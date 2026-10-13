/**
 * Save / load HybridRef YAML and compatible Citadel projects via the IPC bridge.
 * The renderer never touches fs directly — all I/O goes through window.ipc.
 */
import type { ProjectFile } from '../../types'
import { useCanvasStore } from '../store/canvasStore'
import { useHistoryStore } from '../store/historyStore'
import { parseProjectFile } from './projectSchema'
import { useArchiveProgressStore } from '../ui/archiveProgressStore'
import { inscribe } from '../ui/toasts/inscriptionToastStore'
import { captureBoardThumbnail } from '../export/exportCanvas'
import { isBrowserDemo } from '../platform/runtime'
import { beginProjectSession, projectSessionRevision } from './projectSession'
import { visitProjectAssetPaths, visitProjectItems } from '../../types/projectAssetPaths'
import { clearImageMemoryCache, preloadProjectImages } from '../assets/imageMemoryCache'
import type { SourceFingerprint } from '../assets/sourceProvenance'

const VERSION = '1.0.0'
const RECENT_PROJECTS_KEY = 'recent.projects'
const RECENT_PROJECT_LIMIT = 8

export type RecentProject = {
  path: string
  name: string
  lastOpenedAt: number
}

export type RecoverySnapshot = {
  kind: 'citadel-recovery'
  savedAt: number
  boardCount: number
  itemCount: number
  project: ProjectFile
}

export type ParsedRecovery = {
  savedAt: number | null
  boardCount: number
  itemCount: number
  project: ProjectFile
}

export type SaveActivity = {
  lastManualSaveAt: number | null
  lastRecoverySaveAt: number | null
}

export type AutoSaveResult = 'saved' | 'skipped-clean' | 'skipped-unchanged' | 'failed'

// Path of the currently open file (null = unsaved new project)
let currentFilePath: string | null = null
let saveActivity: SaveActivity = { lastManualSaveAt: null, lastRecoverySaveAt: null }
let lastRecoveryProjectPayload: string | null = null
let projectCreatedAt = Date.now()
let projectUpdatedAt = projectCreatedAt
let projectKeybindOverrides: ProjectFile['keybindOverrides']
let lastSavedProjectPayload: string | null = null
let startupProjectRequest: Promise<boolean> | null = null
let saveQueue: Promise<unknown> = Promise.resolve()
let resourceAliases: Record<string, string> = {}
let resourceFingerprints: Record<string, SourceFingerprint> = {}

export function getCurrentFilePath(): string | null {
  return currentFilePath
}

export function getSaveActivity(): SaveActivity {
  return saveActivity
}

function notifyProjectPathChanged(): void {
  window.dispatchEvent(new Event('citadel:projectPathChanged'))
}

function notifySaveActivityChanged(): void {
  window.dispatchEvent(new Event('citadel:saveActivityChanged'))
}

function setSaveActivity(patch: Partial<SaveActivity>): void {
  saveActivity = { ...saveActivity, ...patch }
  notifySaveActivityChanged()
}

function resetSaveActivity(): void {
  saveActivity = { lastManualSaveAt: null, lastRecoverySaveAt: null }
  notifySaveActivityChanged()
}

function resetRecoveryAutosaveCache(): void {
  lastRecoveryProjectPayload = null
}

export function resetRecoveryAutosaveCacheForTests(): void {
  resetRecoveryAutosaveCache()
}

function confirmDiscardUnsaved(): boolean {
  if (!useHistoryStore.getState().isDirty()) return true
  return window.confirm('Discard unsaved changes and continue?')
}

function ipc() {
  return (window as unknown as { ipc: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }).ipc
}

function createProjectFile(): ProjectFile {
  const { boards, activeBoardId } = useCanvasStore.getState()
  const { recordings } = useHistoryStore.getState()
  return {
    version: VERSION,
    createdAt: projectCreatedAt,
    updatedAt: projectUpdatedAt,
    boards,
    activeBoardId: activeBoardId ?? boards[0]?.id ?? '',
    recordings,
    ...(projectKeybindOverrides === undefined ? {} : { keybindOverrides: projectKeybindOverrides }),
  }
}

function deserialize(json: string): ProjectFile {
  return parseProjectFile(json)
}

