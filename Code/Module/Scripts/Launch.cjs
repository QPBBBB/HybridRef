const Fs = require('node:fs')
const Path = require('node:path')
const { spawn: Spawn, spawnSync: SpawnSync } = require('node:child_process')
const { createServer: CreateServer } = require('node:http')
const { randomUUID: RandomUUID } = require('node:crypto')

const DefaultModuleRoot = Path.resolve(__dirname, '..')

function NewestSource(Folder) {
  let Latest = Fs.statSync(Folder).mtimeMs
  for (const Entry of Fs.readdirSync(Folder, { withFileTypes: true })) {
    const FileValue = Path.join(Folder, Entry.name)
    if (Entry.isDirectory()) Latest = Math.max(Latest, NewestSource(FileValue))
    else if (!/(?:Test|Spec)\.tsx?$/.test(Entry.name)) Latest = Math.max(Latest, Fs.statSync(FileValue).mtimeMs)
  }
  return Latest
}

function BuildState(ModuleRoot) {
  const Outputs = ['Output/Server/Index.cjs', 'Output/Web/Index.html'].map(FileValue => Path.join(ModuleRoot, FileValue))
  const Inputs = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vite.config.ts', 'Scripts/Build.cjs'].map(FileValue => Fs.statSync(Path.join(ModuleRoot, FileValue)).mtimeMs)
  const SourceTime = Math.max(NewestSource(Path.join(ModuleRoot, 'Source')), NewestSource(Path.join(ModuleRoot, '../Resource')), ...Inputs)
  const Complete = Outputs.every(FileValue => Fs.existsSync(FileValue) && Fs.statSync(FileValue).isFile())
  const Times = Complete ? Outputs.map(FileValue => Fs.statSync(FileValue).mtimeMs) : []
  return { complete: Complete, stale: !Complete || SourceTime > Math.min(...Times), buildId: Complete ? Times.join('-') : null }
}

function EnsureBuild(ModuleRoot, Force = false, Run = SpawnSync) {
  let State = BuildState(ModuleRoot)
  if (Force || State.stale) {
    const Built = Run(process.execPath, ['Scripts/Build.cjs'], { cwd: ModuleRoot, stdio: 'inherit', windowsHide: true })
    if (Built.error) throw Built.error
    if (Built.status !== 0) throw new Error(`HybridRef build failed (exit ${Built.status ?? 'unknown'}).`)
    State = BuildState(ModuleRoot)
    if (!State.complete) throw new Error('HybridRef build did not produce Output/Server/Index.cjs and Output/Web/Index.html.')
  }
  return State.buildId
}

async function ProbeHealth(Url, TimeoutMs = 1000) {
  try {
    const Response = await fetch(new URL('/api/health', Url), { signal: AbortSignal.timeout(TimeoutMs), redirect: 'error' })
    return Response.ok ? await Response.json() : null
  } catch { return null }
}

async function ReusableRuntime(RuntimeFile, BuildId, Probe = ProbeHealth, TimeoutMs = 1000) {
  try {
    const Runtime = JSON.parse(Fs.readFileSync(RuntimeFile, 'utf8'))
    if (Runtime.buildId !== BuildId || !Number.isInteger(Runtime.pid) || Runtime.pid <= 0
      || !Number.isInteger(Runtime.port) || Runtime.port < 1 || Runtime.port > 65535) return null
    const Url = new URL(Runtime.url)
    if (Url.protocol !== 'http:' || Url.hostname !== '127.0.0.1' || Number(Url.port) !== Runtime.port
      || Url.username || Url.password || Url.pathname !== '/' || Url.search || Url.hash) return null
    const Health = await Probe(Url.origin, TimeoutMs)
    return Health?.app === 'hybridref' && Health.buildId === BuildId ? { ...Runtime, url: Url.origin } : null
  } catch { return null }
}

