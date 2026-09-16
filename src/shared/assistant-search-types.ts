import type { AssistantSearchAuthorityApi } from './assistant-search-authority-types'
export type * from './assistant-search-authority-types'

/** Renderer-safe contract for Assistant Search Broker IPC. */
export type AssistantSearchAdapterKind = 'native' | 'byok' | 'browser_fallback'
export type AssistantSearchAttemptStatus = 'running' | 'succeeded' | 'failed'
export type AssistantSearchFailureCode =
  | 'no_credentials'
  | 'egress_denied'
  | 'no_results'
  | 'timeout'
  | 'provider_failed'
  | 'invalid_result'
  | 'scope_denied'
  | 'unknown'
  | 'cancelled'
  | 'browser_unavailable'

export interface AssistantSearchRequest {
  requestId: string
  query: string
  sessionId?: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  artifactId?: string
  /** Main-owned consent receipt, scoped to this query and original task. */
  authorizationId?: string
  egress?: 'allow' | 'deny'
}

export interface AssistantSearchCitation {
  url: string
  fetchedAt: number
  summary: string
  contentDigest: string
  evidenceId: string
  artifactId?: string
  contentKind?: 'search_snippet'
  /** Observed search endpoint, with query text and fragment removed. */
  sourcePageUrl?: string
}

export interface AssistantSearchAttempt {
  schemaVersion: 1
  attemptId: string
  idempotencyKey: string
  requestId: string
  sessionId?: string
  queryDigest: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  artifactId?: string
  adapterId?: string
  adapterKind?: AssistantSearchAdapterKind
  routeReason?: string
  status: AssistantSearchAttemptStatus
  failureCode?: AssistantSearchFailureCode
  failureMessage?: string
  citations: AssistantSearchCitation[]
  startedAt: number
  completedAt?: number
  evidenceIds: string[]
}

export interface AssistantSearchApi extends AssistantSearchAuthorityApi {
  searchAssistant(request: AssistantSearchRequest): Promise<AssistantSearchAttempt>
  getAssistantSearchAttempt(idempotencyKey: string): Promise<AssistantSearchAttempt | null>
}
