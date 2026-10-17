import { createHash as CreateHash } from 'node:crypto'
import FsPromises from 'node:fs/promises'
import { syncBuiltinESMExports as SyncBuiltinEsmExports } from 'node:module'
import { existsSync as ExistsSync, mkdtempSync as MkdtempSync, readFileSync as ReadFileSync, rmSync as RmSync, writeFileSync as WriteFileSync } from 'node:fs'
import { tmpdir as Tmpdir } from 'node:os'
import { basename as Basename, dirname as Dirname, join as Join, resolve as Resolve } from 'node:path'
import Sharp from 'sharp'
import { parse as Parse, stringify as Stringify } from 'yaml'
import { afterEach as AfterEach, describe as Describe, expect as Expect, it as It, vi as Vi } from 'vitest'
import { CreateArrow } from '../Shared/Arrows'
import { EmptyDocument, EmptyTextResource, type BoardDocument } from '../Shared/Types'
import { ImageStore } from './Storage'

const Roots: string[] = []
function Temp(): string {
  const Root = MkdtempSync(Join(Tmpdir(), 'hybridref-recovery-'))
  Roots.push(Root)
  return Root
}
AfterEach(() => {
  Vi.restoreAllMocks(); SyncBuiltinEsmExports()
  for (const Root of Roots.splice(0)) {
    if (Dirname(Resolve(Root)) !== Resolve(Tmpdir()) || !Basename(Root).startsWith('hybridref-recovery-')) throw new Error('Unsafe test cleanup path')
    RmSync(Root, { recursive: true, force: true })
  }
})
function Read(Path: string): ReturnType<typeof Parse> { return Parse(ReadFileSync(Path, 'utf8')) }
async function Fixture() {
  const Root = Temp(), Path = Join(Root, 'Recovery.hbr'), Store = new ImageStore()
  const Document: BoardDocument = { ...EmptyDocument(), formatVersion: 4, arrows: [] }
  for (const Index of [0, 1]) {
    const Bytes = await Sharp({ create: { width: 20, height: 10, channels: 3, background: Index ? '#ee3344' : '#3355aa' } }).png().toBuffer()
    const Imported = await Store.ImportBuffers([{ name: 'image.png', bytes: Bytes }])
    Document.images.push({ id: `image-${Index}`, asset: Imported.assets[0].id, x: Index * 100, y: 0, width: 80, height: 40 })
    Document.texts.push({ id: `text-${Index}`, x: Index * 200, y: 80, width: 180, height: 90, text: EmptyTextResource(`文字 ${Index}`) })
    Document.arrows!.push(CreateArrow(`line-${Index}`, { x: 0, y: 300 + Index * 40 }, { x: 200, y: 340 + Index * 40 }))
  }
  Document.arrows![1].arrow.startBinding = { id: 'text-0', side: 'right', offset: 0.5 }
  await Store.SaveProject(Path, Document)
  return { Root, Path, Document, Stored: Read(Path) }
}

