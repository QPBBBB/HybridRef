// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasItem, ProjectFile } from '../../types'
import { useCanvasStore } from '../store/canvasStore'
import { useHistoryStore } from '../store/historyStore'
import { getCurrentFilePath, loadProjectData, newProject, openStartupProject, saveProject } from './projectFile'

vi.mock('../assets/imageMemoryCache', () => ({ clearImageMemoryCache: vi.fn(), preloadProjectImages: vi.fn(async () => {}) }))
vi.mock('../export/exportCanvas', () => ({ captureBoardThumbnail: () => null }))

const originalSource = 'D:/references/photo.jpg'
const savedSource = 'D:/boards/BoardResource/abc.png'
const originalFingerprint = { size: 1024, mtimeMs: 100 }
const convertedFingerprint = { size: 3072, mtimeMs: 200 }
const project = (): ProjectFile => ({
  version: '1.0.0', createdAt: 123, updatedAt: 456, activeBoardId: 'board', recordings: [],
  boards: [{
    id: 'board', name: 'References', viewport: { x: 0, y: 0, scale: 1 }, connections: [],
    items: [{
      id: 'image', type: 'image', x: 10, y: 20, width: 200, height: 100,
      rotation: 0, zIndex: 0, locked: false, visible: true, opacity: 1, tags: [], src: originalSource,
    }],
  }],
})

let savedPayloads: ProjectFile[]
let saveResult: (payload: ProjectFile) => Promise<unknown>
const invoke = vi.fn(async (channel: string, args?: Record<string, unknown>) => {
  if (channel === 'file:save') {
    const payload = JSON.parse(args!.data as string) as ProjectFile
    savedPayloads.push(payload)
    return saveResult(payload)
  }
  if (channel === 'settings:get') return { value: [] }
  if (channel === 'file:startupProject') return { path: 'D:/boards/Board.hbr' }
  if (channel === 'file:load') return { data: JSON.stringify(project()) }
  return { ok: true }
})

beforeEach(() => {
  savedPayloads = []
  saveResult = async () => ({ ok: true })
  invoke.mockClear()
  Object.assign(window, { ipc: { invoke }, confirm: () => true })
  loadProjectData(project())
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve }
}

