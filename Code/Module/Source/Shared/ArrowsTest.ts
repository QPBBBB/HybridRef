import { describe as Describe, expect as Expect, it as It } from 'vitest'
import { ArrowDrawing, ArrowEndpoints, BindingPoint, CreateArrow, DetachTransformedArrows, PositionArrow, ResolveArrowBindings, SnapArrowEndpoint } from './Arrows'
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
  It('snaps to object edges, uses the visible top object, and leaves distant endpoints free', () => {
    Expect(SnapArrowEndpoint({ x: 215, y: 60 }, [Image], 14)).toMatchObject({ point: { x: 210, y: 60 }, binding: { id: 'picture', side: 'right', offset: 0.4 } })
    Expect(SnapArrowEndpoint({ x: 400, y: 60 }, [Image], 14)).toEqual({ point: { x: 400, y: 60 } })
    Expect(SnapArrowEndpoint({ x: 200, y: 60 }, [Image, { ...Text, x: 10, y: 20, width: 200, height: 100 }], 14).binding?.id).toBe('note')
  })
  It('keeps fixed-width arrow strokes inside their frames after a small group resize', () => {
    const Arrow = CreateArrow('arrow', { x: 0, y: 0 }, { x: 300, y: 0 })
    const Small = { ...Arrow, width: Arrow.width / 100, height: Arrow.height / 100 }
    const Next = DetachTransformedArrows([Small], ['arrow'])[0] as BoardArrow
    Expect(Next.height).toBeGreaterThanOrEqual(16)
    Expect(ArrowEndpoints(Next).start.x).toBeCloseTo(ArrowEndpoints(Small).start.x)
    Expect(ArrowEndpoints(Next).end.x).toBeCloseTo(ArrowEndpoints(Small).end.x)
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
