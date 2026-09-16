import { resolve } from 'node:path'
import type { DataRetentionSubject } from '../../shared/data-lifecycle-types'
import { invalidateHistoryCache } from '../history'
import {
  inspectManagedWorktreeRegistryRecord,
  purgeRemovedManagedWorktreeRecordAtRoot
} from '../managed-worktree-lifecycle'
import {
  countConversationLedgerArchiveResidualsForSession,
  purgeConversationLedgerArchiveForSession
} from '../task/conversation-ledger-archive'
import { runHasUnresolvedEffects } from '../task/effect-runtime'
import { ModelAttemptRecoveryGate } from '../task/model-attempt-recovery-gate'
import { deleteTaskSnapshot, getTaskSnapshot, listTaskSnapshots } from '../task/task-snapshot'
import { countTaskPlanLedgerForSession } from '../task/task-plan-ledger'
import {
  countWorktreeMergeReceiptsForSession,
  purgeWorktreeMergeReceipts
} from '../worktrees'
import {
  purgeStandaloneSessionFiles,
  purgeStandaloneSessionStores,
  scanStandaloneSessionResiduals
} from './project-session-purge'
import {
  SESSION_DELETION_PHASES,
  SessionDeletionJournal,
  type SessionDeletionJournalEntry,
  type SessionDeletionPhase
} from './session-deletion-journal'
import {
  assertDataPurgeAllowed,
  isDataRetentionBlockedError
} from './retention-authority'
import { withDataLifecycleMutation } from './data-lifecycle-mutation-lock'
import { captureSessionDeletionMemoryScope, countStandaloneSessionMemory, purgeStandaloneSessionMemory } from './session-memory-purge'

export interface SessionDeletionResult {
  operationId: string
  sessionId: string
  sdkSessionId: string
  phase: 'completed'
  removedRecords: Record<string, number>
  removedPathCount: number
  residuals: Record<string, number>
  memoryOwnership: 'resolved' | 'unresolved'
}

export interface SessionDeletionCoordinatorOptions {
  retentionAnchorAt?: number
  relatedLegalHoldSubjects?: DataRetentionSubject[]
  afterPhase?: (phase: SessionDeletionPhase, entry: SessionDeletionJournalEntry) => void | Promise<void>
}

type EntryPatch = Partial<Pick<SessionDeletionJournalEntry,
  'removedRecords' | 'removedPathCount' | 'residuals' | 'memoryScope'>>

export async function deleteStandaloneSession(
  sessionIdInput: string,
  sdkSessionIdInput: string,
  userDataRoot: string,
  options: SessionDeletionCoordinatorOptions = {}
): Promise<SessionDeletionResult> {
  const root = requiredRoot(userDataRoot)
  const sessionId = requiredId(sessionIdInput, 'sessionId')
  const sdkSessionId = requiredId(sdkSessionIdInput, 'sdkSessionId')
  const journal = new SessionDeletionJournal(root)
  const pending = journal.getPendingSession(sessionId)
  const retentionInput = {
    targets: [{
      subject: { kind: 'session' as const, id: sessionId },
      retentionAnchorAt: requiredTimestamp(options.retentionAnchorAt ?? Date.now(), 'retentionAnchorAt')
    }],
    relatedLegalHoldSubjects: [
      { kind: 'session' as const, id: sessionId },
      ...(options.relatedLegalHoldSubjects ?? [])
    ]
  }
  const entry = pending ?? await withDataLifecycleMutation(root, async () => {
    const memoryScope = await captureSessionDeletionMemoryScope(root, sessionId)
    const prepared = await journal.begin({
      sessionId,
      sdkSessionId,
      retentionTargets: retentionInput.targets,
      legalHoldSubjects: [...retentionInput.relatedLegalHoldSubjects,
        ...(memoryScope.ownership === 'resolved' && memoryScope.sessionId !== sessionId
          ? [{ kind: 'session' as const, id: memoryScope.sessionId }] : [])],
      memoryScope
    })
    assertDeletionAllowed(root, prepared)
    await options.afterPhase?.('prepared', prepared)
    return prepared
  })
  if (entry.sdkSessionId !== sdkSessionId) {
    throw new Error('session deletion request does not match the prepared history identity')
  }
  return executeDeletion(root, entry, journal, options)
}

