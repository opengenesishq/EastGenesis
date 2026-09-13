import type { PersonalTaskSubmissionView } from '../../shared/personal-task-types'
import type { PersonalTaskEvidence } from './personal-task-evidence'
import type { PersonalTaskSubmissionRecord } from './personal-task-submission-store'

/** Read-only projection. Receipt phases cannot manufacture an accepted message or a canonical task. */
export function personalTaskSubmissionView(
  record: PersonalTaskSubmissionRecord,
  evidence: PersonalTaskEvidence,
  options: { replayed: boolean; active?: boolean }
): PersonalTaskSubmissionView {
  const binding = evidence.goal && evidence.workItem && evidence.hasSessionRecord ? record.binding : undefined
  return {
    clientRequestId: record.clientRequestId, revision: record.revision,
    status: submissionStatus(record, evidence, Boolean(options.active)),
    replayed: options.replayed, binding, messageId: record.messageId,
    runId: evidence.acceptedRunId,
    session: evidence.session,
    ...(record.error ? { error: { ...record.error } } : {})
  }
}

export function personalTaskSendMustReconcile(record: PersonalTaskSubmissionRecord, evidence: PersonalTaskEvidence): boolean {
  if (evidence.firstMessageAccepted) return false
  return ['dispatching', 'submitted', 'needs_reconciliation'].includes(record.phase) ||
    evidence.attemptCount > 0 || evidence.hasExecutionEffects || evidence.hasOtherUserMessage
}

function submissionStatus(
  record: PersonalTaskSubmissionRecord, evidence: PersonalTaskEvidence, active: boolean
): PersonalTaskSubmissionView['status'] {
  if (evidence.firstMessageAccepted) return 'submitted'
  if (active) return 'preparing'
  if (personalTaskSendMustReconcile(record, evidence)) return 'needs_reconciliation'
  if (record.phase === 'not_sent') return 'not_sent'
  if (evidence.session && evidence.goal && evidence.workItem) return 'ready'
  return 'not_sent'
}

export function personalTaskUnverifiedView(
  record: PersonalTaskSubmissionRecord, error: PersonalTaskSubmissionView['error'], replayed: boolean
): PersonalTaskSubmissionView {
  return {
    clientRequestId: record.clientRequestId, revision: record.revision,
    status: 'needs_reconciliation', replayed, messageId: record.messageId, error
  }
}
