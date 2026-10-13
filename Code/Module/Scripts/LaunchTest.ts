import { mkdtempSync as MkdtempSync, mkdirSync as MkdirSync, rmSync as RmSync, writeFileSync as WriteFileSync, utimesSync as UtimesSync } from 'node:fs'
import { createRequire as CreateRequire } from 'node:module'
import { createServer as CreateServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { spawnSync as SpawnSync } from 'node:child_process'
import { tmpdir as Tmpdir } from 'node:os'
import Path from 'node:path'
import { afterEach as AfterEach, describe as Describe, expect as Expect, it as It, vi as Vi } from 'vitest'

const { BuildState, EnsureBuild, ProbeHealth, ReusableRuntime, WaitForRuntime, ProjectUrl, BrowserCommand, DispatchBrowser, OpenBrowser, Main } = CreateRequire(import.meta.url)('./Launch.cjs')
const Temporary: string[] = []
const Outputs = ['Output/Server/Index.cjs', 'Output/Web/Index.html']

function Fixture() {
  const Root = MkdtempSync(Path.join(Tmpdir(), 'hybridref-launch-'))
  Temporary.push(Root)
  const ModuleRoot = Path.join(Root, 'Code/Module')
  const Write = (FileValue: string, Contents = '', Timestamp = 10): string => {
    const Target = Path.join(ModuleRoot, FileValue)
    MkdirSync(Path.dirname(Target), { recursive: true })
    WriteFileSync(Target, Contents)
    UtimesSync(Target, Timestamp, Timestamp)
    return Target
  }
  for (const FileValue of ['Source/Server/Index.ts', '../Resource/icon.png', 'package.json', 'vite.config.ts', 'Scripts/Build.cjs']) Write(FileValue)
  for (const FileValue of Outputs) Write(FileValue, '', 20)
  for (const Directory of ['Source/Server', 'Source', '../Resource']) UtimesSync(Path.join(ModuleRoot, Directory), 10, 10)
  const RuntimeFile = Path.join(ModuleRoot, 'Runtime/Server.json')
  const WriteRuntime = (Runtime: unknown) => { MkdirSync(Path.dirname(RuntimeFile), { recursive: true }); WriteFileSync(RuntimeFile, JSON.stringify(Runtime)) }
  return { root: Root, moduleRoot: ModuleRoot, write: Write, runtimeFile: RuntimeFile, writeRuntime: WriteRuntime, buildId: '20000-20000' }
}

AfterEach(() => { for (const Root of Temporary.splice(0)) RmSync(Root, { recursive: true, force: true }) })

Describe('browser launcher build readiness', () => {
  It.each(Outputs)('rebuilds when %s is missing', (Missing) => {
    const { moduleRoot: ModuleRoot, write: Write } = Fixture()
    RmSync(Path.join(ModuleRoot, Missing))
    const Build = Vi.fn(() => { Write(Missing, '', 20); return { status: 0 } })
    Expect(EnsureBuild(ModuleRoot, false, Build)).toBe('20000-20000')
    Expect(Build).toHaveBeenCalledWith(process.execPath, ['Scripts/Build.cjs'], Expect.objectContaining({ cwd: ModuleRoot, windowsHide: true }))
  })

  It('checks the oldest output and build script changes', () => {
    const { moduleRoot: ModuleRoot, write: Write } = Fixture()
    Expect(BuildState(ModuleRoot).stale).toBe(false)
    Write('Output/Server/Index.cjs', '', 5)
    Expect(BuildState(ModuleRoot).stale).toBe(true)
    Write('Output/Server/Index.cjs', '', 20)
    Write('Scripts/Build.cjs', '', 30)
    Expect(BuildState(ModuleRoot).stale).toBe(true)
  })

  It('fails if a build reports success without producing both outputs', () => {
    const { moduleRoot: ModuleRoot } = Fixture()
    RmSync(Path.join(ModuleRoot, Outputs[0]))
    Expect(() => EnsureBuild(ModuleRoot, false, () => ({ status: 0 }))).toThrow('did not produce')
  })

  It('--check builds only, without starting a server, probing a port or opening a browser', async () => {
    const { moduleRoot: ModuleRoot } = Fixture()
    const Probe = Vi.fn(), SpawnServer = Vi.fn(), OpenBrowser = Vi.fn(), Build = Vi.fn(() => ({ status: 0 }))
    await Main({ moduleRoot: ModuleRoot, args: ['--check', '--build'], Probe, SpawnServer, OpenBrowser, Build })
    Expect(Build).toHaveBeenCalledOnce()
    Expect(Probe).not.toHaveBeenCalled()
    Expect(SpawnServer).not.toHaveBeenCalled()
    Expect(OpenBrowser).not.toHaveBeenCalled()
  })
})

Describe('local server discovery', () => {
  It('reuses only the same build and matching local health response', async () => {
    const { runtimeFile: RuntimeFile, writeRuntime: WriteRuntime, buildId: BuildId } = Fixture()
    WriteRuntime({ pid: 42, port: 41234, url: 'http://127.0.0.1:41234', buildId: BuildId })
    const Probe = Vi.fn().mockResolvedValue({ app: 'hybridref', buildId: BuildId })
    Expect(await ReusableRuntime(RuntimeFile, BuildId, Probe)).toMatchObject({ pid: 42, port: 41234 })
    Expect(await ReusableRuntime(RuntimeFile, 'new-build', Probe)).toBeNull()
    Probe.mockResolvedValue({ app: 'other-service', buildId: BuildId })
    Expect(await ReusableRuntime(RuntimeFile, BuildId, Probe)).toBeNull()
    Probe.mockResolvedValue({ app: 'hybridref', buildId: 'old-build' })
    Expect(await ReusableRuntime(RuntimeFile, BuildId, Probe)).toBeNull()
    Expect(Probe).toHaveBeenCalledTimes(3)
  })

  It('rejects malformed or non-loopback discovery without requesting it', async () => {
    const { runtimeFile: RuntimeFile, writeRuntime: WriteRuntime, buildId: BuildId } = Fixture()
    WriteRuntime({ pid: 42, port: 41234, url: 'https://example.com:41234', buildId: BuildId })
    const Probe = Vi.fn()
    Expect(await ReusableRuntime(RuntimeFile, BuildId, Probe)).toBeNull()
    WriteFileSync(RuntimeFile, '{')
    Expect(await ReusableRuntime(RuntimeFile, BuildId, Probe)).toBeNull()
    Expect(Probe).not.toHaveBeenCalled()
  })

  It('checks a real loopback health endpoint', async () => {
    const Server = CreateServer((Request, Response) => {
      Expect(Request.url).toBe('/api/health')
      Response.setHeader('Content-Type', 'application/json')
      Response.end(JSON.stringify({ app: 'hybridref', buildId: 'test' }))
    })
    await new Promise<void>(Resolve => Server.listen(0, '127.0.0.1', Resolve))
    try {
      const Address = Server.address() as { port: number }
      Expect(await ProbeHealth(`http://127.0.0.1:${Address.port}`)).toEqual({ app: 'hybridref', buildId: 'test' })
    } finally { Server.closeAllConnections(); await new Promise<void>(Resolve => Server.close(() => Resolve())) }
  })

  It('waits for the newly started PID and reports startup timeout', async () => {
    const { runtimeFile: RuntimeFile, writeRuntime: WriteRuntime, buildId: BuildId } = Fixture()
    WriteRuntime({ pid: 1, port: 41234, url: 'http://127.0.0.1:41234', buildId: BuildId })
    const Probe = Vi.fn().mockResolvedValue({ app: 'hybridref', buildId: BuildId })
    await Expect(WaitForRuntime(RuntimeFile, BuildId, { pid: 2, exitCode: null }, Probe, 20)).rejects.toThrow('Runtime/Logs/Server.log')
    WriteRuntime({ pid: 2, port: 41234, url: 'http://127.0.0.1:41234', buildId: BuildId })
    Expect(await WaitForRuntime(RuntimeFile, BuildId, { pid: 2, exitCode: null }, Probe, 200)).toMatchObject({ pid: 2 })
  })

  It('opens a relative project on an existing server without spawning another', async () => {
    const { root: Root, moduleRoot: ModuleRoot, writeRuntime: WriteRuntime, buildId: BuildId } = Fixture()
    const Relative = "Project/参考 #100% 'test.hbr"
    const Project = Path.join(Root, Relative)
    MkdirSync(Path.dirname(Project), { recursive: true }); WriteFileSync(Project, '')
    WriteRuntime({ pid: 42, port: 41234, url: 'http://127.0.0.1:41234', buildId: BuildId })
    const SpawnServer = Vi.fn(), OpenBrowser = Vi.fn()
    await Main({ moduleRoot: ModuleRoot, invocationRoot: Root, args: ['--project', Relative], Probe: async () => ({ app: 'hybridref', buildId: BuildId }), SpawnServer, OpenBrowser })
    Expect(SpawnServer).not.toHaveBeenCalled()
    Expect(OpenBrowser).toHaveBeenCalledWith(`http://127.0.0.1:41234/?project=${encodeURIComponent(Project)}`)
  })

  It('starts a new build beside an older live server', async () => {
    const { moduleRoot: ModuleRoot, writeRuntime: WriteRuntime, buildId: BuildId } = Fixture()
    WriteRuntime({ pid: 41, port: 41234, url: 'http://127.0.0.1:41234', buildId: 'old-build' })
    const SpawnServer = Vi.fn(async () => {
      WriteRuntime({ pid: 42, port: 41235, url: 'http://127.0.0.1:41235', buildId: BuildId })
      return { pid: 42, exitCode: null }
    })
    const OpenBrowser = Vi.fn()
    await Main({ moduleRoot: ModuleRoot, args: [], Probe: async () => ({ app: 'hybridref', buildId: BuildId }), SpawnServer, OpenBrowser })
    Expect(SpawnServer).toHaveBeenCalledOnce()
    Expect(OpenBrowser).toHaveBeenCalledWith('http://127.0.0.1:41235/')
  })
})

Describe('default-browser command', () => {
  It('encodes the project query and safely quotes a PowerShell URI without app mode', () => {
    const Url = ProjectUrl('http://127.0.0.1:41234', "D:\\参考\\a'b #50%.hbr")
    const Command = BrowserCommand(Url, 'win32')
    Expect(Command.executable).toBe('powershell.exe')
    const Script = Buffer.from(Command.args.at(-1), 'base64').toString('utf16le')
    Expect(Script).toContain(`$Url = '${Url.replace(/'/g, "''")}'`)
    Expect(Url).toContain('%23')
    Expect(Url).toContain('%25')
    Expect(Script).not.toContain('--app')
  })

  It.runIf(process.platform === 'win32').each([
    ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '--new-window', true],
    ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '--new-window', true],
    ['C:\\Program Files\\Mozilla Firefox\\firefox.exe', '-new-window', true],
    ['C:\\Other Browser\\browser.exe', null, true],
    ['C:\\Missing\\msedge.exe', null, false],
  ])('dispatches %s using the actual PowerShell helper', (BrowserPath, NewWindow, Exists) => {
    const Url = ProjectUrl('http://127.0.0.1:41234', "D:\\参考\\a'b #50%.hbr")
    const Command = BrowserCommand(Url, 'win32')
    const Script = Buffer.from(Command.args.at(-1), 'base64').toString('utf16le')
    // Exercise PowerShell parsing/dispatch without opening test browser windows.
    const Mocks = `
function Get-ItemProperty { param($LiteralPath) [pscustomobject]@{ ProgId = 'TestBrowser' } }
function Get-Item {
  param($LiteralPath)
  $Key = [pscustomobject]@{}
  Add-Member -InputObject $Key -MemberType ScriptMethod -Name GetValue -Value { param($Name) '"${BrowserPath}" --single-argument %1 --untrusted-argument' }
  return $Key
}
function Test-Path { param($LiteralPath, $PathType) $${Exists ? 'true' : 'false'} }
function Start-Process {
  param($FilePath, [string[]]$ArgumentList, $WindowStyle, $ErrorAction)
  @{ FilePath = $FilePath; ArgumentList = $ArgumentList; WindowStyle = $WindowStyle } | ConvertTo-Json -Compress
}
`
    const Result = SpawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(Mocks + Script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true })
    Expect(Result.status, Result.stderr).toBe(0)
    const Dispatch = JSON.parse(Result.stdout.trim())
    Expect(Dispatch).toEqual({ FilePath: NewWindow ? BrowserPath : Url, ArgumentList: NewWindow ? [NewWindow, Url] : null, WindowStyle: 'Normal' })
  })

  It('reports a failed default-browser helper instead of claiming the page opened', async () => {
    const Child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
    const Opening = DispatchBrowser('http://127.0.0.1:41234/', () => Child)
    Child.stderr.emit('data', Buffer.from('No browser association'))
    Child.emit('close', 1)
    await Expect(Opening).rejects.toThrow('No browser association')
  })

  It('lets PowerShell hide its console without suppressing the browser handoff', async () => {
    const Child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
    const SpawnProcess = Vi.fn((Executable: string, Args: string[], Options: unknown) => Child)
    const Opening = DispatchBrowser('http://127.0.0.1:41234/', SpawnProcess)
    Child.emit('close', 0)
    await Opening
    Expect(SpawnProcess).toHaveBeenCalledWith(Expect.any(String), Expect.any(Array), Expect.objectContaining({ windowsHide: false, detached: process.platform !== 'win32' }))
    if (process.platform === 'win32') Expect(SpawnProcess.mock.calls[0][1]).toContain('Hidden')
  })

  It('does not report success when the helper exits but no browser loads the URL', async () => {
    const Child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
    const Opening = OpenBrowser('http://127.0.0.1:41234/', () => {
      setImmediate(() => Child.emit('close', 0))
      return Child
    }, 60)
    await Expect(Opening).rejects.toThrow('Open http://127.0.0.1:41234/ manually')
  })

  It.runIf(process.platform === 'win32')('waits for navigation and redirects to the exact project URL', async () => {
    const Target = ProjectUrl('http://127.0.0.1:41234', "D:\\参考\\a'b #50%.hbr")
    let LaunchUrl = ''
    let NotifyStarted!: () => void
    const Started = new Promise<void>(Resolve => { NotifyStarted = Resolve })
    const Child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
    let Completed = false
    const Opening = OpenBrowser(Target, (Executable: string, Args: string[]) => {
      const Script = Buffer.from(Args.at(-1)!, 'base64').toString('utf16le')
      LaunchUrl = /\$Url = '([^']+)'/.exec(Script)![1]
      setImmediate(() => { Child.emit('close', 0); NotifyStarted() })
      return Child
    }).then(() => { Completed = true })
    await Started
    Expect(Completed).toBe(false)
    const Wrong = await fetch(new URL('/WrongReceipt', LaunchUrl))
    Expect(Wrong.status).toBe(404)
    Expect(Completed).toBe(false)
    const Response = await fetch(LaunchUrl, { redirect: 'manual' })
    Expect(Response.status).toBe(302)
    Expect(Response.headers.get('location')).toBe(Target)
    await Opening
    Expect(Completed).toBe(true)
  })
})
