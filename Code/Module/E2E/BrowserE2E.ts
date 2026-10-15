import { test as Test, expect as Expect, type Page } from '@playwright/test'
import { spawn as Spawn, type ChildProcess } from 'node:child_process'
import { createHash as CreateHash } from 'node:crypto'
import { cp as Cp, mkdir as Mkdir, mkdtemp as Mkdtemp, readFile as ReadFile, readdir as Readdir, rm as Rm, stat as Stat, writeFile as WriteFile } from 'node:fs/promises'
import { basename as Basename, dirname as Dirname, join as Join, resolve as Resolve } from 'node:path'
import { tmpdir as Tmpdir } from 'node:os'
import Sharp from 'sharp'
import { parse as Parse, stringify as Stringify } from 'yaml'
import { EmptyDocument, EmptyTextResource, type BoardArrow, type BoardImage } from '../Source/Shared/Types'

type ImageLayout = Pick<BoardImage, 'x' | 'y' | 'width' | 'height'>

const ModuleRoot = Resolve(__dirname, '..')
let Service: ChildProcess
let ServiceUrl: string
let Fixture: string
let ProjectDirectory: string
let Sources: string[]

Test.beforeAll(async () => {
  Fixture = await Mkdtemp(Join(Tmpdir(), 'hybridref-browser-'))
  ProjectDirectory = Join(Fixture, 'Project')
  await Mkdir(ProjectDirectory)
  // Use a private fixture: the repository Demo is an editable user project.
  const DemoDirectory = Join(ProjectDirectory, 'Demo')
  await Mkdir(Join(DemoDirectory, 'DemoResource'), { recursive: true })
  const Document = EmptyDocument()
  Document.viewport = { x: 90, y: 180, zoom: 1 }
  for (let Index = 0; Index < 3; Index++) {
    const Width = 240 + Index * 40, Height = 180 + Index * 40
    const Bytes = await Sharp({ create: { width: Width, height: Height, channels: 3, background: ['#497988', '#98617a', '#70956b'][Index] } }).png().toBuffer()
    const HashPrefix = CreateHash('sha256').update(Bytes).digest('hex').slice(0, 8).toUpperCase()
    const TimestampHash = CreateHash('sha256').update(String(1700000000000 + Index)).digest('hex').slice(0, 16).toUpperCase()
    const Filename = `Texture_${TimestampHash}_${HashPrefix}.png`
    await WriteFile(Join(DemoDirectory, 'DemoResource', Filename), Bytes)
    Document.images.push({ id: `reference-${Index + 1}`, asset: `DemoResource/${Filename}`, x: Index * 380, y: Index === 1 ? 100 : 0, width: 350, height: 350 * Height / Width })
  }
  // Keep the fixture on v2 to exercise existing image-only projects after the text upgrade.
  await WriteFile(Join(DemoDirectory, 'Demo.hbr'), Stringify({ format: Document.format, formatVersion: 2, viewport: Document.viewport, images: Document.images }))
  const SourceDirectory = Join(Fixture, '参考 # 100%')
  await Mkdir(SourceDirectory)
  Sources = ['海.jpg', '山.webp', '光.png'].map(Name => Join(SourceDirectory, Name))
  for (let Index = 0; Index < Sources.length; Index++) {
    await Sharp({ create: { width: 300 + 80 * Index, height: 200 + 50 * Index, channels: 3, background: ['#497988', '#98617a', '#70956b'][Index] } }).toFile(Sources[Index])
  }
  const Runtime = Join(Fixture, 'Server.json')
  Service = Spawn(process.execPath, [Join(ModuleRoot, 'Output/Server/Index.cjs'), '--port', '0', '--runtime', Runtime, '--project-directory', ProjectDirectory], { cwd: Fixture, stdio: 'ignore', windowsHide: true })
  await Expect.poll(async () => {
    try { ServiceUrl = JSON.parse(await ReadFile(Runtime, 'utf8')).url; return (await fetch(`${ServiceUrl}/api/health`)).ok } catch { return false }
  }).toBe(true)
})
Test.afterAll(async () => {
  if (Service && Service.exitCode === null && Service.signalCode === null) {
    const Stopped = new Promise<void>((Done, Fail) => {
      const Timeout = setTimeout(() => Fail(new Error('Test server did not stop; its fixture has been preserved.')), 5000)
      Service.once('exit', () => { clearTimeout(Timeout); Done() })
    })
    Service.kill()
    await Stopped
  }
  if (Fixture) {
    const Root = Resolve(Fixture)
    if (Dirname(Root) !== Resolve(Tmpdir()) || !Basename(Root).startsWith('hybridref-browser-')) throw new Error('Unsafe browser fixture cleanup path')
    await Rm(Root, { recursive: true, force: true })
  }
})

async function ChoosePath(Page: Page, Path: string): Promise<void> {
  await Expect(Page.getByTestId('file-dialog')).toBeVisible()
  await Expect(Page.getByTestId('file-confirm')).toBeEnabled()
  await Page.getByTestId('file-path').fill(Path)
  await Page.getByTestId('file-confirm').click()
}

async function ChooseProjectName(Page: Page, Name: string): Promise<void> {
  await Expect(Page.getByTestId('file-dialog')).toBeVisible()
  await Expect(Page.getByTestId('file-path')).toHaveCount(0)
  await Page.getByTestId('file-name').fill(Name)
  await Page.getByTestId('file-confirm').click()
}

async function StartNewProject(Page: Page): Promise<void> {
  await Page.getByTestId('open').click()
  await Expect(Page.getByTestId('project-menu')).toBeVisible()
  await Expect(Page.getByTestId('project-menu').locator('button').first()).toHaveAttribute('data-testid', 'new')
  await Page.getByTestId('new').click()
}

async function OpenProject(Page: Page, Name: string): Promise<void> {
  await Page.getByTestId('open').click()
  await Page.getByTestId('project-entry').filter({ hasText: Name }).click()
}

async function DropImages(Page: Page, Sources: string[]): Promise<void> {
  const Files = await Promise.all(Sources.map(async Path => ({ name: Basename(Path), data: (await ReadFile(Path)).toString('base64') })))
  await Page.getByTestId('canvas').evaluate((Canvas, Files) => {
    const Data = new DataTransfer()
    for (const FileValue of Files) Data.items.add(new File([Uint8Array.from(atob(FileValue.data), Char => Char.charCodeAt(0))], FileValue.name, { type: 'image/png' }))
    Canvas.dispatchEvent(new DragEvent('drop', { dataTransfer: Data, bubbles: true, cancelable: true, clientX: 680, clientY: 430 }))
  }, Files)
}

async function OpenImportedBoard(Page: Page): Promise<void> {
  await Page.goto(ServiceUrl)
  await Expect(Page.getByTestId('canvas')).toBeVisible()
  await Expect(Page.getByTestId('open')).toBeEnabled()
  await DropImages(Page, Sources)
  const Images = Page.getByTestId('image-item')
  await Expect(Images).toHaveCount(3)
  await Expect.poll(() => Images.evaluateAll(Nodes => Nodes.every(Node => (Node as HTMLImageElement).complete && (Node as HTMLImageElement).naturalWidth > 0))).toBe(true)
}

async function ReadImageLayout(Page: Page): Promise<ImageLayout[]> {
  return Page.getByTestId('image-item').evaluateAll(Nodes => Nodes.map(Node => ({
    x: Number(Node.getAttribute('data-x')), y: Number(Node.getAttribute('data-y')),
    width: Number(Node.getAttribute('data-width')), height: Number(Node.getAttribute('data-height')),
  })))
}

interface CapturedClipboard { png: string; types: readonly string[]; inGesture: boolean; calls: number }
interface ClipboardTestWindow { CapturedClipboard: CapturedClipboard; RejectClipboard: boolean }

async function CaptureClipboard(Page: Page): Promise<void> {
  // Exercise the actual keyboard, ClipboardItem and PNG encoder without replacing the user's clipboard.
  await Page.evaluate(() => {
    const TestWindow = window as unknown as ClipboardTestWindow
    TestWindow.CapturedClipboard = { png: '', types: [], inGesture: false, calls: 0 }
    TestWindow.RejectClipboard = false
    Object.defineProperty(navigator.clipboard, 'write', { configurable: true, value: async (Items: ClipboardItem[]) => {
      if (TestWindow.RejectClipboard) throw new DOMException('Clipboard access denied', 'NotAllowedError')
      const InGesture = navigator.userActivation.isActive
      const Png = await Items[0].getType('image/png')
      const Base64 = await new Promise<string>((Resolve, Reject) => {
        const Reader = new FileReader()
        Reader.onload = () => Resolve(String(Reader.result).split(',')[1])
        Reader.onerror = () => Reject(Reader.error)
        Reader.readAsDataURL(Png)
      })
      TestWindow.CapturedClipboard = { png: Base64, types: Items[0].types, inGesture: InGesture, calls: TestWindow.CapturedClipboard.calls + 1 }
    } })
  })
}

async function CopySnapshot(Page: Page): Promise<CapturedClipboard> {
  const PreviousCalls = await Page.evaluate(() => (window as unknown as ClipboardTestWindow).CapturedClipboard.calls)
  await Page.keyboard.press('Control+c')
  await Expect(Page.locator('.message')).toHaveText('已复制选中元素的 PNG 快照')
  const Captured = await Page.evaluate(() => (window as unknown as ClipboardTestWindow).CapturedClipboard)
  Expect(Captured.calls).toBe(PreviousCalls + 1)
  Expect(Captured.types).toEqual(['image/png'])
  Expect(Captured.inGesture).toBe(true)
  return Captured
}

async function PasteSnapshot(Page: Page): Promise<void> {
  await Page.evaluate(() => {
    const Captured = (window as unknown as ClipboardTestWindow).CapturedClipboard
    const Data = new DataTransfer()
    Data.items.add(new File([Uint8Array.from(atob(Captured.png), Char => Char.charCodeAt(0))], 'Snapshot.png', { type: 'image/png' }))
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: Data, bubbles: true, cancelable: true }))
  })
}

async function CheckShortcutHistory(Page: Page, Shortcut: string, Before: ImageLayout[], After: ImageLayout[]): Promise<void> {
  // An already-applied operation must neither move images nor add an undo step.
  await Page.keyboard.press(Shortcut)
  Expect(await ReadImageLayout(Page)).toEqual(After)
  await Page.keyboard.press('Control+z')
  Expect(await ReadImageLayout(Page)).toEqual(Before)
  await Page.keyboard.press('Control+Shift+z')
  Expect(await ReadImageLayout(Page)).toEqual(After)
  await Page.keyboard.press('Control+z')
  Expect(await ReadImageLayout(Page)).toEqual(Before)
}

function ExpectDirectionalPush(Before: ImageLayout[], Packed: ImageLayout[], Axis: 'x' | 'y', Factor: 0 | 1): void {
  const Dimension = Axis === 'x' ? 'width' : 'height'
  const OtherAxis = Axis === 'x' ? 'y' : 'x'
  const OtherDimension = Axis === 'x' ? 'height' : 'width'
  const Edges = Before.map(Image => Image[Axis] + Factor * Image[Dimension])
  const Edge = Factor === 0 ? Math.min(...Edges) : Math.max(...Edges)
  Packed.forEach((Image, Index) => {
    Expect(Image[OtherAxis]).toBe(Before[Index][OtherAxis])
    Expect([Image.width, Image.height]).toEqual([Before[Index].width, Before[Index].height])
    const LeadingEdge = Image[Axis] + Factor * Image[Dimension]
    const TouchesBoundary = Math.abs(LeadingEdge - Edge) < 1e-6
    const TouchesImage = Packed.some((Other, OtherIndex) => OtherIndex !== Index
      && Image[OtherAxis] < Other[OtherAxis] + Other[OtherDimension]
      && Image[OtherAxis] + Image[OtherDimension] > Other[OtherAxis]
      && Math.abs(LeadingEdge - (Other[Axis] + (1 - Factor) * Other[Dimension])) < 1e-6)
    Expect(TouchesBoundary || TouchesImage).toBe(true)
    for (const Other of Packed.slice(Index + 1)) {
      const OverlapX = Math.min(Image.x + Image.width, Other.x + Other.width) - Math.max(Image.x, Other.x)
      const OverlapY = Math.min(Image.y + Image.height, Other.y + Other.height) - Math.max(Image.y, Other.y)
      Expect(OverlapX > 1e-6 && OverlapY > 1e-6).toBe(false)
    }
  })
}

