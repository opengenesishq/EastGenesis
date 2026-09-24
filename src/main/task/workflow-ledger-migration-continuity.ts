import { dirname, join, resolve } from 'node:path'
import { SessionDeletionJournal } from '../data-lifecycle/session-deletion-journal'
import { listMigrationJournals } from './workflow-ledger-migration-storage'
import {
  WORKFLOW_LEDGER_MIGRATION_KIND,
  WORKFLOW_LEDGER_MIGRATION_VERSION,
  WorkflowLedgerMigrationError,
  type EnsureWorkflowLedgerTaskStoreReadyOptions,
  type PreparedWorkflowLedgerMigration,
  type WorkflowLedgerCanonicalReadinessReport
} from './workflow-ledger-migration-types'

const BACKUP_DIR = join('backups', 'workflow-ledger')

export async function findCommittedWorkflowLedgerMigration(
  options: EnsureWorkflowLedgerTaskStoreReadyOptions,
  targetPath: string
): Promise<PreparedWorkflowLedgerMigration | null> {
  const resolvedTarget = resolve(targetPath)
  const root = resolve(options.backupsRoot ?? join(dirname(resolvedTarget), BACKUP_DIR))
  const journals = await listMigrationJournals(root)
  const found = journals
    .filter(({ journal }) => journal.migrationKind === WORKFLOW_LEDGER_MIGRATION_KIND &&
      journal.migrationVersion === WORKFLOW_LEDGER_MIGRATION_VERSION &&
      journal.targetPath === resolvedTarget &&
      journal.toVersion <= options.targetStoreVersion &&
      journal.state === 'committed')
    .sort((left, right) =>
      right.journal.toVersion - left.journal.toVersion || right.journal.updatedAt - left.journal.updatedAt
    )[0]
  if (!found) return null
  return {
    migrationId: found.journal.migrationId,
    journalPath: found.path,
    backupPath: found.journal.backup.path,
    journal: found.journal,
    alreadyCommitted: true
  }
}

export function assertCommittedWorkflowLedgerTargetContinuity(input: {
  currentVersion: number
  current: WorkflowLedgerCanonicalReadinessReport
  committed: PreparedWorkflowLedgerMigration | null
}): void {
  if (!input.committed) return
  const committedVersion = input.committed.journal.toVersion
  if (input.currentVersion < committedVersion) {
    throw new WorkflowLedgerMigrationError(
      'COMMITTED_TARGET_VERSION_REGRESSION',
      `Committed migration target version regressed:${input.currentVersion} < ${committedVersion}`
    )
  }
  const prior = input.committed.journal.readiness
  if (!prior) {
    throw new WorkflowLedgerMigrationError('MIGRATION_JOURNAL_INVALID', 'Committed migration has no readiness evidence')
  }
  if (prior.storeId && input.current.storeId !== prior.storeId) {
    throw new WorkflowLedgerMigrationError(
      'COMMITTED_TARGET_IDENTITY_MISMATCH',
      'Committed migration target store identity changed'
    )
  }
  assertHighWaterNotRegressed(prior, input.current, authorizedConversationPurgeSince(input.committed))
}

function authorizedConversationPurgeSince(
  committed: PreparedWorkflowLedgerMigration
): { streams: number; generations: number; events: number } {
  const committedAt = committed.journal.committedAt ?? committed.journal.updatedAt
  try {
    return new SessionDeletionJournal(dirname(committed.journal.targetPath))
      .completedConversationPurgeReceipts()
      .filter((receipt) => receipt.completedAt > committedAt)
      .reduce((total, receipt) => ({
        streams: total.streams + receipt.streams,
        generations: total.generations + receipt.generations,
        events: total.events + receipt.events
      }), { streams: 0, generations: 0, events: 0 })
  } catch {
    // A missing or malformed external receipt must never weaken the continuity
    // gate. The normal migration journal/DB checks remain fail-closed.
    return { streams: 0, generations: 0, events: 0 }
  }
}

function assertHighWaterNotRegressed(
  prior: WorkflowLedgerCanonicalReadinessReport,
  current: WorkflowLedgerCanonicalReadinessReport,
  externalConversationPurge: { streams: number; generations: number; events: number } = {
    streams: 0,
    generations: 0,
    events: 0
  }
): void {
  const priorWorkflow = prior.verification?.workflowLedger
  const currentWorkflow = current.verification?.workflowLedger
  const priorEvidence = prior.verification?.taskEvidence
  const currentEvidence = current.verification?.taskEvidence
  const priorConversation = prior.verification?.conversationLedger
  const currentConversation = current.verification?.conversationLedger
  const priorRemoved = prior.authorizedPurges?.removed
  const currentRemoved = current.authorizedPurges?.removed
  const logical = (physical: number, removed: number | undefined): number => physical + (removed ?? 0)
  const logicalConversation = (physical: number, removed: number | undefined, externallyRemoved: number): number =>
    physical + (removed ?? 0) + externallyRemoved
  const regressed = logical(current.counts.workflowRuns, currentRemoved?.workflowRuns) <
      logical(prior.counts.workflowRuns, priorRemoved?.workflowRuns) ||
    logical(current.counts.taskRuns, currentRemoved?.taskRuns) <
      logical(prior.counts.taskRuns, priorRemoved?.taskRuns) ||
    Boolean(priorWorkflow && (!currentWorkflow ||
      logical(currentWorkflow.runs, currentRemoved?.workflowRuns) <
        logical(priorWorkflow.runs, priorRemoved?.workflowRuns) ||
      logical(currentWorkflow.events, currentRemoved?.workflowEvents) <
        logical(priorWorkflow.events, priorRemoved?.workflowEvents) ||
      logical(currentWorkflow.lastSeq, currentRemoved?.workflowEvents) <
        logical(priorWorkflow.lastSeq, priorRemoved?.workflowEvents))) ||
    Boolean(priorEvidence && (!currentEvidence ||
      logical(currentEvidence.count, currentRemoved?.taskEvidence) <
        logical(priorEvidence.count, priorRemoved?.taskEvidence) ||
      logical(currentEvidence.lastSeq, currentRemoved?.taskEvidence) <
        logical(priorEvidence.lastSeq, priorRemoved?.taskEvidence))) ||
    Boolean(priorConversation && (!currentConversation ||
      logicalConversation(currentConversation.streams, currentRemoved?.conversationStreams, externalConversationPurge.streams) <
        logical(priorConversation.streams, priorRemoved?.conversationStreams) ||
      logicalConversation(currentConversation.generations, currentRemoved?.conversationGenerations, externalConversationPurge.generations) <
        logical(priorConversation.generations, priorRemoved?.conversationGenerations) ||
      logicalConversation(currentConversation.events, currentRemoved?.conversationEvents, externalConversationPurge.events) <
        logical(priorConversation.events, priorRemoved?.conversationEvents)))
  if (regressed) {
    throw new WorkflowLedgerMigrationError(
      'COMMITTED_TARGET_STATE_REGRESSION',
      'Committed migration target durable history regressed'
    )
  }
}
