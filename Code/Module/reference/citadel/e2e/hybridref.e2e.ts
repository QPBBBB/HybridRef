import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { cp, mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { parse } from 'yaml'

test('opens YAML, keeps a clean diff, pastes system images and survives save/reopen', async () => {
  test.setTimeout(60_000)
  const moduleRoot = resolve(__dirname, '..')
  const fixture = await mkdtemp(join(tmpdir(), 'hybridref-e2e-'))
  const folder = join(fixture, '参考 # 100%')
  const projectPath = join(folder, 'Demo.hbr')
  await cp(resolve(moduleRoot, '../../Projects/Demo'), folder, { recursive: true })
  const original = await readFile(projectPath, 'utf8')
  const originalCount = parse(original).boards[0].items.length
  const env = { ...process.env, HYBRIDREF_PROJECT: projectPath, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  delete env.ELECTRON_RUN_AS_NODE
  let app: ElectronApplication | undefined
  let clipboardBackup: { format: string; bytes: number[] }[] = []
  let clipboardCaptured = false
  try {
    app = await electron.launch({ args: [moduleRoot, `--user-data-dir=${join(fixture, 'profile')}`], env })
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await expect(page).toHaveTitle('Demo.hbr — HybridRef')
    await page.getByRole('button', { name: 'Continue to board' }).click({ force: true })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite')

    // Encoded Chinese/space/#/% paths must actually load through the native protocol.
    const firstImage = parse(original).boards[0].items.find((item: { type: string }) => item.type === 'image')
    const imageUrl = 'local:///' + join(folder, firstImage.src).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
    const pixels = await page.evaluate(async (src) => {
      const image = new Image()
      image.src = src
      await image.decode()
      return [image.naturalWidth, image.naturalHeight]
    }, imageUrl)
    expect(pixels).toEqual([960, 640])
    const firstSaveMtime = (await stat(projectPath)).mtimeMs
    await page.keyboard.press('Control+s')
    await expect.poll(async () => (await stat(projectPath)).mtimeMs).toBeGreaterThan(firstSaveMtime)
    await expect(page).toHaveTitle('Demo.hbr — HybridRef')
    await expect.poll(() => readFile(projectPath, 'utf8')).toBe(original)

    await page.screenshot({ path: test.info().outputPath('hybridref-demo.png') })
    await mkdir(resolve(moduleRoot, '../../.logs'), { recursive: true })
    await page.screenshot({ path: resolve(moduleRoot, '../../.logs/demo-preview.png') })

    clipboardBackup = await app.evaluate(({ clipboard }) => clipboard.availableFormats().map(format => ({ format, bytes: [...clipboard.readBuffer(format)] })))
    clipboardCaptured = true
    await app.evaluate(({ clipboard, nativeImage }, path) => {
      clipboard.writeImage(nativeImage.createFromPath(path))
    }, join(moduleRoot, 'e2e/fixtures/capture-source.png'))
    await page.keyboard.press('Control+v')
    await expect(page).toHaveTitle('* Demo.hbr — HybridRef')
    await page.keyboard.press('Control+s')
    await expect(page).toHaveTitle('Demo.hbr — HybridRef')
    const saved = parse(await readFile(projectPath, 'utf8'))
    expect(saved.boards[0].items).toHaveLength(originalCount + 1)
    const pasted = saved.boards[0].items.at(-1)
    expect(pasted.type).toBe('image')
    expect(pasted.src).toMatch(/^DemoResource\/[a-f0-9]{64}\.png$/)
    expect((await readFile(join(folder, pasted.src))).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

    // Delete and undo use the same event log after source paths have been rewritten.
    await page.keyboard.press('Delete')
    await expect(page).toHaveTitle('* Demo.hbr — HybridRef')
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+s')
    await expect(page).toHaveTitle('Demo.hbr — HybridRef')
    expect(parse(await readFile(projectPath, 'utf8')).boards[0].items).toHaveLength(originalCount + 1)

    // Reopen using the actual menu and renderer load path, then save without edits.
    await page.evaluate(() => {
      (window as unknown as { hybridrefOpened: boolean }).hybridrefOpened = false
      window.addEventListener('citadel:projectPathChanged', () => {
        (window as unknown as { hybridrefOpened: boolean }).hybridrefOpened = true
      }, { once: true })
    })
    await app.evaluate(({ ipcMain }, path) => {
      ipcMain.removeHandler('file:openDialog')
      ipcMain.handle('file:openDialog', () => ({ path }))
    }, projectPath)
    const beforeReopen = await readFile(projectPath, 'utf8')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:open'))
    await expect.poll(() => page.evaluate(() => (window as unknown as { hybridrefOpened: boolean }).hybridrefOpened)).toBe(true)
    await expect(page).toHaveTitle('Demo.hbr — HybridRef')
    const reopenSaveMtime = (await stat(projectPath)).mtimeMs
    await page.keyboard.press('Control+s')
    await expect.poll(async () => (await stat(projectPath)).mtimeMs).toBeGreaterThan(reopenSaveMtime)
    await expect.poll(() => readFile(projectPath, 'utf8')).toBe(beforeReopen)
    expect(errors).toEqual([])
  } finally {
    if (app) {
      if (clipboardCaptured) await app.evaluate(({ clipboard }, backup) => {
        clipboard.clear()
        for (const entry of backup) clipboard.writeBuffer(entry.format, Buffer.from(entry.bytes))
      }, clipboardBackup).catch(() => {})
      await app.close().catch(() => {})
    }
    if (!resolve(fixture).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected test cleanup path')
    await rm(fixture, { recursive: true, force: true })
  }
})
