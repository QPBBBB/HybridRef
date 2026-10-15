import React from 'react'
import type { BoardArrow } from '../Shared/Types'
import { ArrowDash, ArrowDrawing } from '../Shared/Arrows'

export function ArrowView({ Item, Zoom, Selected, OnPointerDown }: { Item: BoardArrow; Zoom: number; Selected: boolean; OnPointerDown: (InputEvent: React.PointerEvent) => void }): React.ReactElement {
  const Drawing = ArrowDrawing(Item)
  return <svg data-testid="arrow-item" data-arrow-id={Item.id} data-x={Item.x} data-y={Item.y} data-width={Item.width} data-height={Item.height}
    className={`board-arrow${Selected ? ' selected' : ''}`} style={{ left: Item.x, top: Item.y, width: Item.width, height: Item.height }} viewBox={`0 0 ${Item.width} ${Item.height}`}>
    <path data-testid="arrow-line" d={Drawing.path} fill="none" stroke={Item.arrow.color} strokeWidth={Item.arrow.thickness} strokeDasharray={ArrowDash(Item.arrow)} strokeLinecap="round" strokeLinejoin="round" />
    <polygon points={Drawing.head} fill={Item.arrow.color} />
    <path data-testid="arrow-hit" d={Drawing.path} fill="none" stroke="transparent" strokeWidth={Math.max(14 / Zoom, Item.arrow.thickness + 8 / Zoom)} className="arrow-hit" onPointerDown={OnPointerDown} />
  </svg>
}
