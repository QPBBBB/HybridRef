import type { ArrowBinding, ArrowPoint, ArrowResource, ArrowStyle, BoardArrow, BoardImage, BoardItem, BoardText } from './Types'

export const DefaultArrowStyle: ArrowStyle = { color: '#FFFFFF', thickness: 2, dashed: false }

function PortDirection(Binding?: ArrowBinding): ArrowPoint {
  return { x: Binding?.side === 'left' ? -1 : Binding?.side === 'right' ? 1 : 0,
    y: Binding?.side === 'top' ? -1 : Binding?.side === 'bottom' ? 1 : 0 }
}

/** Leave and enter bound handles perpendicular to their edges, including unlike sides. */
function ArrowRoute(Arrow: ArrowResource, Start: ArrowPoint, End: ArrowPoint, Bend: number): { points: ArrowPoint[]; handle: ArrowPoint; axis: ArrowResource['axis']; bend: number } {
  const Clearance = Math.max(24, Arrow.thickness * 4)
  const StartDirection = PortDirection(Arrow.startBinding), EndDirection = PortDirection(Arrow.endBinding)
  const StartLead = { x: Start.x + StartDirection.x * Clearance, y: Start.y + StartDirection.y * Clearance }
  const EndLead = { x: End.x + EndDirection.x * Clearance, y: End.y + EndDirection.y * Clearance }
  let Axis: 'x' | 'y' = Arrow.axis === 'horizontal' ? 'x' : 'y'
  function Limits(Coordinate: 'x' | 'y'): { min: number; max: number } {
    return { min: Math.max(StartDirection[Coordinate] > 0 ? StartLead[Coordinate] : -Infinity, EndDirection[Coordinate] > 0 ? EndLead[Coordinate] : -Infinity),
      max: Math.min(StartDirection[Coordinate] < 0 ? StartLead[Coordinate] : Infinity, EndDirection[Coordinate] < 0 ? EndLead[Coordinate] : Infinity) }
  }
  let Range = Limits(Axis)
  if (Range.min > Range.max) {
    Axis = Axis === 'x' ? 'y' : 'x'
    Range = Limits(Axis)
    Bend = (StartLead[Axis] + EndLead[Axis]) / 2
  }
  Bend = Math.max(Range.min, Math.min(Range.max, Bend))
  // When both handles face away, leave room for a real detour rather than
  // doubling back over the departure stroke at equal endpoint coordinates.
  if (Arrow.startBinding && Arrow.endBinding && !StartDirection[Axis] && !EndDirection[Axis]) {
    const Low = Math.min(StartLead[Axis], EndLead[Axis]), High = Math.max(StartLead[Axis], EndLead[Axis])
    if (High - Low < Clearance * 2 && Bend > Low - Clearance && Bend < High + Clearance) Bend = Bend <= (Low + High) / 2 ? Low - Clearance : High + Clearance
  }
  const Horizontal = Axis === 'x'
  const Middle = Horizontal ? [{ x: Bend, y: StartLead.y }, { x: Bend, y: EndLead.y }]
    : [{ x: StartLead.x, y: Bend }, { x: EndLead.x, y: Bend }]
  const Points = [Start, StartLead, ...Middle, EndLead, End].filter((Point, Index, All) => Index === 0 || Math.hypot(Point.x - All[Index - 1].x, Point.y - All[Index - 1].y) > 1e-8)
  return { points: Points, handle: Horizontal ? { x: Bend, y: (StartLead.y + EndLead.y) / 2 } : { x: (StartLead.x + EndLead.x) / 2, y: Bend }, axis: Horizontal ? 'horizontal' : 'vertical', bend: Bend }
}

export function ArrowEndpoints(Item: BoardArrow): { start: ArrowPoint; end: ArrowPoint; bend: number } {
  return {
    start: { x: Item.x + Item.arrow.start.x * Item.width, y: Item.y + Item.arrow.start.y * Item.height },
    end: { x: Item.x + Item.arrow.end.x * Item.width, y: Item.y + Item.arrow.end.y * Item.height },
    bend: Item.arrow.axis === 'horizontal' ? Item.x + Item.arrow.bend * Item.width : Item.y + Item.arrow.bend * Item.height,
  }
}

