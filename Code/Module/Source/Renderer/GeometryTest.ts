import { describe as Describe, expect as Expect, it as It } from 'vitest'
import { EmptyTextResource, type BoardImage, type BoardText, type Viewport } from '../Shared/Types'
import {
  BoundingBox, CenterImages, FitViewport, Intersects, MaxZoom, MinZoom, NormalizeImages,
  PushImages, RectFromPoints, ResizeGroup, ResizeTextFrame, ScreenToWorld, SnapMove, WorldToScreen, ZoomAt,
  type CenterMode, type NormalizeMode, type PushDirection, type ResizeCorner,
} from './Geometry'

const ImageValue = (Id: string, X: number, Y: number, Width: number, Height: number): BoardImage => ({ id: Id, asset: `asset-${Id}`, x: X, y: Y, width: Width, height: Height })
const FreezeImages = (Images: BoardImage[]): readonly BoardImage[] => Object.freeze(Images.map((Image) => Object.freeze(Image)))
const SeparatedImages = FreezeImages([
  ImageValue('a', -100, -50, 20, 40), ImageValue('b', 40, 30, 60, 20), ImageValue('untouched', -1000, -1000, 500, 500),
])

function ExpectUnchanged(Result: readonly BoardImage[], Original: readonly BoardImage[]): void {
  Expect(Result).toEqual(Original)
  Result.forEach((Image, Index) => Expect(Image).toBe(Original[Index]))
}

function ExpectOnlyAxisChanged(Result: readonly BoardImage[], Original: readonly BoardImage[], Axis: 'x' | 'y'): void {
  const OtherAxis = Axis === 'x' ? 'y' : 'x'
  Expect(Result.map((Image) => [Image.id, Image.asset, Image[OtherAxis], Image.width, Image.height]))
    .toEqual(Original.map((Image) => [Image.id, Image.asset, Image[OtherAxis], Image.width, Image.height]))
}

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

Describe('centering within selected bounds', () => {
  const Examples: [CenterMode, 'x' | 'y', number[]][] = [
    ['horizontal', 'x', [-10, -30]], ['vertical', 'y', [-20, -10]],
  ]
  It.each(Examples)('centers selected images on the %s axis without changing others or input', (Mode, Axis, Expected) => {
    const Result = CenterImages(SeparatedImages, new Set(['a', 'b']), Mode)
    Expect(Result.slice(0, 2).map((Item) => Item[Axis])).toEqual(Expected)
    Expect(Result[2]).toBe(SeparatedImages[2])
    ExpectOnlyAxisChanged(Result, SeparatedImages, Axis)
    Expect(SeparatedImages[0]).toEqual(ImageValue('a', -100, -50, 20, 40))
  })
})

