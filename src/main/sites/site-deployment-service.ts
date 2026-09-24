import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionMeta } from '../../shared/types'
import type { SiteDeploymentPreview, SiteDeploymentReceipt, SiteDeploymentState, SiteDeploymentTarget } from '../../shared/site-deployment-types'
import { writeDurableFile } from '../durable-file'
import { redactSensitiveText } from '../security/secret-redaction'
import { executeInteractiveOperationEffect } from '../task/operation-effect-gateway'
import { stableValueDigest } from '../task/tool-idempotency'
import { listTaskRuns } from '../task/task-snapshot'
import { parseSiteAdapterReceipt, runSiteProcess, siteCommandArgs, siteExecutableDigest, validateSiteTarget, type SiteProcessHandle } from './site-deployment-process'
import { freezeSiteFiles, startSiteSnapshotPreview, stopAllSiteSnapshotPreviews, stopSiteSnapshotPreview, verifySiteSnapshot } from './site-deployment-snapshot'
import { assertHostedTargetMutable } from './hosted-site-state'
import { withSiteStateLock } from './site-operation-lock'

interface Owner { id: string; createdAt: number; cwd: string; workspaceId?: string; goalId?: string; workItemId?: string }
interface SavedPreview { view: SiteDeploymentPreview; owner: Owner; directory: string; executableDigest: string; environmentDigest: string }
interface SavedReceipt { view: SiteDeploymentReceipt; preview: SavedPreview; inspection?: { deploymentId: string; url: string; checkedAt: number } }
interface Document { version: 1; owner: Owner; targets: SiteDeploymentTarget[]; previews: SavedPreview[]; receipts: SavedReceipt[] }
interface Host { root(): string; session(id: string): SessionMeta | undefined; authorize(id: string, action: string): Promise<void> }
const active = new Map<string, SiteProcessHandle>()
export function isSiteDeploymentActive(receiptId: string): boolean { return active.has(receiptId) }
const cancellations = new Set<string>()
export class SiteDeploymentService {
  constructor(private readonly host: Host) {}
  private async owner(sessionId: string): Promise<Owner> {
    const meta = this.host.session(sessionId)
    if (!meta || meta.status === 'closed' || meta.sideChat) throw new Error('当前任务不可用或属于只读侧聊')
    return { id: meta.id, createdAt: meta.createdAt, cwd: await realpath(meta.cwd), workspaceId: meta.workspaceId, goalId: meta.goalId, workItemId: meta.workItemId }
  }
  private path(sessionId: string): string { return join(this.host.root(), 'site-deployments', createHash('sha256').update(sessionId).digest('hex'), 'state.json') }
  private async document(sessionId: string): Promise<Document> {
    const owner = await this.owner(sessionId)
    let document: Document
    try { document = JSON.parse(await readFile(this.path(sessionId), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, owner, targets: [], previews: [], receipts: [] }; throw error }
    if (document.version !== 1 || stableValueDigest(owner) !== stableValueDigest(document.owner)) throw new Error('任务目录或身份已变化；原站点部署记录保持保留，不能在新归属下执行')
    for (const receipt of document.receipts) {
      if (receipt.view.status === 'executing' && !active.has(receipt.view.id)) {
        receipt.view.status = 'needs_reconciliation'
        receipt.view.error = '上次进程已不在运行；请先核对实际部署状态，禁止自动重发'
        receipt.view.recoverySnapshotId ??= receipt.view.operationId ? `operation:${receipt.view.operationId}` : undefined
      }
      if (receipt.view.status === 'needs_reconciliation' && receipt.view.operationId && !active.has(receipt.view.id)) {
        const run = (await listTaskRuns(`operation:${receipt.view.operationId}`, this.host.root())).find(value => value.id === `operation:${receipt.view.operationId}`)
        const effect = run?.effects?.find(value => !receipt.view.effectId || value.id === receipt.view.effectId)
        if (effect) receipt.view.effectId = effect.id
        // Recovery may be resolved outside this page; only converge to success
        // when the exact original adapter receipt is also available.
        if (effect?.status === 'confirmed' && receipt.view.verification === 'adapter_receipt' && receipt.view.deploymentId && receipt.view.url) {
          receipt.view.status = 'confirmed'; receipt.view.error = undefined; receipt.view.recoverySnapshotId = undefined
        }
      }
    }
    return document
  }
  private save(document: Document): Promise<void> { return writeDurableFile(this.path(document.owner.id), `${JSON.stringify(document, null, 2)}\n`) }
  async list(sessionId: string): Promise<SiteDeploymentState> {
    const data = await this.document(sessionId)
    return { targets: data.targets, receipts: data.receipts.map(receipt => receipt.view).reverse() }
  }
  async saveTarget(sessionId: string, input: SiteDeploymentTarget): Promise<SiteDeploymentTarget> {
    return this.lock(sessionId, async () => {
      const document = await this.document(sessionId), target = validateSiteTarget(input)
      if (target.id) await assertHostedTargetMutable(this.host.root(), sessionId, target.id)
      if (document.receipts.some(row => row.view.status === 'executing')) throw new Error('请先等待部署进程结束')
      const previous = document.targets.find(item => item.id === target.id)
      if (target.id && (!previous || previous.revision !== target.revision)) throw new Error('部署配置已变化，请刷新后保存')
      if (!previous && document.targets.length >= 30) throw new Error('每个任务最多保存 30 个部署目标')
      const saved = { ...target, id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1 }
      document.targets = [...document.targets.filter(item => item.id !== saved.id), saved]
      await this.save(document); return saved
    })
  }
  async removeTarget(sessionId: string, id: string, revision: number): Promise<void> {
    await this.lock(sessionId, async () => {
      const document = await this.document(sessionId), target = document.targets.find(item => item.id === id)
      await assertHostedTargetMutable(this.host.root(), sessionId, id)
      if (!target || target.revision !== revision) throw new Error('部署配置已变化，请刷新')
      if (document.receipts.some(row => row.view.targetId === id && ['executing', 'needs_reconciliation'].includes(row.view.status))) throw new Error('该目标仍有执行或待核对记录')
      document.targets = document.targets.filter(item => item.id !== id); await this.save(document)
    })
  }
  async prepare(sessionId: string, targetId: string, rollbackOf?: string): Promise<SiteDeploymentPreview> {
    return this.lock(sessionId, async () => {
      const document = await this.document(sessionId), target = document.targets.find(item => item.id === targetId)
      await assertHostedTargetMutable(this.host.root(), sessionId, targetId)
      if (!target) throw new Error('部署目标不存在')
      if (document.receipts.some(row => row.view.targetId === targetId && ['executing', 'needs_reconciliation'].includes(row.view.status))) throw new Error('该目标仍有执行或待核对记录；请先核对实际状态')
      const expired = document.previews.filter(item => item.view.expiresAt < Date.now() && !document.receipts.some(row => row.view.snapshotId === item.view.id))
      document.previews = document.previews.filter(item => !expired.includes(item))
      for (const item of expired) {
        stopSiteSnapshotPreview(item.view.id)
        if (!document.previews.some(other => other.directory === item.directory)) await rm(item.directory, { recursive: true, force: true })
      }
      if (document.previews.filter(item => !document.receipts.some(row => row.view.snapshotId === item.view.id)).length >= 10) throw new Error('请先关闭不再使用的发布预览')
      const id = randomUUID(), action = rollbackOf ? 'rollback' : 'deploy', createdAt = Date.now()
      const sourceReceipt = rollbackOf ? document.receipts.find(row => row.view.id === rollbackOf && row.view.targetId === targetId && row.view.status === 'confirmed' && row.view.action === 'deploy') : undefined
      if (rollbackOf && (!sourceReceipt || !target.rollbackArgs.length || !target.rollbackArgs.some(arg => arg.includes('{{deploymentId}}')))) throw new Error('回滚需要已确认的原发布回执，且回滚参数必须包含 {{deploymentId}}')
      const directory = sourceReceipt?.preview.directory ?? join(this.host.root(), 'site-deployments', createHash('sha256').update(sessionId).digest('hex'), 'snapshots', id)
      const contents = sourceReceipt ? { files: sourceReceipt.preview.view.files, bytes: sourceReceipt.preview.view.bytes,
        manifestDigest: sourceReceipt.preview.view.manifestDigest, sourceDirectory: sourceReceipt.preview.view.sourceDirectory }
        : await freezeSiteFiles(document.owner.cwd, target.outputDirectory, directory)
      await verifySiteSnapshot(directory, contents.files)
      const command = [target.executable, ...siteCommandArgs(action === 'rollback' ? target.rollbackArgs : target.deployArgs,
        { directory, deploymentId: sourceReceipt?.view.deploymentId, url: sourceReceipt?.view.url, operationId: id })]
      const preview: SavedPreview = { owner: document.owner, directory, executableDigest: await siteExecutableDigest(target.executable), environmentDigest: siteEnvironmentDigest(target), view: {
        id, sessionId, target: structuredClone(target), action, rollbackOf, ...contents, command, environmentKeys: target.environmentKeys,
        createdAt, expiresAt: createdAt + 30 * 60 * 1000 } }
      preview.view.localUrl = await startSiteSnapshotPreview(id, directory, preview.view.expiresAt)
      document.previews.push(preview); await this.save(document)
      return preview.view
    })
  }
  async preview(sessionId: string, previewId: string): Promise<SiteDeploymentPreview> {
    const document = await this.document(sessionId), preview = document.previews.find(item => item.view.id === previewId)
    if (!preview) throw new Error('发布预览不存在')
    return preview.view
  }
  async execute(sessionId: string, previewId: string): Promise<SiteDeploymentReceipt> {
    const prepared = await this.lock(sessionId, async () => {
      const document = await this.document(sessionId), preview = document.previews.find(item => item.view.id === previewId)
      const existing = document.receipts.find(row => row.view.id === previewId)
      if (existing) return { existing: existing.view }
      if (!preview || preview.view.expiresAt < Date.now()) throw new Error('预览已过期，请重新准备发布')
      const target = document.targets.find(item => item.id === preview.view.target.id)
      await assertHostedTargetMutable(this.host.root(), sessionId, preview.view.target.id)
      if (!target || stableValueDigest(target) !== stableValueDigest(preview.view.target)) throw new Error('部署配置已变化，请重新预览')
      if (document.receipts.some(row => row.view.targetId === target.id && ['executing', 'needs_reconciliation'].includes(row.view.status))) throw new Error('该目标还有执行或待核对记录')
      await this.host.authorize(sessionId, preview.view.action === 'deploy' ? '发布网站' : '回滚网站')
      await this.assertPreviewCurrent(preview)
      const view: SiteDeploymentReceipt = { id: previewId, sessionId, targetId: target.id, targetName: target.name,
        action: preview.view.action, status: 'executing', snapshotId: previewId, manifestDigest: preview.view.manifestDigest,
        operationId: previewId, rollbackOf: preview.view.rollbackOf, startedAt: Date.now(), stdout: '', stderr: '', outputTruncated: false, verification: 'unconfirmed' }
      document.receipts.push({ view, preview }); await this.save(document)
      // A placeholder makes this durable prepared operation distinguishable from a stopped process.
      active.set(previewId, { cancel: () => { cancellations.add(previewId) }, done: Promise.resolve({ started: false, exitCode: null, signal: null, stdout: '', stderr: '', outputTruncated: false }) })
      return { preview, view }
    })
    if (prepared.existing) return prepared.existing
    const { preview, view } = prepared as { preview: SavedPreview; view: SiteDeploymentReceipt }
    let next = { ...view }
    try {
      const result = await executeInteractiveOperationEffect({ operationId: view.id, kind: 'terminal_action', title: `${view.action === 'deploy' ? '发布网站' : '回滚网站'}：${view.targetName}`,
        sourceSessionId: sessionId, projectId: preview.owner.workspaceId, cwd: preview.directory, toolName: 'bash',
        toolInput: { siteOperation: view.action, targetId: view.targetId, targetRevision: preview.view.target.revision,
          manifestDigest: view.manifestDigest, commandDigest: stableValueDigest(preview.view.command), environmentKeys: preview.view.environmentKeys },
        execute: async () => {
          await this.host.authorize(sessionId, '执行已确认的网站操作'); await this.assertPreviewCurrent(preview)
          if (cancellations.has(view.id)) throw new Error('用户在程序启动前取消了部署')
          const process = runSiteProcess(preview.view.command[0], preview.view.command.slice(1), preview.directory, preview.view.target)
          active.set(view.id, process)
          return process.done
        },
        isSuccess: output => output.exitCode === 0 && !output.error && parseSiteAdapterReceipt(output.stdout)?.operationId === view.operationId,
        resultSummary: output => JSON.stringify({ ...output, receipt: parseSiteAdapterReceipt(output.stdout) }) })
      const output = result.value, parsed = output && !output.error && output.exitCode === 0 ? parseSiteAdapterReceipt(output.stdout) : undefined
      const adapter = parsed?.operationId === view.operationId ? parsed : undefined
      next = { ...view, effectId: result.effectId,
        recoverySnapshotId: result.status === 'waiting_reconciliation' ? result.snapshotId : undefined,
        status: result.status === 'completed' && adapter ? 'confirmed' : result.effectId ? 'needs_reconciliation' : 'not_started',
        deploymentId: adapter?.deploymentId, url: adapter?.url, verification: adapter ? 'adapter_receipt' : 'unconfirmed',
        finishedAt: Date.now(), exitCode: output?.exitCode, signal: output?.signal, stdout: output?.stdout ?? '', stderr: output?.stderr ?? '',
        outputTruncated: output?.outputTruncated ?? false, error: result.status === 'completed' ? undefined : ('error' in result ? result.error : output?.error) }
    } catch (error) { next.status = 'needs_reconciliation'; next.recoverySnapshotId = `operation:${view.id}`; next.error = redactSensitiveText(error instanceof Error ? error.message : String(error)); next.finishedAt = Date.now() }
    finally { active.delete(view.id); cancellations.delete(view.id) }
    await this.lock(sessionId, async () => { const document = await this.document(sessionId), stored = document.receipts.find(row => row.view.id === view.id); if (!stored) throw new Error('部署回执记录丢失'); stored.view = next; await this.save(document) })
    return next
  }
  async cancel(sessionId: string, id: string): Promise<boolean> { const data = await this.document(sessionId); if (!data.receipts.some(row => row.view.id === id)) throw new Error('部署记录不属于当前任务'); const process = active.get(id); if (!process) return false; process.cancel(); return true }
  async inspect(sessionId: string, receiptId: string): Promise<SiteDeploymentReceipt> {
    const document = await this.document(sessionId), saved = document.receipts.find(row => row.view.id === receiptId)
    if (!saved || saved.view.status !== 'needs_reconciliation' || active.has(receiptId)) throw new Error('仅可核对已停止且结果未知的部署')
    const target = saved.preview.view.target
    if (!target.inspectArgs.length || !target.inspectArgs.some(arg => arg.includes('{{operationId}}') || arg.includes('{{deploymentId}}'))) throw new Error('请配置包含 {{operationId}} 或 {{deploymentId}} 的核对脚本参数；原快照没有核对命令时请使用任务恢复中心')
    await this.host.authorize(sessionId, '核对网站部署'); await this.assertPreviewCurrent(saved.preview, false)
    const args = siteCommandArgs(target.inspectArgs, { directory: saved.preview.directory, operationId: saved.view.operationId!, deploymentId: saved.view.deploymentId, url: saved.view.url })
    if (active.has(receiptId)) throw new Error('核对已在进行')
    active.set(receiptId, { cancel: () => { cancellations.add(receiptId) }, done: Promise.resolve({ started: false, exitCode: null, signal: null, stdout: '', stderr: '', outputTruncated: false }) })
    try {
      const outcome = await executeInteractiveOperationEffect({ kind: 'terminal_action', title: `核对网站部署：${saved.view.targetName}`,
        sourceSessionId: sessionId, projectId: saved.preview.owner.workspaceId, cwd: saved.preview.directory, toolName: 'bash',
        toolInput: { siteOperation: 'inspect', receiptId, commandDigest: stableValueDigest([target.executable, ...args]) },
        execute: async () => {
          await this.host.authorize(sessionId, '核对网站部署'); await this.assertPreviewCurrent(saved.preview, false)
          if (cancellations.has(receiptId)) throw new Error('用户在核对程序启动前取消了操作')
          const process = runSiteProcess(target.executable, args, saved.preview.directory, target); active.set(receiptId, process); return process.done
        }, isSuccess: output => output.exitCode === 0 && !output.error,
        resultSummary: output => JSON.stringify(output) })
      const output = outcome.value
      if (!output || outcome.status !== 'completed') throw new Error('error' in outcome ? outcome.error : '核对程序没有完成')
      const adapter = !output.error && output.exitCode === 0 ? parseSiteAdapterReceipt(output.stdout) : undefined
      const exact = adapter && adapter.operationId === saved.view.operationId && (!saved.view.deploymentId || adapter.deploymentId === saved.view.deploymentId)
      return await this.lock(sessionId, async () => {
        const current = await this.document(sessionId), row = current.receipts.find(item => item.view.id === receiptId)!
        row.view.stderr = `${row.view.stderr}\n核对输出：\n${output.stdout}\n${output.stderr}`.slice(-256 * 1024)
        if (exact) { row.inspection = { deploymentId: adapter.deploymentId, url: adapter.url, checkedAt: Date.now() }; row.view.deploymentId = adapter.deploymentId; row.view.url = adapter.url; row.view.verification = 'adapter_receipt'; row.view.error = '核对脚本返回原操作回执，仍需确认并收敛原效果账本' }
        else { row.inspection = undefined; row.view.verification = 'unconfirmed'; row.view.error = '核对脚本没有返回与原操作匹配的回执；结果继续保持未知' }
        await this.save(current); return row.view
      })
    } finally { active.delete(receiptId); cancellations.delete(receiptId) }
  }
  async acceptInspection(sessionId: string, receiptId: string): Promise<SiteDeploymentReceipt> {
    return this.lock(sessionId, async () => {
      const data = await this.document(sessionId), row = data.receipts.find(item => item.view.id === receiptId)
      if (!row?.inspection || Date.now() - row.inspection.checkedAt > 5 * 60 * 1000) throw new Error('核对回执不存在或已过期')
      row.view.status = 'confirmed'; row.view.error = undefined; row.view.recoverySnapshotId = undefined; await this.save(data); return row.view
    })
  }
  async stopPreview(sessionId: string, id: string): Promise<void> {
    await this.lock(sessionId, async () => {
      const data = await this.document(sessionId), preview = data.previews.find(row => row.view.id === id)
      if (!preview) return
      stopSiteSnapshotPreview(id)
      if (data.receipts.some(row => row.view.snapshotId === id)) return
      data.previews = data.previews.filter(row => row.view.id !== id)
      await this.save(data)
      if (!data.previews.some(row => row.directory === preview.directory)) await rm(preview.directory, { recursive: true, force: true })
    })
  }
  dispose(): void { for (const process of active.values()) process.cancel(); stopAllSiteSnapshotPreviews() }
  private async assertPreviewCurrent(preview: SavedPreview, verifyFiles = true): Promise<void> {
    if (stableValueDigest(await this.owner(preview.owner.id)) !== stableValueDigest(preview.owner)) throw new Error('任务身份已变化，请重新准备发布')
    if (await siteExecutableDigest(preview.view.target.executable) !== preview.executableDigest) throw new Error('部署程序在预览后发生变化，请重新准备发布')
    if (siteEnvironmentDigest(preview.view.target) !== preview.environmentDigest) throw new Error('授权的部署环境变量已变化，请重新准备发布')
    if (verifyFiles) await verifySiteSnapshot(preview.directory, preview.view.files)
  }
  private async lock<T>(id: string, action: () => Promise<T>): Promise<T> {
    void id
    return withSiteStateLock(this.host.root(), action)
  }
}
function siteEnvironmentDigest(target: SiteDeploymentTarget): string {
  return stableValueDigest(target.environmentKeys.map(key => [key, process.env[key] ?? null]))
}
