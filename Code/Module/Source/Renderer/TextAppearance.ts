import type { CSSProperties } from 'react'
import { TextFontFamily, type TextResource } from '../Shared/Types'

function TextColor(Color: string, Opacity: number): string {
  const Channels = [1, 3, 5].map((Index) => parseInt(Color.slice(Index, Index + 2), 16))
  return `rgba(${Channels.join(', ')}, ${Opacity})`
}

/** Shared by the live frame and PNG export so wrapping and style stay identical. */
export function TextAppearance(Text: TextResource): CSSProperties {
  return {
    boxSizing: 'border-box', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', overflow: 'hidden',
    padding: `${Text.padding}px`, fontFamily: TextFontFamily, fontSize: `${Text.font.size}px`, fontWeight: Text.font.weight,
    color: TextColor(Text.font.color, Text.font.opacity), backgroundColor: TextColor(Text.background.color, Text.background.opacity),
    textAlign: Text.paragraph.align, lineHeight: Text.paragraph.lineHeight,
  }
}
