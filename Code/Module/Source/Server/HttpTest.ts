import { randomUUID as RandomUUID } from 'node:crypto'
import { existsSync as ExistsSync, mkdtempSync as MkdtempSync, mkdirSync as MkdirSync, readFileSync as ReadFileSync, readdirSync as ReaddirSync, rmSync as RmSync, symlinkSync as SymlinkSync, writeFileSync as WriteFileSync } from 'node:fs'
import { request as Request, type Server } from 'node:http'
import { tmpdir as Tmpdir } from 'node:os'
import { join as Join, resolve as Resolve } from 'node:path'
import Sharp from 'sharp'
import { afterEach as AfterEach, describe as Describe, expect as Expect, it as It, vi as Vi } from 'vitest'
import { EmptyDocument, type BoardDocument } from '../Shared/Types'
import { CreateAppServer } from './Http'
import { ImageStore } from './Storage'

const Directories: string[] = []
const Servers: Server[] = []
function Temp(): string {
  const Path = MkdtempSync(Join(Tmpdir(), 'hybridref-http-'))
  Directories.push(Path)
  return Path
}
AfterEach(async () => {
  Vi.restoreAllMocks()
  for (const Server of Servers.splice(0)) await new Promise<void>((Done) => { Server.close(() => Done()); Server.closeAllConnections() })
  for (const Path of Directories.splice(0)) {
    if (!Resolve(Path).startsWith(Join(Tmpdir(), 'hybridref-http-'))) throw new Error('Unsafe test cleanup path')
    RmSync(Path, { recursive: true, force: true })
  }
})
async function App(CreateProjectDirectory = true) {
  const Root = Temp()
  const StaticDir = Join(Root, 'web')
  const ProjectDirectory = Join(Root, 'Project')
  MkdirSync(StaticDir)
  if (CreateProjectDirectory) MkdirSync(ProjectDirectory)
  WriteFileSync(Join(StaticDir, 'Index.html'), '<!doctype html><title>HybridRef</title>')
  WriteFileSync(Join(StaticDir, 'app.js'), 'console.log("browser")')
  const Server = CreateAppServer({ staticDir: StaticDir, projectDirectory: ProjectDirectory, buildId: 'test-build' })
  Servers.push(Server)
  await new Promise<void>((Accept) => Server.listen(0, '127.0.0.1', Accept))
  const Address = Server.address()
  if (!Address || typeof Address === 'string') throw new Error('Missing test listener address')
  const Port = Address.port
  const Session = RandomUUID()
  async function Call(Path: string, Body?: unknown, Options: { session?: string; method?: string; headers?: Record<string, string>; raw?: string } = {}) {
    const Text = Options.raw ?? (Body !== undefined ? JSON.stringify(Body) : undefined)
    const Method = Options.method ?? (Text !== undefined ? 'POST' : 'GET')
    return new Promise<{ status: number; body: any; text: string; headers: Record<string, unknown> }>((Accept, Reject) => {
      const Req = Request({ hostname: '127.0.0.1', port: Port, path: Path, method: Method, headers: {
        Connection: 'close',
        ...(Text !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(Text)), 'X-HybridRef-Client': 'browser', 'X-HybridRef-Session': Options.session ?? Session } : {}),
        ...Options.headers,
      } }, (Response) => {
        const Chunks: Buffer[] = []
        Response.on('data', (Chunk: Buffer) => Chunks.push(Chunk))
        Response.on('end', () => {
          const Output = Buffer.concat(Chunks).toString('utf8')
          let Parsed: unknown
          try { Parsed = JSON.parse(Output) } catch { Parsed = null }
          Accept({ status: Response.statusCode ?? 0, body: Parsed, text: Output, headers: Response.headers })
        })
        Response.on('error', Reject)
      })
      Req.on('error', Reject)
      Req.end(Text)
    })
  }
  return { root: Root, staticDir: StaticDir, projectDirectory: ProjectDirectory, port: Port, session: Session, call: Call }
}
async function Jpeg(): Promise<string> {
  return (await Sharp({ create: { width: 12, height: 8, channels: 3, background: '#2a85d7' } }).jpeg().toBuffer()).toString('base64')
}
function ImageBoard(Id: string): BoardDocument {
  return { ...EmptyDocument(), images: [{ id: 'image-1', asset: Id, x: 25, y: -10, width: 120, height: 80 }] }
}