function applyProject(file: ProjectFile): void {
  beginProjectSession()
  clearImageMemoryCache()
  projectCreatedAt = file.createdAt
  projectUpdatedAt = file.updatedAt
  projectKeybindOverrides = file.keybindOverrides === undefined ? undefined : structuredClone(file.keybindOverrides)
  lastSavedProjectPayload = recoveryProjectFingerprint(file)
  resourceAliases = {}
  resourceFingerprints = {}
  useCanvasStore.setState({
    boards: file.boards,
    activeBoardId: file.activeBoardId,
    selectedIds: [],
  })
  resetRecoveryAutosaveCache()
  useHistoryStore.getState().resetHistory()
  // Recording sessions belong to the project, while the undo log is only the
  // current in-memory session. Restore the persisted library after resetting
  // that transient log so opening a project also switches its recordings.
  useHistoryStore.setState({ recordings: file.recordings ?? [] })
  void preloadProjectImages(file.boards)
}

function projectStats(file: ProjectFile): { boardCount: number; itemCount: number } {
  return {
    boardCount: file.boards.length,
    itemCount: file.boards.reduce((sum, board) => sum + board.items.length, 0),
  }
}

function createRecoverySnapshot(): RecoverySnapshot {
  const project = createProjectFile()
  return {
    kind: 'citadel-recovery',
    savedAt: Date.now(),
    ...projectStats(project),
    project,
  }
}

function recoveryProjectFingerprint(project: ProjectFile): string {
  return JSON.stringify({
    boards: project.boards,
    activeBoardId: project.activeBoardId,
    recordings: project.recordings,
    keybindOverrides: project.keybindOverrides,
  })
}

export function parseRecoveryData(data: string): ParsedRecovery {
  const parsed = JSON.parse(data) as ProjectFile | RecoverySnapshot
  if ('kind' in parsed && parsed.kind === 'citadel-recovery') {
    const project = parseProjectFile(JSON.stringify(parsed.project))
    return {
      savedAt: parsed.savedAt,
      ...projectStats(project),
      project,
    }
  }

  const project = parseProjectFile(data)
  return {
    savedAt: null,
    ...projectStats(project),
    project,
  }
}

function projectNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function isRecentProject(value: unknown): value is RecentProject {
  return !!value
    && typeof value === 'object'
    && typeof (value as RecentProject).path === 'string'
    && typeof (value as RecentProject).name === 'string'
    && typeof (value as RecentProject).lastOpenedAt === 'number'
}

export async function getRecentProjects(): Promise<RecentProject[]> {
  const result = await ipc().invoke('settings:get', { key: RECENT_PROJECTS_KEY }) as { value: unknown }
  return Array.isArray(result.value) ? result.value.filter(isRecentProject) : []
}

async function setRecentProjects(projects: RecentProject[]): Promise<void> {
  await ipc().invoke('settings:set', { key: RECENT_PROJECTS_KEY, value: projects })
  window.dispatchEvent(new Event('citadel:recentProjectsChanged'))
}

async function rememberRecentProject(path: string): Promise<void> {
  const existing = await getRecentProjects()
  const normalized = path.toLowerCase()
  const next = [
    { path, name: projectNameFromPath(path), lastOpenedAt: Date.now() },
    ...existing.filter((project) => project.path.toLowerCase() !== normalized),
  ].slice(0, RECENT_PROJECT_LIMIT)
  await setRecentProjects(next)
}

async function loadProjectFromPath(path: string): Promise<boolean> {
  let json: string
  if (path.toLowerCase().endsWith('.citadelz')) {
    useArchiveProgressStore.getState().beginRite('import')
    try {
      const result = await ipc().invoke('import:zip', { zipPath: path }) as
        { ok: true; projectJson: string } | { ok: false; reason: string }
      if (!result.ok) throw new Error(result.reason)
      json = result.projectJson
    } finally {
      useArchiveProgressStore.getState().endRite()
    }
  } else {
    const loaded = await ipc().invoke('file:load', { path }) as { data: string }
    json = loaded.data
  }
  const file = deserialize(json)
  applyProject(file)
  currentFilePath = path
  resetSaveActivity()
  resetRecoveryAutosaveCache()
  notifyProjectPathChanged()
  rememberRecentProject(path).catch(console.error)
  return true
}

/**
 * A frame for the time machine's filmstrip, taken at the moment of a manual
 * save. Best-effort on purpose: there is no canvas at all in tests and in
 * headless runs, and a board picture is never worth failing a save over.
 */
function captureSaveSnapshot(): void {
  try {
    const boardId = useCanvasStore.getState().activeBoardId
    if (!boardId) return
    const thumbnail = captureBoardThumbnail()
    if (!thumbnail) return
    useHistoryStore.getState().addSnapshot({ boardId, takenAt: Date.now(), ...thumbnail })
  } catch {
    /* a missing or tainted canvas just means no frame for this save */
  }
}

