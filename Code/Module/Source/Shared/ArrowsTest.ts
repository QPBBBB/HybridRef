import { describe as Describe, expect as Expect, it as It } from 'vitest'
import { ArrowDrawing, ArrowEndpoints, BindingPoint, ConnectionHandles, CreateArrow, DetachTransformedArrows, PositionArrow, ResolveArrowBindings, SnapArrowEndpoint } from './Arrows'
import { EmptyTextResource, type BoardArrow, type BoardImage, type BoardText } from './Types'

const Image: BoardImage = { id: 'picture', asset: 'image', x: 10, y: 20, width: 200, height: 100 }
const Text: BoardText = { id: 'note', x: 500, y: 300, width: 200, height: 120, text: EmptyTextResource() }

Describe('orthogonal arrows', () => {
  It.each(['horizontal', 'vertical'] as const)('draws a %s route and protects the arrowhead inside its frame', (Axis) => {
    for (const End of [{ x: 300, y: 180 }, { x: -100, y: -40 }, { x: 300, y: 0 }, { x: 0, y: 180 }]) {
      const Arrow = CreateArrow('arrow', { x: 0, y: 0 }, End, Axis)
      const Drawing = ArrowDrawing(Arrow)
      Expect(ArrowEndpoints(Arrow).start.x).toBeCloseTo(0)
      Expect(ArrowEndpoints(Arrow).end.y).toBeCloseTo(End.y)
      for (let Index = 1; Index < Drawing.points.length; Index++) {
        const Previous = Drawing.points[Index - 1], Current = Drawing.points[Index]
        Expect(Current.x === Previous.x || Current.y === Previous.y).toBe(true)
      }
      for (const Point of Drawing.head.split(' ').map((Point) => Point.split(',').map(Number))) {
        Expect(Point[0]).toBeGreaterThanOrEqual(0); Expect(Point[0]).toBeLessThanOrEqual(Arrow.width)
        Expect(Point[1]).toBeGreaterThanOrEqual(0); Expect(Point[1]).toBeLessThanOrEqual(Arrow.height)
      }
    }
  })
  It('allows dragging the middle leg beyond either endpoint without moving the endpoints', () => {
    const Arrow = CreateArrow('arrow', { x: 0, y: 0 }, { x: 300, y: 180 })
    const Next = PositionArrow(Arrow, { x: 0, y: 0 }, { x: 300, y: 180 }, -90)
    const Points = ArrowEndpoints(Next)
    Expect(Points.start.x).toBeCloseTo(0); Expect(Points.start.y).toBeCloseTo(0)
    Expect(Points.end.x).toBeCloseTo(300); Expect(Points.end.y).toBeCloseTo(180); Expect(Points.bend).toBe(-90)
    Expect(Next.x).toBeLessThan(-90)
  })
  It.each([1, 2, 12, 24])('ends the visible shaft at the head base while retaining the true tip at width %s', (Thickness) => {
    for (const End of [{ x: 300, y: 0 }, { x: -300, y: 0 }, { x: 0, y: 300 }, { x: 0, y: -300 }, { x: 5, y: 0 }]) {
      const Initial = CreateArrow('arrow', { x: 0, y: 0 }, End, End.x ? 'horizontal' : 'vertical')
      const Arrow = PositionArrow({ ...Initial, arrow: { ...Initial.arrow, thickness: Thickness } }, { x: 0, y: 0 }, End, ArrowEndpoints(Initial).bend)
      const Drawing = ArrowDrawing(Arrow)
      const [Tip, First, Second] = Drawing.head.split(' ').map((Point) => Point.split(',').map(Number))
      const ShaftEnd = Drawing.shaft.split(' ').slice(-2).map(Number)
      Expect(ShaftEnd[0]).toBeCloseTo((First[0] + Second[0]) / 2)
      Expect(ShaftEnd[1]).toBeCloseTo((First[1] + Second[1]) / 2)
      Expect(Drawing.points.at(-1)).toEqual({ x: Tip[0], y: Tip[1] })
      Expect(Math.hypot(Tip[0] - ShaftEnd[0], Tip[1] - ShaftEnd[1])).toBeGreaterThan(0)
    }
  })
  It('snaps to edge centers, uses the visible top object, and leaves other points free', () => {
    Expect(SnapArrowEndpoint({ x: 215, y: 60 }, [Image], 14)).toMatchObject({ point: { x: 210, y: 70 }, binding: { id: 'picture', side: 'right', offset: 0.5 } })
    Expect(SnapArrowEndpoint({ x: 400, y: 60 }, [Image], 14)).toEqual({ point: { x: 400, y: 60 } })
    Expect(SnapArrowEndpoint({ x: 200, y: 70 }, [Image, { ...Text, x: 10, y: 20, width: 200, height: 100 }], 14).binding?.id).toBe('note')
    for (const Point of [{ x: 110, y: 70 }, { x: 210, y: 30 }]) Expect(SnapArrowEndpoint(Point, [Image], 14)).toEqual({ point: Point })
  })
  It.each([0.25, 1, 3])('snaps all four outside handles with a fixed screen tolerance at zoom %s', (Zoom) => {
    const Handles = ConnectionHandles(Image, 20 / Zoom)
    Expect(Handles).toHaveLength(4)
    for (const Handle of Handles) {
      const Pointer = { x: Handle.handle.x + 3 / Zoom, y: Handle.handle.y + 4 / Zoom }
      Expect(SnapArrowEndpoint(Pointer, [Image], 14 / Zoom, 20 / Zoom)).toEqual({ point: Handle.point, binding: Handle.binding })
      Expect(SnapArrowEndpoint(Pointer, [Image], 14 / Zoom, 20 / Zoom, Image.id)).toEqual({ point: Pointer })
      Expect(Math.hypot(Handle.handle.x - Handle.point.x, Handle.handle.y - Handle.point.y) * Zoom).toBeCloseTo(20)
    }
  })
  It('leaves and enters every pair of handle directions perpendicularly, with the route inside its frame', () => {
    for (const Source of ConnectionHandles(Image)) for (const Target of ConnectionHandles(Text)) {
      const Initial = CreateArrow('arrow', Source.point, Target.point, ['top', 'bottom'].includes(Source.binding.side) ? 'vertical' : 'horizontal')
      const Arrow = PositionArrow({ ...Initial, arrow: { ...Initial.arrow, startBinding: Source.binding, endBinding: Target.binding } }, Source.point, Target.point, ArrowEndpoints(Initial).bend)
      const Drawing = ArrowDrawing(Arrow), Points = Drawing.points
      const First = { x: Points[1].x - Points[0].x, y: Points[1].y - Points[0].y }
      const Last = { x: Points.at(-2)!.x - Points.at(-1)!.x, y: Points.at(-2)!.y - Points.at(-1)!.y }
      for (const [Side, Delta] of [[Source.binding.side, First], [Target.binding.side, Last]] as const) {
        const Horizontal = Side === 'left' || Side === 'right'
        Expect(Delta[Horizontal ? 'y' : 'x']).toBeCloseTo(0)
        Expect(Delta[Horizontal ? 'x' : 'y'] * (Side === 'left' || Side === 'top' ? -1 : 1)).toBeGreaterThan(0)
      }
      for (let Index = 0; Index < Points.length; Index++) {
        const Point = Points[Index]
        Expect(Point.x).toBeGreaterThanOrEqual(0); Expect(Point.x).toBeLessThanOrEqual(Arrow.width)
        Expect(Point.y).toBeGreaterThanOrEqual(0); Expect(Point.y).toBeLessThanOrEqual(Arrow.height)
        if (Index) Expect(Point.x === Points[Index - 1].x || Point.y === Points[Index - 1].y).toBe(true)
      }
    }
  })
  It.each(['left', 'right', 'top', 'bottom'] as const)('prefers one turn from the %s port with either endpoint free', (Side) => {
    const Source = ConnectionHandles(Image).find((Handle) => Handle.binding.side === Side)!
    const Horizontal = Side === 'left' || Side === 'right', Sign = Side === 'left' || Side === 'top' ? -1 : 1
    for (const Distance of [12, 180]) for (const Offset of [-80, 0, 80]) for (const Reversed of [false, true]) {
      const Free = { x: Source.point.x + (Horizontal ? Sign * Distance : Offset), y: Source.point.y + (Horizontal ? Offset : Sign * Distance) }
      const Corner = Horizontal ? { x: Free.x, y: Source.point.y } : { x: Source.point.x, y: Free.y }
      const Start = Reversed ? Free : Source.point, End = Reversed ? Source.point : Free
      const Initial = CreateArrow('arrow', Start, End)
      const Arrow = PositionArrow({ ...Initial, arrow: { ...Initial.arrow,
        ...(Reversed ? { endBinding: Source.binding } : { startBinding: Source.binding }),
      } }, Start, End, ArrowEndpoints(Initial).bend)
      const Drawing = ArrowDrawing(Arrow)
      const Expected = Offset ? [Source.point, Corner, Free] : [Source.point, Free]
      if (Reversed) Expected.reverse()
      Expect(Drawing.points).toHaveLength(Expected.length)
      Drawing.points.forEach((Point, Index) => {
        Expect(Point.x + Arrow.x).toBeCloseTo(Expected[Index].x)
        Expect(Point.y + Arrow.y).toBeCloseTo(Expected[Index].y)
        Expect(Point.x).toBeGreaterThanOrEqual(0); Expect(Point.x).toBeLessThanOrEqual(Arrow.width)
        Expect(Point.y).toBeGreaterThanOrEqual(0); Expect(Point.y).toBeLessThanOrEqual(Arrow.height)
      })
      Expect(Number.isFinite(Drawing.handle.x) && Number.isFinite(Drawing.handle.y)).toBe(true)
      Expect(ResolveArrowBindings([Image, Arrow])[1]).toBe(Arrow)
    }
  })
  It.each(['left', 'right', 'top', 'bottom'] as const)('keeps detours and manual bends from the %s port', (Side) => {
    const Source = ConnectionHandles(Image).find((Handle) => Handle.binding.side === Side)!
    const Horizontal = Side === 'left' || Side === 'right', Sign = Side === 'left' || Side === 'top' ? -1 : 1
    for (const Manual of [false, true]) {
      const Distance = Manual ? 180 : -180
      const End = { x: Source.point.x + (Horizontal ? Sign * Distance : 80), y: Source.point.y + (Horizontal ? 80 : Sign * Distance) }
      const Initial = CreateArrow('arrow', Source.point, End, Horizontal ? 'horizontal' : 'vertical')
      const Arrow = PositionArrow({ ...Initial, arrow: { ...Initial.arrow, startBinding: Source.binding, manualBend: Manual } }, Source.point, End, ArrowEndpoints(Initial).bend)
      const Points = ArrowDrawing(Arrow).points
      Expect(Points.length).toBeGreaterThan(3)
      Expect((Points[1][Horizontal ? 'x' : 'y'] - Points[0][Horizontal ? 'x' : 'y']) * Sign).toBeGreaterThan(0)
      Expect(Points[1][Horizontal ? 'y' : 'x']).toBeCloseTo(Points[0][Horizontal ? 'y' : 'x'])
      if (Manual) Expect(ArrowEndpoints(Arrow).bend).toBeCloseTo(ArrowEndpoints(Initial).bend)
    }
  })
  It('keeps fixed-width arrow strokes inside their frames after a small group resize', () => {
    const Arrow = CreateArrow('arrow', { x: 0, y: 0 }, { x: 300, y: 0 })
    const Small = { ...Arrow, width: Arrow.width / 100, height: Arrow.height / 100 }
    const Next = DetachTransformedArrows([Small], ['arrow'])[0] as BoardArrow
    Expect(Next.height).toBeGreaterThanOrEqual(16)
    Expect(ArrowEndpoints(Next).start.x).toBeCloseTo(ArrowEndpoints(Small).start.x)
    Expect(ArrowEndpoints(Next).end.x).toBeCloseTo(ArrowEndpoints(Small).end.x)
  })
  It('reframes older bound routes even without endpoint movement and stays stable afterward', () => {
    const Source = ConnectionHandles(Image).find((Handle) => Handle.binding.side === 'right')!
    const Target = ConnectionHandles(Text).find((Handle) => Handle.binding.side === 'bottom')!
    Source.binding.offset = 0.4
    const Old = CreateArrow('arrow', BindingPoint(Source.binding, [Image])!, Target.point)
    Old.arrow.startBinding = Source.binding
    Old.arrow.endBinding = Target.binding
    const Resolved = ResolveArrowBindings([Image, Text, Old])
    const Arrow = Resolved[2] as BoardArrow
    Expect(Arrow.arrow.startBinding?.offset).toBe(0.4)
    Expect(Arrow.y + Arrow.height).toBeGreaterThan(Target.point.y + 24)
    const Again = ResolveArrowBindings(Resolved)[2]
    Expect(Again).toBe(Arrow)
    for (const Point of ArrowDrawing(Arrow).points) {
      Expect(Point.x).toBeGreaterThanOrEqual(0); Expect(Point.x).toBeLessThanOrEqual(Arrow.width)
      Expect(Point.y).toBeGreaterThanOrEqual(0); Expect(Point.y).toBeLessThanOrEqual(Arrow.height)
    }
  })
  It('follows resized and moved targets, retains missing bindings and remains stable on repeated updates', () => {
    const Arrow = CreateArrow('arrow', { x: 210, y: 70 }, { x: 500, y: 360 })
    Arrow.arrow.startBinding = { id: 'picture', side: 'right', offset: 0.5 }
    Arrow.arrow.endBinding = { id: 'note', side: 'left', offset: 0.5 }
    const MovedImage = { ...Image, x: 40, width: 240 }
    const Items = ResolveArrowBindings([MovedImage, Text, Arrow])
    const Next = Items[2] as BoardArrow
    Expect(ArrowEndpoints(Next).start).toEqual({ x: 280, y: 70 })
    Expect(ArrowEndpoints(Next).end).toEqual(BindingPoint(Arrow.arrow.endBinding, [Text]))
    Expect(ResolveArrowBindings(Items)[2]).toBe(Next)
    Expect((ResolveArrowBindings([Next])[0] as BoardArrow).arrow.startBinding).toEqual(Arrow.arrow.startBinding)
    Expect((DetachTransformedArrows(Items, ['arrow'])[2] as BoardArrow).arrow.startBinding).toBeUndefined()
    Expect((DetachTransformedArrows(Items, ['arrow', 'picture'])[2] as BoardArrow).arrow.startBinding).toEqual(Arrow.arrow.startBinding)
  })
})
