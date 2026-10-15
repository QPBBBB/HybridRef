import { EventEmitter } from 'node:events'
import { beforeEach as BeforeEach, describe as Describe, expect as Expect, it as It, vi as Vi } from 'vitest'

const { LookupMock, RequestMock } = Vi.hoisted(() => ({ LookupMock: Vi.fn(), RequestMock: Vi.fn() }))
Vi.mock('node:dns/promises', () => ({ lookup: LookupMock }))
Vi.mock('node:https', () => ({ request: RequestMock }))
const { DownloadMarkdownImage, IsPublicImageAddress, MarkdownImageByteLimit } = await import('./MarkdownImages')

BeforeEach(() => { Vi.resetAllMocks(); LookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]) })

function Reply(Status: number, Headers: Record<string, string>, Chunks: Buffer[] = []): void {
  RequestMock.mockImplementationOnce((Url, Options, Callback) => {
    const Request = Object.assign(new EventEmitter(), { end: () => {
      const Response = Object.assign(new EventEmitter(), { statusCode: Status, headers: Headers, resume: () => {}, destroy: () => {} })
      Callback(Response)
      for (const Chunk of Chunks) Response.emit('data', Chunk)
      Response.emit('end')
    }, destroy: (Error: Error) => Request.emit('error', Error) })
    return Request
  })
}

Describe('Markdown network images', () => {
  It.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1'])('blocks private address %s', (Address) => {
    Expect(IsPublicImageAddress(Address)).toBe(false)
  })
  It('pins public DNS when requesting bytes', async () => {
    Reply(200, {}, [Buffer.from('image')])
    Expect(await DownloadMarkdownImage('https://example.com/image.png')).toEqual(Buffer.from('image'))
    const Options = RequestMock.mock.calls[0][1]
    const Resolved = Vi.fn()
    Options.lookup('example.com', {}, Resolved)
    Expect(Resolved).toHaveBeenCalledWith(null, '8.8.8.8', 4)
    Expect(Options.family).toBe(4)
    Expect(IsPublicImageAddress('2606:4700::1111')).toBe(true)
  })
  It('revalidates redirect destinations and rejects mixed public/private DNS', async () => {
    Reply(302, { location: 'https://internal.test/image' })
    LookupMock.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])
    await Expect(DownloadMarkdownImage('https://example.com/image')).rejects.toThrow('内网')
    Expect(RequestMock).toHaveBeenCalledTimes(1)
  })
  It('rejects oversized or failed responses', async () => {
    Reply(200, { 'content-length': String(MarkdownImageByteLimit + 1) })
    await Expect(DownloadMarkdownImage('https://example.com/big')).rejects.toThrow('20 MB')
    Reply(404, {})
    await Expect(DownloadMarkdownImage('https://example.com/missing')).rejects.toThrow('404')
  })
})