function SpawnServer({ moduleRoot: ModuleRoot, runtimeFile: RuntimeFile, logFile: LogFile }) {
  Fs.mkdirSync(Path.dirname(RuntimeFile), { recursive: true })
  Fs.mkdirSync(Path.dirname(LogFile), { recursive: true })
  const Log = Fs.openSync(LogFile, 'a')
  let Child
  try {
    const Env = { ...process.env }
    delete Env.ELECTRON_RUN_AS_NODE
    Child = Spawn(process.execPath, [Path.join(ModuleRoot, 'Output/Server/Index.cjs'), '--port', '0', '--runtime', RuntimeFile], {
      cwd: ModuleRoot, env: Env, detached: true, windowsHide: true, stdio: ['ignore', Log, Log],
    })
  } finally { Fs.closeSync(Log) }
  return new Promise((Resolve, Reject) => {
    Child.once('error', Reject)
    Child.once('spawn', () => { Child.unref(); Resolve(Child) })
  })
}

async function WaitForRuntime(RuntimeFile, BuildId, Child, Probe = ProbeHealth, TimeoutMs = 10000) {
  const Deadline = Date.now() + TimeoutMs
  while (Date.now() < Deadline) {
    if (Child.exitCode != null) throw new Error(`HybridRef server exited (${Child.exitCode}). See Code/Module/Runtime/Logs/Server.log.`)
    const Runtime = await ReusableRuntime(RuntimeFile, BuildId, Probe, Math.max(1, Math.min(1000, Deadline - Date.now())))
    if (Runtime && Runtime.pid === Child.pid) return Runtime
    const Remaining = Deadline - Date.now()
    if (Remaining > 0) await new Promise(Resolve => setTimeout(Resolve, Math.min(100, Remaining)))
  }
  throw new Error('HybridRef server was not ready within 10 seconds. See Code/Module/Runtime/Logs/Server.log.')
}

function ProjectUrl(BaseUrl, Project) {
  return `${BaseUrl.replace(/\/$/, '')}/${Project ? `?project=${encodeURIComponent(Project)}` : ''}`
}

function BrowserCommand(Url, Platform = process.platform) {
  if (Platform === 'win32') {
    // URI dispatch can return success without displaying a browser window.
    // Resolve the registered browser, allowing it to reuse an existing window.
    const Script = `$ErrorActionPreference = 'Stop'
$Url = '${Url.replace(/'/g, "''")}'
$BrowserPath = $null
try {
  $Choice = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice'
  $CommandKey = Get-Item -LiteralPath ("Registry::HKEY_CLASSES_ROOT\\" + $Choice.ProgId + '\\shell\\open\\command')
  $RegisteredCommand = $CommandKey.GetValue('')
  if ($RegisteredCommand -match '^\\s*"([^"]+\\.exe)"' -or $RegisteredCommand -match '^\\s*([^\\s"]+\\.exe)(?:\\s|$)') {
    $Candidate = [Environment]::ExpandEnvironmentVariables($Matches[1])
    $CandidateName = [IO.Path]::GetFileName($Candidate).ToLowerInvariant()
    if ($CandidateName -in @('msedge.exe', 'chrome.exe', 'firefox.exe') -and (Test-Path -LiteralPath $Candidate -PathType Leaf)) { $BrowserPath = $Candidate }
  }
} catch { $BrowserPath = $null }
if ($BrowserPath) {
  $BrowserName = [IO.Path]::GetFileName($BrowserPath).ToLowerInvariant()
  $BrowserArguments = switch ($BrowserName) {
    'firefox.exe' { @('-new-tab', $Url) }
    default { @($Url) }
  }
  Start-Process -FilePath $BrowserPath -ArgumentList $BrowserArguments -WindowStyle Normal -ErrorAction Stop
} else {
  Start-Process -FilePath $Url -WindowStyle Normal -ErrorAction Stop
}`
    return { executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(Script, 'utf16le').toString('base64')] }
  }
  return { executable: Platform === 'darwin' ? 'open' : 'xdg-open', args: [Url] }
}

