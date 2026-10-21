import { createHash as CreateHash } from 'node:crypto'
import { cpSync as CpSync, existsSync as ExistsSync, mkdtempSync as MkdtempSync, readFileSync as ReadFileSync, readdirSync as ReaddirSync, rmSync as RmSync, statSync as StatSync, symlinkSync as SymlinkSync, writeFileSync as WriteFileSync } from 'node:fs'
import FsPromises from 'node:fs/promises'
import { syncBuiltinESMExports as SyncBuiltinEsmExports } from 'node:module'
import { tmpdir as Tmpdir } from 'node:os'
import { basename as Basename, dirname as Dirname, join as Join, resolve as Resolve } from 'node:path'
import { parse as Parse, stringify as Stringify } from 'yaml'
import { afterEach as AfterEach, describe as Describe, expect as Expect, it as It, vi as Vi } from 'vitest'
import { CreateArrow } from '../Shared/Arrows'
import { EmptyDocument, type BoardDocument } from '../Shared/Types'
import { ImageStore } from './Storage'

const Roots: string[] = []
function Temp(): string {
  const Root = MkdtempSync(Join(Tmpdir(), 'hybridref-lines-'))
  Roots.push(Root)
  return Root
}
AfterEach(() => {
  Vi.restoreAllMocks(); SyncBuiltinEsmExports()
  for (const Root of Roots.splice(0)) {
    if (Dirname(Resolve(Root)) !== Resolve(Tmpdir()) || !Basename(Root).startsWith('hybridref-lines-')) throw new Error('Unsafe line test cleanup')
    RmSync(Root, { recursive: true, force: true })
  }
})
function Board(): BoardDocument {
  return { ...EmptyDocument(), formatVersion: 4, arrows: [CreateArrow('line-1', { x: 30, y: 60 }, { x: 280, y: 180 })] }
}
function Read(Path: string): ReturnType<typeof Parse> { return Parse(ReadFileSync(Path, 'utf8')) }
function LineFiles(Project: string, Index = 0): { Yaml: string; Config: string } {
  const Yaml = Join(Dirname(Project), Read(Project).arrows[Index].asset)
  return { Yaml, Config: Yaml.replace('.yaml', '.config') }
}

