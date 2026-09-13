/** Trusted main-process origin; model arguments cannot assign these identities. */
export interface MediaAgentOrigin {
  sessionId: string
  toolUseId: string
  workspaceId: string
  businessLineId: string
  goalId?: string
  workItemId?: string
}
