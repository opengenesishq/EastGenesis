import { isDigitalWorkerProviderDispatchDeniedError } from '../digital-worker/session-action-policy'
import { OutboundContextPolicyError } from '../project-workspace/outbound-context-policy'
import { isModelRouteError } from './model-route-error'
import { ModelContextHandoffError } from './context-handoff-error'

/** Product policy failures must finish the turn before provider recovery or
 * provider-health accounting, including failures at the physical request gate. */
export function nativeTurnRejection(error: unknown): {
  message: string
  subtype: 'policy-denied' | 'outbound-policy-denied' | 'routing-blocked' | 'handoff-blocked'
} | undefined {
  if (error instanceof ModelContextHandoffError) {
    return { message: error.message, subtype: 'handoff-blocked' }
  }
  if (isDigitalWorkerProviderDispatchDeniedError(error)) {
    return { message: error.message, subtype: 'policy-denied' }
  }
  if (error instanceof OutboundContextPolicyError) {
    return { message: error.message, subtype: 'outbound-policy-denied' }
  }
  if (isModelRouteError(error)) return { message: error.message, subtype: 'routing-blocked' }
  return undefined
}
