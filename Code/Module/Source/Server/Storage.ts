import { createHash as CreateHash, randomUUID as RandomUUID } from 'node:crypto'
import { constants as FsConstants } from 'node:fs'
import { copyFile as CopyFile, link as Link, mkdir as Mkdir, open as Open, readFile as ReadFile, realpath as Realpath, rename as Rename, stat as Stat, unlink as Unlink } from 'node:fs/promises'
import { basename as Basename, dirname as Dirname, extname as Extname, isAbsolute as IsAbsolute, join as Join, relative as Relative, resolve as Resolve, win32 as Win32 } from 'node:path'
import { decode as DecodeBmp } from 'bmp-js'
import Sharp from 'sharp'
import { parseDocument as ParseDocument, stringify as Stringify } from 'yaml'
import type { BoardDocument, BoardImage, BoardText, ImageAsset, ImportResult, LoadedBoard, TextResource } from '../Shared/Types'

type DecodedImage = { bytes: Buffer; asset: ImageAsset }
type CachedImage = DecodedImage & { Filename: string }
type StoredText = Omit<BoardText, 'text'> & { asset: string }
type StoredDocument = Omit<BoardDocument, 'texts'> & { texts: StoredText[] }
type ImmutableResource = { path: string; bytes: Buffer; Id: string; Label: string }
const Hash = /^[a-f0-9]{64}$/
const ShortFilename = /^([0-9]{13})_([A-F0-9]{8})\.png$/
const TextId = /^[A-Za-z0-9_-]{1,128}$/
const TextFilename = /^Text_([A-Za-z0-9_-]{1,128})_([a-f0-9]{16})\.yaml$/

function IsRecord(Value: unknown): Value is Record<string, unknown> {
  return Value !== null && typeof Value === 'object' && !Array.isArray(Value)
}

function Digest(Bytes: Buffer): string { return CreateHash('sha256').update(Bytes).digest('hex') }
function ReadableError(CaughtError: unknown): string { return CaughtError instanceof Error ? CaughtError.message : String(CaughtError) }
function Missing(CaughtError: unknown): boolean { return (CaughtError as NodeJS.ErrnoException)?.code === 'ENOENT' }
function Rounded(Value: number): number { return Number(Value.toFixed(4)) || 0 }

function RequireNumber(Value: unknown, Label: string, Positive = false): number {
  if (typeof Value !== 'number' || !Number.isFinite(Value) || (Positive && Value <= 0)) {
    throw new Error(`画板中的${Label}必须是${Positive ? '大于零的' : ''}有限数值。`)
  }
  return Value
}

function RequireOpacity(Value: unknown, Label: string): number {
  const Opacity = RequireNumber(Value, Label)
  if (Opacity < 0 || Opacity > 1) throw new Error(`${Label}必须在 0 到 1 之间。`)
  return Opacity
}

