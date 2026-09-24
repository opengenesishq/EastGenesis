import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import type { SideChatAdoption, SideChatCreateInput, SideChatSendInput, SideChatSendResult, SideChatView } from '../../shared/side-chat-types'
import type { SessionMeta } from '../../shared/types'
import { buildProjectResourceContext } from '../project-workspace/resource-context'
import { sessionManager } from '../sessionManager'
import { captureSideChatSnapshot, sideChatMessages } from './side-chat-context'
import { assertSideChatBinding, assertSideChatSource, frozenSideChatResourceContext, installSideChatSourceResolver } from './side-chat-policy'
import { getSideChatRecord, listSideChatRecords, saveSideChatRecord, sideChatId, type SideChatRecord } from './side-chat-store'
import { getSessionInputService } from '../task/session-input-runtime'
import { listHistory } from '../history'
import { withSessionOperationQueue } from '../session-operation-queue'

function root(): string { return app.getPath('userData') }
function source(id: string): SessionMeta {
  const meta = sessionManager.get(id)?.meta
  if (!meta || meta.status === 'closed') throw new Error('原任务已关闭或不存在。')
  return meta
}
function sourceRecord(record: SideChatRecord): SessionMeta {
  const meta = source(record.snapshot.source.id)
  assertSideChatSource(record, meta, true)
  return meta
}
function view(record: SideChatRecord): SideChatView {
  const meta = sessionManager.get(record.sessionId)?.meta
  const entries = meta ? sessionManager.getTranscript(record.sessionId) : []
  return {
    id: record.id, sourceSessionId: record.snapshot.source.id, sourceTitle: record.snapshot.sourceTitle,
    sessionId: record.sessionId, title: record.title, status: meta?.status ?? (record.closed ? 'closed' : 'idle'),
    capturedAt: record.snapshot.capturedAt, contextSummary: record.snapshot.text.slice(0, 500),
    omittedCount: record.snapshot.omittedCount, providerId: record.providerId, model: record.model,
    costUsd: meta?.costUsd ?? 0, messages: sideChatMessages(entries), ...(record.error ? { error: record.error } : {}), closed: record.closed
  }
}

export class SideChatService {
  constructor() { installSideChatSourceResolver((id) => sessionManager.get(id)?.meta) }

