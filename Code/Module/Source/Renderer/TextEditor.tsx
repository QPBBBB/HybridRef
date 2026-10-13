import React, { useEffect as UseEffect, useRef as UseRef, useState as UseState } from 'react'
import type { TextResource } from '../Shared/Types'

interface TextEditorProps {
  Resource: TextResource
  OnApply: (Resource: TextResource) => void
  OnSave: (Resource: TextResource, SaveAs: boolean) => void
  OnCancel: () => void
  OnDirty: (Dirty: boolean) => void
}

export function TextColor(Color: string, Opacity: number): string {
  const Channels = [1, 3, 5].map((Index) => parseInt(Color.slice(Index, Index + 2), 16))
  return `rgba(${Channels.join(', ')}, ${Opacity})`
}

export function TextEditor({ Resource, OnApply, OnSave, OnCancel, OnDirty }: TextEditorProps): React.ReactElement {
  const [Draft, SetDraft] = UseState(() => structuredClone(Resource))
  const Panel = UseRef<HTMLDivElement>(null)
  const Content = UseRef<HTMLTextAreaElement>(null)
  const Composing = UseRef(false)
  UseEffect(() => { Content.current?.focus(); Content.current?.select() }, [])
  UseEffect(() => { OnDirty(JSON.stringify(Draft) !== JSON.stringify(Resource)) }, [Draft, Resource])

  function NumberChange(Value: string, Minimum: number, Maximum: number, Apply: (Value: number) => void): void {
    if (!Value.trim()) return
    const NumberValue = Number(Value)
    if (Number.isFinite(NumberValue) && NumberValue >= Minimum && NumberValue <= Maximum) Apply(NumberValue)
  }
  function KeyDown(InputEvent: React.KeyboardEvent): void {
    InputEvent.stopPropagation()
    const Modifier = InputEvent.ctrlKey || InputEvent.metaKey
    if (Modifier && InputEvent.key.toLowerCase() === 's') InputEvent.preventDefault()
    if (InputEvent.nativeEvent.isComposing || Composing.current || InputEvent.keyCode === 229) return
    if (Modifier && InputEvent.key.toLowerCase() === 's') { InputEvent.preventDefault(); OnSave(Draft, InputEvent.shiftKey); return }
    if (Modifier && InputEvent.key === 'Enter') { InputEvent.preventDefault(); OnApply(Draft); return }
    if (InputEvent.key === 'Escape') { InputEvent.preventDefault(); OnCancel(); return }
    if (InputEvent.key === 'Tab') {
      const Controls = Array.from(Panel.current!.querySelectorAll<HTMLElement>('button, textarea, input, select'))
      const Index = Controls.indexOf(document.activeElement as HTMLElement)
      if (InputEvent.shiftKey && Index === 0) { InputEvent.preventDefault(); Controls.at(-1)?.focus() }
      else if (!InputEvent.shiftKey && Index === Controls.length - 1) { InputEvent.preventDefault(); Controls[0]?.focus() }
    }
  }
  return <div className="text-editor-overlay">
    <div ref={Panel} className="text-editor" data-testid="text-editor" role="dialog" aria-modal="true" aria-labelledby="text-editor-title" onKeyDown={KeyDown}
      onCompositionStart={() => { Composing.current = true }} onCompositionEnd={() => { Composing.current = false }}>
      <div className="text-editor-heading"><h2 id="text-editor-title">编辑文本</h2><button aria-label="取消编辑" onClick={OnCancel}>×</button></div>
      <label className="text-content-label">内容<textarea ref={Content} data-testid="text-content" value={Draft.content} spellCheck={false} onChange={(InputEvent) => SetDraft({ ...Draft, content: InputEvent.target.value })} /></label>
      <div className="text-properties">
        <label className="text-font-family">字体<input data-testid="text-font-family" value={Draft.font.family} maxLength={256} placeholder="Microsoft YaHei" onChange={(InputEvent) => SetDraft({ ...Draft, font: { ...Draft.font, family: InputEvent.target.value || 'Microsoft YaHei' } })} /></label>
        <label>字号<input data-testid="text-font-size" type="number" min={1} max={512} value={Draft.font.size} onChange={(InputEvent) => NumberChange(InputEvent.target.value, 1, 512, (Value) => SetDraft({ ...Draft, font: { ...Draft.font, size: Value } }))} /></label>
        <label>字重<select data-testid="text-font-weight" value={Draft.font.weight} onChange={(InputEvent) => SetDraft({ ...Draft, font: { ...Draft.font, weight: Number(InputEvent.target.value) as 400 | 700 } })}><option value={400}>常规</option><option value={700}>粗体</option></select></label>
        <label>文字颜色<input data-testid="text-font-color" type="color" value={Draft.font.color} onChange={(InputEvent) => SetDraft({ ...Draft, font: { ...Draft.font, color: InputEvent.target.value } })} /></label>
        <label>文字不透明度 %<input data-testid="text-font-opacity" type="number" min={0} max={100} step={1} value={Math.round(Draft.font.opacity * 100)} onChange={(InputEvent) => NumberChange(InputEvent.target.value, 0, 100, (Value) => SetDraft({ ...Draft, font: { ...Draft.font, opacity: Value / 100 } }))} /></label>
        <label>背景颜色<input data-testid="text-background-color" type="color" value={Draft.background.color} onChange={(InputEvent) => SetDraft({ ...Draft, background: { ...Draft.background, color: InputEvent.target.value } })} /></label>
        <label>背景不透明度 %<input data-testid="text-background-opacity" type="number" min={0} max={100} step={1} value={Math.round(Draft.background.opacity * 100)} onChange={(InputEvent) => NumberChange(InputEvent.target.value, 0, 100, (Value) => SetDraft({ ...Draft, background: { ...Draft.background, opacity: Value / 100 } }))} /></label>
        <label>对齐<select data-testid="text-align" value={Draft.paragraph.align} onChange={(InputEvent) => SetDraft({ ...Draft, paragraph: { ...Draft.paragraph, align: InputEvent.target.value as TextResource['paragraph']['align'] } })}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
        <label>行高倍数<input data-testid="text-line-height" type="number" min={0.5} max={4} step={0.1} value={Draft.paragraph.lineHeight} onChange={(InputEvent) => NumberChange(InputEvent.target.value, 0.5, 4, (Value) => SetDraft({ ...Draft, paragraph: { ...Draft.paragraph, lineHeight: Value } }))} /></label>
        <label>内边距<input data-testid="text-padding" type="number" min={0} max={128} value={Draft.padding} onChange={(InputEvent) => NumberChange(InputEvent.target.value, 0, 128, (Value) => SetDraft({ ...Draft, padding: Value }))} /></label>
      </div>
      <p className="text-editor-help">Enter 换行 · Ctrl+Enter 完成 · Ctrl+S 应用并保存<br />拖动角点调整文本框并自动换行，字号保持不变。</p>
      <div className="text-editor-actions"><button data-testid="text-cancel" onClick={OnCancel}>取消</button><button data-testid="text-apply" className="primary" onClick={() => OnApply(Draft)}>完成</button></div>
    </div>
  </div>
}
