import { randomUUID } from 'node:crypto'
import type { ComputerHistoryDeletionPreview, ComputerHistoryPolicy, ComputerHistoryQueryResult, ComputerHistorySource, ComputerHistoryState, ComputerHistoryStatus } from '../../shared/computer-history-types'
import type { HistoryCollector } from './collector'
import { ComputerHistoryStore } from './store'
import { isExcludedBundleId, matchesHistory, parseHistoryQuery, parsePolicyInput } from './policy'
import { redactSensitiveText } from '../security/secret-redaction'

interface Dependencies { store: ComputerHistoryStore; collector: HistoryCollector; platform: string; temporary: boolean; now?(): number }
interface Preview { public: ComputerHistoryDeletionPreview; ids: Set<string> }

export class ComputerHistoryService {
  private policy: ComputerHistoryPolicy
  private status: ComputerHistoryStatus = 'disabled'
  private error?: string
  private generation = 0
  private pending?: AbortController
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false
  private started = false
  private readonly sourcesByOwner = new Map<number, { sources: ComputerHistorySource[]; expiresAt: number; controller: AbortController }>()
  private readonly sourceRequests = new Map<number, AbortController>()
  private readonly previews = new Map<number, Preview>()
  constructor(private readonly deps: Dependencies) { this.policy = deps.store.policy(); this.status = this.baseStatus() ?? 'waiting' }
  start(): void { if (!this.started && !this.disposed) { this.started = true; this.schedule() } }
  stop(): void {
    this.disposed = true; this.invalidate()
    for (const controller of this.sourceRequests.values()) controller.abort()
    this.sourceRequests.clear(); this.sourcesByOwner.clear(); this.previews.clear(); this.deps.collector.dispose?.()
  }
  state(): ComputerHistoryState {
    this.deps.store.prune(this.now())
    const rows = this.deps.store.records()
    return { policy: structuredClone(this.policy), status: this.baseStatus() ?? this.status, captureScope: 'foreground-window-title', recordCount: rows.length,
      ...(rows.length ? { lastCapturedAt: rows[rows.length - 1].capturedAt } : {}), ...(this.error ? { error: this.error } : {}) }
  }
  async sources(owner: number): Promise<ComputerHistorySource[]> {
    if (this.deps.platform !== 'darwin' || this.deps.temporary || this.disposed) return []
    this.clearSourceOwner(owner)
    const controller = new AbortController(); this.sourceRequests.set(owner, controller)
    try {
      const sources = await this.deps.collector.sources(controller.signal)
      if (controller.signal.aborted || this.disposed || this.sourceRequests.get(owner) !== controller) throw new Error('来源选择已关闭，请重新刷新。')
      this.sourcesByOwner.set(owner, { sources, expiresAt: this.now() + 5 * 60_000, controller })
      return sources.map(source => ({ ...source }))
    } finally { if (this.sourceRequests.get(owner) === controller) this.sourceRequests.delete(owner) }
  }
  update(owner: number, raw: unknown): ComputerHistoryState {
    const input = parsePolicyInput(raw)
    if (this.disposed) throw new Error('电脑历史服务已关闭。')
    if (input.expectedRevision !== this.policy.revision) throw new Error('设置已在其他窗口变更，请刷新后重试。')
    if (input.enabled && (this.deps.platform !== 'darwin' || this.deps.temporary)) throw new Error('当前平台或临时工作空间不支持电脑历史采集。')
    const approved = this.sourcesByOwner.get(owner)
    const previous = new Map(this.policy.allowedApps.map(source => [source.bundleId, source]))
    const allowedApps = input.allowedBundleIds.map(bundleId => {
      if (previous.has(bundleId)) return previous.get(bundleId)!
      const source = approved && approved.expiresAt > this.now() && !approved.controller.signal.aborted && approved.sources.find(item => item.bundleId === bundleId && !item.excludedReason)
      if (!source || isExcludedBundleId(bundleId)) throw new Error('新来源必须从本窗口最近刷新的应用列表中选择。')
      return { bundleId, name: source.name.slice(0, 160) }
    })
    const expanded = allowedApps.some(source => !previous.has(source.bundleId))
    if (((input.enabled && !this.policy.enabled) || expanded) && input.consent !== true) throw new Error('请确认只记录所选应用的前台窗口标题。')
    // Abort before persisting any policy change; in-flight results cannot cross this revision.
    this.invalidate()
    const policy: ComputerHistoryPolicy = { enabled: input.enabled, paused: input.paused, allowedApps, retentionDays: input.retentionDays, revision: this.policy.revision + 1 }
    try { this.deps.store.setPolicy(policy, this.now()); this.policy = policy; this.error = undefined; this.status = 'waiting' }
    catch { this.error = '设置未能保存，采集已停止。请检查本地存储后重试。'; this.status = 'error'; throw new Error(this.error) }
    this.schedule()
    return this.state()
  }
  query(raw: unknown): ComputerHistoryQueryResult {
    const input = parseHistoryQuery(raw)
    this.deps.store.prune(this.now())
    const all = this.deps.store.records(), filtered = all.filter(row => matchesHistory(row, input)).reverse()
    const sources = [...new Map(all.map(row => [row.bundleId, { bundleId: row.bundleId, name: row.appName }])).values()]
    return { records: filtered.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 100)), total: filtered.length, sources }
  }
  previewDelete(owner: number, raw: unknown): ComputerHistoryDeletionPreview {
    const input = parseHistoryQuery(raw, false)
    this.deps.store.prune(this.now())
    const rows = this.deps.store.records().filter(row => matchesHistory(row, input))
    const preview: ComputerHistoryDeletionPreview = { token: randomUUID(), count: rows.length, expiresAt: this.now() + 5 * 60_000,
      ...(rows.length ? { from: rows[0].capturedAt, to: rows[rows.length - 1].capturedAt } : {}) }
    this.previews.set(owner, { public: preview, ids: new Set(rows.map(row => row.id)) })
    return { ...preview }
  }
  delete(owner: number, token: unknown, reviewed: unknown): { deleted: number } {
    const preview = this.previews.get(owner)
    if (reviewed !== true || typeof token !== 'string' || !preview || preview.public.token !== token || preview.public.expiresAt <= this.now()) throw new Error('删除预览已失效，请重新预览并确认。')
    // Prevent a capture already underway from arriving immediately after deletion.
    this.invalidate()
    try {
      const deleted = this.deps.store.delete(preview.ids)
      this.previews.delete(owner); this.schedule()
      return { deleted }
    } catch { this.status = 'error'; this.error = '记录未能删除，采集已停止。请检查本地存储后重试。'; throw new Error(this.error) }
  }
  clearOwner(owner: number): void { this.clearSourceOwner(owner); this.previews.delete(owner) }
  /** Exposed for synthetic-fixture checks. Never called directly from renderer IPC. */
  async collectOnce(): Promise<void> {
    if (!this.canCollect() || this.pending) return
    const generation = this.generation, revision = this.policy.revision, controller = new AbortController()
    const allowed = this.policy.allowedApps.map(source => source.bundleId)
    this.pending = controller
    try {
      const result = await this.deps.collector.capture(allowed, controller.signal)
      if (controller.signal.aborted || generation !== this.generation || revision !== this.policy.revision || !this.canCollect()) return
      if (result.status !== 'captured') { this.status = result.status === 'permission-required' ? 'permission-required' : 'waiting'; return }
      const source = this.policy.allowedApps.find(item => item.bundleId === result.bundleId)
      if (!source || isExcludedBundleId(result.bundleId)) throw new Error('采集来源不匹配。')
      const title = redactSensitiveText(result.title).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 600)
      if (!title) { this.status = 'waiting'; return }
      const now = this.now()
      this.deps.store.prune(now)
      const rows = this.deps.store.records(), prior = rows[rows.length - 1]
      if (!prior || prior.bundleId !== source.bundleId || prior.title !== title || now - prior.capturedAt >= 5 * 60_000) {
        this.deps.store.append({ id: randomUUID(), capturedAt: now, bundleId: source.bundleId, appName: source.name, title }, now)
      }
      this.error = undefined; this.status = 'recording'
    } catch {
      if (!controller.signal.aborted && generation === this.generation) { this.status = 'error'; this.error = '采集未完成。请检查辅助功能权限与 Apple 命令行工具，再暂停并恢复重试。' }
    } finally { if (this.pending === controller) this.pending = undefined }
  }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private clearSourceOwner(owner: number): void {
    this.sourceRequests.get(owner)?.abort(); this.sourceRequests.delete(owner)
    this.sourcesByOwner.get(owner)?.controller.abort(); this.sourcesByOwner.delete(owner)
  }
  private baseStatus(): ComputerHistoryStatus | undefined {
    if (this.deps.temporary) return 'temporary'
    if (this.deps.platform !== 'darwin') return 'unsupported'
    if (!this.policy.enabled) return 'disabled'
    if (this.policy.paused) return 'paused'
    return undefined
  }
  private canCollect(): boolean { return !this.disposed && !this.baseStatus() && this.policy.allowedApps.length > 0 && this.status !== 'error' }
  private invalidate(): void { this.generation++; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.pending?.abort(); this.pending = undefined }
  private schedule(): void {
    if (!this.started || !this.canCollect() || this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.collectOnce().finally(() => this.schedule()) }, 15_000)
    this.timer.unref?.()
  }
}
