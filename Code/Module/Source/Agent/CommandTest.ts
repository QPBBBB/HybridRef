import { mkdtemp as Mkdtemp, readFile as ReadFile, readdir as Readdir, rm as Rm, writeFile as WriteFile, symlink as Symlink, mkdir as Mkdir } from 'node:fs/promises'
import { tmpdir as Tmpdir } from 'node:os'
import { basename as Basename, dirname as Dirname, join as Join, resolve as Resolve } from 'node:path'
import { afterEach as AfterEach, describe as Describe, expect as Expect, it as It, vi as Vi } from 'vitest'
import Sharp from 'sharp'
import { parse as Parse } from 'yaml'
import * as Storage from '../Server/Storage'
import { ArrowEndpoints, ResolveArrowBindings } from '../Shared/Arrows'
import type { BoardArrow } from '../Shared/Types'
import { RunCommand } from './Command'
import { Hash, PublishChanges, ReadCatalog, WithProjectLock } from './Files'

const Repository = Resolve(__dirname, '../../../..'), Roots: string[] = []
AfterEach(async () => {
  Vi.restoreAllMocks()
  for (const Root of Roots.splice(0)) {
    if (Dirname(Resolve(Root)) !== Resolve(Tmpdir()) || !Basename(Root).startsWith('hybridref-agent-')) throw new Error('Unsafe fixture cleanup')
    await Rm(Root, { recursive: true, force: true })
  }
})
async function Fixture() {
  const Root = await Mkdtemp(Join(Tmpdir(), 'hybridref-agent-')); Roots.push(Root)
  const Result = await RunCommand(['project', 'create', '--root', Root, '--name', 'Board'], Repository)
  const Project = String(Result.project), Source = Join(Root, 'Source.png')
  await Sharp({ create: { width: 300, height: 200, channels: 4, background: '#3344ff' } }).png().toFile(Source)
  return { Root, Project, Source }
}
async function Command(Project: string, Group: string, Action: string, Data: unknown) {
  const Input = Join(Dirname(Dirname(Project)), 'Input.yaml')
  await WriteFile(Input, Storage.Serialize(Data))
  return RunCommand([Group, Action, '--project', Project, '--input', Input], Repository)
}
async function Seed(Project: string, Source: string) {
  await Command(Project, 'image', 'create', { id: 'ImageA', source: Source, x: 80, y: 80, width: 320 })
  await Command(Project, 'text', 'create', { id: 'TextA', x: 500, y: 420, width: 320, height: 160, text: { content: '# Hello' } })
  await Command(Project, 'line', 'create', { id: 'LineA', startBinding: { id: 'ImageA', side: 'bottom' }, endBinding: { id: 'TextA', side: 'left' } })
}

