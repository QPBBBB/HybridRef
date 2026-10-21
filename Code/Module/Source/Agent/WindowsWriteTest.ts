import { spawn as Spawn, type ChildProcess } from 'node:child_process'
import { mkdir as Mkdir, mkdtemp as Mkdtemp, readFile as ReadFile, readdir as Readdir, rm as Rm, writeFile as WriteFile } from 'node:fs/promises'
import { basename as Basename, dirname as Dirname, join as Join, resolve as Resolve } from 'node:path'
import { afterEach as AfterEach, describe as Describe, expect as Expect, it as It, vi as Vi } from 'vitest'
import Sharp from 'sharp'
import { ImageStore, Serialize } from '../Server/Storage'
import { ReadCatalog } from './Files'

const Repository = Resolve(__dirname, '../../../..'), TempRoot = Join(Repository, 'Code/Module/Runtime/Tests/Temp')
const Roots: string[] = [], Holders: ChildProcess[] = []
function Quote(Value: string): string { return `'${Value.replaceAll("'", "''")}'` }
function Powershell(Script: string): ChildProcess {
  return Spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(Script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
}
async function Cli(Arguments: string[]): Promise<{ Status: number | null; Output: string; Error: string; Result: Record<string, unknown> }> {
  const Process = Powershell(`& ${[Join(Repository, 'AgentKnowledge/HybridRef.cmd'), ...Arguments].map(Quote).join(' ')}; exit $LASTEXITCODE`)
  let Output = '', Error = ''
  Process.stdout!.on('data', Data => { Output += String(Data) })
  Process.stderr!.on('data', Data => { Error += String(Data) })
  const Status = await new Promise<number | null>((Done, Fail) => { Process.once('error', Fail); Process.once('close', Done) })
  return { Status, Output, Error, Result: JSON.parse(Status === 0 ? Output : Error || Output) }
}
async function Hold(Path: string, Share: 'ReadWrite' | 'Read'): Promise<ChildProcess> {
  const Process = Powershell(`$Stream = [System.IO.File]::Open(${Quote(Path)}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::${Share}); try { [Console]::Out.WriteLine('READY'); [Console]::In.ReadLine() | Out-Null } finally { $Stream.Dispose() }`)
  Holders.push(Process)
  await new Promise<void>((Done, Fail) => {
    const Timeout = setTimeout(() => Fail(new Error('File holder did not start')), 5000)
    Process.stdout!.on('data', Data => { if (String(Data).includes('READY')) { clearTimeout(Timeout); Done() } })
    Process.once('error', Error => { clearTimeout(Timeout); Fail(Error) })
    Process.once('exit', Code => { clearTimeout(Timeout); if (Code !== 0) Fail(new Error(`File holder exited: ${Code}`)) })
  })
  return Process
}
async function Release(Process: ChildProcess): Promise<void> {
  if (Process.exitCode !== null) return
  const Closed = new Promise<void>(Done => { Process.once('close', () => Done()) })
  Process.stdin!.end('\n')
  await Closed
}
AfterEach(async () => {
  for (const Process of Holders.splice(0)) await Release(Process)
  for (const Root of Roots.splice(0)) {
    if (Dirname(Resolve(Root)) !== TempRoot || !Basename(Root).startsWith('AgentWindows-')) throw new Error('Unsafe Windows fixture cleanup')
    await Rm(Root, { recursive: true, force: true })
  }
})
async function Fixture() {
  await Mkdir(TempRoot, { recursive: true })
  const Root = await Mkdtemp(Join(TempRoot, 'AgentWindows-')); Roots.push(Root)
  const Created = await Cli(['project', 'create', '--root', Root, '--name', 'Board'])
  Expect(Created.Status, Created.Error).toBe(0)
  return { Root, Project: String(Created.Result.project) }
}
async function Edit(Project: string, Kind: string, Action: string, Data: unknown) {
  const Input = Join(Dirname(Dirname(Project)), 'Input.json')
  await WriteFile(Input, JSON.stringify(Data))
  return Cli([Kind, Action, '--project', Project, '--input', Input])
}

Describe.runIf(process.platform === 'win32')('public CLI with real Windows file sharing locks', () => {
  It('updates image layouts, text revisions and bound line offsets while readers deny rename', async () => {
    const { Root, Project } = await Fixture(), Source = Join(Root, 'Source.png')
    await Sharp({ create: { width: 80, height: 40, channels: 3, background: '#334455' } }).png().toFile(Source)
    Expect((await Edit(Project, 'image', 'create', { id: 'Image', source: Source, x: 0, y: 0 })).Status).toBe(0)
    Expect((await Edit(Project, 'text', 'create', { id: 'Text', content: 'Before', x: 400, y: 200 })).Status).toBe(0)
    Expect((await Edit(Project, 'line', 'create', { id: 'Line', startBinding: { id: 'Image', side: 'right', offset: 0.85 }, endBinding: { id: 'Text', side: 'left' }, axis: 'horizontal', bend: 240 })).Status).toBe(0)
    const OriginalIndex = await ReadFile(Project)
    for (const [Id, Kind, Data] of [['Image', 'element', { id: 'Image', x: 60 }], ['Text', 'text', { id: 'Text', content: 'After' }], ['Line', 'line', { id: 'Line', startBinding: { id: 'Image', side: 'right', offset: 0.5 }, bend: 240 }]] as const) {
      const Before = await ReadCatalog(Project), Entry = Before.Entries.find(Value => Value.Id === Id)!
      const Holder = await Hold(Join(Before.Directory, Entry.Config), 'ReadWrite')
      const Result = await Edit(Project, Kind, 'update', Data)
      Expect(Result.Status, Result.Error).toBe(0)
      Expect((await Cli(['validate', '--project', Project])).Result).toMatchObject({ ok: true, elements: 3, issues: [] })
      await Release(Holder)
    }
    Expect(await ReadFile(Project)).toEqual(OriginalIndex)
    const Store = new ImageStore()
    await Store.LoadProject(Project)
    const Loaded = await Store.ScanProject(Project)
    Expect(Loaded.resourceIssues).toBeUndefined()
    Expect(Loaded.document.images[0].x).toBe(60)
    Expect(Loaded.document.texts[0].text.content).toBe('After')
    Expect(Loaded.document.arrows![0].arrow.startBinding?.offset).toBe(0.5)
    Expect((await new ImageStore().LoadProject(Project)).document).toEqual(Loaded.document)
    Expect((await Readdir(Join(Dirname(Project), 'Resource'))).some(Name => Name.startsWith('.') || Name.endsWith('.tmp'))).toBe(false)
  }, 90_000)

  It('rejects a lock denying writes, rolls back the revision and succeeds after release', async () => {
    const { Project } = await Fixture()
    Expect((await Edit(Project, 'text', 'create', { id: 'Text', content: 'Before' })).Status).toBe(0)
    const Before = await ReadCatalog(Project), Entry = Before.Entries[0], Config = Join(Before.Directory, Entry.Config)
    const Names = (await Readdir(Join(Before.Directory, 'Resource'))).sort(), Bytes = await ReadFile(Config)
    const Holder = await Hold(Config, 'Read')
    const Failed = await Edit(Project, 'text', 'update', { id: 'Text', content: 'After' })
    Expect(Failed.Status).not.toBe(0)
    Expect(Failed.Result.error).toContain('关闭占用')
    Expect(await ReadFile(Config)).toEqual(Bytes)
    Expect((await Readdir(Join(Before.Directory, 'Resource'))).sort()).toEqual(Names)
    await Release(Holder)
    Expect((await Edit(Project, 'text', 'update', { id: 'Text', content: 'After' })).Status).toBe(0)
    Expect((await Cli(['validate', '--project', Project])).Result.ok).toBe(true)
  }, 45_000)

  It('preserves external edits made while a rename is being retried', async () => {
    const { Project } = await Fixture()
    Expect((await Edit(Project, 'text', 'create', { id: 'Text', content: 'Before' })).Status).toBe(0)
    const Before = await ReadCatalog(Project), Entry = Before.Entries[0], Config = Join(Before.Directory, Entry.Config)
    const External = structuredClone(Entry.Layout); External.instances.Text.x = 777
    const Holder = await Hold(Config, 'ReadWrite')
    const Pending = Edit(Project, 'element', 'update', { id: 'Text', x: 100 })
    await Vi.waitFor(async () => { Expect((await Readdir(Join(Before.Directory, 'Resource'))).some(Name => Name.endsWith('.tmp'))).toBe(true) }, { timeout: 5000 })
    await WriteFile(Config, Serialize(External))
    const Failed = await Pending
    Expect(Failed.Status).not.toBe(0)
    Expect(Failed.Result.error).toContain('被修改')
    Expect(await ReadFile(Config, 'utf8')).toBe(Serialize(External))
    await Release(Holder)
  }, 30_000)
})
