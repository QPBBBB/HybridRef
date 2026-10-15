import type { ArrowBinding, ArrowPoint, ArrowStyle, BoardArrow, BoardItem } from './Types'

export const DefaultArrowStyle: ArrowStyle = { color: '#FFFFFF', thickness: 2, dashed: false }

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
  const Horizontal = Item.arrow.axis === 'horizontal'
  const Left = Math.min(Start.x, End.x, Horizontal ? Bend : Start.x) - Padding
  const Top = Math.min(Start.y, End.y, Horizontal ? Start.y : Bend) - Padding
  const Width = Math.max(Start.x, End.x, Horizontal ? Bend : Start.x) + Padding - Left
  const Height = Math.max(Start.y, End.y, Horizontal ? Start.y : Bend) + Padding - Top
  return { ...Item, x: Left, y: Top, width: Width, height: Height, arrow: { ...Item.arrow,
    start: { x: (Start.x - Left) / Width, y: (Start.y - Top) / Height },
    end: { x: (End.x - Left) / Width, y: (End.y - Top) / Height },
    bend: Horizontal ? (Bend - Left) / Width : (Bend - Top) / Height,
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

export function SnapArrowEndpoint(Point: ArrowPoint, Items: readonly BoardItem[], Threshold: number): { point: ArrowPoint; binding?: ArrowBinding } {
  let Nearest: { point: ArrowPoint; binding?: ArrowBinding } = { point: Point }
  let Distance = Threshold
  for (const Item of [...Items].reverse()) {
    if ('arrow' in Item) continue
    const X = Math.max(0, Math.min(1, (Point.x - Item.x) / Item.width))
    const Y = Math.max(0, Math.min(1, (Point.y - Item.y) / Item.height))
    const Inside = Point.x >= Item.x && Point.x <= Item.x + Item.width && Point.y >= Item.y && Point.y <= Item.y + Item.height
    const Candidates = (['left', 'right', 'top', 'bottom'] as const).map((Side) => {
      const Binding = { id: Item.id, side: Side, offset: Side === 'left' || Side === 'right' ? Y : X }
      const Position = BindingPoint(Binding, [Item])!
      return { point: Position, binding: Binding, distance: Math.hypot(Point.x - Position.x, Point.y - Position.y) }
    }).sort((A, B) => A.distance - B.distance)
    if (Inside) return Candidates[0]
    if (Candidates[0].distance < Distance) { Nearest = Candidates[0]; Distance = Candidates[0].distance }
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
    if (Math.hypot(Start.x - Previous.start.x, Start.y - Previous.start.y, End.x - Previous.end.x, End.y - Previous.end.y) < 1e-8) return Item
    const Axis = Item.arrow.axis === 'horizontal' ? 'x' : 'y'
    const Bend = Previous.bend + (Start[Axis] - Previous.start[Axis] + End[Axis] - Previous.end[Axis]) / 2
    return PositionArrow(Item, Start, End, Bend)
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

export function ArrowDrawing(Item: BoardArrow): { path: string; head: string; points: ArrowPoint[]; handle: ArrowPoint } {
  const Start = { x: Item.arrow.start.x * Item.width, y: Item.arrow.start.y * Item.height }
  const End = { x: Item.arrow.end.x * Item.width, y: Item.arrow.end.y * Item.height }
  const Horizontal = Item.arrow.axis === 'horizontal'
  const Bend = Item.arrow.bend * (Horizontal ? Item.width : Item.height)
  const Points = Horizontal ? [Start, { x: Bend, y: Start.y }, { x: Bend, y: End.y }, End]
    : [Start, { x: Start.x, y: Bend }, { x: End.x, y: Bend }, End]
  const Previous = [...Points.slice(0, -1)].reverse().find((Point) => Math.hypot(Point.x - End.x, Point.y - End.y) > 1e-8)
  const Length = Previous ? Math.hypot(End.x - Previous.x, End.y - Previous.y) : 1
  const Dx = Previous ? (End.x - Previous.x) / Length : 1, Dy = Previous ? (End.y - Previous.y) / Length : 0
  const Head = Math.min(Math.max(8, Item.arrow.thickness * 3), Length)
  const Spread = Math.min(Math.max(4, Item.arrow.thickness * 1.6), Length / 2)
  const Base = { x: End.x - Dx * Head, y: End.y - Dy * Head }
  return { path: Points.map((Point, Index) => `${Index ? 'L' : 'M'} ${Point.x} ${Point.y}`).join(' '),
    head: `${End.x},${End.y} ${Base.x - Dy * Spread},${Base.y + Dx * Spread} ${Base.x + Dy * Spread},${Base.y - Dx * Spread}`,
    points: Points, handle: Horizontal ? { x: Bend, y: (Start.y + End.y) / 2 } : { x: (Start.x + End.x) / 2, y: Bend },
  }
}

export function ArrowDash(Style: ArrowStyle): string | undefined { return Style.dashed ? `${Style.thickness * 4} ${Style.thickness * 3}` : undefined }