Describe('Line YAML and config storage', () => {
  It.each([4, 5])('reads inline version %s arrows and migrates only on save', async (Version) => {
    const Root = Temp(), Project = Join(Root, 'Legacy.hbr'), Doc = Board()
    Doc.arrows![0].arrow.endBinding = { id: 'image-target', side: 'left', offset: 0.25 }
    const Original = Stringify({ ...Doc, formatVersion: Version })
    WriteFileSync(Project, Original)
    const Store = new ImageStore(), Loaded = await Store.LoadProject(Project)
    Expect(Loaded.document).toEqual(Doc)
    Expect(ReadFileSync(Project, 'utf8')).toBe(Original)
    await Store.SaveProject(Project, Loaded.document)
    Expect(Read(Project).formatVersion).toBe(7)
    Expect(Object.keys(Read(Project).arrows[0])).toEqual(['id', 'asset'])
    const Files = LineFiles(Project)
    Expect(Basename(Files.Yaml)).toMatch(/^Line_[A-F0-9]{16}_[A-F0-9]{8}\.yaml$/)
    Expect(Read(Files.Yaml).arrow).toEqual(Doc.arrows![0].arrow)
    Expect((await new ImageStore().LoadProject(Project)).document).toEqual(Doc)
  })

  It('keeps movement in config, publishes style revisions as pairs, and restores deleted lines after undo', async () => {
    const Root = Temp(), Project = Join(Root, 'Line.hbr'), Store = new ImageStore(), Doc = Board()
    await Store.SaveProject(Project, Doc)
    const First = LineFiles(Project), Hbr = ReadFileSync(Project, 'utf8'), Yaml = ReadFileSync(First.Yaml, 'utf8')
    const Times = [Project, First.Yaml, First.Config].map((Path) => StatSync(Path).mtimeMs)
    await Store.SaveProject(Project, Doc)
    Expect([Project, First.Yaml, First.Config].map((Path) => StatSync(Path).mtimeMs)).toEqual(Times)
    Doc.arrows![0].x += 50
    await Store.SaveProject(Project, Doc)
    Expect(ReadFileSync(Project, 'utf8')).toBe(Hbr)
    Expect(ReadFileSync(First.Yaml, 'utf8')).toBe(Yaml)
    Expect(Read(First.Config).instances['line-1'].x).toBe(Doc.arrows![0].x)
    Doc.arrows![0].arrow.color = '#FF1234'; Doc.arrows![0].arrow.dashed = true
    await Store.SaveProject(Project, Doc)
    const Second = LineFiles(Project)
    Expect(Second.Yaml).not.toBe(First.Yaml)
    Expect(Basename(Second.Yaml).split('_')[1]).toBe(Basename(First.Yaml).split('_')[1])
    const Hash = CreateHash('sha256').update(ReadFileSync(Second.Yaml)).digest('hex').slice(0, 8).toUpperCase()
    Expect(Second.Yaml).toContain(`_${Hash}.yaml`)
    Expect(ExistsSync(First.Yaml)).toBe(false); Expect(ExistsSync(First.Config)).toBe(false)
    Expect(Read(Second.Config).instances['line-1'].x).toBe(Doc.arrows![0].x)
    Expect((await new ImageStore().LoadProject(Project)).document).toEqual(Doc)
    await Store.SaveProject(Project, EmptyDocument())
    Expect(ReaddirSync(Join(Root, 'Resource'))).toEqual([])
    await Store.SaveProject(Project, Doc)
    Expect((await new ImageStore().LoadProject(Project)).document).toEqual(Doc)
  })

  It('gives duplicate arrows independent resource names and layouts', async () => {
    const Root = Temp(), Project = Join(Root, 'Copies.hbr'), Store = new ImageStore(), Doc = Board()
    Doc.arrows!.push({ ...structuredClone(Doc.arrows![0]), id: 'line-2', x: 400 })
    await Store.SaveProject(Project, Doc)
    const First = LineFiles(Project), Second = LineFiles(Project, 1)
    Expect(First.Yaml).not.toBe(Second.Yaml)
    Doc.arrows![1].arrow.thickness = 7
    await Store.SaveProject(Project, Doc)
    Expect(Read(First.Yaml).arrow.thickness).toBe(Doc.arrows![0].arrow.thickness)
    Expect((await Store.LoadProject(Project)).document).toEqual(Doc)
  })

  It('isolates sibling Save As and can save to another folder after source storage disappears', async () => {
    const Root = Temp(), Project = Join(Root, 'Original.hbr'), Store = new ImageStore(), Doc = Board()
    await Store.SaveProject(Project, Doc)
    const Original = LineFiles(Project)
    Doc.arrows![0].x = 900
    const Copy = Join(Root, 'Copy.hbr')
    await Store.SaveProject(Copy, Doc)
    Expect(LineFiles(Copy).Yaml).not.toBe(Original.Yaml)
    Expect((await new ImageStore().LoadProject(Project)).document.arrows![0].x).toBe(Board().arrows![0].x)
    const Files = LineFiles(Copy)
    RmSync(Files.Yaml); RmSync(Files.Config)
    const Elsewhere = Join(Temp(), 'Moved.hbr')
    await Store.SaveProject(Elsewhere, Doc)
    Expect((await new ImageStore().LoadProject(Elsewhere)).document).toEqual(Doc)
  })

  It('keeps different arrows edited by two tabs and rejects a later stale edit of the same arrow', async () => {
    const Root = Temp(), Project = Join(Root, 'Team.hbr'), Initial = new ImageStore(), Doc = Board()
    Doc.arrows!.push({ ...structuredClone(Doc.arrows![0]), id: 'line-2', x: 400 })
    await Initial.SaveProject(Project, Doc)
    const A = new ImageStore(), B = new ImageStore()
    const First = (await A.LoadProject(Project)).document, Second = (await B.LoadProject(Project)).document
    First.arrows![0].arrow.color = '#123456'
    Second.arrows![1].arrow.dashed = true
    await Promise.all([A.SaveProject(Project, First), B.SaveProject(Project, Second)])
    const Loaded = (await new ImageStore().LoadProject(Project)).document
    Expect(Loaded.arrows![0].arrow.color).toBe('#123456'); Expect(Loaded.arrows![1].arrow.dashed).toBe(true)
    Second.arrows![0].x = 999
    const Before = ReadFileSync(Project, 'utf8')
    await Expect(B.SaveProject(Project, Second)).rejects.toThrow('外部修改')
    Expect(ReadFileSync(Project, 'utf8')).toBe(Before)
  })

  It('preserves an external config edit across a style filename change and rejects conflicting movement', async () => {
    const Root = Temp(), Project = Join(Root, 'Agent.hbr'), Store = new ImageStore(), Doc = Board()
    await Store.SaveProject(Project, Doc)
    const Files = LineFiles(Project), Config = Read(Files.Config)
    Config.instances['line-1'].x = 777
    WriteFileSync(Files.Config, Stringify(Config))
    Doc.arrows![0].arrow.dashed = true
    await Store.SaveProject(Project, Doc)
    const NewFiles = LineFiles(Project)
    Expect(Read(NewFiles.Config).instances['line-1'].x).toBe(777)
    Expect((await new ImageStore().LoadProject(Project)).document.arrows![0].arrow.dashed).toBe(true)
    Doc.arrows![0].x = 900
    await Expect(Store.SaveProject(Project, Doc)).rejects.toThrow('外部修改')
    Expect(Read(NewFiles.Config).instances['line-1'].x).toBe(777)
  })

  It('preserves missing YAML references and configs, restores recovered resources, and permits manual removal', async () => {
    const Root = Temp(), Project = Join(Root, 'Missing.hbr'), Store = new ImageStore(), Doc = Board()
    await Store.SaveProject(Project, Doc)
    const Files = LineFiles(Project), Bytes = ReadFileSync(Files.Yaml), Original = ReadFileSync(Project, 'utf8')
    RmSync(Files.Yaml)
    const Reopened = new ImageStore(), Loaded = await Reopened.LoadProject(Project)
    Expect(Loaded.document.arrows ?? []).toEqual([])
    Expect(Loaded.missingResources).toEqual([Read(Project).arrows[0].asset])
    await Reopened.SaveProject(Project, Loaded.document)
    await Reopened.CleanupProject(Project, Loaded.document)
    Expect(ReadFileSync(Project, 'utf8')).toBe(Original)
    Expect(ExistsSync(Files.Config)).toBe(true)
    const Sibling = Join(Root, 'Sibling.hbr')
    await Reopened.SaveProject(Sibling, Loaded.document)
    Expect(LineFiles(Sibling).Config).not.toBe(Files.Config)
    Expect(ExistsSync(LineFiles(Sibling).Config)).toBe(true)
    await Reopened.LoadProject(Project)
    const Copy = Join(Temp(), 'Copy.hbr')
    await Reopened.SaveProject(Copy, Loaded.document)
    Expect(ExistsSync(LineFiles(Copy).Config)).toBe(true)
    await Reopened.LoadProject(Project)
    WriteFileSync(Files.Yaml, Bytes)
    const Recovered = await Reopened.CleanupProject(Project, Loaded.document)
    Expect(Recovered.document.arrows).toEqual(Doc.arrows)
    Expect(Recovered.missingResources ?? []).toEqual([])
    RmSync(Files.Yaml)
    const Missing = await Reopened.LoadProject(Project)
    const Manual = Read(Project); delete Manual.arrows
    WriteFileSync(Project, Stringify(Manual))
    const ConfigBefore = ReadFileSync(Files.Config)
    Expect((await Reopened.CleanupProject(Project, Missing.document)).removedFiles).toBe(0)
    Expect(Read(Project).arrows).toBeUndefined()
    // Manual removal from the index does not authorize pruning an incomplete,
    // now-unindexed resource pair.
    Expect(ReadFileSync(Files.Config)).toEqual(ConfigBefore)
  })

  It('protects shared line resources and retains them after they leave the current index', async () => {
    const Root = Temp(), Project = Join(Root, 'Shared.hbr'), Store = new ImageStore()
    await Store.SaveProject(Project, Board())
    const Other = Join(Root, 'Other.hbr'), Files = LineFiles(Project)
    const Before = [ReadFileSync(Files.Yaml), ReadFileSync(Files.Config)]
    CpSync(Project, Other)
    WriteFileSync(Join(Root, 'Resource/Notes.config'), 'keep')
    await Store.SaveProject(Project, EmptyDocument())
    Expect(ExistsSync(Files.Yaml)).toBe(true); Expect(ExistsSync(Files.Config)).toBe(true)
    RmSync(Other)
    Expect((await Store.CleanupProject(Project, EmptyDocument())).removedFiles).toBe(0)
    Expect([ReadFileSync(Files.Yaml), ReadFileSync(Files.Config)]).toEqual(Before)
    Expect(ReaddirSync(Join(Root, 'Resource')).sort()).toEqual(['Notes.config', Basename(Files.Yaml), Basename(Files.Config)].sort())
  })

  It.each(['missing-config', 'invalid-config', 'missing-instance', 'config-link', 'yaml-link', 'hash', 'path'])('isolates %s without rewriting the project and rejects unsafe paths', async (Case) => {
    const Root = Temp(), Project = Join(Root, 'Invalid.hbr'), Store = new ImageStore()
    await Store.SaveProject(Project, Board())
    const Files = LineFiles(Project)
    if (Case === 'missing-config') RmSync(Files.Config)
    if (Case === 'invalid-config') WriteFileSync(Files.Config, 'format: invalid')
    if (Case === 'missing-instance') { const Config = Read(Files.Config); Config.instances = {}; WriteFileSync(Files.Config, Stringify(Config)) }
    if (Case === 'config-link' || Case === 'yaml-link') {
      const Target = Case === 'config-link' ? Files.Config : Files.Yaml
      RmSync(Target); SymlinkSync(Temp(), Target, process.platform === 'win32' ? 'junction' : 'dir')
    }
    if (Case === 'hash') WriteFileSync(Files.Yaml, 'external edit')
    if (Case === 'path') { const Doc = Read(Project); Doc.arrows[0].asset = `../${Basename(Files.Yaml)}`; WriteFileSync(Project, Stringify(Doc)) }
    const Before = ReadFileSync(Project, 'utf8')
    const Reopened = new ImageStore()
    if (['config-link', 'yaml-link', 'path'].includes(Case)) await Expect(Reopened.LoadProject(Project)).rejects.toThrow()
    else {
      const Loaded = await Reopened.LoadProject(Project)
      Expect(Loaded.document.arrows ?? []).toEqual([])
      Expect(Loaded.resourceIssues).toHaveLength(1)
      await Reopened.SaveProject(Project, Loaded.document)
      Expect((await Reopened.CleanupProject(Project, Loaded.document)).resourceIssues).toHaveLength(1)
    }
    Expect(ReadFileSync(Project, 'utf8')).toBe(Before)
  })

  It('rolls back a new config revision when publishing the project fails', async () => {
    const Root = Temp(), Project = Join(Root, 'Rollback.hbr'), Store = new ImageStore(), Doc = Board()
    await Store.SaveProject(Project, Doc)
    const Original = ReadFileSync(Project, 'utf8'), Files = LineFiles(Project), Config = ReadFileSync(Files.Config, 'utf8')
    const Rename = FsPromises.rename
    const Spy = Vi.spyOn(FsPromises, 'rename').mockImplementation(async (From, To) => {
      if (To === Project) throw new Error('simulated publication failure')
      return Rename(From, To)
    })
    SyncBuiltinEsmExports()
    Doc.arrows![0].x = 900; Doc.arrows![0].arrow.dashed = true
    await Expect(Store.SaveProject(Project, Doc)).rejects.toThrow('publication failure')
    Expect(ReadFileSync(Project, 'utf8')).toBe(Original)
    Expect(ReadFileSync(Files.Config, 'utf8')).toBe(Config)
    Expect(ReaddirSync(Join(Root, 'Resource')).filter((Name) => Name.endsWith('.config'))).toEqual([Basename(Files.Config)])
    Spy.mockRestore(); SyncBuiltinEsmExports()
    await Store.SaveProject(Project, Doc)
    Expect((await new ImageStore().LoadProject(Project)).document).toEqual(Doc)
  })

  It.runIf(process.platform === 'win32')('saves after a Windows sharing lock outlasts the former short retry window', async () => {
    const Root = Temp(), Project = Join(Root, 'SharingLock.hbr'), Store = new ImageStore(), Doc = Board()
    await Store.SaveProject(Project, Doc)
    const Files = LineFiles(Project), Rename = FsPromises.rename
    let Attempts = 0
    Vi.spyOn(FsPromises, 'rename').mockImplementation(async (From, To) => {
      if (To === Files.Config && ++Attempts <= 6) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' })
      return Rename(From, To)
    })
    SyncBuiltinEsmExports()
    Doc.arrows![0].x = 900
    await Store.SaveProject(Project, Doc)
    Expect(Attempts).toBeGreaterThan(6)
    Expect(Read(Files.Config).instances['line-1'].x).toBe(900)
    Expect((await new ImageStore().LoadProject(Project)).document).toEqual(Doc)
    Expect(ReaddirSync(Join(Root, 'Resource')).some(Name => Name.endsWith('.tmp'))).toBe(false)
  })

  It.runIf(process.platform === 'win32')('retries a Windows sharing violation but preserves an edit made during the retry', async () => {
    const Root = Temp(), Project = Join(Root, 'Retry.hbr'), Store = new ImageStore(), Doc = Board()
    await Store.SaveProject(Project, Doc)
    const Files = LineFiles(Project), External = Read(Files.Config)
    External.instances['line-1'].x = 777
    const Rename = FsPromises.rename
    let Blocked = false
    Vi.spyOn(FsPromises, 'rename').mockImplementation(async (From, To) => {
      if (To === Files.Config && !Blocked) {
        Blocked = true; WriteFileSync(Files.Config, Stringify(External))
        throw Object.assign(new Error('sharing violation'), { code: 'EPERM' })
      }
      return Rename(From, To)
    })
    SyncBuiltinEsmExports()
    Doc.arrows![0].x = 900
    await Expect(Store.SaveProject(Project, Doc)).rejects.toThrow('保存过程中被修改')
    Expect(Read(Files.Config).instances['line-1'].x).toBe(777)
  })
})
