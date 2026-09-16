import type { TaskExecutionAuthorityWriteTool } from './task-execution-authority-types'

export interface StudioResultRerunInput { planDigest: string; workItemId: string }
export interface StudioResultRerunConfirmInput extends StudioResultRerunInput { previewDigest: string }
export interface StudioResultRerunFile {
  artifactId: string
  title: string
  path: string
  digest: string
}
export interface StudioResultRerunOutput extends StudioResultRerunFile { outputPath: string; relativeOutputPath: string }
export interface StudioResultRerunPreview {
  schemaVersion: 1
  sessionId: string
  projectId: string
  goalId: string
  sourceWorkItemId: string
  sourceWorkItemRevision: number
  planDigest: string
  previewDigest: string
  repairWorkItemId: string
  title: string
  objective: string
  constraints: string[]
  criteria: string[]
  cwd: string
  outputs: StudioResultRerunOutput[]
  protectedFiles: StudioResultRerunFile[]
  allowedWriteTools: TaskExecutionAuthorityWriteTool[]
  authority: { status: 'legacy' | 'granted' | 'revoked'; revision: number; bindingDigest: string }
  acceptances: { id: string; revision: number; status: string }[]
  providerId: string
  model: string
  budgetUsd: number
  state: 'ready' | 'blocked'
  blockedReasons: string[]
}
export interface StudioResultRerunResult {
  repairWorkItemId: string
  sessionId?: string
  state: 'started' | 'existing' | 'awaiting_authorization' | 'needs_reconciliation' | 'blocked'
  reason?: string
}
export interface StudioResultRerunApi {
  previewStudioResultRerun(sessionId: string, input: StudioResultRerunInput): Promise<StudioResultRerunPreview>
  confirmStudioResultRerun(sessionId: string, input: StudioResultRerunConfirmInput): Promise<StudioResultRerunResult>
}
