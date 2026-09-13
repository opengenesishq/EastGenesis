/** Renderer-safe contract for Assistant Search Broker IPC. */
export type AssistantSearchAdapterKind = 'native' | 'byok'
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

export interface AssistantSearchRequest {
  requestId: string
  query: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  artifactId?: string
  egress?: 'allow' | 'deny'
}

export interface AssistantSearchCitation {
  url: string
  fetchedAt: number
  summary: string
  contentDigest: string
  evidenceId: string
  artifactId?: string
}

export interface AssistantSearchAttempt {
  schemaVersion: 1
  attemptId: string
  idempotencyKey: string
  requestId: string
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

export interface AssistantSearchApi {
  searchAssistant(request: AssistantSearchRequest): Promise<AssistantSearchAttempt>
  getAssistantSearchAttempt(idempotencyKey: string): Promise<AssistantSearchAttempt | null>
}
