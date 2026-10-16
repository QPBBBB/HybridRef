import React, { useEffect as UseEffect, useRef as UseRef, useState as UseState } from 'react'
import { EmptyDocument, EmptyTextResource, TextFontFamily, type BoardDocument, type BoardImage, type BoardText, type BoardArrow, type BoardItem, type ArrowBinding, type ArrowStyle, type TextResource, type ImageAsset, type ImportResult, type LoadedBoard, type ProjectEntry, type Viewport } from '../Shared/Types'
import { ArrowDrawing, ArrowEndpoints, ConnectionHandles, CreateArrow, DetachTransformedArrows, PositionArrow, ResolveArrowBindings, SnapArrowEndpoint } from '../Shared/Arrows'
import {
  BoundingBox, CenterImages, FitViewport, Intersects, NormalizeImages, PushImages,
  RectFromPoints, ResizeGroup, ResizeTextFrame, ScreenToWorld, SnapMove, ZoomAt,
  type CenterMode, type NormalizeMode, type Point, type PushDirection, type ResizeCorner, type SnapGuide,
} from './Geometry'
import { ClearImageCache, DecodeAssets } from './ImageCache'
import { IsFileDialogOpen } from './FileDialog'
import { TextEditor } from './TextEditor'
import { TextAppearance } from './TextAppearance'
import { MarkdownPreview } from './MarkdownPreview'
import { ClearMarkdownImages } from './MarkdownContent'
import { CreateSelectionSnapshot } from './SelectionSnapshot'
import { TextInlineInput } from './TextInlineInput'
import { TextCreateIcon, TextSettingsIcon } from './TextCreateIcon'
import { ArrowView } from './ArrowView'
import { ArrowEditor } from './ArrowEditor'

const BoardItems = (Document: BoardDocument): BoardItem[] => [...Document.images, ...Document.texts, ...(Document.arrows ?? [])]

type TextEditSession = {
  id: string
  before: BoardItem[]
  draft: TextResource
  inline: boolean
  settings: boolean
  settingsBefore?: TextResource
}

type Gesture = {
  kind: 'pan' | 'marquee' | 'move' | 'resize' | 'arrow-create' | 'arrow-start' | 'arrow-end' | 'arrow-bend'
  start: Point
  viewport: Viewport
  before: BoardItem[]
  selected: string[]
  corner?: ResizeCorner
  additive?: boolean
  arrowId?: string
  moved?: boolean
}

const Fingerprint = (Images: readonly BoardItem[]): string => JSON.stringify(Images)
const Uuid = (): string => crypto.randomUUID()
const ClipboardType = 'application/x-hybridref-items'
const PushShortcuts: Partial<Record<string, PushDirection>> = { r: 'right', t: 'top', b: 'bottom' }
const DirectionalPushShortcuts: Partial<Record<string, PushDirection>> = { arrowleft: 'left', arrowright: 'right', arrowup: 'top', arrowdown: 'bottom' }
const CenterShortcuts: Partial<Record<string, CenterMode>> = { h: 'horizontal', v: 'vertical' }
const NormalizeShortcuts: Partial<Record<string, NormalizeMode>> = { arrowright: 'width', arrowleft: 'height' }
const ConnectionHandleOffset = 20
const ConnectionSnapDistance = 14

