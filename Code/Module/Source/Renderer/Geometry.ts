import type { BoardImage, Viewport } from '../Shared/Types'

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Rect extends Point, Size {}
export type PushDirection = 'left' | 'right' | 'top' | 'bottom'
export type CenterMode = 'horizontal' | 'vertical'
export type NormalizeMode = 'width' | 'height'
export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'
export interface SnapGuide { axis: 'x' | 'y'; position: number }
export interface SnapResult { dx: number; dy: number; guides: SnapGuide[] }

export const MinZoom = 0.02
export const MaxZoom = 16

export function ClampZoom(Zoom: number): number {
  return Number.isNaN(Zoom) ? 1 : Math.max(MinZoom, Math.min(MaxZoom, Zoom))
}

export function WorldToScreen(Point: Point, Viewport: Viewport): Point {
  return { x: Point.x * Viewport.zoom + Viewport.x, y: Point.y * Viewport.zoom + Viewport.y }
}

export function ScreenToWorld(Point: Point, Viewport: Viewport): Point {
  return { x: (Point.x - Viewport.x) / Viewport.zoom, y: (Point.y - Viewport.y) / Viewport.zoom }
}

/** The world point below the cursor stays fixed, including at either zoom limit. */
export function ZoomAt(Viewport: Viewport, ScreenPoint: Point, NextZoom: number): Viewport {
  const WorldPoint = ScreenToWorld(ScreenPoint, Viewport)
  const Zoom = ClampZoom(NextZoom)
  return { x: ScreenPoint.x - WorldPoint.x * Zoom, y: ScreenPoint.y - WorldPoint.y * Zoom, zoom: Zoom }
}

export function RectFromPoints(A: Point, B: Point): Rect {
  return { x: Math.min(A.x, B.x), y: Math.min(A.y, B.y), width: Math.abs(B.x - A.x), height: Math.abs(B.y - A.y) }
}

export function BoundingBox(Rectangles: readonly Rect[]): Rect | null {
  if (!Rectangles.length) return null
  let Left = Infinity, Top = Infinity, Right = -Infinity, Bottom = -Infinity
  for (const Rect of Rectangles) {
    Left = Math.min(Left, Rect.x, Rect.x + Rect.width)
    Top = Math.min(Top, Rect.y, Rect.y + Rect.height)
    Right = Math.max(Right, Rect.x, Rect.x + Rect.width)
    Bottom = Math.max(Bottom, Rect.y, Rect.y + Rect.height)
  }
  return { x: Left, y: Top, width: Right - Left, height: Bottom - Top }
}

/** Touching a selection-rectangle edge counts as a hit. */
export function Intersects(A: Rect, B: Rect): boolean {
  return A.x <= B.x + B.width && A.x + A.width >= B.x
    && A.y <= B.y + B.height && A.y + A.height >= B.y
}