Test('canvas supports dragging, proportional resize, zoom, pan and snapping', async ({ page: Page }) => {
  const Errors: string[] = []
  Page.on('pageerror', CaughtError => Errors.push(CaughtError.message))
  await OpenImportedBoard(Page)
  for (const Id of ['import', 'file-input', 'undo', 'redo', 'align-menu']) await Expect(Page.getByTestId(Id)).toHaveCount(0)
  const Images = Page.getByTestId('image-item')
  await Page.keyboard.press('Control+a')
  await Expect(Page.getByTestId('status')).toContainText('已选 3')
  const BeforeDrag = await ReadImageLayout(Page)
  const First = (await Images.first().boundingBox())!
  await Page.mouse.move(First.x + First.width / 2, First.y + First.height / 2)
  await Page.mouse.down()
  await Page.mouse.move(First.x + First.width / 2 + 75, First.y + First.height / 2 + 35, { steps: 8 })
  await Page.mouse.up()
  Expect((await ReadImageLayout(Page))[0].x).not.toBe(BeforeDrag[0].x)
  await Page.keyboard.press('Control+ArrowLeft')
  await Page.getByTestId('fit').click()

  const BeforeResize = await ReadImageLayout(Page)
  const Handle = (await Page.getByTestId('resize-se').boundingBox())!
  await Page.mouse.move(Handle.x + 4, Handle.y + 4)
  await Page.mouse.down()
  await Page.mouse.move(Handle.x + 120, Handle.y + 60, { steps: 8 })
  await Page.mouse.up()
  const Resized = await ReadImageLayout(Page)
  Expect(Resized[0].width).toBeGreaterThan(BeforeResize[0].width)
  Resized.forEach((Image, Index) => Expect(Image.width / Image.height).toBeCloseTo(BeforeResize[Index].width / BeforeResize[Index].height, 3))
  await Page.keyboard.press('Control+z')
  Expect(await ReadImageLayout(Page)).toEqual(BeforeResize)
  await Page.keyboard.press('Control+Shift+z')
  Expect(await ReadImageLayout(Page)).toEqual(Resized)

  await Page.getByTestId('fit').click()
  const PreviousZoom = await Page.getByTestId('zoom').textContent()
  await Page.mouse.move(650, 440)
  await Page.mouse.wheel(0, -150)
  await Expect(Page.getByTestId('zoom')).not.toHaveText(PreviousZoom!)
  const BeforePan = await ReadImageLayout(Page)
  const BeforePanBox = (await Images.first().boundingBox())!
  await Page.keyboard.down('Space')
  await Page.mouse.move(950, 730)
  await Page.mouse.down()
  await Page.mouse.move(750, 560, { steps: 8 })
  await Page.mouse.up()
  await Page.keyboard.up('Space')
  Expect(await ReadImageLayout(Page)).toEqual(BeforePan)
  Expect((await Images.first().boundingBox())!.x).not.toBe(BeforePanBox.x)

  await Page.getByTestId('fit').click()
  await Page.keyboard.press('Escape')
  await Images.nth(2).click()
  const Second = (await Images.nth(1).boundingBox())!
  const Third = (await Images.nth(2).boundingBox())!
  await Page.mouse.move(Third.x + Third.width / 2, Third.y + Third.height / 2)
  await Page.mouse.down()
  await Page.mouse.move(Second.x + Second.width + Third.width / 2 + 3, Third.y + Third.height / 2 + 20, { steps: 8 })
  await Expect(Page.getByTestId('snap-guide').first()).toBeVisible()
  await Page.mouse.up()
  const Snapped = await ReadImageLayout(Page)
  Expect(Snapped[2].x).toBeCloseTo(Snapped[1].x + Snapped[1].width, 2)
  Expect(Errors).toEqual([])
})

async function ExpectSelectionFitted(Page: Page): Promise<void> {
  const Canvas = (await Page.getByTestId('canvas').boundingBox())!
  const Selected = (await Page.getByTestId('selection-box').boundingBox())!
  Expect(Selected.x + Selected.width / 2).toBeCloseTo(Canvas.x + Canvas.width / 2, 1)
  Expect(Selected.y + Selected.height / 2).toBeCloseTo(Canvas.y + Canvas.height / 2, 1)
  const HorizontalMargin = (Canvas.width - Selected.width) / 2
  const VerticalMargin = (Canvas.height - Selected.height) / 2
  Expect(HorizontalMargin).toBeGreaterThanOrEqual(55.9)
  Expect(VerticalMargin).toBeGreaterThanOrEqual(55.9)
  Expect(Math.min(HorizontalMargin, VerticalMargin)).toBeCloseTo(56, 1)
}

Test('Space fits only selected images without changing geometry and keeps Space-drag panning', async ({ page: Page }) => {
  await OpenImportedBoard(Page)
  await Page.getByTestId('fit').click()
  const Images = Page.getByTestId('image-item')
  const Layout = await ReadImageLayout(Page)
  const History = await Page.locator('.app').getAttribute('data-history-version')
  const AllTransform = await Page.locator('.world').evaluate(Node => (Node as HTMLElement).style.transform)
  await Page.keyboard.press('Escape')
  await Page.keyboard.press('Space')
  Expect(await Page.locator('.world').evaluate(Node => (Node as HTMLElement).style.transform)).toBe(AllTransform)
  await Images.first().click({ position: { x: 10, y: 2 } })
  const SmallBox = (await Images.first().boundingBox())!
  // Key repeats must not change the view while Space is held for a possible pan.
  await Page.keyboard.down('Space')
  await Page.keyboard.down('Space')
  Expect(await Images.first().boundingBox()).toEqual(SmallBox)
  await Page.keyboard.up('Space')
  await ExpectSelectionFitted(Page)
  Expect((await Images.first().boundingBox())!.width).toBeGreaterThan(SmallBox.width)
  await Expect(Page.getByTestId('status')).toContainText('已选 1')
  await Page.keyboard.press('f')
  Expect(await Page.locator('.world').evaluate(Node => (Node as HTMLElement).style.transform)).toBe(AllTransform)
  await Images.nth(1).click({ modifiers: ['Shift'], position: { x: 10, y: 2 } })
  await Page.keyboard.press('Space')
  await ExpectSelectionFitted(Page)
  await Expect(Page.getByTestId('status')).toContainText('已选 2')
  const BeforePan = (await Images.first().boundingBox())!
  await Page.keyboard.down('Space')
  await Page.mouse.move(900, 700)
  await Page.mouse.down()
  await Page.mouse.move(985, 745, { steps: 5 })
  await Page.mouse.up()
  const Panned = (await Images.first().boundingBox())!
  await Page.keyboard.up('Space')
  Expect(await Images.first().boundingBox()).toEqual(Panned)
  Expect(Panned.x - BeforePan.x).toBeCloseTo(85, 1)
  Expect(Panned.y - BeforePan.y).toBeCloseTo(45, 1)
  Expect(Panned.width).toBeCloseTo(BeforePan.width, 1)
  Expect(await ReadImageLayout(Page)).toEqual(Layout)
  await Expect(Page.locator('.app')).toHaveAttribute('data-history-version', History!)
})

Test('Space fits text and mixed selections while preserving typing and cancelling interrupted taps', async ({ page: Page }) => {
  await OpenImportedBoard(Page)
  await Page.getByTestId('add-text').click()
  await Page.getByTestId('text-content').fill('# 测试')
  const BeforeTyping = await Page.locator('.world').evaluate(Node => (Node as HTMLElement).style.transform)
  await Page.keyboard.press('End')
  await Page.keyboard.press('Space')
  await Expect(Page.getByTestId('text-content')).toHaveValue('# 测试 ')
  Expect(await Page.locator('.world').evaluate(Node => (Node as HTMLElement).style.transform)).toBe(BeforeTyping)
  await Page.keyboard.press('Control+Enter')
  const Frame = Page.getByTestId('text-item')
  const TextBefore = await Frame.evaluate(Node => ({ x: Node.getAttribute('data-x'), y: Node.getAttribute('data-y'), width: Node.getAttribute('data-width'), height: Node.getAttribute('data-height'), fontSize: (Node as HTMLElement).style.fontSize }))
  await Page.keyboard.press('Space')
  await ExpectSelectionFitted(Page)
  await Expect(Page.getByTestId('status')).toContainText('已选 1')
  await Page.keyboard.press('Control+a')
  await Page.keyboard.press('Space')
  await ExpectSelectionFitted(Page)
  await Expect(Page.getByTestId('status')).toContainText('已选 4')
  Expect(await Frame.evaluate(Node => ({ x: Node.getAttribute('data-x'), y: Node.getAttribute('data-y'), width: Node.getAttribute('data-width'), height: Node.getAttribute('data-height'), fontSize: (Node as HTMLElement).style.fontSize }))).toEqual(TextBefore)
  await Page.getByTestId('zoom-out').click()
  const Unfitted = await Page.locator('.world').evaluate(Node => (Node as HTMLElement).style.transform)
  for (const Key of ['Control+Space', 'Shift+Space', 'Alt+Space', 'Meta+Space']) await Page.keyboard.press(Key)
  Expect(await Page.locator('.world').evaluate(Node => (Node as HTMLElement).style.transform)).toBe(Unfitted)
  await Page.keyboard.down('Space')
  await Page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await Page.keyboard.up('Space')
  Expect(await Page.locator('.world').evaluate(Node => (Node as HTMLElement).style.transform)).toBe(Unfitted)
  await Page.getByTestId('open').click()
  await Page.keyboard.press('Space')
  Expect(await Page.locator('.world').evaluate(Node => (Node as HTMLElement).style.transform)).toBe(Unfitted)
  await Page.keyboard.press('Escape')
  await Page.keyboard.down('Space')
  await Page.mouse.move(650, 440)
  await Page.mouse.wheel(0, 100)
  await Expect(Page.locator('.world')).not.toHaveAttribute('style', `transform: ${Unfitted};`)
  const Wheeled = await Page.locator('.world').evaluate(Node => (Node as HTMLElement).style.transform)
  await Page.keyboard.up('Space')
  Expect(await Page.locator('.world').evaluate(Node => (Node as HTMLElement).style.transform)).toBe(Wheeled)
})

Test('geometry shortcuts preserve selection and support exact repeat, undo and redo', async ({ page: Page }) => {
  await OpenImportedBoard(Page)
  await Page.keyboard.press('Control+a')
  const Before = await ReadImageLayout(Page)
  await Page.keyboard.press('l')
  Expect(await ReadImageLayout(Page)).toEqual(Before)

  for (const [Key, Axis, Dimension] of [['h', 'x', 'width'], ['v', 'y', 'height']] as const) {
    await Test.step(`${Key}: centre selected images`, async () => {
      await Page.keyboard.press(Key)
      const Centers = (await ReadImageLayout(Page)).map(Image => Image[Axis] + Image[Dimension] / 2)
      Centers.forEach(Center => Expect(Center).toBeCloseTo(Centers[0], 6))
      await Page.keyboard.press('Control+z')
      Expect(await ReadImageLayout(Page)).toEqual(Before)
    })
  }
  for (const [Key, Axis, Factor] of [['ArrowLeft', 'x', 0], ['ArrowRight', 'x', 1], ['ArrowUp', 'y', 0], ['ArrowDown', 'y', 1]] as const) {
    await Test.step(`Control+${Key}: push until touching`, async () => {
      const Shortcut = `Control+${Key}`
      await Page.keyboard.press(Shortcut)
      const Packed = await ReadImageLayout(Page)
      ExpectDirectionalPush(Before, Packed, Axis, Factor)
      await Expect(Page.getByTestId('status')).toContainText('已选 3')
      await CheckShortcutHistory(Page, Shortcut, Before, Packed)
    })
  }
  for (const [Key, Dimension] of [['ArrowRight', 'width'], ['ArrowLeft', 'height']] as const) {
    await Test.step(`Control+Alt+${Key}: normalize ${Dimension}`, async () => {
      const Shortcut = `Control+Alt+${Key}`
      const Average = Before.reduce((Total, Image) => Total + Image[Dimension], 0) / Before.length
      await Page.keyboard.press(Shortcut)
      const Normalized = await ReadImageLayout(Page)
      Normalized.forEach((Image, Index) => {
        const Original = Before[Index]
        Expect(Image[Dimension]).toBeCloseTo(Average, 6)
        Expect(Image.width / Image.height).toBeCloseTo(Original.width / Original.height, 6)
        Expect(Image.x + Image.width / 2).toBeCloseTo(Original.x + Original.width / 2, 6)
        Expect(Image.y + Image.height / 2).toBeCloseTo(Original.y + Original.height / 2, 6)
      })
      await Expect(Page.getByTestId('status')).toContainText('已选 3')
      await CheckShortcutHistory(Page, Shortcut, Before, Normalized)
    })
  }
})

Test('clipboard images save as deterministic YAML and PNG, then reopen after switching and reload', async ({ page: Page }) => {
  await OpenImportedBoard(Page)
  const Images = Page.getByTestId('image-item')
  await Page.keyboard.press('Escape')
  await Images.nth(2).click()
  await CaptureClipboard(Page)
  await CopySnapshot(Page)
  await PasteSnapshot(Page)
  await Expect(Images).toHaveCount(4)
  await Page.keyboard.press('Delete')
  await Expect(Images).toHaveCount(3)
  await Page.keyboard.press('Control+z')
  await Expect(Images).toHaveCount(4)
  const Png = (await ReadFile(Sources[2])).toString('base64')
  await Page.evaluate(Base64 => {
    const Data = new DataTransfer()
    Data.items.add(new File([Uint8Array.from(atob(Base64), Char => Char.charCodeAt(0))], 'paste.png', { type: 'image/png' }))
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: Data, bubbles: true, cancelable: true }))
  }, Png)
  await Expect(Images).toHaveCount(5)
  await Page.keyboard.press('Control+s')
  await ChooseProjectName(Page, 'BrowserRef')
  await Expect(Page).toHaveTitle('BrowserRef.hbr — HybridRef')
  const Project = Join(ProjectDirectory, 'BrowserRef', 'BrowserRef.hbr')
  const Saved = await ReadFile(Project, 'utf8')
  const Doc = Parse(Saved)
  Expect(Doc.images).toHaveLength(5)
  for (const Image of Doc.images) {
    Expect(Image.asset).toMatch(/^BrowserRefResource\/Texture_[A-F0-9]{16}_[A-F0-9]{8}\.png$/)
    Expect((await ReadFile(Join(Dirname(Project), Image.asset))).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  }
  const BeforeSave = (await Stat(Project)).mtimeMs
  await Page.keyboard.press('Control+s')
  await Expect.poll(async () => (await Stat(Project)).mtimeMs).toBeGreaterThan(BeforeSave)
  Expect(await ReadFile(Project, 'utf8')).toBe(Saved)
  await StartNewProject(Page)
  await ChooseProjectName(Page, 'NextBoard')
  await Expect(Images).toHaveCount(0)
  await OpenProject(Page, 'BrowserRef')
  await Expect(Images).toHaveCount(5)
  await Page.reload()
  await Expect(Images).toHaveCount(5)
})

