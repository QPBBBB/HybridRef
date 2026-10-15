import { createHash as CreateHash, randomUUID as RandomUUID } from 'node:crypto'
import { constants as FsConstants } from 'node:fs'
import { copyFile as CopyFile, link as Link, lstat as Lstat, mkdir as Mkdir, open as Open, readFile as ReadFile, readdir as Readdir, realpath as Realpath, rename as Rename, unlink as Unlink } from 'node:fs/promises'
import { basename as Basename, dirname as Dirname, extname as Extname, isAbsolute as IsAbsolute, join as Join, relative as Relative, resolve as Resolve, win32 as Win32 } from 'node:path'
import { decode as DecodeBmp } from 'bmp-js'
import Sharp from 'sharp'
import { parseDocument as ParseDocument, stringify as Stringify } from 'yaml'
import type { ArrowBinding, ArrowPoint, BoardArrow, BoardDocument, BoardImage, BoardText, CleanupResult, ImageAsset, ImportResult, LoadedBoard, TextResource } from '../Shared/Types'
import { MarkdownImageSources, MarkdownLocalImagePath } from '../Shared/Markdown'
import { DownloadMarkdownImage, MarkdownImageByteLimit } from './MarkdownImages'

type DecodedImage = { bytes: Buffer; asset: ImageAsset }
type CachedImage = DecodedImage & { Filename: string; Reference?: string; Source?: string }
type StoredText = Omit<BoardText, 'text'> & { asset: string }
type StoredDocument = Omit<BoardDocument, 'texts'> & { texts: StoredText[] }
type ImmutableResource = { path: string; bytes: Buffer; Id: string; Label: string }
const Hash = /^[a-f0-9]{64}$/
const ShortFilename = /^Texture_([A-F0-9]{16})_([A-F0-9]{8})\.png$/
const TextId = /^[A-Za-z0-9_-]{1,128}$/
const TextFilename = /^Text_([A-F0-9]{16})_([A-F0-9]{8})\.yaml$/
// All tabs share this queue: publishing one project and pruning its resources
// must not race another tab's resource writes or project publication.
let SaveQueue: Promise<void> = Promise.resolve()

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

function ValidateArrowPoint(Value: unknown): ArrowPoint {
  if (!IsRecord(Value)) throw new Error('箭头端点无效。')
  return { x: RequireOpacity(Value.x, '箭头端点 x'), y: RequireOpacity(Value.y, '箭头端点 y') }
}

function ValidateArrowBinding(Value: unknown, Id: string): ArrowBinding | undefined {
  if (Value === undefined) return undefined
  if (!IsRecord(Value) || typeof Value.id !== 'string' || !TextId.test(Value.id) || Value.id === Id
    || !['left', 'right', 'top', 'bottom'].includes(String(Value.side))) throw new Error('箭头连接对象无效。')
  return { id: Value.id, side: Value.side as ArrowBinding['side'], offset: RequireOpacity(Value.offset, '箭头连接位置') }
}

function ValidateArrow(Value: unknown, Ids: Set<string>): BoardArrow {
  if (!IsRecord(Value) || typeof Value.id !== 'string' || !TextId.test(Value.id)) throw new Error('箭头缺少安全有效的 ID。')
  if (Ids.has(Value.id)) throw new Error(`画板包含重复的对象 ID：${Value.id}`)
  Ids.add(Value.id)
  if (!IsRecord(Value.arrow) || !['horizontal', 'vertical'].includes(String(Value.arrow.axis)) || typeof Value.arrow.dashed !== 'boolean') throw new Error('箭头样式无效。')
  const Thickness = RequireNumber(Value.arrow.thickness, '线宽', true)
  if (Thickness < 1 || Thickness > 24) throw new Error('箭头线宽必须在 1 到 24 之间。')
  const StartBinding = ValidateArrowBinding(Value.arrow.startBinding, Value.id), EndBinding = ValidateArrowBinding(Value.arrow.endBinding, Value.id)
  return { id: Value.id, x: RequireNumber(Value.x, '箭头 x'), y: RequireNumber(Value.y, '箭头 y'), width: RequireNumber(Value.width, '箭头宽度', true), height: RequireNumber(Value.height, '箭头高度', true),
    arrow: { start: ValidateArrowPoint(Value.arrow.start), end: ValidateArrowPoint(Value.arrow.end), axis: Value.arrow.axis as 'horizontal' | 'vertical',
      bend: RequireOpacity(Value.arrow.bend, '折线位置'), color: RequireColor(Value.arrow.color, '线条颜色'), thickness: Thickness, dashed: Value.arrow.dashed,
      ...(StartBinding ? { startBinding: StartBinding } : {}), ...(EndBinding ? { endBinding: EndBinding } : {}),
    } }
}

