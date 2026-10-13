import React, { useEffect as UseEffect, useRef as UseRef, useState as UseState, useSyncExternalStore as UseSyncExternalStore } from 'react'
import type { BrowseResult } from '../Shared/Types'

interface FileRequest {
  mode: 'open' | 'save'
  initialPath?: string
  Browse(Path?: string): Promise<BrowseResult>
  Resolve(Path: string | null): void
}
let Request: FileRequest | null = null
const Listeners = new Set<() => void>()
const Notify = (): void => Listeners.forEach((Listener) => Listener())
const Subscribe = (Listener: () => void): (() => void) => { Listeners.add(Listener); return () => { Listeners.delete(Listener) } }
export const IsFileDialogOpen = (): boolean => Request !== null

export function RequestFilePath(Options: Omit<FileRequest, 'Resolve'>): Promise<string | null> {
  return new Promise((Resolve) => {
    Request?.Resolve(null)
    Request = { ...Options, Resolve }
    Notify()
  })
}
function Close(Path: string | null): void {
  const Active = Request
  Request = null
  Notify()
  Active?.Resolve(Path)
}
const IsBoardPath = (Path: string): boolean => /\.hbr$/i.test(Path.trim())
const ParentPath = (Path: string): string => Path.slice(0, Math.max(Path.lastIndexOf('/'), Path.lastIndexOf('\\')) + 1)
const FileName = (Path: string): string => Path.split(/[\\/]/).pop() || '未命名.hbr'
const JoinPath = (Directory: string, Name: string): string => `${Directory.replace(/[\\/]+$/, '')}/${Name}`

export default function FileDialog(): React.ReactElement | null {
  const Active = UseSyncExternalStore(Subscribe, () => Request)
  return Active ? <Dialog key={Active.mode + (Active.initialPath || '')} active={Active} /> : null
}

function Dialog({ active: Active }: { active: FileRequest }): React.ReactElement {
  const [Listing, SetListing] = UseState<BrowseResult | null>(null)
  const [Path, SetPath] = UseState('')
  const [Name, SetName] = UseState(Active.initialPath ? FileName(Active.initialPath) : '未命名.hbr')
  const [Selected, SetSelected] = UseState<string | null>(null)
  const [Loading, SetLoading] = UseState(true)
  const [CaughtError, SetError] = UseState('')
  const Revision = UseRef(0)
  const Panel = UseRef<HTMLDivElement>(null)
  const PathInput = UseRef<HTMLInputElement>(null)

  async function Browse(Directory?: string): Promise<void> {
    const Token = ++Revision.current
    SetLoading(true); SetError('')
    try {
      const Result = await Active.Browse(Directory)
      if (Token !== Revision.current) return
      SetListing(Result); SetPath(Result.path); SetSelected(null)
    } catch (Reason) { if (Token === Revision.current) SetError(Reason instanceof Error ? Reason.message : String(Reason)) }
    finally { if (Token === Revision.current) SetLoading(false) }
  }
  UseEffect(() => {
    const Previous = document.activeElement as HTMLElement | null
    void Browse(Active.initialPath ? ParentPath(Active.initialPath) : undefined).then(() => PathInput.current?.focus())
    return () => { Revision.current += 1; Previous?.focus() }
  }, [])

  function Confirm(): void {
    if (Loading) return
    const Typed = Path.trim()
    if (IsBoardPath(Typed)) { Close(Typed); return }
    if (Active.mode === 'open') {
      if (Selected) Close(Selected)
      else SetError('请选择一个 .hbr 文件，或输入完整文件路径。')
      return
    }
    const Filename = Name.trim()
    if (!Filename || /[\\/:*?"<>|]/.test(Filename)) { SetError('请输入有效的文件名。'); return }
    if (!Typed) { SetError('请选择保存文件夹。'); return }
    Close(JoinPath(Typed, IsBoardPath(Filename) ? Filename : `${Filename}.hbr`))
  }
  function KeyDown(InputEvent: React.KeyboardEvent): void {
    InputEvent.stopPropagation()
    if (InputEvent.key === 'Escape') { InputEvent.preventDefault(); Close(null) }
    if (InputEvent.key === 'Tab') {
      const Items = Array.from(Panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'))
      const First = Items[0], Last = Items[Items.length - 1]
      if (InputEvent.shiftKey && document.activeElement === First) { InputEvent.preventDefault(); Last?.focus() }
      else if (!InputEvent.shiftKey && document.activeElement === Last) { InputEvent.preventDefault(); First?.focus() }
    }
  }
  return <div className="file-dialog-overlay">
    <div ref={Panel} data-testid="file-dialog" className="file-dialog" role="dialog" aria-modal="true" aria-labelledby="file-dialog-title" onKeyDown={KeyDown}>
      <h2 id="file-dialog-title">{Active.mode === 'save' ? '保存画板' : '打开画板'}</h2>
      <div className="file-location">
        <button disabled={Loading || !Listing?.parent} onClick={() => void Browse(Listing!.parent!)} title="上级文件夹">↑</button>
        <input ref={PathInput} data-testid="file-path" aria-label="文件夹或完整文件路径" disabled={Loading} value={Path} onChange={(InputEvent) => { SetPath(InputEvent.target.value); SetSelected(null) }} onKeyDown={(InputEvent) => { if (InputEvent.key === 'Enter') { InputEvent.preventDefault(); IsBoardPath(Path) ? Confirm() : void Browse(Path) } }} />
        <button disabled={Loading} onClick={() => void Browse(IsBoardPath(Path) ? ParentPath(Path) : Path)}>前往</button>
      </div>
      <div className="file-roots">{Listing?.roots.map((Root) => <button key={Root} disabled={Loading} onClick={() => void Browse(Root)}>{Root}</button>)}</div>
      <div className="file-entries" aria-label="文件列表">
        {Listing?.entries.filter((Entry) => Entry.kind === 'directory' || IsBoardPath(Entry.name)).map((Entry) => <button key={Entry.path} className={Selected === Entry.path ? 'chosen' : ''} disabled={Loading}
          onClick={() => { if (Entry.kind === 'directory') void Browse(Entry.path); else { SetSelected(Entry.path); SetName(Entry.name) } }}
          onDoubleClick={() => { if (Entry.kind === 'file' && Active.mode === 'open') Close(Entry.path) }}>
          <span aria-hidden="true">{Entry.kind === 'directory' ? '▸' : '◇'}</span>{Entry.name}
        </button>)}
        {!Listing?.entries.some((Entry) => Entry.kind === 'directory' || IsBoardPath(Entry.name)) && !Loading && <p>此文件夹中没有画板</p>}
      </div>
      {Active.mode === 'save' && <label className="file-name">文件名<input data-testid="file-name" value={Name} onChange={(InputEvent) => SetName(InputEvent.target.value)} onKeyDown={(InputEvent) => { if (InputEvent.key === 'Enter') { InputEvent.preventDefault(); Confirm() } }} /></label>}
      <div className="file-dialog-status" role="status">{Loading ? '正在读取文件夹…' : CaughtError}</div>
      <div className="file-dialog-actions"><button data-testid="file-cancel" onClick={() => Close(null)}>取消</button><button data-testid="file-confirm" className="primary" disabled={Loading} onClick={Confirm}>{Active.mode === 'save' ? '保存' : '打开'}</button></div>
    </div>
  </div>
}
