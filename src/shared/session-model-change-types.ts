import type { SessionRoutingScope } from './types'
import type { SessionModelHandoff } from './session-model-handoff-types'
import type { SessionRoutingControl } from './session-routing-control-types'

/** An explicit user decision; it never rewrites a preceding Run's frozen route. */
export interface SessionModelChange {
  schemaVersion: 1
  id: string
  state: 'prepared' | 'committed'
  sessionId: string
  projectId?: string
  goalId?: string
  workItemId?: string
  sourceRunId?: string
  sourcePolicyDigest?: string
  from: { providerId: string; model: string; routingScope?: SessionRoutingScope; routingControl?: SessionRoutingControl }
  to: { providerId: string; model: string; routingScope: SessionRoutingScope; routingControl?: SessionRoutingControl }
  handoff: SessionModelHandoff
  createdAt: number
  digest: string
}
