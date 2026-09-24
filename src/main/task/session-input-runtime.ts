import { assertScheduledInputCurrent, assertScheduledMessageCurrent } from '../routines/scheduled-input-gate'
import { join, resolve } from 'node:path'
import type { SessionInputRecord } from '../../shared/session-input-types'
import type { TranscriptEntry } from '../../shared/types'
import { sessionManager } from '../sessionManager'
import { readTranscriptEntriesStrict } from '../transcript'
import { listTaskRuns } from './task-snapshot'
import { pauseSessionContinuations } from '../routines/pause-session-continuations'
import { SessionInputService } from './session-input-service'
import { normalizeSendPayload } from '../ipc/session-message-input'
import { messagePayloadDigest } from '../message-payload-digest'
import { createProjectWorkspaceReadService } from '../project-workspace/canonical-read-service'
import { SessionFollowUpCoordinator } from './session-follow-up-coordinator'
import { pauseSessionFollowUps } from './session-follow-up-gate'
import { runHasUnresolvedEffects } from './effect-runtime'

async function acceptedInput(rootDir: string, record: SessionInputRecord): Promise<boolean> {
  const reads = createProjectWorkspaceReadService(rootDir, 'canonical')
  const workItem = record.workItemId ? await reads.getWorkItem(record.workItemId) : undefined
  if (record.workItemId && (!workItem || workItem.projectId !== record.workspaceId || workItem.goalId !== record.goalId)) {
    throw new Error('补充要求与原始任务归属不一致')
  }
  const meta = sessionManager.get(record.sessionId)?.meta
  const entries: TranscriptEntry[] = meta?.sdkSessionId
    ? readTranscriptEntriesStrict(meta.sdkSessionId)
    : sessionManager.getTranscript(record.sessionId)
  const event = entries.find(({ event }) => event.kind === 'user-message' && event.messageId === record.messageId)?.event
  if (event?.kind === 'user-message') {
    if (event.text !== record.payload.text) throw new Error('补充要求与原始对话记录不一致')
    if (event.payloadDigest !== (record.importedPayloadDigest ?? messagePayloadDigest(record.payload))) throw new Error('补充资料或修订意图缺少完整接收证据')
    const expectedAttachments = (record.payload.images ?? []).map((attachment) => ({ id: attachment.id, mime: attachment.mime, bytes: attachment.bytes }))
    const actualAttachments = event.attachments ?? []
    if (expectedAttachments.length !== actualAttachments.length || expectedAttachments.some((expected, index) => {
      const actual = actualAttachments[index]
      return actual.id !== expected.id || actual.mime !== expected.mime || actual.bytes !== expected.bytes
    })) throw new Error('补充要求附件与原始对话记录不一致')
    if (!workItem) return true
  }
  // A newly prepared Run can exist before the final stop gate permits engine delivery.
  // Automatic follow-ups require the original message event as well as any Run binding.
  if (record.followUp && event?.kind !== 'user-message') return false
  const runs = await listTaskRuns(record.sessionId, rootDir)
  return runs.some((run) => {
    const step = run.steps?.find((step) => step.messageId === record.messageId)
    if (!step) return false
    if (run.sessionId !== record.sessionId || step.requestText !== record.payload.text) {
      throw new Error('补充要求与原始运行记录不一致')
    }
    if (workItem && !workItem.runRefs.includes(run.id)) throw new Error('补充要求的运行记录尚未绑定原始任务')
    if ((record.payload.documents?.length || record.payload.images?.length || record.payload.officeRevisionIntent || record.payload.requirementRevisionIntent || record.payload.goalRevisionIntent) &&
        (event?.kind !== 'user-message' || event.payloadDigest !== (record.importedPayloadDigest ?? messagePayloadDigest(record.payload)))) return false
    return true
  })
}

const services = new Map<string, SessionInputService>()
const coordinators = new Map<string, SessionFollowUpCoordinator>()

export function scheduleSessionFollowUp(root: string, sessionId: string): void {
  getSessionInputService(root)
  coordinators.get(resolve(root))?.schedule(sessionId)
}

export function getSessionInputService(rawRoot: string): SessionInputService {
  const rootDir = resolve(rawRoot)
  const existing = services.get(rootDir)
  if (existing) return existing
  const service = new SessionInputService(rootDir, {
    meta: (id) => sessionManager.get(id)?.meta,
    afterGoalRevision: async (id) => {
      await pauseSessionContinuations(join(rootDir, 'routines'), id)
      await sessionManager.setTaskStrategy(id, 'plan')
    },
    preflight: async (record) => {
      await assertScheduledInputCurrent(rootDir, record.sessionId, record.id)
      const meta = sessionManager.get(record.sessionId)?.meta
      if (!meta) throw new Error('请先恢复原任务，再继续执行')
      if (meta.taskStrategy === 'execute') await sessionManager.assertInteractiveExecutionAuthorized(record.sessionId, '继续原任务')
    },
    send: async (id, payload) => {
      await assertScheduledMessageCurrent(rootDir, id, payload.messageId)
      const normalized = normalizeSendPayload(id, payload)
      if (!normalized || (normalized.images?.length ?? 0) !== (payload.images?.length ?? 0) ||
          (normalized.documents?.length ?? 0) !== (payload.documents?.length ?? 0)) {
        throw new Error('补充资料不再属于当前会话，请核对原任务附件')
      }
      const accepted = await sessionManager.send(id, { ...normalized, messageId: payload.messageId }, {
        readOnlyGoalStart: payload.messageId?.startsWith(`session-input:${id}:goal-start-`) === true
      })
      if (accepted) await sessionManager.persistTaskRunLifecycleBarrier(id)
      return accepted
    },
    accepted: (record) => acceptedInput(rootDir, record)
  })
  services.set(rootDir, service)
  const pausing = new Set<string>()
  const coordinator = new SessionFollowUpCoordinator(rootDir, service, {
    meta: id => sessionManager.get(id)?.meta,
    pause: async (id, messageId) => {
      pausing.add(id)
      try { await sessionManager.interrupt(id, { preserveFollowUpMessageId: messageId }) }
      finally { pausing.delete(id) }
    },
    barrier: async id => { await sessionManager.persistTaskRunLifecycleBarrier(id) },
    assertSafe: id => {
      const run = sessionManager.getTaskRun(id)
      if (runHasUnresolvedEffects(run) || (run && !['completed', 'cancelled'].includes(run.status))) {
        throw new Error('原任务仍有审批、失败或外部操作结果待处理，请核对后手动继续')
      }
      if (sessionManager.get(id)?.pendingPermissions().length) throw new Error('原任务仍有待处理的审批')
    }
  })
  coordinators.set(rootDir, coordinator)
  sessionManager.subscribe(({ sessionId, event }) => {
    if ((event.kind === 'turn-result' && event.isError && !pausing.has(sessionId)) ||
        (event.kind === 'status' && (event.status === 'closed' || (event.status === 'error' && !pausing.has(sessionId))))) {
      pauseSessionFollowUps(rootDir, sessionId)
    } else if (event.kind === 'turn-result' || (event.kind === 'status' && event.status === 'idle')) coordinator.schedule(sessionId)
  })
  return service
}
