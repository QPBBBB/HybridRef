import { existsSync as ExistsSync, readFileSync as ReadFileSync } from 'node:fs'
import { resolve as Resolve } from 'node:path'
import { parse as Parse } from 'yaml'
import { ImageStore } from '../Source/Server/Storage'
import { EmptyDocument } from '../Source/Shared/Types'

async function Main(): Promise<void> {
  const Root = Resolve(__dirname, '../../..')
  const Path = Resolve(Root, 'Project/Demo/SimpleDemo.hbr')
  if (ExistsSync(Path)) throw new Error('SimpleDemo.hbr already exists; user projects are never overwritten by this generator.')
  const Previous = Parse(ReadFileSync(Resolve(Root, 'Project/Demo/Demo.hbr'), 'utf8'))
  const Sources = Previous.boards[0].items.filter((Item: { id: string; src?: string }) => /^demo-image-[123]$/.test(Item.id) && Item.src)
  if (Sources.length !== 3) throw new Error('The original three demo images are unavailable.')
  const Store = new ImageStore()
  const Imported = await Store.ImportFiles(Sources.map((Item: { src: string }) => Resolve(Root, 'Project/Demo', Item.src)))
  if (Imported.errors.length) throw new Error(Imported.errors.join('\n'))
  const Document = EmptyDocument()
  Document.viewport = { x: 90, y: 180, zoom: 1 }
  Document.images = Imported.assets.map((Asset, I) => ({ id: `reference-${I + 1}`, asset: Asset.id, x: I * 380, y: I === 1 ? 100 : 0, width: 350, height: 350 * Asset.height / Asset.width }))
  await Store.SaveProject(Path, Document)
  console.log(`Created ${Path}`)
}
void Main().catch(CaughtError => { console.error(CaughtError); process.exitCode = 1 })
