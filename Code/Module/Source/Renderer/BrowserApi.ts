import { EmptyDocument, type BrowseResult, type HybridRefApi, type ImportResult, type LoadedBoard, type SaveResult } from '../Shared/Types'
import { RequestFilePath } from './FileDialog'

const LastPath = 'hybridref.lastPath'
class ApiError extends Error {
  constructor(Message: string, readonly Status: number, readonly Code?: string) { super(Message) }
}

export function CreateBrowserApi(): HybridRefApi {
  // A duplicated browser tab inherits sessionStorage, so each page gets a new image store.
  const Session = crypto.randomUUID()
  let Dirty = false
  window.addEventListener('beforeunload', (InputEvent) => { if (Dirty) { InputEvent.preventDefault(); InputEvent.returnValue = '' } })

  async function Post<T>(Endpoint: string, Body: unknown = {}): Promise<T> {
    const Response = await fetch(`/api/${Endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HybridRef-Client': 'browser', 'X-HybridRef-Session': Session }, body: JSON.stringify(Body),
    })
    const Result = await Response.json()
    if (!Response.ok) throw new ApiError(Result.message || Result.error || `请求失败 (${Response.status})`, Response.status, Result.code)
    return Result as T
  }
  const KeepAlive = (): void => { void Post('ping').catch(() => undefined) }
  window.setInterval(KeepAlive, 60_000)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') KeepAlive() })
  function Remember(Path: string | null): void {
    if (Path) sessionStorage.setItem(LastPath, Path)
    else sessionStorage.removeItem(LastPath)
    const Url = new URL(window.location.href)
    Url.searchParams.delete('project')
    window.history.replaceState(null, '', Url)
  }
  const Browse = (Path?: string): Promise<BrowseResult> => Post('browse', { path: Path })
  return {
    async Startup() {
      const Path = new URLSearchParams(window.location.search).get('project') || sessionStorage.getItem(LastPath) || undefined
      const Loaded = await Post<LoadedBoard | null>('startup', { path: Path })
      if (Loaded) Remember(Loaded.path)
      return Loaded
    },
    async NewProject() {
      const Name = await RequestFilePath({ mode: 'new', Browse })
      if (!Name) return null
      const Result = await Post<SaveResult>('new', { name: Name })
      Remember(Result.path)
      return { path: Result.path, document: EmptyDocument(), assets: [] }
    },
    async Open() {
      const Path = await RequestFilePath({ mode: 'open', initialPath: sessionStorage.getItem(LastPath) || undefined, Browse })
      if (!Path) return null
      const Loaded = await Post<LoadedBoard>('open', { path: Path })
      Remember(Loaded.path)
      return Loaded
    },
    async Save(Document, CurrentPath) {
      if (!CurrentPath && !sessionStorage.getItem(LastPath)) {
        const Name = await RequestFilePath({ mode: 'new', Browse })
        if (!Name) return null
        const Result = await Post<SaveResult>('new', { name: Name, document: Document })
        Remember(Result.path)
        return Result
      }
      const Path = CurrentPath || await RequestFilePath({ mode: 'save', initialPath: sessionStorage.getItem(LastPath) || undefined, Browse })
      if (!Path) return null
      let Result: SaveResult
      try { Result = await Post<SaveResult>('save', { path: Path, document: Document, overwrite: Boolean(CurrentPath) }) }
      catch (CaughtError) {
        if (!(CaughtError instanceof ApiError) || CaughtError.Status !== 409 || CaughtError.Code !== 'EXISTS') throw CaughtError
        if (!window.confirm(`文件已存在，是否覆盖？\n${Path}`)) return null
        Result = await Post<SaveResult>('save', { path: Path, document: Document, overwrite: true })
      }
      Remember(Result.path)
      return Result
    },
    async ImportBytes(Files) {
      const Encoded = Files.map(({ name: Name, bytes: Bytes }) => {
        const Parts: string[] = []
        for (let Index = 0; Index < Bytes.length; Index += 32768) Parts.push(String.fromCharCode(...Bytes.subarray(Index, Index + 32768)))
        return { name: Name, data: btoa(Parts.join('')) }
      })
      return Post<ImportResult>('import', { files: Encoded })
    },
    SetDirty(Value) { Dirty = Value },
  }
}
