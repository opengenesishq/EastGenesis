import { randomUUID } from 'node:crypto'
import type { SessionMeta } from '../../shared/types'
import type { HostedSiteAnalytics, HostedSiteChange, HostedSiteDescriptor, HostedSitePreview, HostedSiteRange, HostedSiteReceipt, HostedSiteState } from '../../shared/hosted-site-types'
import type { SiteDeploymentState, SiteDeploymentTarget } from '../../shared/site-deployment-types'
import { taskExecutionAuthorityBindingDigest } from '../permission/task-execution-authority-store'
import { redactSensitiveText } from '../security/secret-redaction'
import { runSiteProcess, validateSiteTarget, type SiteProcessHandle, type SiteProcessResult } from './site-deployment-process'
import { hostedProgramDigest } from './hosted-site-program'
import { assertHostedAfter, assertHostedCapability, hostedDigest, hostedSiteKey, HOSTED_SITE_PROTOCOL, parseHostedResponse, validateHostedAnalytics, validateHostedChange, validateHostedDescriptor, validateHostedRange, type HostedRequest, type HostedResponse } from './hosted-site-protocol'
import { assertHostedSiteMutable, readHostedState, writeHostedState, type HostedBinding, type HostedDocument, type HostedSavedPreview, type HostedSavedReceipt } from './hosted-site-state'
import { withSiteStateLock } from './site-operation-lock'
import { HostedEnvironmentValues, validateHostedEnvironmentInput } from './hosted-site-environment'
import { hostedProtocolOutput } from './hosted-site-output'

