import { readFile as ReadFile, readdir as Readdir } from 'node:fs/promises'
import { dirname as Dirname, join as Join, resolve as Resolve } from 'node:path'
import { ArrowEndpoints, BindingPoint, CreateArrow, PositionArrow } from '../Shared/Arrows'
import { EmptyTextResource, type ArrowBinding, type ArrowPoint, type BoardArrow, type BoardItem, type TextResource } from '../Shared/Types'
import { ConfigFormat, NormalizeImage, ParseConfig, ParseYaml, Serialize, ValidateArrow, ValidateText } from '../Server/Storage'
import { CreateProject, DeleteProject, InspectEntry, LayoutOf, NewId, PlainPath, ReadCatalog, WithProjectLock, WriteElement, type Catalog, type ElementEntry, type ElementKind } from './Files'

type InputData = Record<string, unknown>
type CommandResult = { ok: boolean; [Key: string]: unknown }
const GeometryKeys = ['x', 'y', 'width', 'height']
const LineKeys = ['start', 'end', 'startBinding', 'endBinding', 'axis', 'bend', 'manualBend', 'color', 'thickness', 'dashed']
const Commands: Record<string, string[]> = { project: ['create', 'list', 'inspect', 'delete'], element: ['list', 'inspect', 'update'], image: ['create', 'update'], text: ['create', 'update'], line: ['create', 'update'] }

function Record(Value: unknown, Label: string): InputData {
  if (!Value || typeof Value !== 'object' || Array.isArray(Value)) throw new Error(`${Label} 必须是对象。`)
  return Value as InputData
}
function Keys(Value: InputData, Allowed: string[], Label: string): void {
  for (const Key of Object.keys(Value)) if (!Allowed.includes(Key)) throw new Error(`${Label} 未知字段：${Key}`)
}
function StringValue(Value: unknown, Label: string): string {
  if (typeof Value !== 'string' || !Value.trim() || Value.includes('\0')) throw new Error(`${Label} 必须是非空字符串。`)
  return Value
}
function NumberValue(Value: unknown, Label: string): number {
  if (typeof Value !== 'number' || !Number.isFinite(Value)) throw new Error(`${Label} 必须是有限数值。`)
  return Value
}
function Point(Value: unknown, Label: string): ArrowPoint {
  const Data = Record(Value, Label); Keys(Data, ['x', 'y'], Label)
  return { x: NumberValue(Data.x, `${Label}.x`), y: NumberValue(Data.y, `${Label}.y`) }
}
function Geometry(Data: InputData, Defaults = { x: 0, y: 0, width: 320, height: 180 }) {
  const Value = { ...Defaults }
  for (const Key of GeometryKeys as ('x' | 'y' | 'width' | 'height')[]) if (Data[Key] !== undefined) Value[Key] = NumberValue(Data[Key], Key)
  if (Value.width <= 0 || Value.height <= 0) throw new Error('width 和 height 必须大于零。')
  return Value
}