function applySavedAssets(
  project: unknown,
  replacements: Record<string, string>,
  fingerprints: Record<string, SourceFingerprint>,
): void {
  // A PDF preview follows its original PDF, rather than the page image. Read
  // provenance before changing paths, because the response uses original keys.
  visitProjectItems(project, (item) => {
    const meta = item.meta as Record<string, unknown> | undefined
    const baseline = meta?.sourceFingerprint as SourceFingerprint | undefined
    if (!baseline || !Number.isFinite(baseline.size) || !Number.isFinite(baseline.mtimeMs)) return
    const source = typeof meta?.sourcePdf === 'string' ? meta.sourcePdf : item.src
    const next = typeof source === 'string' ? fingerprints[source] : undefined
    if (next) meta!.sourceFingerprint = { ...next }
  })
  visitProjectAssetPaths(project, (source, replace) => {
    const next = replacements[source]
    if (typeof next === 'string' && next !== source) replace(next)
  })
}

/** Rewrite only migrated file references and their baselines; keep concurrent layout edits. */
function adoptSavedResourcePaths(replacements: Record<string, string>, fingerprints: Record<string, SourceFingerprint>): void {
  if (Object.keys(replacements).length === 0 && Object.keys(fingerprints).length === 0) return
  for (const [source, target] of Object.entries(resourceAliases)) {
    if (fingerprints[target]) resourceFingerprints[source] = fingerprints[target]
  }
  resourceFingerprints = { ...resourceFingerprints, ...fingerprints }
  resourceAliases = Object.fromEntries(Object.entries({ ...resourceAliases, ...replacements })
    .map(([source, target]) => [source, replacements[target] ?? target]))
  const canvas = useCanvasStore.getState()
  const history = useHistoryStore.getState()
  const copy = structuredClone({
    boards: canvas.boards,
    recordings: [
      ...history.recordings,
      { events: history.events },
      ...(history.recordingSession ? [history.recordingSession] : []),
    ],
  })
  applySavedAssets(copy, replacements, fingerprints)
  useCanvasStore.setState({ boards: copy.boards })
  const recordedCount = history.recordings.length
  useHistoryStore.setState({
    recordings: copy.recordings.slice(0, recordedCount) as typeof history.recordings,
    events: copy.recordings[recordedCount].events,
    recordingSession: history.recordingSession
      ? copy.recordings[recordedCount + 1] as typeof history.recordingSession
      : null,
  })
  void preloadProjectImages(copy.boards)
}

async function writeProjectSnapshot(path: string, snapshot: ProjectFile, revision: number): Promise<boolean> {
  try {
    if (projectSessionRevision() === revision) {
      applySavedAssets(snapshot, resourceAliases, resourceFingerprints)
    }
    const payload = recoveryProjectFingerprint(snapshot)
    snapshot.updatedAt = payload === lastSavedProjectPayload ? projectUpdatedAt : Date.now()
    const result = await ipc().invoke('file:save', { path, data: JSON.stringify(snapshot, null, 2) }) as
      { ok?: boolean; data?: string; assetReplacements?: Record<string, string>; sourceFingerprints?: Record<string, SourceFingerprint> } | undefined
    if (result?.ok === false) return false
    // Saving an earlier project may finish after New/Open. The write succeeds,
    // but must never rename or replace the project the person switched to.
    if (projectSessionRevision() !== revision) return true
    const unchanged = recoveryProjectFingerprint(createProjectFile()) === payload
    adoptSavedResourcePaths(result?.assetReplacements ?? {}, result?.sourceFingerprints ?? {})
    projectCreatedAt = snapshot.createdAt
    projectUpdatedAt = snapshot.updatedAt
    applySavedAssets(snapshot, resourceAliases, resourceFingerprints)
    lastSavedProjectPayload = recoveryProjectFingerprint(snapshot)
    currentFilePath = path
    if (unchanged) {
      useHistoryStore.getState().markSaved()
      captureSaveSnapshot()
    } else {
      useHistoryStore.getState().markDirty()
    }
    resetRecoveryAutosaveCache()
    setSaveActivity({ lastManualSaveAt: Date.now() })
    notifyProjectPathChanged()
    rememberRecentProject(path).catch(console.error)
    return true
  } catch {
    return false
  }
}

export function saveProject(path: string): Promise<boolean> {
  const snapshot = structuredClone(createProjectFile())
  const revision = projectSessionRevision()
  // Serialize writes so repeated Ctrl+S cannot let an older PNG conversion
  // finish last and overwrite a newer snapshot on disk.
  const pending = saveQueue.then(() => writeProjectSnapshot(path, snapshot, revision))
  saveQueue = pending.catch(() => {})
  return pending
}

