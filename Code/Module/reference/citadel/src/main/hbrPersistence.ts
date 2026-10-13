/** Text-first HybridRef projects. All filesystem work stays in the main process. */
import { createHash, randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'
import { decode as decodeBmp } from 'bmp-js'
import sharp from 'sharp'
import { parseDocument, stringify } from 'yaml'
import { visitProjectAssetPaths, visitProjectItems } from '../types/projectAssetPaths'
import { parseDataUrl } from './dataUrl'

type RecordValue = Record<string, unknown>
type SourceFingerprint = { size: number; mtimeMs: number }
export type HbrSaveResult = {
  assetReplacements: Record<string, string>
  sourceFingerprints: Record<string, SourceFingerprint>
}
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.tif', '.tiff', '.avif', '.heic', '.heif', '.bmp', '.ico'])
const MODEL_EXTENSIONS = new Set(['.gltf', '.glb', '.obj'])
const FIELD_ORDER = ['format', 'formatVersion', 'version', 'createdAt', 'activeBoardId', 'boards', 'recordings', 'keybindOverrides', 'id', 'name', 'type', 'src', 'x', 'y', 'width', 'height', 'rotation', 'zIndex', 'groupId', 'locked', 'visible', 'opacity', 'tags', 'meta', 'items', 'connections', 'viewport']
const fieldRank = new Map(FIELD_ORDER.map((key, index) => [key, index]))
const pendingWrites = new Map<string, Promise<HbrSaveResult>>()

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function posix(path: string): string { return path.replace(/\\/g, '/') }
function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function remote(source: string): boolean { return /^[a-z][a-z0-9+.-]+:/i.test(source) && !/^(file|local|data|blob):/i.test(source) }

function localPath(source: string, projectDir: string): string {
  if (/^file:/i.test(source)) return fileURLToPath(source)
  if (/^local:\/\/\//i.test(source)) {
    const decoded = decodeURIComponent(source.slice('local:///'.length))
    return isAbsolute(decoded) ? decoded : resolve(projectDir, decoded)
  }
  return isAbsolute(source) ? source : resolve(projectDir, source)
}

/** Sort mapping fields only. Array order carries layering, events and board order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort((a, b) => {
    const order = (fieldRank.get(a) ?? FIELD_ORDER.length) - (fieldRank.get(b) ?? FIELD_ORDER.length)
    return order || (a < b ? -1 : a > b ? 1 : 0)
  }).map((key) => [key, canonical(value[key])]))
}

function parseHbr(raw: string): RecordValue {
  const document = parseDocument(raw, { uniqueKeys: true })
  if (document.errors.length) throw new Error(`Invalid HybridRef YAML: ${document.errors[0].message}`)
  const project: unknown = document.toJS({ maxAliasCount: 0 })
  if (!isRecord(project) || !Array.isArray(project.boards)) throw new Error('Invalid HybridRef project: boards must be an array.')
  if (project.format !== 'hybridref' || project.formatVersion !== 1) throw new Error('Unsupported HybridRef format or formatVersion.')
  return project
}

/** Same-directory replacement keeps a failed save from truncating the last good file. */
async function atomicWrite(path: string, bytes: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
  }
}

async function writeContent(path: string, bytes: Buffer): Promise<void> {
  if (existsSync(path)) {
    if (!(await readFile(path)).equals(bytes)) throw new Error(`Resource content does not match its hash: ${path}`)
    return
  }
  await atomicWrite(path, bytes)
}

/** APNG's animation control chunk is not reported as multiple pages by all libvips builds. */
function animatedPng(bytes: Buffer): boolean {
  if (bytes.length < 8 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') return false
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset)
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') return true
    offset += size + 12
  }
  return false
}