/** Construct the small schema explicitly: no editor state, timestamps or old Citadel fields. */
function ValidateDocument(Value: unknown, Stored: false): BoardDocument
function ValidateDocument(Value: unknown, Stored: true): StoredDocument
function ValidateDocument(Value: unknown, Stored: boolean): BoardDocument | StoredDocument {
  if (!IsRecord(Value)) throw new Error('画板格式不正确，应为 HybridRef YAML。')
  if (Value.formatVersion === 1 || 'boards' in Value) {
    throw new Error('这是旧版 HybridRef / Citadel 画板，精简版暂不支持读取或覆盖。请保留原文件，使用新的 .hbr 文件。')
  }
  if (Value.format !== 'hybridref' || (Value.formatVersion !== 3 && Value.formatVersion !== 4 && !(Stored && Value.formatVersion === 2))) throw new Error('不支持此画板格式，请使用 HybridRef 第 2、3 或 4 版 .hbr 文件。')
  if (!IsRecord(Value.viewport) || !Array.isArray(Value.images)) throw new Error('画板缺少有效的 viewport 或 images。')
  if (Value.formatVersion !== 2 && !Array.isArray(Value.texts)) throw new Error('画板缺少有效的 texts。')
  if (Value.formatVersion === 4 && !Array.isArray(Value.arrows)) throw new Error('第 4 版画板缺少有效的 arrows。')
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
      ValidateRelativeAsset(Entry.asset, true)
      return { id: Geometry.id, asset: Entry.asset, x: Geometry.x, y: Geometry.y, width: Geometry.width, height: Geometry.height }
    }
    return { ...Geometry, text: ValidateText(Entry.text) }
  })
  if (Value.arrows !== undefined && !Array.isArray(Value.arrows)) throw new Error('画板 arrows 必须是列表。')
  const Arrows = ((Value.arrows ?? []) as unknown[]).map((Item) => ValidateArrow(Item, Ids))
  return {
    format: 'hybridref',
    formatVersion: Arrows.length ? 4 : 3,
    viewport: {
      x: RequireNumber(Value.viewport.x, '视口 x'),
      y: RequireNumber(Value.viewport.y, '视口 y'),
      zoom: RequireNumber(Value.viewport.zoom, '缩放比例', true),
    },
    images: Images,
    texts: Texts,
    ...(Arrows.length ? { arrows: Arrows } : {}),
  } as BoardDocument | StoredDocument
}

function ParseYaml(Text: string, Label: string): unknown {
  const Yaml = ParseDocument(Text, { uniqueKeys: true })
  if (Yaml.errors.length) throw new Error(`${Label} YAML 无效：${Yaml.errors[0].message}`)
  return Yaml.toJS({ maxAliasCount: 0 })
}

function ParseProject(Text: string): StoredDocument { return ValidateDocument(ParseYaml(Text, '画板'), true) }
function Serialize(Value: unknown): string { return Stringify(Value, { indent: 2, lineWidth: 0, aliasDuplicateObjects: false, defaultKeyType: 'PLAIN', defaultStringType: 'QUOTE_DOUBLE' }) }

