import { existsSync } from 'node:fs'
import type { HistoryEntry, SessionMeta, TaskRunRecord, TranscriptEntry } from '../../shared/types'
import type { Goal, WorkItem } from '../../shared/project-workspace-types'
import { createProjectWorkspaceReadService } from '../project-workspace/canonical-read-service'
import { getTaskSnapshot, listTaskRuns } from '../task/task-snapshot'
import { queryPersistedModelAttempts } from '../task/model-attempt-api'
import { listHistory } from '../history'
import { readTranscriptEntriesStrict, transcriptFile } from '../transcript'
import { listPendingSessionCreations } from '../session-creation-journal'
import { verifyPersonalTaskDirectory } from './personal-task-directory'
import { PersonalTaskSubmissionError } from './personal-task-input'
import type { PersonalTaskSubmissionRecord } from './personal-task-submission-store'
import type { PersonalTaskRuntime } from './personal-task-runtime-types'
import { personalTaskRequestText } from './personal-task-execution'

export interface PersonalTaskEvidence {
  goal?: Goal
  workItem?: WorkItem
  session?: SessionMeta
  hasSessionRecord: boolean
  pendingCreation: boolean
  sdkSessionId?: string
  firstMessageAccepted: boolean
  acceptedRunId?: string
  hasOtherUserMessage: boolean
  attemptCount: number
  runCount: number
  hasExecutionEffects: boolean
  transcriptAvailable: boolean
}

export async function readPersonalTaskEvidence(
  record: PersonalTaskSubmissionRecord,
  dependencies: { rootDir: string; runtime: Pick<PersonalTaskRuntime, 'get'> }
): Promise<PersonalTaskEvidence> {
  const { rootDir, runtime } = dependencies
  const reads = createProjectWorkspaceReadService(rootDir, 'canonical')
  const { binding } = record
  const [goal, workItem, snapshot, runs, attempts] = await Promise.all([
    reads.getGoal(binding.goalId), reads.getWorkItem(binding.workItemId),
    getTaskSnapshot(binding.sessionId, rootDir), listTaskRuns(binding.sessionId, rootDir),
    queryPersistedModelAttempts({ requestId: record.messageId, limit: 500 }, rootDir)
  ])
  assertCanonicalTask(record, goal, workItem)
  const session = runtime.get(binding.sessionId)?.meta
  const history = listHistory().find((entry) => entry.id === binding.sessionId)
  const pending = listPendingSessionCreations().find((draft) => draft.baseMeta.id === binding.sessionId)
  const metas = [session, snapshot?.meta, history, pending?.baseMeta].filter((meta) => meta !== undefined && meta !== null)
  for (const meta of metas) assertPersonalSessionIdentity(record, meta, rootDir)
  const sdkSessionId = session?.sdkSessionId ?? snapshot?.execution.sdkSessionId ?? history?.sdkSessionId ?? record.sdkSessionId
  const transcriptAvailable = Boolean(sdkSessionId && existsSync(transcriptFile(sdkSessionId)))
  const entries = transcriptAvailable ? readTranscriptEntriesStrict(sdkSessionId!) : []
  const acceptedRunId = acceptedCanonicalRun(record, workItem, runs)
  const firstMessageAccepted = acceptedTranscriptMessage(record, entries) || Boolean(acceptedRunId)
  if (attempts.hasMore || attempts.attempts.some((attempt) =>
    attempt.projectId !== binding.workspaceId || attempt.workItemId !== binding.workItemId || attempt.goalId !== binding.goalId)) {
    conflict('模型请求记录跨越当前任务归属')
  }
  return {
    goal, workItem, session: session ? { ...session } : undefined,
    hasSessionRecord: metas.length > 0, pendingCreation: Boolean(pending), sdkSessionId,
    firstMessageAccepted, acceptedRunId,
    hasOtherUserMessage: entries.some(({ event }) => event.kind === 'user-message' && event.messageId !== record.messageId),
    attemptCount: attempts.total, runCount: runs.length,
    hasExecutionEffects: runs.some((run) => Boolean(run.effects?.length || run.toolExecutions?.length)),
    transcriptAvailable
  }
}

export function assertPersonalSessionIdentity(
  record: PersonalTaskSubmissionRecord,
  meta: Pick<SessionMeta | HistoryEntry,
    'id' | 'workspaceId' | 'goalId' | 'workItemId' | 'personalWorkspaceId' | 'businessLineId' | 'unassigned' | 'cwd' | 'experienceModeOverride'>,
  rootDir: string
): void {
  const { binding } = record
  const claims = [
    meta.id === binding.sessionId, meta.workspaceId === binding.workspaceId,
    meta.goalId === binding.goalId, meta.workItemId === binding.workItemId,
    meta.personalWorkspaceId === binding.workspaceId, meta.businessLineId === record.input.businessLineId,
    meta.unassigned === false, meta.experienceModeOverride === 'assistant'
  ]
  if (!claims.every(Boolean)) conflict('Session 与个人任务归属不一致')
  verifyPersonalTaskDirectory(rootDir, binding, meta.cwd)
}

function assertCanonicalTask(record: PersonalTaskSubmissionRecord, goal?: Goal, workItem?: WorkItem): void {
  const { binding, input } = record
  if (goal && goal.projectId !== binding.workspaceId) conflict('Goal 与提交归属不一致')
  if (!workItem) return
  if (!goal || workItem.projectId !== binding.workspaceId || workItem.goalId !== binding.goalId ||
      workItem.businessLineId !== input.businessLineId) conflict('WorkItem 与提交归属不一致')
}

function acceptedCanonicalRun(
  record: PersonalTaskSubmissionRecord, workItem: WorkItem | undefined, runs: TaskRunRecord[]
): string | undefined {
  const matches = runs.filter((run) => run.steps?.some((step) => step.messageId === record.messageId))
  if (matches.length > 1) conflict('首条消息出现在多个 Run 中')
  const run = matches[0]
  if (!run) return undefined
  if (run.sessionId !== record.binding.sessionId || !workItem?.runRefs.includes(run.id)) conflict('首条消息 Run 缺少 canonical 归属')
  if (run.steps?.some((step) => step.messageId === record.messageId && step.requestText !== personalTaskRequestText(record))) conflict('首条消息 Run 内容不一致')
  return run.id
}

function acceptedTranscriptMessage(record: PersonalTaskSubmissionRecord, entries: TranscriptEntry[]): boolean {
  const messages = entries.filter(({ event }) => event.kind === 'user-message' && event.messageId === record.messageId)
  if (messages.length > 1) conflict('首条消息在会话账本中重复')
  const event = messages[0]?.event
  if (!event || event.kind !== 'user-message') return false
  if (event.text !== personalTaskRequestText(record) || event.attachments?.length) conflict('首条消息内容与提交回执不一致')
  return true
}

function conflict(message: string): never {
  throw new PersonalTaskSubmissionError('PERSONAL_TASK_IDENTITY_CONFLICT', message)
}
