import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session } from 'electron'
import { join, resolve, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ImageStore } from './storage'
import type { BoardDocument } from '../shared/types'

const images = new ImageStore()
const clipboardFormat = 'hybridref/images'
const clipboardToken = Buffer.from(randomUUID())
let window: BrowserWindow
let dirty = false
let closePrompt = false
let closeAfterSave = false

function registerHandlers(): void {
  ipcMain.handle('board:startup', async () => {
    const path = process.env.HYBRIDREF_PROJECT || process.argv.slice(1).find(arg => extname(arg).toLowerCase() === '.hbr')
    return path ? images.loadProject(resolve(path)) : null
  })
  ipcMain.handle('board:open', async () => {
    const result = await dialog.showOpenDialog(window, { title: '打开画板', filters: [{ name: 'HybridRef 画板', extensions: ['hbr'] }], properties: ['openFile'] })
    return result.canceled ? null : images.loadProject(result.filePaths[0])
  })
  ipcMain.handle('board:save', async (_event, request: { document: BoardDocument; path: string | null }) => {
    let path = request.path
    if (!path) {
      const result = await dialog.showSaveDialog(window, { title: '保存画板', defaultPath: 'Untitled.hbr', filters: [{ name: 'HybridRef 画板', extensions: ['hbr'] }] })
      if (result.canceled || !result.filePath) { closeAfterSave = false; return null }
      path = result.filePath
    }
    if (extname(path).toLowerCase() !== '.hbr') path += '.hbr'
    try { await images.saveProject(path, request.document) }
    catch (error) { closeAfterSave = false; throw error }
    return { path }
  })
  ipcMain.handle('image:import', async (_event, paths?: string[]) => {
    if (!paths) {
      const result = await dialog.showOpenDialog(window, { title: '导入图片', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'svg', 'tif', 'tiff', 'avif'] }] })
      if (result.canceled) return { assets: [], errors: [] }
      paths = result.filePaths
    }
    return images.importFiles(paths)
  })
  ipcMain.handle('image:bytes', (_event, files: { name: string; bytes: Uint8Array }[]) => images.importBuffers(files))
  ipcMain.handle('clipboard:mark', () => { clipboard.clear(); clipboard.writeBuffer(clipboardFormat, clipboardToken) })
  ipcMain.handle('clipboard:read', async () => {
    if (clipboard.readBuffer(clipboardFormat).equals(clipboardToken)) return { internal: true }
    const image = clipboard.readImage()
    if (image.isEmpty()) return { internal: false }
    const result = await images.importBuffers([{ name: 'Clipboard.png', bytes: image.toPNG() }])
    if (result.errors.length) throw new Error(result.errors.join('\n'))
    return { internal: false, asset: result.assets[0] }
  })
  ipcMain.on('board:dirty', (_event, value) => {
    dirty = value === true
  })
  ipcMain.on('board:closeSaveFinished', (_event, saved) => {
    if (!closeAfterSave) return
    closeAfterSave = false
    if (saved === true && !dirty) window.close()
  })
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.hybridref.app')
  Menu.setApplicationMenu(null)
  window = new BrowserWindow({
    title: 'HybridRef', width: 1360, height: 900, minWidth: 780, minHeight: 540,
    backgroundColor: '#0d0e10', show: false,
    icon: app.isPackaged ? undefined : join(app.getAppPath(), '..', 'Resource', 'icon.png'),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (url !== window.webContents.getURL()) event.preventDefault() })
  registerHandlers()
  window.once('ready-to-show', () => window.show())
  window.on('close', event => {
    if (!dirty) return
    event.preventDefault()
    if (closePrompt) return
    closePrompt = true
    void dialog.showMessageBox(window, { type: 'question', message: '保存画板的修改？', buttons: ['保存', '不保存', '取消'], defaultId: 0, cancelId: 2 }).then(({ response }) => {
      if (response === 0) { closeAfterSave = true; window.webContents.send('board:requestSave') }
      else if (response === 1) { dirty = false; window.close() }
    }).finally(() => { closePrompt = false })
  })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
})
app.on('window-all-closed', () => app.quit())