async function ParseArguments(Arguments: string[]) {
  const Group = Arguments[0], Action = Group === 'validate' ? '' : Arguments[1]
  if (Group !== 'validate' && !Commands[Group]?.includes(Action)) throw new Error('未知命令，请运行 HybridRef.cmd --help。')
  const Flags: InputData = Object.create(null)
  for (let Index = Group === 'validate' ? 1 : 2; Index < Arguments.length; Index += 2) {
    const Key = Arguments[Index], Value = Arguments[Index + 1]
    if (!Key.startsWith('--') || Value === undefined || Value.startsWith('--')) throw new Error(`参数缺少值或格式错误：${Key}`)
    const Name = Key.slice(2)
    if (Object.hasOwn(Flags, Name)) throw new Error(`重复参数：${Key}`)
    Flags[Name] = Value
  }
  Keys(Flags, ['project', 'root', 'name', 'id', 'source', 'content', 'input', ...GeometryKeys, 'color', 'thickness', 'dashed', 'axis'], '命令行')
  for (const Name of [...GeometryKeys, 'thickness']) {
    if (Flags[Name] !== undefined) Flags[Name] = NumberValue(Number(Flags[Name]), Name)
  }
  if (Flags.dashed !== undefined) {
    if (Flags.dashed !== 'true' && Flags.dashed !== 'false') throw new Error('--dashed 只能是 true 或 false。')
    Flags.dashed = Flags.dashed === 'true'
  }
  let Input: InputData = {}, InputDirectory = process.cwd()
  if (Flags.input !== undefined) {
    const Path = Resolve(StringValue(Flags.input, '--input'))
    InputDirectory = Dirname(Path)
    Input = Record(ParseYaml(await ReadFile(Path, 'utf8'), '命令输入'), '命令输入')
    Keys(Input, ['id', 'source', 'content', 'text', ...GeometryKeys, ...LineKeys], '命令输入')
  }
  const { project: Project, root: Root, name: Name, input: InputFile, ...Values } = Flags
  const Data = { ...Input, ...Values }
  if (Data.source !== undefined) Data.source = Resolve(Flags.source === undefined ? InputDirectory : process.cwd(), StringValue(Data.source, 'source'))
  return { Group, Action, Project, Root, Name, InputFile, Data }
}

function TextValue(Data: InputData, Existing?: TextResource): TextResource {
  if (Existing && Data.text === undefined && Data.content === undefined) return Existing
  const Patch = Data.text === undefined ? {} : Record(Data.text, 'text')
  Keys(Patch, ['format', 'formatVersion', 'content', 'opacity', 'font', 'background', 'paragraph', 'padding'], 'text')
  const Value = { ...(Existing ?? EmptyTextResource()), ...Patch } as TextResource
  for (const [Key, Allowed] of [['font', ['family', 'size', 'weight', 'color', 'opacity']], ['background', ['color', 'opacity']], ['paragraph', ['align', 'lineHeight']]] as const) {
    if (Patch[Key] !== undefined) Keys(Record(Patch[Key], `text.${Key}`), [...Allowed], `text.${Key}`)
    Object.assign(Value, { [Key]: { ...(Existing ?? EmptyTextResource())[Key], ...Patch[Key] as object } })
  }
  if (Data.content !== undefined) {
    if (typeof Data.content !== 'string') throw new Error('content 必须是字符串。')
    Value.content = Data.content
  }
  const FontPatch = Patch.font as InputData | undefined, BackgroundPatch = Patch.background as InputData | undefined
  if (FontPatch?.family !== undefined && FontPatch.family !== 'SimHei') throw new Error('当前渲染字体固定为 SimHei。')
  if ((FontPatch?.opacity !== undefined && FontPatch.opacity !== 1) || (BackgroundPatch?.opacity !== undefined && BackgroundPatch.opacity !== 1)) throw new Error('使用 text.opacity 调整整体透明度；font/background.opacity 固定为 1。')
  Value.font.family = 'SimHei'; Value.font.opacity = 1; Value.background.opacity = 1
  return ValidateText(Value)
}

function Binding(Value: unknown, Label: string, Catalog: Catalog): ArrowBinding | undefined {
  if (Value === undefined || Value === null) return undefined
  const Data = Record(Value, Label); Keys(Data, ['id', 'side', 'offset'], Label)
  const Id = StringValue(Data.id, `${Label}.id`)
  if (!Catalog.Entries.some((Entry) => Entry.Id === Id && Entry.Kind !== 'line')) throw new Error(`绑定目标必须是项目中可用的图片或文本：${Id}`)
  const Side = StringValue(Data.side, `${Label}.side`), Offset = Data.offset === undefined ? 0.5 : NumberValue(Data.offset, `${Label}.offset`)
  if (!['left', 'right', 'top', 'bottom'].includes(Side) || Offset < 0 || Offset > 1) throw new Error(`${Label} 的 side 或 offset 无效。`)
  return { id: Id, side: Side as ArrowBinding['side'], offset: Offset }
}

