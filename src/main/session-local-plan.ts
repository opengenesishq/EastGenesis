import { AUTO_MODEL, type SessionMeta } from '../shared/types'

/** A canonical planning Session can exist before any execution target is selected. */
export function isUnroutedLocalPlan(meta: Pick<SessionMeta,
  'taskStrategy' | 'model' | 'providerId' | 'routingScope' | 'workspaceId' | 'goalId' | 'workItemId' | 'parentSessionId'
>): boolean {
  return meta.taskStrategy === 'plan' && meta.model === AUTO_MODEL && !meta.providerId &&
    meta.routingScope === 'global' && Boolean(meta.workspaceId && meta.goalId && meta.workItemId) && !meta.parentSessionId
}