Test('Ctrl+C exports selected images and styled text as an opaque, lossless PNG at board scale', async ({ page: Page }) => {
  const Folder = Join(ProjectDirectory, 'Snapshot')
  await Mkdir(Join(Folder, 'SnapshotResource'), { recursive: true })
  async function Resource(Prefix: string, Bytes: Buffer, Extension: string): Promise<string> {
    const Hash = CreateHash('sha256').update(Bytes).digest('hex').toUpperCase()
    const Asset = `SnapshotResource/${Prefix}_${Hash.slice(8, 24)}_${Hash.slice(0, 8)}.${Extension}`
    await WriteFile(Join(Folder, Asset), Bytes)
    return Asset
  }
  const Pixels = Buffer.alloc(120 * 60 * 4)
  for (let Y = 0; Y < 60; Y++) for (let X = 0; X < 120; X++) {
    const Offset = (Y * 120 + X) * 4
    Pixels.set(X < 60 ? [255, 0, 0, X < 20 ? 0 : 128] : [X, Y, X + Y, 255], Offset)
  }
  const Image = await Resource('Texture', await Sharp(Pixels, { raw: { width: 120, height: 60, channels: 4 } }).png().toBuffer(), 'png')
  const Unselected = await Resource('Texture', await Sharp({ create: { width: 280, height: 200, channels: 3, background: '#ffff00' } }).png().toBuffer(), 'png')
  const Text = EmptyTextResource('黑体 <&>\n第二行 ABCDEFG 自动换行\n底部文字裁切检查')
  Text.font.weight = 700; Text.font.opacity = 0.6
  Text.background = { color: '#304050', opacity: 0.5 }
  Text.paragraph.align = 'right'; Text.padding = 8
  const TextAsset = await Resource('Text', Buffer.from(Stringify(Text)), 'yaml')
  await WriteFile(Join(Folder, 'Snapshot.hbr'), Stringify({ ...EmptyDocument(), viewport: { x: 400, y: 200, zoom: 1 },
    images: [
      { id: 'unselected', asset: Unselected, x: -40, y: -30, width: 280, height: 200 },
      { id: 'selected', asset: Image, x: -40, y: -30, width: 120, height: 60 },
    ],
    texts: [{ id: 'styled', asset: TextAsset, x: -20, y: 50, width: 260, height: 120 }],
  }))
  await Page.goto(ServiceUrl)
  await OpenProject(Page, 'Snapshot')
  await Expect(Page.getByTestId('text-item')).toHaveText(Text.content)
  await CaptureClipboard(Page)
  await Page.getByTestId('image-item').nth(1).click({ position: { x: 90, y: 30 } })
  const ImageOnly = await CopySnapshot(Page)
  const ImageBytes = Buffer.from(ImageOnly.png, 'base64')
  Expect((await Sharp(ImageBytes).metadata()).format).toBe('png')
  const ImageRaw = await Sharp(ImageBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  Expect([ImageRaw.info.width, ImageRaw.info.height]).toEqual([120, 60])
  const PixelAt = (Data: Buffer, Width: number, X: number, Y: number): number[] => Array.from(Data.subarray((Y * Width + X) * 4, (Y * Width + X) * 4 + 4))
  Expect(PixelAt(ImageRaw.data, 120, 10, 25)).toEqual([12, 13, 15, 255])
  const Blended = PixelAt(ImageRaw.data, 120, 30, 25)
  ;[134, 6, 7, 255].forEach((Channel, Index) => Expect(Math.abs(Blended[Index] - Channel)).toBeLessThanOrEqual(1))
  Expect(PixelAt(ImageRaw.data, 120, 75, 25)).toEqual([75, 25, 100, 255])

  await Page.getByTestId('text-item').click({ modifiers: ['Shift'] })
  const Mixed = await CopySnapshot(Page)
  const MixedBytes = Buffer.from(Mixed.png, 'base64')
  const MixedRaw = await Sharp(MixedBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  Expect([MixedRaw.info.width, MixedRaw.info.height]).toEqual([280, 200])
  Expect(MixedRaw.data.every((Channel, Offset) => Offset % 4 !== 3 || Channel === 255)).toBe(true)
  // Gaps contain the canvas color, even when an unselected yellow image is underneath.
  Expect(PixelAt(MixedRaw.data, 280, 140, 30)).toEqual([12, 13, 15, 255])
  Expect(PixelAt(MixedRaw.data, 280, 0, 0)).toEqual([12, 13, 15, 255])
  // The text's translucent background is flattened over the canvas, not the unselected image.
  const TextBackground = PixelAt(MixedRaw.data, 280, 22, 82)
  ;[30, 38, 47, 255].forEach((Channel, Index) => Expect(Math.abs(TextBackground[Index] - Channel)).toBeLessThanOrEqual(1))
  Expect(MixedBytes.length).toBeLessThan(MixedRaw.data.length / 4)
  await WriteFile(Join(ModuleRoot, 'Runtime/SelectionSnapshot.png'), MixedBytes)

  // Compare with independently rendered DOM text, including bold, alignment, wrapping and clipping.
  const Selection = (await Page.getByTestId('selection-box').boundingBox())!
  const Reference = await Page.screenshot({ clip: Selection, path: Join(ModuleRoot, 'Runtime/SnapshotCanvas.png'),
    style: '.selection-box,.text-settings-button,.connection-handle,[data-image-id="unselected"]{visibility:hidden}.board-image,.board-text{outline:none}' })
  const ReferenceRaw = await Sharp(Reference).ensureAlpha().raw().toBuffer()
  let DifferentChannels = 0
  for (let Offset = 0; Offset < MixedRaw.data.length; Offset++) if (Math.abs(MixedRaw.data[Offset] - ReferenceRaw[Offset]) > 3) DifferentChannels++
  Expect(DifferentChannels / MixedRaw.data.length).toBeLessThan(0.015)

  await Page.getByTestId('zoom-out').click({ clickCount: 3 })
  await Page.mouse.move(800, 400)
  await Page.mouse.down({ button: 'middle' })
  await Page.mouse.move(1200, 700)
  await Page.mouse.up({ button: 'middle' })
  Expect((await CopySnapshot(Page)).png).toBe(Mixed.png)
  // Ctrl+D keeps independent editable objects; Ctrl+V imports the copied PNG snapshot.
  await Page.keyboard.press('Control+d')
  await Expect(Page.getByTestId('image-item')).toHaveCount(3)
  await Expect(Page.getByTestId('text-item')).toHaveCount(2)
  await Page.keyboard.press('Control+z')
  await PasteSnapshot(Page)
  await Expect(Page.getByTestId('image-item')).toHaveCount(3)
  await Expect(Page.getByTestId('text-item')).toHaveCount(1)
  await Expect(Page.getByTestId('image-item').last()).toHaveAttribute('data-width', '280')
  await Expect(Page.getByTestId('image-item').last()).toHaveAttribute('data-height', '200')
})

Test('snapshot copy handles text alone, native editing, empty selection and clipboard rejection', async ({ page: Page }) => {
  await Page.goto(ServiceUrl)
  await Expect(Page.getByTestId('add-text')).toBeEnabled()
  await CaptureClipboard(Page)
  await Page.getByTestId('add-text').click()
  await Page.getByTestId('text-content').fill('原位复制文字\n文本快照')
  Expect(await Page.getByTestId('text-content').evaluate(Element => {
    const Event = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })
    Element.dispatchEvent(Event)
    return Event.defaultPrevented
  })).toBe(false)
  Expect(await Page.evaluate(() => (window as unknown as ClipboardTestWindow).CapturedClipboard.calls)).toBe(0)
  await Page.keyboard.press('Control+Enter')
  const First = await CopySnapshot(Page)
  const Metadata = await Sharp(Buffer.from(First.png, 'base64')).metadata()
  Expect(Metadata.width).toBe(Number(await Page.getByTestId('text-item').getAttribute('data-width')))
  Expect(Metadata.height).toBe(Number(await Page.getByTestId('text-item').getAttribute('data-height')))
  await Page.evaluate(() => { (window as unknown as ClipboardTestWindow).RejectClipboard = true })
  await Page.keyboard.press('Control+c')
  await Expect(Page.locator('.message')).toContainText('复制快照失败')
  Expect(await Page.evaluate(() => (window as unknown as ClipboardTestWindow).CapturedClipboard)).toEqual(First)
  await Expect(Page.getByTestId('text-item')).toHaveCount(1)
  await Page.evaluate(() => { (window as unknown as ClipboardTestWindow).RejectClipboard = false })
  await CopySnapshot(Page)
  await Page.keyboard.press('Escape')
  Expect(await Page.evaluate(() => {
    const Event = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })
    document.dispatchEvent(Event)
    return Event.defaultPrevented
  })).toBe(false)
  Expect(await Page.evaluate(() => (window as unknown as ClipboardTestWindow).CapturedClipboard.calls)).toBe(2)
})

Test('snapshot preserves missing-texture aspect ratio and rejects oversized selections without downsampling', async ({ page: Page }) => {
  const Folder = Join(ProjectDirectory, 'SnapshotMissing')
  await Mkdir(Join(Folder, 'SnapshotMissingResource'), { recursive: true })
  const Project = Join(Folder, 'SnapshotMissing.hbr')
  const Doc = { ...EmptyDocument(), viewport: { x: 300, y: 200, zoom: 1 }, images: [
    { id: 'missing', asset: 'SnapshotMissingResource/Texture_AAAAAAAAAAAAAAAA_BBBBBBBB.png', x: 0, y: 0, width: 200, height: 60 },
  ] }
  await WriteFile(Project, Stringify(Doc))
  await Page.goto(ServiceUrl)
  await OpenProject(Page, 'SnapshotMissing')
  await Expect(Page.getByTestId('image-item')).toHaveAttribute('data-missing', 'true')
  await CaptureClipboard(Page)
  await Page.getByTestId('canvas').evaluate(Element => { Element.style.backgroundColor = '#18212e' })
  await Page.keyboard.press('Control+a')
  const Captured = await CopySnapshot(Page)
  const Raw = await Sharp(Buffer.from(Captured.png, 'base64')).ensureAlpha().raw().toBuffer()
  Expect(Array.from(Raw.subarray(0, 4))).toEqual([24, 33, 46, 255])
  const ColoredXs: number[] = []
  for (let Offset = 0; Offset < Raw.length; Offset += 4) {
    if (Raw[Offset] !== 24 || Raw[Offset + 1] !== 33 || Raw[Offset + 2] !== 46) ColoredXs.push((Offset / 4) % 200)
  }
  Expect(ColoredXs.length).toBeGreaterThan(50)
  Expect(Math.min(...ColoredXs)).toBeGreaterThanOrEqual(70)
  Expect(Math.max(...ColoredXs)).toBeLessThan(130)
  Doc.images[0].width = 17000
  await WriteFile(Project, Stringify(Doc))
  await OpenProject(Page, 'SnapshotMissing')
  await Expect(Page.getByTestId('image-item')).toHaveAttribute('data-width', '17000')
  await Page.keyboard.press('Control+a')
  await Page.keyboard.press('Control+c')
  await Expect(Page.locator('.message')).toContainText('选区过大，请分批复制')
  Expect(await Page.evaluate(() => (window as unknown as ClipboardTestWindow).CapturedClipboard)).toEqual(Captured)
})

Test('project dropdown opens the existing demo and supports marquee/Shift selection', async ({ page: Page }) => {
  await Page.goto(ServiceUrl)
  await OpenProject(Page, 'Demo')
  await Expect(Page).toHaveTitle('Demo.hbr — HybridRef')
  const Images = Page.getByTestId('image-item')
  await Expect(Images).toHaveCount(3)
  await Expect(Page.getByTestId('file-dialog')).toHaveCount(0)
  const Boxes = await Promise.all([0, 1, 2].map(Index => Images.nth(Index).boundingBox()))
  await Page.mouse.move(Math.min(...Boxes.map(Box => Box!.x)) - 10, Math.min(...Boxes.map(Box => Box!.y)) - 10)
  await Page.mouse.down()
  await Page.mouse.move(Math.max(...Boxes.map(Box => Box!.x + Box!.width)) + 10, Math.max(...Boxes.map(Box => Box!.y + Box!.height)) + 10, { steps: 8 })
  await Page.mouse.up()
  await Expect(Page.getByTestId('status')).toContainText('已选 3')
  await Page.keyboard.press('Escape')
  await Images.first().click()
  await Images.nth(1).click({ modifiers: ['Shift'] })
  await Expect(Page.getByTestId('status')).toContainText('已选 2')
  await Images.first().click({ modifiers: ['Shift'] })
  await Expect(Page.getByTestId('status')).toContainText('已选 1')
})

Test('separate browser tabs keep independent image stores', async ({ page: Page, context: Context }) => {
  const Folder = Join(Fixture, 'tabs')
  await Mkdir(Folder)
  await Cp(Join(ProjectDirectory, 'Demo/Demo.hbr'), Join(Folder, 'Demo.hbr'))
  await Cp(Join(ProjectDirectory, 'Demo/DemoResource'), Join(Folder, 'DemoResource'), { recursive: true })
  await Page.goto(`${ServiceUrl}/?project=${encodeURIComponent(Join(Folder, 'Demo.hbr'))}`)
  await Expect(Page.getByTestId('image-item')).toHaveCount(3)
  const Other = await Context.newPage()
  await Other.goto(ServiceUrl)
  await StartNewProject(Other)
  await ChooseProjectName(Other, 'OtherTab')
  await Expect(Other).toHaveTitle('OtherTab.hbr — HybridRef')
  await Page.bringToFront()
  const Before = (await Stat(Join(Folder, 'Demo.hbr'))).mtimeMs
  await Page.keyboard.press('Control+s')
  await Expect.poll(async () => (await Stat(Join(Folder, 'Demo.hbr'))).mtimeMs).toBeGreaterThan(Before)
  await Expect(Page).toHaveTitle('Demo.hbr — HybridRef')
  await Other.close()
})

Test('new projects use their own folder below Project even after opening an external board', async ({ page: Page }) => {
  const Folder = Join(Fixture, 'Outside')
  await Mkdir(Folder)
  await Cp(Join(ProjectDirectory, 'Demo/Demo.hbr'), Join(Folder, 'Demo.hbr'))
  await Cp(Join(ProjectDirectory, 'Demo/DemoResource'), Join(Folder, 'DemoResource'), { recursive: true })
  await Page.goto(`${ServiceUrl}/?project=${encodeURIComponent(Join(Folder, 'Demo.hbr'))}`)
  await Expect(Page.getByTestId('image-item')).toHaveCount(3)
  await StartNewProject(Page)
  await Page.getByTestId('file-cancel').click()
  await Expect(Page).toHaveTitle('Demo.hbr — HybridRef')
  await Expect(Page.getByTestId('image-item')).toHaveCount(3)

  const Name = '参考 # 100%'
  const Project = Join(ProjectDirectory, Name, `${Name}.hbr`)
  await StartNewProject(Page)
  await ChooseProjectName(Page, Name)
  await Expect(Page).toHaveTitle(`${Name}.hbr — HybridRef`)
  await Expect(Page.getByTestId('image-item')).toHaveCount(0)
  const Created = await ReadFile(Project, 'utf8')
  Expect(Parse(Created).images).toEqual([])
  Expect((await Stat(Join(Dirname(Project), `${Name}Resource`))).isDirectory()).toBe(true)
  await Page.reload()
  await Expect(Page).toHaveTitle(`${Name}.hbr — HybridRef`)

  await StartNewProject(Page)
  await ChooseProjectName(Page, Name)
  await Expect(Page.locator('.message')).toContainText('已存在')
  await Expect(Page).toHaveTitle(`${Name}.hbr — HybridRef`)
  Expect(await ReadFile(Project, 'utf8')).toBe(Created)

  // Save As remains available for an explicitly chosen external destination.
  const Copy = Join(Folder, 'Copy.hbr')
  await Page.keyboard.press('Control+Shift+s')
  await ChoosePath(Page, Copy)
  await Expect(Page).toHaveTitle('Copy.hbr — HybridRef')
  Expect(Parse(await ReadFile(Copy, 'utf8')).images).toEqual([])
  Expect((await Stat(Join(Folder, 'CopyResource'))).isDirectory()).toBe(true)
})

