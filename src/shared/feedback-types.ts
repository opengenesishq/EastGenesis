export interface FeedbackAppInfo {
  name: 'EastGenesis'
  version: string
  platform: string
  architecture: string
  build: 'packaged' | 'development'
  electron: string
  chromium: string
  node: string
}

export interface FeedbackPreviewInput {
  description: string
  includeTaskSummary: boolean
  includeErrorSummary: boolean
  sessionId?: string
}

export interface FeedbackPreview {
  previewId: string
  generatedAt: number
  expiresAt: number
  json: string
}

export type FeedbackExportResult = { canceled: true } | { canceled: false; filePath: string }

export interface FeedbackApi {
  getFeedbackAppInfo(): Promise<FeedbackAppInfo>
  previewFeedback(input: FeedbackPreviewInput): Promise<FeedbackPreview>
  exportFeedback(previewId: string): Promise<FeedbackExportResult>
}
