import { test as Test, expect as Expect, type Page } from '@playwright/test'
import { spawn as Spawn, type ChildProcess } from 'node:child_process'
import { cp as Cp, mkdir as Mkdir, mkdtemp as Mkdtemp, readFile as ReadFile, stat as Stat } from 'node:fs/promises'
import { basename as Basename, dirname as Dirname, join as Join, resolve as Resolve } from 'node:path'
import { tmpdir as Tmpdir } from 'node:os'
import Sharp from 'sharp'
import { parse as Parse } from 'yaml'

const ModuleRoot = Resolve(__dirname, '..')
let Service: ChildProcess
let ServiceUrl: string
let Fixture: string
let ProjectDirectory: string

Test.beforeAll(async () => {
  Fixture = await Mkdtemp(Join(Tmpdir(), 'hybridref-browser-'))
  ProjectDirectory = Join(Fixture, 'Project')
  await Mkdir(ProjectDirectory)
  await Cp(Resolve(ModuleRoot, '../../Project/Demo'), Join(ProjectDirectory, 'Demo'), { recursive: true })
  const Runtime = Join(Fixture, 'Server.json')
  Service = Spawn(process.execPath, [Join(ModuleRoot, 'Output/Server/Index.cjs'), '--port', '0', '--runtime', Runtime, '--project-directory', ProjectDirectory], { cwd: Fixture, stdio: 'ignore', windowsHide: true })
  await Expect.poll(async () => {
    try { ServiceUrl = JSON.parse(await ReadFile(Runtime, 'utf8')).url; return (await fetch(`${ServiceUrl}/api/health`)).ok } catch { return false }
  }).toBe(true)
})
Test.afterAll(() => { Service?.kill() })

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

