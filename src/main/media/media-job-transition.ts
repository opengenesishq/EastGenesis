import type { MediaJobRecord } from '../../shared/media-types'
import type { MediaJobOperationTarget } from './media-job-effect-target'

type MediaJobProviderOperation = 'submit' | 'poll' | 'download' | 'cancel'

type MediaAdvanceTransition = {
  operation: MediaJobProviderOperation
  status: MediaJobOperationTarget['expectedStatus']
  reason?: string
}

export function nextTransition(job: MediaJobRecord): MediaAdvanceTransition {
  if (job.status === 'requested') return { operation: 'submit', status: 'submitting' }
  if (job.status === 'submitting') return { operation: 'poll', status: 'running' }
  if (job.status === 'running') {
    if (job.providerMode === 'remote') return { operation: 'poll', status: 'running' }
    if (job.mockScenario === 'failure') return { operation: 'poll', status: 'failed', reason: 'Mock Provider reported generation failure' }
    if (job.mockScenario === 'rate_limit') return { operation: 'poll', status: 'failed', reason: 'Mock Provider rate limit exhausted the bounded attempt' }
    if (job.mockScenario === 'unknown_result') {
      return { operation: 'poll', status: 'waiting_reconciliation', reason: 'Mock Provider result is intentionally unknown' }
    }
    return { operation: 'poll', status: 'downloading' }
  }
  if (job.status === 'downloading') return { operation: 'download', status: 'succeeded' }
  throw new Error(`MediaJob cannot advance from ${job.status}`)
}

export function isTerminal(status: MediaJobRecord['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}
