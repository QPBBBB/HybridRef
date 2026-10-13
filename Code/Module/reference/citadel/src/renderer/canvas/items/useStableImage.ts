import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { imageMemoryCache, type ImageMemorySnapshot } from '../../assets/imageMemoryCache'

function useImageSnapshot(url: string): ImageMemorySnapshot {
  const subscribe = useCallback((listener: () => void) => imageMemoryCache.subscribe(url, listener), [url])
  const getSnapshot = useCallback(() => imageMemoryCache.snapshot(url), [url])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useImageLoadStatus(url: string): ImageMemorySnapshot['status'] {
  return useImageSnapshot(url).status
}

// Shared decoded images stay resident when viewport culling unmounts an item.
// Within a project, retain the previous image while its replacement loads.
export function useStableImage(url: string): HTMLImageElement | undefined {
  const snapshot = useImageSnapshot(url)
  const lastLoaded = useRef<{ generation: number; image: HTMLImageElement }>()
  useEffect(() => {
    if (url && snapshot.status === 'idle') void imageMemoryCache.load(url)
  }, [url, snapshot.status, snapshot.generation])
  useEffect(() => {
    if (snapshot.image) lastLoaded.current = { generation: snapshot.generation, image: snapshot.image }
  }, [snapshot])
  if (!url || snapshot.status === 'failed') return undefined
  return snapshot.image ?? (lastLoaded.current?.generation === snapshot.generation ? lastLoaded.current.image : undefined)
}
