import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, lstatSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { SessionMeta } from '../../shared/types'
import type { TaskHandoffIdentity, TaskHandoffHostIdentity, TaskHandoffReleaseProof } from '../../shared/task-handoff-types'
import type { TaskHandoffView, TaskHandoffRemoteCapabilities, TaskHandoffDestinationView } from '../../shared/task-handoff-api'
import { canonicalJson } from '../project-workspace/codec'
import { writeDurableFileSync } from '../durable-file'
import { getTaskHostExecutionGate, type TaskHostExecutionGate } from './execution-gate'
import { assertTaskHandoffIdentity, taskHandoffHostId, verifyTaskHandoffReleaseProof } from './ownership-store'
import { HandoffFileStore, HandoffDestinationStore, HANDOFF_FILE_LIMITS, HANDOFF_CHUNK_BYTES, captureHandoffFiles, validateHandoffFileManifest, handoffFileChunks, restoreHandoffFiles, verifyRestoredHandoffFiles, verifyCurrentHandoffSource, type HandoffFileEntry, type HandoffFileManifest } from './files'
import type { TaskHandoffBundle } from './task-bundle'
import { executeInteractiveOperationEffectInSessionQueue } from '../task/operation-effect-gateway'
import { getTaskSnapshot } from '../task/task-snapshot'
import { reconcileInteractiveOperationSnapshot } from '../ipc/operation-snapshot'

const MAX_ENVELOPE_BYTES = 32 * 1024 * 1024
const MAX_TRANSFER_BYTES = HANDOFF_FILE_LIMITS.bytes + MAX_ENVELOPE_BYTES
const MAX_BLOCKS = Math.ceil(MAX_TRANSFER_BYTES / HANDOFF_CHUNK_BYTES) + HANDOFF_FILE_LIMITS.files
const idPattern = /^[a-zA-Z0-9_-]{1,160}$/
const digestPattern = /^[a-f0-9]{64}$/
const digest = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex')
export interface TaskHandoffRemoteCaller { deviceId: string; projectId: string; publicKey: string }
interface Envelope { schemaVersion: 1; task: TaskHandoffBundle; files: HandoffFileManifest; sourceHost: TaskHandoffHostIdentity; generation: number }
interface PrepareInput { id: string; identity: TaskHandoffIdentity; sourceHost: TaskHandoffHostIdentity; generation: number; destinationId: string; envelope: HandoffFileEntry; bundleDigest: string; title: string; maxBytes: number }
interface Journal extends TaskHandoffView {
  schemaVersion: 1; direction: 'outgoing' | 'incoming'; destinationId: string; caller?: TaskHandoffRemoteCaller
  header: PrepareInput; sourceCwd?: string; chunks: string[]; receivedBytes: number; releaseProof?: TaskHandoffReleaseProof
  restored?: boolean; restoreAttempt?: number; importStarted?: boolean
}
export interface TaskHandoffBackend {
  getSession(id: string): SessionMeta | undefined
  stopAndReconcile(id: string): Promise<SessionMeta>
  beforeImport(id: string): Promise<void>
  capture(id: string): Promise<TaskHandoffBundle>
  assertSourceCurrent(bundle: TaskHandoffBundle): Promise<void>
  validate(bundle: TaskHandoffBundle): void
  previewImport(bundle: TaskHandoffBundle, targetCwd: string): Promise<{ canImport: boolean; conflicts: string[]; missingResources: string[] }>
  importBundle(bundle: TaskHandoffBundle, targetCwd: string): Promise<void>
  request(hostId: string, action: string, payload: unknown): Promise<unknown>
}
const instances = new Map<string, TaskHandoffService>()
export function configureTaskHandoffService(rootDir: string, backend: TaskHandoffBackend): TaskHandoffService {
  const key = resolve(rootDir), service = new TaskHandoffService(key, backend); instances.set(key, service); return service
}
export function handleTaskHandoffRemote(rootDir: string, caller: TaskHandoffRemoteCaller, action: string, payload: unknown, assertCurrent?: () => Promise<void>): Promise<unknown> {
  const service = instances.get(resolve(rootDir)); if (!service) throw new Error('当前主机尚未初始化任务交接。')
  return service.remote(caller, action, payload, assertCurrent)
}

