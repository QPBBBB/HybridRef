import { test as Test, expect as Expect, type Page } from '@playwright/test'
import { spawn as Spawn, type ChildProcess } from 'node:child_process'
import { createHash as CreateHash } from 'node:crypto'
import { cp as Cp, mkdir as Mkdir, mkdtemp as Mkdtemp, readFile as ReadFile, rm as Rm, stat as Stat, writeFile as WriteFile } from 'node:fs/promises'
import { basename as Basename, dirname as Dirname, join as Join, resolve as Resolve } from 'node:path'
import { tmpdir as Tmpdir } from 'node:os'
import Sharp from 'sharp'
import { parse as Parse, stringify as Stringify } from 'yaml'
import { EmptyDocument, type BoardImage } from '../Source/Shared/Types'

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
    const Filename = `${1700000000000 + Index}_${HashPrefix}.png`
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
  // Use browser ClipboardEvent paths without replacing the user's OS clipboard.
  await Page.evaluate(() => {
    const Data = new DataTransfer()
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: Data, bubbles: true, cancelable: true }))
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: Data, bubbles: true, cancelable: true }))
  })
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
    Expect(Image.asset).toMatch(/^BrowserRefResource\/\d{13}_[A-F0-9]{8}\.png$/)
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
  await Expect(Page.getByTestId('text-editor')).toBeVisible()
  await Page.getByTestId('text-content').fill('设计标题\n中文多行说明：颜色与透明度')
  await Page.getByTestId('text-font-size').fill('32')
  await Page.getByTestId('text-font-weight').selectOption('700')
  await Page.getByTestId('text-font-color').fill('#ffcc33')
  await Page.getByTestId('text-font-opacity').fill('75')
  await Page.getByTestId('text-background-color').fill('#224466')
  await Page.getByTestId('text-background-opacity').fill('60')
  await Page.getByTestId('text-align').selectOption('center')
  await Page.getByTestId('text-line-height').fill('1.8')
  await Page.getByTestId('text-padding').fill('18')
  await Page.screenshot({ path: Join(ModuleRoot, 'Runtime/TextEditor.png') })
  await Page.getByTestId('text-content').focus()
  await Page.keyboard.press('Control+a')
  await Expect(Page.getByTestId('status')).toContainText('已选 1')
  // A composing Enter must neither complete the editor nor invoke canvas actions.
  await Page.getByTestId('text-content').evaluate(Element => Element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true })))
  await Expect(Page.getByTestId('text-editor')).toBeVisible()
  await Page.keyboard.press('Control+s')
  await Expect(Page.getByTestId('text-editor')).toHaveCount(0)
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
    Expect(Item.asset).toMatch(/^TextBoardResource\/Text_.*\.yaml$/)
    Resources.push(Parse(await ReadFile(Join(Dirname(Project), Item.asset), 'utf8')))
  }
  Expect(Doc.texts[0].asset).not.toBe(Doc.texts[1].asset)
  Expect(Resources.map(Resource => Resource.content)).toEqual(['设计标题\n中文多行说明：颜色与透明度', '独立副本'])
  Expect(Resources[0].font).toMatchObject({ family: 'Microsoft YaHei', size: 32, weight: 700, color: '#ffcc33', opacity: 0.75 })
  await Page.reload()
  await Expect(Texts).toHaveCount(2)
  await Expect(Page.getByTestId('image-item')).toHaveCount(3)
  await Expect(Texts.last()).toHaveText('独立副本')
  await Expect(Texts.first()).toHaveCSS('color', 'rgba(255, 204, 51, 0.75)')
  await Texts.last().dblclick()
  await Page.getByTestId('text-content').fill('未完成的草稿')
  await Expect(Page).toHaveTitle('* TextBoard.hbr — HybridRef')
  await Page.getByTestId('text-cancel').click()
  await Expect(Page).toHaveTitle('TextBoard.hbr — HybridRef')
  await Expect(Texts.last()).toHaveText('独立副本')
  await Page.screenshot({ path: Join(ModuleRoot, 'Runtime/TextModule.png') })
  Expect(Errors).toEqual([])
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
  await Page.evaluate(() => {
    const Data = new DataTransfer()
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: Data, bubbles: true, cancelable: true }))
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: Data, bubbles: true, cancelable: true }))
  })
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
  const Boxes = await Promise.all([Images.first().boundingBox(), Images.nth(1).boundingBox(), Images.nth(2).boundingBox(), Texts.first().boundingBox()])
  await Page.mouse.move(Math.min(...Boxes.map(Box => Box!.x)) - 10, Math.min(...Boxes.map(Box => Box!.y)) - 10)
  await Page.mouse.down()
  await Page.mouse.move(Math.max(...Boxes.map(Box => Box!.x + Box!.width)) + 10, Math.max(...Boxes.map(Box => Box!.y + Box!.height)) + 10, { steps: 5 })
  await Page.mouse.up()
  await Expect(Page.getByTestId('status')).toContainText('已选 4')
})
