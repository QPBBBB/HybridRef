import React, { useEffect as UseEffect, useRef as UseRef, useState as UseState } from 'react'
import { EmptyDocument, type BoardDocument, type BoardImage, type ImageAsset, type ImportResult, type LoadedBoard, type Viewport } from '../Shared/Types'
import { AlignImages, BoundingBox, FitViewport, Intersects, RectFromPoints, ResizeGroup, ScreenToWorld, SnapMove, ZoomAt, type Point } from './Geometry'
import { ClearImageCache, DecodeAssets } from './ImageCache'
import { IsFileDialogOpen } from './FileDialog'

type Corner = 'nw' | 'ne' | 'sw' | 'se'
type Alignment = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'
type Guide = { axis: 'x' | 'y'; position: number }
type Gesture = {
  kind: 'pan' | 'marquee' | 'move' | 'resize'
  start: Point
  viewport: Viewport
  before: BoardImage[]
  selected: string[]
  corner?: Corner
  additive?: boolean
}

const Fingerprint = (Images: readonly BoardImage[]): string => JSON.stringify(Images)
const Uuid = (): string => crypto.randomUUID()
const ClipboardType = 'application/x-hybridref-items'
const AlignmentOptions: [Alignment, string][] = [['left', '左对齐'], ['centerX', '水平居中'], ['right', '右对齐'], ['top', '顶对齐'], ['centerY', '垂直居中'], ['bottom', '底对齐']]

