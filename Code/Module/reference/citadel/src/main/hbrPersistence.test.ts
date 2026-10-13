import { mkdtempSync, readFileSync, writeFileSync, readdirSync, mkdirSync, cpSync, rmSync, existsSync, statSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { encode as encodeBmp } from 'bmp-js'
import sharp from 'sharp'
import { parse } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isHbrProjectPath, readHbrProject, writeHbrProject } from './hbrPersistence'

const roots: string[] = []
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'hybridref-hbr-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function project(items: unknown[] = []): Record<string, any> {
  return {
    version: '1.0.0', createdAt: 123, updatedAt: 456, activeBoardId: 'board',
    boards: [{ id: 'board', name: '画板', items, connections: [], viewport: { x: 0, y: 0, scale: 1 } }], recordings: [],
  }
}
async function jpeg(path: string): Promise<void> {
  await sharp({ create: { width: 13, height: 9, channels: 3, background: '#25b7d3' } }).jpeg().toFile(path)
}

describe('HybridRef YAML persistence', () => {
  it('writes compressed PNGs beside a readable YAML scene, deduplicating identical originals and returning live replacements', async () => {
    const root = temp()
    const source = join(temp(), '参考.jpg')
    await jpeg(source)
    const duplicate = join(temp(), 'duplicate.jpeg')
    cpSync(source, duplicate)
    const path = join(root, '测试.hbr')
    const saved = await writeHbrProject(path, JSON.stringify(project([{ id: 'a', type: 'image', src: source }, { id: 'b', type: 'image', src: duplicate }])))
    const raw = readFileSync(path, 'utf8')
    expect(raw).toContain('format: "hybridref"')
    expect(raw).not.toContain('data:')
    expect(raw).not.toContain('updatedAt:')
    const yaml = parse(raw)
    const asset = yaml.boards[0].items[0].src
    expect(asset).toMatch(/^测试Resource\/[a-f0-9]{64}\.png$/)
    expect(yaml.boards[0].items[1].src).toBe(asset)
    expect(readdirSync(join(root, '测试Resource'))).toHaveLength(1)
    expect(await sharp(join(root, asset)).metadata()).toMatchObject({ format: 'png', width: 13, height: 9 })
    expect(saved.assetReplacements[source]).toBe(resolve(root, asset))
    expect(saved.assetReplacements[duplicate]).toBe(saved.assetReplacements[source])
  })

  it('produces identical YAML and resource names on repeated saves, including a save after reload', async () => {
    const root = temp()
    const source = join(root, 'input.jpg')
    await jpeg(source)
    const path = join(root, 'Test.hbr')
    const input = project([{ id: 'a', src: source, x: 10.125, y: 22 }])
    await writeHbrProject(path, JSON.stringify(input))
    const first = readFileSync(path, 'utf8')
    input.createdAt += 10
    input.updatedAt += 10
    await writeHbrProject(path, JSON.stringify(input))
    expect(readFileSync(path, 'utf8')).toBe(first)
    await writeHbrProject(path, readHbrProject(path))
    expect(readFileSync(path, 'utf8')).toBe(first)
    expect(readdirSync(join(root, 'TestResource'))).toHaveLength(1)
    const moved = JSON.parse(readHbrProject(path))
    moved.boards[0].items[0].x = 12.125
    await writeHbrProject(path, JSON.stringify(moved))
    expect(readFileSync(path, 'utf8')).toBe(first.replace('x: 10.125', 'x: 12.125'))
  })

  it('converts BMP pixels to opaque PNG without swapping the red and blue channels', async () => {
    const root = temp()
    const source = join(root, 'red.bmp')
    writeFileSync(source, encodeBmp({ width: 2, height: 1, data: Buffer.from([0, 0, 0, 255, 0, 0, 255, 0]) }).data)
    const path = join(root, 'Bitmap.hbr')
    await writeHbrProject(path, JSON.stringify(project([{ type: 'image', src: source }])))
    const destination = JSON.parse(readHbrProject(path)).boards[0].items[0].src as string
    expect(destination).toMatch(/\.png$/)
    expect(await sharp(destination).ensureAlpha().raw().toBuffer()).toEqual(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]))
  })

  it('rebases tracked PNG conversion provenance so Sources reports unchanged, including recording history', async () => {
    const root = temp()
    const source = join(root, 'tracked.jpg')
    await jpeg(source)
    const info = statSync(source)
    const baseline = { size: info.size, mtimeMs: info.mtimeMs }
    const tracked = { id: 'tracked', type: 'image', src: source, meta: { sourceFingerprint: baseline } }
    const data = project([tracked, { id: 'untracked', type: 'image', src: source }])
    data.recordings = [{ events: [{ before: { items: [tracked] }, after: tracked }] }]
    const path = join(root, 'Tracked.hbr')
    const saved = await writeHbrProject(path, JSON.stringify(data))
    const loaded = JSON.parse(readHbrProject(path))
    const target = loaded.boards[0].items[0].src as string
    const targetStat = statSync(target)
    const normalizedBaseline = { size: targetStat.size, mtimeMs: targetStat.mtimeMs }
    expect(saved.sourceFingerprints[source]).toEqual(normalizedBaseline)
    expect(loaded.boards[0].items[0].meta.sourceFingerprint).toEqual(normalizedBaseline)
    expect(loaded.boards[0].items[1].meta).toBeUndefined()
    expect(loaded.recordings[0].events[0].before.items[0].meta.sourceFingerprint).toEqual(normalizedBaseline)
    expect(loaded.recordings[0].events[0].after.meta.sourceFingerprint).toEqual(normalizedBaseline)
    const { buildSourceChangeIndex } = await vi.importActual<{
      buildSourceChangeIndex: (boards: unknown, probes: unknown) => { summary: { unchanged: number; changed: number } }
    }>('../renderer/assets/sourceProvenance')
    expect(buildSourceChangeIndex(loaded.boards, { [target]: { exists: true, ...normalizedBaseline } }).summary).toMatchObject({ unchanged: 1, changed: 0 })
    const first = readFileSync(path, 'utf8')
    await writeHbrProject(path, JSON.stringify(data))
    expect(readFileSync(path, 'utf8')).toBe(first)
    const secondSave = await writeHbrProject(path, readHbrProject(path))
    expect(secondSave.sourceFingerprints).toEqual({})
    expect(readFileSync(path, 'utf8')).toBe(first)
  })

  it('tracks the relocated source PDF rather than the preview and rebases again on Save As', async () => {
    const root = temp()
    const preview = join(root, 'preview.jpg')
    const pdf = join(root, 'paper.pdf')
    await jpeg(preview)
    writeFileSync(pdf, '%PDF-1.4 tracked original')
    const info = statSync(pdf)
    const input = project([{ id: 'page', type: 'image', src: preview, meta: { sourcePdf: pdf, sourceFingerprint: { size: info.size, mtimeMs: info.mtimeMs } } }])
    const path = join(root, 'Paper.hbr')
    const saved = await writeHbrProject(path, JSON.stringify(input))
    const loaded = JSON.parse(readHbrProject(path))
    const target = loaded.boards[0].items[0].meta.sourcePdf as string
    expect(saved.sourceFingerprints[pdf]).toEqual({ size: statSync(target).size, mtimeMs: statSync(target).mtimeMs })
    expect(saved.sourceFingerprints[preview]).toBeUndefined()
    expect(loaded.boards[0].items[0].meta.sourceFingerprint).toEqual(saved.sourceFingerprints[pdf])
    const copyPath = join(temp(), 'Copy.hbr')
    const copied = await writeHbrProject(copyPath, JSON.stringify(loaded))
    const newTarget = copied.assetReplacements[target]
    expect(copied.sourceFingerprints[target]).toEqual({ size: statSync(newTarget).size, mtimeMs: statSync(newTarget).mtimeMs })
    expect(JSON.parse(readHbrProject(copyPath)).boards[0].items[0].meta.sourceFingerprint).toEqual(copied.sourceFingerprints[target])
  })

  it('retains the baseline of a file already at its managed path so external changes stay visible', async () => {
    const root = temp()
    const source = join(root, 'original.jpg')
    await jpeg(source)
    const info = statSync(source)
    const path = join(root, 'External.hbr')
    await writeHbrProject(path, JSON.stringify(project([{ id: 'tracked', type: 'image', src: source, meta: { sourceFingerprint: { size: info.size, mtimeMs: info.mtimeMs } } }])))
    const first = readFileSync(path, 'utf8')
    const loaded = JSON.parse(readHbrProject(path))
    const target = loaded.boards[0].items[0].src as string
    const originalBaseline = loaded.boards[0].items[0].meta.sourceFingerprint
    const time = new Date(originalBaseline.mtimeMs + 60_000)
    utimesSync(target, time, time)
    const saved = await writeHbrProject(path, JSON.stringify(loaded))
    expect(saved.sourceFingerprints).toEqual({})
    expect(readFileSync(path, 'utf8')).toBe(first)
    const { buildSourceChangeIndex } = await vi.importActual<{
      buildSourceChangeIndex: (boards: unknown, probes: unknown) => { summary: { changed: number } }
    }>('../renderer/assets/sourceProvenance')
    expect(buildSourceChangeIndex(loaded.boards, { [target]: { exists: true, size: statSync(target).size, mtimeMs: statSync(target).mtimeMs } }).summary.changed).toBe(1)
  })

  it('keeps board, layer and event order plus extension fields and canonicalizes mapping key order', async () => {
    const root = temp()
    const path = join(root, 'Layers.hbr')
    const data = project([{ id: 'z', x: 1, meta: { zeta: 'last', alpha: 'first' } }, { id: 'a', zIndex: 0 }])
    data.pluginSettings = { schema: 2, note: 'A multiline\ncomment' }
    data.recordings = [{ id: 'recording', startedAt: 111, events: [{ id: 'z', timestamp: 1, before: null, after: null }, { id: 'a', timestamp: 2 }] }]
    await writeHbrProject(path, JSON.stringify(data))
    const first = readFileSync(path, 'utf8')
    data.boards[0].items[0].meta = { alpha: 'first', zeta: 'last' }
    await writeHbrProject(path, JSON.stringify(data))
    expect(readFileSync(path, 'utf8')).toBe(first)
    const loaded = JSON.parse(readHbrProject(path))
    expect(loaded.boards[0].items.map((item: { id: string }) => item.id)).toEqual(['z', 'a'])
    expect(loaded.recordings[0].events.map((event: { id: string }) => event.id)).toEqual(['z', 'a'])
    expect(loaded.pluginSettings).toEqual(data.pluginSettings)
  })

  it('externalizes pasted data and preserves comparison, PDF, transcript and recording references', async () => {
    const root = temp()
    const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#abcdef88' } }).png().toBuffer()
    const embedded = `data:image/png;base64,${png.toString('base64')}`
    const pdf = join(root, 'paper.pdf')
    const audio = join(root, 'voice.wav')
    writeFileSync(pdf, '%PDF-1.4')
    writeFileSync(audio, 'audio bytes')
    const data = project([{ id: 'comparison', meta: { srcA: embedded, srcB: embedded, content: 'data:not a path' } }, { src: embedded, meta: { sourcePdf: pdf } }, { src: audio, meta: { transcriptOf: audio } }])
    data.recordings = [{ events: [{ before: { items: [{ src: embedded }] }, after: { meta: { srcA: embedded, sourcePdf: pdf, transcriptOf: audio } } }] }]
    const path = join(root, 'All.hbr')
    await writeHbrProject(path, JSON.stringify(data))
    const loaded = JSON.parse(readHbrProject(path))
    const items = loaded.boards[0].items
    expect(items[0].meta.srcA).toBe(items[1].src)
    expect(items[0].meta.srcB).toBe(items[1].src)
    expect(items[0].meta.content).toBe('data:not a path')
    expect(items[2].meta.transcriptOf).toBe(items[2].src)
    expect(loaded.recordings[0].events[0].after).toMatchObject({ meta: { srcA: items[1].src, sourcePdf: items[1].meta.sourcePdf, transcriptOf: items[2].src } })
    expect(readdirSync(join(root, 'AllResource'))).toHaveLength(3)
  })

  it('moves with its Resource folder and Save As copies assets into the new project-specific folder', async () => {
    const root = temp()
    const source = join(temp(), 'photo.jpg')
    await jpeg(source)
    const path = join(root, 'Original.hbr')
    await writeHbrProject(path, JSON.stringify(project([{ src: source }])))
    const moved = temp()
    cpSync(path, join(moved, 'Original.hbr'))
    cpSync(join(root, 'OriginalResource'), join(moved, 'OriginalResource'), { recursive: true })
    const loaded = readHbrProject(join(moved, 'Original.hbr'))
    expect(JSON.parse(loaded).boards[0].items[0].src).toContain(join(moved, 'OriginalResource'))
    const other = temp()
    await writeHbrProject(join(other, 'Copy.hbr'), loaded)
    const copy = parse(readFileSync(join(other, 'Copy.hbr'), 'utf8'))
    expect(copy.boards[0].items[0].src).toMatch(/^CopyResource\//)
    expect(existsSync(join(other, copy.boards[0].items[0].src))).toBe(true)
  })

  it('imports file URLs and local URLs as actual local files while retaining network links', async () => {
    const root = temp()
    const source = join(root, 'sp ace 中文.jpg')
    await jpeg(source)
    const path = join(root, 'URLs.hbr')
    await writeHbrProject(path, JSON.stringify(project([
      { src: pathToFileURL(source).href }, { src: `local:///${source.replace(/\\/g, '/')}` },
      { src: 'https://www.youtube.com/watch?v=123', type: 'youtube' },
    ])))
    const loaded = JSON.parse(readHbrProject(path))
    expect(loaded.boards[0].items[0].src).toBe(loaded.boards[0].items[1].src)
    expect(loaded.boards[0].items[2].src).toBe('https://www.youtube.com/watch?v=123')
  })

  it('preserves animated GIF and video bytes without flattening or recompressing them', async () => {
    const root = temp()
    const frames = Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255])
    const gif = await sharp(frames, { raw: { width: 2, height: 2, channels: 4, pageHeight: 1 } }).gif({ loop: 0, delay: [100, 200] }).toBuffer()
    expect(await sharp(gif, { animated: true }).metadata()).toMatchObject({ pages: 2, delay: [100, 200] })
    const gifPath = join(root, 'animation.gif')
    const video = join(root, 'clip.mp4')
    writeFileSync(gifPath, gif)
    writeFileSync(video, 'video original bytes')
    const path = join(root, 'Media.hbr')
    await writeHbrProject(path, JSON.stringify(project([{ type: 'gif', src: gifPath }, { type: 'video', src: video }])))
    const loaded = JSON.parse(readHbrProject(path))
    expect(loaded.boards[0].items[0].src).toMatch(/\.gif$/)
    expect(readFileSync(loaded.boards[0].items[0].src)).toEqual(gif)
    expect(readFileSync(loaded.boards[0].items[1].src, 'utf8')).toBe('video original bytes')
  })

  it('preserves animated WebP frames rather than silently exporting the first frame', async () => {
    const root = temp()
    const frames = Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255])
    const webp = await sharp(frames, { raw: { width: 2, height: 2, channels: 4, pageHeight: 1 } }).webp({ lossless: true, loop: 0, delay: [100, 200] }).toBuffer()
    expect(await sharp(webp, { animated: true }).metadata()).toMatchObject({ pages: 2, delay: [100, 200] })
    const source = join(root, 'animated.webp')
    writeFileSync(source, webp)
    const path = join(root, 'Animation.hbr')
    await writeHbrProject(path, JSON.stringify(project([{ type: 'image', src: source }])))
    const destination = JSON.parse(readHbrProject(path)).boards[0].items[0].src as string
    expect(destination).toMatch(/\.webp$/)
    expect(readFileSync(destination)).toEqual(webp)
  })

  it('bundles GLTF buffers and textures with parent-relative references and stable resaves', async () => {
    const sourceRoot = temp()
    mkdirSync(join(sourceRoot, 'models'))
    mkdirSync(join(sourceRoot, 'textures'))
    const model = join(sourceRoot, 'models', 'figure.gltf')
    writeFileSync(model, JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'figure.bin' }], images: [{ uri: '../textures/skin.png' }] }))
    writeFileSync(join(sourceRoot, 'models', 'figure.bin'), 'vertices')
    writeFileSync(join(sourceRoot, 'textures', 'skin.png'), 'texture original bytes')
    const root = temp()
    const path = join(root, 'Model.hbr')
    await writeHbrProject(path, JSON.stringify(project([{ type: 'model3d', src: model }])))
    const raw = readFileSync(path, 'utf8')
    const loaded = JSON.parse(readHbrProject(path))
    const destination = loaded.boards[0].items[0].src as string
    expect(destination).toMatch(/[a-f0-9]{64}[\\/]models[\\/]figure\.gltf$/)
    expect(readFileSync(resolve(destination, '..', 'figure.bin'), 'utf8')).toBe('vertices')
    expect(readFileSync(resolve(destination, '..', '..', 'textures', 'skin.png'), 'utf8')).toBe('texture original bytes')
    await writeHbrProject(path, JSON.stringify(loaded))
    expect(readFileSync(path, 'utf8')).toBe(raw)
  })

  it('keeps self-contained models as a single hashed resource across reload and save', async () => {
    const root = temp()
    const source = join(root, 'triangle.obj')
    writeFileSync(source, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')
    const path = join(root, 'Single.hbr')
    await writeHbrProject(path, JSON.stringify(project([{ type: 'model3d', src: source }])))
    const first = readFileSync(path, 'utf8')
    const stored = parse(first).boards[0].items[0].src as string
    expect(stored).toMatch(/^SingleResource\/[a-f0-9]{64}\.obj$/)
    await writeHbrProject(path, readHbrProject(path))
    expect(readFileSync(path, 'utf8')).toBe(first)
    expect(readdirSync(join(root, 'SingleResource'))).toEqual([stored.split('/')[1]])
  })

  it('bundles OBJ materials and texture names containing spaces without copying unrelated files', async () => {
    const sourceRoot = temp()
    const model = join(sourceRoot, 'mesh.obj')
    writeFileSync(model, 'mtllib paint.mtl\nv 0 0 0\n')
    writeFileSync(join(sourceRoot, 'paint.mtl'), 'newmtl paint\nmap_Kd -s 1 1 1 skin color.jpg\n')
    writeFileSync(join(sourceRoot, 'skin color.jpg'), 'original texture')
    writeFileSync(join(sourceRoot, 'private.txt'), 'not a dependency')
    const root = temp()
    const path = join(root, 'Mesh.hbr')
    await writeHbrProject(path, JSON.stringify(project([{ type: 'model3d', src: model }])))
    const destination = JSON.parse(readHbrProject(path)).boards[0].items[0].src as string
    expect(readdirSync(resolve(destination, '..')).sort()).toEqual(['mesh.obj', 'paint.mtl', 'skin color.jpg'])
  })

  it('keeps the last good YAML on a missing asset or transient blob, and allows recovery on the next save', async () => {
    const root = temp()
    const path = join(root, 'Safe.hbr')
    await writeHbrProject(path, JSON.stringify(project()))
    const first = readFileSync(path, 'utf8')
    await expect(writeHbrProject(path, JSON.stringify(project([{ src: join(root, 'missing.png') }])))).rejects.toThrow('Could not save resource')
    expect(readFileSync(path, 'utf8')).toBe(first)
    await expect(writeHbrProject(path, JSON.stringify(project([{ src: 'blob:ephemeral' }])))).rejects.toThrow('temporary blob')
    expect(readFileSync(path, 'utf8')).toBe(first)
    await writeHbrProject(path, JSON.stringify(project([{ id: 'recovered' }])))
    expect(JSON.parse(readHbrProject(path)).boards[0].items[0].id).toBe('recovered')
    expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('serializes simultaneous saves so the latest request wins', async () => {
    const root = temp()
    const path = join(root, 'Concurrent.hbr')
    await Promise.all([writeHbrProject(path, JSON.stringify(project([{ id: 'first' }]))), writeHbrProject(path, JSON.stringify(project([{ id: 'last' }])))])
    expect(JSON.parse(readHbrProject(path)).boards[0].items[0].id).toBe('last')
  })

  it('rejects unsupported schemas and ambiguous YAML keys', () => {
    const root = temp()
    const path = join(root, 'Invalid.hbr')
    writeFileSync(path, 'format: hybridref\nformatVersion: 2\nboards: []\n')
    expect(() => readHbrProject(path)).toThrow('Unsupported HybridRef')
    writeFileSync(path, 'format: hybridref\nformatVersion: 1\nboards: []\nboards: []\n')
    expect(() => readHbrProject(path)).toThrow('Invalid HybridRef YAML')
    expect(isHbrProjectPath('测试.HBR')).toBe(true)
    expect(isHbrProjectPath('测试.hbr.backup')).toBe(false)
  })
})
