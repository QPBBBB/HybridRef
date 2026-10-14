import React, { useEffect as UseEffect, useRef as UseRef, useState as UseState } from 'react'
import { EmptyDocument, EmptyTextResource, TextFontFamily, type BoardDocument, type BoardImage, type BoardText, type TextResource, type ImageAsset, type ImportResult, type LoadedBoard, type ProjectEntry, type Viewport } from '../Shared/Types'
import {
  BoundingBox, CenterImages, FitViewport, Intersects, NormalizeImages, PushImages,
  RectFromPoints, ResizeGroup, ResizeTextFrame, ScreenToWorld, SnapMove, ZoomAt,
  type CenterMode, type NormalizeMode, type Point, type PushDirection, type ResizeCorner, type SnapGuide,
} from './Geometry'
import { ClearImageCache, DecodeAssets } from './ImageCache'
import { IsFileDialogOpen } from './FileDialog'
import { TextEditor } from './TextEditor'
import { TextAppearance } from './TextAppearance'
import { CreateSelectionSnapshot } from './SelectionSnapshot'
import { TextInlineInput } from './TextInlineInput'
import { TextCreateIcon, TextSettingsIcon } from './TextCreateIcon'

type BoardItem = BoardImage | BoardText
const BoardItems = (Document: BoardDocument): BoardItem[] => [...Document.images, ...Document.texts]

type TextEditSession = {
  id: string
  before: BoardItem[]
  draft: TextResource
  inline: boolean
  settings: boolean
  settingsBefore?: TextResource
}

type Gesture = {
  kind: 'pan' | 'marquee' | 'move' | 'resize'
  start: Point
  viewport: Viewport
  before: BoardItem[]
  selected: string[]
  corner?: ResizeCorner
  additive?: boolean
}

