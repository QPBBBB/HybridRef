import { createServer as CreateServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir as Mkdir, readFile as ReadFile, readdir as Readdir, realpath as Realpath, rmdir as Rmdir, stat as Stat } from 'node:fs/promises'
import { basename as Basename, dirname as Dirname, extname as Extname, isAbsolute as IsAbsolute, join as Join, relative as Relative, resolve as Resolve } from 'node:path'
import { EmptyDocument, type BoardDocument, type SaveResult } from '../Shared/Types'
import { ImageStore } from './Storage'

type Options = { staticDir: string; projectDirectory: string; buildId?: string }
type Session = { store: ImageStore; currentPath: string | null; queue: Promise<void> }
type Body = Record<string, unknown>
const BodyLimit = 256 * 1024 * 1024
const SessionId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const ApiPaths = new Set(['/api/startup', '/api/open', '/api/save', '/api/import', '/api/browse', '/api/ping', '/api/new', '/api/projects', '/api/cleanup', '/api/scan', '/api/markdown-image'])
const Mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
}

class HttpError extends Error {
  constructor(readonly Status: number, Message: string, readonly Code?: string) { super(Message) }
}
function IsRecord(Value: unknown): Value is Body { return Value !== null && typeof Value === 'object' && !Array.isArray(Value) }
function IsMissing(CaughtError: unknown): boolean { return (CaughtError as NodeJS.ErrnoException)?.code === 'ENOENT' }
function Key(Path: string): string { return process.platform === 'win32' ? Path.toLowerCase() : Path }
function ProjectName(Value: unknown): string {
  if (typeof Value !== 'string' || !Value || Value.trim() !== Value || Value.length > 247
    || /[<>:"/\\|?*\u0000-\u001f]/.test(Value) || /[.\s]$/.test(Value)
    || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CLOCK\$|CONIN\$|CONOUT\$)$/i.test(Value.split('.')[0].trimEnd())) {
    throw new HttpError(400, '请输入有效的项目名称；不能包含路径、特殊字符或 Windows 保留名称。')
  }
  return Value
}
function Inside(Parent: string, Path: string): boolean {
  const Rel = Relative(Parent, Path)
  return Rel === '' || (!IsAbsolute(Rel) && Rel !== '..' && !Rel.startsWith('../') && !Rel.startsWith('..\\'))
}

function Json(Response: ServerResponse, Status: number, Value: unknown): void {
  const Body = JSON.stringify(Value)
  Response.writeHead(Status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(Body) })
  Response.end(Body)
}

function SecurityHeaders(Response: ServerResponse): void {
  Response.setHeader('X-Content-Type-Options', 'nosniff')
  Response.setHeader('X-Frame-Options', 'DENY')
  Response.setHeader('Referrer-Policy', 'no-referrer')
  Response.setHeader('Cache-Control', 'no-store')
  Response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
}

function CheckRequestOrigin(Request: IncomingMessage, Server: Server): void {
  const Address = Server.address()
  const Port = Address && typeof Address === 'object' ? Address.port : null
  const Host = Request.headers.host
  const Match = typeof Host === 'string' ? /^(127\.0\.0\.1|localhost):([0-9]+)$/i.exec(Host) : null
  if (!Match || Number(Match[2]) !== Port) throw new HttpError(403, '不允许此主机访问 HybridRef。')
  const Origin = Request.headers.origin
  if (Origin !== undefined && Origin !== `http://${Host!.toLowerCase()}`) throw new HttpError(403, '不允许跨站访问 HybridRef。')
  const Pathname = (Request.url ?? '/').split('?')[0]
  // A link clicked in another app is a cross-site top-level navigation. It may
  // open the public UI, while every API call still requires a same-origin tab.
  const EnteringApp = (Request.method === 'GET' || Request.method === 'HEAD')
    && Request.headers['sec-fetch-mode'] === 'navigate' && Request.headers['sec-fetch-dest'] === 'document'
    && Pathname !== '/api' && !Pathname.startsWith('/api/')
  if (Request.method === 'OPTIONS' || (Request.headers['sec-fetch-site'] === 'cross-site' && !EnteringApp)) throw new HttpError(403, '不允许跨站或预检请求。')
}

