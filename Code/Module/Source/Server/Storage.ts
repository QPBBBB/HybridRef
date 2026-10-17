import { createHash as CreateHash, randomUUID as RandomUUID } from 'node:crypto'
import { constants as FsConstants } from 'node:fs'
import { copyFile as CopyFile, link as Link, lstat as Lstat, mkdir as Mkdir, open as Open, readFile as ReadFile, readdir as Readdir, realpath as Realpath, rename as Rename, unlink as Unlink } from 'node:fs/promises'
import { basename as Basename, dirname as Dirname, extname as Extname, isAbsolute as IsAbsolute, join as Join, relative as Relative, resolve as Resolve, win32 as Win32 } from 'node:path'
import { setTimeout as Delay } from 'node:timers/promises'
import { decode as DecodeBmp } from 'bmp-js'
import Sharp from 'sharp'
import { parseDocument as ParseDocument, stringify as Stringify } from 'yaml'
import type { ArrowBinding, ArrowPoint, ArrowResource, BoardArrow, BoardDocument, BoardImage, BoardText, CleanupResult, ImageAsset, ImportResult, LoadedBoard, ResourceIssue, SaveResult, ScanResult, TextResource } from '../Shared/Types'
import { MarkdownImageSources, MarkdownLocalImagePath } from '../Shared/Markdown'
import { DownloadMarkdownImage, MarkdownImageByteLimit } from './MarkdownImages'

type DecodedImage = { bytes: Buffer; asset: ImageAsset }
type CachedImage = DecodedImage & { Filename: string; Reference?: string; Source?: string }
type ImageGeometry = Pick<BoardImage, 'x' | 'y' | 'width' | 'height'>
type StoredText = { id: string; asset: string } & Partial<ImageGeometry>
type StoredImage = Pick<BoardImage, 'id' | 'asset'> & Partial<ImageGeometry>
type StoredLine = { id: string; asset: string }
type StoredDocument = Omit<BoardDocument, 'formatVersion' | 'images' | 'texts' | 'arrows'> & { formatVersion: 3 | 4 | 5 | 6 | 7; images: StoredImage[]; texts: StoredText[]; arrows?: (BoardArrow | StoredLine)[] }
type LayoutConfig = { format: 'hybridref-texture' | 'hybridref-text-layout' | 'hybridref-line-layout'; formatVersion: 1; instances: Record<string, ImageGeometry> }
type TextSource = { Reference: string; Value: BoardText }
type LineSource = { Reference?: string; Value: BoardArrow }
type ConfigWrite = { path: string; before: string | undefined; after: string }
type ImmutableResource = { path: string; bytes: Buffer; Id: string; Label: string }
const Hash = /^[a-f0-9]{64}$/
const ShortFilename = /^Texture_([A-F0-9]{16})_([A-F0-9]{8})\.png$/
const TextId = /^[A-Za-z0-9_-]{1,128}$/
const TextFilename = /^Text_([A-F0-9]{16})_([A-F0-9]{8})\.yaml$/
const LineFilename = /^Line_([A-F0-9]{16})_([A-F0-9]{8})\.yaml$/
const ConfigFilename = /^(Texture|Text|Line)_[A-F0-9]{16}_[A-F0-9]{8}\.config$/
// All tabs share this queue: publishing one project and pruning its resources
// must not race another tab's resource writes or project publication.
let SaveQueue: Promise<void> = Promise.resolve()

function IsRecord(Value: unknown): Value is Record<string, unknown> {
  return Value !== null && typeof Value === 'object' && !Array.isArray(Value)
}

function Digest(Bytes: Buffer): string { return CreateHash('sha256').update(Bytes).digest('hex') }
// Accept only proven LF/CRLF differences, never arbitrary YAML reformatting.
function MatchesResource(Bytes: Buffer, Expected: string, Yaml = false): boolean {
  const Matches = (Value: Buffer) => Digest(Value).slice(0, Expected.length).toUpperCase() === Expected.toUpperCase()
  if (Matches(Bytes)) return true
  if (!Yaml) return false
  const Text = Bytes.toString('utf8')
  if (!Buffer.from(Text).equals(Bytes)) return false
  const Normalized = Text.replace(/\r\n/g, '\n')
  return Matches(Buffer.from(Normalized)) || Matches(Buffer.from(Normalized.replace(/\n/g, '\r\n')))
}
class UnsafeResourceError extends Error {}
function RequireRecoverable(CaughtError: unknown): void { if (CaughtError instanceof UnsafeResourceError) throw CaughtError }
function ReadableError(CaughtError: unknown): string { return CaughtError instanceof Error ? CaughtError.message : String(CaughtError) }
function Missing(CaughtError: unknown): boolean { return (CaughtError as NodeJS.ErrnoException)?.code === 'ENOENT' }
function Rounded(Value: number): number { return Number(Value.toFixed(4)) || 0 }

function RequireNumber(Value: unknown, Label: string, Positive = false): number {
  if (typeof Value !== 'number' || !Number.isFinite(Value) || (Positive && Value <= 0)) {
    throw new Error(`画板中的${Label}必须是${Positive ? '大于零的' : ''}有限数值。`)
  }
  return Value
}

function Geometry(Value: { x?: unknown; y?: unknown; width?: unknown; height?: unknown }, Label = '图片'): ImageGeometry {
  return { x: RequireNumber(Value.x, `${Label} x`), y: RequireNumber(Value.y, `${Label} y`), width: RequireNumber(Value.width, `${Label}宽度`, true), height: RequireNumber(Value.height, `${Label}高度`, true) }
}

function ConfigPath(Asset: string): string { return Asset.replace(/\.(png|yaml)$/, '.config') }
function ConfigFormat(Path: string): LayoutConfig['format'] {
  return /^Text_/i.test(Basename(Path)) ? 'hybridref-text-layout' : /^Line_/i.test(Basename(Path)) ? 'hybridref-line-layout' : 'hybridref-texture'
}
function ConfigLabel(Format: LayoutConfig['format']): string { return Format === 'hybridref-texture' ? '图片' : Format === 'hybridref-text-layout' ? '文本' : '箭头' }

function ParseConfig(Text: string, Format: LayoutConfig['format'] = 'hybridref-texture'): LayoutConfig {
  const Label = `${ConfigLabel(Format)}配置`
  const Value = ParseYaml(Text, Label)
  if (!IsRecord(Value) || Value.format !== Format || Value.formatVersion !== 1 || !IsRecord(Value.instances)) throw new Error(`${Label}格式无效，请使用第 1 版 ${Format}。`)
  const Instances: Record<string, ImageGeometry> = Object.create(null)
  for (const [Id, Item] of Object.entries(Value.instances)) {
    if (!Id.trim() || !IsRecord(Item)) throw new Error(`${Label}中的对象 ID 或布局无效。`)
    Instances[Id] = Geometry(Item, ConfigLabel(Format))
  }
  return { format: Format, formatVersion: 1, instances: Instances }
}

