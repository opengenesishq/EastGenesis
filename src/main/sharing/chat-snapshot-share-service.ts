import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SessionMeta, TranscriptEntry } from '../../shared/types'
import type { ChatShareAdapterInput, ChatShareOperationInput, ChatShareOperationPreview, ChatShareReceipt, ChatSnapshotContent, ChatSnapshotShareState, ChatSnapshotSource, PrepareChatSnapshotInput } from '../../shared/chat-snapshot-share-types'
import type { SiteDeploymentTarget } from '../../shared/site-deployment-types'
import { hostedProgramDigest } from '../sites/hosted-site-program'
import { runSiteProcess, validateSiteTarget, type SiteProcessHandle, type SiteProcessResult } from '../sites/site-deployment-process'
import { withSiteStateLock } from '../sites/site-operation-lock'
import { redactSensitiveText } from '../security/secret-redaction'
import { ChatSnapshotStore, type ChatSnapshotOwner, type StoredChatShareAdapter, type StoredChatSharePreview, type StoredChatShareReceipt, type StoredChatSnapshot } from './chat-snapshot-store'
import { capturePublicChat, chatShareBytesDigest, chatShareDigest, publicChatHtml, selectPublicChat } from './chat-snapshot-projection'
import { CHAT_SHARE_PROTOCOL, parseChatShareResponse, requireChatShareCapabilities, type ChatShareRequest, type ChatShareResponse } from './chat-share-protocol'

export interface ChatShareScope { owner: number; sessionId?: string; assertCurrent(): void }
export interface ChatShareEffectOutcome { status: 'completed' | 'failed' | 'waiting_reconciliation'; operationId: string; effectId?: string; snapshotId?: string; value?: SiteProcessResult; error?: string }
export interface ChatShareHost {
  root: string; home: string; session(id: string): SessionMeta | undefined; transcript(id: string): TranscriptEntry[]
  targets(id: string): Promise<SiteDeploymentTarget[]>
  authority(source: ChatSnapshotOwner, mode: 'publish' | 'manage'): string
  authorize(source: ChatSnapshotOwner, mode: 'publish' | 'manage', command: string, authorityKey: string): Promise<void>
  effect(source: ChatSnapshotOwner, request: ChatShareRequest, execute: () => Promise<SiteProcessResult>, success: (value: SiteProcessResult) => boolean): Promise<ChatShareEffectOutcome>
  now?(): number
}
interface Source { view: ChatSnapshotSource; owner: ChatSnapshotOwner; sourceDigest: string; paths: string[]; window: number }
interface Context { adapter: StoredChatShareAdapter; source: ChatSnapshotOwner; mode: 'publish' | 'manage'; executableDigest: string; environmentDigest: string; authorityKey: string }
interface Active { window: number; sessionId: string; cancelled: boolean; handle?: SiteProcessHandle }
const environmentDigest = (adapter: StoredChatShareAdapter): string => chatShareDigest(adapter.view.environmentKeys.map(key => [key, process.env[key] ?? null]))
const errorText = (cause: unknown): string => redactSensitiveText(cause instanceof Error ? cause.message : String(cause)).slice(0,1500)
const sourceOwner = (meta: SessionMeta): ChatSnapshotOwner => ({ id: meta.id, createdAt: meta.createdAt, cwd: meta.cwd,
  ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}), ...(meta.goalId ? { goalId: meta.goalId } : {}), ...(meta.workItemId ? { workItemId: meta.workItemId } : {}) })
const requestCommand = (adapter: StoredChatShareAdapter, request: ChatShareRequest): string => `${[adapter.view.executable, ...adapter.view.args].map(value => `'${value.replace(/'/g,"'\\''")}'`).join(' ')} <<'CAOGEN_CHAT_SHARE_REQUEST'\n${JSON.stringify(request)}\nCAOGEN_CHAT_SHARE_REQUEST`

