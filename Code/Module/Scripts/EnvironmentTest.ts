import {
  copyFileSync as CopyFileSync, existsSync as ExistsSync, lstatSync as LstatSync,
  mkdirSync as MkdirSync, mkdtempSync as MkdtempSync, readFileSync as ReadFileSync,
  realpathSync as RealpathSync, rmdirSync as RmdirSync, rmSync as RmSync, symlinkSync as SymlinkSync, writeFileSync as WriteFileSync,
} from 'node:fs'
import { spawnSync as SpawnSync } from 'node:child_process'
import Path from 'node:path'
import { fileURLToPath as FileUrlToPath } from 'node:url'
import { afterEach as AfterEach, describe as Describe, expect as Expect, it as It } from 'vitest'

const ModuleRoot = Path.resolve(Path.dirname(FileUrlToPath(import.meta.url)), '..')
const TemporaryRoot = Path.join(ModuleRoot, 'Runtime/EnvironmentTests')
const Temporary: string[] = []

function Fixture() {
  MkdirSync(TemporaryRoot, { recursive: true })
  const Root = MkdtempSync(Path.join(TemporaryRoot, 'Portable '))
  Temporary.push(Root)
  const Scripts = Path.join(Root, 'Code/Module/Scripts')
  const DependencyPath = Path.join(Root, 'Dependencies/Packages/node_modules')
  const LinkPath = Path.join(Root, 'Code/Module/node_modules')
  MkdirSync(Scripts, { recursive: true })
  MkdirSync(DependencyPath, { recursive: true })
  const Script = Path.join(Scripts, 'LocalEnvironment.ps1')
  CopyFileSync(Path.join(ModuleRoot, 'Scripts/LocalEnvironment.ps1'), Script)
  const Connect = () => SpawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `$ErrorActionPreference = 'Stop'; . '${Script.replace(/'/g, "''")}'; ConnectHybridRefDependencies -Environment (GetHybridRefEnvironment)`,
  ], { encoding: 'utf8', windowsHide: true })
  return { root: Root, dependencyPath: DependencyPath, linkPath: LinkPath, Connect }
}

AfterEach(() => {
  for (const Root of Temporary.splice(0)) {
    if (Path.dirname(Root) !== TemporaryRoot) throw new Error('Unexpected test cleanup path')
    RmSync(Root, { recursive: true, force: true })
  }
})

Describe.skipIf(process.platform !== 'win32')('portable dependency junction', () => {
  It('creates the source entry point for a repository path containing spaces', () => {
    const { dependencyPath: DependencyPath, linkPath: LinkPath, Connect } = Fixture()
    const Result = Connect()
    Expect(Result.status, Result.stderr).toBe(0)
    Expect(LstatSync(LinkPath).isSymbolicLink()).toBe(true)
    Expect(RealpathSync(LinkPath)).toBe(RealpathSync(DependencyPath))
    Expect(Connect().status).toBe(0)
  })

  It('repairs a moved repository without deleting the old target contents', () => {
    const { root: Root, dependencyPath: DependencyPath, linkPath: LinkPath, Connect } = Fixture()
    const OldTarget = Path.join(Root, 'PreviousLocation/node_modules')
    MkdirSync(OldTarget, { recursive: true })
    const Marker = Path.join(OldTarget, 'Keep.txt')
    WriteFileSync(Marker, 'previous dependencies')
    SymlinkSync(OldTarget, LinkPath, 'junction')
    const Result = Connect()
    Expect(Result.status, Result.stderr).toBe(0)
    Expect(RealpathSync(LinkPath)).toBe(RealpathSync(DependencyPath))
    Expect(ReadFileSync(Marker, 'utf8')).toBe('previous dependencies')
  })

  It('repairs a junction whose former repository location no longer exists', () => {
    const { root: Root, dependencyPath: DependencyPath, linkPath: LinkPath, Connect } = Fixture()
    SymlinkSync(Path.join(Root, 'MissingLocation/node_modules'), LinkPath, 'junction')
    const Result = Connect()
    Expect(Result.status, Result.stderr).toBe(0)
    Expect(RealpathSync(LinkPath)).toBe(RealpathSync(DependencyPath))
  })

  It('refuses to replace a real dependency directory and preserves its files', () => {
    const { linkPath: LinkPath, Connect } = Fixture()
    MkdirSync(LinkPath)
    const Marker = Path.join(LinkPath, 'Keep.txt')
    WriteFileSync(Marker, 'user files')
    const Result = Connect()
    Expect(Result.status).not.toBe(0)
    Expect(Result.stderr).toContain('existing real directory')
    Expect(ReadFileSync(Marker, 'utf8')).toBe('user files')
  })

  It('does not create a link when the local dependencies are missing', () => {
    const { dependencyPath: DependencyPath, linkPath: LinkPath, Connect } = Fixture()
    RmdirSync(DependencyPath)
    const Result = Connect()
    Expect(Result.status).not.toBe(0)
    Expect(Result.stderr).toContain('Setup.cmd')
    Expect(ExistsSync(LinkPath)).toBe(false)
  })
})
