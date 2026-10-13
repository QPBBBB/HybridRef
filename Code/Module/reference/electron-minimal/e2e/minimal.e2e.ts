import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { parse } from 'yaml'

test('minimal image board: import, selection, snapping, alignment, resize, zoom, clipboard and YAML', async () => {
  test.setTimeout(90_000)
  const root = resolve(__dirname, '..')
  const fixture = await mkdtemp(join(tmpdir(), 'hybridref-minimal-'))
  const folder = join(fixture, '参考 # 100%')
  await mkdir(folder)
  const project = join(folder, 'TestRef.hbr')
  const files = [join(folder, '海.jpg'), join(folder, '山.webp'), join(folder, '光.png')]
  for (let i = 0; i < files.length; i++) await sharp({ create: { width: 300 + i * 80, height: 200 + i * 50, channels: 3, background: ['#457b89', '#ae6479', '#6f906b'][i] } }).toFile(files[i])
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.HYBRIDREF_PROJECT
  const app = await electron.launch({ args: [root, `--user-data-dir=${join(fixture, 'profile')}`], env })
  let backup: { format: string; bytes: number[] }[] | undefined
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await expect(page.getByTestId('canvas')).toBeVisible()
    await expect(page.getByTestId('image-item')).toHaveCount(0)
    await app.evaluate(({ dialog }, sources) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: sources })
    }, files)
    await page.getByTestId('import').click()
    const items = page.getByTestId('image-item')
    await expect(items).toHaveCount(3)
    await expect.poll(() => items.evaluateAll(nodes => nodes.every(node => {
      const image = node instanceof HTMLImageElement ? node : node.querySelector('img')!
      return image?.complete && image.naturalWidth > 0
    }))).toBe(true)

    await page.keyboard.press('Control+a')
    await expect(page.getByTestId('selection-box')).toBeVisible()
    const beforeMove = await items.evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-x'))))
    const first = (await items.first().boundingBox())!
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
    await page.mouse.down()
    await page.mouse.move(first.x + first.width / 2 + 75, first.y + first.height / 2 + 35, { steps: 8 })
    await page.mouse.up()
    const afterMove = await items.evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-x'))))
    expect(afterMove[0]).not.toBe(beforeMove[0])
    expect(afterMove[1] - beforeMove[1]).toBeCloseTo(afterMove[0] - beforeMove[0], 2)

    await page.getByTestId('align-menu').click()
    await page.getByTestId('align-top').click()
    const tops = await items.evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-y'))))
    expect(new Set(tops).size).toBe(1)

    const originalSizes = await items.evaluateAll(nodes => nodes.map(node => [Number(node.getAttribute('data-width')), Number(node.getAttribute('data-height'))]))
    const handle = (await page.getByTestId('resize-se').boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + 130, handle.y + 60, { steps: 10 })
    await page.mouse.up()
    const sizes = await items.evaluateAll(nodes => nodes.map(node => [Number(node.getAttribute('data-width')), Number(node.getAttribute('data-height'))]))
    expect(sizes[0][0]).toBeGreaterThan(originalSizes[0][0])
    sizes.forEach((size, i) => expect(size[0] / size[1]).toBeCloseTo(originalSizes[i][0] / originalSizes[i][1], 3))
    await page.keyboard.press('Control+z')
    await expect(items.first()).toHaveAttribute('data-width', String(originalSizes[0][0]))
    await page.keyboard.press('Control+Shift+z')
    await page.getByTestId('fit').click()

    const oldZoom = await page.getByTestId('zoom').textContent()
    await page.mouse.move(700, 450)
    await page.mouse.wheel(0, -200)
    await expect(page.getByTestId('zoom')).not.toHaveText(oldZoom!)
    const worldBeforePan = await items.first().getAttribute('data-x')
    await page.keyboard.down('Space')
    await page.mouse.move(850, 700)
    await page.mouse.down()
    await page.mouse.move(500, 400, { steps: 8 })
    await page.mouse.up()
    await page.keyboard.up('Space')
    await expect(items.first()).toHaveAttribute('data-x', worldBeforePan!)
    await page.getByTestId('fit').click()

    // Drag a single image within the six-screen-pixel snapping threshold.
    const second = (await items.nth(1).boundingBox())!
    const third = (await items.nth(2).boundingBox())!
    await page.keyboard.press('Escape')
    await items.nth(2).click()
    await page.mouse.move(third.x + third.width / 2, third.y + third.height / 2)
    await page.mouse.down()
    await page.mouse.move(second.x + second.width + third.width / 2 + 3, third.y + third.height / 2 + 20, { steps: 10 })
    await expect(page.getByTestId('snap-guide').first()).toBeVisible()
    await page.mouse.up()
    const secondRight = Number(await items.nth(1).getAttribute('data-x')) + Number(await items.nth(1).getAttribute('data-width'))
    expect(Number(await items.nth(2).getAttribute('data-x'))).toBeCloseTo(secondRight, 2)

    backup = await app.evaluate(({ clipboard }) => clipboard.availableFormats().map(format => ({ format, bytes: [...clipboard.readBuffer(format)] })))
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+v')
    await expect(items).toHaveCount(4)
    await page.keyboard.press('Delete')
    await expect(items).toHaveCount(3)
    await page.keyboard.press('Control+z')
    await expect(items).toHaveCount(4)
    await app.evaluate(({ clipboard, nativeImage }, path) => clipboard.writeImage(nativeImage.createFromPath(path)), files[2])
    await page.keyboard.press('Control+v')
    await expect(items).toHaveCount(5)

    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, project)
    await page.keyboard.press('Control+s')
    await expect(page).toHaveTitle('TestRef.hbr — HybridRef')
    const saved = await readFile(project, 'utf8')
    const document = parse(saved)
    expect(document.formatVersion).toBe(2)
    expect(document.images).toHaveLength(5)
    expect(document.boards).toBeUndefined()
    for (const image of document.images) {
      expect(image.asset).toMatch(/^TestRefResource\/[a-f0-9]{64}\.png$/)
      expect((await readFile(join(folder, image.asset))).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    }
    const beforeSave = (await stat(project)).mtimeMs
    await page.keyboard.press('Control+s')
    await expect.poll(async () => (await stat(project)).mtimeMs).toBeGreaterThan(beforeSave)
    expect(await readFile(project, 'utf8')).toBe(saved)
    await page.getByTestId('new').click()
    await expect(items).toHaveCount(0)
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, project)
    await page.getByTestId('open').click()
    await expect(items).toHaveCount(5)
    await expect(page).toHaveTitle('TestRef.hbr — HybridRef')
    expect(errors).toEqual([])
  } finally {
    if (backup) await app.evaluate(({ clipboard }, entries) => {
      clipboard.clear()
      for (const entry of entries) clipboard.writeBuffer(entry.format, Buffer.from(entry.bytes))
    }, backup).catch(() => {})
    await app.evaluate(({ app }) => app.exit()).catch(() => {})
  }
})

