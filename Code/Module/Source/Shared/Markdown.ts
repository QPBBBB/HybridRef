import { Marked } from 'marked'

// Keep ordinary line breaks visible in reference-board notes, as in GitHub comments.
export const MarkdownParser = new Marked({ gfm: true, breaks: true, async: false })

export function MarkdownImageSources(Content: string): string[] {
  const Sources = new Set<string>()
  MarkdownParser.walkTokens(MarkdownParser.lexer(Content), (Token) => {
    if (Token.type === 'image') Sources.add(String(Token.href))
    // Raw HTML is sanitized in the renderer. Conservatively protect local img
    // references during cleanup too, including quoted attributes and entities.
    if (Token.type === 'html') {
      for (const Image of String(Token.text).matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) Sources.add(Image[1] ?? Image[2] ?? Image[3])
    }
  })
  return [...Sources].map((Source) => Source.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[a-f0-9]+);/gi, (Entity) => {
    const Named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' }
    if (Named[Entity.toLowerCase()]) return Named[Entity.toLowerCase()]
    const Code = Entity[2].toLowerCase() === 'x' ? parseInt(Entity.slice(3, -1), 16) : parseInt(Entity.slice(2, -1), 10)
    return Code > 0 && Code <= 0x10ffff ? String.fromCodePoint(Code) : '\uFFFD'
  }))
}

/** Markdown URLs are URI-encoded; project paths must remain inside the project directory. */
export function MarkdownLocalImagePath(Source: string): string | null {
  if (!Source || /^[a-z][a-z0-9+.-]*:/i.test(Source) || /^[\\/]/.test(Source)) return null
  let Path: string
  try { Path = decodeURIComponent(Source.split(/[?#]/)[0]).replace(/\\/g, '/') } catch { return null }
  while (Path.startsWith('./')) Path = Path.slice(2)
  if (!Path || /[:\u0000-\u001f]/.test(Path) || Path.split('/').some((Part) => !Part || Part === '..' || Part === '.')) return null
  return Path
}