function InsertStoredOrder<Item extends { id: string }>(Items: Item[], Value: Item, Stored: { id: string }[]): void {
  const Index = Stored.findIndex((Entry) => Entry.id === Value.id)
  const Next = Stored.slice(Index + 1).find((Entry) => Items.some((Current) => Current.id === Entry.id))
  const Previous = Stored.slice(0, Index).reverse().find((Entry) => Items.some((Current) => Current.id === Entry.id))
  const InsertIndex = Next ? Items.findIndex((Entry) => Entry.id === Next.id)
    : Previous ? Items.findIndex((Entry) => Entry.id === Previous.id) + 1 : 0
  Items.splice(InsertIndex, 0, Value)
}

/** Paths are filesystem strings, never URLs: # and % stay literal. */
function ValidateRelativeAsset(Source: string, Text = false): string {
  const Label = Text ? '文本' : '图片'
  const Normalized = Source.replace(/\\/g, '/')
  const Parts = Normalized.split('/')
  if (IsAbsolute(Source) || Win32.isAbsolute(Source) || Normalized.startsWith('/') || Source.includes(':') || Source.includes('\0') || Parts.some((Part) => !Part || Part === '..' || Part === '.')) {
    throw new Error(`${Label}资源路径不安全，必须位于画板目录内：${Source}`)
  }
  const Filename = Parts[Parts.length - 1]
  if (!(Text ? TextFilename : ShortFilename).test(Filename)) throw new Error(`${Label}资源名称无效，应为 ${Text ? 'Text' : 'Texture'}_<16 位大写时间戳哈希>_<8 位大写内容哈希>.${Text ? 'yaml' : 'png'}：${Source}`)
  return Normalized
}

function Inside(Parent: string, Child: string): boolean {
  const Path = Relative(Parent, Child)
  return Path === '' || (!IsAbsolute(Path) && Path !== '..' && !Path.startsWith(`..\\`) && !Path.startsWith('../'))
}