test('minimal demo opens directly without onboarding or old panels', async () => {
  const root = resolve(__dirname, '..')
  const profile = await mkdtemp(join(tmpdir(), 'hybridref-minimal-preview-'))
  const env = { ...process.env, HYBRIDREF_PROJECT: resolve(root, '../../Projects/Demo/SimpleDemo.hbr'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [root, `--user-data-dir=${profile}`], env })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('image-item')).toHaveCount(3)
    await expect(page).toHaveTitle('SimpleDemo.hbr — HybridRef')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.screenshot({ path: resolve(root, '../../.logs/minimal-preview.png') })
    const pictures = page.getByTestId('image-item')
    const boxes = await Promise.all([0, 1, 2].map(index => pictures.nth(index).boundingBox()))
    await page.mouse.move(Math.min(...boxes.map(box => box!.x)) - 10, Math.min(...boxes.map(box => box!.y)) - 10)
    await page.mouse.down()
    await page.mouse.move(Math.max(...boxes.map(box => box!.x + box!.width)) + 10, Math.max(...boxes.map(box => box!.y + box!.height)) + 10, { steps: 10 })
    await page.mouse.up()
    await expect(page.getByTestId('status')).toContainText('已选 3')
    await page.keyboard.press('Escape')
    await pictures.first().click()
    await pictures.nth(1).click({ modifiers: ['Shift'] })
    await expect(page.getByTestId('status')).toContainText('已选 2')
    await pictures.first().click({ modifiers: ['Shift'] })
    await expect(page.getByTestId('status')).toContainText('已选 1')
  } finally { await app.evaluate(({ app }) => app.exit()).catch(() => {}) }
})

test('canceling a close save preserves the board; successful close saves PNG and YAML', async () => {
  const root = resolve(__dirname, '..')
  const folder = await mkdtemp(join(tmpdir(), 'hybridref-close-'))
  const source = join(folder, 'source.jpg')
  const project = join(folder, 'SavedOnClose.hbr')
  await sharp({ create: { width: 60, height: 40, channels: 3, background: '#92806a' } }).jpeg().toFile(source)
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.HYBRIDREF_PROJECT
  const app = await electron.launch({ args: [root, `--user-data-dir=${join(folder, 'profile')}`], env })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
      ;(globalThis as unknown as { saveCanceled: boolean }).saveCanceled = false
      dialog.showSaveDialog = async () => {
        (globalThis as unknown as { saveCanceled: boolean }).saveCanceled = true
        return { canceled: true, filePath: undefined }
      }
    }, source)
    await page.getByTestId('import').click()
    await expect(page.getByTestId('image-item')).toHaveCount(1)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { saveCanceled: boolean }).saveCanceled)).toBe(true)
    await expect(page).toHaveTitle('* 未命名 — HybridRef')
    await expect(page.getByTestId('canvas')).toBeVisible()
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, project)
    const closed = page.waitForEvent('close')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await closed
    const saved = parse(await readFile(project, 'utf8'))
    expect(saved.images).toHaveLength(1)
    expect((await readFile(join(folder, saved.images[0].asset))).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  } finally { await app.evaluate(({ app }) => app.exit()).catch(() => {}) }
})
