import type { CanvasBoard } from '../../types'
import { pathToUrl } from '../utils/pathToUrl'

export type ImageMemorySnapshot = {
  status: 'idle' | 'loading' | 'loaded' | 'failed'
  image?: HTMLImageElement
  generation: number
}

type Entry = {
  snapshot: ImageMemorySnapshot
  promise: Promise<HTMLImageElement | undefined>
  cancel: () => void
}

/** Full-resolution images live for the project session, independently of mounted canvas nodes. */
export class ImageMemoryCache {
  private entries = new Map<string, Entry>()
  private listeners = new Map<string, Set<() => void>>()
  private idle: ImageMemorySnapshot = { status: 'idle', generation: 0 }

  constructor(private createImage: () => HTMLImageElement = () => new Image()) {}

  snapshot = (url: string): ImageMemorySnapshot => this.entries.get(url)?.snapshot ?? this.idle

  subscribe = (url: string, listener: () => void): (() => void) => {
    let subscribers = this.listeners.get(url)
    if (!subscribers) this.listeners.set(url, subscribers = new Set())
    subscribers.add(listener)
    return () => {
      subscribers.delete(listener)
      if (!subscribers.size) this.listeners.delete(url)
    }
  }

  private notify(url: string): void {
    this.listeners.get(url)?.forEach((listener) => listener())
  }

  load(url: string): Promise<HTMLImageElement | undefined> {
    if (!url) return Promise.resolve(undefined)
    const existing = this.entries.get(url)
    if (existing) return existing.promise

    const image = this.createImage()
    let resolve!: (image: HTMLImageElement | undefined) => void
    let settled = false
    const entry: Entry = {
      snapshot: { status: 'loading', generation: this.idle.generation },
      promise: new Promise((done) => { resolve = done }),
      cancel: () => {
        settled = true
        image.onload = null
        image.onerror = null
        // Abort a pending request when switching projects. A loaded image is
        // released by dropping the cache reference, without changing its pixels.
        if (entry.snapshot.status === 'loading') image.src = ''
        resolve(undefined)
      },
    }
    const finish = (loaded: boolean): void => {
      if (settled) return
      settled = true
      image.onload = null
      image.onerror = null
      entry.snapshot = {
        generation: entry.snapshot.generation,
        status: loaded ? 'loaded' : 'failed',
        ...(loaded ? { image } : {}),
      }
      resolve(loaded ? image : undefined)
      this.notify(url)
    }
    image.onload = () => {
      // Explicitly decode before publishing so prewarming also does the work
      // for offscreen images, rather than merely fetching their compressed bytes.
      if (typeof image.decode === 'function') void image.decode().then(() => finish(true), () => finish(false))
      else finish(true)
    }
    image.onerror = () => finish(false)
    this.entries.set(url, entry)
    image.src = url
    this.notify(url)
    return entry.promise
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.cancel()
    this.entries.clear()
    this.idle = { status: 'idle', generation: this.idle.generation + 1 }
    for (const url of this.listeners.keys()) this.notify(url)
  }
}

export const imageMemoryCache = new ImageMemoryCache()

export function clearImageMemoryCache(): void {
  imageMemoryCache.clear()
}

/** Includes hidden items, offscreen items, inactive boards, and both comparison slots. */
export function projectImageUrls(boards: readonly CanvasBoard[]): string[] {
  const sources = new Set<string>()
  for (const board of boards) {
    for (const item of board.items) {
      if (item.type === 'image' && item.src) sources.add(pathToUrl(item.src))
      if (item.type === 'comparison') {
        for (const source of [item.meta?.srcA, item.meta?.srcB]) {
          if (typeof source === 'string' && source) sources.add(pathToUrl(source))
        }
      }
    }
  }
  return [...sources]
}

export async function preloadProjectImages(boards: readonly CanvasBoard[]): Promise<void> {
  await Promise.all(projectImageUrls(boards).map((url) => imageMemoryCache.load(url)))
}
