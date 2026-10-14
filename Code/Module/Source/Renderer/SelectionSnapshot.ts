import type { BoardImage, BoardText, ImageAsset } from '../Shared/Types'
import { BoundingBox } from './Geometry'
import { TextAppearance } from './TextAppearance'

/** Render at 100% board scale, independent of viewport zoom and screen DPI. */
export async function CreateSelectionSnapshot(Items: readonly (BoardImage | BoardText)[], Assets: Readonly<Record<string, ImageAsset>>, Background: string): Promise<Blob> {
  const Bounds = BoundingBox(Items)
  if (!Bounds) throw new Error('请先选择图片或文本')
  const Width = Math.ceil(Bounds.width), Height = Math.ceil(Bounds.height)
  // Reject excessive allocations explicitly; never silently reduce export resolution.
  if (!Number.isFinite(Width) || !Number.isFinite(Height) || Width < 1 || Height < 1
    || Width > 16384 || Height > 16384 || Width * Height > 64_000_000) {
    throw new Error('选区过大，请分批复制（最长边 16384 像素，总面积不超过 6400 万像素）')
  }
  const Namespace = 'http://www.w3.org/2000/svg'
  const Svg = document.createElementNS(Namespace, 'svg')
  Svg.setAttribute('width', String(Width)); Svg.setAttribute('height', String(Height))
  const Foreign = document.createElementNS(Namespace, 'foreignObject')
  Foreign.setAttribute('width', '100%'); Foreign.setAttribute('height', '100%')
  const Root = document.createElement('div')
  Object.assign(Root.style, { position: 'relative', width: `${Width}px`, height: `${Height}px`, overflow: 'hidden' })
  for (const Item of Items) {
    const Element = document.createElement('text' in Item ? 'div' : 'img')
    Object.assign(Element.style, {
      position: 'absolute', display: 'block', margin: '0', left: `${Item.x - Bounds.x}px`, top: `${Item.y - Bounds.y}px`,
      width: `${Item.width}px`, height: `${Item.height}px`,
    })
    if ('text' in Item) {
      Object.assign(Element.style, TextAppearance(Item.text))
      Element.textContent = Item.text.content
    } else {
      const Asset = Assets[Item.asset]
      if (!Asset) throw new Error('图片尚未加载完成，请稍后重试')
      ;(Element as HTMLImageElement).src = Asset.dataUrl
      Element.style.objectFit = Asset.missing ? 'contain' : 'fill'
      if (Asset.missing) Element.style.filter = 'brightness(0) invert(79%) sepia(18%) saturate(336%) hue-rotate(172deg)'
    }
    Root.append(Element)
  }
  Foreign.append(Root); Svg.append(Foreign)
  await document.fonts.ready
  const Raster = new Image()
  // A self-contained data URL keeps foreignObject rendering origin-clean in Edge.
  Raster.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(Svg))}`
  await Raster.decode()
  const Canvas = document.createElement('canvas')
  Canvas.width = Width; Canvas.height = Height
  const Context = Canvas.getContext('2d', { alpha: false })
  if (!Context) throw new Error('无法创建快照画布')
  Context.fillStyle = Background
  Context.fillRect(0, 0, Width, Height)
  Context.drawImage(Raster, 0, 0)
  // Native PNG encoding uses lossless compression, without quantization or a quality setting.
  try {
    return await new Promise<Blob>((Resolve, Reject) => Canvas.toBlob((Png) => {
      if (Png) Resolve(Png)
      else Reject(new Error('PNG 快照生成失败'))
    }, 'image/png'))
  } finally {
    Canvas.width = 0; Canvas.height = 0
  }
}
