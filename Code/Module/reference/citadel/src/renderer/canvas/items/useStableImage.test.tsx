// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearImageMemoryCache } from '../../assets/imageMemoryCache'
import { useStableImage } from './useStableImage'

const images: TestImage[] = []
class TestImage {
  src = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  decode = vi.fn().mockResolvedValue(undefined)
  constructor() { images.push(this) }
}

beforeEach(() => {
  clearImageMemoryCache()
  images.length = 0
  vi.stubGlobal('Image', TestImage)
})
afterEach(() => {
  cleanup()
  clearImageMemoryCache()
  vi.unstubAllGlobals()
})

describe('useStableImage', () => {
  it('reuses the decoded original after viewport culling unmounts and remounts an item', async () => {
    const first = renderHook(() => useStableImage('image.png'))
    const duplicate = renderHook(() => useStableImage('image.png'))
    expect(images).toHaveLength(1)
    await act(async () => { images[0].onload?.() })
    expect(first.result.current).toBe(images[0])
    expect(duplicate.result.current).toBe(images[0])
    first.unmount()
    duplicate.unmount()
    const remounted = renderHook(() => useStableImage('image.png'))
    expect(remounted.result.current).toBe(images[0])
    expect(images).toHaveLength(1)
  })

  it('never shows pixels from the previous project while the new image loads', async () => {
    const hook = renderHook(({ url }) => useStableImage(url), { initialProps: { url: 'old.png' } })
    await act(async () => { images[0].onload?.() })
    expect(hook.result.current).toBe(images[0])
    act(() => { clearImageMemoryCache() })
    hook.rerender({ url: 'new.png' })
    expect(hook.result.current).toBeUndefined()
    const latest = images.at(-1)!
    await act(async () => { latest.onload?.() })
    expect(hook.result.current).toBe(latest)
    hook.rerender({ url: '' })
    expect(hook.result.current).toBeUndefined()
  })

  it('stops displaying the previous source if a replacement image cannot load', async () => {
    const hook = renderHook(({ url }) => useStableImage(url), { initialProps: { url: 'original.png' } })
    await act(async () => { images[0].onload?.() })
    hook.rerender({ url: 'missing.png' })
    expect(hook.result.current).toBe(images[0])
    act(() => { images[1].onerror?.() })
    expect(hook.result.current).toBeUndefined()
  })
})
