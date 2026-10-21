import { createHash as CreateHash, randomUUID as RandomUUID } from 'node:crypto'
import { lstat as Lstat, mkdir as Mkdir, open as Open, readFile as ReadFile, readdir as Readdir, realpath as Realpath, rm as Rm, unlink as Unlink } from 'node:fs/promises'
import { basename as Basename, dirname as Dirname, join as Join, parse as ParsePath, resolve as Resolve } from 'node:path'
import { setTimeout as Delay } from 'node:timers/promises'
import Sharp from 'sharp'
import { AtomicWrite, ConfigFormat, ConfigPath, GuardedResource, MatchesResource, ParseConfig, ParseProject, ReadLine, ReadText, ScanIndex, Serialize, type LayoutConfig } from '../Server/Storage'
import { EmptyDocument, type BoardItem, type BoardImage, type ResourceIssue } from '../Shared/Types'
import { ConfigRecoveryError, ConfigRecoveryPattern, RewriteLockedConfig } from './LockedConfig'

export type ElementKind = 'image' | 'text' | 'line'
export interface ElementEntry {
  Id: string; Kind: ElementKind; Asset: string; Config: string; Item: BoardItem
  Bytes: Buffer; Layout: LayoutConfig; LayoutText: string
}
export interface Catalog {
  Path: string; Directory: string; Index: ReturnType<typeof ParseProject>
  Entries: ElementEntry[]; Issues: ResourceIssue[]; Ids: Set<string>; Baselines: Map<string, Buffer>
  ResourceNames: string[]
}
export interface FileChange { Path: string; Before?: Buffer; After: Buffer }

export function Hash(Bytes: Buffer | string, Length = 8): string { return CreateHash('sha256').update(Bytes).digest('hex').slice(0, Length).toUpperCase() }
export function SamePath(Left: string, Right: string): boolean { return Resolve(Left).toLowerCase() === Resolve(Right).toLowerCase() }

/** Reject links in every ancestor, including junctions above the project itself. */
export async function PlainPath(Path: string): Promise<void> {
  let Current = Resolve(Path)
  for (;;) {
    if ((await Lstat(Current)).isSymbolicLink()) throw new Error(`不支持符号链接或目录联接：${Current}`)
    const Parent = Dirname(Current)
    if (Parent === Current) break
    Current = Parent
  }
}

export async function ProjectPath(Value: string): Promise<string> {
  const Path = Resolve(Value)
  if (!Path.toLowerCase().endsWith('.hbr')) throw new Error('--project 必须指定 .hbr 文件。')
  await PlainPath(Path)
  if (!(await Lstat(Path)).isFile()) throw new Error('项目路径不是文件。')
  return Realpath(Path)
}