Describe('Resource recovery and newline compatibility', () => {
  It('retains hidden references and keeps cleanup retryable when recovered-resource publication fails', async () => {
    const { Root, Path, Stored } = await Fixture()
    const Files = [Stored.texts[0], Stored.arrows[0]].map((Item) => Join(Root, Item.asset))
    const Original = Files.map((File) => ReadFileSync(File))
    for (const File of Files) WriteFileSync(File, 'corrupt')
    const Store = new ImageStore(), Loaded = await Store.LoadProject(Path)
    for (const [Index, File] of Files.entries()) WriteFileSync(File, Original[Index])
    Loaded.document.viewport.x = 50
    const Rename = FsPromises.rename
    Vi.spyOn(FsPromises, 'rename').mockImplementation(async (From, To) => {
      if (To === Path) throw new Error('simulated publication failure')
      return Rename(From, To)
    })
    SyncBuiltinEsmExports()
    await Expect(Store.CleanupProject(Path, Loaded.document)).rejects.toThrow('publication failure')
    Vi.restoreAllMocks(); SyncBuiltinEsmExports()
    // A stale UI document must not delete the now-restored hidden resources.
    await Expect(Store.SaveProject(Path, Loaded.document)).rejects.toThrow('资源已恢复')
    Expect(Read(Path).texts).toEqual(Stored.texts)
    Expect(Read(Path).arrows).toEqual(Stored.arrows)
    Expect(Files.map((File) => ReadFileSync(File))).toEqual(Original)
    const Recovered = await Store.CleanupProject(Path, Loaded.document)
    Expect(Recovered.resourceIssues).toBeUndefined()
    Expect(Recovered.document.texts).toHaveLength(2)
    Expect(Recovered.document.arrows).toHaveLength(2)
  })

  It('loads, saves, cleans and copies CRLF YAML without rewriting existing resource bytes', async () => {
    const { Root, Path, Stored, Document } = await Fixture()
    const Files = [...Stored.texts, ...Stored.arrows].map((Item: { asset: string }) => Join(Root, Item.asset))
    for (const File of Files) WriteFileSync(File, ReadFileSync(File, 'utf8').replace(/\n/g, '\r\n'))
    const Before = Files.map((File) => ReadFileSync(File))
    const Store = new ImageStore(), Loaded = await Store.LoadProject(Path)
    Expect(Loaded.resourceIssues).toBeUndefined()
    Expect(Loaded.document).toEqual(Document)
    await Store.SaveProject(Path, Loaded.document)
    Expect((await Store.CleanupProject(Path, Loaded.document)).resourceIssues).toBeUndefined()
    Expect(Files.map((File) => ReadFileSync(File))).toEqual(Before)
    const Copy = Join(Temp(), 'Copy.hbr')
    await Store.SaveProject(Copy, Loaded.document)
    Expect((await new ImageStore().LoadProject(Copy)).document).toEqual(Document)
  })

  It('also accepts LF bytes when a YAML filename was hashed from CRLF bytes', async () => {
    const { Root, Path, Stored, Document } = await Fixture()
    for (const Item of [...Stored.texts, ...Stored.arrows]) {
      const Original = Join(Root, Item.asset), Bytes = ReadFileSync(Original)
      const Hash = CreateHash('sha256').update(Bytes.toString('utf8').replace(/\n/g, '\r\n')).digest('hex').slice(0, 8).toUpperCase()
      const Reference = Item.asset.replace(/_[A-F0-9]{8}\.yaml$/, `_${Hash}.yaml`)
      WriteFileSync(Join(Root, Reference), Bytes)
      if (Item.asset.includes('Line_')) WriteFileSync(Join(Root, Reference.replace('.yaml', '.config')), ReadFileSync(Original.replace('.yaml', '.config')))
      Item.asset = Reference
    }
    WriteFileSync(Path, Stringify(Stored))
    const Store = new ImageStore(), Loaded = await Store.LoadProject(Path)
    Expect(Loaded.resourceIssues).toBeUndefined()
    Expect(Loaded.document).toEqual(Document)
    await Store.SaveProject(Path, Loaded.document)
    Expect((await new ImageStore().LoadProject(Path)).document).toEqual(Document)
  })

  It('preserves corrupt image/text/line bytes, references, layout and bindings while saving healthy edits', async () => {
    const { Root, Path, Stored, Document } = await Fixture()
    const Bad = [Stored.images[0], Stored.texts[0], Stored.arrows[0]]
    const Files = Bad.map((Item) => Join(Root, Item.asset))
    const Originals = Files.map((File) => ReadFileSync(File))
    WriteFileSync(Files[0], 'damaged image')
    WriteFileSync(Files[1], Stringify(EmptyTextResource('外部修改的正文')))
    WriteFileSync(Files[2], 'damaged line')
    const Damaged = Files.map((File) => ReadFileSync(File))
    const Store = new ImageStore(), Loaded = await Store.LoadProject(Path)
    Expect(Loaded.resourceIssues).toHaveLength(3)
    Expect(Loaded.document.images).toHaveLength(2)
    Expect(Loaded.assets.filter((Asset) => !Asset.missing)).toHaveLength(1)
    Expect(Loaded.document.texts.map((Item) => Item.id)).toEqual(['text-1'])
    Expect(Loaded.document.arrows?.map((Item) => Item.id)).toEqual(['line-1'])
    Loaded.document.texts[0].text.content = '保留新的编辑'
    WriteFileSync(Join(Root, 'Resource/Orphan.yaml'), 'unreferenced')
    await Store.SaveProject(Path, Loaded.document)
    const Cleaned = await Store.CleanupProject(Path, Loaded.document)
    Expect(Cleaned.resourceIssues).toHaveLength(3)
    Expect(Files.map((File) => ReadFileSync(File))).toEqual(Damaged)
    const Saved = Read(Path)
    Expect(Saved.images).toEqual(Stored.images)
    Expect(Saved.texts[0]).toEqual(Stored.texts[0])
    Expect(Saved.arrows[0]).toEqual(Stored.arrows[0])
    Expect(Read(Join(Root, Saved.arrows[1].asset)).arrow.startBinding).toEqual(Document.arrows![1].arrow.startBinding)
    Expect(ExistsSync(Join(Root, 'Resource/Orphan.yaml'))).toBe(false)
    for (const [Index, File] of Files.entries()) WriteFileSync(File, Originals[Index])
    const Recovered = await Store.CleanupProject(Path, Cleaned.document)
    Expect(Recovered.resourceIssues).toBeUndefined()
    Expect(Recovered.document.texts.map((Item) => Item.id)).toEqual(['text-0', 'text-1'])
    Expect(Recovered.document.texts[1].text.content).toBe('保留新的编辑')
    Expect(Recovered.document.images).toEqual(Document.images)
    Expect(Recovered.document.arrows).toEqual(Document.arrows)
  })

  It.each([false, true])('copies all unavailable bytes and configs on Save As, sibling=%s', async (Sibling) => {
    const { Root, Path, Stored } = await Fixture()
    const ImageConfig = Join(Root, Stored.images[0].asset.replace('.png', '.config'))
    const LineConfig = Join(Root, Stored.arrows[0].asset.replace('.yaml', '.config'))
    WriteFileSync(ImageConfig, 'broken image layout')
    WriteFileSync(LineConfig, 'broken line layout')
    WriteFileSync(Join(Root, Stored.texts[0].asset), 'broken text')
    const OriginalProject = ReadFileSync(Path)
    const Store = new ImageStore(), Loaded = await Store.LoadProject(Path)
    Expect(Loaded.resourceIssues).toHaveLength(3)
    const Copy = Join(Sibling ? Root : Temp(), 'Copy.hbr')
    const Result = await Store.SaveProject(Copy, Loaded.document)
    const Saved = Read(Copy)
    Expect(Result.resourceIssues?.map((Issue) => Issue.asset)).toEqual([Saved.images[0].asset, Saved.texts[0].asset, Saved.arrows[0].asset])
    for (const Kind of ['images', 'texts', 'arrows']) {
      const Before = Join(Root, Stored[Kind][0].asset), After = Join(Dirname(Copy), Saved[Kind][0].asset)
      Expect(ReadFileSync(After)).toEqual(ReadFileSync(Before))
      if (Kind !== 'texts') Expect(ReadFileSync(After.replace(/\.(png|yaml)$/, '.config'))).toEqual(ReadFileSync(Before.replace(/\.(png|yaml)$/, '.config')))
    }
    Expect(ReadFileSync(Path)).toEqual(OriginalProject)
    const Reopened = new ImageStore(), Copied = await Reopened.LoadProject(Copy)
    Expect(Copied.resourceIssues).toHaveLength(3)
    await Reopened.SaveProject(Copy, Copied.document)
    Expect((await Reopened.CleanupProject(Copy, Copied.document)).resourceIssues).toHaveLength(3)
  })

  It('protects Markdown-only PNGs referenced by damaged text, including text that cannot be parsed', async () => {
    const { Root, Path, Stored } = await Fixture()
    const TextFile = Join(Root, Stored.texts[0].asset), Image = Join(Root, 'Resource/MarkdownOnly.png')
    WriteFileSync(Image, ReadFileSync(Join(Root, Stored.images[0].asset)))
    for (const Content of [Stringify(EmptyTextResource('![保留](Resource/MarkdownOnly.png)')), 'content: [invalid YAML']) {
      WriteFileSync(TextFile, Content)
      const Store = new ImageStore(), Loaded = await Store.LoadProject(Path)
      await Store.CleanupProject(Path, Loaded.document)
      Expect(ExistsSync(Image)).toBe(true)
      Expect(ReadFileSync(TextFile, 'utf8')).toBe(Content)
      Expect(Read(Path).texts[0]).toEqual(Stored.texts[0])
    }
  })

  It('recovers missing layout instances without pruning other unavailable instances sharing a PNG', async () => {
    const { Root, Path, Stored, Document } = await Fixture()
    Stored.images.push({ ...Stored.images[0], id: 'hidden-instance' })
    WriteFileSync(Path, Stringify(Stored))
    const Store = new ImageStore(), Loaded = await Store.LoadProject(Path)
    Expect(Loaded.resourceIssues?.[0].id).toBe('hidden-instance')
    await Store.SaveProject(Path, Loaded.document)
    Expect(Read(Path).images).toEqual(Stored.images)
    const ConfigPath = Join(Root, Stored.images[0].asset.replace('.png', '.config')), Config = Read(ConfigPath)
    Config.instances['hidden-instance'] = { x: 900, y: 400, width: 80, height: 40 }
    WriteFileSync(ConfigPath, Stringify(Config))
    const Recovered = await Store.CleanupProject(Path, Loaded.document)
    Expect(Recovered.resourceIssues).toBeUndefined()
    Expect(Recovered.document.images).toEqual([...Document.images, { id: 'hidden-instance', asset: Document.images[0].asset, ...Config.instances['hidden-instance'] }])
  })
})