Test('project menu refreshes on open, supports keyboard control and asks about edits only when switching', async ({ page: Page }) => {
  await Page.goto(ServiceUrl)
  await OpenProject(Page, 'Demo')
  await Expect(Page.getByTestId('image-item')).toHaveCount(3)
  await Page.keyboard.press('Control+o')
  await Expect(Page.getByTestId('project-menu')).toBeVisible()
  await Expect(Page.getByTestId('project-entry').first()).toBeVisible()
  await Expect(Page.getByTestId('file-dialog')).toHaveCount(0)
  await Page.getByTestId('new').focus()
  await Page.keyboard.press('ArrowDown')
  await Expect(Page.getByTestId('project-entry').first()).toBeFocused()
  await Page.keyboard.press('ArrowUp')
  await Expect(Page.getByTestId('new')).toBeFocused()
  await Page.keyboard.press('Escape')
  await Expect(Page.getByTestId('project-menu')).toHaveCount(0)
  await Expect(Page.getByTestId('open')).toBeFocused()

  await Page.getByTestId('open').click()
  await Expect(Page.getByTestId('project-entry').filter({ hasText: 'FreshlyAdded' })).toHaveCount(0)
  await Cp(Join(ProjectDirectory, 'Demo'), Join(ProjectDirectory, 'FreshlyAdded'), { recursive: true })
  await Page.getByTestId('canvas').click({ position: { x: 1250, y: 760 } })
  await Expect(Page.getByTestId('project-menu')).toHaveCount(0)
  await Page.getByTestId('open').click()
  await Expect(Page.getByTestId('project-entry').filter({ hasText: 'FreshlyAdded' })).toBeVisible()
  await Page.getByTestId('new').click()
  await Page.getByTestId('file-name').fill('MyReference')
  await Page.getByTestId('file-cancel').click()

  await Page.keyboard.press('Control+a')
  await Page.keyboard.press('Delete')
  await Expect(Page).toHaveTitle('* Demo.hbr — HybridRef')
  let DialogCount = 0
  const RejectDiscard = (Dialog: import('@playwright/test').Dialog): void => { DialogCount += 1; void Dialog.dismiss() }
  Page.on('dialog', RejectDiscard)
  await Page.getByTestId('open').click()
  await Expect(Page.getByTestId('project-menu')).toBeVisible()
  Expect(DialogCount).toBe(0)
  await Page.getByTestId('project-entry').filter({ hasText: 'FreshlyAdded' }).click()
  await Expect.poll(() => DialogCount).toBe(1)
  await Expect(Page).toHaveTitle('* Demo.hbr — HybridRef')
  await Expect(Page.getByTestId('image-item')).toHaveCount(0)
  Page.off('dialog', RejectDiscard)
  Page.once('dialog', Dialog => { void Dialog.accept() })
  await OpenProject(Page, 'FreshlyAdded')
  await Expect(Page.getByTestId('image-item')).toHaveCount(3)
})

Test('text styles, independent copies, edit history and resource references survive save and reload', async ({ page: Page }) => {
  const Errors: string[] = []
  Page.on('pageerror', CaughtError => Errors.push(CaughtError.message))
  await OpenImportedBoard(Page)
  await Page.getByTestId('add-text').click()
  await Expect(Page.getByTestId('text-editor')).toHaveCount(0)
  await Expect(Page.getByTestId('text-item').getByTestId('text-content')).toBeFocused()
  await Page.getByTestId('text-content').fill('设计标题\n中文多行说明')
  await Page.keyboard.press('Control+Enter')
  await Page.getByTestId('text-settings').click()
  await Expect(Page.getByTestId('text-editor')).toBeVisible()
  await Expect(Page.getByTestId('text-editor').getByTestId('text-content')).toHaveCount(0)
  await Expect(Page.getByTestId('text-editor').getByRole('heading')).toHaveText('字体设置')
  await Expect(Page.getByTestId('text-font-family')).toHaveText('黑体')
  await Expect(Page.getByTestId('text-editor').locator('select, input[data-testid="text-font-family"]')).toHaveCount(0)
  await Expect(Page.getByTestId('text-item')).toHaveCSS('font-family', 'SimHei')
  await Page.getByTestId('text-font-size').fill('32')
  const Bold = Page.getByTestId('text-font-weight')
  await Expect(Bold).toHaveAttribute('aria-pressed', 'false')
  await Bold.click()
  await Expect(Bold).toHaveAttribute('aria-pressed', 'true')
  await Expect(Page.getByTestId('text-item')).toHaveCSS('font-weight', '700')
  await Bold.click()
  await Expect(Bold).toHaveAttribute('aria-pressed', 'false')
  await Expect(Page.getByTestId('text-item')).toHaveCSS('font-weight', '400')
  await Bold.click()
  await Page.getByTestId('text-font-color').fill('#ffcc33')
  await Page.getByTestId('text-font-opacity').fill('75')
  await Page.getByTestId('text-background-color').fill('#224466')
  await Page.getByTestId('text-background-opacity').fill('60')
  for (const Align of ['right', 'left', 'center']) {
    await Page.getByTestId(`text-align-${Align}`).click()
    await Expect(Page.getByTestId(`text-align-${Align}`)).toHaveAttribute('aria-pressed', 'true')
    await Expect(Page.getByTestId('text-align').locator('[aria-pressed=true]')).toHaveCount(1)
    await Expect(Page.getByTestId('text-item')).toHaveCSS('text-align', Align)
  }
  await Page.getByTestId('text-line-height').fill('1.8')
  await Page.getByTestId('text-padding').fill('18')
  const LineHeight = (await Page.getByTestId('text-line-height').boundingBox())!
  const Padding = (await Page.getByTestId('text-padding').boundingBox())!
  Expect(LineHeight.y).toBe(Padding.y)
  Expect(Padding.x).toBeGreaterThan(LineHeight.x + LineHeight.width)
  const AlignButtons = await Page.getByTestId('text-align').getByRole('button').all()
  const AlignBounds = await Promise.all(AlignButtons.map(Button => Button.boundingBox()))
  Expect(new Set(AlignBounds.map(Bounds => Bounds!.y)).size).toBe(1)
  await Page.screenshot({ path: Join(ModuleRoot, 'Runtime/TextFormatSettings.png') })
  await Page.getByTestId('text-apply').click()
  await Page.getByTestId('text-item').dblclick()
  await Page.getByTestId('text-content').fill('设计标题\n中文多行说明：颜色与透明度')
  // Saving while the caret is in the frame must include the uncommitted content.
  await Page.keyboard.press('Control+s')
  await Expect(Page.getByTestId('text-content')).toHaveCount(0)
  await ChooseProjectName(Page, 'TextBoard')
  await Expect(Page).toHaveTitle('TextBoard.hbr — HybridRef')
  const Texts = Page.getByTestId('text-item')
  await Expect(Texts).toHaveCount(1)
  await Expect(Texts.first()).toHaveText('设计标题\n中文多行说明：颜色与透明度')
  await Expect(Texts.first()).toHaveCSS('font-size', '32px')
  await Expect(Texts.first()).toHaveCSS('font-weight', '700')
  await Expect(Texts.first()).toHaveCSS('color', 'rgba(255, 204, 51, 0.75)')
  await Expect(Texts.first()).toHaveCSS('background-color', 'rgba(34, 68, 102, 0.6)')
  await Expect(Texts.first()).toHaveCSS('text-align', 'center')
  await Expect(Texts.first()).toHaveCSS('padding', '18px')
  await Page.keyboard.press('Control+d')
  await Expect(Texts).toHaveCount(2)
  await Texts.last().dblclick()
  await Page.getByTestId('text-content').fill('独立副本')
  await Page.keyboard.press('Control+Enter')
  await Expect(Texts.first()).toContainText('设计标题')
  await Expect(Texts.last()).toHaveText('独立副本')
  await Page.keyboard.press('Control+z')
  await Expect(Texts.last()).toContainText('设计标题')
  await Page.keyboard.press('Control+Shift+z')
  await Expect(Texts.last()).toHaveText('独立副本')
  await Page.keyboard.press('Control+s')
  await Expect(Page).toHaveTitle('TextBoard.hbr — HybridRef')
  const Project = Join(ProjectDirectory, 'TextBoard', 'TextBoard.hbr')
  const Saved = await ReadFile(Project, 'utf8')
  const Doc = Parse(Saved)
  Expect(Doc.formatVersion).toBe(3)
  Expect(Doc.images).toHaveLength(3)
  Expect(Doc.texts).toHaveLength(2)
  Expect(Saved).not.toContain('设计标题')
  Expect(Saved).not.toContain('font:')
  const Resources = []
  for (const Item of Doc.texts) {
    Expect(Object.keys(Item).sort()).toEqual(['asset', 'height', 'id', 'width', 'x', 'y'])
    Expect(Item.asset).toMatch(/^TextBoardResource\/Text_[A-F0-9]{16}_[A-F0-9]{8}\.yaml$/)
    Resources.push(Parse(await ReadFile(Join(Dirname(Project), Item.asset), 'utf8')))
  }
  Expect(Doc.texts[0].asset).not.toBe(Doc.texts[1].asset)
  Expect(Resources.map(Resource => Resource.content)).toEqual(['设计标题\n中文多行说明：颜色与透明度', '独立副本'])
  Expect(Resources[0].font).toMatchObject({ family: 'SimHei', size: 32, weight: 700, color: '#ffcc33', opacity: 0.75 })
  await Page.reload()
  await Expect(Texts).toHaveCount(2)
  await Expect(Page.getByTestId('image-item')).toHaveCount(3)
  await Expect(Texts.last()).toHaveText('独立副本')
  await Expect(Texts.first()).toHaveCSS('color', 'rgba(255, 204, 51, 0.75)')
  await Expect(Texts.first()).toHaveCSS('font-family', 'SimHei')
  await Expect(Texts.first()).toHaveCSS('font-weight', '700')
  await Expect(Texts.first()).toHaveCSS('text-align', 'center')
  await Texts.last().dblclick()
  await Page.getByTestId('text-content').fill('未完成的草稿')
  await Expect(Page).toHaveTitle('* TextBoard.hbr — HybridRef')
  await Page.keyboard.press('Escape')
  await Expect(Page).toHaveTitle('TextBoard.hbr — HybridRef')
  await Expect(Texts.last()).toHaveText('独立副本')
  Expect(Errors).toEqual([])
})

