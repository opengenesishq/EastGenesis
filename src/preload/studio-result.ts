import { ipcRenderer } from 'electron'
import type { StudioAuditTimelineQuery, StudioResultApi } from '../shared/studio-result-types'
import type { StudioResultRerunInput } from '../shared/studio-result-rerun-types'

const invoke = (action: 'get' | 'audit' | 'export' | 'save' | 'check_files' | 'rerun_preview', sessionId: string, query?: StudioAuditTimelineQuery | StudioResultRerunInput) =>
  ipcRenderer.invoke('appFeatures:invoke', 'studio-result', action, sessionId, query)

export const studioResultApi: StudioResultApi = {
  checkStudioResultFiles: (sessionId: string) => invoke('check_files', sessionId),
  previewStudioResultRerun: (sessionId: string, input: StudioResultRerunInput) => invoke('rerun_preview', sessionId, input),
  getStudioResultSnapshot: (sessionId: string) => invoke('get', sessionId),
  queryStudioAuditTimeline: (sessionId: string, query?: StudioAuditTimelineQuery) =>
    invoke('audit', sessionId, query),
  exportStudioResultSnapshot: (sessionId: string) => invoke('export', sessionId),
  saveStudioResultSnapshot: (sessionId: string) => invoke('save', sessionId)
}
