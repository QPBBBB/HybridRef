import { createHash as CreateHash, randomUUID as RandomUUID } from 'node:crypto'
import { constants as FsConstants } from 'node:fs'
import { copyFile as CopyFile, link as Link, mkdir as Mkdir, open as Open, readFile as ReadFile, realpath as Realpath, rename as Rename, stat as Stat, unlink as Unlink } from 'node:fs/promises'
import { basename as Basename, dirname as Dirname, extname as Extname, isAbsolute as IsAbsolute, join as Join, relative as Relative, resolve as Resolve, win32 as Win32 } from 'node:path'
import { decode as DecodeBmp } from 'bmp-js'
import Sharp from 'sharp'
import { parseDocument as ParseDocument, stringify as Stringify } from 'yaml'
import type { BoardDocument, BoardImage, ImageAsset, ImportResult, LoadedBoard } from '../Shared/Types'

type DecodedImage = { bytes: Buffer; asset: ImageAsset }
type CachedImage = DecodedImage & { Filename: string }
const Hash = /^[a-f0-9]{64}$/
const ShortFilename = /^([0-9]{13})_([A-F0-9]{8})\.png$/

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

/** Construct the small schema explicitly: no editor state, timestamps or old Citadel fields. */
function ValidateDocument(Value: unknown, Stored: boolean): BoardDocument {
  if (!IsRecord(Value)) throw new Error('画板格式不正确，应为 HybridRef YAML。')
  if (Value.formatVersion === 1 || 'boards' in Value) {
    throw new Error('这是旧版 HybridRef / Citadel 画板，精简版暂不支持读取或覆盖。请保留原文件，使用新的 .hbr 文件。')
  }
  if (Value.format !== 'hybridref' || Value.formatVersion !== 2) throw new Error('不支持此画板格式，请使用 HybridRef 第 2 版 .hbr 文件。')
  if (!IsRecord(Value.viewport) || !Array.isArray(Value.images)) throw new Error('画板缺少有效的 viewport 或 images。')
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
  return {
    format: 'hybridref',
    formatVersion: 2,
    viewport: {
      x: RequireNumber(Value.viewport.x, '视口 x'),
      y: RequireNumber(Value.viewport.y, '视口 y'),
      zoom: RequireNumber(Value.viewport.zoom, '缩放比例', true),
    },
    images: Images,
  }
}

function ParseProject(Text: string): BoardDocument {
  const Yaml = ParseDocument(Text, { uniqueKeys: true })
  if (Yaml.errors.length) throw new Error(`画板 YAML 无效：${Yaml.errors[0].message}`)
  return ValidateDocument(Yaml.toJS({ maxAliasCount: 0 }), true)
}

/** Paths are filesystem strings, never URLs: # and % stay literal. */
function ValidateRelativeAsset(Source: string): string {
  const Normalized = Source.replace(/\\/g, '/')
  const Parts = Normalized.split('/')
  if (IsAbsolute(Source) || Win32.isAbsolute(Source) || Normalized.startsWith('/') || Source.includes(':') || Source.includes('\0') || Parts.some((Part) => !Part || Part === '..' || Part === '.')) {
    throw new Error(`图片资源路径不安全，必须位于画板目录内：${Source}`)
  }
  const Filename = Parts[Parts.length - 1]
  if (!ShortFilename.test(Filename)) throw new Error(`图片资源名称无效，应为 13 位时间戳_8 位大写哈希.png：${Source}`)
  return Normalized
}

function Inside(Parent: string, Child: string): boolean {
  const Path = Relative(Parent, Child)
  return Path === '' || (!IsAbsolute(Path) && Path !== '..' && !Path.startsWith(`..\\`) && !Path.startsWith('../'))
}

async function GuardedResource(ProjectDir: string, Path: string): Promise<string> {
  const [Root, FileValue] = await Promise.all([Realpath(ProjectDir), Realpath(Path)])
  if (!Inside(Root, FileValue)) throw new Error(`图片资源路径越过画板目录：${Path}`)
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
    const Document = ParseProject(await ReadFile(Target, 'utf8'))
    const ProjectDir = Dirname(Target)
    const Next = new Map<string, CachedImage>()
    const NextFilenames = new Map<string, string>()
    const LoadedPaths = new Map<string, string>()
    for (const ImageValue of Document.images) {
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
    if (Revision !== this.Revision) throw new Error('画板加载已取消。')
    this.Images = Next
    this.FilenameIds = NextFilenames
    return { path: Target, document: Document, assets: [...Next.values()].map((ImageValue) => ({ ...ImageValue.asset })) }
  }

  async SaveProject(Path: string, Doc: BoardDocument): Promise<void> {
    const Document = ValidateDocument(Doc, false)
    const Assets = new Map<string, CachedImage>()
    for (const ImageValue of Document.images) {
      const CachedImage = this.Images.get(ImageValue.asset)
      if (!CachedImage) throw new Error(`图片资源不在内存中，无法保存：${ImageValue.asset}`)
      Assets.set(ImageValue.asset, CachedImage)
      ImageValue.x = Rounded(ImageValue.x)
      ImageValue.y = Rounded(ImageValue.y)
      ImageValue.width = Rounded(ImageValue.width)
      ImageValue.height = Rounded(ImageValue.height)
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
      const Absent: { path: string; bytes: Buffer; Id: string }[] = []
      for (const [Id, ImageValue] of Assets) {
        const Destination = Join(ResourceDir, ImageValue.Filename)
        try {
          await Stat(Destination)
          const Bytes = await ReadFile(await GuardedResource(ProjectDir, Destination))
          if (Digest(Bytes) !== Id) throw new Error(`目标图片资源已损坏，未覆盖：${Destination}`)
        } catch (CaughtError) {
          if (!Missing(CaughtError)) throw CaughtError
          Absent.push({ path: Destination, bytes: ImageValue.bytes, Id })
        }
      }
      for (const ImageValue of Absent) {
        try { await AtomicWrite(ImageValue.path, ImageValue.bytes, true) }
        catch (CaughtError) {
          if ((CaughtError as NodeJS.ErrnoException)?.code !== 'EEXIST') throw CaughtError
          const Bytes = await ReadFile(await GuardedResource(ProjectDir, ImageValue.path))
          if (Digest(Bytes) !== ImageValue.Id) throw new Error(`目标图片资源已损坏，未覆盖：${ImageValue.path}`)
        }
      }
      const Portable: BoardDocument = {
        ...Document,
        images: Document.images.map((ImageValue) => ({ ...ImageValue, asset: `${ResourceName}/${Assets.get(ImageValue.asset)!.Filename}` })),
      }
      await AtomicWrite(Target, Stringify(Portable, { indent: 2, lineWidth: 0, aliasDuplicateObjects: false, defaultKeyType: 'PLAIN', defaultStringType: 'QUOTE_DOUBLE' }))
    })
    this.SaveQueue = Write
    await Write
  }
}
