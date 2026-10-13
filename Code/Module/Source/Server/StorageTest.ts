import { createHash as CreateHash } from 'node:crypto'
import { cpSync as CpSync, existsSync as ExistsSync, mkdirSync as MkdirSync, mkdtempSync as MkdtempSync, readFileSync as ReadFileSync, readdirSync as ReaddirSync, rmSync as RmSync, symlinkSync as SymlinkSync, writeFileSync as WriteFileSync } from 'node:fs'
import { tmpdir as Tmpdir } from 'node:os'
import { basename as Basename, join as Join, resolve as Resolve } from 'node:path'
import { encode as EncodeBmp } from 'bmp-js'
import Sharp from 'sharp'
import { parse as Parse, stringify as Stringify } from 'yaml'
import { afterEach as AfterEach, describe as Describe, expect as Expect, it as It, vi as Vi } from 'vitest'
import { ImageStore } from './Storage'
import { EmptyTextResource, type BoardDocument, type BoardText } from '../Shared/Types'

const Roots: string[] = []
function Temp(): string {
  const Path = MkdtempSync(Join(Tmpdir(), 'hybridref-store-'))
  Roots.push(Path)
  return Path
}
AfterEach(() => {
  Vi.restoreAllMocks()
  for (const Path of Roots.splice(0)) {
    if (!Resolve(Path).startsWith(Join(Tmpdir(), 'hybridref-store-'))) throw new Error('Unsafe test cleanup path')
    RmSync(Path, { recursive: true, force: true })
  }
})
function Board(Asset?: string): BoardDocument {
  return {
    format: 'hybridref', formatVersion: 3, viewport: { x: 20, y: -10, zoom: 1 },
    images: Asset ? [{ id: 'image-1', asset: Asset, x: 10.125, y: 20, width: 130, height: 90 }] : [],
    texts: [],
  }
}
function TextBoard(Content = '中文标题\n第二行  空格\n\t缩进\n\n'): BoardDocument {
  return { ...Board(), texts: [{ id: 'text-1', x: -10.25, y: 30.5, width: 320, height: 180, text: EmptyTextResource(Content) }] }
}
async function Jpeg(): Promise<Buffer> {
  return Sharp({ create: { width: 13, height: 9, channels: 3, background: '#24b7d3' } }).jpeg().toBuffer()
}
function Bytes(DataUrl: string): Buffer { return Buffer.from(DataUrl.split(',')[1], 'base64') }
function Hash(Value: Buffer): string { return CreateHash('sha256').update(Value).digest('hex') }
// Two valid compressed PNGs with different SHA256 digests beginning D9D0F99F.
const CollisionPngs = [
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVR42mPYXM3AwMAAAAagAS/XvTdHAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVR42mOIymFiYGAAAARHAMkYYlopAAAAAElFTkSuQmCC',
].map((Text) => Buffer.from(Text, 'base64'))