function LineValue(Data: InputData, Id: string, Catalog: Catalog, Existing?: BoardArrow): BoardArrow {
  const StartBinding = Binding(Object.hasOwn(Data, 'startBinding') ? Data.startBinding : Existing?.arrow.startBinding, 'startBinding', Catalog)
  const EndBinding = Binding(Object.hasOwn(Data, 'endBinding') ? Data.endBinding : Existing?.arrow.endBinding, 'endBinding', Catalog)
  const HasGeometry = GeometryKeys.some((Key) => Data[Key] !== undefined)
  if (HasGeometry && (StartBinding || EndBinding)) throw new Error('绑定连线的位置由目标决定；移动目标，或将 startBinding/endBinding 设为 null 后修改连线外接框。')
  if (!Existing && HasGeometry) throw new Error('创建连线请使用世界坐标 start/end 或对象绑定；工具自动计算外接框。')
  if (HasGeometry && ['start', 'end', 'bend'].some((Key) => Data[Key] !== undefined)) throw new Error('一次修改选择外接框或端点/bend，不要同时指定。')
  const Base = Existing && { ...Existing, ...Geometry(Data, LayoutOf(Existing)) }
  const Previous = Base && ArrowEndpoints(Base), Items = Catalog.Entries.map((Entry) => Entry.Item)
  const Start = Data.start !== undefined ? Point(Data.start, 'start') : StartBinding ? BindingPoint(StartBinding, Items)! : Previous?.start
  const End = Data.end !== undefined ? Point(Data.end, 'end') : EndBinding ? BindingPoint(EndBinding, Items)! : Previous?.end
  if (!Start || !End) throw new Error('创建连线必须为两端分别提供世界坐标或绑定。')
  if ((Data.start !== undefined && StartBinding) || (Data.end !== undefined && EndBinding)) throw new Error('同一端点不能同时指定坐标与绑定；先用 null 解除该端绑定。')
  const Axis = Data.axis ?? (StartBinding ? ['top', 'bottom'].includes(StartBinding.side) ? 'vertical' : 'horizontal'
    : Existing?.arrow.axis ?? (Math.abs(End.x - Start.x) >= Math.abs(End.y - Start.y) ? 'horizontal' : 'vertical'))
  if (Axis !== 'horizontal' && Axis !== 'vertical') throw new Error('axis 必须是 horizontal 或 vertical。')
  const Arrow = { ...(Base ?? CreateArrow(Id, Start, End, Axis)) }
  Arrow.arrow = { ...Arrow.arrow, axis: Axis, startBinding: StartBinding, endBinding: EndBinding }
  for (const Key of ['color', 'thickness', 'dashed', 'manualBend'] as const) if (Data[Key] !== undefined) Object.assign(Arrow.arrow, { [Key]: Data[Key] })
  if (Data.bend !== undefined) {
    if (Data.manualBend === false) throw new Error('指定 bend 时不能同时关闭 manualBend。')
    Arrow.arrow.manualBend = true
  }
  ValidateArrow(Arrow, new Set())
  const Coordinate = Axis === 'horizontal' ? 'x' : 'y'
  const Bend = Data.bend !== undefined ? NumberValue(Data.bend, 'bend')
    : Arrow.arrow.manualBend && Previous ? Previous.bend
      : StartBinding || EndBinding ? (Start[Coordinate] + End[Coordinate]) / 2 : End[Coordinate]
  return ValidateArrow(PositionArrow(Arrow, Start, End, Bend), new Set())
}

