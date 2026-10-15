import React from 'react'
import type { ArrowStyle } from '../Shared/Types'

export function ArrowEditor({ Style, OnChange, OnApply, OnCancel, OnSave }: {
  Style: ArrowStyle; OnChange: (Style: ArrowStyle) => void; OnApply: () => void; OnCancel: () => void; OnSave: (SaveAs: boolean) => void
}): React.ReactElement {
  return <div className="text-editor arrow-editor" data-testid="arrow-editor" role="region" aria-labelledby="arrow-editor-title"
    onPointerDown={(InputEvent) => InputEvent.stopPropagation()} onDoubleClick={(InputEvent) => InputEvent.stopPropagation()}
    onKeyDown={(InputEvent) => {
      InputEvent.stopPropagation()
      if (InputEvent.nativeEvent.isComposing || InputEvent.keyCode === 229) return
      if (InputEvent.key === 'Escape') { InputEvent.preventDefault(); OnCancel() }
      else if (InputEvent.ctrlKey || InputEvent.metaKey) {
        if (InputEvent.key === 'Enter') { InputEvent.preventDefault(); OnApply() }
        if (InputEvent.key.toLowerCase() === 's') { InputEvent.preventDefault(); OnSave(InputEvent.shiftKey) }
      }
    }}>
    <div className="text-editor-heading"><h2 id="arrow-editor-title">线条设置</h2><button aria-label="取消线条编辑" onClick={OnCancel}>×</button></div>
    <div className="text-properties">
      <label>颜色<input data-testid="arrow-color" type="color" value={Style.color} onChange={(InputEvent) => OnChange({ ...Style, color: InputEvent.target.value })} /></label>
      <label>线宽<input data-testid="arrow-thickness" type="number" min={1} max={24} value={Style.thickness} onChange={(InputEvent) => {
        const Value = Number(InputEvent.target.value)
        if (Value >= 1 && Value <= 24) OnChange({ ...Style, thickness: Value })
      }} /></label>
      <div className="arrow-line-options" role="group" aria-label="线型">
        {([false, true] as const).map((Dashed) => <button key={String(Dashed)} className="text-toggle" data-testid={Dashed ? 'arrow-dashed' : 'arrow-solid'} aria-label={Dashed ? '虚线' : '实线'} title={Dashed ? '虚线' : '实线'} aria-pressed={Style.dashed === Dashed} onClick={() => OnChange({ ...Style, dashed: Dashed })}>
          <svg width="64" height="20" aria-hidden="true"><path d="M 4 10 H 60" stroke="currentColor" strokeWidth="2" strokeDasharray={Dashed ? '8 6' : undefined} /></svg>
        </button>)}
      </div>
    </div>
    <div className="text-editor-actions"><button data-testid="arrow-cancel" onClick={OnCancel}>取消</button><button data-testid="arrow-apply" className="primary" onClick={OnApply}>完成</button></div>
  </div>
}
