import React, { useRef as UseRef } from 'react'
import type { TextResource } from '../Shared/Types'
import { TextAlignmentIcon, TextBoldIcon } from './TextFormatIcons'

interface TextEditorProps {
  Resource: TextResource
  OnChange: (Resource: TextResource) => void
  OnApply: () => void
  OnSave: (SaveAs: boolean) => void
  OnCancel: () => void
  OnComposition: (Composing: boolean) => void
}

export function TextEditor({ Resource: Draft, OnChange: SetDraft, OnApply, OnSave, OnCancel, OnComposition }: TextEditorProps): React.ReactElement {
  const Composing = UseRef(false)
  const Opacity = Math.round(Draft.opacity * 100)

  function NumberChange(Value: string, Minimum: number, Maximum: number, Apply: (Value: number) => void): void {
    if (!Value.trim()) return
    const NumberValue = Number(Value)
    if (Number.isFinite(NumberValue) && NumberValue >= Minimum && NumberValue <= Maximum) Apply(NumberValue)
  }
  function KeyDown(InputEvent: React.KeyboardEvent): void {
    InputEvent.stopPropagation()
    const Modifier = InputEvent.ctrlKey || InputEvent.metaKey
    if (Modifier && InputEvent.key.toLowerCase() === 's') { InputEvent.preventDefault(); OnSave(InputEvent.shiftKey); return }
    if (InputEvent.nativeEvent.isComposing || Composing.current || InputEvent.keyCode === 229) return
    if (Modifier && InputEvent.key === 'Enter') { InputEvent.preventDefault(); OnApply(); return }
    if (InputEvent.key === 'Escape') { InputEvent.preventDefault(); OnCancel(); return }
  }
  return <div className="text-editor" data-testid="text-editor" role="region" aria-labelledby="text-editor-title" onKeyDown={KeyDown}
      onPointerDown={(InputEvent) => InputEvent.stopPropagation()} onDoubleClick={(InputEvent) => InputEvent.stopPropagation()}
      onCompositionStart={() => { Composing.current = true; OnComposition(true) }} onCompositionEnd={() => { Composing.current = false; OnComposition(false) }}>
      <div className="text-editor-heading"><h2 id="text-editor-title">字体设置</h2><button aria-label="取消编辑" onClick={OnCancel}>×</button></div>
      <div className="text-properties">
        <div className="text-property">字体<span className="text-font-name" data-testid="text-font-family">黑体</span></div>
        <label>字号<input data-testid="text-font-size" type="number" min={1} max={512} value={Draft.font.size} onChange={(InputEvent) => NumberChange(InputEvent.target.value, 1, 512, (Value) => SetDraft({ ...Draft, font: { ...Draft.font, size: Value } }))} /></label>
        <div className="text-format-row">
          <button type="button" className="text-toggle text-bold-toggle" data-testid="text-font-weight" aria-label="加粗" title="加粗" aria-pressed={Draft.font.weight === 700}
            onClick={() => SetDraft({ ...Draft, font: { ...Draft.font, weight: Draft.font.weight === 700 ? 400 : 700 } })}><TextBoldIcon /></button>
          <div className="text-align-buttons" data-testid="text-align" role="group" aria-label="文字对齐">
            {(['left', 'center', 'right'] as const).map((Align) => {
              const Label = { left: '左对齐', center: '居中', right: '右对齐' }[Align]
              return <button key={Align} type="button" className="text-toggle" data-testid={`text-align-${Align}`} aria-label={Label} title={Label} aria-pressed={Draft.paragraph.align === Align}
                onClick={() => SetDraft({ ...Draft, paragraph: { ...Draft.paragraph, align: Align } })}><TextAlignmentIcon Align={Align} /></button>
            })}
          </div>
        </div>
        <label>文字颜色<input data-testid="text-font-color" type="color" value={Draft.font.color} onChange={(InputEvent) => SetDraft({ ...Draft, font: { ...Draft.font, color: InputEvent.target.value } })} /></label>
        <label>背景颜色<input data-testid="text-background-color" type="color" value={Draft.background.color} onChange={(InputEvent) => SetDraft({ ...Draft, background: { ...Draft.background, color: InputEvent.target.value } })} /></label>
        <label className="text-opacity-control">不透明度
          <span className="text-opacity-slider">
            <input data-testid="text-opacity" type="range" min={0} max={100} step={1} value={Opacity} aria-valuetext={`${Opacity}%`}
              onChange={(InputEvent) => NumberChange(InputEvent.target.value, 0, 100, (Value) => SetDraft({ ...Draft, opacity: Value / 100 }))} />
            <span className="text-opacity-value" aria-hidden="true">{Opacity}%</span>
          </span>
        </label>
        <label>行高倍数<input data-testid="text-line-height" type="number" min={0.5} max={4} step={0.1} value={Draft.paragraph.lineHeight} onChange={(InputEvent) => NumberChange(InputEvent.target.value, 0.5, 4, (Value) => SetDraft({ ...Draft, paragraph: { ...Draft.paragraph, lineHeight: Value } }))} /></label>
        <label>内边距<input data-testid="text-padding" type="number" min={0} max={128} value={Draft.padding} onChange={(InputEvent) => NumberChange(InputEvent.target.value, 0, 128, (Value) => SetDraft({ ...Draft, padding: Value }))} /></label>
      </div>
      <div className="text-editor-actions"><button data-testid="text-cancel" onClick={OnCancel}>取消</button><button data-testid="text-apply" className="primary" onClick={() => OnApply()}>完成</button></div>
  </div>
}