export async function ReadCatalog(Value: string): Promise<Catalog> {
  const Path = await ProjectPath(Value), Directory = Dirname(Path), Bytes = await ReadFile(Path)
  const Index = ParseProject(Bytes.toString('utf8'))
  if (Index.formatVersion !== 7) throw new Error('请先在 HybridRef 保存旧项目，迁移到第 7 版后再使用 agent 工具。')
  const Resource = await GuardedResource(Directory, Join(Directory, 'Resource'))
  const ResourceNames = (await Readdir(Resource)).sort()
  const Baselines = new Map<string, Buffer>([[Path, Bytes]])
  // Watch all active pairs, including unindexed and damaged ones, to detect
  // changes while the command prepares a replacement.
  for (const Name of ResourceNames.filter((Name) => /^(Texture|Text|Line)_.*\.(png|yaml|config)$/.test(Name))) {
    const FileValue = await GuardedResource(Directory, Join(Resource, Name))
    Baselines.set(FileValue, await ReadFile(FileValue))
  }
  const Scanned = await ScanIndex(Path, Index)
  const Issues = [...Scanned.Issues], Entries: ElementEntry[] = [], Ids = new Set<string>()
  for (const Name of ResourceNames.filter(Name => ConfigRecoveryPattern.test(Name))) {
    Issues.push({ id: `recovery:${Name}`, asset: `Resource/${Name}`, message: '存在未完成的配置写入恢复记录；已保留原内容与目标内容，请先恢复后再编辑。' })
  }
  for (const [Kind, Values] of [['image', Scanned.Document.images], ['text', Scanned.Document.texts], ['line', Scanned.Document.arrows ?? []]] as const) {
    for (const Value of Values) {
      if (!('asset' in Value)) continue
      Ids.add(Value.id)
      try {
        const Config = ConfigPath(Value.asset), ConfigFile = await GuardedResource(Directory, Join(Directory, Config))
        const LayoutText = await ReadFile(ConfigFile, 'utf8'), Layout = ParseConfig(LayoutText, ConfigFormat(Config))
        const Geometry = Layout.instances[Value.id]
        if (!Geometry) throw new Error(`config 缺少实例 ${Value.id}`)
        const AssetFile = await GuardedResource(Directory, Join(Directory, Value.asset)), Content = await ReadFile(AssetFile)
        Baselines.set(ConfigFile, Buffer.from(LayoutText)); Baselines.set(AssetFile, Content)
        let Item: BoardItem
        if (Kind === 'text') Item = { id: Value.id, ...Geometry, text: await ReadText(Directory, Value) }
        else if (Kind === 'line') Item = { id: Value.id, ...Geometry, arrow: await ReadLine(Directory, Value) }
        else {
          const Expected = /_([A-F0-9]{8})\.png$/.exec(Value.asset)?.[1]
          if (!Expected || !MatchesResource(Content, Expected)) throw new Error('图片内容哈希不匹配。')
          const Metadata = await Sharp(Content).metadata()
          if (Metadata.format !== 'png' || !Metadata.width || !Metadata.height) throw new Error('图片必须是有效的 PNG。')
          Item = { id: Value.id, asset: Value.asset, ...Geometry }
        }
        Entries.push({ Id: Value.id, Kind, Asset: Value.asset, Config, Item, Bytes: Content, Layout, LayoutText })
      } catch (CaughtError) { Issues.push({ id: Value.id, asset: Value.asset, message: String(CaughtError instanceof Error ? CaughtError.message : CaughtError) }) }
    }
  }
  for (const Entry of Entries) {
    if (!('arrow' in Entry.Item)) continue
    for (const Binding of [Entry.Item.arrow.startBinding, Entry.Item.arrow.endBinding]) {
      if (Binding && !Entries.some((Target) => Target.Id === Binding.id && Target.Kind !== 'line')) {
        Issues.push({ id: Entry.Id, asset: Entry.Asset, message: `连接目标不可用：${Binding.id}` })
      }
    }
  }
  return { Path, Directory, Index, Entries, Issues, Ids, Baselines, ResourceNames }
}

export function InspectEntry(Entry: ElementEntry) {
  const { id: Id, ...Value } = Entry.Item
  return { id: Id, kind: Entry.Kind, asset: Entry.Asset, config: Entry.Config, ...Value }
}

export async function WithProjectLock<T>(Path: string, Work: () => Promise<T>): Promise<T> {
  await ProjectPath(Path)
  const Lock = Join(Dirname(Resolve(Path)), '.HybridRefAgent.lock')
  let FileValue
  try { FileValue = await Open(Lock, 'wx') }
  catch { throw new Error(`项目正被另一个 agent 命令占用。若上次进程异常退出，确认其已结束后删除锁文件：${Lock}`) }
  try {
    await FileValue.writeFile(JSON.stringify({ pid: process.pid })); await FileValue.close()
    return await Work()
  } finally {
    await FileValue.close().catch(() => {})
    await Unlink(Lock).catch((CaughtError: NodeJS.ErrnoException) => { if (CaughtError.code !== 'ENOENT') throw CaughtError })
  }
}

export async function AssertUnchanged(Catalog: Catalog): Promise<void> {
  if (JSON.stringify((await Readdir(Join(Catalog.Directory, 'Resource'))).sort()) !== JSON.stringify(Catalog.ResourceNames)) throw new Error('资源目录在命令执行期间被修改，请重新读取后重试。')
  for (const [Path, Bytes] of Catalog.Baselines) {
    await GuardedResource(Catalog.Directory, Path)
    if (!(await ReadFile(Path)).equals(Bytes)) throw new Error(`文件在命令执行期间被修改：${Path}`)
  }
}