function DispatchBrowser(Url, SpawnProcess = Spawn) {
  const Command = BrowserCommand(Url)
  // Hiding/detaching this process through Node can suppress the browser handoff
  // on Windows. Let PowerShell hide its own console; its browser stays visible.
  const Child = SpawnProcess(Command.executable, Command.args, { detached: process.platform !== 'win32', windowsHide: false, stdio: ['ignore', 'ignore', 'pipe'] })
  return new Promise((Resolve, Reject) => {
    let ErrorText = ''
    Child.stderr?.on('data', Chunk => { ErrorText = (ErrorText + Chunk.toString()).slice(-2000) })
    const Timer = setTimeout(() => {
      Child.stderr?.destroy()
      Child.unref()
      Reject(new Error(`The browser launcher did not finish. Open ${Url} in your browser.`))
    }, 5000)
    Child.once('error', CaughtError => { clearTimeout(Timer); Reject(CaughtError) })
    // Start-Process returns after dispatching the URI; this waits only for the
    // short launcher helper, never for the user's browser window to close.
    Child.once('close', Code => {
      clearTimeout(Timer)
      if (Code === 0) Resolve()
      else Reject(new Error(`Could not open the default browser: ${ErrorText.trim() || `exit ${Code}`}. Open ${Url} manually.`))
    })
  })
}

async function OpenBrowser(Url, SpawnProcess = Spawn, TimeoutMs = 12000) {
  const ReceiptPath = `/HybridRefLaunch/${RandomUUID()}`
  let ConfirmOpened, RejectOpened
  const Opened = new Promise((Resolve, Reject) => { ConfirmOpened = Resolve; RejectOpened = Reject })
  // A one-use loopback redirect proves that the browser actually navigated.
  // A successful process exit alone did not prove this on Windows.
  const Server = CreateServer((Request, Response) => {
    if (Request.method !== 'GET' || Request.url !== ReceiptPath) { Response.writeHead(404); Response.end(); return }
    Response.writeHead(302, { Location: Url, 'Cache-Control': 'no-store', Connection: 'close' })
    Response.once('finish', ConfirmOpened)
    Response.end()
  })
  await new Promise((Resolve, Reject) => {
    Server.once('error', Reject)
    Server.listen(0, '127.0.0.1', () => { Server.removeListener('error', Reject); Resolve() })
  })
  const LaunchUrl = `http://127.0.0.1:${Server.address().port}${ReceiptPath}`
  const Timer = setTimeout(() => RejectOpened(new Error(`The browser did not load HybridRef. Open ${Url} manually.`)), TimeoutMs)
  try { await Promise.all([Opened, DispatchBrowser(LaunchUrl, SpawnProcess)]) }
  finally {
    clearTimeout(Timer)
    await new Promise(Resolve => Server.close(Resolve))
  }
}

async function Main(Options = {}) {
  const ModuleRoot = Options.moduleRoot ?? DefaultModuleRoot
  const Args = Options.args ?? process.argv.slice(2)
  const ProjectIndex = Args.indexOf('--project')
  const Project = ProjectIndex < 0 ? null : Path.resolve(Options.invocationRoot ?? process.cwd(), Args[ProjectIndex + 1] || '')
  if (Project && (!Fs.existsSync(Project) || !Fs.statSync(Project).isFile() || !/\.hbr$/i.test(Project))) {
    throw new Error(`Project not found or unsupported: ${Project}`)
  }
  const BuildId = EnsureBuild(ModuleRoot, Args.includes('--build'), Options.Build)
  if (Args.includes('--check')) { console.log(`HybridRef browser build ready (${BuildId}).`); return }
  const RuntimeFile = Path.join(ModuleRoot, 'Runtime/Server.json')
  const Probe = Options.Probe ?? ProbeHealth
  let Runtime = await ReusableRuntime(RuntimeFile, BuildId, Probe)
  if (!Runtime) {
    // A previous build may still have unsaved browser tabs. Leave its process
    // alive and start a separate server; only the discovery file is replaced.
    const Child = await (Options.SpawnServer ?? SpawnServer)({ moduleRoot: ModuleRoot, runtimeFile: RuntimeFile, logFile: Path.join(ModuleRoot, 'Runtime/Logs/Server.log') })
    Runtime = await WaitForRuntime(RuntimeFile, BuildId, Child, Probe)
  }
  const Url = ProjectUrl(Runtime.url, Project)
  await (Options.OpenBrowser ?? OpenBrowser)(Url)
  console.log(`HybridRef opened in your browser: ${Url}`)
}

module.exports = { BuildState, EnsureBuild, ProbeHealth, ReusableRuntime, WaitForRuntime, ProjectUrl, BrowserCommand, DispatchBrowser, OpenBrowser, Main }
if (require.main === module) void Main().catch(CaughtError => { console.error(CaughtError instanceof Error ? CaughtError.message : CaughtError); process.exitCode = 1 })