Describe('agent resource commands', () => {
  It('creates three discoverable elements without editing the index and the real refresh loads them', async () => {
    const { Project, Source } = await Fixture(), Before = await ReadFile(Project)
    await Seed(Project, Source)
    Expect(await ReadFile(Project)).toEqual(Before)
    Expect((await ReadCatalog(Project)).Entries.map((Entry) => Entry.Kind).sort()).toEqual(['image', 'line', 'text'])
    const Store = new Storage.ImageStore()
    Expect((await Store.LoadProject(Project)).document.images).toHaveLength(0)
    const Loaded = await Store.ScanProject(Project)
    Expect(Loaded.resourceIssues).toBeUndefined()
    Expect(Loaded.addedElements).toBe(3)
    Expect(Loaded.document.images[0].width / Loaded.document.images[0].height).toBeCloseTo(1.5)
    Expect(Loaded.document.texts[0].text.content).toBe('# Hello')
    Expect(Loaded.document.arrows![0].arrow.startBinding).toEqual({ id: 'ImageA', side: 'bottom', offset: 0.5 })
  })
  It('edits styles, renames content hashes and leaves exactly one active ID while retaining sibling instances', async () => {
    const { Project, Source } = await Fixture(); await Seed(Project, Source)
    const Before = await ReadCatalog(Project), Text = Before.Entries.find((Entry) => Entry.Id === 'TextA')!
    const Shared = structuredClone(Text.Layout)
    Shared.instances.OtherText = { x: 30, y: 40, width: 100, height: 60 }
    await WriteFile(Join(Before.Directory, Text.Config), Storage.Serialize(Shared))
    await Command(Project, 'text', 'update', { id: 'TextA', text: { content: 'changed', font: { size: 32, weight: 700, color: '#FF0000' }, opacity: 0.7, paragraph: { align: 'center' }, background: { color: '#101010' }, padding: 20 } })
    const After = await ReadCatalog(Project), Changed = After.Entries.find((Entry) => Entry.Id === 'TextA')!
    Expect(After.Issues).toEqual([])
    Expect(Changed.Asset.split('_')[1]).toBe(Text.Asset.split('_')[1])
    Expect(Changed.Asset).not.toBe(Text.Asset)
    Expect(Changed.Item).toMatchObject({ text: { content: 'changed', font: { size: 32, weight: 700 }, paragraph: { align: 'center', lineHeight: 1.5 }, opacity: 0.7 } })
    Expect(After.Entries.find((Entry) => Entry.Id === 'OtherText')?.Item).toMatchObject({ text: { content: '# Hello' } })
    Expect(Parse(await ReadFile(Join(Before.Directory, Text.Config), 'utf8')).instances.TextA).toBeUndefined()
    Expect(await ReadFile(Join(Before.Directory, Text.Asset))).toEqual(Text.Bytes)
  })
  It('moves geometry only, preserves CRLF-compatible names and replaces just one shared image instance', async () => {
    const { Project, Source, Root } = await Fixture(); await Seed(Project, Source)
    const Catalog = await ReadCatalog(Project), Text = Catalog.Entries.find((Entry) => Entry.Id === 'TextA')!, Image = Catalog.Entries.find((Entry) => Entry.Id === 'ImageA')!
    await WriteFile(Join(Catalog.Directory, Text.Asset), Text.Bytes.toString('utf8').replace(/\n/g, '\r\n'))
    await RunCommand(['element', 'update', '--project', Project, '--id', 'TextA', '--x', '-50', '--width', '360'], Repository)
    const Moved = (await ReadCatalog(Project)).Entries.find((Entry) => Entry.Id === 'TextA')!
    Expect(Moved.Asset).toBe(Text.Asset); Expect(Moved.Item.x).toBe(-50); Expect(Moved.Item.width).toBe(360)
    const Annotated = `${Moved.LayoutText}# Preserve agent formatting for a no-op.\n`
    await WriteFile(Join(Catalog.Directory, Moved.Config), Annotated)
    Expect((await Command(Project, 'element', 'update', { id: 'TextA', x: -50 })).changedFiles).toEqual([])
    Expect(await ReadFile(Join(Catalog.Directory, Moved.Config), 'utf8')).toBe(Annotated)
    const Shared = structuredClone(Image.Layout); Shared.instances.OtherImage = { x: 0, y: 0, width: 100, height: 100 }
    await WriteFile(Join(Catalog.Directory, Image.Config), Storage.Serialize(Shared))
    const Replacement = Join(Root, 'Replace.jpg')
    await Sharp({ create: { width: 90, height: 30, channels: 3, background: '#ff2222' } }).jpeg().toFile(Replacement)
    await Command(Project, 'image', 'update', { id: 'ImageA', source: Replacement })
    const Replaced = await ReadCatalog(Project), Next = Replaced.Entries.find((Entry) => Entry.Id === 'ImageA')!
    Expect(Next.Item).toMatchObject({ x: Image.Item.x, width: Image.Item.width, height: Image.Item.height })
    Expect((await Sharp(Next.Bytes).metadata()).format).toBe('png')
    Expect(Replaced.Entries.find((Entry) => Entry.Id === 'OtherImage')?.Asset).toBe(Image.Asset)
    Expect(Replaced.Issues).toEqual([])
  })
  It('supports bound endpoints, explicit detachment, world-coordinate bends and free line frame edits', async () => {
    const { Project, Source } = await Fixture(); await Seed(Project, Source)
    await Command(Project, 'image', 'update', { id: 'ImageA', x: 140 })
    const Catalog = await ReadCatalog(Project), Resolved = ResolveArrowBindings(Catalog.Entries.map((Entry) => Entry.Item))
    const Line = Resolved.find((Item) => Item.id === 'LineA') as BoardArrow
    Expect(ArrowEndpoints(Line).start.x).toBeCloseTo(300)
    await Expect(Command(Project, 'element', 'update', { id: 'LineA', x: 0 })).rejects.toThrow('绑定连线')
    await Command(Project, 'line', 'update', { id: 'LineA', startBinding: null, endBinding: null, start: { x: 10, y: 20 }, end: { x: 300, y: 200 }, axis: 'horizontal', bend: 120, color: '#FFAA22', thickness: 4, dashed: true })
    const Edited = (await ReadCatalog(Project)).Entries.find((Entry) => Entry.Id === 'LineA')!.Item as BoardArrow
    Expect(Edited.arrow).toMatchObject({ manualBend: true, dashed: true, thickness: 4 })
    Expect(ArrowEndpoints(Edited).bend).toBeCloseTo(120)
    await Command(Project, 'element', 'update', { id: 'LineA', x: 250, width: 600 })
    const Next = (await ReadCatalog(Project)).Entries.find((Entry) => Entry.Id === 'LineA')!.Item as BoardArrow
    Expect(ArrowEndpoints(Next).start.x).toBeGreaterThan(250)
    Expect(Next.width).toBeGreaterThan(500)
    const Store = new Storage.ImageStore(); await Store.LoadProject(Project)
    Expect((await Store.ScanProject(Project)).document.arrows![0].arrow.manualBend).toBe(true)
  })
  It('rejects duplicate IDs, unsupported fields, invalid styles, missing targets and malformed inputs without writes', async () => {
    const { Project, Source } = await Fixture(); await Seed(Project, Source)
    const Directory = Join(Dirname(Project), 'Resource'), Before = await Readdir(Directory)
    await Expect(Command(Project, 'text', 'create', { id: 'ImageA' })).rejects.toThrow('已存在')
    await Expect(Command(Project, 'text', 'update', { id: 'TextA', text: { font: { wieght: 700 } } })).rejects.toThrow('wieght')
    await Expect(Command(Project, 'text', 'update', { id: 'TextA', text: { opacity: 2 } })).rejects.toThrow('0 到 1')
    await Expect(Command(Project, 'line', 'update', { id: 'LineA', endBinding: { id: 'missing', side: 'left' } })).rejects.toThrow('绑定目标')
    await Expect(Command(Project, 'image', 'update', { id: 'ImageA', width: -10 })).rejects.toThrow('大于零')
    await Expect(RunCommand(['element', 'update', '--project', Project, '--id', 'ImageA', '--widht', '10'], Repository)).rejects.toThrow('widht')
    Expect(await Readdir(Directory)).toEqual(Before)
  })
  It('validates corrupted content and duplicate resource IDs without changing the index', async () => {
    const { Project, Source } = await Fixture(); await Seed(Project, Source)
    const Catalog = await ReadCatalog(Project), Text = Catalog.Entries.find((Entry) => Entry.Id === 'TextA')!, Before = await ReadFile(Project)
    await WriteFile(Join(Catalog.Directory, Text.Asset), 'bad yaml')
    const Invalid = await RunCommand(['validate', '--project', Project], Repository)
    Expect(Invalid.ok).toBe(false)
    Expect(JSON.stringify(Invalid.issues)).toContain('哈希')
    await WriteFile(Join(Catalog.Directory, Text.Asset), Text.Bytes)
    const Duplicate = `Text_${Hash('duplicate', 16)}_${Hash(Text.Bytes)}`
    await WriteFile(Join(Catalog.Directory, 'Resource', `${Duplicate}.yaml`), Text.Bytes)
    await WriteFile(Join(Catalog.Directory, 'Resource', `${Duplicate}.config`), Text.LayoutText)
    Expect((await RunCommand(['validate', '--project', Project], Repository)).ok).toBe(false)
    await Expect(Command(Project, 'text', 'create', { id: 'NewText' })).rejects.toThrow('重复')
    Expect(await ReadFile(Project)).toEqual(Before)
  })
  It('detects external changes and rolls back a partially published content revision', async () => {
    const { Project, Source } = await Fixture(); await Seed(Project, Source)
    const Catalog = await ReadCatalog(Project), Text = Catalog.Entries.find((Entry) => Entry.Id === 'TextA')!, Config = Join(Catalog.Directory, Text.Config)
    await WriteFile(Config, `${Text.LayoutText}\n`)
    await Expect(PublishChanges(Catalog, [{ Path: Config, Before: Buffer.from(Text.LayoutText), After: Buffer.from('ignored') }])).rejects.toThrow('被修改')
    await WriteFile(Config, Text.LayoutText)
    const Files = (await Readdir(Join(Catalog.Directory, 'Resource'))).sort(), Original = Storage.AtomicWrite
    let Writes = 0
    Vi.spyOn(Storage, 'AtomicWrite').mockImplementation(async (...Arguments) => {
      if (++Writes === 3) throw new Error('injected publication failure')
      return Original(...Arguments)
    })
    await Expect(Command(Project, 'text', 'update', { id: 'TextA', content: 'new content' })).rejects.toThrow('已回滚')
    Expect((await Readdir(Join(Catalog.Directory, 'Resource'))).sort()).toEqual(Files)
    Expect(await ReadFile(Config, 'utf8')).toBe(Text.LayoutText)
  })
  It('retries transient Windows file locks while still rejecting edits made before a retry', async () => {
    const { Project, Source } = await Fixture(); await Seed(Project, Source)
    const Catalog = await ReadCatalog(Project), Text = Catalog.Entries.find((Entry) => Entry.Id === 'TextA')!, Original = Storage.AtomicWrite
    let Attempts = 0
    const Writer = Vi.spyOn(Storage, 'AtomicWrite').mockImplementation(async (...Arguments) => {
      if (++Attempts === 1) throw Object.assign(new Error('temporary file lock'), { code: 'EPERM' })
      return Original(...Arguments)
    })
    await Command(Project, 'element', 'update', { id: 'TextA', x: 120 })
    Expect(Attempts).toBe(2)
    const Config = Join(Catalog.Directory, Text.Config), External = `${await ReadFile(Config, 'utf8')}# External editor\n`
    Attempts = 0
    Writer.mockImplementation(async (...Arguments) => {
      if (++Attempts === 1) {
        await WriteFile(Config, External)
        throw Object.assign(new Error('temporary file lock'), { code: 'EPERM' })
      }
      return Original(...Arguments)
    })
    await Expect(Command(Project, 'element', 'update', { id: 'TextA', x: 240 })).rejects.toThrow()
    Expect(await ReadFile(Config, 'utf8')).toBe(External)
  })
  It('permanently deletes only a verified independent project and respects concurrent command locks', async () => {
    const { Project, Root, Source } = await Fixture(); await Seed(Project, Source)
    await Expect(RunCommand(['project', 'create', '--root', Root, '--name', 'Board'], Repository)).rejects.toThrow()
    await WithProjectLock(Project, async () => {
      await Expect(Command(Project, 'text', 'update', { id: 'TextA', content: 'busy' })).rejects.toThrow('占用')
    })
    const Other = Join(Dirname(Project), 'Other.hbr')
    await WriteFile(Other, await ReadFile(Project))
    await Expect(RunCommand(['project', 'delete', '--project', Project], Repository)).rejects.toThrow('其他项目')
    await Rm(Other)
    const Outside = Join(Root, 'Outside'); await Mkdir(Outside); await WriteFile(Join(Outside, 'keep'), 'keep')
    const Link = Join(Dirname(Project), 'Linked')
    await Symlink(Outside, Link, 'junction')
    await Expect(RunCommand(['project', 'delete', '--project', Project], Repository)).rejects.toThrow('链接')
    await Rm(Link)
    Expect((await RunCommand(['project', 'delete', '--project', Project], Repository)).permanent).toBe(true)
    Expect(await ReadFile(Join(Outside, 'keep'), 'utf8')).toBe('keep')
    await Expect(ReadFile(Project)).rejects.toThrow()
  })
})
