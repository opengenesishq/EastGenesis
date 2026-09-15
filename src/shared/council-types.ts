import type { ProjectInstitutionRole, ProjectInstitutionTemplateRef } from './project-institution-template'

/** Council is one bounded, read-only round attached to an existing task. */
export interface CouncilLimits {
  rounds: 1
  maxParticipants: 2
  timeoutMs: number
  totalBudgetUsd: number
  maxOutputTokens: number
  retries: 0
}
export interface CouncilParticipant {
  institutionId: string
  institutionName: string
  duty: string
  providerId: string
  providerName: string
  model: string
  engine: 'openai' | 'anthropic'
  budgetUsd: number
}
export interface CouncilPreviewInput { sessionId: string; requestId: string; topic: string; institutionIds: string[] }
export interface CouncilPreview {
  schemaVersion: 1
  sessionId: string
  requestId: string
  projectId: string
  goalId: string
  workItemId: string
  topic: string
  template: ProjectInstitutionTemplateRef
  participants: CouncilParticipant[]
  limits: CouncilLimits
  previewDigest: string
  blockedReasons: string[]
}
export interface CouncilStartInput extends CouncilPreviewInput { previewDigest: string }
export interface CouncilGetInput { sessionId: string; councilId?: string }
export interface CouncilStopInput { sessionId: string; councilId: string }
export type CouncilPhase = 'preparing' | 'running' | 'completed' | 'stopped' | 'needs_reconciliation'
export interface CouncilOpinion {
  institutionId: string
  sessionId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'needs_reconciliation'
  conclusion?: string
  error?: string
}
export interface CouncilRecord extends CouncilPreview {
  councilId: string
  phase: CouncilPhase
  startedAt: number
  deadlineAt: number
  completedAt?: number
  opinions: CouncilOpinion[]
  /** Programmatic archive of the original opinions; never a new parent model turn. */
  report?: string
  error?: string
}
export interface CouncilContext {
  sessionId: string
  template: ProjectInstitutionTemplateRef
  institutions: ProjectInstitutionRole[]
  history: CouncilRecord[]
}
export interface CouncilApi {
  councilPreview(input: CouncilPreviewInput): Promise<CouncilPreview>
  councilStart(input: CouncilStartInput): Promise<CouncilRecord>
  councilGet(input: CouncilGetInput): Promise<CouncilContext>
  councilStop(input: CouncilStopInput): Promise<CouncilRecord>
}

/** Stored inside the existing TaskDagRuntimeSnapshot, not a separate task store. */
export interface CouncilRuntimeBinding {
  schemaVersion: 1
  record: CouncilRecord
  context: string
  connectionDigests: Record<string, string>
  requestClaims: string[]
  budgetContext: { parentLimitUsd?: number; goalLimitUsd?: number; goalSessionIds: string[]; goalSpentUsd: number }
}
