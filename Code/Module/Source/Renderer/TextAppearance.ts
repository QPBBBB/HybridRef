import type { CSSProperties } from 'react'
import { TextFontFamily, type TextResource } from '../Shared/Types'

/** Shared by the live frame and PNG export so wrapping and style stay identical. */
export function TextAppearance(Text: TextResource): CSSProperties {
  return {
    boxSizing: 'border-box', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', overflow: 'hidden',
    padding: `${Text.padding}px`, fontFamily: TextFontFamily, fontSize: `${Text.font.size}px`, fontWeight: Text.font.weight,
    // Composite text, Markdown images and background together, with no separate font alpha.
    color: Text.font.color, backgroundColor: Text.background.color, opacity: Text.opacity,
    textAlign: Text.paragraph.align, lineHeight: Text.paragraph.lineHeight,
  }
}
