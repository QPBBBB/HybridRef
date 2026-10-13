import { contextBridge, ipcRenderer } from 'electron'
import type { HybridRefApi } from '../shared/types'

const api: HybridRefApi = {
  startup: () => ipcRenderer.invoke('board:startup'),
  open: () => ipcRenderer.invoke('board:open'),
  save: (document, path) => ipcRenderer.invoke('board:save', { document, path }),
  importImages: (paths) => ipcRenderer.invoke('image:import', paths),
  importBytes: (files) => ipcRenderer.invoke('image:bytes', files),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardMark: () => ipcRenderer.invoke('clipboard:mark'),
  setDirty: (dirty) => ipcRenderer.send('board:dirty', dirty),
  onSaveRequested: (callback) => {
    const listener = (): void => { void callback().then(saved => ipcRenderer.send('board:closeSaveFinished', saved), () => ipcRenderer.send('board:closeSaveFinished', false)) }
    ipcRenderer.on('board:requestSave', listener)
    return () => { ipcRenderer.removeListener('board:requestSave', listener) }
  },
}
contextBridge.exposeInMainWorld('hybridref', api)
