import type { WorkflowAcceptanceStatus } from '../../shared/workflow-types'

/**
 * A source change cancels an in-flight verification and revokes any previous
 * pass/waiver. Pending work stays pending; a known failure stays visible until
 * an explicit retest. Every case still needs a new revision to fence old work.
 */
export function workflowAcceptanceStatusAfterChange(status: WorkflowAcceptanceStatus): 'pending' | 'failed' {
  return status === 'failed' ? 'failed' : 'pending'
}