/** Keep a real positive frame around the stroke, including horizontal/vertical arrows. */
export function PositionArrow(Item: BoardArrow, Start: ArrowPoint, End: ArrowPoint, Bend: number): BoardArrow {
  const Padding = Math.max(8, Item.arrow.thickness * 3)
  const Route = ArrowRoute(Item.arrow, Start, End, Bend)
  const Horizontal = Route.axis === 'horizontal'
  const Left = Math.min(...Route.points.map((Point) => Point.x)) - Padding
  const Top = Math.min(...Route.points.map((Point) => Point.y)) - Padding
  const Width = Math.max(...Route.points.map((Point) => Point.x)) + Padding - Left
  const Height = Math.max(...Route.points.map((Point) => Point.y)) + Padding - Top
  return { ...Item, x: Left, y: Top, width: Width, height: Height, arrow: { ...Item.arrow,
    start: { x: (Start.x - Left) / Width, y: (Start.y - Top) / Height },
    end: { x: (End.x - Left) / Width, y: (End.y - Top) / Height },
    axis: Route.axis, bend: Horizontal ? (Route.bend - Left) / Width : (Route.bend - Top) / Height,
  } }
}

export function CreateArrow(Id: string, Start: ArrowPoint, End: ArrowPoint, Axis: 'horizontal' | 'vertical' = 'horizontal'): BoardArrow {
  return PositionArrow({ id: Id, x: 0, y: 0, width: 1, height: 1, arrow: {
    ...DefaultArrowStyle, start: Start, end: End, bend: 0.5, axis: Axis,
  } }, Start, End, Axis === 'horizontal' ? (Start.x + End.x) / 2 : (Start.y + End.y) / 2)
}

export function BindingPoint(Binding: ArrowBinding, Items: readonly BoardItem[]): ArrowPoint | undefined {
  const Target = Items.find((Item) => Item.id === Binding.id && !('arrow' in Item))
  if (!Target) return undefined
  const { side: Side, offset: Offset } = Binding
  return { x: Target.x + Target.width * (Side === 'left' ? 0 : Side === 'right' ? 1 : Offset),
    y: Target.y + Target.height * (Side === 'top' ? 0 : Side === 'bottom' ? 1 : Offset) }
}

/** Visual handles sit outside the frame; the saved connector meets its edge. */
export function ConnectionHandles(Item: BoardImage | BoardText, Offset = 0): { point: ArrowPoint; handle: ArrowPoint; binding: ArrowBinding }[] {
  return (['left', 'right', 'top', 'bottom'] as const).map((Side) => {
    const Binding: ArrowBinding = { id: Item.id, side: Side, offset: 0.5 }
    const Point = BindingPoint(Binding, [Item])!
    return { point: Point, binding: Binding, handle: {
      x: Point.x + (Side === 'left' ? -Offset : Side === 'right' ? Offset : 0),
      y: Point.y + (Side === 'top' ? -Offset : Side === 'bottom' ? Offset : 0),
    } }
  })
}

export function SnapArrowEndpoint(Point: ArrowPoint, Items: readonly BoardItem[], Threshold: number, HandleOffset = 0, ExcludedId?: string): { point: ArrowPoint; binding?: ArrowBinding } {
  let Nearest: { point: ArrowPoint; binding?: ArrowBinding } = { point: Point }
  let Distance = Threshold
  for (const Item of [...Items].reverse()) {
    if ('arrow' in Item || Item.id === ExcludedId) continue
    for (const Candidate of ConnectionHandles(Item, HandleOffset)) {
      const CandidateDistance = Math.min(Math.hypot(Point.x - Candidate.point.x, Point.y - Candidate.point.y), Math.hypot(Point.x - Candidate.handle.x, Point.y - Candidate.handle.y))
      if (CandidateDistance < Distance) { Nearest = { point: Candidate.point, binding: Candidate.binding }; Distance = CandidateDistance }
    }
  }
  return Nearest
}

