const Fs = require('node:fs')
const Path = require('node:path')
const { spawnSync: SpawnSync } = require('node:child_process')
const ModuleRoot = Path.resolve(__dirname, '..')
const Output = Path.join(ModuleRoot, 'Output/Agent/Index.cjs')

function Latest(Directory) {
  return Math.max(Fs.statSync(Directory).mtimeMs, ...Fs.readdirSync(Directory, { withFileTypes: true }).map(Entry => {
    const Filename = Path.join(Directory, Entry.name)
    return Entry.isDirectory() ? Latest(Filename) : Fs.statSync(Filename).mtimeMs
  }))
}

try {
  const Inputs = ['Source/Agent', 'Source/Shared', 'Source/Server'].map(Directory => Latest(Path.join(ModuleRoot, Directory)))
  Inputs.push(Fs.statSync(__filename).mtimeMs)
  if (!Fs.existsSync(Output) || Math.max(...Inputs) > Fs.statSync(Output).mtimeMs) {
    require('esbuild').buildSync({ absWorkingDir: ModuleRoot, entryPoints: ['Source/Agent/Index.ts'], outfile: Output,
      bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', logLevel: 'silent' })
  }
  const Result = SpawnSync(process.execPath, [Output, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true })
  if (Result.error) throw Result.error
  process.exitCode = Result.status ?? 1
} catch (CaughtError) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: CaughtError.message, hint: 'Check bundled dependencies with Dependencies/Setup.cmd.' })}\n`)
  process.exitCode = 1
}
