import { createHash, randomUUID } from 'node:crypto'
import type { AgentEvent, AgentEventIdentity, SessionMeta, SessionStatus } from '../../shared/types'
import type { TaskActivityItem, TaskActivitySnapshot, TaskActivityMarkInput, TaskActivityDestination } from '../../shared/activity-types'
import { ActivityReadStore } from './activity-read-store'

export interface ActivityEvent extends Pick<AgentEventIdentity, 'eventId' | 'streamId' | 'seq' | 'occurredAt'> {
  kind: AgentEvent['kind']; status?: string; isError?: boolean
}
export interface ActivitySource {
  meta: Pick<SessionMeta, 'id' | 'createdAt' | 'title' | 'workspaceId' | 'projectId' | 'goalId' | 'workItemId' | 'sdkSessionId'> & { status: SessionStatus }
  sessionAliases?: string[]
  active: boolean
  archived: boolean
  pendingCount: number
  runId?: string
  runStatus?: string
  historyId?: string
  recoverySnapshotId?: string
  updatedAt: number
  events: ActivityEvent[]
}
interface FrozenSnapshot {
  owner: number; scope?: string; expiresAt: number; readRevision: number; fingerprint: string; createdAt: number
  items: TaskActivityItem[]
}
export function isAttentionEvent(event: Pick<ActivityEvent, 'kind' | 'status'>): boolean {
  return event.kind === 'turn-result' || event.kind === 'permission-request' || event.kind === 'status' && event.status === 'error'
}
export function changesActivity(event: Pick<ActivityEvent, 'kind'>): boolean {
  return ['turn-result', 'permission-request', 'permission-resolved', 'status', 'user-message', 'init'].includes(event.kind)
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function identity(source: ActivitySource): string {
  const meta = source.meta
  return digest([meta.id, meta.createdAt, meta.workspaceId ?? meta.projectId ?? null, meta.goalId ?? null, meta.workItemId ?? null])
}
function readIdentity(source: ActivitySource): string {
  const meta = source.meta
  return digest([meta.sdkSessionId ? ['conversation', meta.sdkSessionId] : ['session', meta.id, meta.createdAt], meta.workspaceId ?? meta.projectId ?? null, meta.goalId ?? null, meta.workItemId ?? null])
}
/** Snapshot tokens are window-owned and freeze only source identities, not execution state. */
export class TaskActivityService {
  private readonly snapshots = new Map<string, FrozenSnapshot>()
  private readonly reads: ActivityReadStore
  constructor(root: string, private readonly sources: (fresh?: boolean) => Promise<ActivitySource[]>, private readonly now = Date.now) {
    this.reads = new ActivityReadStore(root)
  }
  async list(owner: number, sessionId?: string): Promise<TaskActivitySnapshot> {
    const sources = (await this.sources()).filter(source => !sessionId || (source.meta.id === sessionId || source.sessionAliases?.includes(sessionId)))
    const document = this.reads.read()
    const items = sources.map(source => {
      const latest = source.events.filter(isAttentionEvent).sort((a, b) => b.occurredAt - a.occurredAt || b.seq - a.seq || a.eventId.localeCompare(b.eventId))[0]
      const id = identity(source)
      const sourceVersion = digest([readIdentity(source), latest ? [latest.streamId, latest.eventId, latest.seq] : ['created', source.meta.createdAt]])
      const pending = source.pendingCount > 0 || source.runStatus === 'waiting_approval'
      const status: TaskActivityItem['status'] = pending ? 'waiting'
        : source.active && ['starting', 'running'].includes(source.meta.status) ? 'running'
        : source.runStatus === 'failed' || source.meta.status === 'error' || latest?.isError ? 'failed'
        : source.runStatus === 'completed' || latest?.kind === 'turn-result' ? 'completed'
        : !source.active && source.recoverySnapshotId && source.runStatus && !['completed', 'cancelled', 'failed'].includes(source.runStatus) ? 'recovery' : 'idle'
      return { id, sourceVersion, sessionId: source.meta.id, sessionAliases: source.sessionAliases ?? [source.meta.id], title: source.meta.title,
        projectId: source.meta.workspaceId ?? source.meta.projectId, goalId: source.meta.goalId, workItemId: source.meta.workItemId,
        runId: source.runId, historyId: source.historyId, recoverySnapshotId: source.recoverySnapshotId,
        active: source.active, archived: source.archived, status, pendingCount: source.pendingCount,
        unread: document.receipts[sourceVersion] ? !document.receipts[sourceVersion].read : Boolean(latest),
        updatedAt: Math.max(source.updatedAt, latest?.occurredAt ?? 0) }
    }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    this.prune()
    const fingerprint = digest([sessionId, document.revision, items.map(({ updatedAt: _updatedAt, ...item }) => item)])
    const createdAt = this.now()
    for (const [snapshotId, saved] of this.snapshots) {
      if (saved.owner === owner && saved.fingerprint === fingerprint) {
        saved.expiresAt = createdAt + 10 * 60_000
        return { snapshotId, createdAt: saved.createdAt, items: saved.items, unreadCount: saved.items.filter(item => item.unread && !item.archived).length }
      }
    }
    // Retain the newest 64 actionable views per window; stale actions explicitly refresh.
    const owned = [...this.snapshots].filter(([, saved]) => saved.owner === owner)
    for (const [id] of owned.slice(0, Math.max(0, owned.length - 63))) this.snapshots.delete(id)
    const snapshotId = randomUUID()
    this.snapshots.set(snapshotId, { owner, scope: sessionId, expiresAt: createdAt + 10 * 60_000, readRevision: document.revision, fingerprint, createdAt, items })
    return { snapshotId, createdAt, items, unreadCount: items.filter(item => item.unread && !item.archived).length }
  }
  mark(owner: number, input: TaskActivityMarkInput, scope?: string): void {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['snapshotId', 'itemIds', 'read'].includes(key)) ||
      typeof input.read !== 'boolean' || input.itemIds !== undefined && (!Array.isArray(input.itemIds) || input.itemIds.length > 10000 || input.itemIds.some(id => typeof id !== 'string'))) throw new Error('活动已读参数无效。')
    const snapshot = this.requireSnapshot(owner, input.snapshotId, scope)
    const wanted = input.itemIds ? new Set(input.itemIds) : undefined
    const items = wanted ? snapshot.items.filter(item => wanted.has(item.id)) : snapshot.items
    if (wanted && items.length !== wanted.size) throw new Error('活动项不属于当前列表。')
    this.reads.mark(items.map(item => item.sourceVersion), input.read, snapshot.readRevision)
  }
  async resolveSource(owner: number, snapshotId: string, itemId: string, scope?: string): Promise<ActivitySource> {
    const snapshot = this.requireSnapshot(owner, snapshotId, scope), item = snapshot.items.find(candidate => candidate.id === itemId)
    if (!item) throw new Error('活动项不属于当前列表。')
    const source = (await this.sources(true)).find(candidate => identity(candidate) === item.id && candidate.meta.id === item.sessionId)
    if (!source) throw new Error('原任务已移除或身份已变化，请刷新活动。')
    if (source.runId !== item.runId) throw new Error('任务运行已变化，请刷新活动后打开。')
    return source
  }
  async resolve(owner: number, snapshotId: string, itemId: string, scope?: string): Promise<TaskActivityDestination> {
    const source = await this.resolveSource(owner, snapshotId, itemId, scope)
    return { kind: source.active ? 'session' : source.historyId ? 'history' : 'recovery', sessionId: source.meta.id,
      historyId: source.historyId, recoverySnapshotId: source.recoverySnapshotId }
  }
  releaseOwner(owner: number): void { for (const [id, snapshot] of this.snapshots) if (snapshot.owner === owner) this.snapshots.delete(id) }
  private requireSnapshot(owner: number, id: string, scope?: string): FrozenSnapshot {
    const snapshot = typeof id === 'string' && this.snapshots.get(id)
    if (!snapshot || snapshot.owner !== owner || snapshot.scope !== scope || snapshot.expiresAt <= this.now()) throw new Error('活动列表已过期或不属于此窗口，请刷新。')
    return snapshot
  }
  private prune(): void { for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= this.now()) this.snapshots.delete(id) }
}
