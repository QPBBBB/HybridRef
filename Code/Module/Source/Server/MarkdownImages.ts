import { lookup as Lookup } from 'node:dns/promises'
import { request as HttpRequest } from 'node:http'
import { request as HttpsRequest } from 'node:https'
import { BlockList, isIP as IsIp } from 'node:net'

export const MarkdownImageByteLimit = 20 * 1024 * 1024
const PrivateAddresses = new BlockList()
for (const [Address, Prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) PrivateAddresses.addSubnet(Address, Prefix, 'ipv4')
PrivateAddresses.addSubnet('2001:db8::', 32, 'ipv6')

export function IsPublicImageAddress(Address: string): boolean {
  const Family = IsIp(Address)
  if (Family === 4) return !PrivateAddresses.check(Address, 'ipv4')
  return Family === 6 && /^[23]/.test(Address) && !PrivateAddresses.check(Address, 'ipv6')
}

/** Pin the validated DNS result for each redirect, rather than letting fetch resolve it again. */
export async function DownloadMarkdownImage(Source: string, Redirects = 0): Promise<Buffer> {
  const Url = new URL(Source)
  if (!['https:', 'http:'].includes(Url.protocol) || Url.username || Url.password) throw new Error('图片链接只支持无账户信息的 HTTP / HTTPS 地址。')
  const Hostname = Url.hostname.replace(/^\[|\]$/g, '')
  const Addresses = await Lookup(Hostname, { all: true })
  if (!Addresses.length || Addresses.some((Entry) => !IsPublicImageAddress(Entry.address))) throw new Error('网络图片不能访问本机或内网地址。')
  const Address = Addresses[0]
  return new Promise<Buffer>((Resolve, Reject) => {
    const Request = (Url.protocol === 'https:' ? HttpsRequest : HttpRequest)(Url, {
      family: Address.family, lookup: (Hostname, Options, Callback) => Callback(null, Address.address, Address.family),
      headers: { Accept: 'image/*', 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(10_000),
    }, (Response) => {
      const Status = Response.statusCode ?? 0
      if ([301, 302, 303, 307, 308].includes(Status) && Response.headers.location) {
        Response.resume()
        if (Redirects >= 3) { Reject(new Error('图片链接重定向次数过多。')); return }
        void DownloadMarkdownImage(new URL(Response.headers.location, Url).href, Redirects + 1).then(Resolve, Reject)
        return
      }
      if (Status !== 200) { Response.resume(); Reject(new Error(`图片请求失败 (${Status})`)); return }
      if (Number(Response.headers['content-length']) > MarkdownImageByteLimit) { Response.destroy(); Reject(new Error('Markdown 图片不能超过 20 MB。')); return }
      const Chunks: Buffer[] = []
      let Size = 0
      Response.on('data', (Chunk: Buffer) => {
        Size += Chunk.length
        if (Size > MarkdownImageByteLimit) Request.destroy(new Error('Markdown 图片不能超过 20 MB。'))
        else Chunks.push(Chunk)
      })
      Response.on('end', () => Resolve(Buffer.concat(Chunks, Size)))
      Response.on('error', Reject)
      Response.on('aborted', () => Reject(new Error('图片传输已中断。')))
    })
    Request.on('error', Reject)
    Request.end()
  })
}