async function normalizeImage(bytes: Buffer, extension: string): Promise<{ bytes: Buffer; extension: string }> {
  // GIF items use gifler, which requires a GIF even when it contains one frame.
  if (extension === '.gif' || animatedPng(bytes)) return { bytes, extension }
  if (extension === '.bmp') {
    const bitmap = decodeBmp(bytes)
    const rgba = Buffer.allocUnsafe(bitmap.data.length)
    const hasAlpha = bitmap.bitPP === 32 && bitmap.data.some((value, index) => index % 4 === 0 && value !== 0)
    for (let offset = 0; offset < bitmap.data.length; offset += 4) {
      // bmp-js emits ABGR; 24-bit BMP's first byte is padding, not opacity.
      rgba[offset] = bitmap.data[offset + 3]
      rgba[offset + 1] = bitmap.data[offset + 2]
      rgba[offset + 2] = bitmap.data[offset + 1]
      rgba[offset + 3] = hasAlpha ? bitmap.data[offset] : 255
    }
    const png = await sharp(rgba, { raw: { width: bitmap.width, height: bitmap.height, channels: 4 } }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
    return { bytes: png, extension: '.png' }
  }
  const decoder = sharp(bytes, { animated: true })
  const metadata = await decoder.metadata()
  if ((metadata.pages ?? 1) > 1) return { bytes, extension }
  const png = await sharp(bytes).rotate().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
  return { bytes: png, extension: '.png' }
}

function decodeData(source: string): { bytes: Buffer; extension: string; image: boolean } {
  const parsed = parseDataUrl(source)
  if (parsed) return { bytes: parsed.bytes, extension: `.${parsed.extension.replace(/[^a-z0-9]/gi, '') || 'bin'}`, image: parsed.type === 'image' }
  const plain = /^data:([^;,]+)(?:;[^,]*)?,(.*)$/is.exec(source)
  if (!plain || /;base64,/i.test(source)) throw new Error('Cannot save an invalid or empty data URL.')
  const bytes = Buffer.from(decodeURIComponent(plain[2]), 'utf8')
  if (!bytes.length) throw new Error('Cannot save an empty data URL.')
  const mime = plain[1].toLowerCase()
  const extension = mime === 'image/svg+xml' ? '.svg' : `.${mime.split('/')[1].replace(/[^a-z0-9]/g, '') || 'bin'}`
  return { bytes, extension, image: mime.startsWith('image/') }
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..\\`) && !path.startsWith('../'))
}

function uriDependencies(value: unknown): string[] {
  const result: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (isRecord(node)) {
      for (const [key, child] of Object.entries(node)) {
        if (key === 'uri' && typeof child === 'string') result.push(child)
        else walk(child)
      }
    }
  }
  walk(value)
  return result
}

function tokens(text: string): string[] {
  return (text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((part) => part.replace(/^(['"])(.*)\1$/, '$2'))
}

/** Read referenced files only; never copy a whole source folder with unrelated files. */
function modelDependencies(path: string, bytes: Buffer): string[] {
  const extension = extname(path).toLowerCase()
  if (extension === '.gltf') return uriDependencies(JSON.parse(bytes.toString('utf8')))
  if (extension === '.glb' && bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'glTF') {
    const length = bytes.readUInt32LE(12)
    if (bytes.readUInt32LE(16) === 0x4e4f534a && length <= bytes.length - 20) return uriDependencies(JSON.parse(bytes.toString('utf8', 20, 20 + length).replace(/\0+$/, '').trim()))
    return []
  }
  if (extension !== '.obj' && extension !== '.mtl') return []
  const result: string[] = []
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const command = match[1].toLowerCase()
    if (extension === '.obj' && command === 'mtllib') {
      const whole = match[2].replace(/^(['"])(.*)\1$/, '$2')
      result.push(...(existsSync(resolve(dirname(path), whole)) ? [whole] : tokens(match[2])))
    } else if (extension === '.mtl' && /^(map_|bump$|disp$|decal$|refl$|norm$)/.test(command)) {
      const parts = tokens(match[2])
      while (parts[0]?.startsWith('-')) {
        const option = parts.shift()
        if (option === '-o' || option === '-s' || option === '-t') {
          for (let count = 0; count < 3 && parts.length && Number.isFinite(Number(parts[0])); count += 1) parts.shift()
        } else parts.splice(0, option === '-mm' ? 2 : 1)
      }
      if (parts.length) result.push(parts.join(' '))
    }
  }
  return result
}

/** Preserve model-relative names and original dependency bytes inside a content-addressed bundle. */
async function copyModel(sourcePath: string, resourceDir: string): Promise<string> {
  const files = new Map<string, Buffer>()
  const gather = async (path: string): Promise<void> => {
    if (files.has(path)) return
    const bytes = await readFile(path)
    files.set(path, bytes)
    for (const dependency of modelDependencies(path, bytes)) {
      if (/^(data:|https?:)/i.test(dependency)) continue
      if (isAbsolute(dependency) || /^[a-z][a-z0-9+.-]*:/i.test(dependency)) throw new Error(`Model dependency must be relative: ${dependency}`)
      const decoded = decodeURIComponent(dependency)
      await gather(resolve(dirname(path), decoded))
    }
  }
  await gather(sourcePath)
  // A self-contained model has no relative names to protect. Keep it alongside
  // other hashed files, including when loading an existing HybridRef scene.
  if (files.size === 1) {
    const bytes = files.get(sourcePath)!
    const destination = join(resourceDir, `${hash(bytes)}${extname(sourcePath).toLowerCase()}`)
    await writeContent(destination, bytes)
    return destination
  }
  let common = dirname(sourcePath)
  for (const path of files.keys()) {
    while (!within(common, path)) {
      const parent = dirname(common)
      if (parent === common) throw new Error(`Model dependencies span filesystem roots: ${sourcePath}`)
      common = parent
    }
  }
  const entries = [...files].map(([path, bytes]) => ({ path: posix(relative(common, path)), bytes })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const digest = createHash('sha256')
  for (const entry of entries) digest.update(entry.path).update('\0').update(String(entry.bytes.length)).update('\0').update(entry.bytes)
  const bundleDir = join(resourceDir, digest.digest('hex'))
  for (const entry of entries) await writeContent(join(bundleDir, entry.path), entry.bytes)
  return join(bundleDir, relative(common, sourcePath))
}

async function persist(projectPath: string, data: string): Promise<HbrSaveResult> {
  const project: unknown = JSON.parse(data)
  if (!isRecord(project) || !Array.isArray(project.boards)) throw new Error('Cannot save project: boards must be an array.')
  const projectDir = dirname(projectPath)
  const resourceDir = join(projectDir, `${basename(projectPath, extname(projectPath))}Resource`)
  const references: { source: string; replace: (path: string) => void }[] = []
  const trackedSources: { source: string; meta: RecordValue }[] = []
  // Capture provenance before path rewriting. PDF previews track their original
  // document, while other items track src. Untracked items stay untracked.
  visitProjectItems(project, (item) => {
    const meta = item.meta
    if (!isRecord(meta) || !isRecord(meta.sourceFingerprint)) return
    if (!Number.isFinite(meta.sourceFingerprint.size) || !Number.isFinite(meta.sourceFingerprint.mtimeMs)) return
    const source = typeof meta.sourcePdf === 'string' ? meta.sourcePdf : item.src
    if (typeof source === 'string' && source) trackedSources.push({ source, meta })
  })
  visitProjectAssetPaths(project, (source, replace) => references.push({ source, replace }))
  const copied = new Map<string, string>()
  const assetReplacements: Record<string, string> = Object.create(null)
  const sourceFingerprints: Record<string, SourceFingerprint> = Object.create(null)
  for (const { source, replace } of references) {
    if (remote(source)) continue
    if (/^blob:/i.test(source)) throw new Error('A temporary blob URL cannot be saved. Import its contents before saving.')
    const key = /^data:/i.test(source) ? source : localPath(source, projectDir)
    const previous = copied.get(key)
    if (previous) { replace(previous); assetReplacements[source] = resolve(projectDir, previous); continue }
    let destination: string
    try {
      if (!/^data:/i.test(source) && MODEL_EXTENSIONS.has(extname(key).toLowerCase())) {
        destination = await copyModel(key, resourceDir)
      } else {
        let asset = /^data:/i.test(source)
          ? decodeData(source)
          : { bytes: await readFile(key), extension: extname(key).toLowerCase() || '.bin', image: IMAGE_EXTENSIONS.has(extname(key).toLowerCase()) }
        if (asset.image) asset = { ...asset, ...await normalizeImage(asset.bytes, asset.extension) }
        destination = join(resourceDir, `${hash(asset.bytes)}${asset.extension}`)
        await writeContent(destination, asset.bytes)
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Could not save resource ${/^data:/i.test(source) ? '(embedded data)' : source}: ${detail}`)
    }
    const portable = posix(relative(projectDir, destination))
    copied.set(key, portable)
    assetReplacements[source] = destination
    replace(portable)
  }
  for (const { source, meta } of trackedSources) {
    const target = assetReplacements[source]
    if (!target) continue
    const original = /^data:/i.test(source) ? source : localPath(source, projectDir)
    const samePath = process.platform === 'win32'
      ? original.toLowerCase() === target.toLowerCase()
      : original === target
    // Retain the baseline when the actual file did not move. In particular a
    // timestamp change outside HybridRef must remain visible in Sources.
    if (samePath) continue
    let fingerprint = sourceFingerprints[source]
    if (!fingerprint) {
      const info = await stat(target)
      fingerprint = { size: info.size, mtimeMs: info.mtimeMs }
      sourceFingerprints[source] = fingerprint
    }
    meta.sourceFingerprint = { ...fingerprint }
  }
  // Renderer-generated save timestamps should never obscure a layout diff.
  // Keep creation provenance, and supply the required legacy updatedAt on read.
  if (existsSync(projectPath)) {
    const previous = parseHbr(await readFile(projectPath, 'utf8'))
    if (typeof previous.createdAt === 'number') project.createdAt = previous.createdAt
  }
  if (typeof project.createdAt !== 'number') project.createdAt = 0
  delete project.updatedAt
  project.format = 'hybridref'
  project.formatVersion = 1
  const yaml = stringify(canonical(project), { indent: 2, lineWidth: 0, aliasDuplicateObjects: false, defaultKeyType: 'PLAIN', defaultStringType: 'QUOTE_DOUBLE' })
  await atomicWrite(projectPath, yaml)
  return { assetReplacements, sourceFingerprints }
}

export function isHbrProjectPath(path: string): boolean { return extname(path).toLowerCase() === '.hbr' }

/** Serialize saves to the same destination so autosave cannot finish after a newer manual save. */
export async function writeHbrProject(path: string, data: string): Promise<HbrSaveResult> {
  const destination = resolve(path)
  const previous = pendingWrites.get(destination) ?? Promise.resolve()
  const writing = previous.catch(() => undefined).then(() => persist(destination, data))
  pendingWrites.set(destination, writing)
  try { return await writing } finally { if (pendingWrites.get(destination) === writing) pendingWrites.delete(destination) }
}

/** Returns the existing Citadel JSON IPC payload with absolute renderer asset paths. */
export function readHbrProject(path: string): string {
  const project = parseHbr(readFileSync(path, 'utf8'))
  const projectDir = dirname(resolve(path))
  visitProjectAssetPaths(project, (source, replace) => {
    if (remote(source) || /^(data|blob):/i.test(source)) return
    replace(localPath(source, projectDir))
  })
  project.updatedAt = typeof project.createdAt === 'number' ? project.createdAt : 0
  return JSON.stringify(project)
}