async function ReadBody(Request: IncomingMessage): Promise<Body> {
  if (Request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, '请求必须使用 application/json。')
  if (Request.headers['x-hybridref-client'] !== 'browser') throw new HttpError(403, '缺少 HybridRef 浏览器客户端标识。')
  const Declared = Number(Request.headers['content-length'])
  if (Number.isFinite(Declared) && Declared > BodyLimit) {
    Request.resume()
    throw new HttpError(413, '导入请求超过 256 MB 限制，请分批导入。')
  }
  const Bytes = await new Promise<Buffer>((Accept, Reject) => {
    const Chunks: Buffer[] = []
    let Size = 0
    const Cleanup = () => {
      Request.off('data', Data)
      Request.off('end', End)
      Request.off('error', Fail)
      Request.off('aborted', Aborted)
    }
    const Fail = (CaughtError: Error) => { Cleanup(); Reject(CaughtError) }
    const Aborted = () => Fail(new HttpError(400, '请求传输已中断。'))
    const Data = (Chunk: Buffer) => {
      Size += Chunk.length
      if (Size > BodyLimit) {
        Cleanup()
        Request.resume()
        Reject(new HttpError(413, '导入请求超过 256 MB 限制，请分批导入。'))
      } else Chunks.push(Chunk)
    }
    const End = () => { Cleanup(); Accept(Buffer.concat(Chunks, Size)) }
    Request.on('data', Data)
    Request.on('end', End)
    Request.on('error', Fail)
    Request.on('aborted', Aborted)
  })
  let Value: unknown
  try { Value = JSON.parse(Bytes.toString('utf8')) } catch { throw new HttpError(400, '请求 JSON 格式无效。') }
  if (!IsRecord(Value)) throw new HttpError(400, '请求内容必须是 JSON 对象。')
  return Value
}

async function Roots(ProjectDirectory: string): Promise<string[]> {
  if (process.platform !== 'win32') return [...new Set(['/', ProjectDirectory])]
  const Drives = await Promise.all(Array.from({ length: 26 }, async (Unused, Index) => {
    const Drive = `${String.fromCharCode(65 + Index)}:\\`
    try { return (await Stat(Drive)).isDirectory() ? Drive : null } catch { return null }
  }))
  return [...new Map([...Drives.filter((Drive): Drive is string => Drive !== null), ProjectDirectory].map((Path) => [Key(Path), Path])).values()]
}

async function Browse(Path: string, ProjectDirectory: string): Promise<unknown> {
  const Files = await Readdir(Path, { withFileTypes: true })
  const Entries = (await Promise.all(Files.map(async (Entry) => {
    const Child = Join(Path, Entry.name)
    let Directory = Entry.isDirectory()
    let FileValue = Entry.isFile()
    if (Entry.isSymbolicLink()) {
      try { const Info = await Stat(Child); Directory = Info.isDirectory(); FileValue = Info.isFile() } catch { return null }
    }
    if (!Directory && (!FileValue || Extname(Entry.name).toLowerCase() !== '.hbr')) return null
    return { name: Entry.name, path: Child, kind: Directory ? 'directory' as const : 'file' as const }
  }))).filter((Entry): Entry is NonNullable<typeof Entry> => Entry !== null)
  Entries.sort((A, B) => (A.kind === B.kind ? 0 : A.kind === 'directory' ? -1 : 1) || A.name.localeCompare(B.name, 'zh-CN'))
  return { path: Path, parent: Dirname(Path) === Path ? null : Dirname(Path), entries: Entries, roots: await Roots(ProjectDirectory) }
}

