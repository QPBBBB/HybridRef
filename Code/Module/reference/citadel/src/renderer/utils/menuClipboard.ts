export type ClipboardEditAction = 'copy' | 'cut' | 'paste'

const textInputTypes = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number'])

export function hasFocusedTextEditor(): boolean {
  let focused = document.activeElement
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement
  if (!(focused instanceof HTMLElement)) return false
  if (focused instanceof HTMLTextAreaElement) return true
  if (focused instanceof HTMLInputElement) return textInputTypes.has(focused.type)
  if (focused.isContentEditable) return true
  const editable = focused.closest('[contenteditable]')?.getAttribute('contenteditable')?.toLowerCase()
  return editable === '' || editable === 'true' || editable === 'plaintext-only'
}

/** Native accelerators arrive before DOM keydown. Keep editing inside the focused field. */
export function runClipboardMenuAction(action: ClipboardEditAction, canvasAction: () => void): void {
  if (!hasFocusedTextEditor()) {
    canvasAction()
    return
  }
  void window.ipc.invoke('clipboard:editText', { action }).catch(console.error)
}
