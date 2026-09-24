import { ipcRenderer } from 'electron'
import type { HistoryQuestionApi } from '../shared/history-question-types'
export const historyQuestionApi: HistoryQuestionApi = {
  previewHistoryQuestion: input => ipcRenderer.invoke('history-question:preview', input),
  deliverHistoryQuestion: input => ipcRenderer.invoke('history-question:deliver', input)
}