async function Projects(ProjectDirectory: string): Promise<{ name: string; path: string }[]> {
  await Mkdir(ProjectDirectory, { recursive: true })
  const Root = await Realpath(ProjectDirectory)
  const Entries = await Readdir(ProjectDirectory, { withFileTypes: true })
  const ResourceNames = new Set(Entries.filter(Entry => Entry.isFile() && Extname(Entry.name).toLowerCase() === '.hbr')
    .map(Entry => Key(`${Basename(Entry.name, Extname(Entry.name))}Resource`)))
  async function Contained(Path: string): Promise<boolean> {
    try { return Inside(Root, await Realpath(Path)) } catch { return false }
  }
  const Groups = await Promise.all(Entries.map(async Entry => {
    const Path = Join(ProjectDirectory, Entry.name)
    if (Entry.isSymbolicLink() || !(await Contained(Path))) return []
    if (Entry.isFile()) {
      return Extname(Entry.name).toLowerCase() === '.hbr'
        ? [{ name: Basename(Entry.name, Extname(Entry.name)), path: Path }] : []
    }
    if (!Entry.isDirectory() || ResourceNames.has(Key(Entry.name))) return []
    // Only inspect a project's immediate files; never descend into its assets.
    const Children = await Readdir(Path, { withFileTypes: true }).catch(() => [])
    if (Key(Entry.name) === Key('Resource') && !Children.some(File => File.isFile() && Key(File.name) === Key('Resource.hbr'))) return []
    const Files = (await Promise.all(Children.filter(File => File.isFile() && !File.isSymbolicLink() && Extname(File.name).toLowerCase() === '.hbr').map(async File => {
      const FilePath = Join(Path, File.name)
      return await Contained(FilePath) ? { name: File.name, path: FilePath } : null
    }))).filter((File): File is NonNullable<typeof File> => File !== null)
    return Files.map(File => ({ name: Files.length === 1 ? Entry.name : `${Entry.name} / ${Basename(File.name, Extname(File.name))}`, path: File.path }))
  }))
  return Groups.flat().sort((A, B) => A.name.localeCompare(B.name, 'zh-CN') || (A.path < B.path ? -1 : A.path > B.path ? 1 : 0))
}

