import { existsSync as ExistsSync, readFileSync as ReadFileSync } from 'node:fs'
import { resolve as Resolve } from 'node:path'
import { ImageStore } from '../Source/Server/Storage'
import { EmptyDocument } from '../Source/Shared/Types'

async function Main(): Promise<void> {
  const Root = Resolve(__dirname, '../../..')
  const Path = Resolve(Root, 'Project/Demo/Demo.hbr')
  if (ExistsSync(Path)) throw new Error('Demo.hbr already exists; user projects are never overwritten by this generator.')
  const Showcase: { boards: { items: { id: string; src?: string }[] }[] } = JSON.parse(ReadFileSync(Resolve(Root, 'Code/Resource/examples/showcase.citadel'), 'utf8'))
  const Items = Showcase.boards.flatMap(Board => Board.items)
  const Sources = ['media-image', 'res-tinted'].map(Id => {
    const Source = Items.find(Item => Item.id === Id)?.src
    const Match = Source?.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/)
    if (!Match) throw new Error(`The bundled showcase image ${Id} is unavailable.`)
    return { name: `${Id}.png`, bytes: Buffer.from(Match[1], 'base64') }
  })
  Sources.push({ name: 'Icon.png', bytes: ReadFileSync(Resolve(Root, 'Code/Resource/icon.png')) })
  const Store = new ImageStore()
  const Imported = await Store.ImportBuffers(Sources)
  if (Imported.errors.length) throw new Error(Imported.errors.join('\n'))
  const Document = EmptyDocument()
  Document.viewport = { x: 90, y: 180, zoom: 1 }
  Document.images = Imported.assets.map((Asset, Index) => ({ id: `reference-${Index + 1}`, asset: Asset.id, x: Index * 380, y: Index === 1 ? 100 : 0, width: 350, height: 350 * Asset.height / Asset.width }))
  await Store.SaveProject(Path, Document)
  console.log(`Created ${Path}`)
}
void Main().catch(CaughtError => { console.error(CaughtError); process.exitCode = 1 })