export interface HostedEffectOutcome { status: 'completed' | 'failed' | 'waiting_reconciliation'; operationId: string; effectId?: string; snapshotId?: string; value?: SiteProcessResult; error?: string }
interface Host {
  root(): string; session(id: string): SessionMeta | undefined; deployments(id: string): Promise<SiteDeploymentState>; authorityRevision(meta: SessionMeta): number
  authorize(meta: SessionMeta, command: string, revision: number): Promise<void>
  effect(operationId: string, meta: SessionMeta, request: HostedRequest, execute: () => Promise<SiteProcessResult>, success: (output: SiteProcessResult) => boolean): Promise<HostedEffectOutcome>
}
interface Context { meta: SessionMeta; target: SiteDeploymentTarget; ownerKey: string; executableDigest: string; environmentDigest: string; authorityRevision: number; ownerWindow: number }
interface Running { sessionId: string; owner: number; cancelled: boolean; handle?: SiteProcessHandle }
const envDigest = (target: SiteDeploymentTarget): string => hostedDigest(target.environmentKeys.map(key => [key, process.env[key] ?? null]))
const errorText = (cause: unknown): string => redactSensitiveText(cause instanceof Error ? cause.message : String(cause)).slice(0, 2000)
export class HostedSiteService {
  private active = new Map<string, Running>()
  private preparedHere = new Map<string, number>()
  private environmentValues = new HostedEnvironmentValues()
  constructor(private readonly host: Host) {}
  private lock<T>(fn: () => Promise<T>): Promise<T> { return withSiteStateLock(this.host.root(), fn) }
  private request(context: Context, operation: HostedRequest['operation'], extra: Partial<HostedRequest> = {}): HostedRequest {
    return { protocol: HOSTED_SITE_PROTOCOL, requestId: randomUUID(), operation, siteId: context.target.management!.siteId, ...extra }
  }
  private async document(): Promise<HostedDocument> {
    const document = await readHostedState(this.host.root())
    for (const binding of document.bindings) for (const row of binding.receipts) if (row.view.status === 'executing' && !this.active.has(row.view.operationId)) {
      row.view.status = 'needs_reconciliation'; row.view.error = '原适配器进程已不在运行，请核对原操作；不会自动重发。'; row.view.recoverySnapshotId ??= `operation:${row.view.operationId}`
    }
    return document
  }
  private binding(document: HostedDocument, id: string, target: string): HostedBinding | undefined { return document.bindings.find(row => row.sessionId === id && row.targetId === target) }
  async get(id: string, targetId: string): Promise<HostedSiteState> {
    const document = await this.document(), binding = this.binding(document, id, targetId)
    let configured = false, reason: string | undefined
    try {
      const context = await this.context(id, targetId, 0)
      configured = true
      if (binding && (binding.ownerKey !== context.ownerKey || binding.targetDigest !== hostedDigest(context.target))) reason = '任务或目标配置已变化，请重新读取并连接。'
    } catch (error) { reason = errorText(error) }
    return { configured, connected: Boolean(binding && !reason), descriptor: binding?.descriptor, analytics: binding?.analytics,
      receipts: binding?.receipts.map(row => row.view).reverse() ?? [], unavailableReason: reason }
  }
  async refresh(id: string, targetId: string, revision: number, owner: number, assertOwner: () => void): Promise<HostedSiteState> {
    const context = await this.context(id, targetId, owner)
    if (context.target.revision !== revision) throw new Error('部署目标配置已变化，请刷新后重试。')
    const existing = this.binding(await this.document(), id, targetId)
    const request = this.request(context, 'describe', existing ? { accountScope: existing.descriptor.accountScope } : {})
    const response = await this.query(context, request, assertOwner), descriptor = validateHostedDescriptor(response.data)
    await this.lock(async () => {
      await this.check(context, request, assertOwner)
      const data = await this.document(), binding = this.binding(data, id, targetId)
      if (binding && hostedSiteKey(binding.descriptor) !== hostedSiteKey(descriptor)) throw new Error('配置返回了不同账户或站点；旧绑定及回执保留，请使用新的部署目标连接。')
      if (binding) { binding.descriptor = descriptor; binding.targetDigest = hostedDigest(context.target); binding.ownerKey = context.ownerKey }
      else {
        if (data.bindings.length >= 2000) throw new Error('托管站点连接已达到 2000 个。')
        data.bindings.push({ sessionId: id, targetId, ownerKey: context.ownerKey, targetDigest: hostedDigest(context.target), descriptor, previews: [], receipts: [] })
      }
      await writeHostedState(this.host.root(), data)
    })
    return this.get(id, targetId)
  }
  async analytics(id: string, targetId: string, input: HostedSiteRange, owner: number, assertOwner: () => void): Promise<HostedSiteAnalytics> {
    const context = await this.context(id, targetId, owner), binding = this.requireBinding(await this.document(), context), range = validateHostedRange(input)
    if (!binding.descriptor.capabilities.analytics) throw new Error('适配器未提供站点访问分析。')
    const request = this.request(context, 'analytics', { accountScope: binding.descriptor.accountScope, analytics: range })
    const response = await this.query(context, request, assertOwner), result = validateHostedAnalytics(response.data, range)
    await this.lock(async () => { await this.check(context, request, assertOwner); const data = await this.document(); this.requireBinding(data, context).analytics = result; await writeHostedState(this.host.root(), data) })
    return result
  }
  async prepare(id: string, targetId: string, input: HostedSiteChange, owner: number, assertOwner: () => void): Promise<HostedSitePreview> {
    if (input?.kind === 'environment.set') throw new Error('请通过环境变量输入创建预览，不能复用其他预览的变量值。')
    return this.prepareChange(id, targetId, input, owner, assertOwner)
  }
  async prepareEnvironment(id: string, targetId: string, input: unknown, owner: number, assertOwner: () => void): Promise<HostedSitePreview> {
    const value = validateHostedEnvironmentInput(input)
    const preview = await this.prepareChange(id, targetId, { kind: 'environment.set', name: value.name, secret: value.secret, valueRef: randomUUID() }, owner, assertOwner)
    assertOwner()
    this.environmentValues.retain(preview, owner, value.value)
    return preview
  }
  private async prepareChange(id: string, targetId: string, input: HostedSiteChange, owner: number, assertOwner: () => void): Promise<HostedSitePreview> {
    const change = validateHostedChange(input), context = await this.context(id, targetId, owner)
    const binding = this.requireBinding(await this.document(), context)
    await this.assertAvailable(context, binding)
    const describe = this.request(context, 'describe', { accountScope: binding.descriptor.accountScope })
    const before = validateHostedDescriptor((await this.query(context, describe, assertOwner)).data)
    if (hostedSiteKey(before) !== hostedSiteKey(binding.descriptor)) throw new Error('站点身份已变化。')
    assertHostedCapability(before, change)
    const idPreview = randomUUID(), operationId = `hosted-site-${idPreview}`
    const request = this.request(context, 'plan', { accountScope: before.accountScope, expectedRevision: before.revision, change, operationId })
    const response = await this.query(context, request, assertOwner), plan = response.plan
    if (!plan) throw new Error('适配器未返回变更预览。')
    const plannedBefore = validateHostedDescriptor(plan.before), after = validateHostedDescriptor(plan.after)
    if (hostedSiteKey(plannedBefore) !== hostedSiteKey(before) || plannedBefore.revision !== before.revision) throw new Error('预览前置站点或版本与当前观察不匹配。')
    assertHostedAfter(plannedBefore, after, change)
    const createdAt = Date.now(), expiresAt = Math.min(Date.parse(plan.expiresAt), createdAt + 5 * 60 * 1000)
    if (!Number.isFinite(expiresAt) || expiresAt <= createdAt) throw new Error('适配器预览已过期。')
    const view: HostedSitePreview = { id: idPreview, sessionId: id, targetId, targetName: context.target.name, operationId, planId: plan.planId, planDigest: '',
      expectedRevision: before.revision, change, before: plannedBefore, after, impact: plan.impact,
      command: [context.target.executable, ...context.target.management!.args], environmentKeys: [...context.target.environmentKeys], createdAt, expiresAt }
    const saved: HostedSavedPreview = { view, target: context.target, ownerKey: context.ownerKey, executableDigest: context.executableDigest, environmentDigest: context.environmentDigest,
      authorityRevision: context.authorityRevision, ownerWindow: owner }
    view.planDigest = previewDigest(saved)
    await this.lock(async () => {
      await this.check(context, request, assertOwner); await this.assertAvailable(context, binding)
      const data = await this.document(), current = this.requireBinding(data, context)
      current.previews = current.previews.filter(item => item.view.expiresAt > Date.now() || current.receipts.some(row => row.view.previewId === item.view.id))
      if (current.previews.filter(item => !current.receipts.some(row => row.view.previewId === item.view.id)).length >= 20) throw new Error('待执行预览过多，请等待旧预览过期。')
      current.descriptor = before; current.previews.push(saved); await writeHostedState(this.host.root(), data)
    })
    this.preparedHere.set(view.id, owner)
    return view
  }
  async preview(id: string, previewId: string): Promise<HostedSitePreview> {
    const saved = (await this.document()).bindings.filter(row => row.sessionId === id).flatMap(row => row.previews).find(row => row.view.id === previewId)
    if (!saved) throw new Error('托管站点预览不存在。')
    return saved.view
  }
  async discardPreview(id: string, previewId: string, owner: number): Promise<void> {
    await this.lock(async () => {
      if (this.preparedHere.get(previewId) !== owner) return
      const data = await this.document(), binding = data.bindings.find(row => row.sessionId === id && row.previews.some(preview => preview.view.id === previewId))
      if (!binding) return
      this.preparedHere.delete(previewId); this.environmentValues.remove(previewId)
      if (!binding.receipts.some(row => row.view.previewId === previewId)) {
        binding.previews = binding.previews.filter(preview => preview.view.id !== previewId)
        await writeHostedState(this.host.root(), data)
      }
    })
  }
  async execute(id: string, previewId: string, owner: number, assertOwner: () => void): Promise<HostedSiteReceipt> {
    const prepared = await this.lock(async () => {
      const data = await this.document(), binding = data.bindings.find(row => row.sessionId === id && row.previews.some(item => item.view.id === previewId))
      if (!binding) throw new Error('预览不存在。')
      const existing = binding.receipts.find(row => row.view.id === previewId)
      if (existing) return { existing: existing.view }
      const preview = binding.previews.find(item => item.view.id === previewId)!
      if (this.preparedHere.get(previewId) !== owner || preview.ownerWindow !== owner || preview.view.expiresAt <= Date.now() || previewDigest(preview) !== preview.view.planDigest) throw new Error('预览已过期、内容变化或来自其他窗口；重启后请重新预览。')
      const context = await this.fromPreview(id, preview, owner), request = this.applyRequest(context, preview, 'apply')
      await this.check(context, request, assertOwner); await this.assertAvailable(context, binding)
      if (preview.view.change.kind === 'environment.set') this.environmentValues.read(preview.view, owner)
      const view: HostedSiteReceipt = { id: previewId, sessionId: id, targetId: binding.targetId, operationId: preview.view.operationId, previewId,
        change: preview.view.change, siteId: preview.view.before.siteId, accountScope: preview.view.before.accountScope, status: 'executing', startedAt: Date.now(), output: '' }
      binding.receipts.push({ view, preview }); await writeHostedState(this.host.root(), data)
      this.active.set(view.operationId, { sessionId: id, owner, cancelled: false })
      return { preview, context, request, view }
    })
    if (prepared.existing) return prepared.existing
    const { context, request, preview, view } = prepared as Required<Pick<typeof prepared, 'context' | 'request' | 'preview' | 'view'>>
    let next: HostedSiteReceipt = { ...view }
    try {
      const privateValue = preview.view.change.kind === 'environment.set' ? this.environmentValues.read(preview.view, owner) : undefined
      const outcome = await this.invoke(context, request, assertOwner, output => {
        const result = this.response(output, request).receipt
        if (result?.result !== 'applied') return false
        const after = validateHostedDescriptor(result.after)
        assertHostedAfter(preview.view.before, after, preview.view.change)
        return after.revision !== preview.view.expectedRevision
      }, privateValue, preview.view.after)
      const response = outcome.value && !outcome.value.error && outcome.value.exitCode === 0 ? parseHostedResponse(outcome.value.stdout, request) : undefined
      next = { ...view, effectId: outcome.effectId, recoverySnapshotId: outcome.snapshotId ?? (outcome.status !== 'completed' ? `operation:${view.operationId}` : undefined),
        status: outcome.status === 'completed' && response?.receipt?.result === 'applied' ? 'confirmed' : 'needs_reconciliation', result: response?.receipt?.result,
        after: response?.receipt?.result === 'applied' ? validateHostedDescriptor(response.receipt.after) : undefined,
        error: outcome.error, output: outcome.value ? redactSensitiveText(`${outcome.value.stdout}\n${outcome.value.stderr}`).slice(-32768) : '', finishedAt: Date.now() }
    } catch (error) { next.status = 'needs_reconciliation'; next.error = errorText(error); next.recoverySnapshotId = `operation:${view.operationId}`; next.finishedAt = Date.now() }
    finally { this.active.delete(view.operationId); this.environmentValues.remove(previewId) }
    await this.lock(async () => {
      const data = await this.document(), row = this.findReceipt(data, id, previewId); row.view = next
      if (next.status === 'confirmed' && next.after) for (const binding of data.bindings) if (hostedSiteKey(binding.descriptor) === hostedSiteKey(next.after)) binding.descriptor = next.after
      await writeHostedState(this.host.root(), data)
    })
    return next
  }
  async inspect(id: string, receiptId: string, owner: number, assertOwner: () => void): Promise<HostedSiteReceipt> {
    const saved = this.findReceipt(await this.document(), id, receiptId)
    if (saved.view.status !== 'needs_reconciliation' || this.active.has(saved.view.operationId)) throw new Error('仅可核对已停止且结果未知的操作。')
    const context = await this.fromPreview(id, saved.preview, owner, true), request = this.applyRequest(context, saved.preview, 'inspect')
    const response = await this.query(context, request, assertOwner), receipt = response.receipt
    if (!receipt) throw new Error('核对适配器未返回原操作回执。')
    const after = receipt.result === 'applied' ? validateHostedDescriptor(receipt.after) : undefined
    if (after) assertHostedAfter(saved.preview.view.before, after, saved.preview.view.change)
    return this.lock(async () => {
      await this.check(context, request, assertOwner)
      const data = await this.document(), row = this.findReceipt(data, id, receiptId)
      if (receipt.result === 'unknown') { row.inspection = undefined; row.view.error = '适配器仍不能确认原操作结果，继续阻止后续变更。' }
      else { row.inspection = { result: receipt.result, after, checkedAt: Date.now() }; row.view.result = receipt.result; row.view.after = after; row.view.error = '已取得原操作核对回执；仍需收敛原 Effect。' }
      await writeHostedState(this.host.root(), data); return row.view
    })
  }
  async inspection(id: string, receiptId: string): Promise<HostedSavedReceipt> { return this.findReceipt(await this.document(), id, receiptId) }
  async acceptInspection(id: string, receiptId: string): Promise<HostedSiteReceipt> {
    return this.lock(async () => {
      const data = await this.document(), row = this.findReceipt(data, id, receiptId)
      if (!row.inspection || Date.now() - row.inspection.checkedAt > 5 * 60 * 1000) throw new Error('核对证据已过期。')
      row.view.status = row.inspection.result === 'applied' ? 'confirmed' : 'not_applied'; row.view.error = undefined; row.view.recoverySnapshotId = undefined
      if (row.inspection.after) for (const binding of data.bindings) if (hostedSiteKey(binding.descriptor) === hostedSiteKey(row.inspection.after)) binding.descriptor = row.inspection.after
      await writeHostedState(this.host.root(), data); return row.view
    })
  }
  cancel(id: string, operationId: string): boolean { const active = this.active.get(operationId); if (!active || active.sessionId !== id) return false; active.cancelled = true; active.handle?.cancel(); return true }
  stopOwner(owner: number): void { for (const [key, row] of this.active) if (row.owner === owner) this.cancel(row.sessionId, key); for (const [id, window] of this.preparedHere) if (window === owner) this.preparedHere.delete(id); this.environmentValues.clearOwner(owner) }
  dispose(): void { for (const [key, row] of this.active) this.cancel(row.sessionId, key); this.environmentValues.dispose() }
  private findReceipt(data: HostedDocument, id: string, receiptId: string): HostedSavedReceipt {
    const row = data.bindings.filter(binding => binding.sessionId === id).flatMap(binding => binding.receipts).find(item => item.view.id === receiptId)
    if (!row) throw new Error('原操作回执不存在。'); return row
  }
  private async context(id: string, targetId: string, owner: number): Promise<Context> {
    const meta = this.host.session(id)
    if (!meta || meta.status === 'closed' || meta.sideChat) throw new Error('原任务已不可用。')
    const target = (await this.host.deployments(id)).targets.find(item => item.id === targetId)
    if (!target?.management) throw new Error('当前目标未连接管理适配器；请配置管理参数及稳定站点 ID。')
    const validated = validateSiteTarget(target)
    return { meta: { ...meta }, target: validated, ownerKey: taskExecutionAuthorityBindingDigest(meta), executableDigest: await hostedProgramDigest(target, meta.cwd), environmentDigest: envDigest(target), authorityRevision: this.host.authorityRevision(meta), ownerWindow: owner }
  }
  private async fromPreview(id: string, preview: HostedSavedPreview, owner: number, inspecting = false): Promise<Context> {
    const context = await this.context(id, preview.view.targetId, owner)
    if (context.ownerKey !== preview.ownerKey || hostedDigest(context.target) !== hostedDigest(preview.target) || context.executableDigest !== preview.executableDigest || context.environmentDigest !== preview.environmentDigest || (!inspecting && context.authorityRevision !== preview.authorityRevision)) throw new Error('任务、配置、程序、环境或授权已变化，旧预览不能继续。')
    if (previewDigest(preview) !== preview.view.planDigest) throw new Error('原站点变更预览已损坏。')
    return context
  }
  private requireBinding(data: HostedDocument, context: Context): HostedBinding {
    const binding = this.binding(data, context.meta.id, context.target.id)
    if (!binding || binding.ownerKey !== context.ownerKey || binding.targetDigest !== hostedDigest(context.target)) throw new Error('请先重新读取并连接此站点。')
    return binding
  }
  private async assertAvailable(context: Context, binding: HostedBinding): Promise<void> {
    assertHostedSiteMutable(await this.document(), binding.descriptor)
    if ((await this.host.deployments(context.meta.id)).receipts.some(row => row.targetId === context.target.id && ['executing', 'needs_reconciliation'].includes(row.status))) throw new Error('原部署仍在执行或待核对。')
  }
  private applyRequest(context: Context, preview: HostedSavedPreview, operation: 'apply' | 'inspect'): HostedRequest {
    return this.request(context, operation, { accountScope: preview.view.before.accountScope, operationId: preview.view.operationId, expectedRevision: preview.view.expectedRevision,
      change: preview.view.change, planId: preview.view.planId, planDigest: preview.view.planDigest })
  }
  private async check(context: Context, request: HostedRequest, assertOwner: () => void, full = true): Promise<void> {
    assertOwner()
    const meta = this.host.session(context.meta.id)
    if (!meta || meta.status === 'closed' || taskExecutionAuthorityBindingDigest(meta) !== context.ownerKey) throw new Error('原任务身份已变化。')
    // The public request, including the one-use reference to a prepared value, binds the decision.
    const command = `${[context.target.executable, ...context.target.management!.args].map(shellQuote).join(' ')} <<'CAOGEN_SITE_REQUEST'\n${JSON.stringify(request)}\nCAOGEN_SITE_REQUEST`
    await this.host.authorize(meta, command, context.authorityRevision); assertOwner()
    if (full) {
      const target = (await this.host.deployments(meta.id)).targets.find(row => row.id === context.target.id)
      if (!target || hostedDigest(target) !== hostedDigest(context.target) || await hostedProgramDigest(target, meta.cwd) !== context.executableDigest || envDigest(target) !== context.environmentDigest) throw new Error('适配器配置、程序或环境已变化。')
    }
  }
  private response(output: SiteProcessResult, request: HostedRequest): HostedResponse {
    if (output.exitCode !== 0 || output.error || output.outputTruncated) throw new Error(output.error ?? '适配器进程未成功完成，不能确认服务状态。')
    return parseHostedResponse(output.stdout, request)
  }
  private async query(context: Context, request: HostedRequest, assertOwner: () => void): Promise<HostedResponse> {
    const outcome = await this.invoke(context, request, assertOwner, output => { this.response(output, request); return true })
    const response = outcome.value ? this.response(outcome.value, request) : undefined
    if (outcome.status !== 'completed' || !response) throw new Error(outcome.error ?? '适配器读取回执未完成。')
    return response
  }
  private async invoke(context: Context, request: HostedRequest, assertOwner: () => void, success: (output: SiteProcessResult) => boolean, privateValue?: string, publicPreview?: HostedSiteDescriptor): Promise<HostedEffectOutcome> {
    const key = request.operation === 'apply' ? request.operationId! : `hosted-read-${request.requestId}`
    if (this.active.has(key) && request.operation !== 'apply') throw new Error('该操作正在执行。')
    const running = this.active.get(key) ?? { sessionId: context.meta.id, owner: context.ownerWindow, cancelled: false }
    this.active.set(key, running)
    let timer: NodeJS.Timeout | undefined, checking = false
    try {
      await this.check(context, request, assertOwner)
      return await this.host.effect(key, context.meta, request, async () => {
        await this.check(context, request, assertOwner)
        if (running.cancelled) throw new Error('用户已取消适配器操作。')
        const payload = privateValue !== undefined && request.change?.kind === 'environment.set'
          ? { ...request, environmentValue: { name: request.change.name, valueRef: request.change.valueRef, value: privateValue } } : request
        running.handle = runSiteProcess(context.target.executable, context.target.management!.args, context.meta.cwd, { ...context.target, timeoutSeconds: Math.min(context.target.timeoutSeconds, 60) }, `${JSON.stringify(payload)}\n`)
        timer = setInterval(() => {
          if (checking) return
          checking = true
          void this.check(context, request, assertOwner, false).catch(() => { running.cancelled = true; running.handle?.cancel() }).finally(() => { checking = false })
        }, 1000); timer.unref()
        return hostedProtocolOutput(await running.handle.done, request, privateValue, publicPreview)
      }, output => { try { return success(output) } catch { return false } })
    } finally { clearInterval(timer); this.active.delete(key) }
  }
}
function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'` }
function previewDigest(preview: HostedSavedPreview): string { return hostedDigest({ ...preview, view: { ...preview.view, planDigest: '' } }) }
