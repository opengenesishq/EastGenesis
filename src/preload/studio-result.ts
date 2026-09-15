import { ipcRenderer } from 'electron'
import type { StudioAuditTimelineQuery, StudioResultApi } from '../shared/studio-result-types'

const invoke = (action: 'get' | 'audit' | 'export' | 'save' | 'check_files', sessionId: string, query?: StudioAuditTimelineQuery) =>
  ipcRenderer.invoke('appFeatures:invoke', 'studio-result', action, sessionId, query)

export const studioResultApi: StudioResultApi = {
  checkStudioResultFiles: (sessionId: string) => invoke('check_files', sessionId),
  getStudioResultSnapshot: (sessionId: string) => invoke('get', sessionId),
  queryStudioAuditTimeline: (sessionId: string, query?: StudioAuditTimelineQuery) =>
    invoke('audit', sessionId, query),
  exportStudioResultSnapshot: (sessionId: string) => invoke('export', sessionId),
  saveStudioResultSnapshot: (sessionId: string) => invoke('save', sessionId)
}
