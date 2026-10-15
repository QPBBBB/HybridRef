import CreatePurifier from 'dompurify'
import { MarkdownParser } from '../Shared/Markdown'
import type { ImageAsset } from '../Shared/Types'

const Purifier = CreatePurifier(window)
const ImageRequests = new Map<string, Promise<ImageAsset>>()

export function ClearMarkdownImages(): void { ImageRequests.clear() }

export function RenderMarkdownHtml(Content: string): string {
  const Parsed = MarkdownParser.parse(Content.replace(/\u0000/g, '\uFFFD'), { async: false })
  const Fragment = Purifier.sanitize(Parsed, {
    RETURN_DOM_FRAGMENT: true, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    ALLOWED_TAGS: ['a', 'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'align', 'start', 'checked', 'type', 'class', 'colspan', 'rowspan'],
  })
  for (const Element of Fragment.querySelectorAll('[class]')) {
    const Class = Element.getAttribute('class') ?? ''
    if (Element.tagName !== 'CODE' || !/^language-[\w-]+$/.test(Class)) Element.removeAttribute('class')
  }
  for (const Link of Fragment.querySelectorAll('a')) {
    const Href = Link.getAttribute('href') ?? ''
    if (!/^(https?:|mailto:|#)/i.test(Href)) Link.removeAttribute('href')
    if (/^(https?:|mailto:)/i.test(Href)) Link.title = `${Link.title ? `${Link.title} · ` : ''}Ctrl+单击打开链接`
    Link.setAttribute('rel', 'noopener noreferrer')
    Link.setAttribute('target', '_blank')
    Link.setAttribute('draggable', 'false')
  }
  for (const Input of Fragment.querySelectorAll('input')) {
    if (Input.getAttribute('type') !== 'checkbox') { Input.remove(); continue }
    const Check = document.createElement('span')
    Check.className = 'markdown-checkbox'
    Check.textContent = Input.hasAttribute('checked') ? '☑' : '☐'
    Check.setAttribute('role', 'img')
    Check.setAttribute('aria-label', Input.hasAttribute('checked') ? '已完成' : '未完成')
    Input.replaceWith(Check)
  }
  for (const Image of Fragment.querySelectorAll('img')) {
    // Resolve through the local service before exposing any URL to the live DOM.
    Image.dataset.markdownSource = Image.getAttribute('src') ?? ''
    Image.removeAttribute('src')
    Image.setAttribute('draggable', 'false')
  }
  // Keep textContent line breaks useful for accessibility and plain-text selection.
  for (const Break of Fragment.querySelectorAll('br')) Break.after(document.createTextNode('\n'))
  const Container = document.createElement('div')
  Container.append(Fragment)
  return Container.innerHTML
}

export async function ResolveMarkdownImages(Root: HTMLElement, ProjectPath: string | null, Active: () => boolean = () => true): Promise<void> {
  await Promise.all([...Root.querySelectorAll<HTMLImageElement>('img[data-markdown-source]')].map(async (Image) => {
    const Source = Image.dataset.markdownSource ?? ''
    const Key = JSON.stringify([ProjectPath, Source])
    let Request = ImageRequests.get(Key)
    if (!Request) {
      Request = window.HybridRef.MarkdownImage(Source, ProjectPath)
      ImageRequests.set(Key, Request)
      void Request.catch(() => { if (ImageRequests.get(Key) === Request) ImageRequests.delete(Key) })
    }
    try {
      const Asset = await Request
      if (!Active()) return
      Image.src = Asset.dataUrl
      Image.width = Asset.width; Image.height = Asset.height
      await Image.decode()
    } catch (CaughtError) {
      if (!Active()) return
      const Placeholder = document.createElement('span')
      Placeholder.className = 'markdown-image-missing'
      Placeholder.textContent = `[图片：${Image.alt || '加载失败'}]`
      Placeholder.title = CaughtError instanceof Error ? CaughtError.message : String(CaughtError)
      Image.replaceWith(Placeholder)
    }
  }))
}