async function EditElement(Group: string, Action: string, Data: InputData, Catalog: Catalog): Promise<CommandResult> {
  if (Catalog.Issues.length) throw new Error(`请先修复 validate 报告的问题：${Catalog.Issues.map((Issue) => `${Issue.id}: ${Issue.message}`).join('；')}`)
  const Id = Data.id === undefined && Action === 'create' ? NewId() : StringValue(Data.id, 'id')
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(Id)) throw new Error('id 必须是 1–128 位字母、数字、下划线或连字符。')
  const Previous = Catalog.Entries.find((Entry) => Entry.Id === Id)
  if (Action === 'create' && Catalog.Ids.has(Id)) throw new Error(`对象 ID 已存在：${Id}`)
  if (Action === 'update' && !Previous) throw new Error(`找不到对象：${Id}`)
  const Kind = Group === 'element' ? Previous!.Kind : Group as ElementKind
  if (Previous && Previous.Kind !== Kind) throw new Error(`对象类型不是 ${Kind}：${Id}`)
  Keys(Data, ['id', ...GeometryKeys, ...(Group === 'element' ? [] : Kind === 'image' ? ['source'] : Kind === 'text' ? ['text', 'content'] : LineKeys)], `${Group} ${Action}`)
  let Item: BoardItem, Bytes: Buffer
  if (Kind === 'image') {
    if (!Previous && Data.source === undefined) throw new Error('创建图片需要 source 本地图片路径。')
    const Imported = Data.source !== undefined ? await NormalizeImage(await ReadFile(StringValue(Data.source, 'source'))) : undefined
    const Defaults = Previous ? LayoutOf(Previous.Item) : { x: 0, y: 0, width: Imported!.asset.width, height: Imported!.asset.height }
    if (!Previous && Data.width !== undefined && Data.height === undefined) Defaults.height = Imported!.asset.height * NumberValue(Data.width, 'width') / Imported!.asset.width
    if (!Previous && Data.height !== undefined && Data.width === undefined) Defaults.width = Imported!.asset.width * NumberValue(Data.height, 'height') / Imported!.asset.height
    Item = { id: Id, asset: Previous?.Asset ?? '', ...Geometry(Data, Defaults) }
    Bytes = Imported?.bytes ?? Previous!.Bytes
  } else if (Kind === 'text') {
    const Old = Previous && 'text' in Previous.Item ? Previous.Item.text : undefined
    const Text = TextValue(Data, Old)
    Item = { id: Id, ...Geometry(Data, Previous ? LayoutOf(Previous.Item) : undefined), text: Text }
    Bytes = Old && JSON.stringify(Old) === JSON.stringify(Text) ? Previous!.Bytes : Buffer.from(Serialize(Text))
  } else {
    const Old = Previous && 'arrow' in Previous.Item ? Previous.Item : undefined
    Item = LineValue(Data, Id, Catalog, Old)
    Bytes = Old && JSON.stringify(Old.arrow) === JSON.stringify(Item.arrow) ? Previous!.Bytes : Buffer.from(Serialize({ format: 'hybridref-line', formatVersion: 1, arrow: Item.arrow }))
  }
  // Validate the exact geometry through the same config decoder the app uses.
  ParseConfig(Serialize({ format: ConfigFormat(Kind === 'image' ? 'Texture_.config' : Kind === 'text' ? 'Text_.config' : 'Line_.config'), formatVersion: 1, instances: { [Id]: LayoutOf(Item) } }), Kind === 'image' ? 'hybridref-texture' : Kind === 'text' ? 'hybridref-text-layout' : 'hybridref-line-layout')
  const Files = await WriteElement(Catalog, Kind, Item, Bytes, Previous)
  const Next = await ReadCatalog(Catalog.Path), Entry = Next.Entries.find((Value) => Value.Id === Id)!
  return { ok: true, project: Catalog.Path, element: InspectEntry(Entry), changedFiles: Files, requiresRefresh: true }
}

