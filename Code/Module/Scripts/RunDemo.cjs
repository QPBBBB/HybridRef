const Path = require('node:path')
const { spawnSync: SpawnSync } = require('node:child_process')
const Esbuild = require('esbuild')
const Root = Path.resolve(__dirname, '..')

async function RunDemo() {
  await Esbuild.build({
    absWorkingDir: Root, entryPoints: ['Scripts/CreateDemo.ts'], outfile: 'Runtime/CreateDemo.cjs',
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', logLevel: 'info',
  })
  const Result = SpawnSync(process.execPath, [Path.join(Root, 'Runtime/CreateDemo.cjs')], {
    cwd: Root, stdio: 'inherit', windowsHide: true,
  })
  if (Result.error) throw Result.error
  if (Result.status !== 0) process.exitCode = Result.status || 1
}
RunDemo().catch(CaughtError => { console.error(CaughtError); process.exitCode = 1 })