export default function App(): React.ReactElement {
  const [Document, SetDocument] = UseState<BoardDocument>(EmptyDocument)
  const Current = UseRef(Document)
  const [Assets, SetAssets] = UseState<Record<string, ImageAsset>>({})
  const AssetMap = UseRef<Record<string, ImageAsset>>({})
  const [Selected, SetSelected] = UseState<string[]>([])
  const Selection = UseRef<string[]>([])
  const [Path, SetPath] = UseState<string | null>(null)
  const CurrentPath = UseRef<string | null>(null)
  const SavedItems = UseRef(Fingerprint([]))
  const [Dirty, SetDirty] = UseState(false)
  const DirtyRef = UseRef(false)
  const [HistoryVersion, SetHistoryVersion] = UseState(0)
  const Past = UseRef<BoardItem[][]>([])
  const Future = UseRef<BoardItem[][]>([])
  const Canvas = UseRef<HTMLDivElement>(null)
  const Gesture = UseRef<Gesture | null>(null)
  const [Marquee, SetMarquee] = UseState<ReturnType<typeof RectFromPoints> | null>(null)
  const [Guides, SetGuides] = UseState<SnapGuide[]>([])
  const [SpaceHeld, SetSpaceHeld] = UseState(false)
  const Space = UseRef(false)
  const SpaceFitPending = UseRef(false)
  const [Message, SetMessage] = UseState('')
  const [Working, SetWorking] = UseState(1)
  const WorkingRef = UseRef(1)
  const PendingSaves = UseRef(0)
  const [ProjectMenuOpen, SetProjectMenuOpen] = UseState(false)
  const [ProjectEntries, SetProjectEntries] = UseState<ProjectEntry[]>([])
  const [ProjectsLoading, SetProjectsLoading] = UseState(false)
  const [ProjectsError, SetProjectsError] = UseState('')
  const ProjectMenuRevision = UseRef(0)
  const ProjectControl = UseRef<HTMLDivElement>(null)
  const ProjectPanel = UseRef<HTMLDivElement>(null)
  const OpenButton = UseRef<HTMLButtonElement>(null)
  const Session = UseRef(0)
  const StartupAllowed = UseRef(true)
  const InternalClipboard = UseRef<BoardItem[]>([])
  const ClipboardToken = UseRef('')
  const Copying = UseRef(false)
  const PasteOffset = UseRef(0)
  const SaveQueue = UseRef<Promise<unknown>>(Promise.resolve())
  const [TextEdit, SetTextEdit] = UseState<TextEditSession | null>(null)
  const TextEditing = UseRef<TextEditSession | null>(null)
  const TextComposing = UseRef(false)
  const AfterComposition = UseRef<(() => void)[]>([])
  const [ArrowMode, SetArrowMode] = UseState(false)
  const DrawingArrow = UseRef(false)
  const [ArrowEditId, SetArrowEditId] = UseState<string | null>(null)
  const ArrowEditing = UseRef<{ id: string; before: BoardItem[] } | null>(null)
  const [Connecting, SetConnecting] = UseState(false)
  const [ConnectionTarget, SetConnectionTarget] = UseState<ArrowBinding | undefined>()

  function ArrowModeChange(Next: boolean): void { DrawingArrow.current = Next; SetArrowMode(Next) }

  function StartWork(): void { WorkingRef.current += 1; SetWorking(WorkingRef.current) }
  function EndWork(): void { WorkingRef.current -= 1; SetWorking(WorkingRef.current) }

  function Select(Ids: string[]): void { Selection.current = Ids; SetSelected(Ids) }
  function RefreshDirty(): void {
    const Next = Fingerprint(TextDraftItems()) !== SavedItems.current
    DirtyRef.current = Next
    SetDirty(Next)
    window.HybridRef.SetDirty(Next)
  }
  function Publish(Next: BoardDocument): void {
    Current.current = Next
    SetDocument(Next)
  }
  function PublishItems(Next: BoardItem[]): void {
    const Resolved = ResolveArrowBindings(Next)
    const Arrows = Resolved.filter((Item): Item is BoardArrow => 'arrow' in Item)
    Publish({ ...Current.current, formatVersion: Arrows.length ? 4 : 3, images: Resolved.filter((Item): Item is BoardImage => 'asset' in Item), texts: Resolved.filter((Item): Item is BoardText => 'text' in Item), arrows: Arrows })
  }
  function Items(Next: BoardItem[], IsRecord = true): void {
    Next = ResolveArrowBindings(Next)
    if (Fingerprint(Next) === Fingerprint(BoardItems(Current.current))) return
    if (IsRecord) { Past.current.push(BoardItems(Current.current)); Future.current = []; SetHistoryVersion((Value) => Value + 1) }
    PublishItems(Next)
    RefreshDirty()
  }
  function History(Direction: 'undo' | 'redo'): void {
    if (WorkingRef.current || Gesture.current) return
    const From = Direction === 'undo' ? Past : Future
    const To = Direction === 'undo' ? Future : Past
    const Next = From.current.pop()
    if (!Next) return
    To.current.push(BoardItems(Current.current))
    PublishItems(Next)
    Select(Selection.current.filter((Id) => Next.some((Item) => Item.id === Id)))
    SetHistoryVersion((Value) => Value + 1)
    RefreshDirty()
  }
  function ShowError(CaughtError: unknown): void { SetMessage(CaughtError instanceof Error ? CaughtError.message : String(CaughtError)) }
  function MayDiscard(): boolean { return !DirtyRef.current || window.confirm('当前画板尚未保存。放弃更改并继续？') }
  function CloseProjectMenu(RestoreFocus = false): void {
    ProjectMenuRevision.current += 1
    SetProjectMenuOpen(false)
    if (RestoreFocus) OpenButton.current?.focus()
  }
  function ToggleProjectMenu(): void {
    if (WorkingRef.current) return
    if (ProjectMenuOpen) { CloseProjectMenu(true); return }
    SetProjectEntries([]); SetProjectsError(''); SetProjectsLoading(true)
    SetProjectMenuOpen(true)
  }
  function ProjectMenuKeyDown(InputEvent: React.KeyboardEvent): void {
    InputEvent.stopPropagation()
    if (InputEvent.key === 'Escape' || ((InputEvent.ctrlKey || InputEvent.metaKey) && InputEvent.key.toLowerCase() === 'o')) {
      InputEvent.preventDefault(); CloseProjectMenu(true); return
    }
    if (InputEvent.key === 'Tab') { CloseProjectMenu(true); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(InputEvent.key)) return
    InputEvent.preventDefault()
    const Items = Array.from(ProjectPanel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    const CurrentIndex = Items.indexOf(document.activeElement as HTMLButtonElement)
    const NextIndex = InputEvent.key === 'Home' ? 0 : InputEvent.key === 'End' ? Items.length - 1
      : (CurrentIndex + (InputEvent.key === 'ArrowDown' ? 1 : -1) + Items.length) % Items.length
    Items[NextIndex]?.focus()
  }
  function Reset(Next: BoardDocument, NextPath: string | null, NextAssets: ImageAsset[], MissingResources: string[] = []): void {
    const Arrows = ResolveArrowBindings(BoardItems(Next)).filter((Item): Item is BoardArrow => 'arrow' in Item)
    const FixedFont = { ...Next, arrows: Arrows, texts: Next.texts.map((Item) => ({ ...Item, text: { ...Item.text, font: { ...Item.text.font, family: TextFontFamily } } })) }
    TextEditing.current = null; SetTextEdit(null)
    ArrowEditing.current = null; SetArrowEditId(null); ArrowModeChange(false)
    TextComposing.current = false; AfterComposition.current = []
    Session.current += 1
    ClearImageCache()
    ClearMarkdownImages()
    AssetMap.current = Object.fromEntries(NextAssets.map((Asset) => [Asset.id, Asset]))
    SetAssets(AssetMap.current)
    void DecodeAssets(NextAssets).catch(ShowError)
    Gesture.current = null
    SetConnecting(false); SetConnectionTarget(undefined)
    Space.current = false; SpaceFitPending.current = false; SetSpaceHeld(false)
    SetGuides([])
    SetMarquee(null)
    InternalClipboard.current = []
    ClipboardToken.current = ''
    PasteOffset.current = 0
    Past.current = []; Future.current = []
    SetHistoryVersion((Value) => Value + 1)
    Publish(FixedFont)
    Select([])
    CurrentPath.current = NextPath; SetPath(NextPath)
    SavedItems.current = Fingerprint(BoardItems(FixedFont))
    RefreshDirty()
    SetMessage(MissingResources.length ? `${MissingResources.length} 个资源引用丢失，请手动检查 .hbr 中对应的引用` : '')
  }
  async function NewBoard(): Promise<void> {
    if (WorkingRef.current) return
    CloseProjectMenu(true)
    StartupAllowed.current = false
    if (!MayDiscard()) return
    const Revision = Session.current
    StartWork()
    try {
      const Loaded = await window.HybridRef.NewProject()
      if (Loaded && Session.current === Revision) Reset(Loaded.document, Loaded.path, Loaded.assets, Loaded.missingResources)
    }
    catch (CaughtError) { ShowError(CaughtError) }
    finally { EndWork() }
  }
  async function OpenBoard(ProjectPath: string): Promise<void> {
    if (WorkingRef.current) return
    CloseProjectMenu(true)
    StartupAllowed.current = false
    if (!MayDiscard()) return
    const Revision = Session.current
    StartWork()
    try {
      const Loaded = await window.HybridRef.Open(ProjectPath)
      if (Loaded && Session.current === Revision) Reset(Loaded.document, Loaded.path, Loaded.assets, Loaded.missingResources)
    } catch (CaughtError) { ShowError(CaughtError) }
    finally { EndWork() }
  }
  function SaveBoard(SaveAs = false): Promise<boolean> {
    if (TextComposing.current) return new Promise((Resolve) => { AfterComposition.current.push(() => { void SaveBoard(SaveAs).then(Resolve) }) })
    CommitText()
    if (WorkingRef.current > PendingSaves.current) return Promise.resolve(false)
    const Snapshot = structuredClone(Current.current)
    const Revision = Session.current
    PendingSaves.current += 1
    StartWork()
    const Pending = SaveQueue.current.then(async () => {
      try {
        // An earlier queued save may have established the destination already.
        const Result = await window.HybridRef.Save(Snapshot, SaveAs ? null : CurrentPath.current)
        if (!Result || Revision !== Session.current) return false
        CurrentPath.current = Result.path; SetPath(Result.path)
        SavedItems.current = Fingerprint(BoardItems(Snapshot))
        RefreshDirty()
        SetMessage(DirtyRef.current ? '已保存；还有新的修改未保存' : '已保存')
        return !DirtyRef.current
      } catch (CaughtError) { ShowError(CaughtError); return false }
      finally { PendingSaves.current -= 1; EndWork() }
    })
    SaveQueue.current = Pending
    return Pending
  }

  function CleanupResources(): Promise<void> {
    if (TextComposing.current) return new Promise((Resolve) => { AfterComposition.current.push(() => { void CleanupResources().then(Resolve) }) })
    if (WorkingRef.current || Gesture.current) return Promise.resolve()
    CommitText()
    CloseProjectMenu()
    const Snapshot = structuredClone(Current.current)
    const Revision = Session.current
    StartWork()
    const Pending = SaveQueue.current.then(async () => {
      try {
        let Destination = CurrentPath.current
        if (!Destination) {
          const Saved = await window.HybridRef.Save(Snapshot, null)
          if (!Saved || Revision !== Session.current) return
          Destination = Saved.path
          CurrentPath.current = Destination; SetPath(Destination)
          SavedItems.current = Fingerprint(BoardItems(Snapshot))
          RefreshDirty()
        }
        const Result = await window.HybridRef.Cleanup(Snapshot, Destination)
        if (Revision !== Session.current) return
        // Zooming while cleanup runs should not move the user back to an earlier viewport.
        Reset({ ...Result.document, viewport: Current.current.viewport }, Result.path, Result.assets, Result.missingResources)
        SetMessage(`已清理 ${Result.removedFiles} 个孤儿资源`)
      } catch (CaughtError) { ShowError(CaughtError) }
      finally { EndWork() }
    })
    SaveQueue.current = Pending
    return Pending
  }

  function ViewportSize(): { width: number; height: number } {
    return { width: Canvas.current?.clientWidth || window.innerWidth, height: Canvas.current?.clientHeight || window.innerHeight }
  }
  function Center(): Point {
    const Size = ViewportSize()
    return ScreenToWorld({ x: Size.width / 2, y: Size.height / 2 }, Current.current.viewport)
  }
  function TextDraftItems(): BoardItem[] {
    const Active = TextEditing.current
    return BoardItems(Current.current).map((Item) => Active && Item.id === Active.id && 'text' in Item ? { ...Item, text: Active.draft } : Item)
  }
  function PublishTextEdit(Next: TextEditSession | null): void {
    TextEditing.current = Next
    SetTextEdit(Next)
    RefreshDirty()
  }
  function CommitText(Focus = false): boolean {
    CommitArrow()
    if (TextComposing.current) { AfterComposition.current.push(() => { CommitText(Focus) }); return false }
    const Active = TextEditing.current
    if (!Active) return true
    const Text = structuredClone(Active.draft)
    Text.font.family = TextFontFamily
    const Next = BoardItems(Current.current).map((Item) => Item.id === Active.id && 'text' in Item ? { ...Item, text: Text } : Item)
    if (Fingerprint(Next) !== Fingerprint(Active.before)) {
      Past.current.push(Active.before); Future.current = []; SetHistoryVersion((Value) => Value + 1)
    }
    PublishItems(Next)
    PublishTextEdit(null)
    if (Focus) Canvas.current?.focus()
    return true
  }
  function CancelText(): void {
    const Active = TextEditing.current
    if (!Active || TextComposing.current) return
    PublishItems(Active.before)
    Select(Selection.current.filter((Id) => Active.before.some((Item) => Item.id === Id)))
    PublishTextEdit(null)
    Canvas.current?.focus()
  }
  function UpdateText(Resource: TextResource): void {
    const Active = TextEditing.current
    if (Active) PublishTextEdit({ ...Active, draft: Resource })
  }
  function UpdateTextContent(Content: string): void {
    const Active = TextEditing.current
    if (Active) UpdateText({ ...Active.draft, content: Content })
  }
  function TextComposition(Composing: boolean): void {
    if (Composing) { TextComposing.current = true; return }
    window.setTimeout(() => {
      TextComposing.current = false
      const Pending = AfterComposition.current.splice(0)
      Pending.forEach((Action) => Action())
    }, 0)
  }
  function AddText(Content = '文字', Edit = true): void {
    if (WorkingRef.current || Gesture.current || !CommitText()) return
    StartupAllowed.current = false
    ArrowModeChange(false)
    CloseProjectMenu()
    const Position = Center()
    const Height = Math.min(600, Math.max(160, Content.split('\n').length * 36 + 24))
    const Item: BoardText = { id: Uuid(), x: Position.x - 180, y: Position.y - Height / 2, width: 360, height: Height, text: EmptyTextResource(Content) }
    const Before = BoardItems(Current.current)
    if (Edit) {
      PublishItems([...Before, Item])
      PublishTextEdit({ id: Item.id, before: Before, draft: structuredClone(Item.text), inline: true, settings: false })
    } else Items([...Before, Item])
    Select([Item.id])
    if (!Edit) Canvas.current?.focus()
  }
  function EditText(Id: string): void {
    if (WorkingRef.current || Space.current) return
    Finish()
    const Active = TextEditing.current
    if (Active?.id === Id) { PublishTextEdit({ ...Active, inline: true }); return }
    if (!CommitText()) return
    const Item = Current.current.texts.find((Item) => Item.id === Id)
    if (!Item) return
    Select([Id])
    PublishTextEdit({ id: Id, before: BoardItems(Current.current), draft: structuredClone(Item.text), inline: true, settings: false })
  }
  function OpenTextSettings(Id: string): void {
    if (WorkingRef.current || Gesture.current) return
    const Active = TextEditing.current
    if (Active?.id === Id) {
      if (!Active.settings) PublishTextEdit({ ...Active, settings: true, settingsBefore: structuredClone(Active.draft) })
      return
    }
    if (!CommitText()) return
    const Item = Current.current.texts.find((Item) => Item.id === Id)
    if (!Item) return
    PublishTextEdit({ id: Id, before: BoardItems(Current.current), draft: structuredClone(Item.text), inline: false, settings: true, settingsBefore: structuredClone(Item.text) })
  }
  function CommitArrow(Focus = false): void {
    const Active = ArrowEditing.current
    if (!Active) return
    if (Fingerprint(BoardItems(Current.current)) !== Fingerprint(Active.before)) {
      Past.current.push(Active.before); Future.current = []; SetHistoryVersion((Value) => Value + 1)
    }
    ArrowEditing.current = null; SetArrowEditId(null)
    RefreshDirty()
    if (Focus) Canvas.current?.focus()
  }
  function CancelArrow(): void {
    const Active = ArrowEditing.current
    if (!Active) return
    PublishItems(Active.before)
    ArrowEditing.current = null; SetArrowEditId(null)
    RefreshDirty(); Canvas.current?.focus()
  }
  function OpenArrowSettings(Id: string): void {
    if (WorkingRef.current || Gesture.current || ArrowEditing.current?.id === Id || !CommitText()) return
    ArrowModeChange(false)
    ArrowEditing.current = { id: Id, before: BoardItems(Current.current) }; SetArrowEditId(Id)
  }
  function UpdateArrowStyle(Style: ArrowStyle): void {
    Items(BoardItems(Current.current).map((Item) => {
      if (!('arrow' in Item) || Item.id !== ArrowEditing.current?.id) return Item
      const Points = ArrowEndpoints(Item)
      return PositionArrow({ ...Item, arrow: { ...Item.arrow, ...Style } }, Points.start, Points.end, Points.bend)
    }), false)
  }
  function ToggleArrowMode(): void {
    if (WorkingRef.current || Gesture.current || !CommitText()) return
    CloseProjectMenu(); ArrowModeChange(!DrawingArrow.current); Canvas.current?.focus()
  }
  function CancelTextSettings(): void {
    const Active = TextEditing.current
    if (!Active) return
    if (!Active.inline) { CancelText(); return }
    PublishTextEdit({ ...Active, settings: false, settingsBefore: undefined, draft: { ...structuredClone(Active.settingsBefore ?? Active.draft), content: Active.draft.content } })
    Canvas.current?.querySelector<HTMLTextAreaElement>('.text-inline-input')?.focus()
  }
  function DoubleClick(InputEvent: React.MouseEvent): void {
    if (DrawingArrow.current) return
    const Arrow = Current.current.arrows?.find((Item) => Selection.current.length === 1 && Selection.current[0] === Item.id)
    if (Arrow) { OpenArrowSettings(Arrow.id); return }
    const Point = ScreenToWorld(LocalPoint(InputEvent.clientX, InputEvent.clientY), Current.current.viewport)
    // Pointer capture routes the final click to the canvas, so hit-test the visible text frames.
    const Item = [...Current.current.texts].reverse().find((Item) => Point.x >= Item.x && Point.x <= Item.x + Item.width && Point.y >= Item.y && Point.y <= Item.y + Item.height)
    if (Item) EditText(Item.id)
  }
  async function AddAssets(Result: ImportResult, Revision: number, Position: Point): Promise<void> {
    if (Revision !== Session.current) return
    await DecodeAssets(Result.assets)
    if (Revision !== Session.current) return
    const NextAssets = { ...AssetMap.current }
    Result.assets.forEach((Asset) => { NextAssets[Asset.id] = Asset })
    AssetMap.current = NextAssets; SetAssets(NextAssets)
    const Imported = Result.assets.map((Asset, Index): BoardImage => {
      const Ratio = Math.min(1, 800 / Math.max(Asset.width, Asset.height))
      const Width = Asset.width * Ratio, Height = Asset.height * Ratio
      return { id: Uuid(), asset: Asset.id, x: Position.x - Width / 2 + Index * 28, y: Position.y - Height / 2 + Index * 28, width: Width, height: Height }
    })
    if (Imported.length) { Items([...BoardItems(Current.current), ...Imported]); Select(Imported.map((Item) => Item.id)) }
    SetMessage(Result.errors.length ? Result.errors.join('；') : Imported.length ? `已导入 ${Imported.length} 张图片` : '')
  }
  async function ImportFiles(Files: File[], Position = Center()): Promise<void> {
    if (WorkingRef.current || !Files.length) return
    if (TextComposing.current) { AfterComposition.current.push(() => { void ImportFiles(Files, Position) }); return }
    CommitText()
    StartupAllowed.current = false
    const Revision = Session.current
    StartWork()
    try {
      const Bytes = await Promise.all(Files.map(async (FileValue) => ({ name: FileValue.name, bytes: new Uint8Array(await FileValue.arrayBuffer()) })))
      if (Revision !== Session.current) return
      await AddAssets(await window.HybridRef.ImportBytes(Bytes), Revision, Position)
    }
    catch (CaughtError) { if (Revision === Session.current) ShowError(CaughtError) }
    finally { EndWork() }
  }
  async function Drop(InputEvent: React.DragEvent<HTMLDivElement>): Promise<void> {
    InputEvent.preventDefault()
    if (WorkingRef.current) return
    const Files = Array.from(InputEvent.dataTransfer.files)
    if (!Files.length) return
    const Position = ScreenToWorld(LocalPoint(InputEvent.clientX, InputEvent.clientY), Current.current.viewport)
    await ImportFiles(Files, Position)
  }
  function DeleteSelected(): void {
    if (WorkingRef.current) return
    const Ids = new Set(Selection.current)
    Items(BoardItems(Current.current).filter((Item) => !Ids.has(Item.id)).map((Item) => !('arrow' in Item) ? Item : { ...Item, arrow: { ...Item.arrow,
      startBinding: Item.arrow.startBinding && !Ids.has(Item.arrow.startBinding.id) ? Item.arrow.startBinding : undefined,
      endBinding: Item.arrow.endBinding && !Ids.has(Item.arrow.endBinding.id) ? Item.arrow.endBinding : undefined,
    } }))
    Select([])
  }
  function Copy(InputEvent: ClipboardEvent, Cut = false): void {
    const SelectedItems = TextDraftItems().filter((Item) => Selection.current.includes(Item.id))
    if (!SelectedItems.length) return
    InputEvent.preventDefault()
    if (Copying.current || WorkingRef.current || Gesture.current) return
    if (!Cut) { void CopySnapshot(structuredClone(SelectedItems)); return }
    if (!InputEvent.clipboardData) return
    InternalClipboard.current = structuredClone(SelectedItems)
    ClipboardToken.current = `hybridref:${Uuid()}`
    PasteOffset.current = 0
    InputEvent.clipboardData.setData(ClipboardType, ClipboardToken.current)
    InputEvent.clipboardData.setData('text/plain', ClipboardToken.current)
    DeleteSelected()
  }
  async function CopySnapshot(SelectedItems: BoardItem[]): Promise<void> {
    const Revision = Session.current
    Copying.current = true
    SetMessage('正在生成 PNG 快照…')
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('当前浏览器不支持图片剪贴板，请使用 Edge 打开本地应用')
      const Png = CreateSelectionSnapshot(SelectedItems, AssetMap.current, getComputedStyle(Canvas.current!).backgroundColor, CurrentPath.current)
      // Consume rejection even if ClipboardItem construction/write fails before reading the promise.
      void Png.catch(() => {})
      // Start the clipboard write within the copy gesture; supply asynchronous pixels as a promise.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': Png })])
      if (Revision !== Session.current) return
      SetMessage('已复制选中元素的 PNG 快照')
    } catch (CaughtError) {
      if (Revision === Session.current) SetMessage(`复制快照失败：${CaughtError instanceof Error ? CaughtError.message : String(CaughtError)}`)
    } finally { Copying.current = false }
  }
  function InsertCopies(Source: BoardItem[], Offset: number): void {
    if (WorkingRef.current) return
    const Valid = Source.filter((Item) => !('asset' in Item) || AssetMap.current[Item.asset])
    const Ids = new Map(Valid.map((Item) => [Item.id, Uuid()]))
    const Copies = Valid.map((Item): BoardItem => ({ ...structuredClone(Item), id: Ids.get(Item.id)!, x: Item.x + Offset, y: Item.y + Offset,
      ...('arrow' in Item ? { arrow: { ...structuredClone(Item.arrow),
        startBinding: Item.arrow.startBinding && Ids.has(Item.arrow.startBinding.id) ? { ...Item.arrow.startBinding, id: Ids.get(Item.arrow.startBinding.id)! } : undefined,
        endBinding: Item.arrow.endBinding && Ids.has(Item.arrow.endBinding.id) ? { ...Item.arrow.endBinding, id: Ids.get(Item.arrow.endBinding.id)! } : undefined,
      } } : {}),
    }))
    if (!Copies.length) return
    Items([...BoardItems(Current.current), ...Copies])
    Select(Copies.map((Item) => Item.id))
  }
  function Paste(InputEvent: ClipboardEvent): void {
    const Content = InputEvent.clipboardData
    if (!Content) return
    const Token = Content.getData(ClipboardType) || Content.getData('text/plain')
    if (Token && Token === ClipboardToken.current) {
      InputEvent.preventDefault()
      if (WorkingRef.current) return
      PasteOffset.current += 24
      InsertCopies(InternalClipboard.current, PasteOffset.current)
      return
    }
    const Files = Array.from(Content.files).filter((FileValue) => FileValue.type.startsWith('image/'))
    if (Files.length) { InputEvent.preventDefault(); void ImportFiles(Files); return }
    if (Content.getData('text/plain') && !Token.startsWith('hybridref:')) {
      InputEvent.preventDefault()
      AddText(Content.getData('text/plain'), false)
    }
  }
  function Fit(): void { Publish({ ...Current.current, viewport: FitViewport(BoundingBox(BoardItems(Current.current)), ViewportSize(), 56) }) }
  function FitSelection(): void {
    const Bounds = BoundingBox(BoardItems(Current.current).filter((Item) => Selection.current.includes(Item.id)))
    if (Bounds) Publish({ ...Current.current, viewport: FitViewport(Bounds, ViewportSize(), 56) })
  }
  function ChangeZoom(Next: number): void {
    const Size = ViewportSize()
    Publish({ ...Current.current, viewport: ZoomAt(Current.current.viewport, { x: Size.width / 2, y: Size.height / 2 }, Next) })
  }
  function TransformSelection(InputEvent: KeyboardEvent): boolean {
    if (InputEvent.metaKey || InputEvent.shiftKey || InputEvent.isComposing || InputEvent.repeat
      || WorkingRef.current || Gesture.current || Space.current || Selection.current.length < 2) return false
    const Key = InputEvent.key.toLowerCase()
    let Next: BoardItem[] | undefined
    if (InputEvent.ctrlKey && InputEvent.altKey) {
      const Mode = NormalizeShortcuts[Key]
      if (Mode) Next = NormalizeImages(BoardItems(Current.current), Selection.current, Mode)
    } else if (!InputEvent.altKey) {
      const Direction = (InputEvent.ctrlKey ? DirectionalPushShortcuts : PushShortcuts)[Key]
      const CenterMode = !InputEvent.ctrlKey ? CenterShortcuts[Key] : undefined
      if (Direction) Next = PushImages(BoardItems(Current.current), Selection.current, Direction)
      else if (CenterMode) Next = CenterImages(BoardItems(Current.current), Selection.current, CenterMode)
    }
    if (!Next) return false
    InputEvent.preventDefault()
    Items(DetachTransformedArrows(Next, Selection.current))
    return true
  }

  function LocalPoint(ClientX: number, ClientY: number): Point {
    const Rect = Canvas.current!.getBoundingClientRect()
    return { x: ClientX - Rect.left, y: ClientY - Rect.top }
  }
  function Begin(InputEvent: React.PointerEvent, ImageId?: string, Corner?: ResizeCorner, Connection?: ArrowBinding): void {
    if (Gesture.current || WorkingRef.current || !CommitText()) return
    if (InputEvent.button !== 0 && InputEvent.button !== 1) return
    InputEvent.preventDefault()
    InputEvent.stopPropagation()
    const Start = LocalPoint(InputEvent.clientX, InputEvent.clientY)
    Canvas.current!.setPointerCapture(InputEvent.pointerId)
    const Base = { start: Start, viewport: Current.current.viewport, before: BoardItems(Current.current), selected: [...Selection.current] }
    if (InputEvent.button === 1 || Space.current) { Gesture.current = { ...Base, kind: 'pan' }; return }
    if (DrawingArrow.current || Connection) {
      const Origin = ScreenToWorld(Start, Base.viewport)
      const Source = Base.before.find((Item): Item is BoardImage | BoardText => Item.id === Connection?.id && !('arrow' in Item))
      const Endpoint = Source ? ConnectionHandles(Source).find((Handle) => Handle.binding.side === Connection!.side)!
        : InputEvent.altKey ? { point: Origin, binding: undefined } : SnapArrowEndpoint(Origin, Base.before, ConnectionSnapDistance / Base.viewport.zoom, ConnectionHandleOffset / Base.viewport.zoom)
      const Axis = Endpoint.binding && ['top', 'bottom'].includes(Endpoint.binding.side) ? 'vertical' : 'horizontal'
      const Arrow = CreateArrow(Uuid(), Endpoint.point, Endpoint.point, Axis)
      Arrow.arrow.startBinding = Endpoint.binding
      Gesture.current = { ...Base, kind: 'arrow-create', arrowId: Arrow.id }
      CloseProjectMenu(); SetConnecting(true); SetConnectionTarget(undefined)
      StartupAllowed.current = false
      Items([...Base.before, Arrow], false); Select([Arrow.id])
      Canvas.current?.focus()
      return
    }
    if (Corner) { Gesture.current = { ...Base, kind: 'resize', corner: Corner }; return }
    if (ImageId) {
      let Ids = Selection.current
      if (InputEvent.shiftKey) Ids = Ids.includes(ImageId) ? Ids.filter((Id) => Id !== ImageId) : [...Ids, ImageId]
      else if (!Ids.includes(ImageId)) Ids = [ImageId]
      Select(Ids)
      if (Ids.includes(ImageId)) Gesture.current = { ...Base, selected: Ids, kind: 'move' }
    } else {
      Gesture.current = { ...Base, kind: 'marquee', additive: InputEvent.shiftKey }
      if (!InputEvent.shiftKey) Select([])
      SetMarquee({ x: Start.x, y: Start.y, width: 0, height: 0 })
    }
  }
  function BeginArrowHandle(InputEvent: React.PointerEvent, Item: BoardArrow, Kind: 'arrow-start' | 'arrow-end' | 'arrow-bend'): void {
    if (InputEvent.button !== 0 || Gesture.current || WorkingRef.current || !CommitText()) return
    if (Space.current) { Begin(InputEvent, Item.id); return }
    InputEvent.preventDefault(); InputEvent.stopPropagation()
    Canvas.current!.setPointerCapture(InputEvent.pointerId)
    Gesture.current = { kind: Kind, arrowId: Item.id, start: LocalPoint(InputEvent.clientX, InputEvent.clientY), viewport: Current.current.viewport, before: BoardItems(Current.current), selected: [...Selection.current] }
    SetConnecting(Kind !== 'arrow-bend'); SetConnectionTarget(undefined); Canvas.current?.focus()
  }
  function Move(InputEvent: React.PointerEvent): void {
    const Active = Gesture.current
    if (!Active) return
    const Point = LocalPoint(InputEvent.clientX, InputEvent.clientY)
    const Delta = { x: Point.x - Active.start.x, y: Point.y - Active.start.y }
    if (Active.arrowId) {
      if (Active.kind === 'arrow-create' && !Active.moved) {
        if (Math.hypot(Delta.x, Delta.y) < 6) return
        Active.moved = true
      }
      const Item = (Active.kind === 'arrow-create' ? Current.current.arrows : Active.before.filter((Item): Item is BoardArrow => 'arrow' in Item))?.find((Item) => Item.id === Active.arrowId)
      if (!Item) return
      const Points = ArrowEndpoints(Item)
      const Pointer = ScreenToWorld(Point, Active.viewport)
      let Next: BoardArrow
      if (Active.kind === 'arrow-bend') Next = PositionArrow(Item, Points.start, Points.end, Item.arrow.axis === 'horizontal' ? Pointer.x : Pointer.y)
      else {
        const IsStart = Active.kind === 'arrow-start'
        const OtherBinding = IsStart ? Item.arrow.endBinding : Item.arrow.startBinding
        const Endpoint = InputEvent.altKey ? { point: Pointer, binding: undefined } : SnapArrowEndpoint(Pointer, Active.before, ConnectionSnapDistance / Active.viewport.zoom, ConnectionHandleOffset / Active.viewport.zoom, OtherBinding?.id)
        SetConnectionTarget(Endpoint.binding)
        const Start = IsStart ? Endpoint.point : Points.start, End = IsStart ? Points.end : Endpoint.point
        const Arrow = { ...Item.arrow, ...(IsStart ? { startBinding: Endpoint.binding } : { endBinding: Endpoint.binding }) }
        if (Active.kind === 'arrow-create') Arrow.axis = Arrow.startBinding
          ? (['top', 'bottom'].includes(Arrow.startBinding.side) ? 'vertical' : 'horizontal')
          : Math.abs(End.x - Start.x) >= Math.abs(End.y - Start.y) ? 'horizontal' : 'vertical'
        const Bend = Active.kind === 'arrow-create' ? (Arrow.axis === 'horizontal' ? (Start.x + End.x) / 2 : (Start.y + End.y) / 2) : Points.bend
        Next = PositionArrow({ ...Item, arrow: Arrow }, Start, End, Bend)
      }
      Items(Active.kind === 'arrow-create' ? [...Active.before, Next] : Active.before.map((Item) => Item.id === Next.id ? Next : Item), false)
      return
    }
    if (Active.kind === 'pan') {
      Publish({ ...Current.current, viewport: { ...Active.viewport, x: Active.viewport.x + Delta.x, y: Active.viewport.y + Delta.y } }); return
    }
    if (Active.kind === 'marquee') {
      SetMarquee(RectFromPoints(Active.start, Point))
      const Bounds = RectFromPoints(ScreenToWorld(Active.start, Active.viewport), ScreenToWorld(Point, Active.viewport))
      const Hits = Active.before.filter((Item) => Intersects(Item, Bounds)).map((Item) => Item.id)
      Select(Active.additive ? [...Active.selected.filter((Id) => !Hits.includes(Id)), ...Hits.filter((Id) => !Active.selected.includes(Id))] : Hits)
      return
    }
    if (Math.abs(Delta.x) + Math.abs(Delta.y) < 2) return
    const SelectedImages = Active.before.filter((Item) => Active.selected.includes(Item.id))
    let Changed: BoardItem[]
    if (Active.kind === 'resize') {
      const Pointer = ScreenToWorld(Point, Active.viewport)
      const First = SelectedImages[0]
      const TextPointer = First ? {
        x: First.x + (Active.corner === 'nw' || Active.corner === 'sw' ? 0 : First.width) + Delta.x / Active.viewport.zoom,
        y: First.y + (Active.corner === 'nw' || Active.corner === 'ne' ? 0 : First.height) + Delta.y / Active.viewport.zoom,
      } : Pointer
      Changed = SelectedImages.length === 1 && 'text' in SelectedImages[0]
        ? [ResizeTextFrame(SelectedImages[0], Active.corner!, TextPointer)]
        : ResizeGroup(SelectedImages, Active.corner!, Pointer, 4 / Active.viewport.zoom)
    }
    else {
      const Bounds = BoundingBox(SelectedImages)
      if (!Bounds) return
      const Other = Active.before.filter((Item) => !Active.selected.includes(Item.id))
      const Raw = { dx: Delta.x / Active.viewport.zoom, dy: Delta.y / Active.viewport.zoom }
      const Snapped = InputEvent.altKey ? { ...Raw, guides: [] } : SnapMove(Bounds, Other, Raw.dx, Raw.dy, 7 / Active.viewport.zoom)
      SetGuides(Snapped.guides)
      Changed = SelectedImages.map((Item) => ({ ...Item, x: Item.x + Snapped.dx, y: Item.y + Snapped.dy }))
    }
    const ById = new Map(Changed.map((Item) => [Item.id, Item]))
    Items(DetachTransformedArrows(Active.before.map((Item) => ById.get(Item.id) ?? Item), Active.selected), false)
  }
  function Finish(InputEvent?: React.PointerEvent, Cancel = false): void {
    const Active = Gesture.current
    if (!Active) return
    if (Active.kind === 'arrow-create') {
      const Item = Current.current.arrows?.find((Item) => Item.id === Active.arrowId)
      const Endpoints = Item && ArrowEndpoints(Item)
      if (!Active.moved || !Endpoints || Math.hypot(Endpoints.end.x - Endpoints.start.x, Endpoints.end.y - Endpoints.start.y) * Active.viewport.zoom < 6) Cancel = true
      ArrowModeChange(false)
    }
    if (Active.kind === 'move' || Active.kind === 'resize' || Active.arrowId) {
      if (Cancel) Items(Active.before, false)
      else if (Fingerprint(Active.before) !== Fingerprint(BoardItems(Current.current))) {
        Past.current.push(Active.before); Future.current = []; SetHistoryVersion((Value) => Value + 1)
      }
      if (Cancel && Active.arrowId) Select(Active.selected)
    }
    Gesture.current = null
    SetConnecting(false); SetConnectionTarget(undefined)
    SetMarquee(null); SetGuides([])
    if (InputEvent && Canvas.current?.hasPointerCapture(InputEvent.pointerId)) Canvas.current.releasePointerCapture(InputEvent.pointerId)
  }

  UseEffect(() => {
    const Revision = Session.current
    void window.HybridRef.Startup().then((Loaded: LoadedBoard | null) => {
      if (Loaded && StartupAllowed.current && Session.current === Revision) Reset(Loaded.document, Loaded.path, Loaded.assets, Loaded.missingResources)
    }).catch(ShowError).finally(EndWork)
  }, [])
  UseEffect(() => {
    window.document.title = `${Dirty ? '* ' : ''}${Path?.split(/[\\/]/).pop() || '未命名'} — HybridRef`
  }, [Path, Dirty])
  UseEffect(() => {
    const OutsideText = (InputEvent: PointerEvent): void => {
      if (InputEvent.target instanceof Element && ArrowEditing.current && !InputEvent.target.closest('.arrow-editor, .arrow-settings-button')) CommitArrow()
      if (!TextEditing.current || !(InputEvent.target instanceof Element)) return
      if (InputEvent.target.closest('.text-inline-input, .text-editor, .text-settings-button')) return
      CommitText()
    }
    window.addEventListener('pointerdown', OutsideText, true)
    return () => window.removeEventListener('pointerdown', OutsideText, true)
  }, [])
  UseEffect(() => {
    if (!ProjectMenuOpen) return
    const Revision = ++ProjectMenuRevision.current
    ProjectPanel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    void window.HybridRef.ListProjects().then((Entries) => {
      if (Revision === ProjectMenuRevision.current) SetProjectEntries(Entries)
    }).catch((CaughtError) => {
      if (Revision === ProjectMenuRevision.current) SetProjectsError(CaughtError instanceof Error ? CaughtError.message : String(CaughtError))
    }).finally(() => {
      if (Revision === ProjectMenuRevision.current) SetProjectsLoading(false)
    })
    const Outside = (InputEvent: PointerEvent): void => {
      if (InputEvent.target instanceof Node && !ProjectControl.current?.contains(InputEvent.target)) CloseProjectMenu()
    }
    window.addEventListener('pointerdown', Outside, true)
    return () => {
      ProjectMenuRevision.current += 1
      window.removeEventListener('pointerdown', Outside, true)
    }
  }, [ProjectMenuOpen])
  UseEffect(() => {
    const Element = Canvas.current!
    const Wheel = (InputEvent: WheelEvent) => {
      if (InputEvent.target instanceof HTMLElement && InputEvent.target.closest('.text-editor, .text-inline-input')) return
      InputEvent.preventDefault()
      SpaceFitPending.current = false
      const Point = LocalPoint(InputEvent.clientX, InputEvent.clientY)
      const Scale = Math.exp(-InputEvent.deltaY * (InputEvent.deltaMode === 1 ? 0.025 : 0.0015))
      Publish({ ...Current.current, viewport: ZoomAt(Current.current.viewport, Point, Current.current.viewport.zoom * Scale) })
    }
    Element.addEventListener('wheel', Wheel, { passive: false })
    return () => Element.removeEventListener('wheel', Wheel)
  }, [])
  UseEffect(() => {
    const EditingText = (Target: EventTarget | null): boolean => IsFileDialogOpen() || Target instanceof HTMLInputElement || Target instanceof HTMLTextAreaElement || Target instanceof HTMLSelectElement || Boolean((Target as HTMLElement)?.isContentEditable)
    const Down = (InputEvent: KeyboardEvent) => {
      if (Space.current && InputEvent.code !== 'Space') SpaceFitPending.current = false
      if (EditingText(InputEvent.target)) return
      const Modifier = InputEvent.ctrlKey || InputEvent.metaKey
      const Key = InputEvent.key.toLowerCase()
      if (TextEditing.current) {
        if (Modifier && Key === 's') { InputEvent.preventDefault(); void SaveBoard(InputEvent.shiftKey) }
        else if (Modifier && Key === 'enter') { InputEvent.preventDefault(); CommitText(true) }
        else if (Key === 'escape') { InputEvent.preventDefault(); CancelText() }
        return
      }
      if (ArrowEditing.current) {
        if (Modifier && Key === 's') { InputEvent.preventDefault(); void SaveBoard(InputEvent.shiftKey) }
        else if (Modifier && Key === 'enter') { InputEvent.preventDefault(); CommitArrow(true) }
        else if (Key === 'escape') { InputEvent.preventDefault(); CancelArrow() }
        return
      }
      if (ProjectMenuOpen) {
        if (Key === 'escape' || (Modifier && Key === 'o')) { InputEvent.preventDefault(); CloseProjectMenu(true) }
        return
      }
      if (InputEvent.code === 'Space') {
        if (InputEvent.isComposing || InputEvent.keyCode === 229) return
        InputEvent.preventDefault()
        if (Modifier || InputEvent.altKey || InputEvent.shiftKey || WorkingRef.current || Gesture.current) return
        if (!InputEvent.repeat && !Space.current) { Space.current = true; SpaceFitPending.current = true; SetSpaceHeld(true) }
        return
      }
      if (Key === 'escape') {
        const CancellingArrow = Boolean(Gesture.current?.arrowId)
        Finish(undefined, true); ArrowModeChange(false)
        if (!CancellingArrow) Select([])
        return
      }
      if (Gesture.current) return
      if (TransformSelection(InputEvent)) return
      const Action = Modifier ? ({
        a: () => Select(BoardItems(Current.current).map((Item) => Item.id)),
        d: () => InsertCopies(BoardItems(Current.current).filter((Item) => Selection.current.includes(Item.id)), 24),
        z: () => History(InputEvent.shiftKey ? 'redo' : 'undo'), y: () => History('redo'),
        s: () => { void SaveBoard(InputEvent.shiftKey) }, o: ToggleProjectMenu,
      } as Record<string, (() => void)>)[Key] : ({
        delete: DeleteSelected, backspace: DeleteSelected, f: Fit,
        '+': () => ChangeZoom(Current.current.viewport.zoom * 1.2), '=': () => ChangeZoom(Current.current.viewport.zoom * 1.2), '-': () => ChangeZoom(Current.current.viewport.zoom / 1.2),
      } as Record<string, (() => void)>)[Key]
      if (Action) { InputEvent.preventDefault(); Action() }
    }
    const Up = (InputEvent: KeyboardEvent) => {
      if (InputEvent.code !== 'Space') return
      const FitRequested = Space.current && SpaceFitPending.current
      Space.current = false; SpaceFitPending.current = false; SetSpaceHeld(false)
      // Wait until release to distinguish a tap from the existing Space + drag gesture.
      if (FitRequested && !EditingText(InputEvent.target) && !TextEditing.current && !ArrowEditing.current && !DrawingArrow.current && !ProjectMenuOpen
        && !WorkingRef.current && !Gesture.current && !InputEvent.isComposing
        && !InputEvent.ctrlKey && !InputEvent.metaKey && !InputEvent.altKey && !InputEvent.shiftKey) FitSelection()
    }
    const PointerDown = () => { SpaceFitPending.current = false }
    const Blur = () => { Space.current = false; SpaceFitPending.current = false; SetSpaceHeld(false); Finish(undefined, true) }
    const Copied = (InputEvent: ClipboardEvent) => { if (!TextEditing.current?.inline && !ProjectMenuOpen && !EditingText(InputEvent.target)) Copy(InputEvent) }
    const Cut = (InputEvent: ClipboardEvent) => { if (!TextEditing.current && !ProjectMenuOpen && !EditingText(InputEvent.target)) Copy(InputEvent, true) }
    const Pasted = (InputEvent: ClipboardEvent) => { if (!TextEditing.current && !ProjectMenuOpen && !EditingText(InputEvent.target)) Paste(InputEvent) }
    window.addEventListener('keydown', Down); window.addEventListener('keyup', Up); window.addEventListener('blur', Blur)
    window.addEventListener('pointerdown', PointerDown, true)
    window.addEventListener('copy', Copied); window.addEventListener('cut', Cut); window.addEventListener('paste', Pasted)
    return () => {
      window.removeEventListener('keydown', Down); window.removeEventListener('keyup', Up); window.removeEventListener('blur', Blur)
      window.removeEventListener('pointerdown', PointerDown, true)
      window.removeEventListener('copy', Copied); window.removeEventListener('cut', Cut); window.removeEventListener('paste', Pasted)
    }
  })

  const Bounds = BoundingBox(BoardItems(Document).filter((Item) => Selected.includes(Item.id)))
  const SelectedText = Selected.length === 1 ? Document.texts.find((Item) => Item.id === Selected[0]) : undefined
  const SelectedArrow = Selected.length === 1 ? Document.arrows?.find((Item) => Item.id === Selected[0]) : undefined
  const ArrowControls = SelectedArrow && ArrowDrawing(SelectedArrow)
  const EditedArrow = Document.arrows?.find((Item) => Item.id === ArrowEditId)
  const View = Document.viewport
  const SettingsSize = SelectedText ? Math.min(64, Math.max(20, Math.min(SelectedText.width, SelectedText.height) * View.zoom * 0.32)) : 0
  const ArrowSettingsSize = SelectedArrow ? Math.min(40, Math.max(24, Math.min(SelectedArrow.width, SelectedArrow.height) * View.zoom * 0.32)) : 0
  const SelectionStyle = Bounds ? { left: View.x + Bounds.x * View.zoom, top: View.y + Bounds.y * View.zoom, width: Bounds.width * View.zoom, height: Bounds.height * View.zoom } : undefined
  return <div className="app" data-history-version={HistoryVersion}>
    <header className="toolbar">
      <span className="brand">HybridRef</span>
      <div ref={ProjectControl} className="project-control">
        <button ref={OpenButton} data-testid="open" disabled={Working > 0} title="打开项目 · Ctrl+O" aria-haspopup="menu" aria-expanded={ProjectMenuOpen} aria-controls={ProjectMenuOpen ? 'project-menu' : undefined} onClick={ToggleProjectMenu}
          onKeyDown={(InputEvent) => { if (!ProjectMenuOpen && (InputEvent.key === 'ArrowDown' || InputEvent.key === 'ArrowUp')) { InputEvent.preventDefault(); ToggleProjectMenu() } }}>打开 ▾</button>
        {ProjectMenuOpen && <div ref={ProjectPanel} id="project-menu" data-testid="project-menu" className="project-menu" role="menu" aria-label="项目" onKeyDown={ProjectMenuKeyDown}>
          <button data-testid="new" className="project-create" role="menuitem" disabled={Working > 0} onClick={() => void NewBoard()}>+ 新建项目</button>
          <div className="project-menu-list" role="group" aria-label="现有项目">
            {ProjectsLoading ? <p role="status">正在读取项目…</p> : ProjectsError ? <p className="project-menu-error" role="alert">{ProjectsError}</p>
              : ProjectEntries.length ? ProjectEntries.map((Entry) => <button key={Entry.path} data-testid="project-entry" role="menuitem" aria-current={Path === Entry.path ? 'true' : undefined} className={Path === Entry.path ? 'current' : undefined} title={Entry.path} disabled={Working > 0} onClick={() => void OpenBoard(Entry.path)}><span>{Entry.name}</span>{Path === Entry.path && <span className="project-current" aria-hidden="true">●</span>}</button>)
                : <p role="status">Project 中还没有项目</p>}
          </div>
        </div>}
      </div>
      <button data-testid="save" className="save-button" aria-label={Dirty ? '保存（有未保存的修改）' : '保存'} disabled={Working > PendingSaves.current} title="保存 · Ctrl+S / 另存为 · Ctrl+Shift+S" onClick={() => void SaveBoard()}>保存{Dirty && <span className="save-dirty" aria-hidden="true">*</span>}</button>
      <button data-testid="cleanup-resources" disabled={Working > 0} title="保存当前画板，并清理资源目录中未被引用的 PNG / YAML 和配置文件" onClick={() => void CleanupResources()}>清理失效资源</button>
      <span className="filename" title={Path || undefined}>{Path?.split(/[\\/]/).pop() || '未命名画板'}</span>
      {Working > 0 && <span className="working" role="status">处理中…</span>}
    </header>
    <div ref={Canvas} data-testid="canvas" className={`canvas${SpaceHeld ? ' can-pan' : ArrowMode ? ' draw-arrow' : ''}`} tabIndex={-1}
      onPointerDown={(InputEvent) => Begin(InputEvent)} onPointerMove={Move} onPointerUp={(InputEvent) => Finish(InputEvent)} onPointerCancel={(InputEvent) => Finish(InputEvent, true)}
      onDoubleClick={DoubleClick}
      onContextMenu={(InputEvent) => InputEvent.preventDefault()} onDragOver={(InputEvent) => { InputEvent.preventDefault(); InputEvent.dataTransfer.dropEffect = 'copy' }} onDrop={(InputEvent) => void Drop(InputEvent)}>
      <div className="world" style={{ transform: `translate(${View.x}px, ${View.y}px) scale(${View.zoom})` }}>
        {Document.images.map((Item) => <img key={Item.id} data-testid="image-item" data-image-id={Item.id} data-asset-id={Item.asset} data-x={Item.x} data-y={Item.y} data-width={Item.width} data-height={Item.height}
          className={`board-image${Selected.includes(Item.id) ? ' selected' : ''}${Assets[Item.asset]?.missing ? ' missing' : ''}`} data-missing={Assets[Item.asset]?.missing || undefined}
          src={Assets[Item.asset]?.dataUrl} alt={Assets[Item.asset]?.missing ? '纹理引用丢失' : '参考图片'} title={Assets[Item.asset]?.missing ? '纹理引用丢失；请手动检查 .hbr 中对应的引用' : undefined} draggable={false}
          style={{ left: Item.x, top: Item.y, width: Item.width, height: Item.height, outlineWidth: 1 / View.zoom }} onPointerDown={(InputEvent) => Begin(InputEvent, Item.id)} />)}
        {Document.texts.map((Item) => {
          const Active = TextEdit?.id === Item.id ? TextEdit : null
          const Text = Active?.draft ?? Item.text
          return <div key={Item.id} data-testid="text-item" data-text-id={Item.id} data-x={Item.x} data-y={Item.y} data-width={Item.width} data-height={Item.height}
            className={`board-text${Selected.includes(Item.id) ? ' selected' : ''}${Active?.inline ? ' editing' : ''}`} title={Active?.inline ? undefined : '双击编辑 Markdown 源码；拖动角点调整文本框'}
            style={{ left: Item.x, top: Item.y, width: Item.width, height: Item.height, outlineWidth: 1 / View.zoom,
              ...TextAppearance(Text) }} onPointerDown={(InputEvent) => Begin(InputEvent, Item.id)}>
            {Active?.inline ? <TextInlineInput Content={Text.content} OnChange={UpdateTextContent} OnApply={() => CommitText(true)} OnCancel={CancelText}
              OnSave={(SaveAs) => { void SaveBoard(SaveAs) }} OnComposition={TextComposition} /> : <MarkdownPreview Content={Text.content} ProjectPath={Path} />}
          </div>
        })}
        {(Document.arrows ?? []).map((Item) => <ArrowView key={Item.id} Item={Item} Zoom={View.zoom} Selected={Selected.includes(Item.id)} OnPointerDown={(InputEvent) => Begin(InputEvent, Item.id)} />)}
      </div>
      <div className="canvas-tools" onPointerDown={(InputEvent) => InputEvent.stopPropagation()} onDoubleClick={(InputEvent) => InputEvent.stopPropagation()}>
        <button className="canvas-tool" data-testid="add-text" disabled={Working > 0} aria-label="创建文本" title="创建文本" onClick={() => AddText()}><TextCreateIcon /></button>
        <button className="canvas-tool" data-testid="add-arrow" disabled={Working > 0} aria-label="创建箭头" aria-pressed={ArrowMode} title="创建箭头 · 拖动绘制，Alt 暂停连接，Esc 取消" onClick={ToggleArrowMode}><span className="tool-icon arrow-create-icon" aria-hidden="true" /></button>
      </div>
      {SelectedText && <button data-testid="text-settings" className="text-settings-button" aria-label="字体设置" title="字体设置" disabled={Working > 0}
        aria-expanded={Boolean(TextEdit?.settings)} style={{ left: View.x + (SelectedText.x + SelectedText.width) * View.zoom + 10, top: View.y + (SelectedText.y + SelectedText.height) * View.zoom - SettingsSize, width: SettingsSize, height: SettingsSize }}
        onPointerDown={(InputEvent) => { InputEvent.stopPropagation(); InputEvent.preventDefault() }} onDoubleClick={(InputEvent) => InputEvent.stopPropagation()} onClick={() => OpenTextSettings(SelectedText.id)}><TextSettingsIcon /></button>}
      {TextEdit?.settings && <TextEditor Resource={TextEdit.draft} OnChange={UpdateText} OnApply={() => CommitText(true)} OnSave={(SaveAs) => { void SaveBoard(SaveAs) }} OnCancel={CancelTextSettings} OnComposition={TextComposition} />}
      {SelectedArrow && <button data-testid="arrow-settings" className="text-settings-button arrow-settings-button" aria-label="线条设置" title="线条设置" disabled={Working > 0}
        aria-expanded={ArrowEditId === SelectedArrow.id} style={{ left: View.x + (SelectedArrow.x + SelectedArrow.width / 2) * View.zoom - ArrowSettingsSize / 2, top: View.y + SelectedArrow.y * View.zoom - ArrowSettingsSize - 10, width: ArrowSettingsSize, height: ArrowSettingsSize }}
        onPointerDown={(InputEvent) => { InputEvent.stopPropagation(); InputEvent.preventDefault() }} onDoubleClick={(InputEvent) => InputEvent.stopPropagation()} onClick={() => OpenArrowSettings(SelectedArrow.id)}><span className="tool-icon arrow-settings-icon" aria-hidden="true" /></button>}
      {EditedArrow && <ArrowEditor Style={EditedArrow.arrow} OnChange={UpdateArrowStyle} OnApply={() => CommitArrow(true)} OnCancel={CancelArrow} OnSave={(SaveAs) => { void SaveBoard(SaveAs) }} />}
      {!Document.images.length && !Document.texts.length && !Document.arrows?.length && <div className="empty"><span>拖入图片，开始整理参考</span><small>Ctrl+V 粘贴截图或文字 · 点击左侧图标添加文本或箭头</small></div>}
      {Bounds && !SelectedArrow && <div data-testid="selection-box" className="selection-box" style={SelectionStyle}>
        {(['nw', 'ne', 'sw', 'se'] as ResizeCorner[]).map((Corner) => <button key={Corner} data-testid={`resize-${Corner}`} className={`resize-handle ${Corner}`} aria-label={`调整尺寸 ${Corner}`} onPointerDown={(InputEvent) => Begin(InputEvent, undefined, Corner)} />)}
      </div>}
      {!TextEdit?.inline && Working === 0 && [...Document.images, ...Document.texts].filter((Item) => Connecting || Selected.includes(Item.id)).map((Item) =>
        ConnectionHandles(Item, ConnectionHandleOffset / View.zoom).map(({ handle: Handle, binding: Binding }) => {
          const Active = ConnectionTarget?.id === Item.id && ConnectionTarget.side === Binding.side
          return <button key={`${Item.id}-${Binding.side}`} data-testid="connection-handle" data-item-id={Item.id} data-side={Binding.side} data-active={Active}
            className={`connection-handle connection-${Binding.side}${Connecting ? ' connecting' : ''}${Active ? ' active' : ''}`} aria-label={`从${{ left: '左', right: '右', top: '上', bottom: '下' }[Binding.side]}侧连接`} title="拖动创建连线"
            style={{ left: View.x + Handle.x * View.zoom, top: View.y + Handle.y * View.zoom }}
            onPointerDown={(InputEvent) => Begin(InputEvent, Item.id, undefined, Binding)} onDoubleClick={(InputEvent) => InputEvent.stopPropagation()}>
            <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3 8h10M8 3l5 5-5 5" /></svg>
          </button>
        }))}
      {SelectedArrow && ArrowControls && (['start', 'end', 'bend'] as const).map((Part) => {
        const Point = Part === 'bend' ? ArrowControls.handle : Part === 'start' ? ArrowControls.points[0] : ArrowControls.points.at(-1)!
        return <button key={Part} data-testid={`arrow-${Part}`} className={`arrow-handle arrow-handle-${Part}`} aria-label={{ start: '调整起点', end: '调整终点', bend: '调整折线' }[Part]}
          style={{ left: View.x + (SelectedArrow.x + Point.x) * View.zoom, top: View.y + (SelectedArrow.y + Point.y) * View.zoom,
            cursor: Part === 'bend' ? (SelectedArrow.arrow.axis === 'horizontal' ? 'ew-resize' : 'ns-resize') : 'crosshair' }}
          onPointerDown={(InputEvent) => BeginArrowHandle(InputEvent, SelectedArrow, `arrow-${Part}`)} onDoubleClick={(InputEvent) => InputEvent.stopPropagation()} />
      })}
      {Marquee && <div data-testid="marquee" className="marquee" style={{ left: Marquee.x, top: Marquee.y, width: Marquee.width, height: Marquee.height }} />}
      {Guides.map((Guide, Index) => <div key={Index} data-testid="snap-guide" className={`snap-guide ${Guide.axis}`} style={Guide.axis === 'x' ? { left: View.x + Guide.position * View.zoom } : { top: View.y + Guide.position * View.zoom }} />)}
    </div>
    <footer className="statusbar">
      <span data-testid="status">{Document.images.length} 张图片{Document.texts.length ? ` · ${Document.texts.length} 段文字` : ''}{Document.arrows?.length ? ` · ${Document.arrows.length} 个箭头` : ''} · 已选 {Selected.length}</span>
      <span className="hint" title="轻按空格适应选区；按住空格拖动仍可平移">滚轮缩放 · 空格适应选区 · 中键平移 · Shift 多选 · Alt 暂停吸附</span>
      <span className="message" role="status" title={Message}>{Message}</span>
      <button data-testid="zoom-out" aria-label="缩小" onClick={() => ChangeZoom(View.zoom / 1.2)}>−</button>
      <button data-testid="zoom" title="恢复 100%" onClick={() => ChangeZoom(1)}>{Math.round(View.zoom * 100)}%</button>
      <button data-testid="zoom-in" aria-label="放大" onClick={() => ChangeZoom(View.zoom * 1.2)}>＋</button>
      <button data-testid="fit" title="适应画板 · F" onClick={Fit}>适应</button>
    </footer>
  </div>
}