async function GuardedResource(ProjectDir: string, Path: string, Label = '图片'): Promise<string> {
  if (!Inside(Resolve(ProjectDir), Resolve(Path))) throw new Error(`${Label}资源路径越过画板目录：${Path}`)
  let Current = Resolve(ProjectDir)
  for (const Part of Relative(Current, Resolve(Path)).split(/[\\/]/).filter(Boolean)) {
    Current = Join(Current, Part)
    if ((await Lstat(Current)).isSymbolicLink()) throw new Error(`${Label}资源不可使用符号链接或越过画板目录：${Path}`)
  }
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

function PathKey(Path: string): string { return process.platform === 'win32' ? Resolve(Path).toLowerCase() : Resolve(Path) }

function ProtectMarkdownImages(References: Set<string>, Content: string, ProjectDir: string): void {
  for (const Source of MarkdownImageSources(Content)) {
    const Path = MarkdownLocalImagePath(Source)
    if (Path) References.add(PathKey(Resolve(ProjectDir, Path)))
  }
}

/** Only sibling or ancestor projects can legally reference this resource folder:
 * descendants and unrelated project directories would need a forbidden '..'. */
async function SharedReferences(Target: string, ResourceDir: string): Promise<Set<string>> {
  const References = new Set<string>()
  let Directory = Dirname(Target)
  while (true) {
    for (const Entry of await Readdir(Directory, { withFileTypes: true })) {
      if (!Entry.isFile() || Entry.isSymbolicLink() || Extname(Entry.name).toLowerCase() !== '.hbr') continue
      const Project = Join(Directory, Entry.name)
      if (PathKey(Project) === PathKey(Target)) continue
      const Value = ParseYaml(await ReadFile(Project, 'utf8'), `共享资源引用 ${Project}`)
      if (!IsRecord(Value)) throw new Error(`无法确认共享资源引用，未清理：${Project}`)
      for (const Items of [Value.images, Value.texts]) {
        if (Items === undefined) continue
        if (!Array.isArray(Items)) throw new Error(`无法确认共享资源引用，未清理：${Project}`)
        for (const Item of Items) {
          if (!IsRecord(Item) || typeof Item.asset !== 'string') continue
          const Path = Resolve(Directory, Item.asset.replace(/\\/g, '/'))
          if (Inside(ResourceDir, Path)) References.add(PathKey(Path))
          if (Items === Value.texts) {
            try {
              const Text = ParseYaml(await ReadFile(await GuardedResource(Directory, Path, '文本'), 'utf8'), '文本资源')
              if (IsRecord(Text) && typeof Text.content === 'string') ProtectMarkdownImages(References, Text.content, Directory)
            } catch (CaughtError) { if (!Missing(CaughtError)) throw CaughtError }
          }
        }
      }
    }
    const Parent = Dirname(Directory)
    if (Parent === Directory) break
    Directory = Parent
  }
  return References
}

/** Owns compressed PNG bytes for the whole project, independent of source files. */
export class ImageStore {
  private Images = new Map<string, CachedImage>()
  private FilenameIds = new Map<string, string>()
  private TextNames = new Map<string, string>()
  private MissingTextReferences = new Map<string, StoredText>()
  private SourcePath: string | undefined
  private SourceDocument: StoredDocument | undefined
  private TimestampNames = new Set<string>()
  private NextTimestamp = 0
  private Revision = 0

  constructor(private MissingTexturePath = Resolve(__dirname, '../../../Resource/Icons/MissingTexture.png')) {}

  Clear(): void {
    this.Revision += 1
    this.Images.clear()
    this.FilenameIds.clear()
    this.TextNames.clear()
    this.MissingTextReferences.clear()
    this.SourcePath = undefined
    this.SourceDocument = undefined
    this.TimestampNames.clear()
  }

  private AllocateTimestampName(): string {
    let Name: string
    do {
      this.NextTimestamp = Math.max(Date.now(), this.NextTimestamp + 1)
      if (!Number.isSafeInteger(this.NextTimestamp) || this.NextTimestamp <= 0) throw new Error('系统时间无效，无法生成资源名称。')
      Name = Digest(Buffer.from(String(this.NextTimestamp))).slice(0, 16).toUpperCase()
    } while (this.TimestampNames.has(Name))
    this.TimestampNames.add(Name)
    return Name
  }

  private CacheImported(ImageValue: DecodedImage): CachedImage {
    const Id = ImageValue.asset.id
    const Existing = this.Images.get(Id)
    if (Existing) return Existing
    const Filename = `Texture_${this.AllocateTimestampName()}_${Id.slice(0, 8).toUpperCase()}.png`
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

  async MarkdownImage(Source: string): Promise<ImageAsset> {
    let Bytes: Buffer
    if (/^https?:\/\//i.test(Source)) Bytes = await DownloadMarkdownImage(Source)
    else if (/^data:image\/(?:png|jpeg|webp|gif|avif|bmp);base64,/i.test(Source)) {
      const Base64 = Source.slice(Source.indexOf(',') + 1)
      if (!/^[a-z0-9+/]*={0,2}$/i.test(Base64) || Base64.length > MarkdownImageByteLimit * 4 / 3 + 4) throw new Error('内嵌图片数据无效或超过 20 MB。')
      Bytes = Buffer.from(Base64, 'base64')
    } else {
      const Path = MarkdownLocalImagePath(Source)
      if (!Path || !this.SourcePath) throw new Error('请先保存项目，并使用项目文件夹内的相对图片路径。')
      const ProjectDir = Dirname(this.SourcePath)
      const File = await Open(await GuardedResource(ProjectDir, Resolve(ProjectDir, Path)), 'r')
      try {
        if ((await File.stat()).size > MarkdownImageByteLimit) throw new Error('Markdown 图片不能超过 20 MB。')
        Bytes = await File.readFile()
      } finally { await File.close() }
    }
    if (Bytes.length > MarkdownImageByteLimit) throw new Error('Markdown 图片不能超过 20 MB。')
    if (Bytes.toString('ascii', 0, 2) === 'BM') {
      if (Bytes.length < 26) throw new Error('BMP 图片数据不完整。')
      const Header = Bytes.readUInt32LE(14)
      const Width = Header === 12 ? Bytes.readUInt16LE(18) : Math.abs(Bytes.readInt32LE(18))
      const Height = Header === 12 ? Bytes.readUInt16LE(20) : Math.abs(Bytes.readInt32LE(22))
      if (!Width || !Height || Width * Height > 64_000_000) throw new Error('Markdown 图片总面积不能超过 6400 万像素。')
    } else {
      const Metadata = await Sharp(Bytes, { limitInputPixels: 64_000_000 }).metadata()
      if (!['png', 'jpeg', 'webp', 'gif', 'avif', 'heif'].includes(Metadata.format ?? '')) throw new Error('Markdown 图片支持 PNG、JPEG、WebP、GIF、AVIF 和 BMP。')
    }
    return (await NormalizeImage(Bytes)).asset
  }

  async LoadProject(Path: string): Promise<LoadedBoard> {
    const Target = Resolve(Path)
    const Revision = ++this.Revision
    const Stored = ParseProject(await ReadFile(Target, 'utf8'))
    const SourceDocument = structuredClone(Stored)
    const ProjectDir = Dirname(Target)
    const Next = new Map<string, CachedImage>()
    const NextFilenames = new Map<string, string>()
    const NextTextNames = new Map<string, string>()
    const NextMissingTexts = new Map<string, StoredText>()
    const NextTimestampNames = new Set<string>()
    const MissingResources: string[] = []
    const LoadedPaths = new Map<string, string>()
    for (const ImageValue of Stored.images) {
      const Reference = ValidateRelativeAsset(ImageValue.asset)
      const Filename = Basename(Reference)
      let Id = LoadedPaths.get(Reference)
      if (!Id) {
        const Source = Resolve(ProjectDir, Reference)
        let Bytes: Buffer | undefined
        try { Bytes = await ReadFile(await GuardedResource(ProjectDir, Source)) }
        catch (CaughtError) {
          if (!Missing(CaughtError)) throw new Error(`无法读取图片资源 ${Reference}：${ReadableError(CaughtError)}`)
          MissingResources.push(Reference)
        }
        if (Bytes) {
          Id = Digest(Bytes)
          const Matches = ShortFilename.exec(Filename)![2] === Id.slice(0, 8).toUpperCase()
          if (!Matches) throw new Error(`图片资源内容哈希不匹配，文件可能已损坏或被修改：${Reference}`)
          const ExistingId = NextFilenames.get(Filename)
          if (ExistingId && ExistingId !== Id) throw new Error(`图片资源名称重复但内容不同：${Filename}`)
          try {
            const Metadata = await Sharp(Bytes).metadata()
            if (Metadata.format !== 'png') throw new Error('资源必须是 PNG 图片。')
            const { info: Info } = await Sharp(Bytes).raw().toBuffer({ resolveWithObject: true })
            if (!Next.has(Id)) Next.set(Id, { ...Cached(Bytes, Info.width, Info.height), Filename, Source })
          } catch (CaughtError) { throw new Error(`图片资源已损坏 ${Reference}：${ReadableError(CaughtError)}`) }
        } else {
          // Keep the original reference and geometry. Placeholder bytes never
          // enter a saved texture resource, and each missing path has its own ID.
          Id = Digest(Buffer.from(`missing:${Reference}`))
          const Placeholder = await NormalizeImage(await ReadFile(this.MissingTexturePath))
          Next.set(Id, { ...Placeholder, asset: { ...Placeholder.asset, id: Id, missing: true }, Filename, Reference, Source })
        }
        NextFilenames.set(Filename, Id)
        NextTimestampNames.add(ShortFilename.exec(Filename)![1])
        LoadedPaths.set(Reference, Id)
      }
      ImageValue.asset = Id
    }
    const Texts: BoardText[] = []
    for (const TextValue of Stored.texts) {
      const Reference = ValidateRelativeAsset(TextValue.asset, true)
      let Bytes: Buffer
      try { Bytes = await ReadFile(await GuardedResource(ProjectDir, Resolve(ProjectDir, Reference), '文本')) }
      catch (CaughtError) {
        if (!Missing(CaughtError)) throw new Error(`无法读取文本资源 ${Reference}：${ReadableError(CaughtError)}`)
        MissingResources.push(Reference)
        NextMissingTexts.set(TextValue.id, { ...TextValue, asset: Reference })
        continue
      }
      const Name = TextFilename.exec(Basename(Reference))!
      if (Name[2] !== Digest(Bytes).slice(0, 8).toUpperCase()) throw new Error(`文本资源内容哈希不匹配，文件可能已损坏或被修改：${Reference}`)
      const Text = ValidateText(ParseYaml(Bytes.toString('utf8'), '文本资源'))
      Texts.push({ id: TextValue.id, x: TextValue.x, y: TextValue.y, width: TextValue.width, height: TextValue.height, text: Text })
      NextTextNames.set(TextValue.id, Name[1])
      NextTimestampNames.add(Name[1])
    }
    if (Revision !== this.Revision) throw new Error('画板加载已取消。')
    this.Images = Next
    this.FilenameIds = NextFilenames
    this.TextNames = NextTextNames
    this.MissingTextReferences = NextMissingTexts
    this.SourcePath = Target
    this.SourceDocument = SourceDocument
    this.TimestampNames = NextTimestampNames
    return { path: Target, document: { ...Stored, texts: Texts }, assets: [...Next.values()].map((ImageValue) => ({ ...ImageValue.asset })), ...(MissingResources.length ? { missingResources: MissingResources } : {}) }
  }

  private Snapshot(Doc: BoardDocument): { Document: BoardDocument; Assets: Map<string, CachedImage> } {
    const Document = ValidateDocument(Doc, false)
    const Assets = new Map<string, CachedImage>()
    for (const ImageValue of Document.images) {
      const CachedImage = this.Images.get(ImageValue.asset)
      if (!CachedImage) throw new Error(`图片资源不在内存中，无法保存：${ImageValue.asset}`)
      Assets.set(ImageValue.asset, CachedImage)
    }
    for (const Item of [...Document.images, ...Document.texts, ...(Document.arrows ?? [])]) {
      Item.x = Rounded(Item.x)
      Item.y = Rounded(Item.y)
      Item.width = Rounded(Item.width)
      Item.height = Rounded(Item.height)
    }
    Document.viewport = { x: Rounded(Document.viewport.x), y: Rounded(Document.viewport.y), zoom: Rounded(Document.viewport.zoom) }
    ValidateDocument(Document, false)
    return { Document, Assets }
  }

  private async WriteProject(Target: string, Document: BoardDocument, Assets: Map<string, CachedImage>): Promise<number> {
      // Saving under the old demo's name must not silently replace version 1.
      let Previous: StoredDocument | undefined
      try { Previous = ParseProject(await ReadFile(Target, 'utf8')) } catch (CaughtError) { if (!Missing(CaughtError)) throw CaughtError }
      const ProjectDir = Dirname(Target)
      const ResourceName = `${Basename(Target, Extname(Target))}Resource`
      const SaveAs = Boolean(this.SourcePath && PathKey(this.SourcePath) !== PathKey(Target))
      let Source = Previous ?? this.SourceDocument
      const SourceDir = SaveAs ? Dirname(this.SourcePath!) : ProjectDir
      if (SaveAs) {
        try { Source = ParseProject(await ReadFile(this.SourcePath!, 'utf8')) }
        catch (CaughtError) { if (!Missing(CaughtError)) throw CaughtError; Source = this.SourceDocument }
      }
      const PreservedTexts: StoredText[] = []
      for (const Item of Source?.texts ?? []) {
        if (!this.MissingTextReferences.has(Item.id) || Document.texts.some((Text) => Text.id === Item.id)) continue
        try { await GuardedResource(SourceDir, Resolve(SourceDir, Item.asset), '文本') }
        catch (CaughtError) {
          if (!Missing(CaughtError)) throw CaughtError
          PreservedTexts.push(SaveAs ? { ...Item, asset: `${ResourceName}/${Basename(Item.asset)}` } : Item)
          continue
        }
        throw new Error(`原先丢失的文本资源已恢复，请重新打开画板或执行清理以恢复文字后再保存：${Item.asset}`)
      }
      await Mkdir(ProjectDir, { recursive: true })
      const ResourceDir = Join(ProjectDir, ResourceName)
      await Mkdir(ResourceDir, { recursive: true })
      await GuardedResource(ProjectDir, ResourceDir)
      const Protected = await SharedReferences(Target, ResourceDir)
      for (const Item of Document.texts) ProtectMarkdownImages(Protected, Item.text.content, ProjectDir)
      // Validate all existing targets before writing any resource or the YAML.
      const Resources: ImmutableResource[] = []
      for (const [Id, ImageValue] of Assets) {
        if (ImageValue.asset.missing) continue
        Resources.push({ path: Join(ResourceDir, ImageValue.Filename), bytes: ImageValue.bytes, Id, Label: '图片' })
      }
      const Texts = Document.texts.map((TextValue): StoredText => {
        const Bytes = Buffer.from(Serialize(TextValue.text), 'utf8')
        const Id = Digest(Bytes)
        let Name = this.TextNames.get(TextValue.id)
        if (!Name) {
          Name = this.AllocateTimestampName()
          this.TextNames.set(TextValue.id, Name)
        }
        const Filename = `Text_${Name}_${Id.slice(0, 8).toUpperCase()}.yaml`
        Resources.push({ path: Join(ResourceDir, Filename), bytes: Bytes, Id, Label: '文本' })
        return { id: TextValue.id, asset: `${ResourceName}/${Filename}`, x: TextValue.x, y: TextValue.y, width: TextValue.width, height: TextValue.height }
      })
      // Text that could not be loaded remains an explicit project reference.
      // Only a manual edit of the latest on-disk YAML removes this hidden entry.
      for (const Item of PreservedTexts) InsertStoredOrder(Texts, Item, Source!.texts)
      const Absent: ImmutableResource[] = []
      for (const Resource of Resources) {
        try {
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
        images: Document.images.map((ImageValue) => {
          const Asset = Assets.get(ImageValue.asset)!
          return { ...ImageValue, asset: Asset.asset.missing && !SaveAs ? Asset.Reference! : `${ResourceName}/${Asset.Filename}` }
        }),
        texts: Texts,
      }
      await AtomicWrite(Target, Serialize(Portable))
      this.SourcePath = Target
      this.SourceDocument = Portable
      for (const Item of PreservedTexts) this.MissingTextReferences.set(Item.id, Item)
      for (const Id of this.MissingTextReferences.keys()) {
        if (!Portable.texts.some((Item) => Item.id === Id)) this.MissingTextReferences.delete(Id)
      }
      for (const Item of [...Portable.images, ...Portable.texts]) Protected.add(PathKey(Resolve(ProjectDir, Item.asset)))
      for (const [Id, Asset] of Assets) {
        if (Asset.asset.missing) Asset.Reference = Portable.images[Document.images.findIndex((Item) => Item.asset === Id)].asset
        Asset.Source = Resolve(ProjectDir, Asset.asset.missing ? Asset.Reference! : `${ResourceName}/${Asset.Filename}`)
      }
      let RemovedFiles = 0
      // Prune only after the project file was atomically published. Keep unknown
      // file types, subdirectories and links; never recurse into resource data.
      for (const Entry of await Readdir(ResourceDir, { withFileTypes: true })) {
        if (!Entry.isFile() || Entry.isSymbolicLink() || !['.png', '.yaml'].includes(Extname(Entry.name).toLowerCase())) continue
        const Resource = Join(ResourceDir, Entry.name)
        if (Protected.has(PathKey(Resource))) continue
        const Info = await Lstat(Resource).catch((CaughtError: unknown) => { if (!Missing(CaughtError)) throw CaughtError; return null })
        if (!Info?.isFile() || Info.isSymbolicLink()) continue
        await GuardedResource(ProjectDir, Resource)
        try { await Unlink(Resource); RemovedFiles += 1 }
        catch (CaughtError) { if (!Missing(CaughtError)) throw CaughtError }
      }
      return RemovedFiles
  }

  async SaveProject(Path: string, Doc: BoardDocument): Promise<void> {
    const { Document, Assets } = this.Snapshot(Doc)
    const Write = SaveQueue.catch(() => {}).then(async () => { await this.WriteProject(Resolve(Path), Document, Assets) })
    SaveQueue = Write
    await Write
  }

  async CleanupProject(Path: string, Doc: BoardDocument): Promise<CleanupResult> {
    const { Document, Assets } = this.Snapshot(Doc)
    const Target = Resolve(Path)
    const Write = SaveQueue.catch(() => {}).then(async (): Promise<CleanupResult> => {
      const ProjectDir = Dirname(Target)
      let Stored: StoredDocument | undefined
      try { Stored = ParseProject(await ReadFile(Target, 'utf8')) }
      catch (CaughtError) { if (!Missing(CaughtError)) throw CaughtError }
      const RestoredAssets = new Map<string, CachedImage>()
      for (const [Text, Items] of [[false, Stored?.images ?? []], [true, Stored?.texts ?? []]] as const) {
        for (const Item of Items) {
          const Reference = ValidateRelativeAsset(Item.asset, Text)
          try {
            const Bytes = await ReadFile(await GuardedResource(ProjectDir, Resolve(ProjectDir, Reference), Text ? '文本' : '图片'))
            const Pattern = Text ? TextFilename : ShortFilename
            if (Pattern.exec(Basename(Reference))![2] !== Digest(Bytes).slice(0, 8).toUpperCase()) throw new Error(`资源内容哈希不匹配，文件可能已损坏或被修改：${Reference}`)
            if (Text && this.MissingTextReferences.has(Item.id) && !Document.texts.some((Value) => Value.id === Item.id)) {
              const TextValue = ValidateText(ParseYaml(Bytes.toString('utf8'), '文本资源'))
              InsertStoredOrder(Document.texts, { id: Item.id, x: Item.x, y: Item.y, width: Item.width, height: Item.height, text: TextValue }, Stored!.texts)
              this.TextNames.set(Item.id, TextFilename.exec(Basename(Reference))![1])
            }
          } catch (CaughtError) {
            if (!Missing(CaughtError)) throw CaughtError
          }
        }
      }
      for (const [Id, Asset] of Assets) {
        if (!Asset.asset.missing) continue
        const Reference = Asset.Reference!
        try {
          const Source = Resolve(ProjectDir, Reference)
          const Bytes = await ReadFile(await GuardedResource(ProjectDir, Source))
          if (ShortFilename.exec(Basename(Reference))![2] !== Digest(Bytes).slice(0, 8).toUpperCase()) throw new Error(`图片资源内容哈希不匹配：${Reference}`)
          const Metadata = await Sharp(Bytes).metadata()
          if (Metadata.format !== 'png') throw new Error(`图片资源已损坏：${Reference}`)
          const { info: Info } = await Sharp(Bytes).raw().toBuffer({ resolveWithObject: true })
          const Restored = { ...Cached(Bytes, Info.width, Info.height), Filename: Asset.Filename, Source }
          RestoredAssets.set(Id, Restored)
        } catch (CaughtError) {
          if (!Missing(CaughtError)) throw CaughtError
        }
      }
      for (const Item of Document.images) {
        const Restored = RestoredAssets.get(Item.asset)
        if (Restored) {
          Item.asset = Restored.asset.id
          Assets.set(Item.asset, Restored)
          this.Images.set(Item.asset, Restored)
        }
      }
      const ReferencedAssets = new Map(Document.images.map((Item) => [Item.asset, Assets.get(Item.asset)!]))
      const RemovedFiles = await this.WriteProject(Target, Document, ReferencedAssets)
      for (const Item of Document.texts) this.MissingTextReferences.delete(Item.id)
      const MissingResources = [...new Set([
        ...[...ReferencedAssets.values()].filter((Item) => Item.asset.missing).map((Item) => Item.Reference!),
        ...[...this.MissingTextReferences.values()].map((Item) => Item.asset),
      ])]
      return { path: Target, document: Document, assets: [...ReferencedAssets.values()].map((Item) => ({ ...Item.asset })), removedFiles: RemovedFiles, ...(MissingResources.length ? { missingResources: MissingResources } : {}) }
    })
    SaveQueue = Write.then(() => {})
    return Write
  }
}