export default function App(): React.ReactElement {
  const [Document, SetDocument] = UseState<BoardDocument>(EmptyDocument)
  const Current = UseRef(Document)
  const [Assets, SetAssets] = UseState<Record<string, ImageAsset>>({})
  const AssetMap = UseRef<Record<string, ImageAsset>>({})
  const [Selected, SetSelected] = UseState<string[]>([])
  const Selection = UseRef<string[]>([])
  const [Path, SetPath] = UseState<string | null>(null)
  const CurrentPath = UseRef<string | null>(null)
  const SavedImages = UseRef(Fingerprint([]))
  const [Dirty, SetDirty] = UseState(false)
  const DirtyRef = UseRef(false)
  const [HistoryVersion, SetHistoryVersion] = UseState(0)
  const Past = UseRef<BoardImage[][]>([])
  const Future = UseRef<BoardImage[][]>([])
  const Canvas = UseRef<HTMLDivElement>(null)
  const FileInput = UseRef<HTMLInputElement>(null)
  const Gesture = UseRef<Gesture | null>(null)
  const [Marquee, SetMarquee] = UseState<ReturnType<typeof RectFromPoints> | null>(null)
  const [Guides, SetGuides] = UseState<Guide[]>([])
  const [SpaceHeld, SetSpaceHeld] = UseState(false)
  const Space = UseRef(false)
  const [Message, SetMessage] = UseState('')
  const [Working, SetWorking] = UseState(1)
  const WorkingRef = UseRef(1)
  const PendingSaves = UseRef(0)
  const [AlignOpen, SetAlignOpen] = UseState(false)
  const Session = UseRef(0)
  const StartupAllowed = UseRef(true)
  const InternalClipboard = UseRef<BoardImage[]>([])
  const ClipboardToken = UseRef('')
  const PasteOffset = UseRef(0)
  const SaveQueue = UseRef<Promise<unknown>>(Promise.resolve())

  function StartWork(): void { WorkingRef.current += 1; SetWorking(WorkingRef.current) }
  function EndWork(): void { WorkingRef.current -= 1; SetWorking(WorkingRef.current) }

  function Select(Ids: string[]): void { Selection.current = Ids; SetSelected(Ids) }
  function RefreshDirty(): void {
    const Next = Fingerprint(Current.current.images) !== SavedImages.current
    DirtyRef.current = Next
    SetDirty(Next)
    window.HybridRef.SetDirty(Next)
  }
  function Publish(Next: BoardDocument): void {
    Current.current = Next
    SetDocument(Next)
  }
  function Images(Next: BoardImage[], IsRecord = true): void {
    if (Fingerprint(Next) === Fingerprint(Current.current.images)) return
    if (IsRecord) { Past.current.push(Current.current.images); Future.current = []; SetHistoryVersion((Value) => Value + 1) }
    Publish({ ...Current.current, images: Next })
    RefreshDirty()
  }
  function History(Direction: 'undo' | 'redo'): void {
    if (Gesture.current) return
    const From = Direction === 'undo' ? Past : Future
    const To = Direction === 'undo' ? Future : Past
    const Next = From.current.pop()
    if (!Next) return
    To.current.push(Current.current.images)
    Publish({ ...Current.current, images: Next })
    Select(Selection.current.filter((Id) => Next.some((Item) => Item.id === Id)))
    SetHistoryVersion((Value) => Value + 1)
    RefreshDirty()
  }
  function ShowError(CaughtError: unknown): void { SetMessage(CaughtError instanceof Error ? CaughtError.message : String(CaughtError)) }
  function MayDiscard(): boolean { return !DirtyRef.current || window.confirm('当前画板尚未保存。放弃更改并继续？') }
  function Reset(Next: BoardDocument, NextPath: string | null, NextAssets: ImageAsset[]): void {
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
    Publish(Next)
    Select([])
    CurrentPath.current = NextPath; SetPath(NextPath)
    SavedImages.current = Fingerprint(Next.images)
    RefreshDirty()
    SetMessage('')
  }
  async function NewBoard(): Promise<void> {
    if (WorkingRef.current) return
    StartupAllowed.current = false
    if (!MayDiscard()) return
    const Revision = Session.current
    StartWork()
    try {
      const Loaded = await window.HybridRef.NewProject()
      if (Loaded && Session.current === Revision) Reset(Loaded.document, Loaded.path, Loaded.assets)
    }
    catch (CaughtError) { ShowError(CaughtError) }
    finally { EndWork() }
  }
  async function OpenBoard(): Promise<void> {
    if (WorkingRef.current) return
    StartupAllowed.current = false
    if (!MayDiscard()) return
    const Revision = Session.current
    StartWork()
    try {
      const Loaded = await window.HybridRef.Open()
      if (Loaded && Session.current === Revision) Reset(Loaded.document, Loaded.path, Loaded.assets)
    } catch (CaughtError) { ShowError(CaughtError) }
    finally { EndWork() }
  }
  function SaveBoard(SaveAs = false): Promise<boolean> {
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
        SavedImages.current = Fingerprint(Snapshot.images)
        RefreshDirty()
        SetMessage(DirtyRef.current ? '已保存；还有新的修改未保存' : '已保存')
        return !DirtyRef.current
      } catch (CaughtError) { ShowError(CaughtError); return false }
      finally { PendingSaves.current -= 1; EndWork() }
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
    if (Imported.length) { Images([...Current.current.images, ...Imported]); Select(Imported.map((Item) => Item.id)) }
    SetMessage(Result.errors.length ? Result.errors.join('；') : Imported.length ? `已导入 ${Imported.length} 张图片` : '')
  }
  async function ImportFiles(Files: File[], Position = Center()): Promise<void> {
    if (WorkingRef.current || !Files.length) return
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
    const Ids = new Set(Selection.current)
    Images(Current.current.images.filter((Item) => !Ids.has(Item.id)))
    Select([])
  }
  function Copy(InputEvent: ClipboardEvent, Cut = false): void {
    const SelectedImages = Current.current.images.filter((Item) => Selection.current.includes(Item.id))
    if (!SelectedImages.length || !InputEvent.clipboardData) return
    InternalClipboard.current = structuredClone(SelectedImages)
    ClipboardToken.current = `hybridref:${Uuid()}`
    PasteOffset.current = 0
    InputEvent.clipboardData.setData(ClipboardType, ClipboardToken.current)
    InputEvent.clipboardData.setData('text/plain', ClipboardToken.current)
    InputEvent.preventDefault()
    if (Cut) DeleteSelected()
  }
  function InsertCopies(Source: BoardImage[], Offset: number): void {
    const Copies = Source.filter((Item) => AssetMap.current[Item.asset]).map((Item) => ({ ...Item, id: Uuid(), x: Item.x + Offset, y: Item.y + Offset }))
    if (!Copies.length) return
    Images([...Current.current.images, ...Copies])
    Select(Copies.map((Item) => Item.id))
  }
  function Paste(InputEvent: ClipboardEvent): void {
    const Content = InputEvent.clipboardData
    if (!Content) return
    const Files = Array.from(Content.files).filter((FileValue) => FileValue.type.startsWith('image/'))
    if (Files.length) { InputEvent.preventDefault(); void ImportFiles(Files); return }
    const Token = Content.getData(ClipboardType) || Content.getData('text/plain')
    if (Token && Token === ClipboardToken.current) {
      InputEvent.preventDefault()
      if (WorkingRef.current) return
      PasteOffset.current += 24
      InsertCopies(InternalClipboard.current, PasteOffset.current)
    }
  }
  function Fit(): void { Publish({ ...Current.current, viewport: FitViewport(BoundingBox(Current.current.images), ViewportSize(), 56) }) }
  function ChangeZoom(Next: number): void {
    const Size = ViewportSize()
    Publish({ ...Current.current, viewport: ZoomAt(Current.current.viewport, { x: Size.width / 2, y: Size.height / 2 }, Next) })
  }
  function Align(Mode: Alignment): void {
    Images(AlignImages(Current.current.images, Selection.current, Mode))
    SetAlignOpen(false)
  }

  function LocalPoint(ClientX: number, ClientY: number): Point {
    const Rect = Canvas.current!.getBoundingClientRect()
    return { x: ClientX - Rect.left, y: ClientY - Rect.top }
  }
  function Begin(InputEvent: React.PointerEvent, ImageId?: string, Corner?: Corner): void {
    if (InputEvent.button !== 0 && InputEvent.button !== 1) return
    InputEvent.preventDefault()
    InputEvent.stopPropagation()
    const Start = LocalPoint(InputEvent.clientX, InputEvent.clientY)
    Canvas.current!.setPointerCapture(InputEvent.pointerId)
    const Base = { start: Start, viewport: Current.current.viewport, before: Current.current.images, selected: [...Selection.current] }
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
    let Changed: BoardImage[]
    if (Active.kind === 'resize') Changed = ResizeGroup(SelectedImages, Active.corner!, ScreenToWorld(Point, Active.viewport), 4 / Active.viewport.zoom)
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
    Images(Active.before.map((Item) => ById.get(Item.id) ?? Item), false)
  }
  function Finish(InputEvent?: React.PointerEvent, Cancel = false): void {
    const Active = Gesture.current
    if (!Active) return
    if (Active.kind === 'move' || Active.kind === 'resize') {
      if (Cancel) Images(Active.before, false)
      else if (Fingerprint(Active.before) !== Fingerprint(Current.current.images)) {
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
      if (Loaded && StartupAllowed.current && Session.current === Revision) Reset(Loaded.document, Loaded.path, Loaded.assets)
    }).catch(ShowError).finally(EndWork)
  }, [])
  UseEffect(() => {
    window.document.title = `${Dirty ? '* ' : ''}${Path?.split(/[\\/]/).pop() || '未命名'} — HybridRef`
  }, [Path, Dirty])
  UseEffect(() => {
    const Element = Canvas.current!
    const Wheel = (InputEvent: WheelEvent) => {
      InputEvent.preventDefault()
      const Point = LocalPoint(InputEvent.clientX, InputEvent.clientY)
      const Scale = Math.exp(-InputEvent.deltaY * (InputEvent.deltaMode === 1 ? 0.025 : 0.0015))
      Publish({ ...Current.current, viewport: ZoomAt(Current.current.viewport, Point, Current.current.viewport.zoom * Scale) })
    }
    Element.addEventListener('wheel', Wheel, { passive: false })
    return () => Element.removeEventListener('wheel', Wheel)
  }, [])
  UseEffect(() => {
    const EditingText = (Target: EventTarget | null): boolean => IsFileDialogOpen() || Target instanceof HTMLInputElement || Target instanceof HTMLTextAreaElement || Boolean((Target as HTMLElement)?.isContentEditable)
    const Down = (InputEvent: KeyboardEvent) => {
      if (EditingText(InputEvent.target)) return
      const Modifier = InputEvent.ctrlKey || InputEvent.metaKey
      const Key = InputEvent.key.toLowerCase()
      if (InputEvent.code === 'Space') { InputEvent.preventDefault(); Space.current = true; SetSpaceHeld(true); return }
      if (Key === 'escape') { Finish(undefined, true); Select([]); SetAlignOpen(false); return }
      const Action = Modifier ? ({
        a: () => Select(Current.current.images.map((Item) => Item.id)),
        d: () => InsertCopies(Current.current.images.filter((Item) => Selection.current.includes(Item.id)), 24),
        z: () => History(InputEvent.shiftKey ? 'redo' : 'undo'), y: () => History('redo'),
        s: () => { void SaveBoard(InputEvent.shiftKey) }, o: () => { void OpenBoard() },
      } as Record<string, (() => void)>)[Key] : ({
        delete: DeleteSelected, backspace: DeleteSelected, f: Fit,
        '+': () => ChangeZoom(Current.current.viewport.zoom * 1.2), '=': () => ChangeZoom(Current.current.viewport.zoom * 1.2), '-': () => ChangeZoom(Current.current.viewport.zoom / 1.2),
      } as Record<string, (() => void)>)[Key]
      if (Action) { InputEvent.preventDefault(); Action() }
    }
    const Up = (InputEvent: KeyboardEvent) => { if (InputEvent.code === 'Space') { Space.current = false; SetSpaceHeld(false) } }
    const Blur = () => { Space.current = false; SetSpaceHeld(false); Finish(undefined, true) }
    const Copied = (InputEvent: ClipboardEvent) => { if (!EditingText(InputEvent.target)) Copy(InputEvent) }
    const Cut = (InputEvent: ClipboardEvent) => { if (!EditingText(InputEvent.target)) Copy(InputEvent, true) }
    const Pasted = (InputEvent: ClipboardEvent) => { if (!EditingText(InputEvent.target)) Paste(InputEvent) }
    window.addEventListener('keydown', Down); window.addEventListener('keyup', Up); window.addEventListener('blur', Blur)
    window.addEventListener('copy', Copied); window.addEventListener('cut', Cut); window.addEventListener('paste', Pasted)
    return () => {
      window.removeEventListener('keydown', Down); window.removeEventListener('keyup', Up); window.removeEventListener('blur', Blur)
      window.removeEventListener('copy', Copied); window.removeEventListener('cut', Cut); window.removeEventListener('paste', Pasted)
    }
  })

  const Bounds = BoundingBox(Document.images.filter((Item) => Selected.includes(Item.id)))
  const View = Document.viewport
  const SelectionStyle = Bounds ? { left: View.x + Bounds.x * View.zoom, top: View.y + Bounds.y * View.zoom, width: Bounds.width * View.zoom, height: Bounds.height * View.zoom } : undefined
  return <div className="app" data-history-version={HistoryVersion}>
    <input ref={FileInput} data-testid="file-input" type="file" hidden multiple accept="image/*,.tif,.tiff,.avif,.heic,.heif" disabled={Working > 0} onChange={(InputEvent) => { const Files = Array.from(InputEvent.target.files || []); InputEvent.target.value = ''; void ImportFiles(Files) }} />
    <header className="toolbar">
      <span className="brand">HybridRef</span>
      <button data-testid="new" disabled={Working > 0} title="新建画板" onClick={() => void NewBoard()}>新建</button>
      <button data-testid="open" disabled={Working > 0} title="打开 · Ctrl+O" onClick={() => void OpenBoard()}>打开</button>
      <button data-testid="save" disabled={Working > PendingSaves.current} title="保存 · Ctrl+S / 另存为 · Ctrl+Shift+S" onClick={() => void SaveBoard()}>保存{Dirty ? ' ·' : ''}</button>
      <button data-testid="import" disabled={Working > 0} title="导入图片，也可以拖入或粘贴截图" onClick={() => FileInput.current?.click()}>导入图片</button>
      <span className="divider" />
      <button data-testid="undo" title="撤销 · Ctrl+Z" disabled={!Past.current.length} onClick={() => History('undo')}>↶</button>
      <button data-testid="redo" title="重做 · Ctrl+Shift+Z / Ctrl+Y" disabled={!Future.current.length} onClick={() => History('redo')}>↷</button>
      <div className="align-control">
        <button data-testid="align-menu" disabled={Selected.length < 2} aria-expanded={AlignOpen} onClick={() => SetAlignOpen(!AlignOpen)}>对齐 ▾</button>
        {AlignOpen && Selected.length > 1 && <div className="align-menu">{AlignmentOptions.map(([Mode, Label]) => <button key={Mode} data-testid={`align-${Mode}`} onClick={() => Align(Mode)}>{Label}</button>)}</div>}
      </div>
      <span className="filename" title={Path || undefined}>{Path?.split(/[\\/]/).pop() || '未命名画板'}</span>
      {Working > 0 && <span className="working" role="status">处理中…</span>}
    </header>
    <div ref={Canvas} data-testid="canvas" className={`canvas${SpaceHeld ? ' can-pan' : ''}`} tabIndex={-1}
      onPointerDown={(InputEvent) => Begin(InputEvent)} onPointerMove={Move} onPointerUp={(InputEvent) => Finish(InputEvent)} onPointerCancel={(InputEvent) => Finish(InputEvent, true)}
      onContextMenu={(InputEvent) => InputEvent.preventDefault()} onDragOver={(InputEvent) => { InputEvent.preventDefault(); InputEvent.dataTransfer.dropEffect = 'copy' }} onDrop={(InputEvent) => void Drop(InputEvent)}>
      <div className="world" style={{ transform: `translate(${View.x}px, ${View.y}px) scale(${View.zoom})` }}>
        {Document.images.map((Item) => <img key={Item.id} data-testid="image-item" data-image-id={Item.id} data-asset-id={Item.asset} data-x={Item.x} data-y={Item.y} data-width={Item.width} data-height={Item.height}
          className={Selected.includes(Item.id) ? 'board-image selected' : 'board-image'} src={Assets[Item.asset]?.dataUrl} alt="参考图片" draggable={false}
          style={{ left: Item.x, top: Item.y, width: Item.width, height: Item.height, outlineWidth: 1 / View.zoom }} onPointerDown={(InputEvent) => Begin(InputEvent, Item.id)} />)}
      </div>
      {!Document.images.length && <div className="empty"><span>拖入图片，开始整理参考</span><small>或使用 Ctrl+V 粘贴截图</small></div>}
      {Bounds && <div data-testid="selection-box" className="selection-box" style={SelectionStyle}>
        {(['nw', 'ne', 'sw', 'se'] as Corner[]).map((Corner) => <button key={Corner} data-testid={`resize-${Corner}`} className={`resize-handle ${Corner}`} aria-label={`等比缩放 ${Corner}`} onPointerDown={(InputEvent) => Begin(InputEvent, undefined, Corner)} />)}
      </div>}
      {Marquee && <div data-testid="marquee" className="marquee" style={{ left: Marquee.x, top: Marquee.y, width: Marquee.width, height: Marquee.height }} />}
      {Guides.map((Guide, Index) => <div key={Index} data-testid="snap-guide" className={`snap-guide ${Guide.axis}`} style={Guide.axis === 'x' ? { left: View.x + Guide.position * View.zoom } : { top: View.y + Guide.position * View.zoom }} />)}
    </div>
    <footer className="statusbar">
      <span data-testid="status">{Document.images.length} 张图片 · 已选 {Selected.length}</span>
      <span className="hint">滚轮缩放 · 中键 / 空格平移 · Shift 多选 · Alt 暂停吸附</span>
      <span className="message" role="status" title={Message}>{Message}</span>
      <button data-testid="zoom-out" aria-label="缩小" onClick={() => ChangeZoom(View.zoom / 1.2)}>−</button>
      <button data-testid="zoom" title="恢复 100%" onClick={() => ChangeZoom(1)}>{Math.round(View.zoom * 100)}%</button>
      <button data-testid="zoom-in" aria-label="放大" onClick={() => ChangeZoom(View.zoom * 1.2)}>＋</button>
      <button data-testid="fit" title="适应画板 · F" onClick={Fit}>适应</button>
    </footer>
  </div>
}