export async function resumeSessionDeletions(
  userDataRoot: string,
  options: SessionDeletionCoordinatorOptions = {}
): Promise<SessionDeletionResult[]> {
  const root = requiredRoot(userDataRoot)
  const journal = new SessionDeletionJournal(root)
  await journal.compactCompleted()
  const results: SessionDeletionResult[] = []
  for (const entry of journal.listPending()) {
    try {
      results.push(await executeDeletion(root, entry, journal, options))
    } catch (error) {
      if (!isDataRetentionBlockedError(error)) throw error
      console.info(`[caogen] Session deletion remains pending under retention authority: ${entry.sessionId}`)
    }
  }
  return results
}

async function executeDeletion(
  root: string,
  initial: SessionDeletionJournalEntry,
  journal: SessionDeletionJournal,
  options: SessionDeletionCoordinatorOptions
): Promise<SessionDeletionResult> {
  return withDataLifecycleMutation(root, () => executeDeletionLocked(root, initial, journal, options))
}

async function executeDeletionLocked(
  root: string,
  initial: SessionDeletionJournalEntry,
  journal: SessionDeletionJournal,
  options: SessionDeletionCoordinatorOptions
): Promise<SessionDeletionResult> {
  let entry = initial
  assertSessionWorktreePurgeable(root, entry.sessionId)
  const current = (): number => SESSION_DELETION_PHASES.indexOf(entry.phase)
  const advance = async (phase: SessionDeletionPhase, patch: EntryPatch = {}): Promise<void> => {
    entry = await journal.advance(entry.operationId, phase, patch)
    await options.afterPhase?.(phase, entry)
  }

  if (!entry.memoryScope) {
    await advance(entry.phase, { memoryScope: await captureSessionDeletionMemoryScope(root, entry.sessionId) })
  }

  if (current() < phaseIndex('snapshot_purged')) {
    assertDeletionAllowed(root, entry)
    const removed = await purgeRecoverySnapshot(root, entry.sessionId)
    await advance('snapshot_purged', {
      removedRecords: mergeCounts(entry.removedRecords, { taskSnapshots: removed ? 1 : 0 })
    })
  }

  if (current() < phaseIndex('stores_purged')) {
    assertDeletionAllowed(root, entry)
    const stores = await purgeStandaloneSessionStores(
      root,
      entry.sessionId,
      entry.sdkSessionId
    )
    const archive = await purgeConversationLedgerArchiveForSession(entry.sdkSessionId, root)
    invalidateHistoryCache()
    await advance('stores_purged', {
      removedRecords: mergeCounts(entry.removedRecords, stores.removedRecords, {
        conversationLedgerStreams: archive.streams,
        conversationLedgerGenerations: archive.generations,
        conversationLedgerEvents: archive.events
      })
    })
  }

  if (current() < phaseIndex('files_purged')) {
    assertDeletionAllowed(root, entry)
    const removedPaths = purgeStandaloneSessionFiles(root, entry.sessionId, entry.sdkSessionId)
    const worktrees = purgeRemovedManagedWorktreeRecordAtRoot(entry.sessionId, root) ? 1 : 0
    const receipts = purgeWorktreeMergeReceipts(entry.sessionId, root)
    await advance('files_purged', {
      removedRecords: mergeCounts(entry.removedRecords, {
        managedWorktreeRecords: worktrees,
        worktreeMergeReceipts: receipts
      }),
      removedPathCount: (entry.removedPathCount ?? 0) + removedPaths.length
    })
  }

  if (current() < phaseIndex('verified')) {
    assertDeletionAllowed(root, entry)
    const memory = await purgeStandaloneSessionMemory(root, entry.sessionId, entry.memoryScope)
    const residuals = await scanResiduals(root, entry)
    assertNoResiduals(residuals)
    await advance('verified', { residuals, removedRecords: mergeCounts(entry.removedRecords, { layeredMemory: memory }) })
  }

  if (current() < phaseIndex('completed')) await advance('completed')
  const result: SessionDeletionResult = {
    operationId: entry.operationId,
    sessionId: entry.sessionId,
    sdkSessionId: entry.sdkSessionId,
    phase: 'completed',
    removedRecords: { ...(entry.removedRecords ?? {}) },
    removedPathCount: entry.removedPathCount ?? 0,
    residuals: { ...(entry.residuals ?? {}) },
    memoryOwnership: entry.memoryScope?.ownership ?? 'unresolved'
  }
  await journal.compactCompleted()
  return result
}

