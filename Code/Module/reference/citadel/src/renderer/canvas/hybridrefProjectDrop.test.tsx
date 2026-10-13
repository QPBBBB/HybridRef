// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore } from '../store/canvasStore'
import { useHistoryStore } from '../store/historyStore'
import { useFileDrop } from './useFileDrop'
import { getCurrentFilePath, newProject } from '../utils/projectFile'

vi.mock('../assets/imageMemoryCache', () => ({ clearImageMemoryCache: vi.fn(), preloadProjectImages: vi.fn(async () => {}) }))
vi.mock('../utils/pdfPreview', () => ({ renderPdfFirstPage: vi.fn() }))
vi.mock('../export/exportCanvas', () => ({ captureBoardThumbnail: () => null }))

const path = 'D:/参考/Demo.hbr'
const invoke = vi.fn(async (channel: string) => {
  if (channel === 'file:load') return { data: JSON.stringify({
    version: '1.0.0', createdAt: 123, updatedAt: 456, activeBoardId: 'loaded',
    boards: [{ id: 'loaded', name: 'Demo', items: [], connections: [], viewport: { x: 10, y: 20, scale: 1 } }],
  }) }
  if (channel === 'settings:get') return { value: [] }
  return { ok: true }
})

beforeEach(() => {
  Object.assign(window, { ipc: { invoke }, confirm: vi.fn(() => true) })
  invoke.mockClear()
  newProject()
})

function event(): Parameters<ReturnType<typeof useFileDrop>['handleDrop']>[0] {
  return {
    preventDefault: vi.fn(), clientX: 100, clientY: 100,
    dataTransfer: { files: [{ name: 'Demo.HBR', path }] },
  } as unknown as Parameters<ReturnType<typeof useFileDrop>['handleDrop']>[0]
}

describe('HybridRef project drops', () => {
  it('opens a dropped .hbr project instead of treating it as a canvas asset', async () => {
    const { result } = renderHook(useFileDrop)
    await result.current.handleDrop(event())
    expect(invoke).toHaveBeenCalledWith('file:load', { path })
    expect(getCurrentFilePath()).toBe(path)
    expect(useCanvasStore.getState().activeBoardId).toBe('loaded')
    expect(useCanvasStore.getState().items()).toEqual([])
  })

  it('keeps unsaved work when the existing discard confirmation is cancelled', async () => {
    const originalBoard = useCanvasStore.getState().activeBoardId
    useHistoryStore.getState().markDirty()
    vi.mocked(window.confirm).mockReturnValue(false)
    const { result } = renderHook(useFileDrop)
    await result.current.handleDrop(event())
    expect(invoke).not.toHaveBeenCalledWith('file:load', expect.anything())
    expect(useCanvasStore.getState().activeBoardId).toBe(originalBoard)
  })
})
