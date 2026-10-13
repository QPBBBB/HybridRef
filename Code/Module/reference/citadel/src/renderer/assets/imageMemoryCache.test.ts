import { describe, expect, it, vi } from 'vitest'
import type { CanvasBoard, CanvasItem } from '../../types'
import { ImageMemoryCache, projectImageUrls } from './imageMemoryCache'

function fixture() {
  const images: HTMLImageElement[] = []
  const createImage = vi.fn(() => {
    const image = {
      src: '', onload: null, onerror: null, decode: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLImageElement
    images.push(image)
    return image
  })
  const cache = new ImageMemoryCache(createImage)
  const loaded = (index: number) => images[index].onload?.call(images[index], {} as Event)
  const failed = (index: number) => images[index].onerror?.call(images[index], {} as Event)
  return { cache, images, createImage, loaded, failed }
}

describe('project image memory cache', () => {
  it('shares in-flight fetches and fully decoded pixels between repeated references', async () => {
    const { cache, images, createImage, loaded } = fixture()
    const first = cache.load('local:///D:/图/test.png')
    const second = cache.load('local:///D:/图/test.png')
    expect(second).toBe(first)
    expect(cache.snapshot('local:///D:/图/test.png').status).toBe('loading')
    loaded(0)
    expect(await first).toBe(images[0])
    expect(await second).toBe(images[0])
    expect(images[0].decode).toHaveBeenCalledOnce()
    expect(await cache.load('local:///D:/图/test.png')).toBe(images[0])
    expect(createImage).toHaveBeenCalledOnce()
  })

  it('retains images when all canvas listeners unmount and only releases on project clear', async () => {
    const { cache, images, createImage, loaded } = fixture()
    const listener = vi.fn()
    const unsubscribe = cache.subscribe('image.png', listener)
    const loading = cache.load('image.png')
    loaded(0)
    await loading
    unsubscribe()
    expect(await cache.load('image.png')).toBe(images[0])
    expect(createImage).toHaveBeenCalledOnce()
    cache.clear()
    expect(cache.snapshot('image.png')).toEqual({ status: 'idle', generation: 1 })
    const reloaded = cache.load('image.png')
    loaded(1)
    expect(await reloaded).toBe(images[1])
  })

  it('settles cancelled preloads and ignores decode completion from the previous project', async () => {
    const { cache, images, loaded } = fixture()
    let finishDecode!: () => void
    const loading = cache.load('old.png')
    vi.mocked(images[0].decode).mockImplementation(() => new Promise((resolve) => { finishDecode = resolve }))
    loaded(0)
    cache.clear()
    expect(await loading).toBeUndefined()
    finishDecode()
    await Promise.resolve()
    expect(cache.snapshot('old.png').status).toBe('idle')
    expect(images[0].src).toBe('')
  })

  it('handles unavailable images without rejecting the whole project preload', async () => {
    const { cache, failed } = fixture()
    const loading = cache.load('missing.png')
    failed(0)
    expect(await loading).toBeUndefined()
    expect(cache.snapshot('missing.png').status).toBe('failed')
    expect(await cache.load('')).toBeUndefined()
  })

  it('preloads hidden and inactive-board images and comparison slots once, leaving GIF playback alone', () => {
    const item = (type: CanvasItem['type'], src?: string, meta?: CanvasItem['meta']) => ({ type, src, meta, visible: false }) as CanvasItem
    const boards = [
      { items: [item('image', 'D:\\参考\\a.png'), item('gif', 'D:/参考/animated.gif')] },
      { items: [item('image', 'D:/参考/a.png'), item('comparison', undefined, { srcA: 'D:/参考/a.png', srcB: 'D:/参考/b.png' }), item('video', 'movie.mp4')] },
    ] as CanvasBoard[]
    expect(projectImageUrls(boards)).toEqual(['local:///D:/%E5%8F%82%E8%80%83/a.png', 'local:///D:/%E5%8F%82%E8%80%83/b.png'])
  })
})