export class ChatSnapshotShareService {
  readonly store: ChatSnapshotStore
  private sources = new Map<string,Source>()
  private previews = new Map<string,StoredChatSharePreview>()
  private active = new Map<string,Active>()
  constructor(private readonly host: ChatShareHost) { this.store = new ChatSnapshotStore(host.root) }
  private now(): number { return this.host.now?.() ?? Date.now() }
  private lock<T>(action: () => Promise<T>): Promise<T> { return withSiteStateLock(this.host.root, action) }
  private document() {
    const document = this.store.read()
    for (const row of document.receipts) if (row.view.status === 'executing' && !this.active.has(row.view.operationId)) {
      row.view.status = 'needs_reconciliation'; row.view.publicState = 'unknown'; row.view.error = '原适配器进程已结束，须核对原操作；不会自动重发。'
      row.view.recoverySnapshotId ??= `operation:${row.view.operationId}`
    }
    return document
  }
  private scope(scope: ChatShareScope, sessionId: string): void { scope.assertCurrent(); if (scope.sessionId && scope.sessionId !== sessionId) throw new Error('此分享不属于当前任务窗口。') }
  private snapshot(id: string, scope: ChatShareScope): StoredChatSnapshot {
    const value = this.document().snapshots.find(item => item.view.id === id)
    if (!value) throw new Error('聊天快照不存在。')
    this.scope(scope, value.owner.id); return value
  }
  private assertSource(owner: ChatSnapshotOwner): SessionMeta {
    const current = this.host.session(owner.id)
    if (!current || current.status === 'closed' || current.sideChat || chatShareDigest(sourceOwner(current)) !== chatShareDigest(owner)) throw new Error('原任务已关闭或归属已变化，请从原任务重新生成快照。')
    return current
  }
  capture(sessionId: string, scope: ChatShareScope): ChatSnapshotSource {
    this.scope(scope, sessionId)
    const meta = this.host.session(sessionId)
    if (!meta || meta.status === 'closed' || meta.sideChat) throw new Error('请从可用的原任务捕获聊天正文。')
    const entries = this.host.transcript(sessionId), paths = [this.host.home, meta.cwd], view = capturePublicChat(meta, entries, paths, this.now())
    for (const [id,value] of this.sources) if (value.view.expiresAt <= this.now() || value.window === scope.owner) this.sources.delete(id)
    this.sources.set(view.id, { view, owner: sourceOwner(meta), sourceDigest: chatShareDigest(entries), paths, window: scope.owner })
    return structuredClone(view)
  }
  async prepareSnapshot(sessionId: string, input: PrepareChatSnapshotInput, scope: ChatShareScope): Promise<ChatSnapshotContent> {
    this.scope(scope, sessionId)
    const source = input && this.sources.get(input.sourcePreviewId)
    if (!source || source.window !== scope.owner || source.owner.id !== sessionId || source.view.expiresAt <= this.now()) throw new Error('脱敏预览已过期或不属于当前窗口。')
    this.assertSource(source.owner)
    if (chatShareDigest(this.host.transcript(sessionId)) !== source.sourceDigest) throw new Error('原对话已变化，请重新捕获后选择要分享的消息。')
    const selected = selectPublicChat(source.view, input, source.paths), id = randomUUID(), html = publicChatHtml(selected.title, selected.messages, source.view.capturedAt)
    const snapshot: StoredChatSnapshot = { owner: source.owner, sourceDigest: source.sourceDigest, messages: selected.messages, htmlDigest: chatShareBytesDigest(html), paths: source.paths,
      view: { id, sessionId, title: selected.title, capturedAt: source.view.capturedAt, createdAt: this.now(), messageCount: selected.messages.length, bytes: Buffer.byteLength(html), digest: chatShareBytesDigest(html), redactedMessages: selected.redactedMessages } }
    await this.lock(async () => {
      this.scope(scope, sessionId); this.assertSource(source.owner)
      if (chatShareDigest(this.host.transcript(sessionId)) !== source.sourceDigest) throw new Error('原对话已变化，请重新捕获。')
      const document = this.document()
      if (document.snapshots.length >= 1000) throw new Error('本机已保存 1000 份快照，暂时无法继续生成。')
      this.store.saveHtml(id, html); document.snapshots.push(snapshot); this.store.write(document)
    })
    return { snapshot: snapshot.view, messages: selected.messages, html }
  }
  readSnapshot(id: string, scope: ChatShareScope): ChatSnapshotContent {
    const snapshot = this.snapshot(id, scope)
    return { snapshot: snapshot.view, messages: snapshot.messages, html: this.store.readHtml(snapshot) }
  }
  list(scope: ChatShareScope, sessionId?: string): ChatSnapshotShareState {
    scope.assertCurrent(); if (sessionId) this.scope(scope, sessionId)
    const filter = scope.sessionId ?? sessionId, document = this.document()
    return { snapshots: document.snapshots.filter(item => !filter || item.owner.id === filter).map(item => item.view).reverse(),
      adapters: document.adapters.filter(item => !filter || item.view.sessionId === filter).map(item => item.view),
      receipts: document.receipts.filter(item => !filter || item.view.sessionId === filter).map(item => item.view).reverse() }
  }
  async saveAdapter(sessionId: string, input: ChatShareAdapterInput, scope: ChatShareScope) {
    this.scope(scope, sessionId)
    const meta = this.host.session(sessionId)
    if (!meta || meta.status === 'closed' || meta.sideChat) throw new Error('请从原任务配置分享适配器。')
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['id','revision','name','deploymentTargetId','deploymentTargetRevision','args'].includes(key)) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw new Error('分享适配器配置无效。')
    const target = (await this.host.targets(sessionId)).find(value => value.id === input.deploymentTargetId)
    if (!target || target.revision !== input.deploymentTargetRevision) throw new Error('原部署配置已变化，请重新选择。')
    const checked = validateSiteTarget({ ...target, management: { protocol: 'caogen-site-management/1', siteId: 'chat-share-adapter', args: input.args } })
    // Resolve existing script/file arguments now, so revocation remains usable after the task directory is removed.
    const args = await Promise.all(checked.management!.args.map(async arg => {
      if (arg.startsWith('-')) return arg
      try { const path = await realpath(resolve(meta.cwd, arg)); return (await lstat(path)).isFile() ? path : arg }
      catch { return arg }
    }))
    return this.lock(async () => {
      this.scope(scope, sessionId); this.assertSource(sourceOwner(meta))
      const document = this.document(), old = input.id ? document.adapters.find(value => value.view.id === input.id) : undefined
      if (input.id && (!old || old.view.sessionId !== sessionId || old.view.revision !== input.revision)) throw new Error('分享适配器版本已变化。')
      if (document.receipts.some(row => row.view.adapterId === input.id && ['executing','needs_reconciliation'].includes(row.view.status))) throw new Error('该适配器仍有执行或待核对记录。')
      if (!old && document.adapters.length >= 100) throw new Error('分享适配器超过 100 个。')
      const view = { id: old?.view.id ?? randomUUID(), revision: (old?.view.revision ?? 0) + 1, name: input.name.trim(), sessionId,
        deploymentTargetId: target.id, deploymentTargetRevision: target.revision, executable: checked.executable, args,
        environmentKeys: checked.environmentKeys, timeoutSeconds: Math.min(checked.timeoutSeconds, 120) }
      const saved: StoredChatShareAdapter = { view, target: { ...checked, management: { ...checked.management!, args }, timeoutSeconds: view.timeoutSeconds } }
      document.adapters = [...document.adapters.filter(value => value.view.id !== view.id), saved]; this.store.write(document); return view
    })
  }
  operationTarget(input: ChatShareOperationInput, scope: ChatShareScope): { snapshot: StoredChatSnapshot; adapter: StoredChatShareAdapter; publication?: StoredChatShareReceipt } {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['action','snapshotId','adapterId','shareId'].includes(key)) || !['publish','revoke'].includes(input.action)) throw new Error('分享操作无效。')
    const snapshot = this.snapshot(input.snapshotId, scope), document = this.document()
    const publication = input.action === 'revoke' ? document.receipts.find(row => row.view.shareId === input.shareId && row.view.action === 'publish' && row.view.status === 'confirmed' && row.view.snapshotId === input.snapshotId) : undefined
    if (input.action === 'revoke' && !publication) throw new Error('撤销必须引用原已确认的分享。')
    const adapter = document.adapters.find(value => value.view.id === (publication?.view.adapterId ?? input.adapterId))
    if (!adapter || adapter.view.sessionId !== snapshot.owner.id) throw new Error('未配置原任务的分享适配器。')
    if (input.action === 'publish') this.assertSource(snapshot.owner)
    else if (scope.sessionId && !this.host.session(snapshot.owner.id)) throw new Error('原任务已移除，请从主工作台管理已发布分享。')
    return { snapshot, adapter, publication }
  }
  async prepareOperation(input: ChatShareOperationInput, scope: ChatShareScope): Promise<ChatShareOperationPreview> {
    const { snapshot, adapter, publication } = this.operationTarget(input, scope)
    this.assertAvailable(snapshot.view.id, adapter.view.id, publication?.view.shareId)
    if (input.action === 'publish') this.store.readHtml(snapshot)
    const context = await this.context(snapshot.owner, adapter, input.action === 'publish' ? 'publish' : 'manage')
    const describe = this.request('describe', randomUUID(), publication ? this.accountFields(publication.view.account) : {})
    const account = (await this.query(context, describe, scope)).account
    requireChatShareCapabilities(account)
    const id = randomUUID(), operationId = `chat-share-${id}`, shareId = publication?.view.shareId ?? randomUUID()
    const request = this.request(input.action, operationId, { ...this.accountFields(account), shareId, snapshotId: snapshot.view.id,
      manifestDigest: snapshot.view.digest, ...(publication ? { expectedRevision: publication.view.revision } : { directory: this.store.bundle(snapshot.view.id) }) })
    const view: ChatShareOperationPreview = { id, operationId, action: input.action, snapshot: snapshot.view, adapter: adapter.view, account, shareId,
      ...(publication ? { expectedRevision: publication.view.revision } : {}), command: [adapter.view.executable,...adapter.view.args], createdAt: this.now(), expiresAt: this.now()+10*60_000 }
    await this.check(context, request, scope)
    this.assertAvailable(snapshot.view.id, adapter.view.id, publication?.view.shareId)
    for (const [key,preview] of this.previews) if (preview.view.expiresAt <= this.now()) this.previews.delete(key)
    if ([...this.previews.values()].filter(item => item.ownerWindow === scope.owner).length >= 20) throw new Error('待确认分享过多，请等待旧预览过期。')
    this.previews.set(id, { view, adapter, request, executableDigest: context.executableDigest, environmentDigest: context.environmentDigest, authorityKey: context.authorityKey, ownerWindow: scope.owner })
    return view
  }
  preview(id: string, scope: ChatShareScope): ChatShareOperationPreview {
    const saved = this.previews.get(id)
    if (!saved || saved.ownerWindow !== scope.owner || saved.view.expiresAt <= this.now()) throw new Error('分享操作预览已过期或不属于此窗口。')
    this.scope(scope, saved.view.snapshot.sessionId); return saved.view
  }
  async execute(id: string, scope: ChatShareScope): Promise<ChatShareReceipt> {
    this.preview(id, scope)
    const saved = this.previews.get(id)!, source = this.snapshot(saved.view.snapshot.id, scope)
    const context: Context = { adapter: saved.adapter, source: source.owner, mode: saved.view.action === 'publish' ? 'publish' : 'manage', executableDigest: saved.executableDigest, environmentDigest: saved.environmentDigest, authorityKey: saved.authorityKey }
    const existing = this.document().receipts.find(row => row.view.id === id)
    if (existing) return existing.view
    await this.check(context, saved.request, scope)
    if (saved.view.action === 'publish') this.store.readHtml(source)
    const claimed = await this.lock(async () => {
      const document = this.document(), repeated = document.receipts.find(row => row.view.id === id)
      if (repeated) return { view: repeated.view, existing: true }
      this.assertAvailable(source.view.id, saved.adapter.view.id, saved.view.action === 'revoke' ? saved.view.shareId : undefined)
      this.scope(scope, source.owner.id)
      const receipt: ChatShareReceipt = { id, snapshotId: source.view.id, sessionId: source.owner.id, adapterId: saved.adapter.view.id, adapterName: saved.adapter.view.name,
        action: saved.view.action, operationId: saved.view.operationId, shareId: saved.view.shareId, manifestDigest: source.view.digest, account: saved.view.account,
        expectedRevision: saved.view.expectedRevision, status: 'executing', publicState: 'unknown', startedAt: this.now() }
      document.receipts.push({ view: receipt, preview: saved }); this.store.write(document)
      this.active.set(receipt.operationId, { window: scope.owner, sessionId: source.owner.id, cancelled: false }); return { view: receipt, existing: false }
    })
    const view = claimed.view
    if (claimed.existing) return view
    let next = { ...view }
    try {
      const outcome = await this.invoke(context, saved.request, scope), response = outcome.value ? this.response(outcome.value, saved.request) : undefined
      next.effectId = outcome.effectId
      if (outcome.status !== 'completed' || !response || response.result === 'unknown') {
        next.status = 'needs_reconciliation'; next.error = outcome.error ?? '分享结果未知，请核对原操作。'; next.recoverySnapshotId = outcome.snapshotId ?? `operation:${view.operationId}`
      } else next = this.applyResponse(next, response)
    } catch (cause) { next.status = 'needs_reconciliation'; next.error = errorText(cause); next.recoverySnapshotId = `operation:${view.operationId}` }
    finally { this.active.delete(view.operationId) }
    next.finishedAt = this.now()
    await this.lock(async () => { const document = this.document(), row = document.receipts.find(item => item.view.id === id)!; row.view = next; this.store.write(document) })
    return next
  }
  receipt(id: string, scope: ChatShareScope): StoredChatShareReceipt {
    const row = this.document().receipts.find(item => item.view.id === id)
    if (!row) throw new Error('分享操作记录不存在。')
    this.scope(scope, row.view.sessionId); return row
  }
  async inspect(id: string, scope: ChatShareScope): Promise<ChatShareReceipt> {
    const row = this.receipt(id, scope)
    if (row.view.status !== 'needs_reconciliation' || this.active.has(row.view.operationId)) throw new Error('仅可核对已停止且结果未知的原操作。')
    const snapshot = this.snapshot(row.view.snapshotId, scope), context = await this.context(snapshot.owner, row.preview.adapter, 'manage')
    const request = { ...row.preview.request, requestId: randomUUID(), operation: 'inspect' as const, originalAction: row.view.action }
    delete request.directory
    const response = await this.query(context, request, scope)
    if (response.result === 'unknown') return row.view
    if (response.result !== 'applied' && response.result !== 'not_applied') throw new Error('适配器未能确认原操作。')
    await this.lock(async () => {
      this.scope(scope, row.view.sessionId)
      const document = this.document(), current = document.receipts.find(item => item.view.id === id)!
      if (current.view.status !== 'needs_reconciliation') throw new Error('原分享操作状态已变化，请刷新。')
      current.inspection = { result: response.result as 'applied' | 'not_applied', response }; this.store.write(document)
    })
    return this.receipt(id, scope).view
  }
  async acceptInspection(id: string, scope: ChatShareScope): Promise<ChatShareReceipt> {
    return this.lock(async () => {
      const document = this.document(), row = document.receipts.find(item => item.view.id === id)
      if (!row?.inspection) throw new Error('尚无原操作核对结果。')
      this.scope(scope, row.view.sessionId)
      row.view = this.applyResponse(row.view, row.inspection.response); this.store.write(document); return row.view
    })
  }
  cancel(operationId: string, scope: ChatShareScope): boolean {
    scope.assertCurrent(); const active = this.active.get(operationId)
    if (!active || active.window !== scope.owner || scope.sessionId && scope.sessionId !== active.sessionId) return false
    active.cancelled = true; active.handle?.cancel(); return true
  }
  releaseOwner(owner: number): void {
    for (const [id,source] of this.sources) if (source.window === owner) this.sources.delete(id)
    for (const [id,preview] of this.previews) if (preview.ownerWindow === owner) this.previews.delete(id)
    for (const active of this.active.values()) if (active.window === owner) { active.cancelled = true; active.handle?.cancel() }
  }
  dispose(): void { for (const active of this.active.values()) { active.cancelled = true; active.handle?.cancel() }; this.sources.clear(); this.previews.clear() }
  private applyResponse(view: ChatShareReceipt, response: ChatShareResponse): ChatShareReceipt {
    return { ...view, status: response.result === 'applied' ? 'confirmed' : 'not_applied', publicState: response.publicState!, revision: response.revision,
      url: response.url ?? view.url, finishedAt: this.now(), error: undefined, recoverySnapshotId: undefined }
  }
  private assertAvailable(snapshotId: string, adapterId: string, shareId?: string): void {
    const rows = this.document().receipts.filter(row => row.view.snapshotId === snapshotId && row.view.adapterId === adapterId)
    if (rows.some(row => ['executing','needs_reconciliation'].includes(row.view.status))) throw new Error('该快照还有执行或待核对操作。')
    if (shareId) { if (rows.some(row => row.view.shareId === shareId && row.view.action === 'revoke' && row.view.status === 'confirmed')) throw new Error('原分享已经撤销。') }
    else if (rows.some(row => row.view.action === 'publish' && row.view.status === 'confirmed' && !rows.some(other => other.view.shareId === row.view.shareId && other.view.action === 'revoke' && other.view.status === 'confirmed'))) throw new Error('这份快照已经发布，请使用现有链接或先撤销。')
  }
  private async context(source: ChatSnapshotOwner, adapter: StoredChatShareAdapter, mode: Context['mode']): Promise<Context> {
    return { source, adapter, mode, executableDigest: await hostedProgramDigest(adapter.target, this.store.adapterCwd), environmentDigest: environmentDigest(adapter), authorityKey: this.host.authority(source, mode) }
  }
  private async check(context: Context, request: ChatShareRequest, scope: ChatShareScope): Promise<void> {
    this.scope(scope, context.source.id)
    if (context.mode === 'publish') this.assertSource(context.source)
    if (scope.sessionId && !this.host.session(context.source.id)) throw new Error('请从主工作台管理原任务已移除的分享。')
    const current = this.document().adapters.find(item => item.view.id === context.adapter.view.id)
    if (!current || chatShareDigest(current) !== chatShareDigest(context.adapter) || await hostedProgramDigest(context.adapter.target, this.store.adapterCwd) !== context.executableDigest || environmentDigest(context.adapter) !== context.environmentDigest) throw new Error('分享适配器配置、程序或环境已变化，请重新预览。')
    if (this.host.authority(context.source, context.mode) !== context.authorityKey) throw new Error('分享操作授权已变化，请重新确认。')
    await this.host.authorize(context.source, context.mode, requestCommand(context.adapter, request), context.authorityKey)
    this.scope(scope, context.source.id)
  }
  private request(operation: ChatShareRequest['operation'], operationId: string, extra: Partial<ChatShareRequest> = {}): ChatShareRequest {
    return { protocol: CHAT_SHARE_PROTOCOL, requestId: randomUUID(), operationId, operation, ...extra }
  }
  private accountFields(account: import('../../shared/chat-snapshot-share-types').ChatShareAccount) { return { adapterNamespace: account.adapterNamespace, accountScope: account.accountScope, targetId: account.targetId } }
  private response(output: SiteProcessResult, request: ChatShareRequest): ChatShareResponse {
    if (output.exitCode !== 0 || output.error || output.outputTruncated) throw new Error(output.error ?? '分享适配器未成功完成。')
    return parseChatShareResponse(output.stdout, request)
  }
  private async query(context: Context, request: ChatShareRequest, scope: ChatShareScope): Promise<ChatShareResponse> {
    const outcome = await this.invoke(context, request, scope)
    if (outcome.status !== 'completed' || !outcome.value) throw new Error(outcome.error ?? '分享适配器读取未完成。')
    return this.response(outcome.value, request)
  }
  private async invoke(context: Context, request: ChatShareRequest, scope: ChatShareScope): Promise<ChatShareEffectOutcome> {
    const key = ['publish','revoke'].includes(request.operation) ? request.operationId : `chat-share-read-${request.requestId}`
    const running = this.active.get(key) ?? { window: scope.owner, sessionId: context.source.id, cancelled: false }
    this.active.set(key, running)
    let timer: ReturnType<typeof setInterval> | undefined, checking = false
    try {
      await this.check(context, request, scope)
      const effectRequest = request.operation === 'inspect' || request.operation === 'describe' ? { ...request, operationId: key } : request
      const result = await this.host.effect(context.source, effectRequest, async () => {
        await this.check(context, request, scope)
        if (running.cancelled) throw new Error('分享操作已取消。')
        if (request.operation === 'publish') this.store.readHtml(this.snapshot(request.snapshotId!, scope))
        running.handle = runSiteProcess(context.adapter.view.executable, context.adapter.view.args, this.store.adapterCwd, context.adapter.target, `${JSON.stringify(request)}\n`)
        timer = setInterval(() => {
          if (checking) return
          checking = true
          void this.check(context, request, scope).catch(() => { running.cancelled = true; running.handle?.cancel() }).finally(() => { checking = false })
        }, 750)
        return running.handle.done
      }, output => { try { const response = this.response(output, request); return request.operation === 'describe' || request.operation === 'inspect' || response.result !== 'unknown' } catch { return false } })
      await this.check(context, request, scope)
      return result
    } finally { if (timer) clearInterval(timer); if (request.operation === 'describe' || request.operation === 'inspect') this.active.delete(key) }
  }
}