async function PublishFile(Catalog: Catalog, Change: FileChange): Promise<void> {
  for (let Attempt = 0; ; Attempt++) {
    await GuardedResource(Catalog.Directory, Dirname(Change.Path))
    if (Change.Before) await GuardedResource(Catalog.Directory, Change.Path)
    try {
      // Each retry repeats AtomicWrite's expected-content check. A transient
      // Windows file lock must never become permission to overwrite an edit.
      await AtomicWrite(Change.Path, Change.After, !Change.Before, Change.Before?.toString('utf8'))
      return
    } catch (CaughtError) {
      const Locked = ['EPERM', 'EACCES', 'EBUSY'].includes((CaughtError as NodeJS.ErrnoException).code ?? '')
      if (!Locked) throw CaughtError
      if (Attempt >= 2) {
        if (process.platform !== 'win32' || !Change.Before || !/^(Texture|Text|Line)_[A-F0-9]{16}_[A-F0-9]{8}\.config$/.test(Basename(Change.Path))) throw CaughtError
        await GuardedResource(Catalog.Directory, Change.Path)
        await RewriteLockedConfig(Change.Path, Change.Before, Change.After)
        return
      }
      await Delay(50 * (Attempt + 1))
    }
  }
}

/** Publish complete files; roll back our own writes if publication fails. */
export async function PublishChanges(Catalog: Catalog, Changes: FileChange[]): Promise<string[]> {
  const Pending = Changes.filter((Change) => !Change.Before?.equals(Change.After))
  if (new Set(Pending.map((Change) => Resolve(Change.Path).toLowerCase())).size !== Pending.length) throw new Error('资源发布路径冲突。')
  await AssertUnchanged(Catalog)
  const Written: FileChange[] = []
  try {
    for (const Change of Pending) {
      await PublishFile(Catalog, Change)
      Written.push(Change)
    }
  } catch (CaughtError) {
    const RollbackErrors: string[] = []
    for (const Change of Written.reverse()) {
      try {
        await GuardedResource(Catalog.Directory, Change.Path)
        if (!(await ReadFile(Change.Path)).equals(Change.After)) throw new Error('文件已被其他进程修改')
        if (Change.Before) await PublishFile(Catalog, { Path: Change.Path, Before: Change.After, After: Change.Before })
        else await Unlink(Change.Path)
      } catch (RollbackError) { RollbackErrors.push(`${Change.Path}: ${String(RollbackError)}`) }
    }
    if (CaughtError instanceof ConfigRecoveryError) RollbackErrors.push(CaughtError.message)
    throw new Error(`${String(CaughtError)}${RollbackErrors.length ? `；部分写入无法回滚：${RollbackErrors.join('；')}` : '；本次写入已回滚。'}`)
  }
  return Pending.map((Change) => Change.Path)
}

