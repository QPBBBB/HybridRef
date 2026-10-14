import React from 'react'
import type { TextResource } from '../Shared/Types'

export function TextBoldIcon(): React.ReactElement {
  return <span className="tool-icon text-bold-icon" aria-hidden="true" />
}

export function TextAlignmentIcon({ Align }: { Align: TextResource['paragraph']['align'] }): React.ReactElement {
  const Start = { left: 4, center: 7, right: 10 }[Align]
  return <svg viewBox="0 0 24 24" className="text-alignment-icon" aria-hidden="true">
    <path d={`M4 6h16 M${Start} 12h10 M4 18h16`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
}
