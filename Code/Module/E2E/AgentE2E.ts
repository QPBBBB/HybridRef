import { test as Test, expect as Expect } from '@playwright/test'
import { spawn as Spawn, spawnSync as SpawnSync, type ChildProcess } from 'node:child_process'
import { mkdtemp as Mkdtemp, readFile as ReadFile, rm as Rm } from 'node:fs/promises'
import { basename as Basename, dirname as Dirname, join as Join, resolve as Resolve } from 'node:path'
import { tmpdir as Tmpdir } from 'node:os'

const Repository = Resolve(__dirname, '../../..'), ModuleRoot = Join(Repository, 'Code/Module')
let Fixture: string, Project: string, ServiceUrl: string, Service: ChildProcess

Test.beforeAll(async () => {
  Test.setTimeout(90_000)
  Fixture = await Mkdtemp(Join(Tmpdir(), 'hybridref-agent-browser-'))
  // Run the exact public documentation example, including its .cmd entry point.
  const Example = SpawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    Join(Repository, 'AgentKnowledge/Elements/Examples/Walkthrough.ps1'), '-Root', Fixture, '-Keep'],
  { cwd: Fixture, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  Expect(Example.status, Example.stderr).toBe(0)
  Project = JSON.parse(Example.stdout).project
  const Runtime = Join(Fixture, 'Server.json')
  Service = Spawn(process.execPath, [Join(ModuleRoot, 'Output/Server/Index.cjs'), '--port', '0', '--runtime', Runtime,
    '--project-directory', Fixture], { cwd: Fixture, stdio: 'ignore', windowsHide: true })
  await Expect.poll(async () => {
    try { ServiceUrl = JSON.parse(await ReadFile(Runtime, 'utf8')).url; return (await fetch(`${ServiceUrl}/api/health`)).ok } catch { return false }
  }).toBe(true)
})

Test.afterAll(async () => {
  if (Service && Service.exitCode === null && Service.signalCode === null) {
    const Stopped = new Promise<void>((Done, Fail) => {
      const Timeout = setTimeout(() => Fail(new Error('Agent test server did not stop; retaining fixture.')), 5000)
      Service.once('exit', () => { clearTimeout(Timeout); Done() })
    })
    Service.kill(); await Stopped
  }
  if (Fixture) {
    const Root = Resolve(Fixture)
    if (Dirname(Root) !== Resolve(Tmpdir()) || !Basename(Root).startsWith('hybridref-agent-browser-')) throw new Error('Unsafe agent browser fixture cleanup')
    await Rm(Root, { recursive: true, force: true })
  }
})

Test('documented public CLI operations load through browser refresh', async ({ page: Page }) => {
  await Page.goto(ServiceUrl)
  await Page.getByTestId('open').click()
  await Page.getByTestId('project-entry').filter({ hasText: 'AgentExample' }).click()
  await Expect(Page.getByTestId('scan-resources')).toBeEnabled()
  await Expect(Page.getByTestId('image-item')).toHaveCount(0)
  await Page.getByTestId('scan-resources').click()
  const Image = Page.getByTestId('image-item'), Text = Page.getByTestId('text-item'), Line = Page.getByTestId('arrow-item')
  await Expect(Image).toHaveCount(1); await Expect(Text).toHaveCount(1); await Expect(Line).toHaveCount(1)
  await Expect.poll(() => Image.evaluate(Node => (Node as HTMLImageElement).complete && (Node as HTMLImageElement).naturalWidth > 0)).toBe(true)
  await Expect(Image).toHaveAttribute('data-width', '360')
  await Expect(Image).toHaveAttribute('data-height', '240')
  await Expect(Text).toContainText('Updated through the public CLI.')
  await Expect(Text).toHaveAttribute('data-x', '528')
  await Expect(Text).toHaveAttribute('data-y', '136')
  await Expect(Line.locator('path').first()).toHaveAttribute('stroke', '#F6C36A')
  await Expect(Line.locator('path').first()).toHaveAttribute('stroke-width', '4')
  const Before = await ReadFile(Project)
  const Arguments = [Join(Repository, 'AgentKnowledge/HybridRef.cmd'), 'text', 'update', '--project', Project,
    '--id', 'TextA', '--content', 'CLI refreshed again', '--x', '600']
  const Command = `& ${Arguments.map(Value => `'${Value.replaceAll("'", "''")}'`).join(' ')}; exit $LASTEXITCODE`
  const Changed = SpawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(Command, 'utf16le').toString('base64')], { cwd: Fixture, encoding: 'utf8', windowsHide: true })
  Expect(Changed.status, Changed.stderr).toBe(0)
  Expect(await ReadFile(Project)).toEqual(Before)
  await Expect(Text).toContainText('Updated through the public CLI.')
  await Page.getByTestId('scan-resources').click()
  await Expect(Text).toHaveText('CLI refreshed again')
  await Expect(Text).toHaveAttribute('data-x', '600')
  await Page.reload()
  await Expect(Page.getByTestId('text-item')).toHaveText('CLI refreshed again')
  await Expect(Page.getByTestId('image-item')).toHaveCount(1)
  await Expect(Page.getByTestId('arrow-item')).toHaveCount(1)
})
