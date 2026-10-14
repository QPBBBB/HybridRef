import { afterEach as AfterEach, beforeEach as BeforeEach, describe as Describe, expect as Expect, it as It, vi as Vi } from 'vitest'
import { EmptyDocument } from '../Shared/Types'
Vi.doMock('./FileDialog', () => ({ RequestFilePath: Vi.fn() }))
const { RequestFilePath } = await import('./FileDialog')
const { CreateBrowserApi } = await import('./BrowserApi')

const FetchMock = Vi.fn()
const PathDialog = Vi.mocked(RequestFilePath)
const Stored = new Map<string, string>()
let Unload: (InputEvent: Pick<BeforeUnloadEvent, 'preventDefault'> & { returnValue?: string }) => void
let Visible: () => void

function Response(Value: unknown, Status = 200): void {
  FetchMock.mockResolvedValueOnce({ ok: Status < 400, status: Status, json: async () => Value })
}
function Request(Index = 0): { endpoint: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const [Endpoint, Options] = FetchMock.mock.calls[Index]
  return { endpoint: Endpoint, headers: Options.headers, body: JSON.parse(Options.body) }
}

BeforeEach(() => {
  Vi.resetAllMocks(); Stored.clear()
  Vi.useFakeTimers()
  const Location = { href: 'http://127.0.0.1:47321/', search: '' }
  Vi.stubGlobal('window', {
    location: Location,
    history: { replaceState: Vi.fn((State, Title, Url: URL) => { Location.href = Url.toString(); Location.search = Url.search }) },
    addEventListener: Vi.fn((Type, Callback) => { Unload = Callback }),
    setInterval,
    confirm: Vi.fn(() => true),
  })
  Vi.stubGlobal('sessionStorage', { getItem: (Key: string) => Stored.get(Key) ?? null, setItem: (Key: string, Value: string) => Stored.set(Key, Value), removeItem: (Key: string) => Stored.delete(Key) })
  Vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: Vi.fn((Type, Callback) => { Visible = Callback }) })
  Vi.stubGlobal('fetch', FetchMock)
})
AfterEach(() => {
  Vi.clearAllTimers()
  Vi.unstubAllGlobals()
  Vi.useRealTimers()
})

