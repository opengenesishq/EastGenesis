import { app } from 'electron'
import type { SessionEventPayload, TranscriptEntry } from '../../shared/types'
import type { TaskActivityRecord } from '../../shared/activity-types'
import { listHistory } from '../history'
import { sessionManager } from '../sessionManager'
import { readEventReceipts, readTranscriptEntriesStrict } from '../transcript'
import { taskRuntimeRegistry } from '../task/task-runtime-registry'
import { TaskActivityService, changesActivity, isAttentionEvent, type ActivityEvent, type ActivitySource } from './activity-service'

const liveEvents = new Map<string, ActivityEvent>()
let service: TaskActivityService | undefined
export function activityService(): TaskActivityService {
  return service ??= new TaskActivityService(app.getPath('userData'), loadActivitySources)
}
export function observeActivity(payload: SessionEventPayload): boolean {
  if (isAttentionEvent(payload.event)) liveEvents.set(payload.sessionId, eventView({ ...payload, ...payload.event }))
  return changesActivity(payload.event)
}
function eventView(event: ActivityEvent): ActivityEvent {
  return { eventId: event.eventId, streamId: event.streamId, seq: event.seq, occurredAt: event.occurredAt,
    kind: event.kind, status: event.status, isError: event.isError }
}
function transcriptEvents(entries: readonly TranscriptEntry[]): ActivityEvent[] {
  return entries.filter(entry => entry.eventId && entry.streamId && typeof entry.occurredAt === 'number' && isAttentionEvent(entry.event))
    .map(entry => eventView({ eventId: entry.eventId!, streamId: entry.streamId!, seq: entry.seq, occurredAt: entry.occurredAt!, ...entry.event }))
}
/** Read canonical Session/history/snapshot identities, and reuse the existing event receipt files. */
let cachedSources: ActivitySource[] | undefined, cachedAt = 0
let pendingSources: Promise<ActivitySource[]> | undefined
export async function loadActivitySources(fresh = false): Promise<ActivitySource[]> {
  if (!fresh && cachedSources && Date.now() - cachedAt < 1000) return cachedSources
  if (!fresh && pendingSources) return pendingSources
  const pending = readActivitySources().then(sources => { cachedSources = sources; cachedAt = Date.now(); return sources })
  if (fresh) return pending
  pendingSources = pending
  try { return await pending } finally { if (pendingSources === pending) pendingSources = undefined }
}
async function readActivitySources(): Promise<ActivitySource[]> {
  const catalog = new Map<string, ActivitySource>()
  for (const history of listHistory()) catalog.set(history.id, { meta: { ...history, status: 'closed' }, active: false,
    archived: history.archived === true, pendingCount: 0, historyId: history.id, updatedAt: history.updatedAt, events: [] })
  for (const snapshot of await sessionManager.listTaskSnapshots()) {
    const previous = catalog.get(snapshot.sessionId)
    if (previous?.recoverySnapshotId && previous.updatedAt > snapshot.updatedAt) continue
    catalog.set(snapshot.sessionId, { meta: snapshot.meta, active: false, archived: previous?.archived ?? false,
      pendingCount: 0, historyId: previous?.historyId, recoverySnapshotId: snapshot.id, runId: snapshot.run?.id,
      runStatus: snapshot.run?.status, updatedAt: Math.max(previous?.updatedAt ?? 0, snapshot.updatedAt), events: transcriptEvents(snapshot.transcript) })
  }
  for (const meta of sessionManager.list()) {
    if (meta.status === 'closed') continue
    const previous = catalog.get(meta.id), run = taskRuntimeRegistry.get(meta.id)
    catalog.set(meta.id, { ...previous, meta, active: true, archived: previous?.archived ?? false,
      pendingCount: sessionManager.get(meta.id)?.pendingPermissions().length ?? 0,
      runId: run?.id ?? previous?.runId, runStatus: run?.status ?? previous?.runStatus,
      updatedAt: Math.max(meta.createdAt, previous?.updatedAt ?? 0, run?.updatedAt ?? 0),
      events: [...(previous?.events ?? []), ...transcriptEvents(sessionManager.getTranscript(meta.id))] })
  }
  for (const source of catalog.values()) {
    const sdkId = source.meta.sdkSessionId
    // The path component is resolved from trusted stored metadata and remains a single filename.
    if (sdkId && /^[A-Za-z0-9:_-]{1,200}$/.test(sdkId)) source.events.push(...readEventReceipts(sdkId).filter(isAttentionEvent))
    const live = liveEvents.get(source.meta.id)
    if (live) source.events.push(live)
    source.sessionAliases = [source.meta.id]
  }
  // History resumption can replace only the local Session ID. Collapse aliases
  // solely within the same conversation AND canonical task ownership.
  const groups = new Map<string, ActivitySource[]>()
  for (const source of catalog.values()) {
    const meta = source.meta
    const key = meta.sdkSessionId ? JSON.stringify([meta.sdkSessionId, meta.workspaceId ?? meta.projectId, meta.goalId, meta.workItemId]) : meta.id
    groups.set(key, [...(groups.get(key) ?? []), source])
  }
  return [...groups.values()].flatMap(group => {
    const active = group.filter(source => source.active)
    if (active.length > 1) return group // Ambiguous concurrent identities stay explicit.
    const target = active[0] ?? [...group].sort((a, b) => b.meta.createdAt - a.meta.createdAt || b.updatedAt - a.updatedAt)[0]
    target.sessionAliases = group.map(source => source.meta.id)
    target.historyId ??= group.find(source => source.historyId)?.historyId
    target.archived = group.some(source => source.archived)
    return [target]
  })
}

/** Read the original transcript without resuming it or creating an execution. */
export async function readActivityRecord(owner: number, snapshotId: string, itemId: string, scope?: string): Promise<TaskActivityRecord> {
  const source = await activityService().resolveSource(owner, snapshotId, itemId, scope)
  let entries = source.active ? sessionManager.getTranscript(source.meta.id) : []
  if (!entries.length && source.meta.sdkSessionId) {
    if (!/^[A-Za-z0-9:_-]{1,200}$/.test(source.meta.sdkSessionId)) throw new Error('原任务记录标识无效。')
    entries = readTranscriptEntriesStrict(source.meta.sdkSessionId)
  }
  if (!entries.length && source.recoverySnapshotId) {
    const snapshot = (await sessionManager.listTaskSnapshots()).find(item => item.id === source.recoverySnapshotId && item.sessionId === source.meta.id)
    entries = snapshot?.transcript ?? []
  }
  await activityService().resolveSource(owner, snapshotId, itemId, scope)
  const messages: TaskActivityRecord['messages'] = []
  for (const { event } of entries) {
    if (event.kind === 'user-message') messages.push({ role: 'user', text: event.text })
    else if (event.kind === 'assistant-message') {
      const text = event.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (text) messages.push({ role: 'assistant', text })
    } else if (event.kind === 'turn-result' && event.resultText && messages[messages.length - 1]?.text !== event.resultText) {
      messages.push({ role: 'assistant', text: event.resultText })
    }
  }
  const recent = messages.slice(-100)
  let characters = 0, truncated = recent.length < messages.length
  for (let index = recent.length - 1; index >= 0; index--) {
    const remaining = 200_000 - characters
    if (recent[index].text.length > remaining) { recent[index] = { ...recent[index], text: recent[index].text.slice(-remaining) }; truncated = true }
    characters += recent[index].text.length
    if (characters >= 200_000 && index > 0) { recent.splice(0, index); truncated = true; break }
  }
  return { sessionId: source.meta.id, title: source.meta.title, messages: recent, truncated }
}
