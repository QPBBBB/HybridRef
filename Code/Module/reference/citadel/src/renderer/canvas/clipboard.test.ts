// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasItem } from '../../types'
import { useCanvasStore } from '../store/canvasStore'
import { useHistoryStore } from '../store/historyStore'
import { beginProjectSession } from '../utils/projectSession'
import { copySelectedItems, pasteClipboard } from './clipboard'

const imageData = 'data:image/png;base64,cG5n'
let clipboard: { internal: boolean; imageData?: string; width?: number; height?: number }
let save: () => Promise<unknown>
const invoke = vi.fn(async (channel: string) => {
  if (channel === 'clipboard:markInternal') { clipboard = { internal: true }; return { ok: true } }
  if (channel === 'clipboard:readImage') return clipboard
  if (channel === 'assets:saveDataUrl') return save()
  return { ok: true }
})
const original: CanvasItem = {
  id: 'original', type: 'sticky', x: 10, y: 20, width: 100, height: 80,
  rotation: 0, zIndex: 0, locked: false, visible: true, opacity: 1, tags: [], meta: { text: 'Editable' },
}

beforeEach(() => {
  beginProjectSession()
  useCanvasStore.setState({
    boards: [{ id: 'board', name: 'Board', items: [original], connections: [], viewport: { x: 0, y: 0, scale: 1 } }],
    activeBoardId: 'board', selectedIds: ['original'],
  })
  useHistoryStore.getState().resetHistory()
  clipboard = { internal: false, imageData, width: 1600, height: 800 }
  save = async () => ({ path: 'D:/cached/clipboard.png' })
  invoke.mockClear()
  Object.assign(window, { ipc: { invoke } })
})

describe('native and internal clipboard', () => {
  it('imports a screenshot as a selected image with one undoable event', async () => {
    await expect(pasteClipboard()).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('assets:saveDataUrl', { dataUrl: imageData, filename: 'clipboard.png' })
    const item = useCanvasStore.getState().items()[1]
    expect(item).toMatchObject({ type: 'image', src: 'D:/cached/clipboard.png', width: 800, height: 400 })
    expect(useCanvasStore.getState().selectedIds).toEqual([item.id])
    expect(useHistoryStore.getState().events).toHaveLength(1)
    expect(useHistoryStore.getState().events[0]).toMatchObject({ type: 'ITEM_ADD', after: item })
  })

  it('copies editable items when the clipboard still contains the internal marker', async () => {
    copySelectedItems()
    await expect(pasteClipboard()).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('clipboard:markInternal')
    expect(useCanvasStore.getState().items()[1]).toMatchObject({ type: 'sticky', x: 30, y: 40, meta: { text: 'Editable' } })
    expect(invoke).not.toHaveBeenCalledWith('assets:saveDataUrl', expect.anything())
  })

  it('prefers a newly copied screenshot over a stale internal copy', async () => {
    copySelectedItems()
    clipboard = { internal: false, imageData, width: 10, height: 20 }
    await pasteClipboard()
    expect(useCanvasStore.getState().items()[1].type).toBe('image')
  })

  it('cuts and pastes with matching delete and add events', async () => {
    copySelectedItems(true)
    expect(useCanvasStore.getState().items()).toEqual([])
    await pasteClipboard()
    expect(useCanvasStore.getState().items()).toHaveLength(1)
    expect(useHistoryStore.getState().events.map((event) => event.type)).toEqual(['ITEM_DELETE', 'ITEM_ADD'])
  })

  it('does not paste an old internal copy over newer external text', async () => {
    copySelectedItems()
    clipboard = { internal: false }
    await expect(pasteClipboard()).resolves.toBe(false)
    expect(useCanvasStore.getState().items()).toHaveLength(1)
  })

  it('does not add the image to a project opened while the import is running', async () => {
    let finish!: (value: unknown) => void
    let started!: () => void
    const pending = new Promise<void>((resolve) => { started = resolve })
    save = () => { started(); return new Promise((resolve) => { finish = resolve }) }
    const pasting = pasteClipboard()
    await pending
    beginProjectSession()
    useCanvasStore.setState({ boards: [], activeBoardId: null, selectedIds: [] })
    finish({ path: 'D:/cached/clipboard.png' })
    await expect(pasting).resolves.toBe(false)
    expect(useCanvasStore.getState().boards).toEqual([])
    expect(useHistoryStore.getState().events).toEqual([])
  })
})
