import { ipcRenderer } from 'electron'
import type { AgentDeskApi, AssistantSearchApi, AssistantSearchRequest } from '../shared/types'

export const assistantSearchApi: Pick<AgentDeskApi, keyof AssistantSearchApi> = {
  authorizeAssistantSearch: input => ipcRenderer.invoke('assistantSearch:authorize', input),
  cancelAssistantSearch: (sessionId, requestId) => ipcRenderer.invoke('assistantSearch:cancel', sessionId, requestId),
  searchAssistant: (request: AssistantSearchRequest) =>
    ipcRenderer.invoke('assistantSearch:search', request),
  getAssistantSearchAttempt: (idempotencyKey: string) =>
    ipcRenderer.invoke('assistantSearch:getAttempt', idempotencyKey)
}