Describe('HybridRef image and text storage', () => {
  It.each(['中文标题\n第二行  空格\n\t缩进\n\n', '', '   \n\t\r\n', 'emoji 🌄 <script> & # : "quoted"'])('stores text content %j in its own deterministic resource with only a layout reference in hbr', async (Content) => {
    const Root = Temp()
    const Path = Join(Root, '文字 #%25.hbr')
    const Store = new ImageStore()
    const Document = TextBoard(Content)
    Document.texts[0].text.font = { family: '微软雅黑', size: 36, weight: 700, color: '#24b7d3', opacity: 0.65 }
    Document.texts[0].text.background = { color: '#F0F0F0', opacity: 0 }
    Document.texts[0].text.paragraph = { align: 'right', lineHeight: 1.75 }
    Document.texts[0].text.padding = 0
    await Store.SaveProject(Path, Document)
    const Before = ReadFileSync(Path, 'utf8')
    const Stored = Parse(Before)
    Expect(Object.keys(Stored.texts[0])).toEqual(['id', 'asset', 'x', 'y', 'width', 'height'])
    Expect(Stored.texts[0].asset).toMatch(/^文字 #%25Resource\/Text_text-1_[a-f0-9]{16}\.yaml$/)
    const Resource = ReadFileSync(Join(Root, Stored.texts[0].asset))
    Expect(Parse(Resource.toString('utf8'))).toEqual(Document.texts[0].text)
    Expect(Stored.texts[0].asset).toContain(Hash(Resource).slice(0, 16))
    Expect(Before).not.toMatch(/content:|font:|paragraph:|background:/)
    const Reopened = new ImageStore()
    const Loaded = await Reopened.LoadProject(Path)
    Expect(Loaded.document).toEqual(Document)
    Expect(Loaded.assets).toEqual([])
    await Reopened.SaveProject(Path, Loaded.document)
    Expect(ReadFileSync(Path, 'utf8')).toBe(Before)
    Expect(ReadFileSync(Join(Root, Stored.texts[0].asset))).toEqual(Resource)
    Expect(ReaddirSync(Join(Root, '文字 #%25Resource'))).toEqual([Basename(Stored.texts[0].asset)])
  })

  It('roundtrips a mixed board and saves it elsewhere entirely from memory', async () => {
    const Root = Temp()
    const Store = new ImageStore()
    const Imported = await Store.ImportBuffers([{ name: 'mixed.jpg', bytes: await Jpeg() }])
    const Document = { ...Board(Imported.assets[0].id), texts: TextBoard().texts }
    const Path = Join(Root, 'Mixed.hbr')
    await Store.SaveProject(Path, Document)
    Expect(ReaddirSync(Join(Root, 'MixedResource'))).toHaveLength(2)
    const Reopened = new ImageStore()
    const Loaded = await Reopened.LoadProject(Path)
    Expect(Loaded.document).toEqual(Document)
    Expect(Loaded.assets).toEqual(Imported.assets)
    // Simulate removable source storage disappearing after open.
    for (const Name of ReaddirSync(Join(Root, 'MixedResource'))) RmSync(Join(Root, 'MixedResource', Name))
    const SavedAs = Join(Temp(), '另存.hbr')
    await Reopened.SaveProject(SavedAs, Loaded.document)
    Expect((await new ImageStore().LoadProject(SavedAs)).document).toEqual(Document)
  })

  It('creates immutable text versions and independent resources for copied objects', async () => {
    const Root = Temp()
    const Path = Join(Root, 'Versions.hbr')
    const Store = new ImageStore()
    const Document = TextBoard('初稿')
    await Store.SaveProject(Path, Document)
    const FirstYaml = ReadFileSync(Path, 'utf8')
    const First = Parse(FirstYaml)
    const FirstResource = ReadFileSync(Join(Root, First.texts[0].asset))
    Document.texts.push({ ...Document.texts[0], id: 'copy_2', text: structuredClone(Document.texts[0].text) })
    Document.texts[0].text.content = '修改后的正文'
    Document.texts[0].text.font.opacity = 0.4
    await Store.SaveProject(Path, Document)
    const Second = Parse(ReadFileSync(Path, 'utf8'))
    Expect(Second.texts[0].asset).not.toBe(First.texts[0].asset)
    Expect(Second.texts[1].asset).not.toBe(First.texts[0].asset)
    Expect(Second.texts[1].asset).toMatch(/Text_copy_2_/)
    Expect(ReadFileSync(Join(Root, First.texts[0].asset))).toEqual(FirstResource)
    Expect(ReaddirSync(Join(Root, 'VersionsResource'))).toHaveLength(3)
    WriteFileSync(Join(Root, 'Snapshot.hbr'), FirstYaml)
    Expect((await new ImageStore().LoadProject(Join(Root, 'Snapshot.hbr'))).document.texts[0].text.content).toBe('初稿')
    Expect((await new ImageStore().LoadProject(Path)).document).toEqual(Document)
  })

  It('loads image-only version 2 and upgrades only when explicitly saved', async () => {
    const Root = Temp()
    const Store = new ImageStore()
    const Imported = await Store.ImportBuffers([{ name: 'legacy.jpg', bytes: await Jpeg() }])
    const Path = Join(Root, 'Version2.hbr')
    await Store.SaveProject(Path, Board(Imported.assets[0].id))
    const Stored = Parse(ReadFileSync(Path, 'utf8'))
    Stored.formatVersion = 2
    delete Stored.texts
    const Version2 = Stringify(Stored)
    WriteFileSync(Path, Version2)
    const Reopened = new ImageStore()
    const Loaded = await Reopened.LoadProject(Path)
    Expect(Loaded.document).toEqual(Board(Imported.assets[0].id))
    Expect(ReadFileSync(Path, 'utf8')).toBe(Version2)
    await Reopened.SaveProject(Path, Loaded.document)
    Expect(Parse(ReadFileSync(Path, 'utf8'))).toMatchObject({ formatVersion: 3, texts: [] })
  })

  It('protects an existing project and immutable text target from conflicting content', async () => {
    const Root = Temp()
    const Store = new ImageStore()
    const Path = Join(Root, 'ProtectedText.hbr')
    const Document = TextBoard()
    await Store.SaveProject(Path, Document)
    const Before = ReadFileSync(Path, 'utf8')
    const Resource = Join(Root, Parse(Before).texts[0].asset)
    WriteFileSync(Resource, 'external edit')
    await Expect(Store.SaveProject(Path, Document)).rejects.toThrow('目标文本资源已损坏')
    Expect(ReadFileSync(Path, 'utf8')).toBe(Before)
    Expect(ReadFileSync(Resource, 'utf8')).toBe('external edit')
    await Expect(new ImageStore().LoadProject(Path)).rejects.toThrow('文本资源内容哈希不匹配')
  })

  It.each(['../outside/', '..\\outside\\', 'C:/outside/', '/outside/', 'local:///outside/', './Resource/'])('rejects unsafe text path prefix %s', async (Prefix) => {
    const Root = Temp()
    const Stored = { ...Board(), texts: [{ id: 'text-1', asset: `${Prefix}Text_text-1_aaaaaaaaaaaaaaaa.yaml`, x: 0, y: 0, width: 100, height: 100 }] }
    const Path = Join(Root, 'UnsafeText.hbr')
    WriteFileSync(Path, Stringify(Stored))
    await Expect(new ImageStore().LoadProject(Path)).rejects.toThrow('路径不安全')
  })

  It('rejects missing, malformed, mismatched and junction-escaped text resources without losing cached images', async () => {
    const Root = Temp()
    const Outside = Temp()
    const Store = new ImageStore()
    const Imported = await Store.ImportBuffers([{ name: 'keep.jpg', bytes: await Jpeg() }])
    const Path = Join(Root, 'BrokenText.hbr')
    const Text = Buffer.from(Stringify(EmptyTextResource('safe')))
    const Filename = `Text_text-1_${Hash(Text).slice(0, 16)}.yaml`
    const Stored = { ...Board(), texts: [{ id: 'text-1', asset: `BrokenTextResource/${Filename}`, x: 0, y: 0, width: 100, height: 100 }] }
    WriteFileSync(Path, Stringify(Stored))
    await Expect(Store.LoadProject(Path)).rejects.toThrow('无法读取文本资源')
    WriteFileSync(Join(Outside, Filename), Text)
    SymlinkSync(Outside, Join(Root, 'BrokenTextResource'), process.platform === 'win32' ? 'junction' : 'dir')
    await Expect(Store.LoadProject(Path)).rejects.toThrow('越过画板目录')
    await Expect(Store.SaveProject(Path, TextBoard())).rejects.toThrow('越过画板目录')
    Stored.texts[0].asset = `Text_other_${Hash(Text).slice(0, 16)}.yaml`
    WriteFileSync(Path, Stringify(Stored))
    await Expect(Store.LoadProject(Path)).rejects.toThrow('对象 ID 不匹配')
    const Malformed = Buffer.from('format: hybridref-text\nformatVersion: 1\ncontent: []\n')
    Stored.texts[0].asset = `Text_text-1_${Hash(Malformed).slice(0, 16)}.yaml`
    WriteFileSync(Join(Root, Stored.texts[0].asset), Malformed)
    WriteFileSync(Path, Stringify(Stored))
    await Expect(Store.LoadProject(Path)).rejects.toThrow('文字内容')
    await Store.SaveProject(Join(Root, 'KeptImages.hbr'), Board(Imported.assets[0].id))
    Expect((await new ImageStore().LoadProject(Join(Root, 'KeptImages.hbr'))).assets).toEqual(Imported.assets)
  })

  It('rejects duplicate object ids, unsafe text ids and invalid text geometry or styles before writing', async () => {
    const Root = Temp()
    const Store = new ImageStore()
    const Path = Join(Root, 'InvalidText.hbr')
    const Mutations: ((Text: BoardText) => void)[] = [
      (Text) => { Text.id = '../escape' }, (Text) => { Text.id = '' },
      (Text) => { Text.x = Infinity }, (Text) => { Text.width = 0 }, (Text) => { Text.height = -1 },
      (Text) => { Text.text.font.size = NaN }, (Text) => { Text.text.font.size = 0 },
      (Text) => { Text.text.font.family = ' ' }, (Text) => { Text.text.font.family = 'Bad\nFont' },
      (Text) => { Text.text.font.color = 'red' }, (Text) => { Text.text.background.color = '#123' },
      (Text) => { Text.text.font.opacity = 2 }, (Text) => { Text.text.background.opacity = -1 },
      (Text) => { Text.text.paragraph.lineHeight = 0 }, (Text) => { Text.text.padding = -1 },
      (Text) => { Text.text = { ...Text.text, content: 42 } as unknown as BoardText['text'] },
      (Text) => { Text.text.font.weight = 500 as 400 },
      (Text) => { Text.text.paragraph.align = 'justify' as 'left' },
      (Text) => { Text.text.paragraph.align = ['left'] as unknown as 'left' },
      (Text) => { Text.text.formatVersion = 2 as 1 },
    ]
    for (const Mutate of Mutations) {
      const Document = TextBoard()
      Mutate(Document.texts[0])
      await Expect(Store.SaveProject(Path, Document)).rejects.toThrow()
      Expect(ExistsSync(Path)).toBe(false)
    }
    const Duplicate = { ...Board('a'.repeat(64)), texts: TextBoard().texts }
    Duplicate.texts[0].id = Duplicate.images[0].id
    await Expect(Store.SaveProject(Path, Duplicate)).rejects.toThrow('重复')
    const DuplicateTexts = TextBoard()
    DuplicateTexts.texts.push({ ...DuplicateTexts.texts[0] })
    await Expect(Store.SaveProject(Path, DuplicateTexts)).rejects.toThrow('重复')
    Expect(ReaddirSync(Root)).toEqual([])
  })

  It('creates the resource directory for an empty project and keeps repeated saves deterministic', async () => {
    const Root = Temp()
    const Path = Join(Root, 'Empty', 'Empty.hbr')
    const Store = new ImageStore()
    await Store.SaveProject(Path, Board())
    const Before = ReadFileSync(Path, 'utf8')
    Expect(ReaddirSync(Join(Root, 'Empty')).sort()).toEqual(['Empty.hbr', 'EmptyResource'])
    Expect(ReaddirSync(Join(Root, 'Empty', 'EmptyResource'))).toEqual([])
    Expect((await new ImageStore().LoadProject(Path)).document).toEqual(Board())
    await Store.SaveProject(Path, Board())
    Expect(ReadFileSync(Path, 'utf8')).toBe(Before)
  })

  It('normalizes JPEG and BMP to compressed PNG with actual dimensions, colors and content ids', async () => {
    const Store = new ImageStore()
    const Bmp = EncodeBmp({ width: 2, height: 1, data: Buffer.from([0, 0, 0, 255, 0, 0, 255, 0]) }).data
    const Result = await Store.ImportBuffers([{ name: 'photo.jpg', bytes: await Jpeg() }, { name: 'pixels.bmp', bytes: Bmp }])
    Expect(Result.errors).toEqual([])
    Expect(Result.assets).toHaveLength(2)
    Expect(Result.assets[0]).toMatchObject({ width: 13, height: 9 })
    for (const ImageValue of Result.assets) {
      Expect(ImageValue.dataUrl).toMatch(/^data:image\/png;base64,/)
      Expect(ImageValue.id).toBe(Hash(Bytes(ImageValue.dataUrl)))
      Expect(await Sharp(Bytes(ImageValue.dataUrl)).metadata()).toMatchObject({ format: 'png' })
    }
    Expect(await Sharp(Bytes(Result.assets[1].dataUrl)).ensureAlpha().raw().toBuffer()).toEqual(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]))
  })

  It.each(['gif', 'webp'] as const)('imports only the first frame of an animated %s', async (Format) => {
    const Pixels = Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255])
    const Decoder = Sharp(Pixels, { raw: { width: 2, height: 2, channels: 4, pageHeight: 1 } })
    const Animation = Format === 'gif' ? await Decoder.gif({ delay: [100, 100] }).toBuffer() : await Decoder.webp({ lossless: true, delay: [100, 100] }).toBuffer()
    Expect((await Sharp(Animation, { animated: true }).metadata()).pages).toBe(2)
    const Result = await new ImageStore().ImportBuffers([{ name: `animation.${Format}`, bytes: Animation }])
    Expect(Result.errors).toEqual([])
    Expect(Result.assets[0]).toMatchObject({ width: 2, height: 1 })
    Expect(await Sharp(Bytes(Result.assets[0].dataUrl)).ensureAlpha().raw().toBuffer()).toEqual(Pixels.subarray(0, 8))
  })

  It('reports bad inputs individually and keeps every successful import', async () => {
    const Root = Temp()
    const Photo = Join(Root, '参考 #%25.jpg')
    WriteFileSync(Photo, await Jpeg())
    const Store = new ImageStore()
    const Files = await Store.ImportFiles([Join(Root, 'missing.jpg'), Photo])
    Expect(Files.assets).toHaveLength(1)
    Expect(Files.errors).toHaveLength(1)
    Expect(Files.errors[0]).toContain('missing.jpg')
    const Buffers = await Store.ImportBuffers([{ name: 'not-an-image.png', bytes: Buffer.from('broken') }, { name: 'valid.jpg', bytes: await Jpeg() }])
    Expect(Buffers.assets).toHaveLength(1)
    Expect(Buffers.errors[0]).toContain('not-an-image.png')
    Expect(Files.assets[0].id).toBe(Buffers.assets[0].id)
  })

  It('assigns a timestamp filename once on import and preserves it on duplicate import and after reopening', async () => {
    const Root = Temp()
    const Path = Join(Root, 'StableName.hbr')
    let Now = 1700000000000
    Vi.spyOn(Date, 'now').mockImplementation(() => Now)
    const Store = new ImageStore()
    const Photo = await Jpeg()
    const Imported = await Store.ImportBuffers([{ name: 'first.jpg', bytes: Photo }])
    const Id = Imported.assets[0].id
    const Filename = `1700000000000_${Id.slice(0, 8).toUpperCase()}.png`
    Now += 5000
    const Duplicate = await Store.ImportBuffers([{ name: 'again.jpg', bytes: Photo }])
    Expect(Duplicate.assets[0].id).toBe(Id)
    const Doc = Board(Id)
    Doc.images.push({ ...Doc.images[0], id: 'image-2', x: 200 })
    await Store.SaveProject(Path, Doc)
    const Original = ReadFileSync(Path, 'utf8')
    Expect(Parse(Original).images.map((ImageValue: { asset: string }) => ImageValue.asset)).toEqual([
      `StableNameResource/${Filename}`, `StableNameResource/${Filename}`,
    ])
    Expect(ReaddirSync(Join(Root, 'StableNameResource'))).toEqual([Filename])
    const Reopened = new ImageStore()
    const Loaded = await Reopened.LoadProject(Path)
    Now += 5000
    Expect((await Reopened.ImportBuffers([{ name: 'third.jpg', bytes: Photo }])).assets[0].id).toBe(Id)
    await Reopened.SaveProject(Path, Loaded.document)
    Expect(ReadFileSync(Path, 'utf8')).toBe(Original)
    Expect(ReaddirSync(Join(Root, 'StableNameResource'))).toEqual([Filename])
  })

  It('resolves real short-hash collisions in the same millisecond without merging or overwriting images', async () => {
    const Root = Temp()
    const Path = Join(Root, 'Collision.hbr')
    Vi.spyOn(Date, 'now').mockReturnValue(1700000000000)
    const Store = new ImageStore()
    const Imported = await Store.ImportBuffers(CollisionPngs.map((Data, Index) => ({ name: `Collision${Index}.png`, bytes: Data })))
    Expect(Imported.errors).toEqual([])
    Expect(Imported.assets).toHaveLength(2)
    Expect(Imported.assets[0].id).not.toBe(Imported.assets[1].id)
    Expect(Imported.assets.map((Asset) => Asset.id.slice(0, 8))).toEqual(['d9d0f99f', 'd9d0f99f'])
    const Doc = Board(Imported.assets[0].id)
    Doc.images.push({ ...Doc.images[0], id: 'image-2', asset: Imported.assets[1].id })
    await Store.SaveProject(Path, Doc)
    const Names = ['1700000000000_D9D0F99F.png', '1700000000001_D9D0F99F.png']
    Expect(ReaddirSync(Join(Root, 'CollisionResource')).sort()).toEqual(Names)
    for (const [Index, Name] of Names.entries()) Expect(ReadFileSync(Join(Root, 'CollisionResource', Name))).toEqual(CollisionPngs[Index])
    const Reopened = new ImageStore()
    const Loaded = await Reopened.LoadProject(Path)
    Expect(Loaded.document).toEqual(Doc)
    Expect(Loaded.assets).toEqual(Imported.assets)
    const Before = ReadFileSync(Path, 'utf8')
    await Reopened.SaveProject(Path, Loaded.document)
    Expect(ReadFileSync(Path, 'utf8')).toBe(Before)
  })

  It('uses the full hash before saving over an existing filename even when the short hashes match', async () => {
    const Root = Temp()
    const Path = Join(Root, 'ProtectedCollision.hbr')
    Vi.spyOn(Date, 'now').mockReturnValue(1700000000000)
    const Store = new ImageStore()
    const Imported = await Store.ImportBuffers([{ name: 'First.png', bytes: CollisionPngs[0] }])
    const Doc = Board(Imported.assets[0].id)
    await Store.SaveProject(Path, Doc)
    const Before = ReadFileSync(Path, 'utf8')
    const Resource = Join(Root, Parse(Before).images[0].asset)
    WriteFileSync(Resource, CollisionPngs[1])
    await Expect(Store.SaveProject(Path, Doc)).rejects.toThrow('目标图片资源已损坏')
    Expect(ReadFileSync(Path, 'utf8')).toBe(Before)
    Expect(ReadFileSync(Resource)).toEqual(CollisionPngs[1])
  })

  It('rejects legacy full-hash filenames without modifying the project or resource', async () => {
    const Root = Temp()
    const Path = Join(Root, 'Legacy.hbr')
    const Id = Hash(CollisionPngs[0])
    const Directory = Join(Root, 'LegacyResource')
    MkdirSync(Directory)
    const Resource = Join(Directory, `${Id}.png`)
    WriteFileSync(Resource, CollisionPngs[0])
    const Stored = Board(Id)
    Stored.images[0].asset = `LegacyResource/${Id}.png`
    const Before = Stringify(Stored, { indent: 2, lineWidth: 0, aliasDuplicateObjects: false, defaultKeyType: 'PLAIN', defaultStringType: 'QUOTE_DOUBLE' })
    WriteFileSync(Path, Before)
    const Store = new ImageStore()
    await Expect(Store.LoadProject(Path)).rejects.toThrow('资源名称无效')
    await Expect(Store.SaveProject(Path, Board())).rejects.toThrow('资源名称无效')
    Expect(ReadFileSync(Path, 'utf8')).toBe(Before)
    Expect(ReadFileSync(Resource)).toEqual(CollisionPngs[0])
    Expect(ReaddirSync(Directory)).toEqual([`${Id}.png`])
  })

  It('rejects a short-hash filename that does not match its PNG bytes', async () => {
    const Root = Temp()
    const Filename = '1700000000000_00000000.png'
    WriteFileSync(Join(Root, Filename), CollisionPngs[0])
    const Stored = Board(Hash(CollisionPngs[0]))
    Stored.images[0].asset = Filename
    const Path = Join(Root, 'WrongHash.hbr')
    WriteFileSync(Path, Stringify(Stored))
    await Expect(new ImageStore().LoadProject(Path)).rejects.toThrow('内容哈希不匹配')
  })

  It('saves literal Chinese/#/% paths, caches bytes after source deletion, and deduplicates image instances', async () => {
    const Root = Temp()
    const Source = Join(Root, '原图 #%25.jpg')
    WriteFileSync(Source, await Jpeg())
    const Store = new ImageStore()
    const Imported = await Store.ImportFiles([Source])
    RmSync(Source)
    const Asset = Imported.assets[0].id
    const Doc = Board(Asset)
    Doc.images.push({ ...Doc.images[0], id: 'image-2', x: 300 })
    const Path = Join(Root, '参考 #% 测试.hbr')
    await Store.SaveProject(Path, Doc)
    const Raw = ReadFileSync(Path, 'utf8')
    Expect(Raw).toContain('formatVersion: 3')
    Expect(Raw).not.toMatch(/createdAt|updatedAt|boards:|recordings:|data:image/)
    const Filename = Basename(Parse(Raw).images[0].asset)
    Expect(Filename).toMatch(/^[0-9]{13}_[A-F0-9]{8}\.png$/)
    Expect(Filename.endsWith(`_${Asset.slice(0, 8).toUpperCase()}.png`)).toBe(true)
    Expect(Parse(Raw).images.map((ImageValue: { asset: string }) => ImageValue.asset)).toEqual([`参考 #% 测试Resource/${Filename}`, `参考 #% 测试Resource/${Filename}`])
    Expect(ReaddirSync(Join(Root, '参考 #% 测试Resource'))).toEqual([Filename])
    const Loaded = await new ImageStore().LoadProject(Path)
    Expect(Loaded.document).toEqual(Doc)
    Expect(Loaded.assets).toEqual(Imported.assets)
  })

  It('has stable field order, four-decimal geometry and identical repeated saves after load', async () => {
    const Root = Temp()
    const Store = new ImageStore()
    const Result = await Store.ImportBuffers([{ name: 'photo.jpg', bytes: await Jpeg() }])
    const Path = Join(Root, 'Stable.hbr')
    const Doc = Board(Result.assets[0].id)
    Doc.images[0].x = 1.23456789
    Doc.viewport.zoom = 0.12345678
    await Store.SaveProject(Path, Doc)
    const First = ReadFileSync(Path, 'utf8')
    Expect(Parse(First).images[0].x).toBe(1.2346)
    Expect(Parse(First).viewport.zoom).toBe(0.1235)
    Expect(Object.keys(Parse(First))).toEqual(['format', 'formatVersion', 'viewport', 'images', 'texts'])
    Expect(Object.keys(Parse(First).images[0])).toEqual(['id', 'asset', 'x', 'y', 'width', 'height'])
    await Store.SaveProject(Path, Doc)
    Expect(ReadFileSync(Path, 'utf8')).toBe(First)
    const Reopened = new ImageStore()
    const Loaded = await Reopened.LoadProject(Path)
    await Reopened.SaveProject(Path, Loaded.document)
    Expect(ReadFileSync(Path, 'utf8')).toBe(First)
    Loaded.document.images[0].x = 25
    await Reopened.SaveProject(Path, Loaded.document)
    Expect(ReadFileSync(Path, 'utf8')).toBe(First.replace('x: 1.2346', 'x: 25'))
  })

  It('supports moving the project folder and Save As entirely from loaded memory', async () => {
    const Root = Temp()
    const Store = new ImageStore()
    const Imported = await Store.ImportBuffers([{ name: 'image.jpg', bytes: await Jpeg() }])
    const Original = Join(Root, 'Original.hbr')
    await Store.SaveProject(Original, Board(Imported.assets[0].id))
    const Filename = Basename(Parse(ReadFileSync(Original, 'utf8')).images[0].asset)
    const Moved = Temp()
    CpSync(Original, Join(Moved, 'Original.hbr'))
    CpSync(Join(Root, 'OriginalResource'), Join(Moved, 'OriginalResource'), { recursive: true })
    const LoadedStore = new ImageStore()
    const Loaded = await LoadedStore.LoadProject(Join(Moved, 'Original.hbr'))
    const SavedAs = Join(Temp(), '另存.hbr')
    await LoadedStore.SaveProject(SavedAs, Loaded.document)
    Expect(Parse(ReadFileSync(SavedAs, 'utf8')).images[0].asset).toBe(`另存Resource/${Filename}`)
    Expect((await new ImageStore().LoadProject(SavedAs)).assets).toEqual(Imported.assets)
  })

  It('protects existing YAML when memory assets are missing or destination resources are corrupt', async () => {
    const Root = Temp()
    const Store = new ImageStore()
    const Imported = await Store.ImportBuffers([{ name: 'image.jpg', bytes: await Jpeg() }])
    const Path = Join(Root, 'Protected.hbr')
    await Store.SaveProject(Path, Board(Imported.assets[0].id))
    const Before = ReadFileSync(Path, 'utf8')
    await Expect(Store.SaveProject(Path, Board('f'.repeat(64)))).rejects.toThrow('不在内存')
    Expect(ReadFileSync(Path, 'utf8')).toBe(Before)
    const Resource = Join(Root, Parse(Before).images[0].asset)
    WriteFileSync(Resource, 'external corruption')
    await Expect(Store.SaveProject(Path, Board(Imported.assets[0].id))).rejects.toThrow('目标图片资源已损坏')
    Expect(ReadFileSync(Path, 'utf8')).toBe(Before)
    Expect(ReadFileSync(Resource, 'utf8')).toBe('external corruption')
    Expect(ReaddirSync(Root).some((Name) => Name.endsWith('.tmp'))).toBe(false)
  })

  It('fails damaged or missing project loads without discarding the current memory cache', async () => {
    const Root = Temp()
    const Store = new ImageStore()
    const Imported = await Store.ImportBuffers([{ name: 'keep.jpg', bytes: await Jpeg() }])
    const ProjectPath = Join(Root, 'Missing.hbr')
    const Stored = Board(Imported.assets[0].id)
    Stored.images[0].asset = `MissingResource/1700000000000_${Imported.assets[0].id.slice(0, 8).toUpperCase()}.png`
    WriteFileSync(ProjectPath, Stringify(Stored))
    await Expect(Store.LoadProject(ProjectPath)).rejects.toThrow('无法读取图片资源')
    await Store.SaveProject(Join(Root, 'StillCached.hbr'), Board(Imported.assets[0].id))
    MkdirSync(Join(Root, 'MissingResource'))
    WriteFileSync(Join(Root, Stored.images[0].asset), 'corrupt')
    await Expect(Store.LoadProject(ProjectPath)).rejects.toThrow('哈希不匹配')
    await Store.SaveProject(Join(Root, 'StillCached.hbr'), Board(Imported.assets[0].id))
    Store.Clear()
    await Expect(Store.SaveProject(Join(Root, 'AfterClear.hbr'), Board(Imported.assets[0].id))).rejects.toThrow('不在内存')
    Expect(ExistsSync(Join(Root, 'AfterClear.hbr'))).toBe(false)
  })

  It('rejects undecodable resources even when their bytes match the filename hash', async () => {
    const Root = Temp()
    const Corrupt = Buffer.from('this is not a PNG')
    const Id = Hash(Corrupt)
    const Doc = Board(Id)
    const Filename = `1700000000000_${Id.slice(0, 8).toUpperCase()}.png`
    Doc.images[0].asset = Filename
    WriteFileSync(Join(Root, Filename), Corrupt)
    WriteFileSync(Join(Root, 'Bad.hbr'), Stringify(Doc))
    await Expect(new ImageStore().LoadProject(Join(Root, 'Bad.hbr'))).rejects.toThrow('图片资源已损坏')
  })

  It.each(['../outside/', 'C:/outside/', '/outside/', 'local:///outside/', './Resource/'])('rejects unsafe path prefix %s', async (Prefix) => {
    const Root = Temp()
    const Doc = Board('a'.repeat(64))
    Doc.images[0].asset = `${Prefix}1700000000000_AAAAAAAA.png`
    WriteFileSync(Join(Root, 'Unsafe.hbr'), Stringify(Doc))
    await Expect(new ImageStore().LoadProject(Join(Root, 'Unsafe.hbr'))).rejects.toThrow('路径不安全')
  })

  It('rejects a resource directory junction escaping the project root on both load and save', async () => {
    const Root = Temp()
    const Outside = Temp()
    const Store = new ImageStore()
    const Imported = await Store.ImportBuffers([{ name: 'image.jpg', bytes: await Jpeg() }])
    const Id = Imported.assets[0].id
    const Filename = `1700000000000_${Id.slice(0, 8).toUpperCase()}.png`
    WriteFileSync(Join(Outside, Filename), Bytes(Imported.assets[0].dataUrl))
    SymlinkSync(Outside, Join(Root, 'EscapeResource'), process.platform === 'win32' ? 'junction' : 'dir')
    const Doc = Board(Id)
    Doc.images[0].asset = `EscapeResource/${Filename}`
    const Path = Join(Root, 'Escape.hbr')
    WriteFileSync(Path, Stringify(Doc))
    const Original = ReadFileSync(Path, 'utf8')
    await Expect(Store.LoadProject(Path)).rejects.toThrow('越过画板目录')
    await Expect(Store.SaveProject(Path, Board(Id))).rejects.toThrow('越过画板目录')
    Expect(ReadFileSync(Path, 'utf8')).toBe(Original)
  })

  It('rejects duplicate image ids, invalid geometry and duplicate YAML keys', async () => {
    const Root = Temp()
    const Store = new ImageStore()
    const Duplicate = Board('a'.repeat(64))
    Duplicate.images.push({ ...Duplicate.images[0] })
    await Expect(Store.SaveProject(Join(Root, 'Invalid.hbr'), Duplicate)).rejects.toThrow('重复')
    const BadGeometry = Board()
    BadGeometry.viewport.zoom = 0
    await Expect(Store.SaveProject(Join(Root, 'Invalid.hbr'), BadGeometry)).rejects.toThrow('大于零')
    BadGeometry.viewport.zoom = NaN
    await Expect(Store.SaveProject(Join(Root, 'Invalid.hbr'), BadGeometry)).rejects.toThrow('有限数值')
    WriteFileSync(Join(Root, 'Invalid.hbr'), 'format: hybridref\nformatVersion: 2\nimages: []\nimages: []\n')
    await Expect(Store.LoadProject(Join(Root, 'Invalid.hbr'))).rejects.toThrow('YAML 无效')
  })

  It('clearly rejects reading or overwriting version 1 and leaves the older file untouched', async () => {
    const Root = Temp()
    const Path = Join(Root, 'OldDemo.hbr')
    const Old = 'format: hybridref\nformatVersion: 1\nboards: []\nrecordings: []\n'
    WriteFileSync(Path, Old)
    const Store = new ImageStore()
    await Expect(Store.LoadProject(Path)).rejects.toThrow('旧版')
    await Expect(Store.SaveProject(Path, Board())).rejects.toThrow('旧版')
    Expect(ReadFileSync(Path, 'utf8')).toBe(Old)
    Expect(ReaddirSync(Root)).toEqual(['OldDemo.hbr'])
  })

  It('serializes saves and can recover after a failed write', async () => {
    const Root = Temp()
    const Path = Join(Root, 'Sequence.hbr')
    const Store = new ImageStore()
    const First = Board()
    const Last = Board()
    Last.viewport.x = 99
    await Promise.all([Store.SaveProject(Path, First), Store.SaveProject(Path, Last)])
    Expect(Parse(ReadFileSync(Path, 'utf8')).viewport.x).toBe(99)
    const Old = Join(Root, 'Old.hbr')
    WriteFileSync(Old, 'formatVersion: 1\n')
    await Expect(Store.SaveProject(Old, Board())).rejects.toThrow('旧版')
    await Store.SaveProject(Path, Board())
    Expect(Parse(ReadFileSync(Path, 'utf8')).viewport.x).toBe(20)
  })
})
