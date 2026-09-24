import { ipcRenderer } from 'electron'
import type { FeedbackApi } from '../shared/feedback-types'

export const feedbackApi: FeedbackApi = {
  getFeedbackAppInfo: () => ipcRenderer.invoke('feedback:appInfo'),
  previewFeedback: input => ipcRenderer.invoke('feedback:preview', input),
  exportFeedback: previewId => ipcRenderer.invoke('feedback:export', previewId)
}
