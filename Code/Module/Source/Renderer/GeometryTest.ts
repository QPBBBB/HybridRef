import { describe as Describe, expect as Expect, it as It } from 'vitest'
import type { BoardImage, Viewport } from '../Shared/Types'
import {
  AlignImages, BoundingBox, FitViewport, Intersects, MaxZoom, MinZoom,
  RectFromPoints, ResizeGroup, ScreenToWorld, SnapMove, WorldToScreen, ZoomAt,
  type AlignMode, type ResizeCorner,
} from './Geometry'

const ImageValue = (Id: string, X: number, Y: number, Width: number, Height: number): BoardImage => ({ id: Id, asset: `asset-${Id}`, x: X, y: Y, width: Width, height: Height })

Describe('viewport transforms', () => {
  It('round-trips negative world coordinates after pan and zoom', () => {
    const Viewport: Viewport = { x: 25, y: -80, zoom: 0.25 }
    const Point = { x: -80, y: 100 }
    Expect(WorldToScreen(Point, Viewport)).toEqual({ x: 5, y: -55 })
    Expect(ScreenToWorld(WorldToScreen(Point, Viewport), Viewport)).toEqual(Point)
  })

  It.each([[4, 4], [0.001, MinZoom], [100, MaxZoom]])('keeps the cursor anchor fixed at zoom %s', (Requested, Expected) => {
    const Before = { x: 100, y: -50, zoom: 2 }
    const Cursor = { x: 300, y: 150 }
    const After = ZoomAt(Before, Cursor, Requested)
    Expect(After.zoom).toBe(Expected)
    Expect(ScreenToWorld(Cursor, After)).toEqual(ScreenToWorld(Cursor, Before))
    Expect(Before).toEqual({ x: 100, y: -50, zoom: 2 })
  })

  It('fits negative bounds with symmetric padding', () => {
    const Viewport = FitViewport({ x: -100, y: -50, width: 200, height: 100 }, { width: 800, height: 600 }, 50)
    Expect(Viewport).toEqual({ x: 400, y: 300, zoom: 3.5 })
    Expect(WorldToScreen({ x: -100, y: -50 }, Viewport)).toEqual({ x: 50, y: 125 })
    Expect(FitViewport(null, { width: 800, height: 600 })).toEqual({ x: 0, y: 0, zoom: 1 })
  })
})

Describe('selection bounds', () => {
  It('computes bounds across negative coordinates', () => {
    Expect(BoundingBox([ImageValue('a', -100, -50, 20, 30), ImageValue('b', -20, -120, 30, 50)]))
      .toEqual({ x: -100, y: -120, width: 110, height: 100 })
    Expect(BoundingBox([])).toBeNull()
  })

  It('supports reverse-direction marquee selection and edge touches', () => {
    const Marquee = RectFromPoints({ x: 20, y: 10 }, { x: -20, y: -30 })
    Expect(Marquee).toEqual({ x: -20, y: -30, width: 40, height: 40 })
    Expect(Intersects(Marquee, ImageValue('a', -25, -35, 5, 5))).toBe(true)
    Expect(Intersects(Marquee, ImageValue('b', 21, 0, 10, 10))).toBe(false)
  })
})

Describe('six-way alignment', () => {
  const Examples: [AlignMode, 'x' | 'y', number[]][] = [
    ['left', 'x', [-100, -100]], ['centerX', 'x', [-10, -30]], ['right', 'x', [80, 40]],
    ['top', 'y', [-50, -50]], ['centerY', 'y', [-20, -10]], ['bottom', 'y', [10, 30]],
  ]
  It.each(Examples)('aligns %s against selected bounds without changing others or input', (Mode, Axis, Expected) => {
    const Images = Object.freeze([
      Object.freeze(ImageValue('a', -100, -50, 20, 40)),
      Object.freeze(ImageValue('b', 40, 30, 60, 20)),
      Object.freeze(ImageValue('untouched', -1000, -1000, 500, 500)),
    ])
    const Result = AlignImages(Images, new Set(['a', 'b']), Mode)
    Expect(Result.slice(0, 2).map((Item) => Item[Axis])).toEqual(Expected)
    Expect(Result[2]).toBe(Images[2])
    const OtherAxis = Axis === 'x' ? 'y' : 'x'
    Expect(Result.map((Item) => Item[OtherAxis])).toEqual(Images.map((Item) => Item[OtherAxis]))
    Expect(Images[0]).toEqual(ImageValue('a', -100, -50, 20, 40))
  })
})