Describe('local browser HTTP server', () => {
  It('serves health, static HTML/HEAD and same-origin JSON without exposing project files statically', async () => {
    const { call: Call, port: Port, projectDirectory: ProjectDirectory } = await App()
    const Health = await Call('/api/health')
    Expect(Health.status).toBe(200)
    Expect(Health.body).toEqual({ app: 'hybridref', buildId: 'test-build' })
    Expect((await Call('/')).text).toContain('<title>HybridRef</title>')
    const Head = await Call('/app.js', undefined, { method: 'HEAD' })
    Expect(Head.status).toBe(200)
    Expect(Head.text).toBe('')
    Expect(Head.headers['content-type']).toContain('javascript')
    Expect(Number(Head.headers['content-length'])).toBeGreaterThan(0)
    Expect((await Call('/api/ping', {}, { headers: { Origin: `http://127.0.0.1:${Port}` } })).body).toEqual({})
    Expect((await Call('/api/startup', {})).body).toBe(null)
    Expect((await Call('/api/startup', { path: null })).body).toBe(null)
    WriteFileSync(Join(ProjectDirectory, 'secret.txt'), 'private content')
    Expect((await Call('/Project/secret.txt')).status).toBe(404)
    Expect((await Call('/api/not-an-api')).status).toBe(404)
  })

  It('round-trips PNG assets through real HTTP with isolated tab caches and local YAML saving', async () => {
    const { call: Call, projectDirectory: ProjectDirectory } = await App()
    const Imported = await Call('/api/import', { files: [{ name: '照片.jpg', data: await Jpeg() }, { name: 'bad.png', data: 'bad%' }] })
    Expect(Imported.status).toBe(200)
    Expect(Imported.body.errors).toHaveLength(1)
    Expect(Imported.body.assets[0]).toMatchObject({ width: 12, height: 8 })
    Expect(Imported.body.assets[0].dataUrl).toMatch(/^data:image\/png;base64,/)
    const Document = ImageBoard(Imported.body.assets[0].id)
    const Path = Join(ProjectDirectory, '参考 #%25.hbr')
    Expect((await Call('/api/save', { path: Path, document: Document })).body).toEqual({ path: Path })
    const SecondTab = RandomUUID()
    const Isolated = await Call('/api/save', { path: Join(ProjectDirectory, 'Other.hbr'), document: Document }, { session: SecondTab })
    Expect(Isolated.status).toBe(400)
    Expect(Isolated.body.error).toContain('不在内存')
    const Loaded = await Call('/api/open', { path: Path }, { session: SecondTab })
    Expect(Loaded.body.document).toEqual(Document)
    Expect(Loaded.body.assets).toEqual(Imported.body.assets)
    Expect((await Call('/api/new', { name: 'Cleared' }, { session: SecondTab })).body).toEqual({ path: Join(ProjectDirectory, 'Cleared', 'Cleared.hbr') })
    Expect((await Call('/api/save', { path: Join(ProjectDirectory, 'Cleared.hbr'), document: Document }, { session: SecondTab })).status).toBe(400)
    Expect((await Call('/api/save', { path: Path, document: Document })).status).toBe(200)
    const Startup = await Call('/api/startup', { path: Path }, { session: RandomUUID() })
    Expect(Startup.body.document).toEqual(Document)
  })

  It('requires confirmation before replacing another tab’s project and still protects version 1', async () => {
    const { call: Call, projectDirectory: ProjectDirectory } = await App()
    const Path = Join(ProjectDirectory, 'Existing.hbr')
    Expect((await Call('/api/save', { path: Path, document: EmptyDocument() })).status).toBe(200)
    const Before = ReadFileSync(Path, 'utf8')
    const NextTab = RandomUUID()
    const Changed = { ...EmptyDocument(), viewport: { x: 200, y: 0, zoom: 1 } }
    const Conflict = await Call('/api/save', { path: Path, document: Changed }, { session: NextTab })
    Expect(Conflict.status).toBe(409)
    Expect(Conflict.body).toEqual({ error: '文件已存在', code: 'EXISTS' })
    Expect(ReadFileSync(Path, 'utf8')).toBe(Before)
    Expect((await Call('/api/save', { path: Path, document: Changed, overwrite: true }, { session: NextTab })).status).toBe(200)
    Expect(ReadFileSync(Path, 'utf8')).toContain('x: 200')
    const OldPath = Join(ProjectDirectory, 'Old.hbr')
    const Old = 'format: hybridref\nformatVersion: 1\nboards: []\n'
    WriteFileSync(OldPath, Old)
    const OldSave = await Call('/api/save', { path: OldPath, document: EmptyDocument(), overwrite: true })
    Expect(OldSave.status).toBe(400)
    Expect(OldSave.body.error).toContain('旧版')
    Expect(ReadFileSync(OldPath, 'utf8')).toBe(Old)
  })

  It('keeps a sleeping tab’s unsaved image bytes when another tab requests after more than 24 hours', async () => {
    const { call: Call, projectDirectory: ProjectDirectory } = await App()
    let Now = Date.now()
    Vi.spyOn(Date, 'now').mockImplementation(() => Now)
    const Imported = await Call('/api/import', { files: [{ name: 'unsaved.jpg', data: await Jpeg() }] })
    Expect(Imported.status).toBe(200)
    const Document = ImageBoard(Imported.body.assets[0].id)
    Now += 25 * 60 * 60 * 1000
    Expect((await Call('/api/ping', {}, { session: RandomUUID() })).status).toBe(200)
    const Path = Join(ProjectDirectory, 'AfterSleep.hbr')
    Expect((await Call('/api/save', { path: Path, document: Document })).status).toBe(200)
    Now += 48 * 60 * 60 * 1000
    Expect((await Call('/api/new', { name: 'Awake' }, { session: RandomUUID() })).status).toBe(200)
    Expect((await Call('/api/ping', {})).status).toBe(200)
    Expect((await Call('/api/save', { path: Path, document: Document })).status).toBe(200)
  })

  It('serializes cross-tab saves so a simultaneous create cannot bypass overwrite confirmation', async () => {
    const { call: Call, projectDirectory: ProjectDirectory } = await App()
    const Path = Join(ProjectDirectory, 'Race.hbr')
    const Results = await Promise.all([
      Call('/api/save', { path: Path, document: EmptyDocument() }, { session: RandomUUID() }),
      Call('/api/save', { path: Path, document: EmptyDocument() }, { session: RandomUUID() }),
    ])
    Expect(Results.map((Result) => Result.status).sort()).toEqual([200, 409])
  })

  It('creates named projects beneath Project with their YAML and resource folder, even before any import', async () => {
    const { call: Call, projectDirectory: ProjectDirectory } = await App(false)
    const Name = '参考 #%25'
    const Directory = Join(ProjectDirectory, Name)
    const Path = Join(Directory, `${Name}.hbr`)
    const Created = await Call('/api/new', { name: Name })
    Expect(Created.status).toBe(200)
    Expect(Created.body).toEqual({ path: Path })
    Expect(ReaddirSync(Directory).sort()).toEqual([`${Name}.hbr`, `${Name}Resource`].sort())
    Expect(ReaddirSync(Join(Directory, `${Name}Resource`))).toEqual([])
    const Opened = await Call('/api/open', { path: Path }, { session: RandomUUID() })
    Expect(Opened.body.document).toEqual(EmptyDocument())
    Expect(Opened.body.assets).toEqual([])
    const Changed = { ...EmptyDocument(), viewport: { x: 91, y: -8, zoom: 2 } }
    Expect((await Call('/api/save', { path: Path, document: Changed })).status).toBe(200)
    Expect(ReadFileSync(Path, 'utf8')).toContain('x: 91')
  })

  It('saves the initial unnamed board into a named project without losing its cached images', async () => {
    const { call: Call, projectDirectory: ProjectDirectory } = await App()
    const Imported = await Call('/api/import', { files: [{ name: '参考.jpg', data: await Jpeg() }] })
    const Document = ImageBoard(Imported.body.assets[0].id)
    const Path = Join(ProjectDirectory, 'First', 'First.hbr')
    const Created = await Call('/api/new', { name: 'First', document: Document })
    Expect(Created.status).toBe(200)
    Expect(Created.body).toEqual({ path: Path })
    Expect(ReaddirSync(Join(ProjectDirectory, 'First', 'FirstResource'))).toEqual([`${Imported.body.assets[0].id}.png`])
    Expect(ReadFileSync(Path, 'utf8')).toContain(`FirstResource/${Imported.body.assets[0].id}.png`)
    const Loaded = await Call('/api/open', { path: Path }, { session: RandomUUID() })
    Expect(Loaded.body.document).toEqual(Document)
    Expect(Loaded.body.assets).toEqual(Imported.body.assets)
    Document.images[0].x = 77
    Expect((await Call('/api/save', { path: Path, document: Document })).status).toBe(200)
  })

  It('rejects path traversal, reserved Windows names and invalid project names without creating files', async () => {
    const { call: Call, projectDirectory: ProjectDirectory } = await App()
    const InvalidNames = [undefined, null, 123, '', ' ', '.', '..', '../Escape', '..\\Escape', 'D:\\Escape', '/Escape',
      'With/Slash', 'With\\Slash', 'Bad:Name', 'Bad*Name', 'Bad?Name', 'Bad"Name', 'Bad<Name', 'Bad>Name', 'Bad|Name',
      'Bad\0Name', 'Bad\nName', 'Trailing.', 'Trailing ', ' Leading', 'CON', 'con.txt', 'PRN', 'AUX', 'NUL',
      'COM1', 'Lpt9.png', 'COM¹', 'LPT²', 'CON .txt', 'CONIN$', 'CONOUT$', 'A'.repeat(248)]
    for (const Name of InvalidNames) {
      const Result = await Call('/api/new', { name: Name })
      Expect(Result.status, `Invalid name: ${String(Name)}`).toBe(400)
    }
    Expect(ReaddirSync(ProjectDirectory)).toEqual([])
  })

  It('rejects existing project directories and files, preserving the current board and cached images on every failure', async () => {
    const { call: Call, projectDirectory: ProjectDirectory } = await App()
    const Imported = await Call('/api/import', { files: [{ name: 'keep.jpg', data: await Jpeg() }] })
    const Document = ImageBoard(Imported.body.assets[0].id)
    const Current = Join(ProjectDirectory, 'Current', 'Current.hbr')
    Expect((await Call('/api/new', { name: 'Current', document: Document })).status).toBe(200)
    const Before = ReadFileSync(Current, 'utf8')
    MkdirSync(Join(ProjectDirectory, 'ExistingDirectory'))
    WriteFileSync(Join(ProjectDirectory, 'ExistingFile'), 'preserve this file')
    for (const Name of ['Current', 'ExistingDirectory', 'ExistingFile']) {
      const Result = await Call('/api/new', { name: Name })
      Expect(Result.status).toBe(409)
      Expect(Result.body.code).toBe('EXISTS')
    }
    Expect(ReadFileSync(Current, 'utf8')).toBe(Before)
    Expect(ReadFileSync(Join(ProjectDirectory, 'ExistingFile'), 'utf8')).toBe('preserve this file')
    Expect(ReaddirSync(Join(ProjectDirectory, 'ExistingDirectory'))).toEqual([])
    const Invalid = await Call('/api/new', { name: 'Invalid', document: null })
    Expect(Invalid.status).toBe(400)
    Expect(ExistsSync(Join(ProjectDirectory, 'Invalid'))).toBe(false)
    Vi.spyOn(ImageStore.prototype, 'SaveProject').mockRejectedValueOnce(new Error('simulated write failure'))
    Expect((await Call('/api/new', { name: 'Failed' })).status).toBe(400)
    Expect(ExistsSync(Join(ProjectDirectory, 'Failed'))).toBe(false)
    Document.images[0].x = 42
    Expect((await Call('/api/save', { path: Current, document: Document })).status).toBe(200)
    Expect(ReadFileSync(Current, 'utf8')).toContain('x: 42')
  })

  It('leaves any files written before a project-creation failure intact', async () => {
    const { call: Call, projectDirectory: ProjectDirectory } = await App()
    const Directory = Join(ProjectDirectory, 'Interrupted')
    Vi.spyOn(ImageStore.prototype, 'SaveProject').mockImplementationOnce(async () => {
      WriteFileSync(Join(Directory, 'Keep.txt'), 'partially written or externally added data')
      throw new Error('simulated interrupted save')
    })
    Expect((await Call('/api/new', { name: 'Interrupted' })).status).toBe(400)
    Expect(ReadFileSync(Join(Directory, 'Keep.txt'), 'utf8')).toBe('partially written or externally added data')
    Expect((await Call('/api/new', { name: 'Interrupted' })).status).toBe(409)
  })

  It('allows only one simultaneous creation of the same project across sessions', async () => {
    const { call: Call, projectDirectory: ProjectDirectory } = await App(false)
    const Results = await Promise.all([
      Call('/api/new', { name: 'Race', document: { ...EmptyDocument(), viewport: { x: 11, y: 0, zoom: 1 } } }, { session: RandomUUID() }),
      Call('/api/new', { name: 'Race', document: { ...EmptyDocument(), viewport: { x: 22, y: 0, zoom: 1 } } }, { session: RandomUUID() }),
    ])
    Expect(Results.map((Result) => Result.status).sort()).toEqual([200, 409])
    Expect(Results.find((Result) => Result.status === 409)?.body.code).toBe('EXISTS')
    const Winner = Results[0].status === 200 ? 11 : 22
    Expect(ReadFileSync(Join(ProjectDirectory, 'Race', 'Race.hbr'), 'utf8')).toContain(`x: ${Winner}`)
    Expect(ReaddirSync(Join(ProjectDirectory, 'Race')).sort()).toEqual(['Race.hbr', 'RaceResource'])
  })

  It('rejects cross-origin, rebinding Host, wrong ports, browser preflights and cross-site fetches', async () => {
    const { call: Call, port: Port } = await App()
    const BlockedHeaders: Record<string, string>[] = [
      { Origin: 'https://evil.example' },
      { Origin: `http://localhost:${Port}` },
      { Host: `evil.example:${Port}` },
      { Host: `127.0.0.1:${Port + 1}` },
      { 'Sec-Fetch-Site': 'cross-site' },
    ]
    for (const Headers of BlockedHeaders) {
      const Result = await Call('/api/ping', {}, { headers: Headers })
      Expect(Result.status).toBe(403)
      Expect(Result.headers['access-control-allow-origin']).toBeUndefined()
    }
    Expect((await Call('/api/import', undefined, { method: 'OPTIONS', headers: { Origin: `http://127.0.0.1:${Port}` } })).status).toBe(403)
    Expect((await Call('/api/health', undefined, { headers: { Host: `localhost:${Port}` } })).status).toBe(200)
    const Navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }
    Expect((await Call('/', undefined, { headers: Navigation })).status).toBe(200)
    Expect((await Call('/api/health', undefined, { headers: Navigation })).status).toBe(403)
  })

  It('requires the JSON client and UUID session headers and rejects malformed or oversized bodies', async () => {
    const { call: Call } = await App()
    Expect((await Call('/api/ping', {}, { headers: { 'Content-Type': 'text/plain' } })).status).toBe(415)
    Expect((await Call('/api/ping', {}, { headers: { 'X-HybridRef-Client': '' } })).status).toBe(403)
    Expect((await Call('/api/ping', {}, { session: '../session' })).status).toBe(400)
    Expect((await Call('/api/ping', undefined, { raw: '{invalid' })).status).toBe(400)
    Expect((await Call('/api/ping', [])).status).toBe(400)
    const Oversized = await Call('/api/import', {}, { headers: { 'Content-Length': String(256 * 1024 * 1024 + 1) } })
    Expect(Oversized.status).toBe(413)
    Expect(Oversized.body.error).toContain('256 MB')
  })

  It('browses the requested folder with directories first, only hbr files and filesystem roots', async () => {
    const { call: Call, projectDirectory: ProjectDirectory } = await App()
    MkdirSync(Join(ProjectDirectory, '目录 #%'))
    WriteFileSync(Join(ProjectDirectory, 'board.HBR'), '')
    WriteFileSync(Join(ProjectDirectory, 'ignore.png'), '')
    WriteFileSync(Join(ProjectDirectory, 'ignore.txt'), '')
    const Result = await Call('/api/browse', {})
    Expect(Result.status).toBe(200)
    Expect(Result.body.path).toBe(ProjectDirectory)
    Expect(Result.body.entries).toEqual([
      { name: '目录 #%', path: Join(ProjectDirectory, '目录 #%'), kind: 'directory' },
      { name: 'board.HBR', path: Join(ProjectDirectory, 'board.HBR'), kind: 'file' },
    ])
    Expect(Result.body.roots).toContain(ProjectDirectory)
    const Nested = await Call('/api/browse', { path: Join(ProjectDirectory, '目录 #%') })
    Expect(Nested.body.parent).toBe(ProjectDirectory)
    Expect(Nested.body.entries).toEqual([])
  })

  It('creates a missing Project directory when browsing the default location', async () => {
    const { call: Call, projectDirectory: ProjectDirectory } = await App(false)
    Expect(ExistsSync(ProjectDirectory)).toBe(false)
    const Result = await Call('/api/browse', {})
    Expect(Result.status).toBe(200)
    Expect(Result.body.path).toBe(ProjectDirectory)
    Expect(Result.body.entries).toEqual([])
    Expect(ReaddirSync(ProjectDirectory)).toEqual([])
  })

  It('blocks encoded, backslash and symbolic-link static path escapes', async () => {
    const { call: Call, root: Root, staticDir: StaticDir } = await App()
    WriteFileSync(Join(Root, 'private.txt'), 'private content')
    for (const Path of ['/../private.txt', '/%2e%2e/private.txt', '/%2e%2e%5cprivate.txt', '/C:/private.txt']) {
      const Result = await Call(Path)
      Expect(Result.status).toBe(404)
      Expect(Result.text).not.toContain('private content')
    }
    const Outside = Temp()
    WriteFileSync(Join(Outside, 'secret.txt'), 'outside content')
    SymlinkSync(Outside, Join(StaticDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    Expect((await Call('/escape/secret.txt')).status).toBe(404)
    Expect((await Call('/%broken')).status).toBe(400)
  })
})
