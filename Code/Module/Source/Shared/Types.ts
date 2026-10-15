export interface Viewport { x: number; y: number; zoom: number }
export interface BoardImage { id: string; asset: string; x: number; y: number; width: number; height: number }
export interface TextResource {
  format: 'hybridref-text'
  formatVersion: 1
  content: string
  font: { family: string; size: number; weight: 400 | 700; color: string; opacity: number }
  background: { color: string; opacity: number }
  paragraph: { align: 'left' | 'center' | 'right'; lineHeight: number }
  padding: number
}
export interface BoardText { id: string; x: number; y: number; width: number; height: number; text: TextResource }
export interface BoardDocument { format: 'hybridref'; formatVersion: 3; viewport: Viewport; images: BoardImage[]; texts: BoardText[] }
export interface ImageAsset { id: string; dataUrl: string; width: number; height: number; missing?: boolean }
export interface LoadedBoard { path: string; document: BoardDocument; assets: ImageAsset[]; missingResources?: string[] }
export interface CleanupResult extends LoadedBoard { removedFiles: number }
export interface ImportResult { assets: ImageAsset[]; errors: string[] }
export interface SaveResult { path: string }
export interface ProjectEntry { name: string; path: string }
export interface BrowseEntry { name: string; path: string; kind: 'directory' | 'file' }
export interface BrowseResult { path: string; parent: string | null; entries: BrowseEntry[]; roots: string[] }
export interface HybridRefApi {
  Startup(): Promise<LoadedBoard | null>
  NewProject(): Promise<LoadedBoard | null>
  ListProjects(): Promise<ProjectEntry[]>
  Open(Path: string): Promise<LoadedBoard>
  Save(Document: BoardDocument, Path: string | null): Promise<SaveResult | null>
  Cleanup(Document: BoardDocument, Path: string): Promise<CleanupResult>
  ImportBytes(Files: { name: string; bytes: Uint8Array }[]): Promise<ImportResult>
  MarkdownImage(Source: string, ProjectPath: string | null): Promise<ImageAsset>
  SetDirty(Dirty: boolean): void
}
export const TextFontFamily = 'SimHei'
export const EmptyTextResource = (Content = '文字'): TextResource => ({
  format: 'hybridref-text', formatVersion: 1, content: Content,
  font: { family: TextFontFamily, size: 24, weight: 400, color: '#FFFFFF', opacity: 1 },
  background: { color: '#202020', opacity: 0.8 },
  paragraph: { align: 'left', lineHeight: 1.5 }, padding: 12,
})
export const EmptyDocument = (): BoardDocument => ({ format: 'hybridref', formatVersion: 3, viewport: { x: 0, y: 0, zoom: 1 }, images: [], texts: [] })
