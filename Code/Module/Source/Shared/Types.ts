export interface Viewport { x: number; y: number; zoom: number }
export interface BoardImage { id: string; asset: string; x: number; y: number; width: number; height: number }
export interface BoardDocument { format: 'hybridref'; formatVersion: 2; viewport: Viewport; images: BoardImage[] }
export interface ImageAsset { id: string; dataUrl: string; width: number; height: number }
export interface LoadedBoard { path: string; document: BoardDocument; assets: ImageAsset[] }
export interface ImportResult { assets: ImageAsset[]; errors: string[] }
export interface SaveResult { path: string }
export interface BrowseEntry { name: string; path: string; kind: 'directory' | 'file' }
export interface BrowseResult { path: string; parent: string | null; entries: BrowseEntry[]; roots: string[] }
export interface HybridRefApi {
  Startup(): Promise<LoadedBoard | null>
  NewProject(): Promise<void>
  Open(): Promise<LoadedBoard | null>
  Save(Document: BoardDocument, Path: string | null): Promise<SaveResult | null>
  ImportBytes(Files: { name: string; bytes: Uint8Array }[]): Promise<ImportResult>
  SetDirty(Dirty: boolean): void
}
export const EmptyDocument = (): BoardDocument => ({ format: 'hybridref', formatVersion: 2, viewport: { x: 0, y: 0, zoom: 1 }, images: [] })
