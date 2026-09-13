import { ipcRenderer } from 'electron'
import type { AgentDeskApi, AssistantSearchApi, AssistantSearchRequest } from '../shared/types'

export const assistantSearchApi: Pick<AgentDeskApi, keyof AssistantSearchApi> = {
  searchAssistant: (request: AssistantSearchRequest) =>
    ipcRenderer.invoke('assistantSearch:search', request),
  getAssistantSearchAttempt: (idempotencyKey: string) =>
    ipcRenderer.invoke('assistantSearch:getAttempt', idempotencyKey)
}
