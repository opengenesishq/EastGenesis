import { resolve } from 'node:path'
import type { SessionInputRecord } from '../../shared/session-input-types'
import type { TranscriptEntry } from '../../shared/types'
import { sessionManager } from '../sessionManager'
import { readTranscriptEntriesStrict } from '../transcript'
import { listTaskRuns } from './task-snapshot'
import { SessionInputService } from './session-input-service'
import { normalizeSendPayload } from '../ipc/session-message-input'
import { messagePayloadDigest } from '../message-payload-digest'
import { createProjectWorkspaceReadService } from '../project-workspace/canonical-read-service'

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
  const runs = await listTaskRuns(record.sessionId, rootDir)
  return runs.some((run) => {
    const step = run.steps?.find((step) => step.messageId === record.messageId)
    if (!step) return false
    if (run.sessionId !== record.sessionId || step.requestText !== record.payload.text) {
      throw new Error('补充要求与原始运行记录不一致')
    }
    if (workItem && !workItem.runRefs.includes(run.id)) throw new Error('补充要求的运行记录尚未绑定原始任务')
    if ((record.payload.documents?.length || record.payload.images?.length || record.payload.officeRevisionIntent) &&
        (event?.kind !== 'user-message' || event.payloadDigest !== (record.importedPayloadDigest ?? messagePayloadDigest(record.payload)))) return false
    return true
  })
}

const services = new Map<string, SessionInputService>()

export function getSessionInputService(rawRoot: string): SessionInputService {
  const rootDir = resolve(rawRoot)
  const existing = services.get(rootDir)
  if (existing) return existing
  const service = new SessionInputService(rootDir, {
    meta: (id) => sessionManager.get(id)?.meta,
    send: async (id, payload) => {
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
  return service
}
