import { nanoid } from 'nanoid'
import type { CanvasItem } from '../../types'
import { useCanvasStore } from '../store/canvasStore'
import { useHistoryStore } from '../store/historyStore'
import { projectSessionRevision } from '../utils/projectSession'
import { inscribe } from '../ui/toasts/inscriptionToastStore'
import { remapTranscriptReferences } from './transcriptReferences'

// Internal object copies preserve editable properties and media references.
// The native clipboard marker distinguishes these from a newer OS screenshot.
let items: CanvasItem[] = []
let pasteOffset = 0
let markPending: Promise<unknown> = Promise.resolve()

export function copySelectedItems(cut = false): void {
  const canvas = useCanvasStore.getState()
  const boardId = canvas.activeBoardId
  const selected = canvas.selectedUnlockedItems()
  if (!boardId || selected.length === 0) return
  items = structuredClone(selected)
  pasteOffset = 0
  markPending = window.ipc.invoke('clipboard:markInternal').catch(() => {})
  if (!cut) return
  useHistoryStore.getState().push('ITEM_DELETE', boardId, selected, selected.map((item) => ({ id: item.id })))
  canvas.removeItems(boardId, selected.map((item) => item.id))
  canvas.clearSelection()
}

type ClipboardImage = { internal?: boolean; imageData?: string | null; width?: number; height?: number }

export async function pasteClipboard(): Promise<boolean> {
  const canvas = useCanvasStore.getState()
  const boardId = canvas.activeBoardId
  if (!boardId) return false
  const revision = projectSessionRevision()
  const current = () => projectSessionRevision() === revision
    && useCanvasStore.getState().activeBoardId === boardId
    && useCanvasStore.getState().boards.some((board) => board.id === boardId)
  try {
    await markPending
    const content = await window.ipc.invoke('clipboard:readImage') as ClipboardImage
    if (!current()) return false
    if (content?.internal) {
      if (items.length === 0) return false
      pasteOffset += 20
      const ids = new Map(items.map((item) => [item.id, nanoid()]))
      const copies = items.map((item) => remapTranscriptReferences({
        ...structuredClone(item), id: ids.get(item.id)!, x: item.x + pasteOffset, y: item.y + pasteOffset,
      }, ids))
      copies.forEach((item) => {
        useCanvasStore.getState().addItem(boardId, item)
        useHistoryStore.getState().push('ITEM_ADD', boardId, null, item)
      })
      useCanvasStore.getState().setSelection(copies.map((item) => item.id))
      return true
    }
    if (!content?.imageData) return false
    const saved = await window.ipc.invoke('assets:saveDataUrl', {
      dataUrl: content.imageData, filename: 'clipboard.png',
    }) as { path?: string }
    if (!current()) return false
    if (!saved?.path) throw new Error('The image could not be imported')
    const width = Math.max(1, Number.isFinite(content.width) ? content.width! : 400)
    const height = Math.max(1, Number.isFinite(content.height) ? content.height! : 300)
    const factor = Math.min(1, 800 / Math.max(width, height))
    const viewport = useCanvasStore.getState().viewport()
    const surface = document.querySelector('[data-vision-surface="canvas"]')?.getBoundingClientRect()
    const centerX = surface?.width ? surface.left + surface.width / 2 : window.innerWidth / 2
    const centerY = surface?.height ? surface.top + surface.height / 2 : window.innerHeight / 2
    const item: CanvasItem = {
      id: nanoid(), type: 'image', src: saved.path,
      width: Math.round(width * factor), height: Math.round(height * factor),
      x: (centerX - viewport.x) / viewport.scale - width * factor / 2,
      y: (centerY - viewport.y) / viewport.scale - height * factor / 2,
      rotation: 0, zIndex: Date.now(), locked: false, visible: true, opacity: 1, tags: [],
    }
    useCanvasStore.getState().addItem(boardId, item)
    useHistoryStore.getState().push('ITEM_ADD', boardId, null, item)
    useCanvasStore.getState().setSelection([item.id])
    return true
  } catch (error) {
    if (current()) inscribe(`Could not paste: ${error instanceof Error ? error.message : String(error)}`, { tone: 'danger' })
    return false
  }
}
