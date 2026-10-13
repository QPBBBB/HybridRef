import type { BoardImage, Viewport } from '../Shared/Types'

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Rect extends Point, Size {}
export type AlignMode = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'
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

export function AlignImages(Images: readonly BoardImage[], SelectedIds: readonly string[] | ReadonlySet<string>, Mode: AlignMode): BoardImage[] {
  const Selected = new Set(SelectedIds)
  const Bounds = BoundingBox(Images.filter((ImageValue) => Selected.has(ImageValue.id)))
  if (!Bounds) return [...Images]
  return Images.map((ImageValue) => {
    if (!Selected.has(ImageValue.id)) return ImageValue
    switch (Mode) {
      case 'left': return { ...ImageValue, x: Bounds.x }
      case 'centerX': return { ...ImageValue, x: Bounds.x + (Bounds.width - ImageValue.width) / 2 }
      case 'right': return { ...ImageValue, x: Bounds.x + Bounds.width - ImageValue.width }
      case 'top': return { ...ImageValue, y: Bounds.y }
      case 'centerY': return { ...ImageValue, y: Bounds.y + (Bounds.height - ImageValue.height) / 2 }
      case 'bottom': return { ...ImageValue, y: Bounds.y + Bounds.height - ImageValue.height }
    }
  })
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