function assertSessionWorktreePurgeable(root: string, sessionId: string): void {
  const lookup = inspectManagedWorktreeRegistryRecord(sessionId, root)
  if ('error' in lookup) throw new Error(lookup.error)
  if (lookup.record?.state === 'active') {
    throw new Error('active managed worktree prevents Session deletion')
  }
}

function assertDeletionAllowed(root: string, entry: SessionDeletionJournalEntry): void {
  assertDataPurgeAllowed(root, {
    targets: entry.retentionTargets ?? [{
      subject: { kind: 'session', id: entry.sessionId },
      retentionAnchorAt: entry.createdAt
    }],
    relatedLegalHoldSubjects: entry.legalHoldSubjects ?? [
      { kind: 'session', id: entry.sessionId }
    ]
  })
}

async function purgeRecoverySnapshot(root: string, sessionId: string): Promise<boolean> {
  const snapshot = await getTaskSnapshot(sessionId, root)
  if (!snapshot) return false
  await new ModelAttemptRecoveryGate().assertSnapshotDeletable(snapshot, root)
  const operationWaiting = snapshot.run?.operation && snapshot.run.status === 'waiting_reconciliation'
  if (runHasUnresolvedEffects(snapshot.run) || operationWaiting) {
    throw new Error('unresolved Effect or operation reconciliation prevents Session deletion')
  }
  return deleteTaskSnapshot(sessionId, root)
}

async function scanResiduals(
  root: string,
  entry: SessionDeletionJournalEntry
): Promise<Record<string, number>> {
  const { sessionId, sdkSessionId } = entry
  const local = scanStandaloneSessionResiduals(root, sessionId, sdkSessionId)
  const snapshots = await listTaskSnapshots(root)
  const archive = await countConversationLedgerArchiveResidualsForSession(sdkSessionId, root)
  const taskPlanLedgerEvents = await countTaskPlanLedgerForSession(root, sessionId)
  const worktreeLookup = inspectManagedWorktreeRegistryRecord(sessionId, root)
  if ('error' in worktreeLookup) throw new Error(worktreeLookup.error)
  return {
    ...local,
    layeredMemory: await countStandaloneSessionMemory(root, sessionId, entry.memoryScope),
    taskSnapshots: snapshots.filter((snapshot) =>
      snapshot.id === sessionId || snapshot.sessionId === sessionId).length,
    conversationLedgerStreams: archive.streams,
    conversationLedgerGenerations: archive.generations,
    conversationLedgerEvents: archive.events,
    taskPlanLedgerEvents,
    managedWorktreeRecords: worktreeLookup.record ? 1 : 0,
    worktreeMergeReceipts: countWorktreeMergeReceiptsForSession(sessionId, root)
  }
}

function assertNoResiduals(residuals: Readonly<Record<string, number>>): void {
  const total = Object.values(residuals).reduce((sum, value) => sum + value, 0)
  if (total !== 0) {
    throw new Error(`session deletion left ${total} residual records: ${JSON.stringify(residuals)}`)
  }
}

function mergeCounts(...values: Array<Record<string, number> | undefined>): Record<string, number> {
  const merged: Record<string, number> = {}
  for (const value of values) {
    for (const [key, count] of Object.entries(value ?? {})) {
      merged[key] = (merged[key] ?? 0) + count
    }
  }
  return merged
}

function phaseIndex(phase: SessionDeletionPhase): number {
  return SESSION_DELETION_PHASES.indexOf(phase)
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${label} is required`)
  return value.trim()
}

function requiredRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('userDataRoot is required')
  return resolve(value)
}

function requiredTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} is invalid`)
  return Number(value)
}
