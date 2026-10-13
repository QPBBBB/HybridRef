import type { ImageAsset } from '../Shared/Types'

/** Hold every full-resolution decoded source until the board is replaced. */
const DecodedImages = new Map<string, { image: HTMLImageElement; ready: Promise<void> }>()

export function DecodeAssets(Assets: readonly ImageAsset[]): Promise<void> {
  return Promise.all(Assets.map((Asset) => {
    const Existing = DecodedImages.get(Asset.id)
    if (Existing) return Existing.ready
    const ImageValue = new Image()
    const Ready = new Promise<void>((Resolve, Reject) => {
      ImageValue.onload = () => {
        if (typeof ImageValue.decode === 'function') ImageValue.decode().then(Resolve, Reject)
        else Resolve()
      }
      ImageValue.onerror = () => Reject(new Error('图片解码失败'))
      ImageValue.src = Asset.dataUrl
    })
    DecodedImages.set(Asset.id, { image: ImageValue, ready: Ready })
    return Ready
  })).then(() => {})
}

export function ClearImageCache(): void { DecodedImages.clear() }