  async create(input: SideChatCreateInput): Promise<SideChatView> {
    await sessionManager.whenInitialized()
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) throw new Error('侧聊请求标识无效。')
    const parent = source(input.sourceSessionId)
    const id = sideChatId(parent.id, input.requestId)
    return withSessionOperationQueue(`side-chat:${id}`, async () => {
      let record = getSideChatRecord(root(), id)
      if (!record) {
        const resources = await buildProjectResourceContext(parent, root())
        const snapshot = captureSideChatSnapshot(parent, sessionManager.getTranscript(parent.id), resources)
        const binding = { schemaVersion: 1 as const, sideChatId: id, sourceSessionId: parent.id,
          sourceSessionCreatedAt: parent.createdAt, snapshotDigest: snapshot.digest, policy: 'context_only_v1' as const }
        record = { schemaVersion: 1, id, sessionId: id, requestId: input.requestId, binding, snapshot,
          projectId: parent.projectId, workspaceId: parent.workspaceId, unassigned: parent.unassigned, cwd: parent.cwd, title: `侧聊 · ${parent.title}`,
          providerId: parent.providerId, model: parent.model, routingScope: parent.routingScope,
          routingControl: parent.routingControl ? structuredClone(parent.routingControl) : undefined,
          businessLineId: parent.businessLineId, driveMode: parent.driveMode, budgetUsd: parent.budgetUsd, closed: false }
        // Reserve immutable identity and context before entering managed creation.
        saveSideChatRecord(root(), record)
      }
      sourceRecord(record)
      if (!record.closed) await ensureSideChatSession(record)
      return view(getSideChatRecord(root(), id)!)
    })
  }

  list(sourceSessionId: string): SideChatView[] {
    source(sourceSessionId)
    return listSideChatRecords(root())
      .filter((record) => record.snapshot.source.id === sourceSessionId && !record.closed).map(view)
  }
  get(id: string): Promise<SideChatView> {
    return withSessionOperationQueue(`side-chat:${id}`, async () => {
      const record = getSideChatRecord(root(), id)
      if (!record) throw new Error('侧聊不存在。')
      sourceRecord(record)
      if (!record.closed) await ensureSideChatSession(record)
      return view(getSideChatRecord(root(), id)!)
    })
  }
  async send(input: SideChatSendInput): Promise<SideChatSendResult> {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId) || !input.text.trim() || input.text.length > 20000) throw new Error('侧聊内容无效。')
    return withSessionOperationQueue(`side-chat:${input.sideChatId}`, async () => {
      const record = getSideChatRecord(root(), input.sideChatId)
      if (!record || record.closed) throw new Error('侧聊已关闭。')
      sourceRecord(record)
      const meta = await ensureSideChatSession(record)
      const inputs = getSessionInputService(root())
      const queued = await inputs.queue(meta.id, input.requestId, { text: input.text })
      const receipt = queued.phase === 'applied' ? queued : await inputs.apply(meta.id, input.requestId, async () => {
        sourceRecord(record)
        await frozenSideChatResourceContext(sessionManager.get(meta.id)!.meta, root())
      })
      return { view: view(getSideChatRecord(root(), record.id)!), input: receipt }
    })
  }
  async interrupt(id: string): Promise<void> { const record = getSideChatRecord(root(), id); if (!record) return; sourceRecord(record); await sessionManager.interrupt(record.sessionId) }
  async close(id: string): Promise<void> {
    return withSessionOperationQueue(`side-chat:${id}`, async () => {
      const record = getSideChatRecord(root(), id); if (!record) return
      sourceRecord(record)
      record.closed = true; saveSideChatRecord(root(), record)
      await sessionManager.close(record.sessionId)
    })
  }
  adopt(input: { sideChatId: string; messageId: string; selection?: string }): SideChatAdoption {
    const record = getSideChatRecord(root(), input.sideChatId); if (!record || record.closed) throw new Error('侧聊已关闭。')
    sourceRecord(record)
    const message = sideChatMessages(sessionManager.getTranscript(record.sessionId)).find((item) => item.id === input.messageId && item.role === 'assistant' && item.complete)
    if (!message) throw new Error('只能采纳已完成的侧聊回答。')
    const text = input.selection === undefined ? message.text : input.selection
    if (!text || !message.text.includes(text)) throw new Error('采纳片段不是该回答的原文。')
    return { adoptionId: randomUUID(), sideChatId: record.id, sourceSessionId: record.snapshot.source.id,
      sourceSessionCreatedAt: record.snapshot.source.createdAt, messageId: message.id, text, capturedAt: Date.now() }
  }
}

async function ensureSideChatSession(record: SideChatRecord): Promise<SessionMeta> {
  await sessionManager.whenInitialized()
  sourceRecord(record)
  const active = sessionManager.get(record.sessionId)?.meta
  if (active && active.status !== 'closed') { assertSideChatBinding(active, root()); return active }
  const history = listHistory().find(item => item.id === record.sessionId || Boolean(record.sdkSessionId && item.sdkSessionId === record.sdkSessionId))
  if (!history && record.sessionCreatedAt !== undefined) throw new Error('侧聊的创建或恢复记录尚未核对，请先在恢复中心恢复原侧聊；不会创建第二个会话。')
  const meta = await sessionManager.createManaged(history
    ? { cwd: record.cwd, isolated: false, resumeSdkSessionId: history.sdkSessionId, sideChat: record.binding }
    : { cwd: record.cwd, isolated: false, projectId: record.projectId, workspaceId: record.workspaceId,
        unassigned: record.unassigned ?? (!record.projectId && !record.workspaceId),
        providerId: record.providerId, model: record.model, routingScope: record.routingScope,
        businessLineId: record.businessLineId, budgetUsd: record.budgetUsd, driveMode: record.driveMode,
        taskStrategy: 'view', title: record.title, sideChat: record.binding },
    { ...(history ? {} : { reservedSessionId: record.id }), awaitStart: true, beforeStart: async created => {
      sourceRecord(record)
      assertSideChatBinding(created as SessionMeta, root())
      record.sessionCreatedAt = created.createdAt; record.sdkSessionId = created.sdkSessionId
      record.providerId = created.providerId; record.model = created.model
      saveSideChatRecord(root(), record)
    } })
  assertSideChatBinding(meta, root())
  record.sdkSessionId = meta.sdkSessionId
  saveSideChatRecord(root(), record)
  return meta
}

export const sideChatService = new SideChatService()