async function ServeStatic(Request: IncomingMessage, Response: ServerResponse, StaticDir: string): Promise<void> {
  if (Request.method !== 'GET' && Request.method !== 'HEAD') throw new HttpError(405, '此资源仅支持 GET 或 HEAD。')
  let Pathname: string
  try { Pathname = decodeURIComponent((Request.url ?? '/').split('?')[0]).replace(/\\/g, '/') } catch { throw new HttpError(400, '网页资源路径无效。') }
  if (!Pathname.startsWith('/') || Pathname.includes('\0') || Pathname.includes(':') || Pathname.split('/').some((Part) => Part === '..')) throw new HttpError(404, '网页资源不存在。')
  const Path = Resolve(StaticDir, Pathname === '/' ? 'Index.html' : `.${Pathname}`)
  if (!Inside(StaticDir, Path)) throw new HttpError(404, '网页资源不存在。')
  let Real: string
  try {
    const [Root, Resolved] = await Promise.all([Realpath(StaticDir), Realpath(Path)])
    if (!Inside(Root, Resolved) || !(await Stat(Resolved)).isFile()) throw new HttpError(404, '网页资源不存在。')
    Real = Resolved
  } catch (CaughtError) { if (CaughtError instanceof HttpError) throw CaughtError; throw new HttpError(404, '网页资源不存在。') }
  const Content = await ReadFile(Real)
  Response.writeHead(200, { 'Content-Type': Mime[Extname(Real).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': Content.length })
  Response.end(Request.method === 'HEAD' ? undefined : Content)
}

/** Local browser host; listen only on 127.0.0.1 in the executable entry point. */
export function CreateAppServer(Options: Options): Server {
  const ProjectDirectory = Resolve(Options.projectDirectory)
  const StaticDir = Resolve(Options.staticDir)
  const Sessions = new Map<string, Session>()
  const Writes = new Map<string, Promise<void>>()

  function SessionFor(Request: IncomingMessage): Session {
    const Id = Request.headers['x-hybridref-session']
    if (typeof Id !== 'string' || !SessionId.test(Id)) throw new HttpError(400, '缺少有效的画板会话 ID。')
    // A sleeping tab can hold unsaved images. Never expire its bytes based on
    // elapsed time or another tab's requests; New/Open/host exit own cleanup.
    let Session = Sessions.get(Id)
    if (!Session) {
      Session = { store: new ImageStore(), currentPath: null, queue: Promise.resolve() }
      Sessions.set(Id, Session)
    }
    return Session
  }

  function PathFrom(Value: unknown): string {
    if (typeof Value !== 'string' || !Value.trim() || Value.includes('\0')) throw new HttpError(400, '请输入有效的本地文件路径。')
    return Resolve(ProjectDirectory, Value)
  }

  async function WithWriteLock<T>(Path: string, Work: () => Promise<T>): Promise<T> {
    const Id = Key(Path)
    const Pending = (Writes.get(Id) ?? Promise.resolve()).then(Work)
    const Tail = Pending.then(() => {}, () => {})
    Writes.set(Id, Tail)
    try { return await Pending } finally { if (Writes.get(Id) === Tail) Writes.delete(Id) }
  }

  async function Api(Path: string, Body: Body, Session: Session): Promise<unknown> {
    if (Path === '/api/ping') return {}
    if (Path === '/api/projects') return Projects(ProjectDirectory)
    if (Path === '/api/markdown-image') {
      if (typeof Body.source !== 'string' || !Body.source || Body.source.length > 28_000_000) throw new HttpError(400, 'Markdown 图片地址无效。')
      if (Body.projectPath !== Session.currentPath) throw new HttpError(409, '画板已切换，请重新加载图片。')
      return Session.store.MarkdownImage(Body.source)
    }
    if (Path === '/api/browse') {
      if (Body.path === undefined) await Mkdir(ProjectDirectory, { recursive: true })
      return Browse(Body.path === undefined ? ProjectDirectory : PathFrom(Body.path), ProjectDirectory)
    }
    if (Path === '/api/new') {
      const Name = ProjectName(Body.name)
      const Directory = Join(ProjectDirectory, Name)
      const Target = Join(Directory, `${Name}.hbr`)
      return WithWriteLock(Target, async () => {
        await Mkdir(ProjectDirectory, { recursive: true })
        try { await Mkdir(Directory) }
        catch (CaughtError) {
          if ((CaughtError as NodeJS.ErrnoException)?.code === 'EEXIST') throw new HttpError(409, '同名项目已存在，请使用其他名称。', 'EXISTS')
          throw CaughtError
        }
        const Store = Body.document === undefined ? new ImageStore() : Session.store
        let Saved: SaveResult
        try { Saved = await Store.SaveProject(Target, Body.document === undefined ? EmptyDocument() : Body.document as BoardDocument) }
        catch (CaughtError) {
          // Remove only our still-empty reservation; never erase a partially
          // written project or anything another process has added to it.
          await Rmdir(Directory).catch(() => {})
          throw CaughtError
        }
        if (Store !== Session.store) {
          Session.store.Clear()
          Session.store = Store
        }
        Session.currentPath = Target
        return Saved
      })
    }
    if (Path === '/api/startup' || Path === '/api/open') {
      if (Path === '/api/startup' && (Body.path === undefined || Body.path === null)) return null
      const Result = await Session.store.LoadProject(PathFrom(Body.path))
      Session.currentPath = Result.path
      return Result
    }
    if (Path === '/api/save') {
      let Target = PathFrom(Body.path)
      if (Extname(Target).toLowerCase() !== '.hbr') Target += '.hbr'
      return WithWriteLock(Target, async () => {
        let Exists = false
        try { await Stat(Target); Exists = true } catch (CaughtError) { if (!IsMissing(CaughtError)) throw CaughtError }
        if (Exists && Key(Target) !== (Session.currentPath ? Key(Session.currentPath) : null) && Body.overwrite !== true) throw new HttpError(409, '文件已存在', 'EXISTS')
        const Saved = await Session.store.SaveProject(Target, Body.document as BoardDocument)
        Session.currentPath = Target
        return Saved
      })
    }
    if (Path === '/api/cleanup') {
      const Target = PathFrom(Body.path)
      if (!Session.currentPath || Key(Target) !== Key(Session.currentPath)) throw new HttpError(400, '只能清理当前已打开的项目。')
      return WithWriteLock(Target, () => Session.store.CleanupProject(Target, Body.document as BoardDocument))
    }
    if (Path === '/api/scan') {
      const Target = PathFrom(Body.path)
      if (!Session.currentPath || Key(Target) !== Key(Session.currentPath)) throw new HttpError(400, '只能扫描当前已打开的项目。')
      return WithWriteLock(Target, () => Session.store.ScanProject(Target))
    }
    if (Path === '/api/import') {
      if (!Array.isArray(Body.files)) throw new HttpError(400, '导入请求缺少 files 列表。')
      const Files: { name: string; bytes: Uint8Array }[] = []
      const Errors: string[] = []
      for (const FileValue of Body.files) {
        if (!IsRecord(FileValue) || typeof FileValue.name !== 'string' || typeof FileValue.data !== 'string') throw new HttpError(400, '导入图片需要 name 和 base64 data。')
        if (!/^[a-z0-9+/]*={0,2}$/i.test(FileValue.data) || FileValue.data.length % 4 !== 0) { Errors.push(`${FileValue.name}：图片 base64 数据无效。`); continue }
        Files.push({ name: FileValue.name, bytes: Buffer.from(FileValue.data, 'base64') })
      }
      const Result = await Session.store.ImportBuffers(Files)
      return { assets: Result.assets, errors: [...Errors, ...Result.errors] }
    }
    throw new HttpError(404, '接口不存在。')
  }

  const Server = CreateServer((Request, Response) => {
    SecurityHeaders(Response)
    void (async () => {
      CheckRequestOrigin(Request, Server)
      const Pathname = (Request.url ?? '/').split('?')[0]
      if (Pathname === '/api/health' && Request.method === 'GET') { Json(Response, 200, { app: 'hybridref', buildId: Options.buildId ?? 'development' }); return }
      if (Pathname === '/api' || Pathname.startsWith('/api/')) {
        if (!ApiPaths.has(Pathname)) throw new HttpError(404, '接口不存在。')
        if (Request.method !== 'POST') throw new HttpError(405, '此接口仅支持 POST。')
        const Body = await ReadBody(Request)
        const Session = SessionFor(Request)
        const Result = Session.queue.then(() => Api(Pathname, Body, Session))
        // Image reads capture their project directory before awaiting I/O and
        // never mutate the store. Slow web images must not block saves or edits.
        if (Pathname !== '/api/markdown-image') Session.queue = Result.then(() => {}, () => {})
        Json(Response, 200, await Result)
        return
      }
      await ServeStatic(Request, Response, StaticDir)
    })().catch((CaughtError: unknown) => {
      Request.resume()
      if (Response.headersSent) { Response.destroy(); return }
      if (CaughtError instanceof HttpError) Json(Response, CaughtError.Status, { error: CaughtError.message, ...(CaughtError.Code ? { code: CaughtError.Code } : {}) })
      else Json(Response, IsMissing(CaughtError) ? 404 : 400, { error: `操作失败：${CaughtError instanceof Error ? CaughtError.message : String(CaughtError)}` })
    })
  })
  Server.on('close', () => { for (const Session of Sessions.values()) Session.store.Clear(); Sessions.clear() })
  return Server
}