Test('orphan cleanup preserves missing references and inline edits, and restored resources reappear', async ({ page: Page }) => {
  const Directory = Join(ProjectDirectory, 'CleanupBoard')
  const ResourceDirectory = Join(Directory, 'CleanupBoardResource')
  const Path = Join(Directory, 'CleanupBoard.hbr')
  await Mkdir(ResourceDirectory, { recursive: true })
  const Bytes = await Sharp({ create: { width: 200, height: 120, channels: 3, background: '#497988' } }).png().toBuffer()
  const ImageName = `Texture_AA11223344556677_${CreateHash('sha256').update(Bytes).digest('hex').slice(0, 8).toUpperCase()}.png`
  const TextBytes = Buffer.from(Stringify(EmptyTextResource('清理前的文字')))
  const TextName = `Text_BB11223344556677_${CreateHash('sha256').update(TextBytes).digest('hex').slice(0, 8).toUpperCase()}.yaml`
  const MissingImageBytes = await Sharp({ create: { width: 400, height: 140, channels: 3, background: '#98617a' } }).png().toBuffer()
  const MissingImageName = `Texture_CC11223344556677_${CreateHash('sha256').update(MissingImageBytes).digest('hex').slice(0, 8).toUpperCase()}.png`
  const MissingTextBytes = Buffer.from(Stringify(EmptyTextResource('恢复的文字')))
  const MissingTextName = `Text_DD11223344556677_${CreateHash('sha256').update(MissingTextBytes).digest('hex').slice(0, 8).toUpperCase()}.yaml`
  await WriteFile(Join(ResourceDirectory, ImageName), Bytes)
  await WriteFile(Join(ResourceDirectory, TextName), TextBytes)
  await WriteFile(Join(ResourceDirectory, 'Orphan.png'), Bytes)
  await WriteFile(Join(ResourceDirectory, 'Orphan.yaml'), TextBytes)
  const MissingGeometry = { x: 370, y: 60, width: 400, height: 140 }
  await WriteFile(Path, Stringify({
    ...EmptyDocument(), viewport: { x: 90, y: 100, zoom: 1 },
    images: [
      { id: 'keep-image', asset: `CleanupBoardResource/${ImageName}`, x: 20, y: 60, width: 300, height: 180 },
      { id: 'missing-image', asset: `CleanupBoardResource/${MissingImageName}`, ...MissingGeometry },
    ],
    texts: [
      { id: 'keep-text', asset: `CleanupBoardResource/${TextName}`, x: 20, y: 320, width: 360, height: 160 },
      { id: 'missing-text', asset: `CleanupBoardResource/${MissingTextName}`, x: 430, y: 320, width: 300, height: 180 },
    ],
  }))
  await Page.goto(ServiceUrl)
  await OpenProject(Page, 'CleanupBoard')
  const Images = Page.getByTestId('image-item')
  const Texts = Page.getByTestId('text-item')
  await Expect(Images).toHaveCount(2)
  await Expect(Texts).toHaveCount(1)
  const Placeholder = Page.locator('[data-testid="image-item"][data-missing="true"]')
  await Expect(Placeholder).toHaveCount(1)
  await Expect(Placeholder).toHaveCSS('object-fit', 'contain')
  Expect((await ReadImageLayout(Page))[1]).toEqual(MissingGeometry)
  await Expect.poll(() => Placeholder.evaluate(Node => (Node as HTMLImageElement).complete && (Node as HTMLImageElement).naturalWidth > 0)).toBe(true)
  await Expect(Placeholder).toHaveAttribute('alt', '纹理引用丢失')
  await Page.screenshot({ path: Join(ModuleRoot, 'Runtime/MissingResources.png') })
  await Texts.first().dblclick()
  await Page.getByTestId('text-content').fill('清理也保存原位编辑草稿')
  await Expect(Page.locator('.toolbar').getByTestId('cleanup-resources')).toBeVisible()
  await Page.getByTestId('cleanup-resources').click()
  await Expect(Page).toHaveTitle('CleanupBoard.hbr — HybridRef')
  await Expect(Images).toHaveCount(2)
  await Expect(Placeholder).toHaveCount(1)
  await Expect(Texts).toHaveText('清理也保存原位编辑草稿')
  const Saved = Parse(await ReadFile(Path, 'utf8'))
  Expect(Saved.images).toHaveLength(2)
  Expect(Saved.texts).toHaveLength(2)
  Expect(Saved.images[0].id).toBe('keep-image')
  Expect(Saved.texts[0].id).toBe('keep-text')
  Expect(Saved.images[1]).toEqual({ id: 'missing-image', asset: `CleanupBoardResource/${MissingImageName}`, ...MissingGeometry })
  Expect(Saved.texts[1]).toEqual({ id: 'missing-text', asset: `CleanupBoardResource/${MissingTextName}`, x: 430, y: 320, width: 300, height: 180 })
  Expect(Parse(await ReadFile(Join(Directory, Saved.texts[0].asset), 'utf8')).content).toBe('清理也保存原位编辑草稿')
  const Referenced = [...Saved.images, ...Saved.texts].map((Item: { asset: string }) => Basename(Item.asset)).sort()
  Expect((await Readdir(ResourceDirectory)).sort()).toEqual([ImageName, Basename(Saved.texts[0].asset)].sort())
  Expect(Referenced.every(Name => /^(Texture|Text)_[A-F0-9]{16}_[A-F0-9]{8}\.(png|yaml)$/.test(Name))).toBe(true)
  await Page.reload()
  await Expect(Images).toHaveCount(2)
  await Expect(Placeholder).toHaveCount(1)
  await Expect(Texts).toHaveText('清理也保存原位编辑草稿')
  await WriteFile(Join(ResourceDirectory, MissingImageName), MissingImageBytes)
  await WriteFile(Join(ResourceDirectory, MissingTextName), MissingTextBytes)
  await Page.getByTestId('cleanup-resources').click()
  await Expect(Placeholder).toHaveCount(0)
  await Expect(Images).toHaveCount(2)
  await Expect(Texts).toHaveText(['清理也保存原位编辑草稿', '恢复的文字'])
  Expect((await ReadImageLayout(Page))[1]).toEqual(MissingGeometry)
  const Recovered = Parse(await ReadFile(Path, 'utf8'))
  const RecoveredReferences = [...Recovered.images, ...Recovered.texts].map((Item: { asset: string }) => Basename(Item.asset)).sort()
  Expect((await Readdir(ResourceDirectory)).sort()).toEqual(RecoveredReferences)
})

Test('plain text paste, mixed selection, cut/copy, movement and text frame resizing support undo', async ({ page: Page }) => {
  await OpenImportedBoard(Page)
  await Page.evaluate(() => {
    const Data = new DataTransfer()
    Data.setData('text/plain', '粘贴的文字\n第二行')
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: Data, bubbles: true, cancelable: true }))
  })
  const Texts = Page.getByTestId('text-item')
  const Images = Page.getByTestId('image-item')
  await Expect(Texts).toHaveCount(1)
  await Expect(Texts.first()).toHaveText('粘贴的文字\n第二行')
  await Expect(Page.getByTestId('text-settings')).toBeVisible()
  const Width = Number(await Texts.first().getAttribute('data-width'))
  const Height = Number(await Texts.first().getAttribute('data-height'))
  const Handle = (await Page.getByTestId('resize-se').boundingBox())!
  await Page.mouse.move(Handle.x + 4, Handle.y + 4)
  await Page.mouse.down()
  await Page.mouse.move(Handle.x + 104, Handle.y + 4, { steps: 5 })
  await Page.mouse.up()
  Expect(Number(await Texts.first().getAttribute('data-width'))).toBeGreaterThan(Width + 90)
  Expect(Number(await Texts.first().getAttribute('data-height'))).toBeCloseTo(Height, 0)
  await Expect(Texts.first()).toHaveCSS('font-size', '24px')
  await Page.keyboard.press('Control+z')
  await Expect(Texts.first()).toHaveAttribute('data-width', String(Width))
  await Page.keyboard.press('Control+a')
  await Expect(Page.getByTestId('status')).toContainText('已选 4')
  await Expect(Page.getByTestId('text-settings')).toHaveCount(0)
  const BeforeImages = await ReadImageLayout(Page)
  const BeforeTextX = Number(await Texts.first().getAttribute('data-x'))
  const BeforeTextY = Number(await Texts.first().getAttribute('data-y'))
  const Box = (await Texts.first().boundingBox())!
  await Page.keyboard.down('Alt')
  await Page.mouse.move(Box.x + 30, Box.y + 30)
  await Page.mouse.down()
  await Page.mouse.move(Box.x + 100, Box.y + 80, { steps: 5 })
  await Page.mouse.up()
  await Page.keyboard.up('Alt')
  Expect(Number(await Texts.first().getAttribute('data-x'))).toBeCloseTo(BeforeTextX + 70, 2)
  Expect(Number(await Texts.first().getAttribute('data-y'))).toBeCloseTo(BeforeTextY + 50, 2)
  Expect((await ReadImageLayout(Page))[0].x).toBeCloseTo(BeforeImages[0].x + 70, 2)
  await Page.keyboard.press('Control+z')
  Expect(await ReadImageLayout(Page)).toEqual(BeforeImages)
  await Page.keyboard.press('Control+d')
  await Expect(Images).toHaveCount(6)
  await Expect(Texts).toHaveCount(2)
  await Page.keyboard.press('Delete')
  await Expect(Images).toHaveCount(3)
  await Expect(Texts).toHaveCount(1)
  await Page.keyboard.press('Control+z')
  await Expect(Images).toHaveCount(6)
  await Expect(Texts).toHaveCount(2)
  await Page.keyboard.press('Control+Shift+z')
  await Expect(Images).toHaveCount(3)
  await Expect(Texts).toHaveCount(1)
  await Page.keyboard.press('Control+a')
  await Page.evaluate(() => {
    const Data = new DataTransfer()
    document.dispatchEvent(new ClipboardEvent('cut', { clipboardData: Data, bubbles: true, cancelable: true }))
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: Data, bubbles: true, cancelable: true }))
  })
  await Expect(Images).toHaveCount(3)
  await Expect(Texts).toHaveCount(1)
  await Page.getByTestId('fit').click()
  await Page.keyboard.press('Escape')
  await Expect(Page.getByTestId('text-settings')).toHaveCount(0)
  const TopImage = (await Images.last().boundingBox())!
  await Images.last().click({ position: { x: TopImage.width - 15, y: TopImage.height - 15 } })
  await Expect(Page.getByTestId('text-settings')).toHaveCount(0)
  await Texts.first().click()
  await Expect(Page.getByTestId('text-settings')).toBeVisible()
  await Page.keyboard.press('Escape')
  const Boxes = await Promise.all([Images.first().boundingBox(), Images.nth(1).boundingBox(), Images.nth(2).boundingBox(), Texts.first().boundingBox()])
  await Page.mouse.move(Math.min(...Boxes.map(Box => Box!.x)) - 10, Math.min(...Boxes.map(Box => Box!.y)) - 10)
  await Page.mouse.down()
  await Page.mouse.move(Math.max(...Boxes.map(Box => Box!.x + Box!.width)) + 10, Math.max(...Boxes.map(Box => Box!.y + Box!.height)) + 10, { steps: 5 })
  await Page.mouse.up()
  await Expect(Page.getByTestId('status')).toContainText('已选 4')
})

Test('inline text keeps native typing and IME, and the font card preserves content while editing', async ({ page: Page }) => {
  await Page.goto(ServiceUrl)
  await Expect(Page.getByTestId('add-text')).toBeEnabled()
  await Page.getByTestId('add-text').click()
  const Texts = Page.getByTestId('text-item')
  const Content = Texts.getByTestId('text-content')
  await Expect(Content).toBeFocused()
  await Expect(Page.getByTestId('text-editor')).toHaveCount(0)
  await Content.fill('输入测试')
  await Page.keyboard.press('Control+a')
  Expect(await Content.evaluate(Element => {
    const Input = Element as HTMLTextAreaElement
    return [Input.selectionStart, Input.selectionEnd]
  })).toEqual([0, 4])
  await Page.keyboard.press('Backspace')
  await Expect(Content).toHaveValue('')
  await Expect(Texts).toHaveCount(1)
  await Page.keyboard.insertText('项目参考')
  await Page.keyboard.press('Enter')
  await Page.keyboard.insertText('在画布上直接编辑')
  await Page.keyboard.press('Enter')
  await Page.keyboard.insertText('支持中文与多行说明')
  const InitialContent = '项目参考\n在画布上直接编辑\n支持中文与多行说明'
  await Expect(Content).toHaveValue(InitialContent)
  await Page.keyboard.press('Delete')
  await Page.keyboard.press('Control+ArrowLeft')
  await Expect(Texts).toHaveCount(1)
  await Expect(Page.getByTestId('status')).toContainText('已选 1')
  // Synthetic events let us exercise composition guards without switching the user's IME.
  await Content.evaluate(Element => {
    Element.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
    for (const Key of ['Enter', 'Escape']) Element.dispatchEvent(new KeyboardEvent('keydown', { key: Key, ctrlKey: Key === 'Enter', isComposing: true, bubbles: true, cancelable: true }))
    Element.dispatchEvent(new CompositionEvent('compositionend', { data: '说明', bubbles: true }))
  })
  await Expect(Content).toBeFocused()
  await Expect(Content).toHaveValue(InitialContent)
  // Input-owned clipboard events must remain native and must not create board items.
  Expect(await Content.evaluate(Element => {
    const Data = new DataTransfer()
    Data.setData('text/plain', '原位粘贴')
    return ['copy', 'cut', 'paste'].map(Kind => {
      const Event = new ClipboardEvent(Kind, { clipboardData: Data, bubbles: true, cancelable: true })
      Element.dispatchEvent(Event)
      return Event.defaultPrevented
    })
  })).toEqual([false, false, false])
  await Expect(Texts).toHaveCount(1)
  // A save requested during IME composition waits for the final candidate to reach the draft.
  await Content.evaluate(Element => Element.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true })))
  await Page.keyboard.press('Control+s')
  await Expect(Page.getByTestId('file-dialog')).toHaveCount(0)
  await Expect(Content).toBeFocused()
  const SavedContent = `${InitialContent}。`
  await Content.fill(SavedContent)
  await Content.evaluate(Element => Element.dispatchEvent(new CompositionEvent('compositionend', { data: '。', bubbles: true })))
  await ChooseProjectName(Page, 'InlineDraft')
  await Expect(Page).toHaveTitle('InlineDraft.hbr — HybridRef')
  const Project = Join(ProjectDirectory, 'InlineDraft/InlineDraft.hbr')
  const Saved = Parse(await ReadFile(Project, 'utf8'))
  Expect(Parse(await ReadFile(Join(Dirname(Project), Saved.texts[0].asset), 'utf8')).content).toBe(SavedContent)
  await Texts.dblclick()
  await Content.fill('取消这次输入')
  await Page.keyboard.press('Escape')
  await Expect(Content).toHaveCount(0)
  await Expect(Texts).toHaveText(SavedContent)
  await Expect(Page).toHaveTitle('InlineDraft.hbr — HybridRef')

  await Texts.dblclick()
  const RevisedContent = '设计笔记\n在画布中直接输入文字\n字体与背景随手调整'
  await Content.fill(RevisedContent)
  await Page.keyboard.press('Control+End')
  await Page.screenshot({ path: Join(ModuleRoot, 'Runtime/TextInline.png') })
  await Page.getByTestId('text-settings').click()
  await Expect(Page.getByTestId('text-editor')).toBeVisible()
  await Expect(Page.getByTestId('text-editor').getByTestId('text-content')).toHaveCount(0)
  await Page.getByTestId('text-font-size').fill('28')
  await Expect(Texts).toHaveCSS('font-size', '28px')
  await Content.click()
  await Expect(Content).toBeFocused()
  await Page.keyboard.press('Control+End')
  await Page.keyboard.insertText('。')
  const FinalContent = `${RevisedContent}。`
  await Expect(Content).toHaveValue(FinalContent)
  await Expect(Page.getByTestId('text-editor')).toBeVisible()
  await Page.screenshot({ path: Join(ModuleRoot, 'Runtime/TextFontSettings.png') })
  // Canceling a style preview must retain the independent content draft.
  await Page.getByTestId('text-cancel').click()
  await Expect(Page.getByTestId('text-editor')).toHaveCount(0)
  await Expect(Texts).toHaveCSS('font-size', '24px')
  await Expect(Content).toHaveValue(FinalContent)
  await Page.getByTestId('canvas').click({ position: { x: 1230, y: 740 } })
  await Expect(Content).toHaveCount(0)
  await Expect(Texts).toHaveText(FinalContent)
  await Texts.click()
  await Page.getByTestId('text-settings').click()
  await Page.getByTestId('text-font-size').fill('30')
  await Page.getByTestId('text-apply').click()
  await Expect(Texts).toHaveCSS('font-size', '30px')
  await Expect(Texts).toHaveText(FinalContent)
  await Page.keyboard.press('Control+z')
  await Expect(Texts).toHaveCSS('font-size', '24px')
  await Expect(Texts).toHaveText(FinalContent)
})

