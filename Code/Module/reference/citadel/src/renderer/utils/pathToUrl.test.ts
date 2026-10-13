import { describe, expect, it } from 'vitest'
import { pathToUrl } from './pathToUrl'

describe('local asset URL encoding', () => {
  it.each([
    ['D:\\参考\\TestRefResource\\色卡 #1 100%.png', 'local:///D:/%E5%8F%82%E8%80%83/TestRefResource/%E8%89%B2%E5%8D%A1%20%231%20100%25.png'],
    ['/home/画板/which? #1%.png', 'local:////home/%E7%94%BB%E6%9D%BF/which%3F%20%231%25.png'],
    ['D:/refs/literal%20name.png', 'local:///D:/refs/literal%2520name.png'],
    ['\\\\server\\shared refs\\#test.png', 'local://///server/shared%20refs/%23test.png'],
    ['C:/refs/test.png', 'local:///C:/refs/test.png'],
  ])('round-trips raw path %s through the custom protocol', (path, expected) => {
    const url = pathToUrl(path)
    expect(url).toBe(expected)
    const parsed = new URL(url)
    expect(parsed.hash).toBe('')
    expect(parsed.search).toBe('')
    expect(decodeURIComponent(parsed.href.slice('local:///'.length))).toBe(path.replace(/\\/g, '/'))
    expect(pathToUrl(url)).toBe(url)
  })

  it.each([
    'https://example.com/a%20b.png?size=2#preview',
    'http://example.com/a.png',
    'data:image/png;base64,abc==',
    'blob:https://example.com/id',
    'file:///C:/a%20b.png',
    'local:///C:/a%23b%25.png',
    'HTTPS://example.com/a.png',
  ])('preserves an existing URL without double encoding: %s', (url) => {
    expect(pathToUrl(url)).toBe(url)
  })

  it('does not mistake a filename beginning with http for a URL', () => {
    expect(pathToUrl('https reference.png')).toBe('local:///https%20reference.png')
    expect(pathToUrl('')).toBe('')
  })
})
