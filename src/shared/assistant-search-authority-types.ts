import type { AssistantSearchRequest } from './assistant-search-types'

export interface AssistantSearchAuthorizationInput {
  sessionId: string
  requestId: string
  query: string
}

export interface AssistantSearchAuthorityApi {
  /** User explicitly submits this query to the displayed search service. */
  authorizeAssistantSearch(input: AssistantSearchAuthorizationInput): Promise<AssistantSearchRequest>
  cancelAssistantSearch(sessionId: string, requestId: string): Promise<void>
}
