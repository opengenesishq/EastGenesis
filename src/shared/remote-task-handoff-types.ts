/** Signed transport only. Task ownership, content approval and durable
 * idempotency remain in the task-handoff service keyed by payload.id. */
export const REMOTE_TASK_HANDOFF_ACTIONS = ['capabilities', 'destinations', 'prepare', 'chunk', 'status', 'preview', 'commit', 'cancel'] as const
export type RemoteTaskHandoffAction = typeof REMOTE_TASK_HANDOFF_ACTIONS[number]
export interface RemoteTaskHandoffEnvelope {
  schemaVersion: 1
  kind: 'task_handoff'
  requestId: string
  action: RemoteTaskHandoffAction
  issuerDeviceId: string
  projectId: string
  createdAt: number
  expiresAt: number
  payloadDigest: string
  payload: Record<string, unknown>
  signature: string
}
