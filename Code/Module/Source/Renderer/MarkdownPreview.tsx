import React, { useEffect as UseEffect, useMemo as UseMemo, useRef as UseRef } from 'react'
import { RenderMarkdownHtml, ResolveMarkdownImages } from './MarkdownContent'
import './Markdown.css'

export function MarkdownPreview({ Content, ProjectPath }: { Content: string; ProjectPath: string | null }): React.ReactElement {
  const Root = UseRef<HTMLDivElement>(null)
  const Html = UseMemo(() => RenderMarkdownHtml(Content), [Content])
  UseEffect(() => {
    let Active = true
    if (Root.current) void ResolveMarkdownImages(Root.current, ProjectPath, () => Active)
    return () => { Active = false }
  }, [Html, ProjectPath])
  return <div key={ProjectPath ?? ''} ref={Root} className="markdown-content" data-testid="markdown-content" dangerouslySetInnerHTML={{ __html: Html }}
    onPointerDown={(InputEvent) => {
      if ((InputEvent.ctrlKey || InputEvent.metaKey) && (InputEvent.target as Element).closest('a[href]')) InputEvent.stopPropagation()
    }}
    onClick={(InputEvent) => {
      const Link = (InputEvent.target as Element).closest<HTMLAnchorElement>('a[href]')
      if (!Link) return
      InputEvent.preventDefault()
      const Href = Link.getAttribute('href') ?? ''
      if ((InputEvent.ctrlKey || InputEvent.metaKey) && /^(https?:|mailto:)/i.test(Href)) window.open(Href, '_blank', 'noopener,noreferrer')
    }} />
}