Test('text creation icon stays fixed while the selected text settings icon follows its frame and zoom', async ({ page: Page }) => {
  await Page.goto(ServiceUrl)
  const Create = Page.getByTestId('add-text')
  await Expect(Create).toBeEnabled()
  Expect(await Create.evaluate(Element => Element.closest('.toolbar') === null)).toBe(true)
  const CreateBefore = (await Create.boundingBox())!
  await Create.click()
  await Page.getByTestId('text-content').fill('自由调整文本框')
  await Page.keyboard.press('Control+Enter')
  const Text = Page.getByTestId('text-item')
  const Settings = Page.getByTestId('text-settings')
  await Expect(Settings).toBeVisible()
  const FrameBefore = (await Text.boundingBox())!
  const SettingsBefore = (await Settings.boundingBox())!
  Expect(SettingsBefore.x).toBeGreaterThanOrEqual(FrameBefore.x + FrameBefore.width - 2)
  Expect(SettingsBefore.y + SettingsBefore.height).toBeCloseTo(FrameBefore.y + FrameBefore.height, 0)
  await Page.getByTestId('zoom-in').click()
  const FrameZoomed = (await Text.boundingBox())!
  const SettingsZoomed = (await Settings.boundingBox())!
  const CreateZoomed = (await Create.boundingBox())!
  Expect(CreateZoomed).toEqual(CreateBefore)
  Expect(SettingsZoomed.width / SettingsBefore.width).toBeCloseTo(FrameZoomed.width / FrameBefore.width, 1)
  Expect(SettingsZoomed.height).toBeGreaterThan(SettingsBefore.height)
  await Page.getByTestId('zoom').click()
  const Handle = (await Page.getByTestId('resize-se').boundingBox())!
  await Page.mouse.move(Handle.x + 4, Handle.y + 4)
  await Page.mouse.down()
  await Page.mouse.move(Handle.x + 154, Handle.y + 84, { steps: 5 })
  await Page.mouse.up()
  Expect((await Settings.boundingBox())!.width).toBeGreaterThan(SettingsBefore.width)
  Expect((await Create.boundingBox())!).toEqual(CreateBefore)
  await Expect(Text).toHaveCSS('font-size', '24px')
  await Page.keyboard.press('Escape')
  await Expect(Settings).toHaveCount(0)
  await Create.click()
  await Page.keyboard.press('Escape')
  await Expect(Page.getByTestId('text-content')).toHaveCount(0)
  await Expect(Text).toHaveCount(1)
})

Test('dropping images commits the active text draft before image import and preserves separate undo steps', async ({ page: Page }) => {
  await Page.goto(ServiceUrl)
  await Expect(Page.getByTestId('add-text')).toBeEnabled()
  await Page.getByTestId('add-text').click()
  await Page.getByTestId('text-content').fill('拖入图片时保留原位编辑内容')
  await DropImages(Page, Sources)
  await Expect(Page.getByTestId('text-content')).toHaveCount(0)
  await Expect(Page.getByTestId('text-item')).toHaveText('拖入图片时保留原位编辑内容')
  await Expect(Page.getByTestId('image-item')).toHaveCount(3)
  await Page.keyboard.press('Escape')
  await Expect(Page.getByTestId('image-item')).toHaveCount(3)
  await Page.keyboard.press('Control+z')
  await Expect(Page.getByTestId('image-item')).toHaveCount(0)
  await Expect(Page.getByTestId('text-item')).toHaveCount(1)
  await Page.keyboard.press('Control+z')
  await Expect(Page.getByTestId('text-item')).toHaveCount(0)
})

Test('Markdown renders GFM, keeps source editable and saved, and exports the same typography and local image', async ({ page: Page }) => {
  const Folder = Join(ProjectDirectory, 'Markdown')
  const ResourceFolder = Join(Folder, 'MarkdownResource')
  await Mkdir(ResourceFolder, { recursive: true })
  const Picture = await Sharp({ create: { width: 280, height: 80, channels: 3, background: '#2493c1' } }).png().toBuffer()
  const PictureHash = CreateHash('sha256').update(Picture).digest('hex').toUpperCase()
  const PictureName = `Texture_${PictureHash.slice(8, 24)}_${PictureHash.slice(0, 8)}.png`
  await WriteFile(Join(ResourceFolder, PictureName), Picture)
  const Content = [
    '# Markdown 参考笔记',
    '', '**重点文字**、*斜体*、~~已废弃~~，还有 `InlineCode()`。',
    '', '## 列表与引用', '', '- 参考资料', '  - 嵌套列表', '- 第二项', '', '3. 有序步骤', '4. 下一步',
    '', '> 引用说明', '> 第二行保留换行',
    '', '### 任务与表格', '', '- [x] 已完成', '- [ ] 待办',
    '', '| 左对齐 | 居中 | 右对齐 |', '| :--- | :---: | ---: |', '| **标题** | 中文 | 42 |',
    '', '#### 代码块', '', '```typescript', 'const Value = "<tag>"', '  console.log(Value)', '```',
    '', '##### 链接和图片', '', '[参考链接][reference] · https://example.com',
    '', `![本地示意图](MarkdownResource/${PictureName})`,
    '', '###### 六级标题', '', '---', '', '转义：\\*保留星号\\*。',
    '', '[reference]: https://example.com "示例"',
  ].join('\n')
  const Text = EmptyTextResource(Content)
  Text.font.size = 18; Text.paragraph.lineHeight = 1.4; Text.padding = 22
  const TextBytes = Buffer.from(Stringify(Text))
  const TextHash = CreateHash('sha256').update(TextBytes).digest('hex').toUpperCase()
  const TextName = `Text_${TextHash.slice(8, 24)}_${TextHash.slice(0, 8)}.yaml`
  await WriteFile(Join(ResourceFolder, TextName), TextBytes)
  const Project = Join(Folder, 'Markdown.hbr')
  await WriteFile(Project, Stringify({ ...EmptyDocument(), viewport: { x: 220, y: 20, zoom: 0.52 }, texts: [
    { id: 'markdown', asset: `MarkdownResource/${TextName}`, x: 0, y: 0, width: 760, height: 1480 },
  ] }))
  await Page.goto(ServiceUrl)
  await OpenProject(Page, 'Markdown')
  const Frame = Page.getByTestId('text-item')
  const Markdown = Frame.getByTestId('markdown-content')
  for (const Tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'pre', 'hr']) await Expect(Markdown.locator(Tag)).toHaveCount(1)
  await Expect(Markdown.locator('h1')).toHaveText('Markdown 参考笔记')
  await Expect(Markdown.locator('h1')).toHaveCSS('font-size', '36px')
  await Expect(Markdown.locator('em')).toHaveText('斜体')
  await Expect(Markdown.locator('del')).toHaveText('已废弃')
  await Expect(Markdown.locator('ul ul li')).toHaveText('嵌套列表')
  await Expect(Markdown.locator('ol')).toHaveAttribute('start', '3')
  await Expect(Markdown.locator('.markdown-checkbox')).toHaveText(['☑', '☐'])
  await Expect(Markdown.locator('td').last()).toHaveCSS('text-align', /right$/)
  await Expect(Markdown.locator('pre code')).toHaveText('const Value = "<tag>"\n  console.log(Value)\n')
  await Expect(Markdown.locator('a')).toHaveCount(2)
  const PictureElement = Markdown.locator('img')
  await Expect(PictureElement).toHaveAttribute('src', /^data:image\/png;base64,/)
  await Expect.poll(() => PictureElement.evaluate(Image => (Image as HTMLImageElement).naturalWidth)).toBe(280)
  await Frame.click({ position: { x: 20, y: 20 } })
  await CaptureClipboard(Page)
  const Captured = await CopySnapshot(Page)
  const Snapshot = Buffer.from(Captured.png, 'base64')
  const Raw = await Sharp(Snapshot).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  Expect([Raw.info.width, Raw.info.height]).toEqual([760, 1480])
  Expect(Raw.data.every((Channel, Index) => Index % 4 !== 3 || Channel === 255)).toBe(true)
  const FrameBounds = (await Frame.boundingBox())!, ImageBounds = (await PictureElement.boundingBox())!
  const Scale = FrameBounds.width / 760
  const SampleX = Math.floor((ImageBounds.x + ImageBounds.width / 2 - FrameBounds.x) / Scale)
  const SampleY = Math.floor((ImageBounds.y + ImageBounds.height / 2 - FrameBounds.y) / Scale)
  const Offset = (SampleY * 760 + SampleX) * 4
  Expect(Array.from(Raw.data.subarray(Offset, Offset + 4))).toEqual([36, 147, 193, 255])
  await WriteFile(Join(ModuleRoot, 'Runtime/MarkdownSnapshot.png'), Snapshot)
  await Page.screenshot({ path: Join(ModuleRoot, 'Runtime/MarkdownCanvas.png') })
  await Page.setViewportSize({ width: 1180, height: 1800 })
  await Page.getByTestId('fit').click()
  await Page.getByTestId('zoom').click()
  const Reference = await Page.screenshot({ clip: (await Frame.boundingBox())!, path: Join(ModuleRoot, 'Runtime/MarkdownDom.png'),
    style: '.selection-box,.text-settings-button,.connection-handle{visibility:hidden}.board-text{outline:none}' })
  const ReferenceRaw = await Sharp(Reference).ensureAlpha().raw().toBuffer()
  let DifferentChannels = 0
  for (let Index = 0; Index < Raw.data.length; Index++) if (Math.abs(Raw.data[Index] - ReferenceRaw[Index]) > 3) DifferentChannels++
  Expect(DifferentChannels / Raw.data.length).toBeLessThan(0.015)
  // Cached local image bytes keep export working even if the original file disappears.
  await Rm(Join(ResourceFolder, PictureName))
  Expect((await CopySnapshot(Page)).png).toBe(Captured.png)
  await WriteFile(Join(ResourceFolder, PictureName), Picture)
  await Frame.dblclick({ position: { x: 20, y: 20 } })
  await Expect(Page.getByTestId('text-content')).toHaveValue(Content)
  const Updated = Content.replace('Markdown 参考笔记', '修改后的 Markdown')
  await Page.getByTestId('text-content').fill(Updated)
  await Page.keyboard.press('Control+Enter')
  await Expect(Markdown.locator('h1')).toHaveText('修改后的 Markdown')
  await Page.keyboard.press('Control+z')
  await Expect(Markdown.locator('h1')).toHaveText('Markdown 参考笔记')
  await Page.keyboard.press('Control+Shift+z')
  await Expect(Markdown.locator('h1')).toHaveText('修改后的 Markdown')
  await Page.getByTestId('cleanup-resources').click()
  await Expect(Page.locator('.message')).toContainText('清理')
  await Expect(Page.getByTestId('open')).toBeEnabled()
  const Saved = Parse(await ReadFile(Project, 'utf8'))
  Expect(Parse(await ReadFile(Join(Folder, Saved.texts[0].asset), 'utf8')).content).toBe(Updated)
  Expect(await ReadFile(Join(ResourceFolder, PictureName))).toEqual(Picture)
  await Page.reload()
  await Expect(Markdown.locator('h1')).toHaveText('修改后的 Markdown')
  await Expect(PictureElement).toHaveAttribute('src', /^data:image\/png;base64,/)
})

Test('Markdown strips active HTML, opens links only with Ctrl-click, and renders remote or missing images', async ({ page: Page, context: Context }) => {
  const Png = await Sharp({ create: { width: 80, height: 40, channels: 3, background: '#499566' } }).png().toBuffer()
  await Page.route('**/api/markdown-image', async Route => {
    const Body = Route.request().postDataJSON()
    if (Body.source !== 'https://images.example.test/photo.png') { await Route.continue(); return }
    await Route.fulfill({ json: { id: 'test-image', dataUrl: `data:image/png;base64,${Png.toString('base64')}`, width: 80, height: 40 } })
  })
  await Context.route('https://example.com/**', Route => Route.fulfill({ contentType: 'text/html', body: '<title>Reference</title>' }))
  await Page.goto(ServiceUrl)
  await Page.getByTestId('add-text').click()
  const Source = '[安全链接](https://example.com)\n\n![网络图片](https://images.example.test/photo.png) ![缺图](Missing.png)\n\n<script>window.MarkdownExecuted=true</script>\n<img src="javascript:alert(1)" onerror="window.MarkdownExecuted=true">\n<a href="javascript:alert(1)">危险链接</a>\n<div class="toolbar" style="position:fixed;inset:0" onclick="alert(1)">普通内容</div>\n<form><input autofocus></form>\n<iframe src="https://example.com"></iframe>'
  await Page.getByTestId('text-content').fill(Source)
  await Page.keyboard.press('Control+Enter')
  const Markdown = Page.getByTestId('markdown-content')
  await Expect(Markdown.locator('img[alt="网络图片"]')).toHaveAttribute('src', /^data:image\/png;base64,/)
  await Expect(Markdown.locator('.markdown-image-missing')).toHaveCount(2)
  await Expect(Markdown.locator('script, iframe, form, input, [onclick], [onerror], [style], .toolbar')).toHaveCount(0)
  Expect(await Page.evaluate(() => 'MarkdownExecuted' in window)).toBe(false)
  await Expect(Markdown.getByText('危险链接')).not.toHaveAttribute('href')
  const Link = Markdown.getByRole('link', { name: '安全链接' })
  await Link.click()
  Expect(Context.pages()).toHaveLength(1)
  const Popup = Context.waitForEvent('page')
  await Link.click({ modifiers: ['Control'] })
  const Reference = await Popup
  await Expect(Reference).toHaveTitle('Reference')
  await Reference.close()
  await Page.bringToFront()
  await CaptureClipboard(Page)
  await CopySnapshot(Page)
  await Page.getByTestId('text-item').dblclick({ position: { x: 12, y: 80 } })
  await Expect(Page.getByTestId('text-content')).toHaveValue(Source)
})

async function DrawArrow(Page: Page, Start: { x: number; y: number }, End: { x: number; y: number }): Promise<void> {
  await Page.getByTestId('add-arrow').click()
  await Page.mouse.move(Start.x, Start.y)
  await Page.mouse.down()
  await Page.mouse.move(End.x, End.y, { steps: 8 })
  await Page.mouse.up()
}