/** Close gaps on one axis while preserving the other axis, sizes and layer order. */
export function PushImages(Images: readonly BoardImage[], SelectedIds: readonly string[] | ReadonlySet<string>, Direction: PushDirection): BoardImage[] {
  const Selected = new Set(SelectedIds)
  const Targets = Images.filter((ImageValue) => Selected.has(ImageValue.id))
  if (Targets.length < 2) return [...Images]
  const Bounds = BoundingBox(Targets)
  if (!Bounds) return [...Images]
  const Horizontal = Direction === 'left' || Direction === 'right'
  const Reverse = Direction === 'right' || Direction === 'bottom'
  const Axis = Horizontal ? 'x' : 'y'
  const Dimension = Horizontal ? 'width' : 'height'
  const CrossAxis = Horizontal ? 'y' : 'x'
  const CrossDimension = Horizontal ? 'height' : 'width'
  // Push toward the original outer edge. Separate rows/columns can reach the
  // same edge; only images with intersecting perpendicular spans block one another.
  const Ordered = [...Targets].sort((A, B) => {
    const AEdge = A[Axis] + (Reverse ? A[Dimension] : 0)
    const BEdge = B[Axis] + (Reverse ? B[Dimension] : 0)
    return (Reverse ? BEdge - AEdge : AEdge - BEdge) || A[CrossAxis] - B[CrossAxis]
  })
  // Read the far edge directly: rebuilding it from min + bounding size adds
  // cancellation error when a previous push expanded the bounds backwards.
  const Edge = Reverse ? Targets.reduce((Maximum, ImageValue) => Math.max(Maximum, ImageValue[Axis] + ImageValue[Dimension]), -Infinity) : Bounds[Axis]
  const Placed = new Map<string, BoardImage>()
  for (const ImageValue of Ordered) {
    let Position = Edge - (Reverse ? ImageValue[Dimension] : 0)
    for (const Other of Placed.values()) {
      const Crosses = ImageValue[CrossAxis] < Other[CrossAxis] + Other[CrossDimension]
        && ImageValue[CrossAxis] + ImageValue[CrossDimension] > Other[CrossAxis]
      if (!Crosses) continue
      Position = Reverse
        ? Math.min(Position, Other[Axis] - ImageValue[Dimension])
        : Math.max(Position, Other[Axis] + Other[Dimension])
    }
    if (!Number.isFinite(Position) || !Number.isFinite(Position + ImageValue[Dimension])) return [...Images]
    Placed.set(ImageValue.id, Position === ImageValue[Axis] ? ImageValue : { ...ImageValue, [Axis]: Position })
  }
  return Images.map((ImageValue) => Placed.get(ImageValue.id) ?? ImageValue)
}

/** Match selected centres to the centre of their bounding box on one axis. */
export function CenterImages(Images: readonly BoardImage[], SelectedIds: readonly string[] | ReadonlySet<string>, Mode: CenterMode): BoardImage[] {
  const Selected = new Set(SelectedIds)
  const Bounds = BoundingBox(Images.filter((ImageValue) => Selected.has(ImageValue.id)))
  if (!Bounds) return [...Images]
  return Images.map((ImageValue) => {
    if (!Selected.has(ImageValue.id)) return ImageValue
    return Mode === 'horizontal'
      ? { ...ImageValue, x: Bounds.x + (Bounds.width - ImageValue.width) / 2 }
      : { ...ImageValue, y: Bounds.y + (Bounds.height - ImageValue.height) / 2 }
  })
}

/** Normalize selected dimensions to their average, preserving each image's centre and aspect ratio. */
export function NormalizeImages(Images: readonly BoardImage[], SelectedIds: readonly string[] | ReadonlySet<string>, Mode: NormalizeMode): BoardImage[] {
  const Selected = new Set(SelectedIds)
  const Targets = Images.filter((ImageValue) => Selected.has(ImageValue.id)
    && [ImageValue.x, ImageValue.y, ImageValue.width, ImageValue.height].every(Number.isFinite)
    && ImageValue.width > 0 && ImageValue.height > 0)
  if (Targets.length < 2 || Targets.every((ImageValue) => ImageValue[Mode] === Targets[0][Mode])) return [...Images]
  // An incremental mean avoids overflowing the sum of otherwise valid sizes.
  const Dimension = Targets.reduce((Average, ImageValue, Index) => Average + (ImageValue[Mode] - Average) / (Index + 1), 0)
  if (!Number.isFinite(Dimension) || Dimension <= 0) return [...Images]
  const Normalized = new Map<string, BoardImage>()
  for (const ImageValue of Targets) {
    if (ImageValue[Mode] === Dimension) continue
    const Scale = Dimension / ImageValue[Mode]
    const Width = Mode === 'width' ? Dimension : ImageValue.width * Scale
    const Height = Mode === 'height' ? Dimension : ImageValue.height * Scale
    const X = ImageValue.x + (ImageValue.width - Width) / 2
    const Y = ImageValue.y + (ImageValue.height - Height) / 2
    if (![X, Y, Width, Height].every(Number.isFinite) || Width <= 0 || Height <= 0) return [...Images]
    Normalized.set(ImageValue.id, { ...ImageValue, x: X, y: Y, width: Width, height: Height })
  }
  return Images.map((ImageValue) => Normalized.get(ImageValue.id) ?? ImageValue)
}

/**
 * Snap the translated selection's outer edges and centre to other images.
 * Supply threshold in world units (normally 6 / viewport.zoom), and exclude
 * selected images from others. The UI bypasses this helper while Alt is held.
 */
