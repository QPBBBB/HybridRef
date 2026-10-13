import { mkdir as Mkdir, stat as Stat, writeFile as WriteFile } from 'node:fs/promises'
import { dirname as Dirname, resolve as Resolve } from 'node:path'
import { CreateAppServer } from './Http'

function Argument(Name: string): string | undefined {
  const Index = process.argv.indexOf(Name)
  return Index < 0 ? undefined : process.argv[Index + 1]
}

async function Main(): Promise<void> {
  const ModuleRoot = Resolve(__dirname, '../..')
  const StaticDir = Resolve(ModuleRoot, 'Output/Web')
  const Port = Number(Argument('--port') ?? 47321)
  if (!Number.isInteger(Port) || Port < 0 || Port > 65535) throw new Error('Invalid local server port')
  const [Backend, Frontend] = await Promise.all([Stat(__filename), Stat(Resolve(StaticDir, 'Index.html'))])
  const BuildId = `${Backend.mtimeMs}-${Frontend.mtimeMs}`
  const ProjectDirectory = Resolve(Argument('--project-directory') ?? Resolve(ModuleRoot, '../../Project'))
  const Server = CreateAppServer({ staticDir: StaticDir, projectDirectory: ProjectDirectory, buildId: BuildId })
  await new Promise<void>((Done, Fail) => {
    Server.once('error', Fail)
    Server.listen(Port, '127.0.0.1', () => { Server.removeListener('error', Fail); Done() })
  })
  const Address = Server.address()
  if (!Address || typeof Address === 'string') throw new Error('No HTTP address available')
  const Url = `http://127.0.0.1:${Address.port}`
  const Runtime = Argument('--runtime')
  try {
    if (Runtime) {
      await Mkdir(Dirname(Runtime), { recursive: true })
      await WriteFile(Runtime, JSON.stringify({ pid: process.pid, port: Address.port, url: Url, buildId: BuildId }), 'utf8')
    }
  } catch (CaughtError) {
    Server.close()
    throw CaughtError
  }
  console.log(`HybridRef listening at ${Url}`)
  const Shutdown = (): void => { Server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref() }
  process.once('SIGTERM', Shutdown)
  process.once('SIGINT', Shutdown)
}
void Main().catch(CaughtError => { console.error(CaughtError); process.exitCode = 1 })
