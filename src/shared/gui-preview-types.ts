export type GuiPreviewPhase = 'idle' | 'waiting' | 'running' | 'completed' | 'failed' | 'stopping' | 'paused' | 'unavailable'

export interface GuiPreviewAction {
  id: string
  toolName: string
  label: string
  target: string
  startedAt: number
  finishedAt?: number
}

export interface GuiPreviewFrame {
  dataUrl: string
  sourceLabel: string
  capturedAt: number
  width: number
  height: number
  sha256: string
}

export interface GuiPreviewSnapshot {
  sessionId: string
  title: string
  runId?: string
  language: 'zh' | 'en'
  phase: GuiPreviewPhase
  taskStatus: string
  action?: GuiPreviewAction
  frame?: GuiPreviewFrame
  pendingApprovalCount: number
  canStop: boolean
  available: boolean
  message?: string
  revision: number
}

/** This limited API is the only bridge exposed in the floating preview window. */
export interface GuiPreviewApi {
  getState(): Promise<GuiPreviewSnapshot>
  pause(expectedRunId: string | undefined): Promise<GuiPreviewSnapshot>
  takeOver(expectedRunId: string | undefined): Promise<GuiPreviewSnapshot>
  openTask(): Promise<void>
  close(): Promise<void>
  onState(callback: (state: GuiPreviewSnapshot) => void): () => void
}

export interface GuiPreviewWorkbenchApi {
  openGuiPreview(sessionId: string): Promise<void>
}