Describe('directional push', () => {
  const Modes: PushDirection[] = ['left', 'right', 'top', 'bottom']
  function Orient(Images: BoardImage[], Mode: PushDirection): BoardImage[] {
    return Mode === 'left' || Mode === 'right' ? Images : Images.map((Image) => ({ ...Image, x: Image.y, y: Image.x, width: Image.height, height: Image.width }))
  }
  function ExpectNoOverlap(Images: readonly BoardImage[]): void {
    for (let Index = 0; Index < Images.length; Index++) {
      for (const Other of Images.slice(Index + 1)) {
        const Image = Images[Index]
        Expect(Image.x + Image.width <= Other.x || Other.x + Other.width <= Image.x
          || Image.y + Image.height <= Other.y || Other.y + Other.height <= Image.y).toBe(true)
      }
    }
  }

  const SeparatedCases: [PushDirection, 'x' | 'y', number[]][] = [
    ['left', 'x', [-100, -100]], ['right', 'x', [80, 40]], ['top', 'y', [-50, -50]], ['bottom', 'y', [10, 30]],
  ]
  It.each(SeparatedCases)('moves non-intersecting images independently toward %s, preserving unselected images and input', (Direction, Axis, Expected) => {
    const Result = PushImages(SeparatedImages, new Set(['a', 'b']), Direction)
    Expect(Result.slice(0, 2).map((Image) => Image[Axis])).toEqual(Expected)
    Expect(Result[2]).toBe(SeparatedImages[2])
    ExpectOnlyAxisChanged(Result, SeparatedImages, Axis)
    Expect(SeparatedImages[0]).toEqual(ImageValue('a', -100, -50, 20, 40))
  })

  It.each(Modes)('pushes %s with zero gaps on one axis while preserving centres on the other axis, sizes, layer order and input', (Mode) => {
    const Images = FreezeImages(Orient([
      ImageValue('a', -100, -20, 20, 50), ImageValue('untouched', -1000, -1000, 500, 500),
      ImageValue('b', 0, -10, 40, 30), ImageValue('c', 80, -15, 30, 40),
    ], Mode))
    const Before = JSON.stringify(Images)
    const Result = PushImages(Images, ['c', 'b', 'a'], Mode)
    const Selected = Result.filter((Image) => Image.id !== 'untouched')
    const Axis = Mode === 'left' || Mode === 'right' ? 'x' : 'y'
    Expect(Selected.map((Image) => Image[Axis])).toEqual(Mode === 'left' || Mode === 'top' ? [-100, -80, -40] : [20, 40, 80])
    ExpectOnlyAxisChanged(Result, Images, Axis)
    Expect(Result[1]).toBe(Images[1])
    Expect(JSON.stringify(Images)).toBe(Before)
    ExpectNoOverlap(Selected)
  })

  It.each(Modes)('lets independent rows or columns reach the %s boundary, including perpendicular edges that only touch', (Mode) => {
    const Images = Orient([ImageValue('a', -100, 0, 20, 10), ImageValue('b', 50, 10, 40, 10), ImageValue('c', 100, 30, 30, 10)], Mode)
    const Result = PushImages(Images, Images.map((Image) => Image.id), Mode)
    const Axis = Mode === 'left' || Mode === 'right' ? 'x' : 'y'
    Expect(Result.map((Image) => Image[Axis])).toEqual(Mode === 'left' || Mode === 'top' ? [-100, -100, -100] : [110, 90, 100])
    ExpectNoOverlap(Result)
  })

  It.each(Modes)('stops a spanning image against every intersecting stair-step during %s push', (Mode) => {
    const Images = Orient([ImageValue('a', 0, 0, 30, 20), ImageValue('b', 80, 20, 50, 20), ImageValue('bridge', 200, 10, 20, 20)], Mode)
    const Result = PushImages(Images, Images.map((Image) => Image.id), Mode)
    const Axis = Mode === 'left' || Mode === 'right' ? 'x' : 'y'
    Expect(Result.map((Image) => Image[Axis])).toEqual(Mode === 'left' || Mode === 'top' ? [0, 0, 50] : [170, 150, 200])
    ExpectNoOverlap(Result)
  })

  const OverlapCases: [PushDirection, number[]][] = [
    ['left', [-10, 20, 60]], ['right', [-80, -50, -10]],
    ['top', [-10, 5, 30]], ['bottom', [-50, -35, -10]],
  ]
  It.each(OverlapCases)('resolves pre-existing overlaps along %s only, using facing edges and stable document-order ties', (Mode, Expected) => {
    const Images = [ImageValue('first', -10, -10, 30, 15), ImageValue('second', -10, -10, 40, 25), ImageValue('third', -10, -10, 50, 35)]
    const Result = PushImages(Images, ['third', 'second', 'first'], Mode)
    const Axis = Mode === 'left' || Mode === 'right' ? 'x' : 'y'
    const CrossAxis = Axis === 'x' ? 'y' : 'x'
    Expect(Result.map((Image) => Image[Axis])).toEqual(Expected)
    Expect(Result.map((Image) => Image[CrossAxis])).toEqual([-10, -10, -10])
    ExpectNoOverlap(Result)
  })

  It.each(Modes)('makes repeated %s push an exact no-op and leaves empty or single selections unchanged', (Mode) => {
    const Images = [ImageValue('a', -10.2, -4.3, 21.7, 10.1), ImageValue('b', 3.6, -4.3, 37.2, 9.8)]
    const Once = PushImages(Images, ['a', 'b'], Mode)
    ExpectUnchanged(PushImages(Once, ['a', 'b'], Mode), Once)
    for (const Ids of [[], ['missing'], ['a'], ['a', 'a', 'missing']]) {
      ExpectUnchanged(PushImages(Images, Ids, Mode), Images)
    }
    Expect(PushImages([], ['a'], Mode)).toEqual([])
  })
})
Describe('average-size normalization', () => {
  const Cases: [NormalizeMode, number, number[][]][] = [
    ['width', 60, [[60, 30], [60, 120], [60, 60]]],
    ['height', 80, [[160, 80], [40, 80], [80, 80]]],
  ]
  It.each(Cases)('normalizes %s while preserving individual centres, aspect ratios, inputs and unselected images', (Mode, Average, Sizes) => {
    const Images = FreezeImages([
      ImageValue('a', -100, -150, 40, 20), ImageValue('b', -25, 40, 80, 160),
      ImageValue('c', 150, -400, 60, 60), ImageValue('untouched', -1000, -1000, 500, 500),
    ])
    const Result = NormalizeImages(Images, new Set(['a', 'b', 'c']), Mode)
    Expect(Result.slice(0, 3).map((Image) => [Image.width, Image.height])).toEqual(Sizes)
    for (let Index = 0; Index < 3; Index++) {
      Expect(Result[Index][Mode]).toBe(Average)
      Expect(Result[Index].width / Result[Index].height).toBe(Images[Index].width / Images[Index].height)
      Expect(Result[Index].x + Result[Index].width / 2).toBe(Images[Index].x + Images[Index].width / 2)
      Expect(Result[Index].y + Result[Index].height / 2).toBe(Images[Index].y + Images[Index].height / 2)
      Expect(Result[Index].id).toBe(Images[Index].id)
      Expect(Result[Index].asset).toBe(Images[Index].asset)
    }
    Expect(Result[3]).toBe(Images[3])
    Expect(Images[0]).toEqual(ImageValue('a', -100, -150, 40, 20))
    Expect(Images[1]).toEqual(ImageValue('b', -25, 40, 80, 160))
  })

  It.each(['width', 'height'] as const)('makes repeated %s normalization an exact no-op, including fractional dimensions', (Mode) => {
    const Images = [ImageValue('a', -20.3, 4.1, 10.1, 21.3), ImageValue('b', 13.7, -6.9, 12.5, 10.2), ImageValue('c', 7, 8, 30.7, 43.2)]
    const Ids = ['a', 'b', 'c']
    const Once = NormalizeImages(Images, Ids, Mode)
    ExpectUnchanged(NormalizeImages(Once, Ids, Mode), Once)
  })

  It('does nothing for empty, missing, duplicate-only or single selections', () => {
    const Images = [ImageValue('a', -10, 0, 20, 30), ImageValue('b', 20, -10, 50, 80)]
    for (const Ids of [[], ['missing'], ['a'], ['a', 'a', 'missing']]) {
      for (const Mode of ['width', 'height'] as const) {
        ExpectUnchanged(NormalizeImages(Images, Ids, Mode), Images)
      }
    }
    Expect(NormalizeImages([], ['a', 'b'], 'width')).toEqual([])
  })

  It('preserves an already-average image and ignores invalid images when computing the average', () => {
    const Images = [ImageValue('a', 0, 0, 10, 20), ImageValue('b', 100, 100, 20, 30), ImageValue('c', 200, 200, 30, 40), ImageValue('invalid', 0, 0, Infinity, 10)]
    const Result = NormalizeImages(Images, Images.map((Image) => Image.id), 'width')
    Expect(Result.slice(0, 3).map((Image) => Image.width)).toEqual([20, 20, 20])
    Expect(Result[1]).toBe(Images[1])
    Expect(Result[3]).toBe(Images[3])
    ExpectUnchanged(NormalizeImages(Images, ['a', 'invalid'], 'width'), Images)
  })

  It('avoids overflowing the average and declines resizing when proportional dimensions cannot remain finite and positive', () => {
    const Large = [ImageValue('a', 0, 0, 1e308, 1e308), ImageValue('b', 0, 0, 1.6e308, 1.6e308)]
    const Result = NormalizeImages(Large, ['a', 'b'], 'width')
    Result.forEach((Image) => {
      Expect(Image.width).toBe(1.3e308)
      Expect([Image.x, Image.y, Image.width, Image.height].every(Number.isFinite)).toBe(true)
      Expect(Image.height).toBeGreaterThan(0)
    })
    const Extreme = [ImageValue('a', 0, 0, Number.MIN_VALUE, 10), ImageValue('b', 0, 0, 100, 100)]
    ExpectUnchanged(NormalizeImages(Extreme, ['a', 'b'], 'width'), Extreme)
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
  const Original = FreezeImages([ImageValue('a', 0, 0, 100, 50), ImageValue('b', 120, 50, 80, 50)])
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

Describe('text frames', () => {
  const Original: BoardText = { id: 'text', x: 10, y: 20, width: 100, height: 60, text: EmptyTextResource('文字') }
  It('changes frame proportions without changing text style and keeps the opposite corner fixed', () => {
    const Result = ResizeTextFrame(Original, 'nw', { x: -40, y: 10 })
    Expect(Result).toMatchObject({ x: -40, y: 10, width: 150, height: 70 })
    Expect(Result.text).toBe(Original.text)
    const Crossed = ResizeTextFrame(Original, 'se', { x: -100, y: -100 })
    Expect(Crossed).toMatchObject({ x: 10, y: 20, width: 24, height: 24 })
  })
  It('retains font style while resizing and arranging a mixed image/text selection', () => {
    const Items: (BoardImage | BoardText)[] = [ImageValue('image', -110, 20, 100, 60), Original]
    const Resized = ResizeGroup(Items, 'se', { x: 330, y: 140 })
    Expect(Resized[1].width).toBe(200)
    Expect('text' in Resized[1] && Resized[1].text).toBe(Original.text)
    const Pushed = PushImages(Items, ['image', 'text'], 'left')
    Expect(Pushed[1].x).toBe(-10)
    Expect('text' in Pushed[1] && Pushed[1].text).toBe(Original.text)
  })
})
