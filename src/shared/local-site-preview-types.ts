export interface LocalSitePreview {
  id: string
  sessionId: string
  sourcePath: string
  kind: 'html' | 'directory'
  entryPath: string
  localUrl: string
  fileCount: number
  bytes: number
  manifestDigest: string
  createdAt: number
  expiresAt: number
}
export interface LocalSitePreviewApi {
  startLocalSitePreview(sessionId: string, path: string, expectedTaskKey?: string): Promise<LocalSitePreview>
  getLocalSitePreview(sessionId: string): Promise<LocalSitePreview | null>
  stopLocalSitePreview(sessionId: string, previewId?: string): Promise<void>
}
