// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runClipboardMenuAction } from './menuClipboard'

const invoke = vi.fn(async () => ({ ok: true }))
const canvasAction = vi.fn()

beforeEach(() => {
  Object.assign(window, { ipc: { invoke } })
  invoke.mockClear()
  canvasAction.mockClear()
})
afterEach(() => { document.body.innerHTML = '' })

describe('native clipboard menu focus routing', () => {
  it.each(['copy', 'cut', 'paste'] as const)('keeps %s in a focused input', (action) => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    runClipboardMenuAction(action, canvasAction)
    expect(invoke).toHaveBeenCalledWith('clipboard:editText', { action })
    expect(canvasAction).not.toHaveBeenCalled()
  })

  it.each(['textarea', 'contenteditable'])('keeps paste in a focused %s', (kind) => {
    const element = document.createElement(kind === 'textarea' ? 'textarea' : 'div')
    if (kind === 'contenteditable') {
      element.setAttribute('contenteditable', 'true')
      element.tabIndex = 0
    }
    document.body.appendChild(element)
    element.focus()
    runClipboardMenuAction('paste', canvasAction)
    expect(invoke).toHaveBeenCalledWith('clipboard:editText', { action: 'paste' })
    expect(canvasAction).not.toHaveBeenCalled()
  })

  it('keeps paste on the canvas when a non-text control has focus', () => {
    const range = document.createElement('input')
    range.type = 'range'
    document.body.appendChild(range)
    range.focus()
    runClipboardMenuAction('paste', canvasAction)
    expect(canvasAction).toHaveBeenCalledOnce()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('keeps paste on the canvas when no editor is focused', () => {
    runClipboardMenuAction('paste', canvasAction)
    expect(canvasAction).toHaveBeenCalledOnce()
    expect(invoke).not.toHaveBeenCalled()
  })
})