export async function CreateProject(Root: string, Name: string): Promise<string> {
  if (!/^[^<>:"/\\|?*\x00-\x1f]+$/.test(Name) || /[. ]$/.test(Name) || Name === '.' || Name === '..'
    || /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(Name)) throw new Error('项目名称无效。')
  let Ancestor = Resolve(Root)
  for (;;) {
    try { await PlainPath(Ancestor); break }
    catch (CaughtError) {
      if ((CaughtError as NodeJS.ErrnoException).code !== 'ENOENT' || Ancestor === Dirname(Ancestor)) throw CaughtError
      Ancestor = Dirname(Ancestor)
    }
  }
  await Mkdir(Root, { recursive: true }); await PlainPath(Root)
  const Directory = Resolve(Root, Name), Path = Join(Directory, `${Name}.hbr`)
  await Mkdir(Directory) // Exclusive: never overwrite an existing directory.
  await Mkdir(Join(Directory, 'Resource'))
  await AtomicWrite(Path, Serialize({ ...EmptyDocument(), formatVersion: 7 }), true)
  return Path
}

export async function DeleteProject(Value: string, Repository: string): Promise<string> {
  const Path = await ProjectPath(Value), Directory = Dirname(Path)
  const Forbidden = [Repository, Join(Repository, 'Project'), Join(Repository, 'Code'), Join(Repository, 'Dependencies'), Join(Repository, 'AgentKnowledge'), ParsePath(Directory).root]
  if (Forbidden.some((Root) => SamePath(Root, Directory)) || Basename(Path, '.hbr') !== Basename(Directory)) throw new Error('只允许删除与 .hbr 同名的独立项目目录。')
  ParseProject(await ReadFile(Path, 'utf8'))
  if (!(await Lstat(Join(Directory, 'Resource'))).isDirectory()) throw new Error('缺少项目 Resource 目录。')
  const Top = await Readdir(Directory)
  if (Top.some((Name) => Name.toLowerCase() === '.git' || (Name.toLowerCase().endsWith('.hbr') && Name !== Basename(Path)))) throw new Error('目录包含 Git 元数据或其他项目，不执行整个目录删除。')
  async function CheckTree(Current: string): Promise<void> {
    for (const Entry of await Readdir(Current, { withFileTypes: true })) {
      const Child = Join(Current, Entry.name)
      if (Entry.isSymbolicLink() || Entry.name.toLowerCase() === '.git'
        || (Entry.name.toLowerCase().endsWith('.hbr') && !SamePath(Child, Path))) throw new Error(`项目包含链接、Git 元数据或其他项目：${Child}`)
      if (Entry.isDirectory()) await CheckTree(Child)
    }
  }
  await CheckTree(Directory)
  // Validate the resolved absolute target immediately before recursive removal.
  if (!SamePath(await Realpath(Directory), Directory)) throw new Error('项目实际路径不一致。')
  await Rm(Directory, { recursive: true, force: false, maxRetries: 3 })
  return Directory
}

export function ResourceName(Catalog: Catalog, Kind: ElementKind, Bytes: Buffer, Previous?: ElementEntry): string {
  if (Previous?.Bytes.equals(Bytes)) return Basename(Previous.Asset)
  const Prefix = { image: 'Texture', text: 'Text', line: 'Line' }[Kind], Extension = Kind === 'image' ? 'png' : 'yaml'
  let Stamp = Previous && Basename(Previous.Asset).split('_')[1]
  if (!Stamp) {
    let Timestamp = Date.now()
    do { Stamp = Hash(String(Timestamp++), 16) } while (Catalog.ResourceNames.some((Name) => Name.includes(`_${Stamp}_`)))
  }
  return `${Prefix}_${Stamp}_${Hash(Bytes)}.${Extension}`
}

export function LayoutOf(Item: BoardItem): Pick<BoardImage, 'x' | 'y' | 'width' | 'height'> {
  return { x: Item.x, y: Item.y, width: Item.width, height: Item.height }
}

/** A revision removes only this ID from its old config, retaining sibling
 * instances and immutable bytes (which may still be used by Markdown). */
export async function WriteElement(Catalog: Catalog, Kind: ElementKind, Item: BoardItem, Bytes: Buffer, Previous?: ElementEntry): Promise<string[]> {
  if (Previous?.Bytes.equals(Bytes) && JSON.stringify(LayoutOf(Previous.Item)) === JSON.stringify(LayoutOf(Item))) return []
  const Name = ResourceName(Catalog, Kind, Bytes, Previous), Asset = `Resource/${Name}`, Config = ConfigPath(Asset)
  const AssetPath = Join(Catalog.Directory, Asset), ConfigFile = Join(Catalog.Directory, Config)
  const Changes: FileChange[] = []
  const ExistingBytes = Catalog.Baselines.get(AssetPath)
  if (ExistingBytes && !ExistingBytes.equals(Bytes)) throw new Error(`内容短哈希冲突：${Asset}`)
  if (!ExistingBytes) Changes.push({ Path: AssetPath, After: Bytes })
  const Before = Catalog.Baselines.get(ConfigFile)
  const Layout: LayoutConfig = Before ? ParseConfig(Before.toString('utf8'), ConfigFormat(Config))
    : { format: ConfigFormat(Config), formatVersion: 1, instances: Object.create(null) }
  if (Previous && !SamePath(Join(Catalog.Directory, Previous.Config), ConfigFile)) {
    const Old = structuredClone(Previous.Layout)
    delete Old.instances[Item.id]
    Changes.push({ Path: Join(Catalog.Directory, Previous.Config), Before: Buffer.from(Previous.LayoutText), After: Buffer.from(Serialize(Old)) })
  }
  Layout.instances[Item.id] = LayoutOf(Item)
  Changes.push({ Path: ConfigFile, Before, After: Buffer.from(Serialize(Layout)) })
  return PublishChanges(Catalog, Changes)
}

export function NewId(): string { return RandomUUID() }