export async function saveProjectAs(): Promise<string | null> {
  const result = await ipc().invoke('file:saveDialog', {}) as { path: string | null }
  if (!result.path) return null
  const ok = await saveProject(result.path)
  return ok ? result.path : null
}

export async function saveCurrentOrAs(): Promise<boolean> {
  if (currentFilePath) return saveProject(currentFilePath)
  const path = await saveProjectAs()
  return path !== null
}

function surfaceOpenFailure(error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error)
  inscribe(`Could not open the project: ${reason}`, { tone: 'danger' })
}

export async function openProject(): Promise<boolean> {
  if (!confirmDiscardUnsaved()) return false
  const result = await ipc().invoke('file:openDialog') as { path: string | null }
  if (!result.path) return false
  try {
    return await loadProjectFromPath(result.path)
  } catch (error) {
    surfaceOpenFailure(error)
    return false
  }
}

export async function openRecentProject(path: string): Promise<boolean> {
  if (!confirmDiscardUnsaved()) return false
  try {
    return await loadProjectFromPath(path)
  } catch (error) {
    surfaceOpenFailure(error)
    return false
  }
}

/** One request for the lifetime of this renderer, including StrictMode mounts. */
export function openStartupProject(): Promise<boolean> {
  startupProjectRequest ??= (async () => {
    try {
      const result = await ipc().invoke('file:startupProject') as { path?: string | null }
      return result?.path ? openRecentProject(result.path) : false
    } catch (error) {
      surfaceOpenFailure(error)
      return false
    }
  })()
  return startupProjectRequest
}

/**
 * Opens the shipped example project as a tour.
 *
 * Deliberately does not adopt its path the way opening a normal project does.
 * The example lives in the app's own resources, which are read-only wherever
 * the app is properly installed — taking its path would point Ctrl+S at a file
 * the user cannot write. Left pathless, the tour behaves like unsaved work:
 * saving asks where to put it, and their copy is their own.
 */
export async function openShowcase(): Promise<boolean> {
  if (!confirmDiscardUnsaved()) return false
  try {
    const loaded = await ipc().invoke('showcase:load') as { data: string | null }
    if (!loaded?.data) {
      inscribe('The example project is not installed alongside this build', { tone: 'danger' })
      return false
    }
    applyProject(deserialize(loaded.data))
    currentFilePath = null
    resetSaveActivity()
    resetRecoveryAutosaveCache()
    notifyProjectPathChanged()
    inscribe(isBrowserDemo
      ? 'Example project opened — changes reset when you reload'
      : 'Example project opened — save a copy to keep your changes')
    return true
  } catch (error) {
    surfaceOpenFailure(error)
    return false
  }
}

export function newProject(): boolean {
  if (!confirmDiscardUnsaved()) return false
  currentFilePath = null
  beginProjectSession()
  clearImageMemoryCache()
  projectCreatedAt = Date.now()
  projectUpdatedAt = projectCreatedAt
  projectKeybindOverrides = undefined
  lastSavedProjectPayload = null
  resourceAliases = {}
  resourceFingerprints = {}
  resetSaveActivity()
  resetRecoveryAutosaveCache()
  useCanvasStore.setState({ boards: [], activeBoardId: null, selectedIds: [] })
  useCanvasStore.getState().initDefaultBoard()
  useHistoryStore.getState().resetHistory()
  notifyProjectPathChanged()
  return true
}

export function loadProjectData(file: ProjectFile): void {
  currentFilePath = null
  resetSaveActivity()
  resetRecoveryAutosaveCache()
  applyProject(file)
  notifyProjectPathChanged()
}

export async function clearRecoveryIfClean(): Promise<boolean> {
  if (useHistoryStore.getState().isDirty()) return false
  try {
    await ipc().invoke('recovery:clear')
    return true
  } catch {
    return false
  }
}

export async function autoSave(): Promise<AutoSaveResult> {
  if (!useHistoryStore.getState().isDirty()) return 'skipped-clean'
  const snapshot = createRecoverySnapshot()
  const projectPayload = recoveryProjectFingerprint(snapshot.project)
  if (projectPayload === lastRecoveryProjectPayload) return 'skipped-unchanged'
  const payload = JSON.stringify(snapshot, null, 2)
  try {
    await ipc().invoke('file:saveRecovery', { data: payload })
    lastRecoveryProjectPayload = projectPayload
    setSaveActivity({ lastRecoverySaveAt: Date.now() })
    return 'saved'
  } catch {
    return 'failed'
  }
}
