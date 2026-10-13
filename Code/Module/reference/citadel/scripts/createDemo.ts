import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { CanvasItem, ProjectFile } from '../src/types'
import { writeHbrProject } from '../src/main/hbrPersistence'

const root = resolve(__dirname, '../../..')
const destination = resolve(root, 'Projects/Demo/Demo.hbr')
if (existsSync(destination) && !process.argv.includes('--force')) {
  throw new Error('Demo already exists. Use --force only to replace the demo deliberately.')
}

const artwork = (variant: number): string => {
  const colors = [['#183446', '#84b8b0', '#efb585'], ['#3a253c', '#cf8292', '#e9bf80'], ['#1b3030', '#97bb91', '#e0d9b0']][variant]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">
    <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs>
    <rect width="960" height="640" fill="url(#sky)"/>
    <circle cx="${690 - variant * 115}" cy="190" r="78" fill="${colors[2]}"/>
    <path d="M0 470L220 160L460 465L665 260L960 470V640H0Z" fill="${colors[0]}" opacity=".85"/>
    <path d="M0 520Q250 400 480 525T960 480V640H0Z" fill="${colors[0]}"/>
    <path d="M0 585Q260 510 560 580T960 565" fill="none" stroke="${colors[1]}" stroke-width="3"/>
    <rect x="35" y="35" width="890" height="570" fill="none" stroke="${colors[2]}" opacity=".35"/>
  </svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}
const item = (id: string, type: CanvasItem['type'], x: number, y: number, width: number, height: number, patch: Partial<CanvasItem> = {}): CanvasItem => ({
  id, type, x, y, width, height, rotation: 0, zIndex: 0, locked: false, visible: true, opacity: 1, tags: [], ...patch,
})
const art = [artwork(0), artwork(1), artwork(2)]
const upstream = JSON.parse(readFileSync(resolve(root, 'Code/Resource/examples/showcase.citadel'), 'utf8')) as ProjectFile
const demo: ProjectFile = {
  version: '1.0.0', createdAt: 1791763200000, updatedAt: 1791763200000, activeBoardId: 'hybridref-demo', recordings: [],
  boards: [{
    id: 'hybridref-demo', name: 'HybridRef Demo', viewport: { x: 120, y: 105, scale: 0.85 },
    items: [
      item('demo-title', 'text', 0, 0, 1000, 60, { meta: { content: 'HybridRef / Reference study', fontSize: 36, fontStyle: 'bold' } }),
      item('demo-subtitle', 'text', 0, 65, 1000, 45, { meta: { content: '移动图片、对齐、保存，然后查看 Demo.hbr 的文本变更。', fontSize: 18, color: '#aab3bf' } }),
      ...art.map((src, index) => item(`demo-image-${index + 1}`, 'image', index * 355, 135, 330, 220, { src, zIndex: index + 1, tags: ['reference', ['cool', 'warm', 'earth'][index]], meta: { filename: `Reference ${index + 1}` } })),
      item('demo-note', 'sticky', 0, 390, 330, 235, { meta: { content: '试一下\n\nCtrl+V 粘贴截图\nShift+单击 多选\n右键菜单 对齐 / 排列\nDelete 删除 · Ctrl+Z 撤销\nCtrl+S 保存 YAML 与资源\nCtrl+Shift+S 另存为', color: '#25313a', fontSize: 17 } }),
      item('demo-compare', 'comparison', 355, 390, 330, 220, { meta: { srcA: art[0], srcB: art[1], splitX: 0.5 } }),
      item('demo-code', 'code', 710, 390, 330, 235, { meta: { language: 'yaml', code: 'format: hybridref\nformatVersion: 1\n# Demo.hbr + DemoResource/\n# 静态图片 → PNG\n# 稳定 ID · 相对路径\n# 画布布局可直接 diff' } }),
    ], connections: [],
  }, ...upstream.boards.map(board => ({ ...board, name: `Citadel · ${board.name}` }))],
}
void writeHbrProject(destination, JSON.stringify(demo)).then(() => {
console.log(`Created ${destination} (${demo.boards.length} boards)`)

}).catch((error) => { console.error(error); process.exitCode = 1 })