const Fingerprint = (Images: readonly BoardItem[]): string => JSON.stringify(Images)
const Uuid = (): string => crypto.randomUUID()
const ClipboardType = 'application/x-hybridref-items'
const PushShortcuts: Partial<Record<string, PushDirection>> = { r: 'right', t: 'top', b: 'bottom' }
const DirectionalPushShortcuts: Partial<Record<string, PushDirection>> = { arrowleft: 'left', arrowright: 'right', arrowup: 'top', arrowdown: 'bottom' }
const CenterShortcuts: Partial<Record<string, CenterMode>> = { h: 'horizontal', v: 'vertical' }
const NormalizeShortcuts: Partial<Record<string, NormalizeMode>> = { arrowright: 'width', arrowleft: 'height' }

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
    Publish({ ...Current.current, images: Next.filter((Item): Item is BoardImage => !('text' in Item)), texts: Next.filter((Item): Item is BoardText => 'text' in Item) })
  }
  function Items(Next: BoardItem[], IsRecord = true): void {
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
    const FixedFont = { ...Next, texts: Next.texts.map((Item) => ({ ...Item, text: { ...Item.text, font: { ...Item.text.font, family: TextFontFamily } } })) }
    TextEditing.current = null; SetTextEdit(null)
    TextComposing.current = false; AfterComposition.current = []
    Session.current += 1
    ClearImageCache()
    AssetMap.current = Object.fromEntries(NextAssets.map((Asset) => [Asset.id, Asset]))
    SetAssets(AssetMap.current)
    void DecodeAssets(NextAssets).catch(ShowError)
    Gesture.current = null
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
  function CancelTextSettings(): void {
    const Active = TextEditing.current
    if (!Active) return
    if (!Active.inline) { CancelText(); return }
    PublishTextEdit({ ...Active, settings: false, settingsBefore: undefined, draft: { ...structuredClone(Active.settingsBefore ?? Active.draft), content: Active.draft.content } })
    Canvas.current?.querySelector<HTMLTextAreaElement>('.text-inline-input')?.focus()
  }
  function DoubleClick(InputEvent: React.MouseEvent): void {
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
    Items(BoardItems(Current.current).filter((Item) => !Ids.has(Item.id)))
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
      const Png = CreateSelectionSnapshot(SelectedItems, AssetMap.current, getComputedStyle(Canvas.current!).backgroundColor)
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
    const Copies = Source.filter((Item) => 'text' in Item || AssetMap.current[Item.asset]).map((Item) => ({ ...structuredClone(Item), id: Uuid(), x: Item.x + Offset, y: Item.y + Offset }))
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
    Items(Next)
    return true
  }

  function LocalPoint(ClientX: number, ClientY: number): Point {
    const Rect = Canvas.current!.getBoundingClientRect()
    return { x: ClientX - Rect.left, y: ClientY - Rect.top }
  }
  function Begin(InputEvent: React.PointerEvent, ImageId?: string, Corner?: ResizeCorner): void {
    if (WorkingRef.current || !CommitText()) return
    if (InputEvent.button !== 0 && InputEvent.button !== 1) return
    InputEvent.preventDefault()
    InputEvent.stopPropagation()
    const Start = LocalPoint(InputEvent.clientX, InputEvent.clientY)
    Canvas.current!.setPointerCapture(InputEvent.pointerId)
    const Base = { start: Start, viewport: Current.current.viewport, before: BoardItems(Current.current), selected: [...Selection.current] }
    if (InputEvent.button === 1 || Space.current) { Gesture.current = { ...Base, kind: 'pan' }; return }
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
  function Move(InputEvent: React.PointerEvent): void {
    const Active = Gesture.current
    if (!Active) return
    const Point = LocalPoint(InputEvent.clientX, InputEvent.clientY)
    const Delta = { x: Point.x - Active.start.x, y: Point.y - Active.start.y }
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
    Items(Active.before.map((Item) => ById.get(Item.id) ?? Item), false)
  }
  function Finish(InputEvent?: React.PointerEvent, Cancel = false): void {
    const Active = Gesture.current
    if (!Active) return
    if (Active.kind === 'move' || Active.kind === 'resize') {
      if (Cancel) Items(Active.before, false)
      else if (Fingerprint(Active.before) !== Fingerprint(BoardItems(Current.current))) {
        Past.current.push(Active.before); Future.current = []; SetHistoryVersion((Value) => Value + 1)
      }
    }
    Gesture.current = null
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
      if (!TextEditing.current || !(InputEvent.target instanceof HTMLElement)) return
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
      if (EditingText(InputEvent.target)) return
      const Modifier = InputEvent.ctrlKey || InputEvent.metaKey
      const Key = InputEvent.key.toLowerCase()
      if (TextEditing.current) {
        if (Modifier && Key === 's') { InputEvent.preventDefault(); void SaveBoard(InputEvent.shiftKey) }
        else if (Modifier && Key === 'enter') { InputEvent.preventDefault(); CommitText(true) }
        else if (Key === 'escape') { InputEvent.preventDefault(); CancelText() }
        return
      }
      if (ProjectMenuOpen) {
        if (Key === 'escape' || (Modifier && Key === 'o')) { InputEvent.preventDefault(); CloseProjectMenu(true) }
        return
      }
      if (InputEvent.code === 'Space') { InputEvent.preventDefault(); Space.current = true; SetSpaceHeld(true); return }
      if (Key === 'escape') { Finish(undefined, true); Select([]); return }
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
    const Up = (InputEvent: KeyboardEvent) => { if (InputEvent.code === 'Space') { Space.current = false; SetSpaceHeld(false) } }
    const Blur = () => { Space.current = false; SetSpaceHeld(false); Finish(undefined, true) }
    const Copied = (InputEvent: ClipboardEvent) => { if (!TextEditing.current?.inline && !ProjectMenuOpen && !EditingText(InputEvent.target)) Copy(InputEvent) }
    const Cut = (InputEvent: ClipboardEvent) => { if (!TextEditing.current && !ProjectMenuOpen && !EditingText(InputEvent.target)) Copy(InputEvent, true) }
    const Pasted = (InputEvent: ClipboardEvent) => { if (!TextEditing.current && !ProjectMenuOpen && !EditingText(InputEvent.target)) Paste(InputEvent) }
    window.addEventListener('keydown', Down); window.addEventListener('keyup', Up); window.addEventListener('blur', Blur)
    window.addEventListener('copy', Copied); window.addEventListener('cut', Cut); window.addEventListener('paste', Pasted)
    return () => {
      window.removeEventListener('keydown', Down); window.removeEventListener('keyup', Up); window.removeEventListener('blur', Blur)
      window.removeEventListener('copy', Copied); window.removeEventListener('cut', Cut); window.removeEventListener('paste', Pasted)
    }
  })

  const Bounds = BoundingBox(BoardItems(Document).filter((Item) => Selected.includes(Item.id)))
  const SelectedText = Selected.length === 1 ? Document.texts.find((Item) => Item.id === Selected[0]) : undefined
  const View = Document.viewport
  const SettingsSize = SelectedText ? Math.min(64, Math.max(20, Math.min(SelectedText.width, SelectedText.height) * View.zoom * 0.32)) : 0
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
      <button data-testid="cleanup-resources" disabled={Working > 0} title="保存当前画板，并清理资源目录中未被引用的 PNG / YAML 文件" onClick={() => void CleanupResources()}>清理失效资源</button>
      <span className="filename" title={Path || undefined}>{Path?.split(/[\\/]/).pop() || '未命名画板'}</span>
      {Working > 0 && <span className="working" role="status">处理中…</span>}
    </header>
    <div ref={Canvas} data-testid="canvas" className={`canvas${SpaceHeld ? ' can-pan' : ''}`} tabIndex={-1}
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
            className={`board-text${Selected.includes(Item.id) ? ' selected' : ''}${Active?.inline ? ' editing' : ''}`} title={Active?.inline ? undefined : '双击直接编辑文字；拖动角点调整文本框'}
            style={{ left: Item.x, top: Item.y, width: Item.width, height: Item.height, outlineWidth: 1 / View.zoom,
              ...TextAppearance(Text) }} onPointerDown={(InputEvent) => Begin(InputEvent, Item.id)}>
            {Active?.inline ? <TextInlineInput Content={Text.content} OnChange={UpdateTextContent} OnApply={() => CommitText(true)} OnCancel={CancelText}
              OnSave={(SaveAs) => { void SaveBoard(SaveAs) }} OnComposition={TextComposition} /> : Text.content}
          </div>
        })}
      </div>
      <div className="canvas-tools" onPointerDown={(InputEvent) => InputEvent.stopPropagation()} onDoubleClick={(InputEvent) => InputEvent.stopPropagation()}>
        <button className="canvas-tool" data-testid="add-text" disabled={Working > 0} aria-label="创建文本" title="创建文本" onClick={() => AddText()}><TextCreateIcon /></button>
      </div>
      {SelectedText && <button data-testid="text-settings" className="text-settings-button" aria-label="字体设置" title="字体设置" disabled={Working > 0}
        aria-expanded={Boolean(TextEdit?.settings)} style={{ left: View.x + (SelectedText.x + SelectedText.width) * View.zoom + 10, top: View.y + (SelectedText.y + SelectedText.height) * View.zoom - SettingsSize, width: SettingsSize, height: SettingsSize }}
        onPointerDown={(InputEvent) => { InputEvent.stopPropagation(); InputEvent.preventDefault() }} onDoubleClick={(InputEvent) => InputEvent.stopPropagation()} onClick={() => OpenTextSettings(SelectedText.id)}><TextSettingsIcon /></button>}
      {TextEdit?.settings && <TextEditor Resource={TextEdit.draft} OnChange={UpdateText} OnApply={() => CommitText(true)} OnSave={(SaveAs) => { void SaveBoard(SaveAs) }} OnCancel={CancelTextSettings} OnComposition={TextComposition} />}
      {!Document.images.length && !Document.texts.length && <div className="empty"><span>拖入图片，开始整理参考</span><small>Ctrl+V 粘贴截图或文字 · 点击左侧图标添加文本</small></div>}
      {Bounds && <div data-testid="selection-box" className="selection-box" style={SelectionStyle}>
        {(['nw', 'ne', 'sw', 'se'] as ResizeCorner[]).map((Corner) => <button key={Corner} data-testid={`resize-${Corner}`} className={`resize-handle ${Corner}`} aria-label={`调整尺寸 ${Corner}`} onPointerDown={(InputEvent) => Begin(InputEvent, undefined, Corner)} />)}
      </div>}
      {Marquee && <div data-testid="marquee" className="marquee" style={{ left: Marquee.x, top: Marquee.y, width: Marquee.width, height: Marquee.height }} />}
      {Guides.map((Guide, Index) => <div key={Index} data-testid="snap-guide" className={`snap-guide ${Guide.axis}`} style={Guide.axis === 'x' ? { left: View.x + Guide.position * View.zoom } : { top: View.y + Guide.position * View.zoom }} />)}
    </div>
    <footer className="statusbar">
      <span data-testid="status">{Document.images.length} 张图片{Document.texts.length ? ` · ${Document.texts.length} 段文字` : ''} · 已选 {Selected.length}</span>
      <span className="hint">滚轮缩放 · 中键 / 空格平移 · Shift 多选 · Alt 暂停吸附</span>
      <span className="message" role="status" title={Message}>{Message}</span>
      <button data-testid="zoom-out" aria-label="缩小" onClick={() => ChangeZoom(View.zoom / 1.2)}>−</button>
      <button data-testid="zoom" title="恢复 100%" onClick={() => ChangeZoom(1)}>{Math.round(View.zoom * 100)}%</button>
      <button data-testid="zoom-in" aria-label="放大" onClick={() => ChangeZoom(View.zoom * 1.2)}>＋</button>
      <button data-testid="fit" title="适应画板 · F" onClick={Fit}>适应</button>
    </footer>
  </div>
}
