import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionMeta, TaskSnapshotRecord, TranscriptEntry } from '../../shared/types'
import { activeSessionRecordsFromDocument } from '../active-session-registry-format'
import { activeSessionRecoveryBlocks } from '../session-creation-recovery'
import { listPendingSessionCreations } from '../session-creation-journal'
import { readTranscriptEntriesStrict, transcriptFile } from '../transcript'
import { queryPersistedModelAttempts } from '../task/model-attempt-api'
import { assertPersonalSessionIdentity, readPersonalTaskEvidence } from './personal-task-evidence'
import { PersonalTaskSubmissionStore, type PersonalTaskSubmissionRecord } from './personal-task-submission-store'

interface PersonalTaskStartupRecovery {
  activeRecoveryBlocks: Set<string>
  pendingCreationSnapshots: TaskSnapshotRecord[]
}

/** No prompt is replayed here. Only durable proof of never-dispatched initialization
 * allows existing registry/journal recovery; every execution/reference gate remains. */
export async function planPersonalTaskStartupRecovery(
  snapshots: TaskSnapshotRecord[], rootDir: string
): Promise<PersonalTaskStartupRecovery> {
  const ordinary = { activeRecoveryBlocks: activeSessionRecoveryBlocks(snapshots), pendingCreationSnapshots: snapshots }
  try {
    const candidates = await findUnstartedPersonalTasks(snapshots, rootDir)
    const blocked = activeSessionRecoveryBlocks(snapshots.filter((snapshot) => !candidates.initialized.has(snapshot.sessionId) &&
      !candidates.pending.has(snapshot.sessionId)))
    return { activeRecoveryBlocks: blocked, pendingCreationSnapshots: snapshots.filter((snapshot) =>
      !candidates.pending.has(snapshot.sessionId) || blocked.has(snapshot.sessionId)) }
  } catch (error) {
    console.error('[caogen] personal task dormant recovery proof unavailable:', error)
    return ordinary
  }
}

async function findUnstartedPersonalTasks(snapshots: TaskSnapshotRecord[], rootDir: string): Promise<{
  initialized: Set<string>; pending: Set<string>
}> {
  const result = { initialized: new Set<string>(), pending: new Set<string>() }
  const records = new PersonalTaskSubmissionStore(rootDir).list()
  const registryFile = join(rootDir, 'active-sessions.json')
  if (!existsSync(registryFile)) return result
  const registry = activeSessionRecordsFromDocument<SessionMeta>(JSON.parse(readFileSync(registryFile, 'utf8')))
  for (const record of records) {
    const matches = snapshots.filter((snapshot) => snapshot.sessionId === record.binding.sessionId)
    const metas = registry.filter((meta) => meta.id === record.binding.sessionId)
    if (matches.length !== 1 || metas.length !== 1 || !hasNoDispatchClaim(record)) continue
    if (await canRestoreDormantPersonalTask(record, matches[0], metas[0], rootDir)) result.initialized.add(record.binding.sessionId)
    else if (await canRestorePendingInitialization(record, matches[0], metas[0], rootDir)) result.pending.add(record.binding.sessionId)
  }
  return result
}

function hasNoDispatchClaim(record: PersonalTaskSubmissionRecord): boolean {
  return record.dispatchClaimedAt === undefined && ['task_created', 'session_ready', 'not_sent'].includes(record.phase)
}

async function canRestorePendingInitialization(
  record: PersonalTaskSubmissionRecord, snapshot: TaskSnapshotRecord, meta: SessionMeta, rootDir: string
): Promise<boolean> {
  if (meta.sdkSessionId || snapshot.meta.sdkSessionId || snapshot.execution.sdkSessionId || record.sdkSessionId) return false
  if (meta.status !== 'starting' || snapshot.conversationLedger?.mode !== 'empty' || snapshot.transcript.length > 0) return false
  if (!hasNoSnapshotExecution(snapshot)) return false
  const draft = listPendingSessionCreations().find((candidate) => candidate.baseMeta.id === record.binding.sessionId)
  if (!draft || draft.opts.initialPrompt || draft.baseMeta.sdkSessionId) return false
  for (const candidate of [meta, snapshot.meta, draft.baseMeta]) assertPersonalSessionIdentity(record, candidate, rootDir)
  return await hasNoExecutionEvidence(record, rootDir) && !(await hasAnyTaskModelAttempt(record, rootDir))
}

async function canRestoreDormantPersonalTask(
  record: PersonalTaskSubmissionRecord, snapshot: TaskSnapshotRecord, meta: SessionMeta, rootDir: string
): Promise<boolean> {
  if (meta.status !== 'idle' || !meta.sdkSessionId || !isUnstartedSnapshot(snapshot)) return false
  assertPersonalSessionIdentity(record, meta, rootDir)
  const sdkSessionId = snapshot.execution.sdkSessionId ?? snapshot.meta.sdkSessionId
  if (sdkSessionId !== meta.sdkSessionId || !existsSync(transcriptFile(sdkSessionId))) return false
  const transcript = readTranscriptEntriesStrict(sdkSessionId)
  if (!hasCompletedInitialization(transcript)) return false
  return await hasNoExecutionEvidence(record, rootDir) && !(await hasAnyTaskModelAttempt(record, rootDir))
}

async function hasNoExecutionEvidence(record: PersonalTaskSubmissionRecord, rootDir: string): Promise<boolean> {
  const evidence = await readPersonalTaskEvidence(record, { rootDir, runtime: { get: () => undefined } })
  if (!evidence.goal || !evidence.workItem || evidence.workItem.runRefs.length > 0) return false
  if (evidence.runCount || evidence.firstMessageAccepted || evidence.hasOtherUserMessage || evidence.attemptCount || evidence.hasExecutionEffects) return false
  return true
}

function isUnstartedSnapshot(snapshot: TaskSnapshotRecord): boolean {
  if (!hasNoSnapshotExecution(snapshot) || snapshot.conversationLedger?.mode !== 'sealed') return false
  return onlyInitializationEvents(snapshot.transcript)
}

function hasNoSnapshotExecution(snapshot: TaskSnapshotRecord): boolean {
  return !snapshot.run && !snapshot.replayCandidate && !snapshot.subtasks.length && !snapshot.dagExecutions.length &&
    !snapshot.dagRuntimes?.length && snapshot.conversationLedger?.valid === true
}

function hasCompletedInitialization(entries: TranscriptEntry[]): boolean {
  const last = entries.at(-1)?.event
  return onlyInitializationEvents(entries) && last?.kind === 'status' && last.status === 'idle'
}

function onlyInitializationEvents(entries: TranscriptEntry[]): boolean {
  return entries.length > 0 && entries.every(({ event }) => event.kind === 'init' ||
    (event.kind === 'status' && (event.status === 'starting' || event.status === 'idle')))
}

async function hasAnyTaskModelAttempt(record: PersonalTaskSubmissionRecord, rootDir: string): Promise<boolean> {
  let cursor: string | undefined
  do {
    const page = await queryPersistedModelAttempts({ projectId: record.binding.workspaceId, limit: 500, cursor }, rootDir)
    if (page.attempts.some((attempt) => attempt.workItemId === record.binding.workItemId)) return true
    if (page.hasMore && !page.nextCursor) throw new Error('ModelAttempt pagination proof is incomplete')
    cursor = page.nextCursor
  } while (cursor)
  return false
}
