import React, { useEffect as UseEffect, useRef as UseRef } from 'react'

interface TextInlineInputProps {
  Content: string
  OnChange: (Content: string) => void
  OnApply: () => void
  OnCancel: () => void
  OnSave: (SaveAs: boolean) => void
  OnComposition: (Composing: boolean) => void
}

/** Keep a native textarea mounted throughout style changes so its selection and undo stack survive. */
export function TextInlineInput({ Content, OnChange, OnApply, OnCancel, OnSave, OnComposition }: TextInlineInputProps): React.ReactElement {
  const Input = UseRef<HTMLTextAreaElement>(null)
  const InitialContent = UseRef(Content)
  const Composing = UseRef(false)
  UseEffect(() => { Input.current?.focus(); Input.current?.select() }, [])
  function KeyDown(InputEvent: React.KeyboardEvent): void {
    InputEvent.stopPropagation()
    const Modifier = InputEvent.ctrlKey || InputEvent.metaKey
    if (Modifier && InputEvent.key.toLowerCase() === 's') { InputEvent.preventDefault(); OnSave(InputEvent.shiftKey); return }
    if (Composing.current || InputEvent.nativeEvent.isComposing || InputEvent.keyCode === 229) return
    if (Modifier && InputEvent.key === 'Enter') { InputEvent.preventDefault(); OnApply(); return }
    if (InputEvent.key === 'Escape') { InputEvent.preventDefault(); OnCancel() }
  }
  return <textarea ref={Input} data-testid="text-content" className="text-inline-input" aria-label="Markdown 文本源码" defaultValue={InitialContent.current} spellCheck={false}
    onChange={(InputEvent) => OnChange(InputEvent.target.value)} onKeyDown={KeyDown}
    onPointerDown={(InputEvent) => InputEvent.stopPropagation()} onDoubleClick={(InputEvent) => InputEvent.stopPropagation()} onContextMenu={(InputEvent) => InputEvent.stopPropagation()}
    onCompositionStart={() => { Composing.current = true; OnComposition(true) }}
    onCompositionEnd={(InputEvent) => { OnChange(InputEvent.currentTarget.value); Composing.current = false; OnComposition(false) }} />
}