export async function RunCommand(Arguments: string[], Repository: string): Promise<CommandResult> {
  if (!Arguments.length || Arguments.includes('--help')) return { ok: true, commands: Commands, validate: 'validate --project <Path.hbr>',
    flags: ['--project', '--root', '--name', '--id', '--source', '--content', '--x', '--y', '--width', '--height', '--color', '--thickness', '--dashed', '--axis', '--input'],
    knowledge: Join(Repository, 'AgentKnowledge/README.md'), input: 'JSON/YAML patch; input source paths are relative to the input file. See Elements/*.md.',
    workflow: 'Save browser edits first; run CLI; then click Refresh in HybridRef. New elements are discoverable before refresh via element list.' }
  const { Group, Action, Project, Root, Name, InputFile, Data } = await ParseArguments(Arguments)
  if (Group === 'project') {
    Keys(Data, [], 'project')
    if (InputFile !== undefined) throw new Error('project 命令不接受 --input。')
    if (Action === 'create' || Action === 'list') {
      if (Project !== undefined || (Action === 'list' && Name !== undefined)) throw new Error('create 使用 --name/--root；list 只使用 --root。')
      const Directory = Root === undefined ? Join(Repository, 'Project') : Resolve(StringValue(Root, '--root'))
      if (Action === 'create') return { ok: true, project: await CreateProject(Directory, StringValue(Name, '--name')), requiresRefresh: false, next: 'Open the new project in HybridRef, then refresh after adding elements.' }
      await PlainPath(Directory)
      const Projects: string[] = []
      for (const Entry of await Readdir(Directory, { withFileTypes: true })) {
        if (Entry.isFile() && Entry.name.toLowerCase().endsWith('.hbr')) Projects.push(Join(Directory, Entry.name))
        else if (Entry.isDirectory() && !Entry.isSymbolicLink()) {
          for (const Child of await Readdir(Join(Directory, Entry.name), { withFileTypes: true })) {
            if (Child.isFile() && Child.name.toLowerCase().endsWith('.hbr')) Projects.push(Join(Directory, Entry.name, Child.name))
          }
        }
      }
      return { ok: true, projects: Projects.sort() }
    }
  } else if (Root !== undefined || Name !== undefined) throw new Error('--root/--name 仅用于 project create/list。')
  if (Group === 'project' && (Root !== undefined || Name !== undefined)) throw new Error('project inspect/delete 只接受 --project。')
  const Path = Resolve(StringValue(Project, '--project'))
  if (Group === 'project' && Action === 'delete') return WithProjectLock(Path, async () => ({ ok: true, deletedDirectory: await DeleteProject(Path, Repository), permanent: true }))
  if (Action === 'create' || Action === 'update') return WithProjectLock(Path, async () => EditElement(Group, Action, Data, await ReadCatalog(Path)))
  Keys(Data, Action === 'inspect' && Group === 'element' ? ['id'] : [], `${Group} ${Action}`)
  if (InputFile !== undefined) throw new Error('读取/校验命令不接受 --input。')
  const Catalog = await ReadCatalog(Path)
  if (Group === 'validate') return { ok: Catalog.Issues.length === 0, project: Catalog.Path, elements: Catalog.Entries.length, issues: Catalog.Issues }
  if (Group === 'element' && Action === 'inspect') {
    const Id = StringValue(Data.id, '--id'), Entry = Catalog.Entries.find((Value) => Value.Id === Id)
    if (!Entry) throw new Error(`找不到可读元素 ${Id}；使用 validate 查看问题。`)
    return { ok: true, project: Catalog.Path, element: InspectEntry(Entry), resourceYaml: Entry.Kind === 'image' ? undefined : Entry.Bytes.toString('utf8'), configYaml: Entry.LayoutText, issues: Catalog.Issues }
  }
  return { ok: true, project: Catalog.Path, formatVersion: Catalog.Index.formatVersion, viewport: Catalog.Index.viewport,
    elements: Catalog.Entries.map(InspectEntry), issues: Catalog.Issues, requiresRefresh: true }
}
