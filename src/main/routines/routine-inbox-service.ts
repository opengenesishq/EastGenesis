import { createHash, randomUUID } from 'node:crypto'
import type { RoutineRunRecord, SessionMeta } from '../../shared/types'
import type { WorkflowLedgerRendererSelection } from '../../shared/workflow-types'
import type { RoutineInboxItem, RoutineInboxMarkInput, RoutineInboxQuery, RoutineInboxResult, RoutineInboxSnapshot, RoutineInboxTask } from '../../shared/routine-inbox-types'
import { RoutineInboxReadStore } from './routine-inbox-read-store'

type Meta = Pick<SessionMeta, 'id' | 'createdAt' | 'cwd' | 'workspaceId' | 'goalId' | 'workItemId' | 'status'>
export interface RoutineInboxRuntime {
  runs(): Promise<RoutineRunRecord[]>
  meta(id: string): Meta | undefined
  ledger(run: RoutineRunRecord): Promise<WorkflowLedgerRendererSelection>
}
interface Frozen {
  owner: number; scope?: string; expiresAt: number; readRevision: number
  items: RoutineInboxItem[]; tasks: Map<string, RoutineInboxTask>
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function identity(run: RoutineRunRecord): string {
  return hash([run.id, run.routineId, run.startedAt, run.projectCwd, run.projectId, run.goalId, run.workItemId, run.sessionId, run.workflowRunId, run.heartbeat?.target])
}
export function routineInboxSourceVersion(run: RoutineRunRecord): string {
  return hash([identity(run), run.status, run.inboxStatus, run.dispatchState, run.finishedAt, run.resultObservedAt,
    run.artifactId, run.evidenceId, run.resultText, run.error, run.reviewDecision, run.reviewNote, run.reviewedAt, run.heartbeat?.phase])
}
function task(meta: Meta): RoutineInboxTask {
  return { sessionId: meta.id, sessionCreatedAt: meta.createdAt, cwd: meta.cwd,
    ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}), ...(meta.goalId ? { goalId: meta.goalId } : {}),
    ...(meta.workItemId ? { workItemId: meta.workItemId } : {}) }
}
function taskMatches(run: RoutineRunRecord, meta: Meta): boolean {
  const target = run.heartbeat?.target
  return meta.status !== 'closed' && meta.id === run.sessionId && meta.cwd === run.projectCwd &&
    (!run.projectId || meta.workspaceId === run.projectId) && (!run.goalId || meta.goalId === run.goalId) &&
    (!run.workItemId || meta.workItemId === run.workItemId) &&
    (target ? meta.createdAt === target.sessionCreatedAt && meta.id === target.sessionId && meta.cwd === target.cwd &&
      meta.workspaceId === target.workspaceId && meta.goalId === target.goalId && meta.workItemId === target.workItemId
      : meta.createdAt >= run.startedAt && (!run.finishedAt || meta.createdAt <= run.finishedAt))
}
function matchesStatus(run: RoutineRunRecord, status: RoutineInboxQuery['status']): boolean {
  if (!status || status === 'all') return true
  if (status === 'failed') return run.status === 'failed' || run.inboxStatus === 'failed' || run.inboxStatus === 'rejected'
  if (status === 'waiting') return ['waiting_approval', 'needs_review'].includes(run.inboxStatus) || run.heartbeat?.phase === 'needs_reconciliation'
  if (status === 'running') return ['queued', 'running'].includes(run.status) && run.inboxStatus !== 'waiting_approval' && run.heartbeat?.phase !== 'needs_reconciliation'
  return run.status === 'succeeded' && !['needs_review', 'waiting_approval', 'rejected'].includes(run.inboxStatus)
}
function validateQuery(input: RoutineInboxQuery): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['routineId','projectId','query','status','unreadOnly','page'].includes(key)) ||
    (['routineId','projectId','query'] as const).some(key => input[key] !== undefined && (typeof input[key] !== 'string' || input[key]!.length > 500)) ||
    input.status !== undefined && !['all','running','waiting','failed','completed'].includes(input.status) ||
    input.unreadOnly !== undefined && typeof input.unreadOnly !== 'boolean' ||
    input.page !== undefined && (!Number.isSafeInteger(input.page) || input.page < 1)) throw new Error('定时运行筛选参数无效。')
}
export class RoutineInboxService {
  private readonly snapshots = new Map<string, Frozen>()
  private readonly reads: RoutineInboxReadStore
  constructor(root: string, private readonly runtime: RoutineInboxRuntime, private readonly now = Date.now) {
    this.reads = new RoutineInboxReadStore(root)
  }
  async list(owner: number, input: RoutineInboxQuery = {}, scope?: string): Promise<RoutineInboxSnapshot> {
    validateQuery(input)
    const records = (await this.runtime.runs()).filter(run => !scope || run.sessionId === scope)
    const document = this.reads.read(), query = input.query?.trim().toLocaleLowerCase()
    const projects = [...new Map(records.filter(run => run.projectId).map(run => [run.projectId!, { id: run.projectId!, label: run.projectCwd || run.projectId! }])).values()]
    const filtered = records.filter(run => (!input.routineId || run.routineId === input.routineId) && (!input.projectId || run.projectId === input.projectId) &&
      matchesStatus(run, input.status) && (!query || [run.routineName, run.id, run.projectCwd, run.resultText, run.error].some(value => value?.toLocaleLowerCase().includes(query))))
      .sort((a,b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))
      .map(run => {
        const sourceVersion = routineInboxSourceVersion(run), receipt = document.receipts[sourceVersion]
        return { run, sourceVersion, unread: receipt ? !receipt.read : ['succeeded','failed'].includes(run.status) || ['waiting_approval','needs_review','failed','rejected'].includes(run.inboxStatus) || run.heartbeat?.phase === 'needs_reconciliation' }
      })
    const unreadCount = filtered.filter(item => item.unread).length, matching = input.unreadOnly ? filtered.filter(item => item.unread) : filtered
    const pageSize = 20, page = Math.min(input.page ?? 1, Math.max(1, Math.ceil(matching.length / pageSize)))
    const items = matching.slice((page-1)*pageSize, page*pageSize), tasks = new Map<string,RoutineInboxTask>()
    for (const item of items) {
      const meta = item.run.sessionId && this.runtime.meta(item.run.sessionId)
      if (meta && taskMatches(item.run, meta)) tasks.set(item.run.id, task(meta))
    }
    for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= this.now()) this.snapshots.delete(id)
    const owned = [...this.snapshots].filter(([, snapshot]) => snapshot.owner === owner)
    for (const [id] of owned.slice(0, Math.max(0, owned.length - 63))) this.snapshots.delete(id)
    const snapshotId = randomUUID()
    this.snapshots.set(snapshotId, { owner, scope, expiresAt: this.now() + 10*60_000, readRevision: document.revision, items: structuredClone(items), tasks })
    return { snapshotId, items, total: matching.length, page, pageSize, hasMore: page*pageSize < matching.length, unreadCount, projects }
  }
  mark(owner: number, input: RoutineInboxMarkInput, scope?: string): void {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['snapshotId','runIds','read'].includes(key)) || typeof input.read !== 'boolean' ||
      !Array.isArray(input.runIds) || input.runIds.length > 20 || input.runIds.some(id => typeof id !== 'string')) throw new Error('运行阅读参数无效。')
    const snapshot = this.require(owner, input.snapshotId, scope), wanted = new Set(input.runIds)
    const items = snapshot.items.filter(item => wanted.has(item.run.id))
    if (items.length !== wanted.size) throw new Error('运行记录不属于当前页。')
    this.reads.mark(items.map(item => item.sourceVersion), input.read, snapshot.readRevision)
  }
  async read(owner: number, snapshotId: string, runId: string, scope?: string): Promise<RoutineInboxResult> {
    const item = await this.current(owner, snapshotId, runId, scope)
    const result: RoutineInboxResult = { item }
    if (!item.run.workflowRunId) return { ...result, workflowIssue: '这次定时执行尚未生成 Run。下方保留调度状态、结果和原始失败记录。' }
    try {
      const ledger = await this.runtime.ledger(item.run), run = ledger.runs.items.find(candidate => candidate.id === item.run.workflowRunId)
      if (!run || run.sessionId !== item.run.sessionId || item.run.projectId && run.projectId !== item.run.projectId ||
        item.run.goalId && run.goalId !== item.run.goalId || item.run.workItemId && run.workItemId !== item.run.workItemId) {
        return { ...result, workflowIssue: '原 Run 不存在或身份不匹配，保留定时运行记录供核对。' }
      }
      result.detail = { runs: [run], workItems: ledger.workItems.items.filter(value => value.id === run.workItemId && value.projectId === run.projectId),
        artifacts: ledger.artifacts.items.filter(value => value.runId === run.id && value.projectId === run.projectId),
        acceptances: ledger.acceptances.items.filter(value => Boolean(run.workItemId) && value.workItemId === run.workItemId && value.projectId === run.projectId),
        evidenceLinks: ledger.evidenceLinks.items.filter(value => value.runId === run.id && value.projectId === run.projectId),
        events: ledger.events.items.filter(value => value.runId === run.id && value.projectId === run.projectId) }
      result.detailsTruncated = Object.values(ledger).some(page => page.hasMore)
    } catch {
      result.workflowIssue = '暂时无法读取原 Run 的账本详情，定时运行原始记录仍可查看。'
    }
    await this.current(owner, snapshotId, runId, scope)
    return result
  }
  async resolve(owner: number, snapshotId: string, runId: string, scope?: string): Promise<RoutineInboxTask> {
    const snapshot = this.require(owner, snapshotId, scope), item = await this.current(owner, snapshotId, runId, scope)
    const expected = snapshot.tasks.get(runId), meta = item.run.sessionId && this.runtime.meta(item.run.sessionId)
    if (!expected || !meta || !taskMatches(item.run, meta) || hash(task(meta)) !== hash(expected)) throw new Error('原任务已移除或身份已变化；本次运行记录仍可查看。')
    return expected
  }
  releaseOwner(owner: number): void { for (const [id, snapshot] of this.snapshots) if (snapshot.owner === owner) this.snapshots.delete(id) }
  private require(owner: number, id: string, scope?: string): Frozen {
    const value = typeof id === 'string' && this.snapshots.get(id)
    if (!value || value.owner !== owner || value.scope !== scope || value.expiresAt <= this.now()) throw new Error('定时运行列表已过期或不属于此窗口，请刷新。')
    return value
  }
  private async current(owner: number, snapshotId: string, runId: string, scope?: string): Promise<RoutineInboxItem> {
    const snapshot = this.require(owner, snapshotId, scope), saved = snapshot.items.find(item => item.run.id === runId)
    if (!saved) throw new Error('运行记录不属于当前页。')
    const current = (await this.runtime.runs()).find(run => run.id === runId)
    if (!current || identity(current) !== identity(saved.run) || routineInboxSourceVersion(current) !== saved.sourceVersion || scope && current.sessionId !== scope) throw new Error('这次运行记录已更新或移除，请刷新后重新打开。')
    return structuredClone(saved)
  }
}
