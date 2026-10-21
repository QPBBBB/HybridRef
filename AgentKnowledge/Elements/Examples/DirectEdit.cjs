// Executable example: edit the TextA config and content through YAML directly.
// Run only on the example project made by Walkthrough.ps1.
const Fs = require('node:fs')
const Path = require('node:path')
const Crypto = require('node:crypto')
const { spawnSync: SpawnSync } = require('node:child_process')
const Repository = Path.resolve(__dirname, '../../..')
const Yaml = require(Path.join(Repository, 'Code/Module/node_modules/yaml'))
const Project = Path.resolve(process.argv[2])
const Result = SpawnSync(process.execPath, [Path.join(Repository, 'Code/Module/Scripts/RunAgent.cjs'), 'element', 'inspect', '--project', Project, '--id', 'TextA'], { encoding: 'utf8', windowsHide: true })
if (Result.status !== 0) throw new Error(Result.stderr)
const Entry = JSON.parse(Result.stdout).element
const Directory = Path.dirname(Project)
const ConfigPath = Path.join(Directory, Entry.config)
const Config = Yaml.parse(Fs.readFileSync(ConfigPath, 'utf8'))
const Layout = { ...Config.instances.TextA, x: Config.instances.TextA.x + 24, y: Config.instances.TextA.y + 16 }
const Content = Yaml.parse(Fs.readFileSync(Path.join(Directory, Entry.asset), 'utf8'))
Content.content += '\n\n通过直接编辑 YAML 更新。'
const Bytes = Buffer.from(Yaml.stringify(Content), 'utf8')
const Hash = Crypto.createHash('sha256').update(Bytes).digest('hex').slice(0, 8).toUpperCase()
const Name = Path.basename(Entry.asset).replace(/_[A-F0-9]{8}\.yaml$/, `_${Hash}.yaml`)
const ResourcePath = Path.join(Directory, 'Resource', Name)
const NextConfig = { format: 'hybridref-text-layout', formatVersion: 1, instances: { TextA: Layout } }
// First stage the complete content. No .hbr write is necessary.
Fs.writeFileSync(ResourcePath, Bytes, { flag: 'wx' })
// Keep any sibling instances and keep the old immutable content for references.
delete Config.instances.TextA
Fs.writeFileSync(ConfigPath, Yaml.stringify(Config))
Fs.writeFileSync(ResourcePath.replace('.yaml', '.config'), Yaml.stringify(NextConfig), { flag: 'wx' })
process.stdout.write(`${JSON.stringify({ ok: true, asset: ResourcePath, requiresRefresh: true })}\n`)