Describe('drag snapping', () => {
  It.each([0.02, 0.5, 1, 4, 16])('uses the same 6-screen-pixel tolerance at zoom %s', (Zoom) => {
    const Bounds = { x: 0, y: 0, width: 10, height: 10 }
    const Close = { x: 10 + 5 / Zoom, y: 2000, width: 20, height: 20 }
    const Far = { ...Close, x: 10 + 7 / Zoom }
    const Snapped = SnapMove(Bounds, [Close], 0, 0, 6 / Zoom)
    Expect(Snapped.dx).toBeCloseTo(5 / Zoom)
    Expect(Snapped.dy).toBe(0)
    Expect(Snapped.guides).toEqual([{ axis: 'x', position: Close.x }])
    Expect(SnapMove(Bounds, [Far], 0, 0, 6 / Zoom)).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  It('snaps a moved group at negative coordinates and chooses the nearest target', () => {
    const Bounds = Object.freeze({ x: -100, y: -100, width: 10, height: 10 })
    const Others = Object.freeze([
      Object.freeze({ x: -77, y: 200, width: 10, height: 10 }),
      Object.freeze({ x: -78, y: 200, width: 10, height: 10 }),
    ])
    Expect(SnapMove(Bounds, Others, 7, 0)).toEqual({ dx: 12, dy: 0, guides: [{ axis: 'x', position: -78 }] })
    Expect(Bounds.x).toBe(-100)
  })

  It('supports center-to-center alignment on both axes', () => {
    const Result = SnapMove({ x: -10, y: -10, width: 20, height: 20 }, [{ x: -29, y: -39, width: 60, height: 80 }], 0, 0)
    Expect(Result).toEqual({ dx: 1, dy: 1, guides: [{ axis: 'x', position: 1 }, { axis: 'y', position: 1 }] })
  })
})

Describe('proportional group resize', () => {
  const Original = Object.freeze([Object.freeze(ImageValue('a', 0, 0, 100, 50)), Object.freeze(ImageValue('b', 120, 50, 80, 50))])
  const Cases: [ResizeCorner, { x: number; y: number }, { x: number; y: number }][] = [
    ['se', { x: 400, y: 200 }, { x: 0, y: 0 }],
    ['nw', { x: -200, y: -100 }, { x: 200, y: 100 }],
    ['ne', { x: 400, y: -100 }, { x: 0, y: 100 }],
    ['sw', { x: -200, y: 200 }, { x: 200, y: 0 }],
  ]
  It.each(Cases)('keeps the opposite anchor fixed when resizing %s', (Corner, Pointer, Anchor) => {
    const Result = ResizeGroup(Original, Corner, Pointer)
    for (let Index = 0; Index < Result.length; Index++) {
      Expect(Result[Index].width).toBe(Original[Index].width * 2)
      Expect(Result[Index].height).toBe(Original[Index].height * 2)
      Expect(Result[Index].x - Anchor.x).toBe((Original[Index].x - Anchor.x) * 2)
      Expect(Result[Index].y - Anchor.y).toBe((Original[Index].y - Anchor.y) * 2)
    }
    Expect(Original[1]).toEqual(ImageValue('b', 120, 50, 80, 50))
  })

  It('keeps positive minimum dimensions and original aspect ratios past the anchor', () => {
    const Result = ResizeGroup(Original, 'se', { x: -1000, y: -500 }, 8)
    for (let Index = 0; Index < Result.length; Index++) {
      Expect(Math.min(Result[Index].width, Result[Index].height)).toBeGreaterThanOrEqual(8)
      Expect(Result[Index].width / Result[Index].height).toBe(Original[Index].width / Original[Index].height)
    }
    Expect(Result[1].x / Result[0].width).toBeCloseTo(Original[1].x / Original[0].width)
    Expect(Result[0].x).toBe(0)
    Expect(Result[0].y).toBe(0)
  })
})
