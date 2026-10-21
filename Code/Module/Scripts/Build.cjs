const Path = require('node:path')
const { spawnSync: SpawnSync } = require('node:child_process')
const Esbuild = require('esbuild')
const Root = Path.resolve(__dirname, '..')

async function Build() {
  const Result = SpawnSync(process.execPath, [Path.join(Root, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: Root, stdio: 'inherit', windowsHide: true,
  })
  if (Result.error) throw Result.error
  if (Result.status !== 0) process.exit(Result.status || 1)
  await Esbuild.build({
    absWorkingDir: Root, entryPoints: ['Source/Server/Index.ts'], outfile: 'Output/Server/Index.cjs',
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', logLevel: 'info',
  })
  await Esbuild.build({
    absWorkingDir: Root, entryPoints: ['Source/Agent/Index.ts'], outfile: 'Output/Agent/Index.cjs',
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', logLevel: 'info',
  })
}
Build().catch(CaughtError => { console.error(CaughtError); process.exitCode = 1 })
