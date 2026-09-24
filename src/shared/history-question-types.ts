export interface HistoryQuestionSourceRef { kind: 'computer' | 'browser'; id: string }
export type HistoryQuestionIntent = 'question' | 'summary' | 'skill' | 'plan'
export interface HistoryQuestionInput {
  sessionId: string
  sources: HistoryQuestionSourceRef[]
  intent: HistoryQuestionIntent
  question?: string
  language: 'zh' | 'en'
}
export interface HistoryQuestionTaskBinding {
  id: string
  createdAt: number
  cwd: string
  projectId?: string
  workspaceId?: string
  goalId?: string
  workItemId?: string
}
export interface HistoryQuestionPreview {
  id: string
  sessionId: string
  taskTitle: string
  binding: HistoryQuestionTaskBinding
  text: string
  sourceCount: number
  sourcesDigest: string
  expiresAt: number
}
export interface HistoryQuestionDelivery {
  deliveryId: string
  sessionId: string
  binding: HistoryQuestionTaskBinding
  text: string
}
export interface HistoryQuestionApi {
  previewHistoryQuestion(input: HistoryQuestionInput): Promise<HistoryQuestionPreview>
  deliverHistoryQuestion(input: { previewId: string; sessionId: string }): Promise<HistoryQuestionDelivery>
}