async function ReadArrowEndpoints(Page: Page): Promise<{ start: { x: number; y: number }; end: { x: number; y: number } }> {
  return Page.getByTestId('arrow-line').first().evaluate((Element) => {
    const Path = Element as SVGPathElement
    const Start = Path.getPointAtLength(0).matrixTransform(Path.getScreenCTM()!)
    const End = Path.getPointAtLength(Path.getTotalLength()).matrixTransform(Path.getScreenCTM()!)
    return { start: { x: Start.x, y: Start.y }, end: { x: End.x, y: End.y } }
  })
}

Test('arrows support orthogonal drawing, endpoint and bend editing, styles, PNG copy and persistent YAML', async ({ page: Page }) => {
  await Page.goto(ServiceUrl)
  await Expect(Page.getByTestId('add-arrow')).toBeEnabled()
  await DrawArrow(Page, { x: 260, y: 200 }, { x: 880, y: 500 })
  const Arrow = Page.getByTestId('arrow-item'), Line = Page.getByTestId('arrow-line')
  await Expect(Arrow).toHaveCount(1)
  await Expect(Page.getByTestId('add-arrow')).toHaveAttribute('aria-pressed', 'false')
  await Expect(Line).toHaveAttribute('stroke', '#FFFFFF')
  await Expect(Page.getByTestId('arrow-settings')).toHaveCSS('color', 'rgb(255, 255, 255)')
  const Initial = await ReadArrowEndpoints(Page)
  Expect(Initial).toEqual({ start: { x: 260, y: 200 }, end: { x: 880, y: 500 } })
  const Bend = (await Page.getByTestId('arrow-bend').boundingBox())!
  const InitialPath = await Line.getAttribute('d')
  await Page.mouse.move(Bend.x + Bend.width / 2, Bend.y + Bend.height / 2)
  await Page.mouse.down(); await Page.mouse.move(Bend.x + 100, Bend.y + Bend.height / 2, { steps: 6 }); await Page.mouse.up()
  await Expect(Line).not.toHaveAttribute('d', InitialPath!)
  Expect(await ReadArrowEndpoints(Page)).toEqual(Initial)
  const BentPath = await Line.getAttribute('d')
  await Page.keyboard.press('Control+z'); await Expect(Line).toHaveAttribute('d', InitialPath!)
  await Page.keyboard.press('Control+Shift+z'); await Expect(Line).toHaveAttribute('d', BentPath!)
  const End = (await Page.getByTestId('arrow-end').boundingBox())!
  await Page.mouse.move(End.x + End.width / 2, End.y + End.height / 2)
  await Page.mouse.down(); await Page.mouse.move(950, 590, { steps: 6 }); await Page.mouse.up()
  Expect((await ReadArrowEndpoints(Page)).end).toEqual({ x: 950, y: 590 })
  await Page.getByTestId('arrow-settings').click()
  await Page.getByTestId('arrow-color').fill('#ff4400')
  await Page.getByTestId('arrow-thickness').fill('4')
  await Page.getByTestId('arrow-dashed').click()
  await Expect(Line).toHaveAttribute('stroke', '#ff4400')
  await Expect(Line).toHaveAttribute('stroke-dasharray', '16 12')
  await Page.getByTestId('arrow-cancel').click()
  await Expect(Line).toHaveAttribute('stroke', '#FFFFFF')
  await Expect(Line).not.toHaveAttribute('stroke-dasharray')
  await Page.getByTestId('arrow-settings').click()
  await Page.getByTestId('arrow-color').fill('#ff4400')
  await Page.getByTestId('arrow-thickness').fill('4')
  await Page.getByTestId('arrow-dashed').click()
  await Page.getByTestId('arrow-apply').click()
  await Page.keyboard.press('Control+z'); await Expect(Line).toHaveAttribute('stroke', '#FFFFFF')
  await Page.keyboard.press('Control+Shift+z'); await Expect(Line).toHaveAttribute('stroke', '#ff4400')
  const Settings = (await Page.getByTestId('arrow-settings').boundingBox())!, Box = (await Arrow.boundingBox())!
  Expect(Settings.x).toBeGreaterThan(Box.x + Box.width)
  Expect(Settings.y + Settings.height).toBeCloseTo(Box.y + Box.height)
  await Page.getByTestId('arrow-settings').click()
  await Page.screenshot({ path: Join(ModuleRoot, 'Runtime/ArrowSettings.png') })
  await Page.getByTestId('arrow-apply').click()
  await CaptureClipboard(Page)
  const Png = Buffer.from((await CopySnapshot(Page)).png, 'base64')
  const Raw = await Sharp(Png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  Expect(Raw.data.every((Channel, Index) => Index % 4 !== 3 || Channel === 255)).toBe(true)
  const Colored = []
  for (let X = 20; X < 150; X++) { const Offset = (12 * Raw.info.width + X) * 4; Colored.push(Raw.data[Offset] > 230 && Raw.data[Offset + 1] > 50 && Raw.data[Offset + 1] < 90) }
  Expect(Colored.some(Boolean)).toBe(true); Expect(Colored.some((Value) => !Value)).toBe(true)
  await WriteFile(Join(ModuleRoot, 'Runtime/ArrowSnapshot.png'), Png)
  await Page.keyboard.press('Control+s')
  await ChooseProjectName(Page, 'ArrowFree')
  await Expect(Page).toHaveTitle('ArrowFree.hbr — HybridRef')
  const Project = Join(ProjectDirectory, 'ArrowFree/ArrowFree.hbr')
  const Saved = Parse(await ReadFile(Project, 'utf8'))
  Expect(Saved.arrows).toHaveLength(1)
  Expect(Saved.formatVersion).toBe(4)
  Expect(Saved.arrows[0].arrow).toMatchObject({ color: '#ff4400', dashed: true, thickness: 4 })
  await Page.getByTestId('cleanup-resources').click()
  await Expect(Page.getByTestId('open')).toBeEnabled()
  await Page.reload()
  await Expect(Line).toHaveAttribute('stroke-dasharray', '16 12')
  await Page.keyboard.press('Control+a'); await Page.keyboard.press('Space')
  await ExpectSelectionFitted(Page)
  await Page.keyboard.press('Control+d'); await Expect(Arrow).toHaveCount(2)
  await Page.keyboard.press('Delete'); await Expect(Arrow).toHaveCount(1)
  await Page.keyboard.press('Control+z'); await Expect(Arrow).toHaveCount(2)
})

Test('arrow bindings follow image and text objects, remap copies and survive deletion undo and reload', async ({ page: Page }) => {
  await Page.goto(ServiceUrl)
  await Expect(Page.getByTestId('open')).toBeEnabled()
  await DropImages(Page, [Sources[0]])
  const Image = Page.getByTestId('image-item')
  await Expect(Image).toHaveCount(1)
  const InitialImage = (await Image.boundingBox())!
  await Page.mouse.move(InitialImage.x + InitialImage.width / 2, InitialImage.y + InitialImage.height / 2)
  await Page.mouse.down(); await Page.mouse.move(320, 300, { steps: 6 }); await Page.mouse.up()
  await Page.getByTestId('add-text').click()
  await Page.getByTestId('text-content').fill('## 目标说明\n图片通过箭头连接到这里。')
  await Page.keyboard.press('Control+Enter')
  const Text = Page.getByTestId('text-item'), TextBox = (await Text.boundingBox())!
  await Page.mouse.move(TextBox.x + TextBox.width / 2, TextBox.y + TextBox.height / 2)
  await Page.mouse.down(); await Page.mouse.move(930, 620, { steps: 6 }); await Page.mouse.up()
  const ImageBox = (await Image.boundingBox())!, TargetBox = (await Text.boundingBox())!
  await DrawArrow(Page, { x: ImageBox.x + ImageBox.width, y: ImageBox.y + ImageBox.height / 2 }, { x: TargetBox.x, y: TargetBox.y + TargetBox.height / 2 })
  await Expect(Page.getByTestId('arrow-item')).toHaveCount(1)
  await Image.click()
  await Page.mouse.move(ImageBox.x + ImageBox.width / 2, ImageBox.y + ImageBox.height / 2)
  await Page.mouse.down(); await Page.mouse.move(ImageBox.x + ImageBox.width / 2 + 70, ImageBox.y + ImageBox.height / 2 + 30, { steps: 6 }); await Page.mouse.up()
  const MovedImage = (await Image.boundingBox())!, MovedEnds = await ReadArrowEndpoints(Page)
  Expect(MovedEnds.start.x).toBeCloseTo(MovedImage.x + MovedImage.width)
  Expect(MovedEnds.start.y).toBeCloseTo(MovedImage.y + MovedImage.height / 2)
  await Page.keyboard.press('Delete')
  await Expect(Image).toHaveCount(0); await Expect(Page.getByTestId('arrow-item')).toHaveCount(1)
  Expect(await ReadArrowEndpoints(Page)).toEqual(MovedEnds)
  await Page.keyboard.press('Control+z'); await Expect(Image).toHaveCount(1)
  await Page.keyboard.press('Control+a'); await Page.keyboard.press('Control+d')
  await Expect(Page.getByTestId('arrow-item')).toHaveCount(2)
  await Page.keyboard.press('Control+s'); await ChooseProjectName(Page, 'ArrowBindings')
  await Expect(Page).toHaveTitle('ArrowBindings.hbr — HybridRef')
  const Project = Join(ProjectDirectory, 'ArrowBindings/ArrowBindings.hbr')
  const Saved = Parse(await ReadFile(Project, 'utf8'))
  const Arrows = Saved.arrows as BoardArrow[]
  Expect(Arrows[0].arrow.startBinding?.id).toBe(Saved.images[0].id)
  Expect(Arrows[1].arrow.startBinding?.id).toBe(Saved.images[1].id)
  Expect(Arrows[0].arrow.endBinding?.id).toBe(Saved.texts[0].id)
  Expect(Arrows[1].arrow.endBinding?.id).toBe(Saved.texts[1].id)
  await Page.keyboard.press('Control+z')
  await Expect(Page.getByTestId('arrow-item')).toHaveCount(1)
  await Page.keyboard.press('Control+s')
  await Expect(Page).toHaveTitle('ArrowBindings.hbr — HybridRef')
  await Page.reload(); await Expect(Page.getByTestId('arrow-item')).toHaveCount(1)
  const LoadedImage = (await Image.boundingBox())!
  await Page.mouse.move(LoadedImage.x + LoadedImage.width / 2, LoadedImage.y + LoadedImage.height / 2)
  await Page.mouse.down(); await Page.mouse.move(LoadedImage.x + LoadedImage.width / 2 - 45, LoadedImage.y + LoadedImage.height / 2 + 20, { steps: 6 }); await Page.mouse.up()
  const ReloadedEnds = await ReadArrowEndpoints(Page)
  Expect(ReloadedEnds.start.x).toBeCloseTo(MovedEnds.start.x - 45)
  Expect(ReloadedEnds.start.y).toBeCloseTo(MovedEnds.start.y + 20)
  await Page.keyboard.press('Control+a'); await Page.keyboard.press('Space')
  await CaptureClipboard(Page); await CopySnapshot(Page)
  await Page.screenshot({ path: Join(ModuleRoot, 'Runtime/ArrowCanvas.png') })
})

Test('arrow creation cancels empty gestures and Escape without changing the board', async ({ page: Page }) => {
  await Page.goto(ServiceUrl)
  await Expect(Page.getByTestId('add-arrow')).toBeEnabled()
  await DrawArrow(Page, { x: 300, y: 220 }, { x: 301, y: 220 })
  await Expect(Page.getByTestId('arrow-item')).toHaveCount(0)
  await Expect(Page.getByTestId('save')).toHaveAttribute('aria-label', '保存')
  await Page.getByTestId('add-arrow').click()
  await Page.mouse.move(300, 220); await Page.mouse.down(); await Page.mouse.move(600, 450, { steps: 6 })
  await Expect(Page.getByTestId('arrow-item')).toHaveCount(1)
  await Page.keyboard.press('Escape'); await Page.mouse.up()
  await Expect(Page.getByTestId('arrow-item')).toHaveCount(0)
  await Expect(Page.getByTestId('save')).toHaveAttribute('aria-label', '保存')
  await Expect(Page.getByTestId('add-arrow')).toHaveAttribute('aria-pressed', 'false')
})

Test('Alt leaves arrow endpoints free when drawing over an existing object', async ({ page: Page }) => {
  await Page.goto(ServiceUrl)
  await Page.getByTestId('add-text').click()
  await Page.getByTestId('text-content').fill('自由连线起点')
  await Page.keyboard.press('Control+Enter')
  const Box = (await Page.getByTestId('text-item').boundingBox())!
  const Start = { x: Box.x + Box.width / 2, y: Box.y + Box.height / 2 }
  await Page.getByTestId('add-arrow').click()
  await Page.keyboard.down('Alt')
  await Page.mouse.move(Start.x, Start.y); await Page.mouse.down(); await Page.mouse.move(1100, 700, { steps: 6 }); await Page.mouse.up()
  await Page.keyboard.up('Alt')
  const Endpoints = await ReadArrowEndpoints(Page)
  Expect(Endpoints.start.x).toBeCloseTo(Start.x); Expect(Endpoints.start.y).toBeCloseTo(Start.y)
  Expect(Endpoints.end).toEqual({ x: 1100, y: 700 })
})

async function OpenConnectionBoard(Page: Page): Promise<{ image: string; text: string }> {
  await Page.goto(ServiceUrl)
  await Expect(Page.getByTestId('open')).toBeEnabled()
  await DropImages(Page, [Sources[0]])
  const Image = Page.getByTestId('image-item'), ImageBox = (await Image.boundingBox())!
  await Page.mouse.move(ImageBox.x + ImageBox.width / 2, ImageBox.y + ImageBox.height / 2)
  await Page.mouse.down(); await Page.mouse.move(320, 300, { steps: 6 }); await Page.mouse.up()
  await Page.getByTestId('add-text').click()
  await Page.getByTestId('text-content').fill('## 连接目标\n从四边 handle 拖动连线。')
  await Page.keyboard.press('Control+Enter')
  const Text = Page.getByTestId('text-item'), TextBox = (await Text.boundingBox())!
  await Page.mouse.move(TextBox.x + TextBox.width / 2, TextBox.y + TextBox.height / 2)
  await Page.mouse.down(); await Page.mouse.move(930, 580, { steps: 6 }); await Page.mouse.up()
  return { image: (await Image.getAttribute('data-image-id'))!, text: (await Text.getAttribute('data-text-id'))! }
}

function ConnectionHandle(Page: Page, Id: string, Side: string) {
  return Page.locator(`[data-testid="connection-handle"][data-item-id="${Id}"][data-side="${Side}"]`)
}

Test('four handles on images and text create bound lines directly, with snapping, undo and persistence', async ({ page: Page }) => {
  const Ids = await OpenConnectionBoard(Page)
  const Image = Page.getByTestId('image-item'), Text = Page.getByTestId('text-item')
  await Image.click()
  await Expect(Page.getByTestId('connection-handle')).toHaveCount(4)
  await Expect(Page.getByTestId('resize-nw')).toBeVisible()
  const ImageBox = (await Image.boundingBox())!, TextBox = (await Text.boundingBox())!
  const Right = ConnectionHandle(Page, Ids.image, 'right'), RightBox = (await Right.boundingBox())!
  Expect(RightBox.x + RightBox.width / 2).toBeCloseTo(ImageBox.x + ImageBox.width + 20)
  Expect(RightBox.y + RightBox.height / 2).toBeCloseTo(ImageBox.y + ImageBox.height / 2)
  await Page.screenshot({ path: Join(ModuleRoot, 'Runtime/ConnectionHandles.png') })
  await Page.mouse.move(RightBox.x + RightBox.width / 2, RightBox.y + RightBox.height / 2)
  await Page.mouse.down()
  await Expect(Page.getByTestId('connection-handle')).toHaveCount(8)
  const Target = ConnectionHandle(Page, Ids.text, 'left'), TargetBox = (await Target.boundingBox())!
  await Page.mouse.move(TargetBox.x + TargetBox.width / 2 + 4, TargetBox.y + TargetBox.height / 2 + 5, { steps: 8 })
  await Expect(Target).toHaveAttribute('data-active', 'true')
  const Ends = await ReadArrowEndpoints(Page)
  Expect(Ends.start.x).toBeCloseTo(ImageBox.x + ImageBox.width)
  Expect(Ends.start.y).toBeCloseTo(ImageBox.y + ImageBox.height / 2)
  Expect(Ends.end.x).toBeCloseTo(TextBox.x)
  Expect(Ends.end.y).toBeCloseTo(TextBox.y + TextBox.height / 2)
  await Page.screenshot({ path: Join(ModuleRoot, 'Runtime/ConnectionSnapping.png') })
  await Page.mouse.up()
  await Expect(Page.getByTestId('connection-handle')).toHaveCount(0)
  await Expect(Page.getByTestId('arrow-item')).toHaveCount(1)
  await Expect(Page.getByTestId('add-arrow')).toHaveAttribute('aria-pressed', 'false')
  Expect(await Image.boundingBox()).toEqual(ImageBox); Expect(await Text.boundingBox()).toEqual(TextBox)
  await Page.keyboard.press('Control+z'); await Expect(Page.getByTestId('arrow-item')).toHaveCount(0)
  await Page.keyboard.press('Control+Shift+z'); await Expect(Page.getByTestId('arrow-item')).toHaveCount(1)
  await Page.keyboard.press('Control+s'); await ChooseProjectName(Page, 'HandleConnections')
  await Expect(Page).toHaveTitle('HandleConnections.hbr — HybridRef')
  const Saved = Parse(await ReadFile(Join(ProjectDirectory, 'HandleConnections/HandleConnections.hbr'), 'utf8'))
  Expect(Saved.arrows[0].arrow.startBinding).toEqual({ id: Ids.image, side: 'right', offset: 0.5 })
  Expect(Saved.arrows[0].arrow.endBinding).toEqual({ id: Ids.text, side: 'left', offset: 0.5 })
  await Page.reload()
  await Expect(Page.getByTestId('arrow-item')).toHaveCount(1)
  await Text.click()
  const Resize = (await Page.getByTestId('resize-se').boundingBox())!
  await Page.mouse.move(Resize.x + Resize.width / 2, Resize.y + Resize.height / 2)
  await Page.mouse.down(); await Page.mouse.move(Resize.x + 80, Resize.y + 65, { steps: 6 }); await Page.mouse.up()
  const Resized = (await Text.boundingBox())!, ResizedEnds = await ReadArrowEndpoints(Page)
  Expect(ResizedEnds.end.x).toBeCloseTo(Resized.x)
  Expect(ResizedEnds.end.y).toBeCloseTo(Resized.y + Resized.height / 2)
  await Page.mouse.move(Resized.x + Resized.width / 2, Resized.y + Resized.height / 2)
  await Page.mouse.down(); await Page.mouse.move(Resized.x + Resized.width / 2 - 60, Resized.y + Resized.height / 2 - 40, { steps: 6 }); await Page.mouse.up()
  const Moved = (await Text.boundingBox())!, MovedEnds = await ReadArrowEndpoints(Page)
  Expect(MovedEnds.end.x).toBeCloseTo(Moved.x)
  Expect(MovedEnds.end.y).toBeCloseTo(Moved.y + Moved.height / 2)
})

Test('every source handle draws a line and can snap to a different target direction', async ({ page: Page }) => {
  const Ids = await OpenConnectionBoard(Page)
  const Cases = [
    { source: 'image', side: 'left', target: 'text', end: 'top' },
    { source: 'image', side: 'right', target: 'text', end: 'bottom' },
    { source: 'text', side: 'top', target: 'image', end: 'right' },
    { source: 'text', side: 'bottom', target: 'image', end: 'left' },
  ] as const
  for (const Case of Cases) {
    await Page.getByTestId(`${Case.source}-item`).click()
    const Handle = (await ConnectionHandle(Page, Ids[Case.source], Case.side).boundingBox())!
    await Page.mouse.move(Handle.x + Handle.width / 2, Handle.y + Handle.height / 2); await Page.mouse.down()
    const Target = ConnectionHandle(Page, Ids[Case.target], Case.end), Box = (await Target.boundingBox())!
    await Page.mouse.move(Box.x + Box.width / 2, Box.y + Box.height / 2, { steps: 8 })
    await Expect(Target).toHaveAttribute('data-active', 'true')
    await Page.mouse.up()
    await Expect(Page.getByTestId('arrow-item')).toHaveCount(1)
    const Directions = await Page.getByTestId('arrow-line').evaluate((Element) => {
      const Path = Element as SVGPathElement, Length = Path.getTotalLength()
      const Start = Path.getPointAtLength(0), After = Path.getPointAtLength(1), End = Path.getPointAtLength(Length), Before = Path.getPointAtLength(Length - 1)
      return [{ x: After.x - Start.x, y: After.y - Start.y }, { x: Before.x - End.x, y: Before.y - End.y }]
    })
    for (const [Index, Side] of [Case.side, Case.end].entries()) {
      const Horizontal = Side === 'left' || Side === 'right'
      Expect(Directions[Index][Horizontal ? 'y' : 'x']).toBeCloseTo(0)
      Expect(Directions[Index][Horizontal ? 'x' : 'y'] * (Side === 'left' || Side === 'top' ? -1 : 1)).toBeGreaterThan(0)
    }
    await Page.keyboard.press('Control+z'); await Expect(Page.getByTestId('arrow-item')).toHaveCount(0)
  }
})

Test('connection handles retain screen size while zoomed and cancel clicks, Escape and pointer cancellation', async ({ page: Page }) => {
  const Ids = await OpenConnectionBoard(Page)
  const Image = Page.getByTestId('image-item')
  await Image.click()
  const Handle = ConnectionHandle(Page, Ids.image, 'bottom'), Before = (await Handle.boundingBox())!
  await Page.mouse.move(400, 320); await Page.mouse.wheel(0, 420)
  await Expect.poll(async () => (await Image.boundingBox())!.width).toBeLessThan(200)
  const ZoomedImage = (await Image.boundingBox())!, After = (await Handle.boundingBox())!
  Expect(After.width).toBe(Before.width); Expect(After.height).toBe(Before.height)
  Expect(After.y + After.height / 2).toBeCloseTo(ZoomedImage.y + ZoomedImage.height + 20, 1)
  await Handle.click()
  await Expect(Page.getByTestId('arrow-item')).toHaveCount(0)
  await Expect(Handle).toBeVisible()
  const Start = { x: After.x + After.width / 2, y: After.y + After.height / 2 }
  await Page.mouse.move(Start.x, Start.y); await Page.mouse.down(); await Page.mouse.move(Start.x + 2, Start.y + 1); await Page.mouse.up()
  await Expect(Page.getByTestId('arrow-item')).toHaveCount(0)
  await Page.mouse.move(Start.x, Start.y); await Page.mouse.down(); await Page.mouse.move(650, 650, { steps: 6 })
  await Expect(Page.getByTestId('arrow-item')).toHaveCount(1)
  await Page.keyboard.press('Escape'); await Page.mouse.up()
  await Expect(Page.getByTestId('arrow-item')).toHaveCount(0)
  await Expect(Handle).toBeVisible()
  await Page.mouse.move(Start.x, Start.y); await Page.mouse.down(); await Page.mouse.move(650, 650, { steps: 6 })
  await Page.getByTestId('canvas').dispatchEvent('pointercancel')
  await Page.mouse.up()
  await Expect(Page.getByTestId('arrow-item')).toHaveCount(0)
  await Expect(Handle).toBeVisible()
  // Space over the same handle still pans, never creating an arrow.
  await Page.keyboard.down('Space')
  await Page.mouse.move(Start.x, Start.y); await Page.mouse.down(); await Page.mouse.move(Start.x + 45, Start.y + 35, { steps: 6 }); await Page.mouse.up()
  await Page.keyboard.up('Space')
  await Expect(Page.getByTestId('arrow-item')).toHaveCount(0)
  Expect((await Image.boundingBox())!.x).toBeCloseTo(ZoomedImage.x + 45, 1)
  // The same screen-space tolerance snaps to the visible handle after zoom/pan.
  const NewHandle = (await Handle.boundingBox())!
  await Page.mouse.move(NewHandle.x + NewHandle.width / 2, NewHandle.y + NewHandle.height / 2); await Page.mouse.down()
  const Target = ConnectionHandle(Page, Ids.text, 'top'), TargetBox = (await Target.boundingBox())!
  await Page.mouse.move(TargetBox.x + TargetBox.width / 2 + 7, TargetBox.y + TargetBox.height / 2 + 6, { steps: 6 })
  await Expect(Target).toHaveAttribute('data-active', 'true')
  await Page.mouse.up()
  const TextBox = (await Page.getByTestId('text-item').boundingBox())!, Ends = await ReadArrowEndpoints(Page)
  Expect(Ends.end.x).toBeCloseTo(TextBox.x + TextBox.width / 2, 1); Expect(Ends.end.y).toBeCloseTo(TextBox.y, 1)
})

Test('existing line endpoints reconnect to handles with Alt temporarily disabling snapping', async ({ page: Page }) => {
  const Ids = await OpenConnectionBoard(Page)
  await DrawArrow(Page, { x: 580, y: 220 }, { x: 680, y: 460 })
  const Original = await ReadArrowEndpoints(Page)
  const End = (await Page.getByTestId('arrow-end').boundingBox())!
  await Page.mouse.move(End.x + End.width / 2, End.y + End.height / 2); await Page.mouse.down()
  const Target = ConnectionHandle(Page, Ids.text, 'top'), TargetBox = (await Target.boundingBox())!
  const Pointer = { x: TargetBox.x + TargetBox.width / 2 + 5, y: TargetBox.y + TargetBox.height / 2 + 3 }
  await Page.mouse.move(Pointer.x, Pointer.y, { steps: 8 })
  await Expect(Target).toHaveAttribute('data-active', 'true')
  await Page.keyboard.down('Alt'); await Page.mouse.move(Pointer.x + 1, Pointer.y + 1)
  await Expect(Target).toHaveAttribute('data-active', 'false')
  Expect((await ReadArrowEndpoints(Page)).end).toEqual({ x: Pointer.x + 1, y: Pointer.y + 1 })
  await Page.keyboard.up('Alt'); await Page.mouse.move(Pointer.x, Pointer.y)
  await Expect(Target).toHaveAttribute('data-active', 'true')
  await Page.mouse.up()
  const TextBox = (await Page.getByTestId('text-item').boundingBox())!, Connected = await ReadArrowEndpoints(Page)
  Expect(Connected.start).toEqual(Original.start)
  Expect(Connected.end.x).toBeCloseTo(TextBox.x + TextBox.width / 2)
  Expect(Connected.end.y).toBeCloseTo(TextBox.y)
  const Start = (await Page.getByTestId('arrow-start').boundingBox())!
  await Page.mouse.move(Start.x + Start.width / 2, Start.y + Start.height / 2); await Page.mouse.down()
  const Source = ConnectionHandle(Page, Ids.image, 'right'), SourceBox = (await Source.boundingBox())!
  await Page.mouse.move(SourceBox.x + SourceBox.width / 2, SourceBox.y + SourceBox.height / 2, { steps: 8 })
  await Expect(Source).toHaveAttribute('data-active', 'true')
  await Page.mouse.up()
  await CaptureClipboard(Page)
  const Png = Buffer.from((await CopySnapshot(Page)).png, 'base64')
  await WriteFile(Join(ModuleRoot, 'Runtime/ConnectionSnapshot.png'), Png)
  await Page.screenshot({ path: Join(ModuleRoot, 'Runtime/ConnectionCrossDirections.png') })
  await Page.keyboard.press('Control+z')
  Expect(await ReadArrowEndpoints(Page)).toEqual(Connected)
  await Page.keyboard.press('Control+z')
  Expect(await ReadArrowEndpoints(Page)).toEqual(Original)
  await Page.getByTestId('text-item').dblclick({ position: { x: 60, y: 50 } })
  await Expect(Page.getByTestId('text-content')).toBeVisible()
  await Expect(Page.getByTestId('connection-handle')).toHaveCount(0)
})