export function SnapMove(Bounds: Rect, Others: readonly Rect[], Dx: number, Dy: number, Threshold = 6): SnapResult {
  const Limit = Math.max(0, Threshold)
  const MovingX = [Bounds.x + Dx, Bounds.x + Dx + Bounds.width / 2, Bounds.x + Dx + Bounds.width]
  const MovingY = [Bounds.y + Dy, Bounds.y + Dy + Bounds.height / 2, Bounds.y + Dy + Bounds.height]
  let BestX: { delta: number; position: number } | undefined
  let BestY: { delta: number; position: number } | undefined
  for (const Other of Others) {
    for (const Target of [Other.x, Other.x + Other.width / 2, Other.x + Other.width]) {
      for (const Edge of MovingX) {
        const Delta = Target - Edge
        if (Math.abs(Delta) <= Limit && (!BestX || Math.abs(Delta) < Math.abs(BestX.delta))) BestX = { delta: Delta, position: Target }
      }
    }
    for (const Target of [Other.y, Other.y + Other.height / 2, Other.y + Other.height]) {
      for (const Edge of MovingY) {
        const Delta = Target - Edge
        if (Math.abs(Delta) <= Limit && (!BestY || Math.abs(Delta) < Math.abs(BestY.delta))) BestY = { delta: Delta, position: Target }
      }
    }
  }
  const Guides: SnapGuide[] = []
  if (BestX) Guides.push({ axis: 'x', position: BestX.position })
  if (BestY) Guides.push({ axis: 'y', position: BestY.position })
  return { dx: Dx + (BestX?.delta ?? 0), dy: Dy + (BestY?.delta ?? 0), guides: Guides }
}

/**
 * Always pass the images captured at pointer-down, never the previous frame.
 * Project the pointer onto the original corner diagonal for one uniform scale.
 * The opposite corner remains fixed, and crossing it cannot flip any image.
 */
export function ResizeGroup(Images: readonly BoardImage[], Corner: ResizeCorner, Pointer: Point, MinSize = 1): BoardImage[] {
  const Bounds = BoundingBox(Images)
  if (!Bounds || Bounds.width <= 0 || Bounds.height <= 0) return [...Images]
  const Left = Corner === 'nw' || Corner === 'sw'
  const Top = Corner === 'nw' || Corner === 'ne'
  const Anchor = { x: Left ? Bounds.x + Bounds.width : Bounds.x, y: Top ? Bounds.y + Bounds.height : Bounds.y }
  const Diagonal = { x: Left ? -Bounds.width : Bounds.width, y: Top ? -Bounds.height : Bounds.height }
  const ProjectedScale = ((Pointer.x - Anchor.x) * Diagonal.x + (Pointer.y - Anchor.y) * Diagonal.y)
    / (Diagonal.x * Diagonal.x + Diagonal.y * Diagonal.y)
  const MinimumDimension = Math.max(Number.EPSILON, MinSize)
  const MinimumScale = Images.reduce((Minimum, ImageValue) => Math.max(Minimum, MinimumDimension / ImageValue.width, MinimumDimension / ImageValue.height), 0)
  const Scale = Math.max(MinimumScale, ProjectedScale)
  return Images.map((ImageValue) => ({
    ...ImageValue,
    x: Anchor.x + (ImageValue.x - Anchor.x) * Scale,
    y: Anchor.y + (ImageValue.y - Anchor.y) * Scale,
    width: ImageValue.width * Scale,
    height: ImageValue.height * Scale,
  }))
}

export function FitViewport(Bounds: Rect | null, Size: Size, Padding = 64): Viewport {
  if (!Bounds) return { x: 0, y: 0, zoom: 1 }
  const Zoom = ClampZoom(Math.min(
    Math.max(1, Size.width - Padding * 2) / Math.max(1, Bounds.width),
    Math.max(1, Size.height - Padding * 2) / Math.max(1, Bounds.height),
  ))
  return { x: Size.width / 2 - (Bounds.x + Bounds.width / 2) * Zoom, y: Size.height / 2 - (Bounds.y + Bounds.height / 2) * Zoom, zoom: Zoom }
}