Describe('browser API', () => {
  It('isolates duplicated tabs while restoring the last saved path', async () => {
    Stored.set('hybridref.lastPath', 'D:/参考/Test.hbr')
    Response(null); Response(null)
    await CreateBrowserApi().Startup()
    await CreateBrowserApi().Startup()
    Expect(Request().body).toEqual({ path: 'D:/参考/Test.hbr' })
    Expect(Request().headers['X-HybridRef-Client']).toBe('browser')
    Expect(Request().headers['Content-Type']).toBe('application/json')
    Expect(Request().headers['X-HybridRef-Session']).not.toBe(Request(1).headers['X-HybridRef-Session'])
  })

  It('uses a launcher project first and remembers the loaded path for refresh', async () => {
    const Project = 'D:/参考/启动.hbr'
    window.location.href = `http://127.0.0.1:47321/?project=${encodeURIComponent(Project)}`
    window.location.search = `?project=${encodeURIComponent(Project)}`
    Stored.set('hybridref.lastPath', 'D:/Old.hbr')
    Response({ path: Project, document: EmptyDocument(), assets: [] })
    await CreateBrowserApi().Startup()
    Expect(Request().body).toEqual({ path: Project })
    Expect(Stored.get('hybridref.lastPath')).toBe(Project)
    Expect(window.location.search).toBe('')
  })

  It('creates a named project and remembers its saved path', async () => {
    Stored.set('hybridref.lastPath', 'D:/Old.hbr')
    PathDialog.mockResolvedValueOnce('新参考')
    const Path = 'D:/Git/HybridRef/Project/新参考/新参考.hbr'
    Response({ path: Path })
    Expect(await CreateBrowserApi().NewProject()).toEqual({ path: Path, document: EmptyDocument(), assets: [] })
    Expect(PathDialog).toHaveBeenCalledWith(Expect.objectContaining({ mode: 'new' }))
    Expect(Request().endpoint).toBe('/api/new')
    Expect(Request().body).toEqual({ name: '新参考' })
    Expect(Stored.get('hybridref.lastPath')).toBe(Path)
  })

  It('keeps the current project when new project naming is cancelled', async () => {
    Stored.set('hybridref.lastPath', 'D:/Old.hbr')
    PathDialog.mockResolvedValueOnce(null)
    Expect(await CreateBrowserApi().NewProject()).toBeNull()
    Expect(FetchMock).not.toHaveBeenCalled()
    Expect(Stored.get('hybridref.lastPath')).toBe('D:/Old.hbr')
  })

  It('keeps the last path when creating a project fails', async () => {
    Stored.set('hybridref.lastPath', 'D:/Old.hbr')
    PathDialog.mockResolvedValueOnce('已存在')
    Response({ error: '项目已存在', code: 'EXISTS' }, 409)
    await Expect(CreateBrowserApi().NewProject()).rejects.toThrow('项目已存在')
    Expect(Stored.get('hybridref.lastPath')).toBe('D:/Old.hbr')
    Expect(window.confirm).not.toHaveBeenCalled()
  })

  It('creates a project with imported images on the first save of an untitled board', async () => {
    const Document = EmptyDocument()
    Document.images.push({ id: 'Image', asset: 'Asset', x: 15, y: 30, width: 320, height: 200 })
    const Path = 'D:/Git/HybridRef/Project/参考/参考.hbr'
    PathDialog.mockResolvedValueOnce('参考')
    Response({ path: Path })
    Expect(await CreateBrowserApi().Save(Document, null)).toEqual({ path: Path })
    Expect(PathDialog).toHaveBeenCalledWith(Expect.objectContaining({ mode: 'new' }))
    Expect(Request().endpoint).toBe('/api/new')
    Expect(Request().body).toEqual({ name: '参考', document: Document })
    Expect(Stored.get('hybridref.lastPath')).toBe(Path)
  })

  It('keeps an untitled board unsaved when the first save is cancelled', async () => {
    PathDialog.mockResolvedValueOnce(null)
    Expect(await CreateBrowserApi().Save(EmptyDocument(), null)).toBeNull()
    Expect(FetchMock).not.toHaveBeenCalled()
    Expect(Stored.has('hybridref.lastPath')).toBe(false)
  })

  It('does not remember an unsaved project when its first save fails', async () => {
    PathDialog.mockResolvedValueOnce('无效项目')
    Response({ error: '无法创建项目' }, 400)
    await Expect(CreateBrowserApi().Save(EmptyDocument(), null)).rejects.toThrow('无法创建项目')
    Expect(Stored.has('hybridref.lastPath')).toBe(false)
  })

  It('keeps the old last path when opening a file fails', async () => {
    Stored.set('hybridref.lastPath', 'D:/Old.hbr')
    Response({ error: '画板格式无效' }, 400)
    await Expect(CreateBrowserApi().Open('D:/Broken.hbr')).rejects.toThrow('画板格式无效')
    Expect(Stored.get('hybridref.lastPath')).toBe('D:/Old.hbr')
    Expect(PathDialog).not.toHaveBeenCalled()
  })

  It('scans projects on every request without changing the current project', async () => {
    Stored.set('hybridref.lastPath', 'D:/Old.hbr')
    const Entries = [{ name: 'Demo', path: 'D:/Git/HybridRef/Project/Demo/Demo.hbr' }]
    Response(Entries); Response([])
    const Api = CreateBrowserApi()
    Expect(await Api.ListProjects()).toEqual(Entries)
    Expect(await Api.ListProjects()).toEqual([])
    Expect(Request().endpoint).toBe('/api/projects')
    Expect(Request().body).toEqual({})
    Expect(Request(1).endpoint).toBe('/api/projects')
    Expect(Stored.get('hybridref.lastPath')).toBe('D:/Old.hbr')
    Expect(PathDialog).not.toHaveBeenCalled()
  })

  It('reports project scan errors without forgetting the open project', async () => {
    Stored.set('hybridref.lastPath', 'D:/Old.hbr')
    Response({ error: '无法读取项目目录' }, 400)
    await Expect(CreateBrowserApi().ListProjects()).rejects.toThrow('无法读取项目目录')
    Expect(Stored.get('hybridref.lastPath')).toBe('D:/Old.hbr')
  })

  It('opens the selected project path without a file picker', async () => {
    const Path = 'D:/Git/HybridRef/Project/Demo/Demo.hbr'
    const Loaded = { path: Path, document: EmptyDocument(), assets: [] }
    Response(Loaded)
    Expect(await CreateBrowserApi().Open(Path)).toEqual(Loaded)
    Expect(Request().endpoint).toBe('/api/open')
    Expect(Request().body).toEqual({ path: Path })
    Expect(PathDialog).not.toHaveBeenCalled()
    Expect(Stored.get('hybridref.lastPath')).toBe(Path)
  })

  It('asks before overwriting a destination chosen in Save As', async () => {
    Stored.set('hybridref.lastPath', 'D:/Open.hbr')
    PathDialog.mockResolvedValueOnce('D:/Existing.hbr')
    Response({ error: '文件已存在', code: 'EXISTS' }, 409)
    Response({ path: 'D:/Existing.hbr' })
    await CreateBrowserApi().Save(EmptyDocument(), null)
    Expect(Request().body.overwrite).toBe(false)
    Expect(window.confirm).toHaveBeenCalledOnce()
    Expect(Request(1).body.overwrite).toBe(true)
    Expect(Stored.get('hybridref.lastPath')).toBe('D:/Existing.hbr')
  })

  It('does not overwrite when the user cancels confirmation', async () => {
    Stored.set('hybridref.lastPath', 'D:/Open.hbr')
    PathDialog.mockResolvedValueOnce('D:/Existing.hbr')
    Vi.mocked(window.confirm).mockReturnValueOnce(false)
    Response({ error: '文件已存在', code: 'EXISTS' }, 409)
    Expect(await CreateBrowserApi().Save(EmptyDocument(), null)).toBeNull()
    Expect(FetchMock).toHaveBeenCalledTimes(1)
    Expect(Stored.get('hybridref.lastPath')).toBe('D:/Open.hbr')
  })

  It('allows Save As to choose a destination outside the default project folder', async () => {
    Stored.set('hybridref.lastPath', 'D:/Git/HybridRef/Project/参考/参考.hbr')
    PathDialog.mockResolvedValueOnce('E:/参考/副本.hbr')
    Response({ path: 'E:/参考/副本.hbr' })
    await CreateBrowserApi().Save(EmptyDocument(), null)
    Expect(PathDialog).toHaveBeenCalledWith(Expect.objectContaining({ mode: 'save', initialPath: 'D:/Git/HybridRef/Project/参考/参考.hbr' }))
    Expect(Request().endpoint).toBe('/api/save')
    Expect(Request().body).toEqual({ path: 'E:/参考/副本.hbr', document: EmptyDocument(), overwrite: false })
    Expect(Stored.get('hybridref.lastPath')).toBe('E:/参考/副本.hbr')
  })

  It('saves an already opened file directly without another file dialog', async () => {
    Response({ path: 'D:/Open.hbr' })
    await CreateBrowserApi().Save(EmptyDocument(), 'D:/Open.hbr')
    Expect(PathDialog).not.toHaveBeenCalled()
    Expect(Request().body.overwrite).toBe(true)
  })

  It('uploads image bytes as base64 without requesting a local file path', async () => {
    Response({ assets: [], errors: [] })
    await CreateBrowserApi().ImportBytes([{ name: '参考.png', bytes: new Uint8Array([0, 128, 255]) }])
    Expect(Request().body).toEqual({ files: [{ name: '参考.png', data: 'AID/' }] })
  })

  It('cleans the saved project using the current edited document without a file dialog', async () => {
    const Document = EmptyDocument()
    Document.images.push({ id: 'Image', asset: 'Asset', x: 15, y: 30, width: 320, height: 200 })
    const Result = { path: 'D:/参考/Test.hbr', document: EmptyDocument(), assets: [], removedFiles: 2 }
    Response(Result)
    Expect(await CreateBrowserApi().Cleanup(Document, Result.path)).toEqual(Result)
    Expect(Request().endpoint).toBe('/api/cleanup')
    Expect(Request().body).toEqual({ path: Result.path, document: Document })
    Expect(PathDialog).not.toHaveBeenCalled()
    Expect(Stored.get('hybridref.lastPath')).toBe(Result.path)
  })

  It('keeps the current path when cleanup fails', async () => {
    Stored.set('hybridref.lastPath', 'D:/Old.hbr')
    Response({ error: '无法清理资源' }, 400)
    await Expect(CreateBrowserApi().Cleanup(EmptyDocument(), 'D:/Broken.hbr')).rejects.toThrow('无法清理资源')
    Expect(Stored.get('hybridref.lastPath')).toBe('D:/Old.hbr')
  })

  It('only requests the browser close warning while there are unsaved edits', () => {
    const Api = CreateBrowserApi(), InputEvent = { preventDefault: Vi.fn(), returnValue: undefined as string | undefined }
    Unload(InputEvent)
    Expect(InputEvent.preventDefault).not.toHaveBeenCalled()
    Api.SetDirty(true); Unload(InputEvent)
    Expect(InputEvent.preventDefault).toHaveBeenCalledOnce()
    Expect(InputEvent.returnValue).toBe('')
    Api.SetDirty(false); Unload(InputEvent)
    Expect(InputEvent.preventDefault).toHaveBeenCalledOnce()
  })

  It('keeps a long-lived page session active and pings when the tab is revisited', async () => {
    CreateBrowserApi()
    Response({ ok: true })
    await Vi.advanceTimersByTimeAsync(60_000)
    Expect(Request().endpoint).toBe('/api/ping')
    Response({ ok: true })
    Visible()
    Expect(Request(1).endpoint).toBe('/api/ping')
  })
})