/** A release is durable before it is sent. An uncertain response can never restore the old owner. */
export class TaskHandoffService {
  readonly blocks: HandoffFileStore
  readonly destinations: HandoffDestinationStore
  readonly gate: TaskHostExecutionGate
  private readonly journalRoot: string
  private readonly busy = new Set<string>()
  constructor(readonly rootDir: string, private backend: TaskHandoffBackend) {
    const privateRoot = join(rootDir, 'private', 'task-handoff')
    this.blocks = new HandoffFileStore(join(privateRoot, 'blocks'))
    this.destinations = new HandoffDestinationStore(join(privateRoot, 'receive-roots'))
    this.gate = getTaskHostExecutionGate(rootDir)
    this.journalRoot = join(privateRoot, 'journals'); mkdirSync(this.journalRoot, { recursive: true, mode: 0o700 })
  }
  list(sessionId?: string): TaskHandoffView[] {
    return readdirSync(this.journalRoot).filter(name => /^[a-zA-Z0-9_-]{1,160}\.json$/.test(name)).map(name => this.read(name.slice(0, -5)))
      .filter(row => !sessionId || row.identity.sessionId === sessionId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200).map(row => this.view(row))
  }
  localDestinations(): TaskHandoffDestinationView[] { return this.destinations.list().map(row => ({ id: row.id, label: basename(row.root), path: row.root, expiresAt: row.expiresAt, enabled: row.enabled })) }
  async targets(hostId: string): Promise<TaskHandoffRemoteCapabilities> {
    const result = await this.backend.request(hostId, 'capabilities', {}) as TaskHandoffRemoteCapabilities
    if (result?.protocolVersion !== 1 || !result.host || result.host.hostId !== taskHandoffHostId(result.host.publicKey) || !Array.isArray(result.destinations) || result.destinations.length > 20 || result.destinations.some(row => !row || !idPattern.test(row.id) || typeof row.path !== 'string' || row.path.length > 8192 || typeof row.enabled !== 'boolean' || !Number.isFinite(row.expiresAt))) throw new Error('目标主机不支持兼容的任务移交协议。')
    if (result.host.hostId === this.gate.store.hostIdentity().hostId) throw new Error('目标与当前安装实例相同。')
    return result
  }
  async prepare(input: { sessionId: string; hostId: string; destinationId: string }): Promise<TaskHandoffView> {
    const session = this.backend.getSession(input.sessionId)
    if (!session || !idPattern.test(input.hostId) || !idPattern.test(input.destinationId)) throw new Error('请选择原任务、已配对主机和接收目录。')
    const active = this.list(input.sessionId).find(row => row.direction === 'outgoing' && !['committed', 'cancelled'].includes(row.state))
    if (active) throw new Error('原任务存在未结束的移交，请核对或取消原操作。')
    const target = await this.targets(input.hostId)
    if (!target.destinations.some(row => row.id === input.destinationId && row.enabled && row.expiresAt > Date.now())) throw new Error('目标接收目录授权已失效。')
    const id = randomUUID(), identity = { sessionId: session.id, sessionCreatedAt: session.createdAt }
    return this.exclusive(id, async () => {
      // Create a visible recovery record before stopping the task or freezing its ownership.
      const row: Journal = { schemaVersion: 1, id, direction: 'outgoing', identity, title: session.title, state: 'preparing',
        hostId: input.hostId, sourceHostId: this.gate.store.hostIdentity().hostId, targetHostId: target.host.hostId,
        destinationId: input.destinationId, sourceCwd: session.cwd, createdAt: Date.now(), updatedAt: Date.now(), files: 0, bytes: 0,
        excluded: [], missingResources: [], chunks: [], receivedBytes: 0, header: undefined as unknown as PrepareInput }
      this.save(row)
      try {
        await this.gate.freeze(identity, id, async () => { await this.backend.stopAndReconcile(identity.sessionId) })
        const task = await this.backend.capture(identity.sessionId)
        this.backend.validate(task)
        if (task.identity.sessionId !== identity.sessionId || task.identity.sessionCreatedAt !== identity.sessionCreatedAt || task.cwd !== session.cwd) throw new Error('任务身份或目录已变化。')
        const files = captureHandoffFiles(task.cwd, this.blocks), sourceHost = this.gate.store.hostIdentity(), generation = this.gate.status(identity.sessionId)!.generation
        const envelope: Envelope = { schemaVersion: 1, task, files, sourceHost, generation }
        const bytes = Buffer.from(canonicalJson(envelope))
        if (bytes.length > MAX_ENVELOPE_BYTES) throw new Error('任务执行记录超过32MiB移交上限。')
        const entry = this.blocks.capture('task-handoff.json', bytes)
        row.header = { id, identity, sourceHost, generation, destinationId: input.destinationId, envelope: entry, bundleDigest: entry.sha256, title: task.title, maxBytes: files.totalBytes + bytes.length }
        row.files = files.entries.filter(entry => entry.kind === 'file').length; row.bytes = row.header.maxBytes; row.excluded = files.excluded
        row.chunks = [...new Set([...entry.chunks, ...handoffFileChunks(files)])]; row.state = 'uploading'; this.save(row)
        return await this.transfer(row)
      } catch (error) { this.fail(row, error); throw error }
    })
  }
  async commit(id: string, expectedPreview: string): Promise<TaskHandoffView> {
    return this.exclusive(id, async () => {
      const row = this.read(id); this.assertOutgoing(row)
      if (row.state === 'committed') { await this.reconcileEffect(row); return this.view(row) }
      if (row.releaseProof) return this.reconcileUnlocked(row)
      if (row.state !== 'ready' || row.previewDigest !== expectedPreview) throw new Error('请重新核对本次移交预览。')
      try {
        const envelope = this.envelope(row)
        // A restored desktop process must drain fresh in-memory permits again before release.
        await this.gate.freeze(row.identity, id, async () => { await this.backend.stopAndReconcile(row.identity.sessionId) })
        verifyCurrentHandoffSource(row.sourceCwd!, envelope.files)
        await this.backend.assertSourceCurrent(envelope.task)
        const target = await this.backend.request(row.hostId!, 'preview', { id }) as TaskHandoffView
        this.verifyRemote(row, target)
        if (target.state !== 'ready' || target.previewDigest !== expectedPreview) throw new Error('目标目录或记录已变化，请重新核对。')
        return await this.gate.withHandoffControl(row.identity, id, async () => {
          const outcome = await executeInteractiveOperationEffectInSessionQueue({
            rootDir: this.rootDir, operationId: id, source: 'session_lifecycle', kind: 'task_handoff', title: '移交任务到其他主机',
            sourceSessionId: row.identity.sessionId, projectId: envelope.task.projectId, cwd: row.sourceCwd!, toolName: 'task_handoff',
            toolInput: { sessionId: row.identity.sessionId, handoffId: id, bundleDigest: row.header.bundleDigest, previewDigest: row.previewDigest,
              sourceHostId: row.sourceHostId, targetHostId: row.targetHostId, rootDir: this.rootDir },
            execute: async () => {
              await this.backend.assertSourceCurrent(envelope.task)
              verifyCurrentHandoffSource(row.sourceCwd!, envelope.files)
              row.releaseProof = this.gate.release(row.identity, { targetHostId: row.targetHostId, handoffId: id, bundleDigest: this.releaseDigest(row) })
              row.state = 'released'; row.message = '源任务已停止执行；正在核对目标接收。'; this.save(row)
              return this.sendCommit(row)
            }, isSuccess: view => view.state === 'committed', resultSummary: view => JSON.stringify({ id, state: view.state }),
            failureDisposition: () => 'waiting_reconciliation'
          })
          if (outcome.status !== 'completed') { row.message = outcome.error; this.save(row) }
          return this.view(row)
        })
      } catch (error) { this.fail(row, error); throw error }
    })
  }
  async reconcile(id: string): Promise<TaskHandoffView> { return this.exclusive(id, async () => this.reconcileUnlocked(this.read(id))) }
  async cancel(id: string): Promise<TaskHandoffView> {
    return this.exclusive(id, async () => {
      const row = this.read(id); this.assertOutgoing(row)
      if (row.releaseProof || this.gate.status(row.identity.sessionId)?.state === 'released') throw new Error('任务所有权已经释放，只能核对原移交，不能在源端恢复执行。')
      if (row.state === 'cancelled') return this.view(row)
      // The receiver can never activate without a release proof. Unreachable staging may remain inert.
      if (row.header) await this.backend.request(row.hostId!, 'cancel', { id }).catch(() => undefined)
      if (this.gate.status(row.identity.sessionId)?.handoffId === id) this.gate.cancelBeforeRelease(row.identity, id)
      row.state = 'cancelled'; row.message = '移交已取消；原任务可手动继续，已传输的准备资料不会自动执行。'; this.save(row); return this.view(row)
    })
  }
  async remote(caller: TaskHandoffRemoteCaller, action: string, value: unknown, assertCurrent?: () => Promise<void>): Promise<unknown> {
    await assertCurrent?.()
    if (action === 'capabilities' || action === 'destinations') return { protocolVersion: 1, host: this.gate.store.hostIdentity(), destinations: this.localDestinations().filter(row => row.enabled && row.expiresAt > Date.now()) }
    if (!value || typeof value !== 'object' || !idPattern.test((value as { id: string }).id)) throw new Error('移交请求无效。')
    const input = value as Record<string, unknown>, id = input.id as string
    return this.exclusive(id, async () => {
      if (action === 'prepare') return this.receivePrepare(caller, value as PrepareInput)
      const row = this.read(id); this.assertCaller(row, caller)
      if (action === 'status') return this.view(row)
      if (action === 'cancel') {
        if (row.importStarted || row.releaseProof || row.state === 'committed') throw new Error('目标已进入接收提交，只能核对。')
        row.state = 'cancelled'; this.save(row); return this.view(row)
      }
      if (row.state === 'cancelled') throw new Error('本次移交已取消。')
      if (action === 'chunk') {
        if (row.state !== 'uploading') throw new Error('本次移交不再接受新资料块。')
        this.destinations.require(row.destinationId)
        const hash = input.digest as string, base64 = input.base64 as string
        if (!digestPattern.test(hash) || typeof base64 !== 'string') throw new Error('移交块无效。')
        if (!row.chunks.includes(hash)) {
          const bytes = Buffer.byteLength(base64, 'base64')
          if (row.chunks.length >= MAX_BLOCKS || row.receivedBytes + bytes > row.header.maxBytes) throw new Error('移交资料超过本次确认范围。')
          this.blocks.receive(hash, base64); row.chunks.push(hash); row.receivedBytes += bytes; this.save(row)
        } else this.blocks.receive(hash, base64)
        return { id, receivedBytes: row.receivedBytes }
      }
      if (action === 'preview') return this.receivePreview(row)
      if (action === 'commit') return this.receiveCommit(row, input.proof as TaskHandoffReleaseProof, input.previewDigest as string, assertCurrent)
      throw new Error('不支持此移交动作。')
    })
  }
  private receivePrepare(caller: TaskHandoffRemoteCaller, input: PrepareInput): TaskHandoffView {
    assertTaskHandoffIdentity(input.identity)
    if (!input.sourceHost || input.sourceHost.hostId !== taskHandoffHostId(input.sourceHost.publicKey) || !Number.isSafeInteger(input.generation) || input.generation < 0 || !digestPattern.test(input.bundleDigest) || typeof input.title !== 'string' || input.title.length > 2000 || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0 || input.maxBytes > MAX_TRANSFER_BYTES) throw new Error('移交来源或范围无效。')
    const entry = input.envelope
    if (!entry || entry.path !== 'task-handoff.json' || entry.kind !== 'file' || entry.bytes <= 0 || entry.bytes > MAX_ENVELOPE_BYTES || entry.sha256 !== input.bundleDigest || !Array.isArray(entry.chunks) || entry.chunks.length !== Math.ceil(entry.bytes / HANDOFF_CHUNK_BYTES) || entry.chunks.some(hash => !digestPattern.test(hash))) throw new Error('任务资料包头无效。')
    if (existsSync(this.path(input.id))) { const previous = this.read(input.id); this.assertCaller(previous, caller); if (canonicalJson(previous.header) !== canonicalJson(input)) throw new Error('同一交接标识的资料范围不一致。'); return this.view(previous) }
    this.destinations.require(input.destinationId)
    const own = this.gate.store.hostIdentity()
    if (own.hostId === input.sourceHost.hostId) throw new Error('移交两端必须是不同安装实例。')
    if (this.list(input.identity.sessionId).some(row => row.direction === 'incoming' && !['cancelled', 'committed'].includes(row.state))) throw new Error('此任务已有未结束的接收操作。')
    const row: Journal = { schemaVersion: 1, id: input.id, identity: input.identity, direction: 'incoming', title: input.title,
      state: 'uploading', sourceHostId: input.sourceHost.hostId, targetHostId: own.hostId, destinationId: input.destinationId,
      createdAt: Date.now(), updatedAt: Date.now(), files: 0, bytes: input.maxBytes, excluded: [], missingResources: [],
      header: input, caller, chunks: [], receivedBytes: 0 }
    this.save(row); return this.view(row)
  }
  private async receivePreview(row: Journal): Promise<TaskHandoffView> {
    if (row.state === 'committed') return this.view(row)
    if (row.releaseProof || row.importStarted) throw new Error('已接收释放证明，请核对本次提交。')
    const envelope = this.envelope(row); this.destinations.require(row.destinationId)
    for (const hash of handoffFileChunks(envelope.files)) this.blocks.read(hash)
    if (!row.restored) {
      if ((row.restoreAttempt ?? 0) >= 3) throw new Error('文件准备未成功，请在目标主机核对后取消本次准备。')
      row.restoreAttempt = (row.restoreAttempt ?? 0) + 1
      row.targetPath = this.destinations.reserve(row.destinationId, `${row.id}-${row.restoreAttempt}`)
      this.save(row)
      restoreHandoffFiles(row.targetPath, envelope.files, this.blocks)
      row.restored = true; this.save(row)
    }
    verifyRestoredHandoffFiles(row.targetPath!, envelope.files)
    const preview = await this.backend.previewImport(envelope.task, row.targetPath!)
    if (!preview.canImport) throw new Error(preview.conflicts.join('\n') || '原任务身份与目标记录存在冲突。')
    row.files = envelope.files.entries.filter(item => item.kind === 'file').length; row.excluded = envelope.files.excluded
    row.missingResources = preview.missingResources
    row.previewDigest = digest({ id: row.id, identity: row.identity, bundleDigest: row.header.bundleDigest, targetHostId: row.targetHostId, destinationId: row.destinationId, path: row.targetPath, missingResources: row.missingResources })
    row.state = 'ready'; row.message = '资料已核对，等待源主机确认释放任务。'; this.save(row); return this.view(row)
  }
  private async receiveCommit(row: Journal, proof: TaskHandoffReleaseProof, expectedPreview: string, assertCurrent?: () => Promise<void>): Promise<TaskHandoffView> {
    verifyTaskHandoffReleaseProof(proof, row.header.sourceHost.publicKey)
    if (proof.handoffId !== row.id || proof.identity.sessionId !== row.identity.sessionId || proof.identity.sessionCreatedAt !== row.identity.sessionCreatedAt || proof.fromHostId !== row.sourceHostId || proof.toHostId !== row.targetHostId || proof.fromGeneration !== row.header.generation || proof.bundleDigest !== this.releaseDigest(row) || row.previewDigest !== expectedPreview) throw new Error('任务释放证明与本次双端预览不匹配。')
    if (row.state === 'committed') return this.view(row)
    const ownership = this.gate.status(row.identity.sessionId)
    if (ownership?.state === 'owned' && ownership.ownerHostId === row.targetHostId && ownership.releaseProof && canonicalJson(ownership.releaseProof) === canonicalJson(proof)) {
      row.state = 'committed'; row.message = '已核对本机任务所有权，原接收已经完成。'; this.save(row); return this.view(row)
    }
    if (!row.restored || !row.targetPath || !['ready', 'importing', 'needs_reconciliation'].includes(row.state)) throw new Error('目标尚未完成资料准备。')
    if (row.releaseProof && canonicalJson(row.releaseProof) !== canonicalJson(proof)) throw new Error('原释放证明不一致。')
    this.destinations.require(row.destinationId)
    const envelope = this.envelope(row)
    verifyRestoredHandoffFiles(row.targetPath, envelope.files)
    row.releaseProof = proof; row.state = 'importing'; row.importStarted = true; this.save(row)
    try {
      this.gate.stageImported(row.identity, row.sourceHostId, row.id, row.header.generation)
      await this.backend.beforeImport(row.identity.sessionId)
      await assertCurrent?.()
      await this.backend.importBundle(envelope.task, row.targetPath)
      verifyRestoredHandoffFiles(row.targetPath, envelope.files)
      await assertCurrent?.()
      this.destinations.require(row.destinationId)
      verifyRestoredHandoffFiles(row.targetPath, envelope.files)
      this.gate.activateImported(proof, row.header.sourceHost.publicKey)
      row.state = 'committed'; row.message = '已接收原任务，自动运行保持暂停，可在本机手动继续。'; this.save(row)
      return this.view(row)
    } catch (error) { this.fail(row, error); throw error }
  }
  private async transfer(row: Journal): Promise<TaskHandoffView> {
    const remote = await this.backend.request(row.hostId!, 'prepare', row.header) as TaskHandoffView
    this.verifyRemote(row, remote)
    if (!['uploading', 'ready'].includes(remote.state)) throw new Error('目标接收状态不允许继续准备。')
    if (remote.state === 'uploading') for (const hash of row.chunks) await this.backend.request(row.hostId!, 'chunk', { id: row.id, digest: hash, base64: this.blocks.read(hash).toString('base64') })
    const view = await this.backend.request(row.hostId!, 'preview', { id: row.id }) as TaskHandoffView
    this.verifyRemote(row, view)
    if (view.state !== 'ready' || !view.previewDigest) throw new Error('目标尚未完成预览。')
    row.state = 'ready'; row.previewDigest = view.previewDigest; row.targetPath = view.targetPath; row.missingResources = view.missingResources
    row.message = '两端资料已准备，请确认目标路径与迁移范围。'; this.save(row); return this.view(row)
  }
  private async sendCommit(row: Journal): Promise<TaskHandoffView> {
    try {
      const remote = await this.backend.request(row.hostId!, 'commit', { id: row.id, proof: row.releaseProof, previewDigest: row.previewDigest }) as TaskHandoffView
      this.verifyRemote(row, remote)
      if (remote.state !== 'committed') throw new Error('目标接收结果尚未确认。')
      row.state = 'committed'; row.message = '任务已移交，源主机保留历史并停止执行。'; this.save(row); return this.view(row)
    } catch (error) { this.fail(row, error); return this.view(row) }
  }
  private async reconcileUnlocked(row: Journal): Promise<TaskHandoffView> {
    this.assertOutgoing(row)
    if (row.state === 'committed') { await this.reconcileEffect(row); return this.view(row) }
    if (row.state === 'cancelled') return this.view(row)
    const record = this.gate.status(row.identity.sessionId)
    if (!row.releaseProof && record?.state === 'released' && record.handoffId === row.id) { row.releaseProof = record.releaseProof; this.save(row) }
    if (!row.header) throw new Error('准备中断，请取消本次移交后重新开始。')
    const remote = await this.backend.request(row.hostId!, 'status', { id: row.id }) as TaskHandoffView
    this.verifyRemote(row, remote)
    if (remote.state === 'committed') {
      if (!row.releaseProof) throw new Error('目标声称已接收但缺少源端释放证明。')
      row.state = 'committed'; row.message = '已核对目标接收回执；原任务在目标主机。'; this.save(row); await this.reconcileEffect(row); return this.view(row)
    }
    if (row.releaseProof) {
      if (!['ready', 'importing', 'needs_reconciliation'].includes(remote.state)) throw new Error('目标状态待人工核对；源端不会重新获得执行权。')
      const result = await this.sendCommit(row) // Same signed proof and operation, after querying the original receipt.
      if (result.state === 'committed') await this.reconcileEffect(row)
      return result
    }
    verifyCurrentHandoffSource(row.sourceCwd!, this.envelope(row).files)
    return this.transfer(row)
  }
  private envelope(row: Journal): Envelope {
    if (!row.header) throw new Error('任务资料尚未准备。')
    const value = JSON.parse(this.blocks.content(row.header.envelope).toString('utf8')) as Envelope
    if (value.schemaVersion !== 1 || value.generation !== row.header.generation || value.sourceHost.hostId !== row.sourceHostId || value.sourceHost.publicKey !== row.header.sourceHost.publicKey || value.task.identity.sessionId !== row.identity.sessionId || value.task.identity.sessionCreatedAt !== row.identity.sessionCreatedAt) throw new Error('任务资料与原移交身份不一致。')
    this.backend.validate(value.task); validateHandoffFileManifest(value.files)
    if (row.header.maxBytes !== value.files.totalBytes + row.header.envelope.bytes) throw new Error('任务资料大小与确认范围不一致。')
    return value
  }
  private releaseDigest(row: Journal): string { return digest({ bundleDigest: row.header.bundleDigest, previewDigest: row.previewDigest, destinationId: row.destinationId, targetHostId: row.targetHostId }) }
  private async reconcileEffect(row: Journal): Promise<void> {
    const snapshot = await getTaskSnapshot(`operation:${row.id}`, this.rootDir)
    if (snapshot) await reconcileInteractiveOperationSnapshot(snapshot, { requireStored: true, rootDir: this.rootDir })
  }
  private assertOutgoing(row: Journal): void { if (row.direction !== 'outgoing' || !row.hostId) throw new Error('此操作不是本机发起的移交。') }
  private assertCaller(row: Journal, caller: TaskHandoffRemoteCaller): void { if (row.direction !== 'incoming' || canonicalJson(row.caller) !== canonicalJson(caller)) throw new Error('移交不属于当前已配对设备。') }
  private verifyRemote(row: Journal, value: TaskHandoffView): void {
    if (!value || value.id !== row.id || value.identity?.sessionId !== row.identity.sessionId || value.identity.sessionCreatedAt !== row.identity.sessionCreatedAt || value.sourceHostId !== row.sourceHostId || value.targetHostId !== row.targetHostId || value.direction !== 'incoming' || !Array.isArray(value.missingResources)) throw new Error('目标回执与原移交不一致。')
  }
  private path(id: string): string { if (!idPattern.test(id)) throw new Error('移交标识无效。'); return join(this.journalRoot, `${id}.json`) }
  private read(id: string): Journal {
    const path = this.path(id), info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('移交记录无法核对。')
    const row = JSON.parse(readFileSync(path, 'utf8')) as Journal
    if (row.schemaVersion !== 1 || row.id !== id || !['outgoing', 'incoming'].includes(row.direction) || !Array.isArray(row.chunks) || row.chunks.length > MAX_BLOCKS) throw new Error('移交记录损坏。')
    assertTaskHandoffIdentity(row.identity); return row
  }
  private save(row: Journal): void { row.updatedAt = Date.now(); writeDurableFileSync(this.path(row.id), JSON.stringify(row), { mode: 0o600 }) }
  private fail(row: Journal, error: unknown): void { row.state = 'needs_reconciliation'; row.message = (error instanceof Error ? error.message : '移交未确认').slice(0, 600); this.save(row) }
  private view(row: Journal): TaskHandoffView {
    const { schemaVersion: _schema, caller: _caller, header: _header, sourceCwd: _cwd, chunks: _chunks, receivedBytes: _received, releaseProof: _proof, restored: _restored, restoreAttempt: _attempt, importStarted: _started, destinationId: _destination, ...view } = row
    return { ...view, canCancelBeforeRelease: row.direction === 'outgoing' && !row.releaseProof && this.gate.status(row.identity.sessionId)?.state !== 'released' && !['committed', 'cancelled'].includes(row.state) }
  }
  private async exclusive<T>(id: string, action: () => Promise<T> | T): Promise<T> {
    if (this.busy.has(id)) throw new Error('本次移交正在处理，请等待原操作。')
    this.busy.add(id); try { return await action() } finally { this.busy.delete(id) }
  }
}