function RequireColor(Value: unknown, Label: string): string {
  if (typeof Value !== 'string' || !/^#[A-Fa-f0-9]{6}$/.test(Value)) throw new Error(`${Label}必须是 #RRGGBB 颜色。`)
  return Value
}

function ValidateText(Value: unknown): TextResource {
  if (!IsRecord(Value) || Value.format !== 'hybridref-text' || Value.formatVersion !== 1) throw new Error('文本资源格式无效，请使用第 1 版 hybridref-text。')
  if (typeof Value.content !== 'string') throw new Error('文本资源缺少有效的文字内容。')
  if (!IsRecord(Value.font) || !IsRecord(Value.background) || !IsRecord(Value.paragraph)) throw new Error('文本资源缺少有效的字体、背景或段落样式。')
  if (typeof Value.font.family !== 'string' || !Value.font.family.trim() || /[\u0000-\u001f]/.test(Value.font.family)) throw new Error('文本字体名称无效。')
  if (Value.font.weight !== 400 && Value.font.weight !== 700) throw new Error('文本字重必须是 400 或 700。')
  if (Value.paragraph.align !== 'left' && Value.paragraph.align !== 'center' && Value.paragraph.align !== 'right') throw new Error('文本对齐方式无效。')
  const Padding = RequireNumber(Value.padding, '文本内边距')
  if (Padding < 0) throw new Error('文本内边距不能小于零。')
  return {
    format: 'hybridref-text', formatVersion: 1, content: Value.content,
    font: {
      family: Value.font.family, size: RequireNumber(Value.font.size, '文本字号', true), weight: Value.font.weight,
      color: RequireColor(Value.font.color, '文字颜色'), opacity: RequireOpacity(Value.font.opacity, '文字透明度'),
    },
    background: { color: RequireColor(Value.background.color, '背景颜色'), opacity: RequireOpacity(Value.background.opacity, '背景透明度') },
    paragraph: { align: Value.paragraph.align, lineHeight: RequireNumber(Value.paragraph.lineHeight, '文本行距', true) },
    padding: Padding,
  }
}

/** Construct the small schema explicitly: no editor state, timestamps or old Citadel fields. */
function ValidateDocument(Value: unknown, Stored: false): BoardDocument
function ValidateDocument(Value: unknown, Stored: true): StoredDocument
function ValidateDocument(Value: unknown, Stored: boolean): BoardDocument | StoredDocument {
  if (!IsRecord(Value)) throw new Error('画板格式不正确，应为 HybridRef YAML。')
  if (Value.formatVersion === 1 || 'boards' in Value) {
    throw new Error('这是旧版 HybridRef / Citadel 画板，精简版暂不支持读取或覆盖。请保留原文件，使用新的 .hbr 文件。')
  }
  if (Value.format !== 'hybridref' || (Value.formatVersion !== 3 && !(Stored && Value.formatVersion === 2))) throw new Error('不支持此画板格式，请使用 HybridRef 第 2 或第 3 版 .hbr 文件。')
  if (!IsRecord(Value.viewport) || !Array.isArray(Value.images)) throw new Error('画板缺少有效的 viewport 或 images。')
  if (Value.formatVersion === 3 && !Array.isArray(Value.texts)) throw new Error('画板缺少有效的 texts。')
  const Ids = new Set<string>()
  const Images = Value.images.map((Entry, Index): BoardImage => {
    if (!IsRecord(Entry) || typeof Entry.id !== 'string' || !Entry.id.trim()) throw new Error(`第 ${Index + 1} 张图片缺少有效 ID。`)
    if (Ids.has(Entry.id)) throw new Error(`画板包含重复的图片 ID：${Entry.id}`)
    Ids.add(Entry.id)
    if (typeof Entry.asset !== 'string' || !Entry.asset || (!Stored && !Hash.test(Entry.asset))) throw new Error(`图片 ${Entry.id} 的资源引用无效。`)
    if (Stored) ValidateRelativeAsset(Entry.asset)
    return {
      id: Entry.id,
      asset: Entry.asset,
      x: RequireNumber(Entry.x, '图片 x'),
      y: RequireNumber(Entry.y, '图片 y'),
      width: RequireNumber(Entry.width, '图片宽度', true),
      height: RequireNumber(Entry.height, '图片高度', true),
    }
  })
  const Texts = (Value.formatVersion === 2 ? [] : Value.texts as unknown[]).map((Entry, Index): BoardText | StoredText => {
    if (!IsRecord(Entry) || typeof Entry.id !== 'string' || !TextId.test(Entry.id)) throw new Error(`第 ${Index + 1} 个文本缺少安全有效的 ID。`)
    if (Ids.has(Entry.id)) throw new Error(`画板包含重复的对象 ID：${Entry.id}`)
    Ids.add(Entry.id)
    const Geometry = { id: Entry.id, x: RequireNumber(Entry.x, '文本 x'), y: RequireNumber(Entry.y, '文本 y'), width: RequireNumber(Entry.width, '文本宽度', true), height: RequireNumber(Entry.height, '文本高度', true) }
    if (Stored) {
      if (typeof Entry.asset !== 'string' || !Entry.asset) throw new Error(`文本 ${Entry.id} 的资源引用无效。`)
      const Reference = ValidateRelativeAsset(Entry.asset, true)
      if (TextFilename.exec(Basename(Reference))![1] !== Entry.id) throw new Error(`文本资源名称与对象 ID 不匹配：${Entry.id}`)
      return { id: Geometry.id, asset: Entry.asset, x: Geometry.x, y: Geometry.y, width: Geometry.width, height: Geometry.height }
    }
    return { ...Geometry, text: ValidateText(Entry.text) }
  })
  return {
    format: 'hybridref',
    formatVersion: 3,
    viewport: {
      x: RequireNumber(Value.viewport.x, '视口 x'),
      y: RequireNumber(Value.viewport.y, '视口 y'),
      zoom: RequireNumber(Value.viewport.zoom, '缩放比例', true),
    },
    images: Images,
    texts: Texts,
  } as BoardDocument | StoredDocument
}

function ParseYaml(Text: string, Label: string): unknown {
  const Yaml = ParseDocument(Text, { uniqueKeys: true })
  if (Yaml.errors.length) throw new Error(`${Label} YAML 无效：${Yaml.errors[0].message}`)
  return Yaml.toJS({ maxAliasCount: 0 })
}

function ParseProject(Text: string): StoredDocument { return ValidateDocument(ParseYaml(Text, '画板'), true) }
function Serialize(Value: unknown): string { return Stringify(Value, { indent: 2, lineWidth: 0, aliasDuplicateObjects: false, defaultKeyType: 'PLAIN', defaultStringType: 'QUOTE_DOUBLE' }) }

/** Paths are filesystem strings, never URLs: # and % stay literal. */
function ValidateRelativeAsset(Source: string, Text = false): string {
  const Label = Text ? '文本' : '图片'
  const Normalized = Source.replace(/\\/g, '/')
  const Parts = Normalized.split('/')
  if (IsAbsolute(Source) || Win32.isAbsolute(Source) || Normalized.startsWith('/') || Source.includes(':') || Source.includes('\0') || Parts.some((Part) => !Part || Part === '..' || Part === '.')) {
    throw new Error(`${Label}资源路径不安全，必须位于画板目录内：${Source}`)
  }
  const Filename = Parts[Parts.length - 1]
  if (!(Text ? TextFilename : ShortFilename).test(Filename)) throw new Error(Text ? `文本资源名称无效，应为 Text_<ID>_<16 位内容哈希>.yaml：${Source}` : `图片资源名称无效，应为 13 位时间戳_8 位大写哈希.png：${Source}`)
  return Normalized
}

function Inside(Parent: string, Child: string): boolean {
  const Path = Relative(Parent, Child)
  return Path === '' || (!IsAbsolute(Path) && Path !== '..' && !Path.startsWith(`..\\`) && !Path.startsWith('../'))
}

async function GuardedResource(ProjectDir: string, Path: string, Label = '图片'): Promise<string> {
  const [Root, FileValue] = await Promise.all([Realpath(ProjectDir), Realpath(Path)])
  if (!Inside(Root, FileValue)) throw new Error(`${Label}资源路径越过画板目录：${Path}`)
  return FileValue
}

async function AtomicWrite(Path: string, Bytes: Buffer | string, Exclusive = false): Promise<void> {
  const Temporary = Join(Dirname(Path), `.${Basename(Path)}.${RandomUUID()}.tmp`)
  try {
    const FileValue = await Open(Temporary, 'wx')
    try { await FileValue.writeFile(Bytes); await FileValue.sync() } finally { await FileValue.close() }
    // Installing immutable assets with a hard link is atomic and cannot replace
    // another writer's file between the existence check and this operation.
    if (Exclusive) {
      try { await Link(Temporary, Path) }
      catch (CaughtError) {
        if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS', 'EXDEV'].includes((CaughtError as NodeJS.ErrnoException)?.code ?? '')) throw CaughtError
        // FAT/exFAT and some network volumes cannot link files. Copy the fully
        // written temporary file exclusively before publishing the YAML.
        await CopyFile(Temporary, Path, FsConstants.COPYFILE_EXCL)
      }
    } else await Rename(Temporary, Path)
  } finally {
    await Unlink(Temporary).catch((CaughtError: unknown) => { if (!Missing(CaughtError)) throw CaughtError })
  }
}

function Cached(Bytes: Buffer, Width: number, Height: number): DecodedImage {
  const Id = Digest(Bytes)
  return { bytes: Bytes, asset: { id: Id, dataUrl: `data:image/png;base64,${Bytes.toString('base64')}`, width: Width, height: Height } }
}

async function NormalizeImage(Input: Uint8Array): Promise<DecodedImage> {
  const Bytes = Buffer.from(Input)
  let ImageValue: Sharp.Sharp
  if (Bytes.length >= 2 && Bytes.toString('ascii', 0, 2) === 'BM') {
    const Bitmap = DecodeBmp(Bytes)
    const Rgba = Buffer.allocUnsafe(Bitmap.data.length)
    const HasAlpha = Bitmap.bitPP === 32 && Bitmap.data.some((Value, Index) => Index % 4 === 0 && Value !== 0)
    for (let Offset = 0; Offset < Bitmap.data.length; Offset += 4) {
      Rgba[Offset] = Bitmap.data[Offset + 3]
      Rgba[Offset + 1] = Bitmap.data[Offset + 2]
      Rgba[Offset + 2] = Bitmap.data[Offset + 1]
      Rgba[Offset + 3] = HasAlpha ? Bitmap.data[Offset] : 255
    }
    ImageValue = Sharp(Rgba, { raw: { width: Bitmap.width, height: Bitmap.height, channels: 4 } })
  } else {
    // The minimal app intentionally imports only the first frame/page.
    ImageValue = Sharp(Bytes, { pages: 1 }).rotate()
  }
  const { data: Data, info: Info } = await ImageValue.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer({ resolveWithObject: true })
  return Cached(Data, Info.width, Info.height)
}

/** Owns compressed PNG bytes for the whole project, independent of source files. */
export class ImageStore {
  private Images = new Map<string, CachedImage>()
  private FilenameIds = new Map<string, string>()
  private Revision = 0
  private SaveQueue: Promise<void> = Promise.resolve()

  Clear(): void {
    this.Revision += 1
    this.Images.clear()
    this.FilenameIds.clear()
  }

  private CacheImported(ImageValue: DecodedImage): CachedImage {
    const Id = ImageValue.asset.id
    const Existing = this.Images.get(Id)
    if (Existing) return Existing
    let Timestamp = Date.now()
    let Filename: string
    do {
      Filename = `${Timestamp}_${Id.slice(0, 8).toUpperCase()}.png`
      if (!ShortFilename.test(Filename)) throw new Error('系统时间无效，无法生成图片资源名称。')
      Timestamp += 1
    } while (this.FilenameIds.has(Filename))
    const Image = { ...ImageValue, Filename }
    this.Images.set(Id, Image)
    this.FilenameIds.set(Filename, Id)
    return Image
  }

  async ImportFiles(Paths: string[]): Promise<ImportResult> {
    const Result: ImportResult = { assets: [], errors: [] }
    const Revision = this.Revision
    for (const Path of Paths) {
      try {
        const ImageValue = await NormalizeImage(await ReadFile(Path))
        if (Revision !== this.Revision) throw new Error('画板已切换，已取消导入。')
        Result.assets.push({ ...this.CacheImported(ImageValue).asset })
      } catch (CaughtError) { Result.errors.push(`${Basename(Path)}：${ReadableError(CaughtError)}`) }
    }
    return Result
  }

  async ImportBuffers(Files: { name: string; bytes: Uint8Array }[]): Promise<ImportResult> {
    const Result: ImportResult = { assets: [], errors: [] }
    const Revision = this.Revision
    for (const FileValue of Files) {
      try {
        const ImageValue = await NormalizeImage(FileValue.bytes)
        if (Revision !== this.Revision) throw new Error('画板已切换，已取消导入。')
        Result.assets.push({ ...this.CacheImported(ImageValue).asset })
      } catch (CaughtError) { Result.errors.push(`${FileValue.name}：${ReadableError(CaughtError)}`) }
    }
    return Result
  }

  async LoadProject(Path: string): Promise<LoadedBoard> {
    const Target = Resolve(Path)
    const Revision = ++this.Revision
    const Stored = ParseProject(await ReadFile(Target, 'utf8'))
    const ProjectDir = Dirname(Target)
    const Next = new Map<string, CachedImage>()
    const NextFilenames = new Map<string, string>()
    const LoadedPaths = new Map<string, string>()
    for (const ImageValue of Stored.images) {
      const Reference = ValidateRelativeAsset(ImageValue.asset)
      const Filename = Basename(Reference)
      let Id = LoadedPaths.get(Reference)
      if (!Id) {
        let Bytes: Buffer
        try { Bytes = await ReadFile(await GuardedResource(ProjectDir, Resolve(ProjectDir, Reference))) }
        catch (CaughtError) { throw new Error(`无法读取图片资源 ${Reference}：${ReadableError(CaughtError)}`) }
        Id = Digest(Bytes)
        const Matches = ShortFilename.exec(Filename)![2] === Id.slice(0, 8).toUpperCase()
        if (!Matches) throw new Error(`图片资源内容哈希不匹配，文件可能已损坏或被修改：${Reference}`)
        const ExistingId = NextFilenames.get(Filename)
        if (ExistingId && ExistingId !== Id) throw new Error(`图片资源名称重复但内容不同：${Filename}`)
        try {
          const Metadata = await Sharp(Bytes).metadata()
          if (Metadata.format !== 'png') throw new Error('资源必须是 PNG 图片。')
          // Decode as well as inspecting the header, so a truncated IDAT cannot
          // replace a healthy in-memory project and fail only when displayed.
          const { info: Info } = await Sharp(Bytes).raw().toBuffer({ resolveWithObject: true })
          if (!Next.has(Id)) Next.set(Id, { ...Cached(Bytes, Info.width, Info.height), Filename })
        } catch (CaughtError) { throw new Error(`图片资源已损坏 ${Reference}：${ReadableError(CaughtError)}`) }
        NextFilenames.set(Filename, Id)
        LoadedPaths.set(Reference, Id)
      }
      ImageValue.asset = Id
    }
    const Texts: BoardText[] = []
    for (const TextValue of Stored.texts) {
      const Reference = ValidateRelativeAsset(TextValue.asset, true)
      let Bytes: Buffer
      try { Bytes = await ReadFile(await GuardedResource(ProjectDir, Resolve(ProjectDir, Reference), '文本')) }
      catch (CaughtError) { throw new Error(`无法读取文本资源 ${Reference}：${ReadableError(CaughtError)}`) }
      if (TextFilename.exec(Basename(Reference))![2] !== Digest(Bytes).slice(0, 16)) throw new Error(`文本资源内容哈希不匹配，文件可能已损坏或被修改：${Reference}`)
      const Text = ValidateText(ParseYaml(Bytes.toString('utf8'), '文本资源'))
      Texts.push({ id: TextValue.id, x: TextValue.x, y: TextValue.y, width: TextValue.width, height: TextValue.height, text: Text })
    }
    if (Revision !== this.Revision) throw new Error('画板加载已取消。')
    this.Images = Next
    this.FilenameIds = NextFilenames
    return { path: Target, document: { ...Stored, texts: Texts }, assets: [...Next.values()].map((ImageValue) => ({ ...ImageValue.asset })) }
  }

  async SaveProject(Path: string, Doc: BoardDocument): Promise<void> {
    const Document = ValidateDocument(Doc, false)
    const Assets = new Map<string, CachedImage>()
    for (const ImageValue of Document.images) {
      const CachedImage = this.Images.get(ImageValue.asset)
      if (!CachedImage) throw new Error(`图片资源不在内存中，无法保存：${ImageValue.asset}`)
      Assets.set(ImageValue.asset, CachedImage)
    }
    for (const Item of [...Document.images, ...Document.texts]) {
      Item.x = Rounded(Item.x)
      Item.y = Rounded(Item.y)
      Item.width = Rounded(Item.width)
      Item.height = Rounded(Item.height)
    }
    Document.viewport = { x: Rounded(Document.viewport.x), y: Rounded(Document.viewport.y), zoom: Rounded(Document.viewport.zoom) }
    ValidateDocument(Document, false)
    const Target = Resolve(Path)
    const Write = this.SaveQueue.catch(() => {}).then(async () => {
      // Saving under the old demo's name must not silently replace version 1.
      try { ParseProject(await ReadFile(Target, 'utf8')) } catch (CaughtError) { if (!Missing(CaughtError)) throw CaughtError }
      const ProjectDir = Dirname(Target)
      await Mkdir(ProjectDir, { recursive: true })
      const ResourceName = `${Basename(Target, Extname(Target))}Resource`
      const ResourceDir = Join(ProjectDir, ResourceName)
      await Mkdir(ResourceDir, { recursive: true })
      await GuardedResource(ProjectDir, ResourceDir)
      // Validate all existing targets before writing any resource or the YAML.
      const Resources: ImmutableResource[] = []
      for (const [Id, ImageValue] of Assets) {
        Resources.push({ path: Join(ResourceDir, ImageValue.Filename), bytes: ImageValue.bytes, Id, Label: '图片' })
      }
      const Texts = Document.texts.map((TextValue): StoredText => {
        const Bytes = Buffer.from(Serialize(TextValue.text), 'utf8')
        const Id = Digest(Bytes)
        const Filename = `Text_${TextValue.id}_${Id.slice(0, 16)}.yaml`
        Resources.push({ path: Join(ResourceDir, Filename), bytes: Bytes, Id, Label: '文本' })
        return { id: TextValue.id, asset: `${ResourceName}/${Filename}`, x: TextValue.x, y: TextValue.y, width: TextValue.width, height: TextValue.height }
      })
      const Absent: ImmutableResource[] = []
      for (const Resource of Resources) {
        try {
          await Stat(Resource.path)
          const Bytes = await ReadFile(await GuardedResource(ProjectDir, Resource.path, Resource.Label))
          if (Digest(Bytes) !== Resource.Id) throw new Error(`目标${Resource.Label}资源已损坏，未覆盖：${Resource.path}`)
        } catch (CaughtError) {
          if (!Missing(CaughtError)) throw CaughtError
          Absent.push(Resource)
        }
      }
      for (const Resource of Absent) {
        try { await AtomicWrite(Resource.path, Resource.bytes, true) }
        catch (CaughtError) {
          if ((CaughtError as NodeJS.ErrnoException)?.code !== 'EEXIST') throw CaughtError
          const Bytes = await ReadFile(await GuardedResource(ProjectDir, Resource.path, Resource.Label))
          if (Digest(Bytes) !== Resource.Id) throw new Error(`目标${Resource.Label}资源已损坏，未覆盖：${Resource.path}`)
        }
      }
      const Portable: StoredDocument = {
        ...Document,
        images: Document.images.map((ImageValue) => ({ ...ImageValue, asset: `${ResourceName}/${Assets.get(ImageValue.asset)!.Filename}` })),
        texts: Texts,
      }
      await AtomicWrite(Target, Serialize(Portable))
    })
    this.SaveQueue = Write
    await Write
  }
}