/** Bindings follow their objects, while absent targets retain their last endpoint. */
export function ResolveArrowBindings(Items: readonly BoardItem[]): BoardItem[] {
  return Items.map((Item) => {
    if (!('arrow' in Item)) return Item
    const Previous = ArrowEndpoints(Item)
    const Start = (Item.arrow.startBinding && BindingPoint(Item.arrow.startBinding, Items)) || Previous.start
    const End = (Item.arrow.endBinding && BindingPoint(Item.arrow.endBinding, Items)) || Previous.end
    const Axis = Item.arrow.axis === 'horizontal' ? 'x' : 'y'
    const Bend = Previous.bend + (Start[Axis] - Previous.start[Axis] + End[Axis] - Previous.end[Axis]) / 2
    const Next = PositionArrow(Item, Start, End, Bend)
    const Unchanged = Math.hypot(Start.x - Previous.start.x, Start.y - Previous.start.y, End.x - Previous.end.x, End.y - Previous.end.y) < 1e-8
      && (['x', 'y', 'width', 'height'] as const).every((Key) => Math.abs(Next[Key] - Item[Key]) < 1e-8)
      && Next.arrow.axis === Item.arrow.axis && Math.abs(Next.arrow.bend - Item.arrow.bend) < 1e-8
    return Unchanged ? Item : Next
  })
}

/** A manually transformed connector detaches from targets outside that same selection. */
export function DetachTransformedArrows(Items: readonly BoardItem[], Selected: readonly string[]): BoardItem[] {
  return Items.map((Item) => {
    if (!('arrow' in Item) || !Selected.includes(Item.id)) return Item
    const Points = ArrowEndpoints(Item)
    // Group scaling changes the route but not the chosen line width. Rebuild its
    // padding so a small resized arrow is still fully included in PNG snapshots.
    return PositionArrow({ ...Item, arrow: { ...Item.arrow,
      startBinding: Item.arrow.startBinding && Selected.includes(Item.arrow.startBinding.id) ? Item.arrow.startBinding : undefined,
      endBinding: Item.arrow.endBinding && Selected.includes(Item.arrow.endBinding.id) ? Item.arrow.endBinding : undefined,
    } }, Points.start, Points.end, Points.bend)
  })
}

export function ArrowDrawing(Item: BoardArrow): { path: string; shaft: string; head: string; points: ArrowPoint[]; handle: ArrowPoint } {
  const Start = { x: Item.arrow.start.x * Item.width, y: Item.arrow.start.y * Item.height }
  const End = { x: Item.arrow.end.x * Item.width, y: Item.arrow.end.y * Item.height }
  const Horizontal = Item.arrow.axis === 'horizontal'
  const Bend = Item.arrow.bend * (Horizontal ? Item.width : Item.height)
  const Route = ArrowRoute(Item.arrow, Start, End, Bend)
  const Points = Route.points
  const Previous = [...Points.slice(0, -1)].reverse().find((Point) => Math.hypot(Point.x - End.x, Point.y - End.y) > 1e-8)
  const Length = Previous ? Math.hypot(End.x - Previous.x, End.y - Previous.y) : 1
  const Dx = Previous ? (End.x - Previous.x) / Length : 1, Dy = Previous ? (End.y - Previous.y) / Length : 0
  const Head = Math.min(Math.max(8, Item.arrow.thickness * 3), Length)
  const Spread = Math.min(Math.max(4, Item.arrow.thickness * 1.6), Length / 2)
  const Base = { x: End.x - Dx * Head, y: End.y - Dy * Head }
  // Keep the full route for endpoint controls/hit testing. The visible stroke
  // stops at the triangle base, so its width cannot poke through the tip.
  const Shaft = [...Points.slice(0, -1), Base].filter((Point, Index, All) => Index === 0 || Math.hypot(Point.x - All[Index - 1].x, Point.y - All[Index - 1].y) > 1e-8)
  return { path: Points.map((Point, Index) => `${Index ? 'L' : 'M'} ${Point.x} ${Point.y}`).join(' '),
    shaft: Shaft.map((Point, Index) => `${Index ? 'L' : 'M'} ${Point.x} ${Point.y}`).join(' '),
    head: `${End.x},${End.y} ${Base.x - Dy * Spread},${Base.y + Dx * Spread} ${Base.x + Dy * Spread},${Base.y - Dx * Spread}`,
    points: Points, handle: Route.handle,
  }
}

export function ArrowDash(Style: ArrowStyle): string | undefined { return Style.dashed ? `${Style.thickness * 4} ${Style.thickness * 3}` : undefined }