function SameGeometry(Left: ImageGeometry | undefined, Right: ImageGeometry | undefined): boolean {
  return Left === Right || Boolean(Left && Right && Left.x === Right.x && Left.y === Right.y && Left.width === Right.width && Left.height === Right.height)
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
    opacity: Value.opacity === undefined ? 1 : RequireOpacity(Value.opacity, '不透明度'),
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
  if (Value.arrow.manualBend !== undefined && typeof Value.arrow.manualBend !== 'boolean') throw new Error('箭头折线调整标记无效。')
  const Thickness = RequireNumber(Value.arrow.thickness, '线宽', true)
  if (Thickness < 1 || Thickness > 24) throw new Error('箭头线宽必须在 1 到 24 之间。')
  const StartBinding = ValidateArrowBinding(Value.arrow.startBinding, Value.id), EndBinding = ValidateArrowBinding(Value.arrow.endBinding, Value.id)
  return { id: Value.id, x: RequireNumber(Value.x, '箭头 x'), y: RequireNumber(Value.y, '箭头 y'), width: RequireNumber(Value.width, '箭头宽度', true), height: RequireNumber(Value.height, '箭头高度', true),
    arrow: { start: ValidateArrowPoint(Value.arrow.start), end: ValidateArrowPoint(Value.arrow.end), axis: Value.arrow.axis as 'horizontal' | 'vertical',
      bend: RequireOpacity(Value.arrow.bend, '折线位置'), color: RequireColor(Value.arrow.color, '线条颜色'), thickness: Thickness, dashed: Value.arrow.dashed,
      ...(Value.arrow.manualBend !== undefined ? { manualBend: Value.arrow.manualBend as boolean } : {}),
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
  if (Value.format !== 'hybridref' || (Value.formatVersion !== 3 && Value.formatVersion !== 4 && !(Stored && [2, 5, 6, 7].some((Version) => Version === Value.formatVersion)))) throw new Error('不支持此画板格式，请使用 HybridRef 第 2 至 7 版 .hbr 文件。')
  if (!IsRecord(Value.viewport) || !Array.isArray(Value.images)) throw new Error('画板缺少有效的 viewport 或 images。')
  if (Value.formatVersion !== 2 && !Array.isArray(Value.texts)) throw new Error('画板缺少有效的 texts。')
  if (Value.formatVersion === 4 && !Array.isArray(Value.arrows)) throw new Error('第 4 版画板缺少有效的 arrows。')
  const Ids = new Set<string>()
  const Images = Value.images.map((Entry, Index): StoredImage => {
    if (!IsRecord(Entry) || typeof Entry.id !== 'string' || !Entry.id.trim()) throw new Error(`第 ${Index + 1} 张图片缺少有效 ID。`)
    if (Ids.has(Entry.id)) throw new Error(`画板包含重复的图片 ID：${Entry.id}`)
    Ids.add(Entry.id)
    if (typeof Entry.asset !== 'string' || !Entry.asset || (!Stored && !Hash.test(Entry.asset))) throw new Error(`图片 ${Entry.id} 的资源引用无效。`)
    if (Stored) ValidateRelativeAsset(Entry.asset)
    return { id: Entry.id, asset: Entry.asset, ...(Value.formatVersion === 5 || Value.formatVersion === 6 || Value.formatVersion === 7 ? {} : Geometry(Entry)) }
  })
  const Texts = (Value.formatVersion === 2 ? [] : Value.texts as unknown[]).map((Entry, Index): BoardText | StoredText => {
    if (!IsRecord(Entry) || typeof Entry.id !== 'string' || !TextId.test(Entry.id)) throw new Error(`第 ${Index + 1} 个文本缺少安全有效的 ID。`)
    if (Ids.has(Entry.id)) throw new Error(`画板包含重复的对象 ID：${Entry.id}`)
    Ids.add(Entry.id)
    if (Stored) {
      if (typeof Entry.asset !== 'string' || !Entry.asset) throw new Error(`文本 ${Entry.id} 的资源引用无效。`)
      ValidateRelativeAsset(Entry.asset, true)
      return { id: Entry.id, asset: Entry.asset, ...(Value.formatVersion === 7 ? {} : Geometry(Entry, '文本')) }
    }
    return { id: Entry.id, ...Geometry(Entry, '文本'), text: ValidateText(Entry.text) }
  })
  if (Value.arrows !== undefined && !Array.isArray(Value.arrows)) throw new Error('画板 arrows 必须是列表。')
  const Arrows = ((Value.arrows ?? []) as unknown[]).map((Item): BoardArrow | StoredLine => {
    if (Value.formatVersion !== 6 && Value.formatVersion !== 7) return ValidateArrow(Item, Ids)
    if (!IsRecord(Item) || typeof Item.id !== 'string' || !TextId.test(Item.id) || typeof Item.asset !== 'string') throw new Error('箭头资源引用无效。')
    if (Ids.has(Item.id)) throw new Error(`画板包含重复的对象 ID：${Item.id}`)
    Ids.add(Item.id)
    return { id: Item.id, asset: ValidateRelativeAsset(Item.asset, 'line') }
  })
  return {
    format: 'hybridref',
    formatVersion: Value.formatVersion === 7 ? 7 : Value.formatVersion === 6 ? 6 : Value.formatVersion === 5 ? 5 : Arrows.length ? 4 : 3,
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

function StoredReferences(Document: StoredDocument | undefined): StoredLine[] {
  return [...Document?.images ?? [], ...Document?.texts ?? [], ...Document?.arrows?.filter((Item): Item is StoredLine => 'asset' in Item) ?? []]
}

/** Discover instances without changing resource files or dropping unavailable references. */
async function ScanIndex(Target: string, Stored: StoredDocument): Promise<{ Document: StoredDocument; Issues: ResourceIssue[] }> {
  const ProjectDir = Dirname(Target), ResourceDir = Join(ProjectDir, 'Resource')
  const Entries = await Readdir(await GuardedResource(ProjectDir, ResourceDir), { withFileTypes: true })
  const Names = new Set<string>()
  const Issues: ResourceIssue[] = []
  for (const Entry of Entries) {
    if (ShortFilename.test(Entry.name) || TextFilename.test(Entry.name) || LineFilename.test(Entry.name)) Names.add(Entry.name)
    else if (ConfigFilename.test(Entry.name)) Names.add(Entry.name.replace(/\.config$/, Entry.name.startsWith('Texture_') ? '.png' : '.yaml'))
    else if (/^(Texture|Text|Line)_.*\.(png|yaml|config)$/i.test(Entry.name)) Issues.push({ id: `scan:name:${Entry.name}`, asset: `Resource/${Entry.name}`, message: '文件名不符合资源命名规则，已保留但未加载。' })
  }
  const Candidates = new Map<string, { Reference: StoredLine; Kind: 'images' | 'texts' | 'arrows' }[]>()
  const Original = new Map(StoredReferences(Stored).map((Item) => [Item.id, Item]))
  const OriginalKinds = new Map<string, string>([
    ...Stored.images.map((Item): [string, string] => [Item.id, 'images']),
    ...Stored.texts.map((Item): [string, string] => [Item.id, 'texts']),
    ...(Stored.arrows ?? []).map((Item): [string, string] => [Item.id, 'arrows']),
  ])
  const IndexedPaths = new Set([...Original.values()].map((Item) => Item.asset))
  for (const Name of [...Names].sort()) {
    const Asset = `Resource/${Name}`
    const Kind = Name.startsWith('Texture_') ? 'images' : Name.startsWith('Text_') ? 'texts' : 'arrows'
    try {
      // Check both paths, including missing resources, before accepting new IDs.
      try { await GuardedResource(ProjectDir, Resolve(ProjectDir, Asset)) }
      catch (CaughtError) { if (!Missing(CaughtError)) throw CaughtError }
      const Config = ParseConfig(await ReadFile(await GuardedResource(ProjectDir, Resolve(ProjectDir, ConfigPath(Asset))), 'utf8'), ConfigFormat(Asset))
      for (const Id of Object.keys(Config.instances)) {
        if (!TextId.test(Id)) {
          Issues.push({ id: `scan:${Asset}:${Id}`, asset: Asset, message: `配置中的对象 ID 无效：${Id}；请使用 1–128 位字母、数字、下划线或连字符。` })
          continue
        }
        const Values = Candidates.get(Id) ?? []
        Values.push({ Reference: { id: Id, asset: Asset }, Kind })
        Candidates.set(Id, Values)
      }
    } catch (CaughtError) {
      // Existing references retain their normal per-object diagnostics on load.
      if (!IndexedPaths.has(Asset)) Issues.push({ id: `scan:${Asset}`, asset: Asset, message: `未加载，文件已保留：${Missing(CaughtError) ? '资源或配套配置缺失' : ReadableError(CaughtError)}` })
    }
  }
  const Document = structuredClone(Stored)
  for (const [Id, Values] of Candidates) {
    const Existing = Original.get(Id)
    const Candidate = Values[0]
    if (Values.length !== 1 || (Existing && OriginalKinds.get(Id) !== Candidate.Kind)) {
      Issues.push({ id: `scan:id:${Id}`, asset: Values.map((Value) => Value.Reference.asset).join(' / '), message: `对象 ID ${Id} 重复或类型冲突，保留已有引用；请为每个对象保留唯一的资源/config 配对后重试。` })
      continue
    }
    const Items = Candidate.Kind === 'arrows' ? Document.arrows ??= [] : Document[Candidate.Kind]
    const Index = Items.findIndex((Item) => Item.id === Id)
    if (Index >= 0) Items[Index] = Candidate.Reference
    else Items.push(Candidate.Reference)
  }
  return { Document: ValidateDocument(Document, true), Issues }
}

function InsertStoredOrder<Item extends { id: string }>(Items: Item[], Value: Item, Stored: { id: string }[]): void {
  const Index = Stored.findIndex((Entry) => Entry.id === Value.id)
  const Next = Stored.slice(Index + 1).find((Entry) => Items.some((Current) => Current.id === Entry.id))
  const Previous = Stored.slice(0, Index).reverse().find((Entry) => Items.some((Current) => Current.id === Entry.id))
  const InsertIndex = Next ? Items.findIndex((Entry) => Entry.id === Next.id)
    : Previous ? Items.findIndex((Entry) => Entry.id === Previous.id) + 1 : 0
  Items.splice(InsertIndex, 0, Value)
}

/** Paths are filesystem strings, never URLs: # and % stay literal. */
function ValidateRelativeAsset(Source: string, Text: boolean | 'line' = false): string {
  const Label = Text === 'line' ? '箭头' : Text ? '文本' : '图片'
  const Normalized = Source.replace(/\\/g, '/')
  const Parts = Normalized.split('/')
  if (IsAbsolute(Source) || Win32.isAbsolute(Source) || Normalized.startsWith('/') || Source.includes(':') || Source.includes('\0') || Parts.some((Part) => !Part || Part === '..' || Part === '.')) {
    throw new Error(`${Label}资源路径不安全，必须位于画板目录内：${Source}`)
  }
  const Filename = Parts[Parts.length - 1]
  if (!(Text === 'line' ? LineFilename : Text ? TextFilename : ShortFilename).test(Filename)) throw new Error(`${Label}资源名称无效，应为 ${Text === 'line' ? 'Line' : Text ? 'Text' : 'Texture'}_<16 位大写时间戳哈希>_<8 位大写内容哈希>.${Text ? 'yaml' : 'png'}：${Source}`)
  return Normalized
}

function Inside(Parent: string, Child: string): boolean {
  const Path = Relative(Parent, Child)
  return Path === '' || (!IsAbsolute(Path) && Path !== '..' && !Path.startsWith(`..\\`) && !Path.startsWith('../'))
}

async function GuardedResource(ProjectDir: string, Path: string, Label = '图片'): Promise<string> {
  if (!Inside(Resolve(ProjectDir), Resolve(Path))) throw new UnsafeResourceError(`${Label}资源路径越过画板目录：${Path}`)
  let Current = Resolve(ProjectDir)
  for (const Part of Relative(Current, Resolve(Path)).split(/[\\/]/).filter(Boolean)) {
    Current = Join(Current, Part)
    if ((await Lstat(Current)).isSymbolicLink()) throw new UnsafeResourceError(`${Label}资源不可使用符号链接或越过画板目录：${Path}`)
  }
  const [Root, FileValue] = await Promise.all([Realpath(ProjectDir), Realpath(Path)])
  if (!Inside(Root, FileValue)) throw new UnsafeResourceError(`${Label}资源路径越过画板目录：${Path}`)
  return FileValue
}

async function ReadLayout(ProjectDir: string, Item: StoredLine, Configs: Map<string, LayoutConfig>): Promise<ImageGeometry> {
  const Reference = ConfigPath(Item.asset), Path = Resolve(ProjectDir, Reference), Format = ConfigFormat(Path)
  const Label = `${ConfigLabel(Format)}配置`
  let Config = Configs.get(PathKey(Path))
  if (!Config) {
    try { Config = ParseConfig(await ReadFile(await GuardedResource(ProjectDir, Path, Label), 'utf8'), Format) }
    catch (CaughtError) { RequireRecoverable(CaughtError); throw new Error(`无法读取${Label} ${Reference}：${ReadableError(CaughtError)}`) }
    Configs.set(PathKey(Path), Config)
  }
  const Layout = Config.instances[Item.id]
  if (!Layout) throw new Error(`${Label} ${Reference} 缺少对象 ${Item.id} 的布局，请修复配置后重新打开。`)
  return Layout
}

async function ReadLine(ProjectDir: string, Item: StoredLine): Promise<ArrowResource> {
  const Reference = ValidateRelativeAsset(Item.asset, 'line')
  const Bytes = await ReadFile(await GuardedResource(ProjectDir, Resolve(ProjectDir, Reference), '箭头'))
  if (!MatchesResource(Bytes, LineFilename.exec(Basename(Reference))![2], true)) throw new Error(`箭头资源内容哈希不匹配：${Reference}`)
  const Value = ParseYaml(Bytes.toString('utf8'), '箭头资源')
  if (!IsRecord(Value) || Value.format !== 'hybridref-line' || Value.formatVersion !== 1) throw new Error(`箭头资源格式无效：${Reference}`)
  return ValidateArrow({ id: Item.id, x: 0, y: 0, width: 1, height: 1, arrow: Value.arrow }, new Set()).arrow
}

async function ReadText(ProjectDir: string, Item: StoredText): Promise<TextResource> {
  const Reference = ValidateRelativeAsset(Item.asset, true)
  const Bytes = await ReadFile(await GuardedResource(ProjectDir, Resolve(ProjectDir, Reference), '文本'))
  if (!MatchesResource(Bytes, TextFilename.exec(Basename(Reference))![2], true)) throw new Error(`文本资源内容哈希不匹配，文件可能已损坏或被修改：${Reference}`)
  return ValidateText(ParseYaml(Bytes.toString('utf8'), '文本资源'))
}

async function AtomicWrite(Path: string, Bytes: Buffer | string, Exclusive = false, Expected?: string): Promise<void> {
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
    } else {
      // Windows scanners may briefly hold a newly read config without delete
      // sharing. Retry the rename, rechecking the baseline on every attempt.
      for (let Attempt = 0; ; Attempt++) {
        if (Expected !== undefined && await ReadFile(Path, 'utf8') !== Expected) throw new Error(`文件在保存过程中被修改，未覆盖：${Path}`)
        try { await Rename(Temporary, Path); break }
        catch (CaughtError) {
          if (process.platform !== 'win32' || Attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((CaughtError as NodeJS.ErrnoException)?.code ?? '')) throw CaughtError
          await Delay(25 * (Attempt + 1))
        }
      }
    }
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

async function ProtectStoredTextImages(References: Set<string>, ProjectDir: string, Reference: string, ResourceDir: string): Promise<void> {
  try {
    const Text = ParseYaml(await ReadFile(await GuardedResource(ProjectDir, Resolve(ProjectDir, Reference), '文本'), 'utf8'), '文本资源')
    if (!IsRecord(Text) || typeof Text.content !== 'string') throw new Error('文字内容无效')
    ProtectMarkdownImages(References, Text.content, ProjectDir)
  } catch (CaughtError) {
    RequireRecoverable(CaughtError)
    if (Missing(CaughtError)) return
    // An unreadable text may contain the only reference to a local PNG.
    // Retain candidate images until the text can be inspected again.
    for (const Entry of await Readdir(ResourceDir, { withFileTypes: true })) {
      if (Entry.isFile() && !Entry.isSymbolicLink() && Extname(Entry.name).toLowerCase() === '.png') References.add(PathKey(Join(ResourceDir, Entry.name)))
    }
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
      for (const Items of [Value.images, Value.texts, Value.arrows]) {
        if (Items === undefined) continue
        if (!Array.isArray(Items)) throw new Error(`无法确认共享资源引用，未清理：${Project}`)
        for (const Item of Items) {
          if (!IsRecord(Item) || typeof Item.asset !== 'string') continue
          const Path = Resolve(Directory, Item.asset.replace(/\\/g, '/'))
          if (Inside(ResourceDir, Path)) References.add(PathKey(Path))
          if (Items === Value.texts) {
            await ProtectStoredTextImages(References, Directory, Item.asset, ResourceDir)
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
  private TextSources = new Map<string, TextSource>()
  private LineNames = new Map<string, string>()
  private LineSources = new Map<string, LineSource>()
  private MissingLineReferences = new Map<string, StoredLine>()
  private MissingTextReferences = new Map<string, StoredText>()
  private MissingImageReferences = new Map<string, StoredImage>()
  private ResourceIssues = new Map<string, ResourceIssue>()
  private ScanIssues: ResourceIssue[] = []
  private SourcePath: string | undefined
  private SourceDocument: StoredDocument | undefined
  private ConfigSources = new Map<string, LayoutConfig>()
  private TimestampNames = new Set<string>()
  private NextTimestamp = 0
  private Revision = 0

  constructor(private MissingTexturePath = Resolve(__dirname, '../../../Resource/Icons/MissingTexture.png')) {}

  Clear(): void {
    this.Revision += 1
    this.Images.clear()
    this.FilenameIds.clear()
    this.TextNames.clear()
    this.TextSources.clear()
    this.LineNames.clear()
    this.LineSources.clear()
    this.MissingLineReferences.clear()
    this.MissingTextReferences.clear()
    this.MissingImageReferences.clear()
    this.ResourceIssues.clear()
    this.ScanIssues = []
    this.SourcePath = undefined
    this.SourceDocument = undefined
    this.ConfigSources.clear()
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
    return this.LoadStoredProject(Target, Stored, Revision)
  }

  private async LoadStoredProject(Target: string, Stored: StoredDocument, Revision = ++this.Revision): Promise<LoadedBoard> {
    const SourceDocument = structuredClone(Stored)
    const ProjectDir = Dirname(Target)
    const Next = new Map<string, CachedImage>()
    const NextFilenames = new Map<string, string>()
    const NextTextNames = new Map<string, string>()
    const NextTexts = new Map<string, TextSource>()
    const NextMissingTexts = new Map<string, StoredText>()
    const NextTimestampNames = new Set<string>()
    const NextConfigs = new Map<string, LayoutConfig>()
    const NextLineNames = new Map<string, string>()
    const NextLines = new Map<string, LineSource>()
    const NextMissingLines = new Map<string, StoredLine>()
    const NextMissingImages = new Map<string, StoredImage>()
    const Issues = new Map<string, ResourceIssue>()
    function RecordIssue(Item: StoredLine, CaughtError: unknown): void {
      RequireRecoverable(CaughtError)
      Issues.set(Item.id, { id: Item.id, asset: Item.asset, message: Missing(CaughtError) ? '资源文件缺失' : ReadableError(CaughtError) })
    }
    const Images: BoardImage[] = []
    const LoadedPaths = new Map<string, string>()
    for (const ImageValue of Stored.images) {
      const Reference = ValidateRelativeAsset(ImageValue.asset)
      let Layout: ImageGeometry
      try { Layout = Stored.formatVersion >= 5 ? await ReadLayout(ProjectDir, ImageValue, NextConfigs) : Geometry(ImageValue) }
      catch (CaughtError) {
        RecordIssue(ImageValue, CaughtError)
        NextMissingImages.set(ImageValue.id, ImageValue)
        continue
      }
      const Filename = Basename(Reference)
      let Id = LoadedPaths.get(Reference)
      if (!Id) {
        const Source = Resolve(ProjectDir, Reference)
        try {
          const Bytes = await ReadFile(await GuardedResource(ProjectDir, Source))
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
        } catch (CaughtError) {
          RecordIssue(ImageValue, CaughtError)
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
      if (Next.get(Id)!.asset.missing) {
        NextMissingImages.set(ImageValue.id, ImageValue)
        if (!Issues.has(ImageValue.id)) {
          const Previous = [...Issues.values()].find((Issue) => Issue.asset === Reference)!
          Issues.set(ImageValue.id, { ...Previous, id: ImageValue.id })
        }
      }
      Images.push({ id: ImageValue.id, asset: Id, ...Layout })
    }
    const Texts: BoardText[] = []
    for (const TextValue of Stored.texts) {
      const Reference = ValidateRelativeAsset(TextValue.asset, true)
      let Text: TextResource
      let Layout: ImageGeometry
      try {
        Layout = Stored.formatVersion >= 7 ? await ReadLayout(ProjectDir, TextValue, NextConfigs) : Geometry(TextValue, '文本')
        Text = await ReadText(ProjectDir, TextValue)
      }
      catch (CaughtError) {
        RecordIssue(TextValue, CaughtError)
        NextMissingTexts.set(TextValue.id, { ...TextValue, asset: Reference })
        continue
      }
      const Name = TextFilename.exec(Basename(Reference))!
      const Item = { id: TextValue.id, ...Layout, text: Text }
      Texts.push(Item)
      NextTexts.set(Item.id, { Reference, Value: structuredClone(Item) })
      NextTextNames.set(TextValue.id, Name[1])
      NextTimestampNames.add(Name[1])
    }
    const Arrows: BoardArrow[] = []
    for (const Item of Stored.arrows ?? []) {
      if (!('asset' in Item)) { Arrows.push(Item); NextLines.set(Item.id, { Value: structuredClone(Item) }); continue }
      let Arrow: ArrowResource
      let Layout: ImageGeometry
      try { Arrow = await ReadLine(ProjectDir, Item); Layout = await ReadLayout(ProjectDir, Item, NextConfigs) }
      catch (CaughtError) {
        RecordIssue(Item, CaughtError)
        NextMissingLines.set(Item.id, Item)
        continue
      }
      const Line = { id: Item.id, ...Layout, arrow: Arrow }
      const Name = LineFilename.exec(Basename(Item.asset))![1]
      NextLineNames.set(Item.id, Name)
      NextTimestampNames.add(Name)
      Arrows.push(Line)
      NextLines.set(Item.id, { Reference: Item.asset, Value: structuredClone(Line) })
    }
    if (Revision !== this.Revision) throw new Error('画板加载已取消。')
    this.Images = Next
    this.FilenameIds = NextFilenames
    this.TextNames = NextTextNames
    this.TextSources = NextTexts
    this.LineNames = NextLineNames
    this.LineSources = NextLines
    this.MissingLineReferences = NextMissingLines
    this.MissingTextReferences = NextMissingTexts
    this.MissingImageReferences = NextMissingImages
    this.ResourceIssues = Issues
    this.ScanIssues = []
    this.SourcePath = Target
    this.SourceDocument = SourceDocument
    this.ConfigSources = NextConfigs
    this.TimestampNames = NextTimestampNames
    const { arrows: StoredArrows, ...Document } = Stored
    return { path: Target, document: { ...Document, formatVersion: Arrows.length ? 4 : 3, images: Images, texts: Texts, ...(Arrows.length ? { arrows: Arrows } : {}) }, assets: [...Next.values()].map((ImageValue) => ({ ...ImageValue.asset })), ...this.ResourceWarnings() }
  }

  private ResourceWarnings(): Pick<LoadedBoard, 'missingResources' | 'resourceIssues'> {
    const Issues = [...this.ResourceIssues.values(), ...this.ScanIssues]
    return Issues.length ? { missingResources: [...new Set(Issues.map((Issue) => Issue.asset))], resourceIssues: Issues } : {}
  }

  async ScanProject(Path: string): Promise<ScanResult> {
    const Target = Resolve(Path)
    const Work = SaveQueue.catch(() => {}).then(async (): Promise<ScanResult> => {
      if (!this.SourcePath || PathKey(Target) !== PathKey(this.SourcePath)) throw new Error('只能扫描当前已打开的项目。')
      const Before = await ReadFile(Target, 'utf8')
      const Stored = ParseProject(Before)
      if (Stored.formatVersion !== 7) throw new Error('请先保存项目，将旧版布局迁移到资源 config 后再刷新。')
      const { Document, Issues } = await ScanIndex(Target, Stored)
      // Stage a complete load before publication. A failed scan leaves this
      // session and its cached images available for further editing/saving.
      const Staged = new ImageStore(this.MissingTexturePath)
      const Loaded = await Staged.LoadStoredProject(Target, Document)
      Staged.ScanIssues = Issues
      const Output = Serialize(Document)
      if (Output !== Before) await AtomicWrite(Target, Output, false, Before)
      else if (await ReadFile(Target, 'utf8') !== Before) throw new Error('项目在扫描过程中被修改，请再次刷新。')
      this.Revision += 1
      this.Images = Staged.Images
      this.FilenameIds = Staged.FilenameIds
      this.TextNames = Staged.TextNames
      this.TextSources = Staged.TextSources
      this.LineNames = Staged.LineNames
      this.LineSources = Staged.LineSources
      this.MissingLineReferences = Staged.MissingLineReferences
      this.MissingTextReferences = Staged.MissingTextReferences
      this.MissingImageReferences = Staged.MissingImageReferences
      this.ResourceIssues = Staged.ResourceIssues
      this.ScanIssues = Staged.ScanIssues
      this.SourcePath = Staged.SourcePath
      this.SourceDocument = Staged.SourceDocument
      this.ConfigSources = Staged.ConfigSources
      this.TimestampNames = Staged.TimestampNames
      const PreviousIds = new Set(StoredReferences(Stored).map((Item) => Item.id))
      const Added = [...Loaded.document.images, ...Loaded.document.texts, ...Loaded.document.arrows ?? []].filter((Item) => !PreviousIds.has(Item.id)).length
      return { ...Loaded, ...this.ResourceWarnings(), addedElements: Added }
    })
    SaveQueue = Work.then(() => {}, () => {})
    return Work
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

  private async PrepareConfigs(ProjectDir: string, Items: StoredLine[], Layouts: (ImageGeometry & { id: string })[], Protected: Set<string>, PreviousPaths = new Map<string, string>()): Promise<ConfigWrite[]> {
    const Groups = new Map<string, Record<string, ImageGeometry>>()
    for (const Item of Items) {
      const Path = Resolve(ProjectDir, ConfigPath(Item.asset))
      const Instances = Groups.get(Path) ?? Object.create(null) as Record<string, ImageGeometry>
      Instances[Item.id] = Geometry(Layouts.find((Layout) => Layout.id === Item.id)!)
      Groups.set(Path, Instances)
    }
    const Writes: ConfigWrite[] = []
    for (const [Path, Instances] of Groups) {
      const Format = ConfigFormat(Path), Label = ConfigLabel(Format)
      let Before: string | undefined
      try { Before = await ReadFile(await GuardedResource(ProjectDir, Path, `${Label}配置`), 'utf8') }
      catch (CaughtError) { if (!Missing(CaughtError)) throw CaughtError }
      const PreviousPath = PreviousPaths.get(PathKey(Path))
      const Base = this.ConfigSources.get(PathKey(PreviousPath ?? Path))
      let Seed: LayoutConfig | undefined
      if (PreviousPath) {
        try { Seed = ParseConfig(await ReadFile(await GuardedResource(ProjectDir, PreviousPath, `${Label}配置`), 'utf8'), Format) }
        catch (CaughtError) { if (!Missing(CaughtError) || Base) throw CaughtError }
      }
      if (Base && Before === undefined && !PreviousPath) throw new Error(`${Label}配置已在外部删除，请重新打开画板后再保存：${Path}`)
      const Config: LayoutConfig = Before === undefined ? Seed ?? { format: Format, formatVersion: 1, instances: Object.create(null) } : ParseConfig(Before, Format)
      let Changed = Before === undefined
      for (const [Id, Layout] of Object.entries(Instances)) {
        const Original = Base?.instances[Id], Current = Config.instances[Id]
        // An untouched instance must not overwrite changes made by another tab
        // or an agent. Conflicting edits to the same instance require a reload.
        if (Original && Current && SameGeometry(Original, Layout)) continue
        if (!SameGeometry(Current, Original) && !SameGeometry(Current, Layout)) throw new Error(`${Label}布局已在外部修改，请重新打开画板后再编辑：${Path}（${Id}）`)
        if (!SameGeometry(Current, Layout)) { Config.instances[Id] = Layout; Changed = true }
      }
      if (!Protected.has(PathKey(Path.replace(/\.config$/, Format === 'hybridref-texture' ? '.png' : '.yaml')))) {
        for (const Old of [...this.SourceDocument?.images ?? [], ...this.SourceDocument?.texts ?? [], ...this.SourceDocument?.arrows?.filter((Item): Item is StoredLine => 'asset' in Item) ?? []]) {
          if (!this.SourcePath || PathKey(Resolve(Dirname(this.SourcePath), ConfigPath(Old.asset))) !== PathKey(Path) || Object.hasOwn(Instances, Old.id)) continue
          if (Base?.instances[Old.id] && !SameGeometry(Config.instances[Old.id], Base.instances[Old.id])) throw new Error(`${Label}布局已在外部修改，请重新打开画板后再删除：${Path}（${Old.id}）`)
          if (Object.hasOwn(Config.instances, Old.id)) { delete Config.instances[Old.id]; Changed = true }
        }
      }
      if (Changed) Writes.push({ path: Path, before: Before, after: Serialize(Config) })
    }
    return Writes
  }

  private async WriteProject(Target: string, Document: BoardDocument, Assets: Map<string, CachedImage>): Promise<number> {
      // Saving under the old demo's name must not silently replace version 1.
      let Previous: StoredDocument | undefined
      try { Previous = ParseProject(await ReadFile(Target, 'utf8')) } catch (CaughtError) { if (!Missing(CaughtError)) throw CaughtError }
      const ProjectDir = Dirname(Target)
      const ResourceName = 'Resource'
      const SaveAs = Boolean(this.SourcePath && PathKey(this.SourcePath) !== PathKey(Target))
      // Only files previously indexed by this destination belong to its cleanup.
      // An agent may be publishing an entirely new pair between any two saves.
      const Owned = new Map<string, Set<string>>()
      for (const Item of [...StoredReferences(Previous), ...(!SaveAs ? StoredReferences(this.SourceDocument) : [])]) {
        const Key = PathKey(Resolve(ProjectDir, Item.asset))
        const Ids = Owned.get(Key) ?? new Set<string>()
        Ids.add(Item.id); Owned.set(Key, Ids)
      }
      let Source = Previous ?? this.SourceDocument
      const SourceDir = SaveAs ? Dirname(this.SourcePath!) : ProjectDir
      if (SaveAs) {
        try { Source = ParseProject(await ReadFile(this.SourcePath!, 'utf8')) }
        catch (CaughtError) { if (!Missing(CaughtError)) throw CaughtError; Source = this.SourceDocument }
      }
      const PreservedTexts: StoredText[] = []
      for (const Item of Source?.texts ?? []) {
        if (!this.MissingTextReferences.has(Item.id) || Document.texts.some((Text) => Text.id === Item.id)) continue
        try {
          await ReadText(SourceDir, Item)
          if (Source!.formatVersion >= 7) await ReadLayout(SourceDir, Item, new Map())
        }
        catch (CaughtError) {
          RequireRecoverable(CaughtError)
          const Filename = SaveAs && PathKey(SourceDir) === PathKey(ProjectDir)
            ? `Text_${this.AllocateTimestampName()}_${TextFilename.exec(Basename(Item.asset))![2]}.yaml` : Basename(Item.asset)
          PreservedTexts.push({ id: Item.id, asset: SaveAs ? `${ResourceName}/${Filename}` : Item.asset })
          continue
        }
        throw new Error(`原先丢失的文本资源已恢复，请重新打开画板或执行清理以恢复文字后再保存：${Item.asset}`)
      }
      const SourceLines = (Source?.arrows ?? []).filter((Item): Item is StoredLine => 'asset' in Item)
      const PreservedLines: StoredLine[] = []
      for (const Item of SourceLines) {
        if (!this.MissingLineReferences.has(Item.id) || Document.arrows?.some((Line) => Line.id === Item.id)) continue
        try { await ReadLine(SourceDir, Item); await ReadLayout(SourceDir, Item, new Map()) }
        catch (CaughtError) {
          RequireRecoverable(CaughtError)
          const Filename = SaveAs && PathKey(SourceDir) === PathKey(ProjectDir)
            ? `Line_${this.AllocateTimestampName()}_${LineFilename.exec(Basename(Item.asset))![2]}.yaml` : Basename(Item.asset)
          PreservedLines.push(SaveAs ? { ...Item, asset: `${ResourceName}/${Filename}` } : Item)
          continue
        }
        throw new Error(`原先丢失的箭头资源已恢复，请重新打开画板或执行清理后再保存：${Item.asset}`)
      }
      await Mkdir(ProjectDir, { recursive: true })
      const ResourceDir = Join(ProjectDir, ResourceName)
      await Mkdir(ResourceDir, { recursive: true })
      await GuardedResource(ProjectDir, ResourceDir)
      const Protected = await SharedReferences(Target, ResourceDir)
      for (const Item of Document.texts) ProtectMarkdownImages(Protected, Item.text.content, ProjectDir)
      for (const Item of PreservedTexts) await ProtectStoredTextImages(Protected, SourceDir, Source!.texts.find((Text) => Text.id === Item.id)!.asset, ResourceDir)
      const PreservedImages = (Source?.images ?? []).filter((Item) => this.MissingImageReferences.has(Item.id) && !Document.images.some((Image) => Image.id === Item.id)).map((Item) => {
        const Filename = SaveAs && PathKey(SourceDir) === PathKey(ProjectDir)
          ? `Texture_${this.AllocateTimestampName()}_${ShortFilename.exec(Basename(Item.asset))![2]}.png` : Basename(Item.asset)
        return SaveAs ? { ...Item, asset: `${ResourceName}/${Filename}` } : Item
      })
      for (const Item of PreservedImages) Protected.add(PathKey(Resolve(ProjectDir, Item.asset)))
      // A sibling Save As shares Resource/, so give its textures new names to
      // prevent later layout edits from also changing the original project.
      if (SaveAs && PathKey(SourceDir) === PathKey(ProjectDir)) {
        for (const [Id, Asset] of Assets) {
          const Suffix = ShortFilename.exec(Asset.Filename)![2]
          Assets.set(Id, { ...Asset, Filename: `Texture_${this.AllocateTimestampName()}_${Suffix}.png` })
        }
      }
      // Validate all existing targets before writing any resource or the YAML.
      const Resources: ImmutableResource[] = []
      async function CopyPreserved(Reference: string, Destination: string, Label: string): Promise<void> {
        if (!SaveAs) return
        try {
          const Bytes = await ReadFile(await GuardedResource(SourceDir, Resolve(SourceDir, Reference), Label))
          Resources.push({ path: Resolve(ProjectDir, Destination), bytes: Bytes, Id: Digest(Bytes), Label })
        } catch (CaughtError) { if (!Missing(CaughtError)) throw CaughtError }
      }
      for (const [Id, ImageValue] of Assets) {
        if (ImageValue.asset.missing) {
          await CopyPreserved(ImageValue.Reference!, `${ResourceName}/${ImageValue.Filename}`, '异常图片')
          continue
        }
        Resources.push({ path: Join(ResourceDir, ImageValue.Filename), bytes: ImageValue.bytes, Id, Label: '图片' })
      }
      const Texts: StoredText[] = [], ConfigTexts: StoredText[] = [], TextLayouts: (ImageGeometry & { id: string })[] = []
      const PreviousConfigPaths = new Map<string, string>()
      const NextTextSources = new Map<string, TextSource>()
      for (const Item of Document.texts) {
        const Original = this.TextSources.get(Item.id)
        const Latest = Source?.texts.find((Text) => Text.id === Item.id)
        if (Original && Latest && Original.Reference !== Latest.asset) {
          if (SaveAs || !SameGeometry(Original.Value, Item) || Serialize(Original.Value.text) !== Serialize(Item.text)) throw new Error(`文本已在外部修改，请重新打开画板后再编辑：${Latest.asset}`)
          Texts.push({ id: Latest.id, asset: Latest.asset })
          if (Source!.formatVersion < 7) {
            ConfigTexts.push(Latest); TextLayouts.push({ id: Latest.id, ...Geometry(Latest, '文本') })
          }
          // Keep the old baseline: a later edit from this stale tab must still conflict.
          continue
        }
        if (Latest && !SaveAs) {
          try { await ReadText(ProjectDir, Latest) }
          catch (CaughtError) { if (!Missing(CaughtError)) throw CaughtError }
        }
        const Bytes = Buffer.from(Serialize(Item.text), 'utf8')
        const Id = Digest(Bytes)
        let Name = this.TextNames.get(Item.id)
        if (!Name || SaveAs && PathKey(SourceDir) === PathKey(ProjectDir)) {
          Name = this.AllocateTimestampName()
          this.TextNames.set(Item.id, Name)
        }
        const Filename = `Text_${Name}_${Id.slice(0, 8).toUpperCase()}.yaml`
        Resources.push({ path: Join(ResourceDir, Filename), bytes: Bytes, Id, Label: '文本' })
        const Reference = `${ResourceName}/${Filename}`, Stored = { id: Item.id, asset: Reference }
        Texts.push(Stored); ConfigTexts.push(Stored); TextLayouts.push(Item)
        NextTextSources.set(Item.id, { Reference, Value: structuredClone(Item) })
        if (!SaveAs && Original && this.SourceDocument?.formatVersion === 7) {
          const BeforePath = Resolve(ProjectDir, ConfigPath(Original.Reference)), AfterPath = Resolve(ProjectDir, ConfigPath(Reference))
          if (PathKey(BeforePath) !== PathKey(AfterPath)) PreviousConfigPaths.set(PathKey(AfterPath), BeforePath)
        }
      }
      const Lines: StoredLine[] = [], LineLayouts: BoardArrow[] = [], ConfigLines: StoredLine[] = []
      const NextLineSources = new Map<string, LineSource>()
      for (const Item of Document.arrows ?? []) {
        const Original = this.LineSources.get(Item.id)
        const Latest = SourceLines.find((Line) => Line.id === Item.id)
        if (Original?.Reference && Latest && Original.Reference !== Latest.asset) {
          if (SaveAs || !SameGeometry(Original.Value, Item) || Serialize(Original.Value.arrow) !== Serialize(Item.arrow)) throw new Error(`箭头已在外部修改，请重新打开画板后再编辑：${Latest.asset}`)
          // Another writer changed this untouched arrow. Keep their reference;
          // retain our old baseline so a later stale edit still detects conflict.
          Lines.push(Latest)
          continue
        }
        if (Latest && !SaveAs) {
          try { await ReadLine(ProjectDir, Latest) }
          catch (CaughtError) { if (!Missing(CaughtError)) throw CaughtError }
        }
        let Name = this.LineNames.get(Item.id)
        if (!Name || SaveAs && PathKey(SourceDir) === PathKey(ProjectDir)) {
          Name = this.AllocateTimestampName()
          this.LineNames.set(Item.id, Name)
        }
        const Bytes = Buffer.from(Serialize({ format: 'hybridref-line', formatVersion: 1, arrow: Item.arrow }))
        const Id = Digest(Bytes), Filename = `Line_${Name}_${Id.slice(0, 8).toUpperCase()}.yaml`
        const Reference = `${ResourceName}/${Filename}`
        Resources.push({ path: Join(ResourceDir, Filename), bytes: Bytes, Id, Label: '箭头' })
        const Stored = { id: Item.id, asset: Reference }
        Lines.push(Stored); ConfigLines.push(Stored); LineLayouts.push(Item)
        NextLineSources.set(Item.id, { Reference, Value: structuredClone(Item) })
        if (!SaveAs && Original?.Reference) {
          const BeforePath = Resolve(ProjectDir, ConfigPath(Original.Reference)), AfterPath = Resolve(ProjectDir, ConfigPath(Reference))
          if (PathKey(BeforePath) !== PathKey(AfterPath)) PreviousConfigPaths.set(PathKey(AfterPath), BeforePath)
        }
      }
      for (const Item of PreservedLines) {
        InsertStoredOrder(Lines, Item, SourceLines)
        const Original = SourceLines.find((Line) => Line.id === Item.id)!
        await CopyPreserved(Original.asset, Item.asset, '异常箭头')
        await CopyPreserved(ConfigPath(Original.asset), ConfigPath(Item.asset), '箭头配置')
      }
      // Text that could not be loaded remains an explicit project reference.
      // Only a manual edit of the latest on-disk YAML removes this hidden entry.
      for (const Item of PreservedTexts) {
        InsertStoredOrder(Texts, Item, Source!.texts)
        const Original = Source!.texts.find((Text) => Text.id === Item.id)!
        await CopyPreserved(Original.asset, Item.asset, '异常文本')
        if (Source!.formatVersion >= 7) await CopyPreserved(ConfigPath(Original.asset), ConfigPath(Item.asset), '文本配置')
        else {
          // A broken legacy text still has valid geometry in .hbr. Publish it
          // before removing the inline fields so repairing the YAML restores it.
          ConfigTexts.push(Item); TextLayouts.push({ id: Item.id, ...Geometry(Original, '文本') })
        }
      }
      for (const Item of PreservedImages) {
        const Original = Source!.images.find((Image) => Image.id === Item.id)!
        await CopyPreserved(Original.asset, Item.asset, '异常图片')
        await CopyPreserved(ConfigPath(Original.asset), ConfigPath(Item.asset), '图片配置')
      }
      const Portable: StoredDocument = {
        ...Document, formatVersion: 7,
        images: Document.images.map((ImageValue) => {
          const Asset = Assets.get(ImageValue.asset)!
          return { id: ImageValue.id, asset: Asset.asset.missing && !SaveAs ? Asset.Reference! : `${ResourceName}/${Asset.Filename}` }
        }),
        texts: Texts,
        ...(Lines.length ? { arrows: Lines } : {}),
      }
      if (!Lines.length) delete Portable.arrows
      const ConfigItems = [...Portable.images, ...ConfigTexts, ...ConfigLines], Layouts = [...Document.images, ...TextLayouts, ...LineLayouts]
      for (const Item of PreservedImages) InsertStoredOrder(Portable.images, Item, Source!.images)
      const ConfigWrites = await this.PrepareConfigs(ProjectDir, ConfigItems, Layouts, Protected, PreviousConfigPaths)
      const Absent: ImmutableResource[] = []
      for (const Resource of Resources) {
        try {
          const Bytes = await ReadFile(await GuardedResource(ProjectDir, Resource.path, Resource.Label))
          if (!MatchesResource(Bytes, Resource.Id, Extname(Resource.path) === '.yaml')) throw new Error(`目标${Resource.Label}资源已损坏，未覆盖：${Resource.path}`)
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
          if (!MatchesResource(Bytes, Resource.Id, Extname(Resource.path) === '.yaml')) throw new Error(`目标${Resource.Label}资源已损坏，未覆盖：${Resource.path}`)
        }
      }
      const Published: ConfigWrite[] = []
      try {
        for (const Write of ConfigWrites) {
          try { await GuardedResource(ProjectDir, Dirname(Write.path), '资源配置') }
          catch (CaughtError) { if (!Missing(CaughtError)) throw CaughtError }
          await Mkdir(Dirname(Write.path), { recursive: true })
          await GuardedResource(ProjectDir, Dirname(Write.path), '资源配置')
          let Current: string | undefined
          try { Current = await ReadFile(await GuardedResource(ProjectDir, Write.path, '资源配置'), 'utf8') }
          catch (CaughtError) { if (!Missing(CaughtError)) throw CaughtError }
          if (Current !== Write.before) throw new Error(`资源配置在保存过程中被修改，请重新打开画板：${Write.path}`)
          await AtomicWrite(Write.path, Write.after, Write.before === undefined, Write.before)
          Published.push(Write)
        }
        const Output = Serialize(Portable)
        const Current = await ReadFile(Target, 'utf8').catch((CaughtError: unknown) => { if (!Missing(CaughtError)) throw CaughtError; return undefined })
        if (Output !== Current) await AtomicWrite(Target, Output, false, Current)
      } catch (CaughtError) {
        // Restore only our own writes when publishing the project fails. Never
        // roll back an intervening external edit.
        for (const Write of Published.reverse()) {
          if (await ReadFile(Write.path, 'utf8').catch(() => undefined) !== Write.after) continue
          if (Write.before === undefined) await Unlink(Write.path)
          else await AtomicWrite(Write.path, Write.before, false, Write.after)
        }
        throw CaughtError
      }
      this.SourcePath = Target
      this.SourceDocument = Portable
      for (const Write of ConfigWrites) {
        const Base = this.ConfigSources.get(PathKey(Write.path))
        if (!Base) continue
        const Saved = ParseConfig(Write.after, ConfigFormat(Write.path))
        for (const Id of Object.keys(Base.instances)) if (!Object.hasOwn(Saved.instances, Id)) delete Base.instances[Id]
      }
      for (const Item of ConfigItems) {
        const Key = PathKey(Resolve(ProjectDir, ConfigPath(Item.asset)))
        const Config = this.ConfigSources.get(Key) ?? { format: ConfigFormat(Item.asset), formatVersion: 1, instances: Object.create(null) } as LayoutConfig
        Config.instances[Item.id] = Geometry(Layouts.find((Layout) => Layout.id === Item.id)!)
        this.ConfigSources.set(Key, Config)
      }
      for (const [Id, Item] of NextLineSources) this.LineSources.set(Id, Item)
      for (const Id of this.LineSources.keys()) if (!Lines.some((Item) => Item.id === Id)) this.LineSources.delete(Id)
      for (const [Id, Item] of NextTextSources) this.TextSources.set(Id, Item)
      for (const Id of this.TextSources.keys()) if (!Texts.some((Item) => Item.id === Id)) this.TextSources.delete(Id)
      this.MissingLineReferences = new Map(PreservedLines.map((Item) => [Item.id, Item]))
      for (const Item of PreservedTexts) this.MissingTextReferences.set(Item.id, Item)
      for (const Id of this.MissingTextReferences.keys()) {
        if (!Portable.texts.some((Item) => Item.id === Id)) this.MissingTextReferences.delete(Id)
      }
      const StoredItems = [...Portable.images, ...Portable.texts, ...Lines]
      for (const [Id, Issue] of this.ResourceIssues) {
        const Item = StoredItems.find((Value) => Value.id === Id)
        if (Item) this.ResourceIssues.set(Id, { ...Issue, asset: Item.asset })
        else this.ResourceIssues.delete(Id)
      }
      this.MissingImageReferences = new Map(Portable.images.filter((Item) => this.MissingImageReferences.has(Item.id)).map((Item) => [Item.id, Item]))
      for (const Item of [...Portable.images, ...Portable.texts, ...Lines]) Protected.add(PathKey(Resolve(ProjectDir, Item.asset)))
      for (const Path of [...Protected]) if (Path.endsWith('.png') || /^(Text|Line)_.*\.yaml$/i.test(Basename(Path))) Protected.add(PathKey(ConfigPath(Path)))
      for (const [Id, Asset] of Assets) {
        this.Images.set(Id, Asset)
        if (Asset.asset.missing) Asset.Reference = Portable.images.find((Item) => Document.images.some((Image) => Image.id === Item.id && Image.asset === Id))!.asset
        Asset.Source = Resolve(ProjectDir, Asset.asset.missing ? Asset.Reference! : `${ResourceName}/${Asset.Filename}`)
      }
      let RemovedFiles = 0
      const Entries = await Readdir(ResourceDir, { withFileTypes: true })
      // New text resources can refer to an older texture before they are scanned.
      for (const Entry of Entries) {
        if (!Entry.isFile() || Entry.isSymbolicLink() || !TextFilename.test(Entry.name) || Owned.has(PathKey(Join(ResourceDir, Entry.name)))) continue
        await ProtectStoredTextImages(Protected, ProjectDir, `${ResourceName}/${Entry.name}`, ResourceDir)
      }
      const Removable = new Set<string>()
      for (const [Resource, Ids] of Owned) {
        if (Protected.has(Resource)) continue
        try {
          const Configuration = await ReadFile(await GuardedResource(ProjectDir, ConfigPath(Resource)), 'utf8').catch((CaughtError: unknown) => { if (!Missing(CaughtError)) throw CaughtError; return undefined })
          if (Configuration !== undefined) {
            const Config = ParseConfig(Configuration, ConfigFormat(Resource))
            const Base = this.ConfigSources.get(PathKey(ConfigPath(Resource)))
            if (Object.keys(Config.instances).some((Id) => !Ids.has(Id) || (Base && !SameGeometry(Base.instances[Id], Config.instances[Id])))) continue
          }
          const Bytes = await ReadFile(await GuardedResource(ProjectDir, Resource)).catch((CaughtError: unknown) => { if (!Missing(CaughtError)) throw CaughtError; return undefined })
          const Expected = /_([A-F0-9]{8})\.(png|yaml)$/i.exec(Resource)?.[1]
          if (Bytes && (!Expected || !MatchesResource(Bytes, Expected, Resource.endsWith('.yaml')))) continue
        } catch { continue } // Keep abnormal or externally changed pairs intact.
        Removable.add(Resource); Removable.add(PathKey(ConfigPath(Resource)))
      }
      // Prune only owned, unchanged resources after project publication. Unknown
      // files, new instances, incomplete pairs, directories and links survive.
      for (const Entry of Entries) {
        if (!Entry.isFile() || Entry.isSymbolicLink() || !(['.png', '.yaml'].includes(Extname(Entry.name).toLowerCase()) || /^(Texture|Text|Line)_[A-F0-9]{16}_[A-F0-9]{8}\.config$/.test(Entry.name))) continue
        const Resource = Join(ResourceDir, Entry.name)
        if (Protected.has(PathKey(Resource)) || !Removable.has(PathKey(Resource))) continue
        const Info = await Lstat(Resource).catch((CaughtError: unknown) => { if (!Missing(CaughtError)) throw CaughtError; return null })
        if (!Info?.isFile() || Info.isSymbolicLink()) continue
        await GuardedResource(ProjectDir, Resource)
        try { await Unlink(Resource); this.ConfigSources.delete(PathKey(Resource)); RemovedFiles += 1 }
        catch (CaughtError) { if (!Missing(CaughtError)) throw CaughtError }
      }
      return RemovedFiles
  }

  async SaveProject(Path: string, Doc: BoardDocument): Promise<SaveResult> {
    const { Document, Assets } = this.Snapshot(Doc)
    const Target = Resolve(Path)
    const Write = SaveQueue.catch(() => {}).then(async (): Promise<SaveResult> => {
      await this.WriteProject(Target, Document, Assets)
      const { resourceIssues: Issues } = this.ResourceWarnings()
      return { path: Target, ...(Issues ? { resourceIssues: Issues } : {}) }
    })
    SaveQueue = Write.then(() => {}, () => {})
    return Write
  }

  async CleanupProject(Path: string, Doc: BoardDocument): Promise<CleanupResult> {
    const { Document, Assets } = this.Snapshot(Doc)
    const Target = Resolve(Path)
    const Write = SaveQueue.catch(() => {}).then(async (): Promise<CleanupResult> => {
      const ProjectDir = Dirname(Target)
      const Recovery = new ImageStore(this.MissingTexturePath)
      let Loaded: LoadedBoard | undefined
      try { Loaded = await Recovery.LoadProject(Target) }
      catch (CaughtError) { if (!Missing(CaughtError)) throw CaughtError }
      const PreviousImages = new Map(this.MissingImageReferences), PreviousTexts = new Map(this.MissingTextReferences)
      const PreviousLines = new Map(this.MissingLineReferences), PreviousIssues = new Map(this.ResourceIssues)
      const RecoveredIds = new Set<string>(), RestoredImages = new Map<string, string>()
      if (Loaded) {
        const Stored = Recovery.SourceDocument!
        for (const [Id, Issue] of this.ResourceIssues) {
          const Remaining = Recovery.ResourceIssues.get(Id)
          if (Remaining) { this.ResourceIssues.set(Id, Remaining); continue }
          const Image = Loaded.document.images.find((Item) => Item.id === Id)
          const Text = Loaded.document.texts.find((Item) => Item.id === Id)
          const Line = Loaded.document.arrows?.find((Item) => Item.id === Id)
          if (Image && this.MissingImageReferences.has(Id)) {
            const Existing = Document.images.find((Item) => Item.id === Id)
            if (Existing) { RestoredImages.set(Existing.asset, Image.asset); Existing.asset = Image.asset }
            else InsertStoredOrder(Document.images, Image, Stored.images)
            const Asset = Recovery.Images.get(Image.asset)!
            Assets.set(Image.asset, Asset); this.Images.set(Image.asset, Asset)
          }
          if (Text && this.MissingTextReferences.has(Id)) {
            if (!Document.texts.some((Item) => Item.id === Id)) InsertStoredOrder(Document.texts, Text, Stored.texts)
            this.TextNames.set(Id, Recovery.TextNames.get(Id)!)
            this.TextSources.set(Id, Recovery.TextSources.get(Id)!)
          }
          if (Line && this.MissingLineReferences.has(Id)) {
            if (!Document.arrows?.some((Item) => Item.id === Id)) InsertStoredOrder(Document.arrows ??= [], Line, Stored.arrows!)
            Document.formatVersion = 4
            this.LineNames.set(Id, Recovery.LineNames.get(Id)!)
            this.LineSources.set(Id, Recovery.LineSources.get(Id)!)
          }
          if (Image || Text || Line) {
            const Key = PathKey(Resolve(ProjectDir, ConfigPath(Issue.asset)))
            const Config = Recovery.ConfigSources.get(Key)
            const Base = this.ConfigSources.get(Key)
            if (Config && !Base) this.ConfigSources.set(Key, Config)
            else if (Config && Base && !Base.instances[Id]) Base.instances[Id] = Config.instances[Id]
          }
          RecoveredIds.add(Id)
        }
      }
      for (const Item of Document.images) Item.asset = RestoredImages.get(Item.asset) ?? Item.asset
      const ReferencedAssets = new Map(Document.images.map((Item) => [Item.asset, Assets.get(Item.asset)!]))
      let RemovedFiles: number
      try { RemovedFiles = await this.WriteProject(Target, Document, ReferencedAssets) }
      catch (CaughtError) {
        // The UI still has the pre-recovery document if cleanup failed. Retain
        // its hidden references so a retry cannot delete recovered resources.
        this.MissingImageReferences = PreviousImages; this.MissingTextReferences = PreviousTexts
        this.MissingLineReferences = PreviousLines; this.ResourceIssues = PreviousIssues
        throw CaughtError
      }
      for (const Id of RecoveredIds) {
        this.MissingImageReferences.delete(Id); this.MissingTextReferences.delete(Id)
        this.MissingLineReferences.delete(Id); this.ResourceIssues.delete(Id)
      }
      return { path: Target, document: Document, assets: [...ReferencedAssets.values()].map((Item) => ({ ...Item.asset })), removedFiles: RemovedFiles, ...this.ResourceWarnings() }
    })
    // Callers observe Write's rejection; the shared queue itself must always
    // settle successfully so a failed cleanup cannot crash the HTTP service.
    SaveQueue = Write.then(() => {}, () => {})
    return Write
  }
}
