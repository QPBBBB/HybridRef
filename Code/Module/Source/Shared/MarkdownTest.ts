import { describe as Describe, expect as Expect, it as It } from 'vitest'
import { MarkdownImageSources, MarkdownLocalImagePath, MarkdownParser } from './Markdown'

Describe('Markdown reference parsing', () => {
  It('finds inline, nested, reference and HTML images without treating code examples as references', () => {
    const Content = '![图](DemoResource/A.png)\n\n> [![链接图片][picture]](https://example.com)\n\n[picture]: Images/B%20C.png\n\n<img alt="示例" src="Images/A&amp;B.png">\n\n`![代码](Unused.png)`\n\n```md\n![代码](Unused2.png)\n```'
    Expect(MarkdownImageSources(Content)).toEqual(['DemoResource/A.png', 'Images/B%20C.png', 'Images/A&B.png'])
  })
  It.each(['../Secret.png', '%2e%2e/Secret.png', '/Secret.png', 'C:/Secret.png', '\\\\server\\Secret.png', 'file:///Secret.png', 'https://example.com/a.png', 'data:image/png;base64,AAAA', '%2FSecret.png', 'a/%00.png'])('rejects non-project image path %s', (Source) => {
    Expect(MarkdownLocalImagePath(Source)).toBeNull()
  })
  It('decodes local URL paths once and keeps encoded filename punctuation', () => {
    Expect(MarkdownLocalImagePath('./Images/中文%20%23100%25.png?version=1#anchor')).toBe('Images/中文 #100%.png')
  })
  It('enables GFM tables, tasks, strikethrough, autolinks and note line breaks', () => {
    const Html = MarkdownParser.parse('| A | B |\n| - | -: |\n| ~~旧~~ | 新 |\n\n- [x] 完成\n- [ ] 待办\n\nhttps://example.com\n第二行', { async: false })
    for (const Tag of ['<table>', '<del>旧</del>', 'type="checkbox"', 'checked', 'align="right"', 'href="https://example.com"', '<br>']) Expect(Html).toContain(Tag)
  })
})
