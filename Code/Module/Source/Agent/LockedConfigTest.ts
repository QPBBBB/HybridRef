import FsPromises, { link as Link, mkdir as Mkdir, mkdtemp as Mkdtemp, readFile as ReadFile, readdir as Readdir, rm as Rm, writeFile as WriteFile } from 'node:fs/promises'
import { syncBuiltinESMExports as SyncBuiltinEsmExports } from 'node:module'
import { basename as Basename, dirname as Dirname, join as Join, resolve as Resolve } from 'node:path'
import { afterEach as AfterEach, describe as Describe, expect as Expect, it as It, vi as Vi } from 'vitest'
import { Serialize } from '../Server/Storage'
import { RunCommand } from './Command'
import { ReadCatalog } from './Files'
import { ConfigRecoveryError, ConfigRecoveryPattern, RewriteLockedConfig } from './LockedConfig'

const Repository = Resolve(__dirname, '../../../..'), TempRoot = Join(Repository, 'Code/Module/Runtime/Tests/Temp'), Roots: string[] = []
AfterEach(async () => {
  Vi.restoreAllMocks(); SyncBuiltinEsmExports()
  for (const Root of Roots.splice(0)) {
    if (Dirname(Resolve(Root)) !== TempRoot || !Basename(Root).startsWith('AgentConfig-')) throw new Error('Unsafe config fixture cleanup')
    await Rm(Root, { recursive: true, force: true })
  }
})
async function Fixture() {
  await Mkdir(TempRoot, { recursive: true })
  const Root = await Mkdtemp(Join(TempRoot, 'AgentConfig-')); Roots.push(Root)
  const Created = await RunCommand(['project', 'create', '--root', Root, '--name', 'Board'], Repository)
  const Project = String(Created.project)
  await RunCommand(['text', 'create', '--project', Project, '--id', 'Text', '--x', '123456'], Repository)
  const Catalog = await ReadCatalog(Project), Entry = Catalog.Entries[0], Path = Join(Catalog.Directory, Entry.Config)
  const Next = structuredClone(Entry.Layout); Next.instances.Text.x = 5
  return { Root, Project, Path, Before: Buffer.from(Entry.LayoutText), After: Buffer.from(Serialize(Next)) }
}
async function RecoveryFiles(Path: string): Promise<string[]> { return (await Readdir(Dirname(Path))).filter(Name => ConfigRecoveryPattern.test(Name)) }

Describe('guarded writes to rename-locked configs', () => {
  It('rejects malformed configs and hard links without modifying bytes', async () => {
    const { Root, Path, Before, After } = await Fixture()
    await Expect(RewriteLockedConfig(Path, Before, Buffer.from('invalid'))).rejects.toThrow()
    await Link(Path, Join(Root, 'Shared.config'))
    await Expect(RewriteLockedConfig(Path, Before, After)).rejects.toThrow('硬链接')
    Expect(await ReadFile(Path)).toEqual(Before)
    Expect(await RecoveryFiles(Path)).toEqual([])
  })
  It('rechecks the baseline after backing up and preserves intervening edits', async () => {
    const { Path, Before, After } = await Fixture(), External = Buffer.concat([Before, Buffer.from('# External edit\n')])
    const Open = FsPromises.open
    Vi.spyOn(FsPromises, 'open').mockImplementation(async (...Arguments) => {
      const Handle = await Open(...Arguments)
      if (ConfigRecoveryPattern.test(Basename(String(Arguments[0])))) {
        const Sync = Handle.sync.bind(Handle)
        Vi.spyOn(Handle, 'sync').mockImplementationOnce(async () => { await Sync(); await WriteFile(Path, External) })
      }
      return Handle
    })
    SyncBuiltinEsmExports()
    await Expect(RewriteLockedConfig(Path, Before, After)).rejects.toThrow('被修改')
    Expect(await ReadFile(Path)).toEqual(External)
    Expect(await RecoveryFiles(Path)).toEqual([])
  })
  It('restores the complete original bytes after a partially completed write fails', async () => {
    const { Path, Before, After } = await Fixture(), Open = FsPromises.open
    Vi.spyOn(FsPromises, 'open').mockImplementation(async (...Arguments) => {
      const Handle = await Open(...Arguments)
      if (Arguments[0] === Path && Arguments[1] === 'r+') Vi.spyOn(Handle, 'truncate').mockRejectedValueOnce(new Error('injected truncate failure'))
      return Handle
    })
    SyncBuiltinEsmExports()
    await Expect(RewriteLockedConfig(Path, Before, After)).rejects.toThrow('injected truncate failure')
    Expect(await ReadFile(Path)).toEqual(Before)
    Expect(await RecoveryFiles(Path)).toEqual([])
  })
  It('retains a durable recovery record and blocks further commands if restoration fails', async () => {
    const { Project, Path, Before, After } = await Fixture(), Open = FsPromises.open
    Vi.spyOn(FsPromises, 'open').mockImplementation(async (...Arguments) => {
      const Handle = await Open(...Arguments)
      if (Arguments[0] === Path && Arguments[1] === 'r+') Vi.spyOn(Handle, 'truncate').mockRejectedValue(new Error('persistent truncate failure'))
      return Handle
    })
    SyncBuiltinEsmExports()
    await Expect(RewriteLockedConfig(Path, Before, After)).rejects.toBeInstanceOf(ConfigRecoveryError)
    const Records = await RecoveryFiles(Path)
    Expect(Records).toHaveLength(1)
    Expect(JSON.parse(await ReadFile(Join(Dirname(Path), Records[0]), 'utf8'))).toMatchObject({ file: Basename(Path), before: Before.toString('utf8'), after: After.toString('utf8') })
    Expect((await RunCommand(['validate', '--project', Project], Repository)).ok).toBe(false)
    await Expect(RunCommand(['text', 'update', '--project', Project, '--id', 'Text', '--content', 'Do not write'], Repository)).rejects.toThrow('先修复')
  })
  It('does not roll back another writer after an interrupted write', async () => {
    const { Path, Before, After } = await Fixture(), Open = FsPromises.open
    const External = Buffer.concat([Before, Buffer.from('# Keep this external edit\n')])
    Vi.spyOn(FsPromises, 'open').mockImplementation(async (...Arguments) => {
      const Handle = await Open(...Arguments)
      if (Arguments[0] === Path && Arguments[1] === 'r+') Vi.spyOn(Handle, 'truncate').mockImplementationOnce(async () => { await WriteFile(Path, External); throw new Error('concurrent modification') })
      return Handle
    })
    SyncBuiltinEsmExports()
    await Expect(RewriteLockedConfig(Path, Before, After)).rejects.toBeInstanceOf(ConfigRecoveryError)
    Expect(await ReadFile(Path)).toEqual(External)
    Expect(await RecoveryFiles(Path)).toHaveLength(1)
  })
})