Test('browser editor preserves canvas interactions, clipboard events and real YAML files', async ({ page: Page }) => {
  Test.setTimeout(60_000)
  const Folder = Join(Fixture, '参考 # 100%')
  await Mkdir(Folder)
  const Project = Join(ProjectDirectory, 'BrowserRef', 'BrowserRef.hbr')
  const Sources = [Join(Folder, '海.jpg'), Join(Folder, '山.webp'), Join(Folder, '光.png')]
  for (let I = 0; I < Sources.length; I++) await Sharp({ create: { width: 300 + 80 * I, height: 200 + 50 * I, channels: 3, background: ['#497988', '#98617a', '#70956b'][I] } }).toFile(Sources[I])
  const Errors: string[] = []
  Page.on('pageerror', CaughtError => Errors.push(CaughtError.message))
  await Page.goto(ServiceUrl)
  await Expect(Page.getByTestId('canvas')).toBeVisible()
  await Expect(Page.getByTestId('open')).toBeEnabled()
  await Expect(Page.getByTestId('import')).toHaveCount(0)
  await Expect(Page.getByTestId('file-input')).toHaveCount(0)
  await DropImages(Page, Sources)
  const Images = Page.getByTestId('image-item')
  await Expect(Images).toHaveCount(3)
  await Expect.poll(() => Images.evaluateAll(Nodes => Nodes.every(Node => (Node as HTMLImageElement).complete && (Node as HTMLImageElement).naturalWidth > 0))).toBe(true)
  await Page.keyboard.press('Control+a')
  await Expect(Page.getByTestId('status')).toContainText('已选 3')
  const OldX = Number(await Images.first().getAttribute('data-x'))
  const First = (await Images.first().boundingBox())!
  await Page.mouse.move(First.x + First.width / 2, First.y + First.height / 2)
  await Page.mouse.down()
  await Page.mouse.move(First.x + First.width / 2 + 75, First.y + First.height / 2 + 35, { steps: 8 })
  await Page.mouse.up()
  Expect(Number(await Images.first().getAttribute('data-x'))).not.toBe(OldX)
  await Page.getByTestId('align-menu').click()
  await Page.getByTestId('align-top').click()
  Expect(new Set(await Images.evaluateAll(Nodes => Nodes.map(Node => Node.getAttribute('data-y')))).size).toBe(1)

  const Dimensions = await Images.evaluateAll(Nodes => Nodes.map(Node => [Number(Node.getAttribute('data-width')), Number(Node.getAttribute('data-height'))]))
  const Handle = (await Page.getByTestId('resize-se').boundingBox())!
  await Page.mouse.move(Handle.x + 4, Handle.y + 4)
  await Page.mouse.down()
  await Page.mouse.move(Handle.x + 120, Handle.y + 60, { steps: 8 })
  await Page.mouse.up()
  const Resized = await Images.evaluateAll(Nodes => Nodes.map(Node => [Number(Node.getAttribute('data-width')), Number(Node.getAttribute('data-height'))]))
  Expect(Resized[0][0]).toBeGreaterThan(Dimensions[0][0])
  Resized.forEach((Size, I) => Expect(Size[0] / Size[1]).toBeCloseTo(Dimensions[I][0] / Dimensions[I][1], 3))
  await Page.keyboard.press('Control+z')
  await Expect(Images.first()).toHaveAttribute('data-width', String(Dimensions[0][0]))
  await Page.keyboard.press('Control+Shift+z')
  await Page.getByTestId('fit').click()
  const PreviousZoom = await Page.getByTestId('zoom').textContent()
  await Page.mouse.move(650, 440)
  await Page.mouse.wheel(0, -150)
  await Expect(Page.getByTestId('zoom')).not.toHaveText(PreviousZoom!)
  const BeforePan = await Images.first().getAttribute('data-x')
  await Page.keyboard.down('Space')
  await Page.mouse.move(950, 730)
  await Page.mouse.down()
  await Page.mouse.move(750, 560, { steps: 8 })
  await Page.mouse.up()
  await Page.keyboard.up('Space')
  await Expect(Images.first()).toHaveAttribute('data-x', BeforePan!)
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
  Expect(Number(await Images.nth(2).getAttribute('data-x'))).toBeCloseTo(Number(await Images.nth(1).getAttribute('data-x')) + Number(await Images.nth(1).getAttribute('data-width')), 2)

  // Exercise the native browser ClipboardEvent paths without replacing the user's OS clipboard.
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
  const Saved = await ReadFile(Project, 'utf8')
  const Doc = Parse(Saved)
  Expect(Doc.images).toHaveLength(5)
  for (const Item of Doc.images) {
    Expect(Item.asset).toMatch(/^BrowserRefResource\/\d{13}_[A-F0-9]{8}\.png$/)
    Expect((await ReadFile(Join(Dirname(Project), Item.asset))).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
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
  Expect(Errors).toEqual([])
})

Test('project dropdown opens the existing demo and supports marquee/Shift selection', async ({ page: Page }) => {
  await Page.goto(ServiceUrl)
  await OpenProject(Page, 'Demo')
  await Expect(Page).toHaveTitle('Demo.hbr — HybridRef')
  const Images = Page.getByTestId('image-item')
  await Expect(Images).toHaveCount(3)
  await Expect(Page.getByTestId('file-dialog')).toHaveCount(0)
  await Mkdir(Resolve(ModuleRoot, 'Runtime/Logs'), { recursive: true })
  await Page.screenshot({ path: Resolve(ModuleRoot, 'Runtime/Logs/BrowserPreview.png') })
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
  await Cp(Resolve(ModuleRoot, '../../Project/Demo/Demo.hbr'), Join(Folder, 'Demo.hbr'))
  await Cp(Resolve(ModuleRoot, '../../Project/Demo/DemoResource'), Join(Folder, 'DemoResource'), { recursive: true })
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
  await Cp(Resolve(ModuleRoot, '../../Project/Demo/Demo.hbr'), Join(Folder, 'Demo.hbr'))
  await Cp(Resolve(ModuleRoot, '../../Project/Demo/DemoResource'), Join(Folder, 'DemoResource'), { recursive: true })
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
  await Cp(Resolve(ModuleRoot, '../../Project/Demo'), Join(ProjectDirectory, 'FreshlyAdded'), { recursive: true })
  await Page.getByTestId('canvas').click({ position: { x: 1250, y: 760 } })
  await Expect(Page.getByTestId('project-menu')).toHaveCount(0)
  await Page.getByTestId('open').click()
  await Expect(Page.getByTestId('project-entry').filter({ hasText: 'FreshlyAdded' })).toBeVisible()
  await Mkdir(Resolve(ModuleRoot, 'Runtime/Logs'), { recursive: true })
  await Page.screenshot({ path: Resolve(ModuleRoot, 'Runtime/Logs/ProjectMenuPreview.png') })
  await Page.getByTestId('new').click()
  await Page.getByTestId('file-name').fill('MyReference')
  await Page.screenshot({ path: Resolve(ModuleRoot, 'Runtime/Logs/NewProjectPreview.png') })
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