describe('HybridRef project saves', () => {
  it('preserves creation time and makes repeated unchanged saves identical', async () => {
    useCanvasStore.getState().updateItem('board', 'image', { x: 50 })
    await saveProject('D:/boards/Board.hbr')
    await saveProject('D:/boards/Board.hbr')
    expect(savedPayloads[0].createdAt).toBe(123)
    expect(savedPayloads[0].updatedAt).toBeGreaterThan(456)
    expect(savedPayloads[1]).toEqual(savedPayloads[0])
  })

  it('keeps metadata unchanged when an opened project is saved without an edit', async () => {
    await saveProject('D:/boards/Board.hbr')
    expect(savedPayloads[0]).toMatchObject({ createdAt: 123, updatedAt: 456 })
  })

  it('preserves project keybind overrides without leaking them into another project', async () => {
    const overrides = { 'file:save': ['ctrl+alt+s'], 'edit:copy': [] }
    loadProjectData({ ...project(), keybindOverrides: overrides })
    await saveProject('D:/boards/Custom.hbr')
    expect(savedPayloads[0].keybindOverrides).toEqual(overrides)
    expect(savedPayloads[0].updatedAt).toBe(456)

    loadProjectData(project())
    await saveProject('D:/boards/Plain.hbr')
    expect(savedPayloads[1].keybindOverrides).toBeUndefined()

    loadProjectData({ ...project(), keybindOverrides: overrides })
    newProject()
    await saveProject('D:/boards/New.hbr')
    expect(savedPayloads[2].keybindOverrides).toBeUndefined()
  })

  it('adopts converted paths in items, undo, and recordings without erasing edits made during save', async () => {
    const completion = deferred<unknown>()
    const started = deferred<void>()
    saveResult = async () => { started.resolve(); return completion.promise }
    useCanvasStore.getState().updateItem('board', 'image', { meta: { sourceFingerprint: originalFingerprint } })
    const item = useCanvasStore.getState().items()[0]
    const event = useHistoryStore.getState().push('ITEM_ADD', 'board', null, item)
    useHistoryStore.getState().saveRecording({ id: 'recording', name: 'Capture', startedAt: 1, events: [event] })
    const saving = saveProject('D:/boards/Board.hbr')
    await started.promise
    useCanvasStore.getState().updateItem('board', 'image', { x: 99 })
    useHistoryStore.getState().push('ITEM_MOVE', 'board', { id: 'image', x: 10 }, { id: 'image', x: 99 })
    completion.resolve({ ok: true, assetReplacements: { [originalSource]: savedSource }, sourceFingerprints: { [originalSource]: convertedFingerprint } })
    await expect(saving).resolves.toBe(true)
    expect(useCanvasStore.getState().items()[0]).toMatchObject({ x: 99, src: savedSource, meta: { sourceFingerprint: convertedFingerprint } })
    const history = useHistoryStore.getState()
    expect(history.events).toHaveLength(2)
    expect((history.events[0].after as CanvasItem).src).toBe(savedSource)
    expect((history.events[0].after as CanvasItem).meta?.sourceFingerprint).toEqual(convertedFingerprint)
    expect((history.recordings[0].events[0].after as CanvasItem).src).toBe(savedSource)
    expect((history.recordings[0].events[0].after as CanvasItem).meta?.sourceFingerprint).toEqual(convertedFingerprint)
    expect(history.isDirty()).toBe(true)
  })

  it('does not restore a deleted item or overwrite a replacement source while saving', async () => {
    const completion = deferred<unknown>()
    const started = deferred<void>()
    saveResult = async () => { started.resolve(); return completion.promise }
    const saving = saveProject('D:/boards/Board.hbr')
    await started.promise
    useCanvasStore.getState().updateItem('board', 'image', { src: 'D:/another.png' })
    completion.resolve({ ok: true, assetReplacements: { [originalSource]: savedSource } })
    await saving
    expect(useCanvasStore.getState().items()[0].src).toBe('D:/another.png')
    expect(useHistoryStore.getState().isDirty()).toBe(true)
  })

  it('does not rename a new project when the previous project finishes saving', async () => {
    const completion = deferred<unknown>()
    const started = deferred<void>()
    saveResult = async () => { started.resolve(); return completion.promise }
    const saving = saveProject('D:/boards/Board.hbr')
    await started.promise
    newProject()
    const newBoardId = useCanvasStore.getState().activeBoardId
    completion.resolve({ ok: true, assetReplacements: { [originalSource]: savedSource } })
    await expect(saving).resolves.toBe(true)
    expect(getCurrentFilePath()).toBeNull()
    expect(useCanvasStore.getState().activeBoardId).toBe(newBoardId)
    expect(useCanvasStore.getState().items()).toEqual([])
  })

  it('orders repeated saves and carries converted paths into a queued snapshot', async () => {
    useCanvasStore.getState().updateItem('board', 'image', { x: 60, meta: { sourceFingerprint: originalFingerprint } })
    const completion = deferred<unknown>()
    const started = deferred<void>()
    saveResult = async () => {
      if (savedPayloads.length === 1) { started.resolve(); return completion.promise }
      return { ok: true }
    }
    const first = saveProject('D:/boards/Board.hbr')
    const second = saveProject('D:/boards/Board.hbr')
    await started.promise
    expect(savedPayloads).toHaveLength(1)
    completion.resolve({ ok: true, assetReplacements: { [originalSource]: savedSource }, sourceFingerprints: { [originalSource]: convertedFingerprint } })
    await Promise.all([first, second])
    expect(savedPayloads[1].boards[0].items[0].src).toBe(savedSource)
    expect(savedPayloads[1].boards[0].items[0].meta?.sourceFingerprint).toEqual(convertedFingerprint)
    expect(savedPayloads[1].updatedAt).toBe(savedPayloads[0].updatedAt)
    expect(useHistoryStore.getState().isDirty()).toBe(false)
  })

  it('uses the PDF baseline over its page image and leaves untracked assets untracked', async () => {
    const pdfSource = 'D:/references/source.pdf'
    const savedPdf = 'D:/boards/BoardResource/source.pdf'
    const pdfFingerprint = { size: 5000, mtimeMs: 600 }
    const item = useCanvasStore.getState().items()[0]
    useCanvasStore.getState().addItem('board', { ...item, id: 'untracked' })
    useCanvasStore.getState().updateItem('board', 'image', { meta: { sourcePdf: pdfSource, sourceFingerprint: originalFingerprint } })
    saveResult = async () => ({
      ok: true,
      assetReplacements: { [originalSource]: savedSource, [pdfSource]: savedPdf },
      sourceFingerprints: { [originalSource]: convertedFingerprint, [pdfSource]: pdfFingerprint },
    })
    await saveProject('D:/boards/Board.hbr')
    expect(useCanvasStore.getState().items()[0].meta).toMatchObject({ sourcePdf: savedPdf, sourceFingerprint: pdfFingerprint })
    expect(useCanvasStore.getState().items()[1].meta?.sourceFingerprint).toBeUndefined()
    // Saving the already-managed source must not refresh its historical
    // baseline: a later external disk edit still needs to be detected.
    saveResult = async () => ({ ok: true, assetReplacements: { [savedSource]: savedSource, [savedPdf]: savedPdf } })
    await saveProject('D:/boards/Board.hbr')
    expect(savedPayloads[1].boards[0].items[0].meta?.sourceFingerprint).toEqual(pdfFingerprint)
    expect(useHistoryStore.getState().isDirty()).toBe(false)
  })

  it('does not report a rejected write as saved', async () => {
    useHistoryStore.getState().markDirty()
    saveResult = async () => ({ ok: false })
    await expect(saveProject('D:/boards/Board.hbr')).resolves.toBe(false)
    expect(useHistoryStore.getState().isDirty()).toBe(true)
    expect(getCurrentFilePath()).toBeNull()
  })

  it('opens the launcher project only once across repeated startup requests', async () => {
    await Promise.all([openStartupProject(), openStartupProject()])
    expect(getCurrentFilePath()).toBe('D:/boards/Board.hbr')
    expect(invoke.mock.calls.filter(([channel]) => channel === 'file:startupProject')).toHaveLength(1)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'file:load')).toHaveLength(1)
  })
})
