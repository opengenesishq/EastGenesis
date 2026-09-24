import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import type { RemoteHostApi, RemoteHostCommandReceipt, RemoteHostPairingPreview, RemoteHostRevokeEnvelope, RemoteHostRenewEnvelope, RemoteHostView, RemoteHostApprovalReceipt } from '../../shared/remote-host-types'
import type { RemoteCommandEnvelope, RemoteCommandPayload, RemoteApprovalDecisionEnvelope } from '../../shared/remote-types'
import type { ProtectedStorageBackend } from '../security/protected-storage-runtime'
import type { RemoteWorkspaceBinding, RemoteWorkspaceRequest, RemoteWorkspaceView } from '../../shared/remote-workspace-types'
import { canonicalJson, digest } from '../project-workspace/codec'
import { RemoteHostStore, remoteHostView, type StoredRemoteHost, type StoredRemoteCommand, type StoredRemoteDecision } from './store'
import { parseRemoteHostPairing, type RemoteHostTransport } from './transport'
import { capabilities, commandKind, object, receipt, revision, tasks, text, approval, approvalCandidate } from './validation'
import { validateWorkspaceResponse } from './workspace-validation'
import { saveRemoteWorkspaceDownload } from './download'
import { taskHandoffPayload } from '../remote/task-handoff-protocol'
import type { RemoteTaskHandoffEnvelope } from '../../shared/remote-task-handoff-types'
import { consoleTokenDigest } from '../remote/console-renew-protocol'
import { assertCommandConnection, assertOriginalCommand, commandIntentDigest, validateCommandInput } from './command-intent'

import type { RemoteSshBinding, RemoteSshTunnelView } from '../../shared/ssh-types'
import type { RemoteSshTunnelManager, RemoteHostDialTarget } from '../ssh/tunnel'

interface Secrets { privateKey: string; consoleToken?: string }
interface PairingDraft extends RemoteHostPairingPreview { token: string; ssh?: RemoteSshBinding }
const unresolved = (command: RemoteHostCommandReceipt): boolean => command.createPhase === 'needs_reconciliation' || ['sending', 'unknown'].includes(command.state) ||
  command.state === 'received' && (['pending', 'offline'].includes(command.status ?? '') || command.status === 'accepted' && command.execution?.status !== 'failed' && command.execution?.status !== 'succeeded')

export class RemoteHostService implements RemoteHostApi {
  private readonly store: RemoteHostStore
  private readonly drafts = new Map<string, PairingDraft>()
  private readonly busy = new Set<string>()
  private readonly workspaces = new Map<string, { identity: string; binding: RemoteWorkspaceBinding }>()
  private draftGeneration = 0
  private closed = false
  constructor(root: string, protection: ProtectedStorageBackend, private readonly transport: RemoteHostTransport, private readonly now = Date.now, private readonly tunnels?: RemoteSshTunnelManager) {
    this.store = new RemoteHostStore(root, protection)
  }
  async listRemoteSshTunnels(ownerId?: number): Promise<RemoteSshTunnelView[]> { return this.tunnels?.list(ownerId) ?? [] }
  async startRemoteHostSshTunnel(input: Parameters<RemoteHostApi['startRemoteHostSshTunnel']>[0], ownerId = 0): Promise<RemoteSshTunnelView> {
    if (this.closed || Boolean(input.pairingUrl) === Boolean(input.hostId)) throw new Error('请选择配对链接或已有远端连接。')
    const sshHostId = text(input.sshHostId), sshHostRevision = revision(input.sshHostRevision)
    let origin: string
    if (input.hostId) {
      const host = this.store.get(text(input.hostId))
      if (!host.ssh || host.ssh.sshHostId !== sshHostId || host.ssh.sshHostRevision !== sshHostRevision) throw new Error('原 SSH 主机配置已变化，请重新核对并配对。原未知操作记录仍保留。')
      origin = host.identity.origin
    } else origin = parseRemoteHostPairing(text(input.pairingUrl, 2048)).origin
    const generation = this.draftGeneration
    return this.exclusive(`ssh-start:${sshHostId}`, async () => {
      const tunnel = await this.requireTunnels().start(sshHostId, sshHostRevision, origin, ownerId)
      if (this.closed || generation !== this.draftGeneration) { this.requireTunnels().close(tunnel.id, ownerId); throw new Error('窗口已变化，SSH 隧道已关闭。') }
      return tunnel
    })
  }
  async writeRemoteSshTunnelInput(id: string, input: string, ownerId = 0): Promise<void> { this.requireTunnels().write(text(id), input, ownerId) }
  async closeRemoteSshTunnel(id: string, ownerId = 0): Promise<void> { this.requireTunnels().close(text(id), ownerId); this.workspaces.clear() }
  private requireTunnels(): RemoteSshTunnelManager { if (!this.tunnels) throw new Error('SSH 隧道不可用。'); return this.tunnels }
  private dial(host: StoredRemoteHost): RemoteHostDialTarget | undefined { return host.ssh ? this.requireTunnels().resolve(host.ssh) : undefined }
  async listRemoteHosts(): ReturnType<RemoteHostApi['listRemoteHosts']> {
    return { hosts: this.store.read().map(host => remoteHostView(host, this.now())), secureStorageAvailable: this.store.available() }
  }
  invalidatePairingPreviews(): void { this.drafts.clear(); this.workspaces.clear(); this.tunnels?.closeAll('窗口已变化，SSH 隧道已断开。'); this.draftGeneration++ }
  dispose(): void { this.closed = true; this.tunnels?.dispose(); this.invalidatePairingPreviews(); this.transport.dispose?.() }
  async inspectRemoteHostPairing(pairingUrl: string, tunnelId?: string, ownerId = 0): Promise<RemoteHostPairingPreview> {
    if (this.closed) throw new Error('远端主机服务已停止。')
    const generation = this.draftGeneration
    const target = parseRemoteHostPairing(pairingUrl)
    const ssh = tunnelId ? this.requireTunnels().binding(tunnelId, ownerId) : undefined
    if (ssh && ssh.httpsOrigin !== target.origin) throw new Error('SSH 隧道与配对来源不匹配。')
    const identity = await this.transport.inspect(target.origin, ssh ? this.requireTunnels().resolve(ssh) : undefined)
    if (this.closed || generation !== this.draftGeneration) throw new Error('窗口已变化，请重新检查服务器身份。')
    if (identity.origin !== target.origin || !/^sha256:[a-f0-9]{64}$/.test(identity.spkiFingerprint)) throw new Error('服务器身份无法确认。')
    for (const [id, draft] of this.drafts) if (draft.expiresAt <= this.now()) this.drafts.delete(id)
    if (this.drafts.size >= 20) throw new Error('待确认连接过多，请稍后重试。')
    const draft: PairingDraft = { id: randomUUID(), identity, expiresAt: this.now() + 5 * 60_000, token: target.token, ...(ssh ? { ssh } : {}) }
    this.drafts.set(draft.id, draft)
    return { id: draft.id, identity: structuredClone(identity), expiresAt: draft.expiresAt }
  }
  async pairRemoteHost(input: Parameters<RemoteHostApi['pairRemoteHost']>[0]): Promise<RemoteHostView> {
    if (this.closed) throw new Error('远端主机服务已停止。')
    const draft = this.drafts.get(input.previewId)
    if (!draft || draft.expiresAt <= this.now()) throw new Error('服务器身份确认已过期，请重新检查配对链接。')
    if (input.confirmedSpkiFingerprint !== draft.identity.spkiFingerprint) throw new Error('请先核对并确认此服务器证书指纹。')
    if (!['encrypted', 'session'].includes(input.storage)) throw new Error('请选择加密保存或仅本次运行配对。')
    const label = text(input.label, 120), deviceLabel = text(input.deviceLabel, 120)
    this.drafts.delete(draft.id)
    const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const secret: Secrets = { privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') }
    const host: StoredRemoteHost = { id: randomUUID(), label, storage: input.storage, identity: draft.identity, ...(draft.ssh ? { ssh: draft.ssh } : {}), status: 'pairing_unknown', createdAt: this.now(),
      capabilities: [], commands: [], sealedCredentials: this.store.seal(secret, input.storage) }
    this.store.save(host)
    try {
      const response = await this.transport.request(host.identity, 'POST', '/remote/pair/register', undefined,
        { token: draft.token, label: deviceLabel, userId: 'local-user', publicKey }, this.dial(host))
      if (response.status !== 201) throw new Error('远端没有完成配对。请在远端检查设备列表并重新生成配对链接。')
      const data = object(response.body), consoleUrl = new URL(text(data.consoleUrl, 2048))
      const token = /^\/remote\/console\/([A-Za-z0-9_-]{32})$/.exec(consoleUrl.pathname)?.[1]
      if (data.protocolVersion !== 1 || consoleUrl.origin !== host.identity.origin || consoleUrl.search || consoleUrl.hash || consoleUrl.username || consoleUrl.password || !token ||
        data.fingerprint !== `sha256:${createHash('sha256').update(publicKey).digest('hex')}`) throw new Error('远端配对协议或设备身份不匹配，请在远端撤销刚创建的设备。')
      const expiresAt = revision(data.expiresAt)
      if (expiresAt <= this.now() || expiresAt > this.now() + 48 * 60 * 60_000) throw new Error('远端配对有效期无效。')
      const updated = this.store.update(host.id, item => {
        item.deviceId = text(data.deviceId); item.projectId = text(data.projectId); item.expiresAt = expiresAt
        item.capabilities = capabilities(data.capabilities); item.status = 'paired'; item.error = undefined
        item.sealedCredentials = this.store.seal({ ...secret, consoleToken: token }, item.storage)
      })
      return remoteHostView(updated, this.now())
    } catch {
      return remoteHostView(this.store.update(host.id, item => { item.error = '配对结果未确认。请在远端检查并撤销本设备，再生成新链接；不会自动重复注册。' }), this.now())
    }
  }
  async readRemoteHostTasks(hostId: string): ReturnType<RemoteHostApi['readRemoteHostTasks']> {
    const host = this.activeHost(hostId), secret = this.credentials(host)
    try {
      const response = await this.transport.request(host.identity, 'GET', '/remote/console-api', secret.consoleToken, undefined, this.dial(host))
      if (response.status !== 200) throw new Error('远端拒绝访问，请检查连接有效期、权限和配对状态。')
      const result = tasks(response.body, host)
      this.store.update(host.id, item => { item.lastCheckedAt = this.now(); item.projectName = result.projectName; item.capabilities = result.capabilities; item.error = undefined })
      return result
    } catch (error) {
      this.store.update(host.id, item => { item.error = '无法读取远端任务，请核对网络、服务器身份与配对有效期。' })
      throw error
    }
  }
  /** Exactly one transport attempt. The task-handoff service persists its
   * original payload.id and resolves unknown outcomes through status queries. */
  async requestTaskHandoff(hostId: string, action: string, payload: unknown): Promise<unknown> {
    const validated = taskHandoffPayload(action, payload)
    return this.exclusive(`task-handoff:${hostId}`, async () => {
      const host = this.activeHost(text(hostId)), secret = this.credentials(host)
      const identity = digest({ identity: host.identity, deviceId: host.deviceId, projectId: host.projectId })
      const generation = this.draftGeneration, createdAt = this.now()
      const unsigned: Omit<RemoteTaskHandoffEnvelope, 'signature'> = {
        schemaVersion: 1, kind: 'task_handoff', requestId: randomUUID(), action: validated.action,
        issuerDeviceId: host.deviceId!, projectId: host.projectId!, createdAt, expiresAt: createdAt + 5 * 60_000,
        payloadDigest: digest(validated.payload), payload: validated.payload
      }
      const envelope: RemoteTaskHandoffEnvelope = { ...unsigned, signature: this.signature(secret, unsigned) }
      try {
        // Capabilities are checked live on the remote host, not inferred from
        // this connection's cached capability list after permission changes.
        const response = await this.transport.request(host.identity, 'POST', '/remote/task-handoff', secret.consoleToken, envelope, this.dial(host))
        const current = this.activeHost(host.id)
        if (this.closed || generation !== this.draftGeneration || identity !== digest({ identity: current.identity, deviceId: current.deviceId, projectId: current.projectId })) throw new Error('Connection changed')
        const body = object(response.body)
        if (response.status !== 200 || body.protocolVersion !== 1 || body.requestId !== unsigned.requestId || body.action !== action ||
          body.issuerDeviceId !== host.deviceId || body.projectId !== host.projectId || body.payloadDigest !== unsigned.payloadDigest || !Object.hasOwn(body, 'result')) throw new Error('Unconfirmed task handoff response')
        return body.result
      } catch {
        throw new Error('移交结果未确认。请按原移交 ID 查询状态；不会自动重试或另建移交。')
      }
    })
  }
  async sendRemoteHostCommand(input: Parameters<RemoteHostApi['sendRemoteHostCommand']>[0]): Promise<RemoteHostCommandReceipt> {
    input = validateCommandInput(input)
    const { hostId, requestId } = input
    return this.exclusive(hostId, async () => {
      let host = this.store.get(hostId)
      assertCommandConnection(input, host)
      const existing = host.commands.find(command => command.requestId === requestId)
      if (existing) {
        assertOriginalCommand(input, host, existing, this.store.unseal<RemoteCommandEnvelope>(existing.sealedEnvelope))
        return this.commandView(existing)
      }
      host = this.activeHost(hostId)
      const kind = commandKind(input.kind), expectedRevision = revision(input.expectedRevision)
      const workItemId = input.workItemId === undefined ? undefined : text(input.workItemId)
      const routineId = input.routineId === undefined ? undefined : text(input.routineId)
      if (host.commands.some(command => command.workItemId === workItemId && unresolved(command))) throw new Error('此任务有尚未确认的命令。请先按原命令 ID 核对结果。')
      const snapshot = await this.readRemoteHostTasks(hostId), task = snapshot.workItems.find(item => item.id === workItemId)
      const requiredCapability = kind === 'resume_work_item' ? 'resume_work_item' : ['create_task', 'trigger_routine', 'approve_effect'].includes(kind) ? kind : 'control_work_item'
      if (!snapshot.capabilities.includes(requiredCapability as import('../../shared/remote-types').RemoteDeviceCapability)) throw new Error('当前设备权限或任务状态不允许此操作。')
      let candidate: ReturnType<typeof approvalCandidate> | undefined
      if (kind === 'create_task' || kind === 'trigger_routine') {
        if (workItemId || expectedRevision !== snapshot.projectRevision) throw new Error('远端项目版本已变化，请刷新。')
        if (kind === 'trigger_routine' && !snapshot.routines.some(item => item.id === routineId)) throw new Error('远端计划任务不可用。')
      } else {
        const allowed = task && (kind === 'resume_work_item' ? task.canResume : kind === 'append_task' ? task.canAppend : kind === 'pause_work_item' ? task.canPause : kind === 'approve_effect' ? true : task.canCancel)
        if (!task || task.revision !== expectedRevision) throw new Error('远端任务版本已变化，请刷新后再操作。')
        if (!allowed) throw new Error('当前设备权限或任务状态不允许此操作。')
        if (kind === 'approve_effect') {
          candidate = approvalCandidate(input.approvalCandidate)
          if (candidate.workItemId !== workItemId || candidate.revision !== expectedRevision || !snapshot.approvalCandidates.some(item => digest(item) === digest(candidate))) throw new Error('远端审批目标已变化，请刷新。')
        }
      }
      if (kind !== 'trigger_routine' && routineId) throw new Error('此命令不接受计划任务身份。')
      const commandId = randomUUID(), createdAt = this.now()
      const payload: RemoteCommandPayload | undefined = kind === 'append_task' ? { kind, text: text(input.text, 200_000), clientRequestId: `remote-${commandId}` }
        : kind === 'create_task' ? { kind, objective: text(input.text, 20_000) }
        : kind === 'approve_effect' && candidate ? { kind, sessionId: candidate.sessionId, permissionRequestId: candidate.permissionRequestId, action: candidate.action, targetDigest: candidate.targetDigest, dataScope: candidate.dataScope }
        : kind === 'pause_work_item' || kind === 'cancel_work_item' ? { kind } : undefined
      const scope: RemoteCommandEnvelope['scope'] = { projectId: host.projectId!, ...(workItemId ? { workItemId } : {}), ...(routineId ? { routineId } : {}), artifactIds: [], dataClass: 'metadata_only' }
      const unsigned = { schemaVersion: 1 as const, commandId, issuerDeviceId: host.deviceId!, kind, scope, revision: expectedRevision,
        createdAt, expiresAt: createdAt + 5 * 60_000, payloadDigest: digest(payload ?? { kind, scope, revision: expectedRevision }), ...(payload ? { payload } : {}) }
      const secret = this.credentials(host), envelope: RemoteCommandEnvelope = { ...unsigned, signature: this.signature(secret, unsigned) }
      const command: StoredRemoteCommand = { commandId, requestId, kind, workItemId, routineId, createdAt, state: 'sending',
        ...(input.source ? { source: input.source } : {}), intentDigest: commandIntentDigest(input, host), sealedEnvelope: this.store.seal(envelope, host.storage) }
      host = this.store.update(host.id, item => {
        if (item.commands.length >= 500) throw new Error('此连接的命令记录已达上限，请在远端撤销后重新配对。')
        item.commands.push(command)
      })
      // The original signed identity is persisted before sending. Any uncertain result is read back by this exact ID.
      try { await this.transport.request(host.identity, 'POST', '/remote/console-api', secret.consoleToken, { token: secret.consoleToken, envelope }, this.dial(host)) }
      catch { /* Never create a replacement command or resend after an uncertain transport result. */ }
      return this.queryCommand(host, command)
    })
  }
  async findRemoteHostCommandByRequestId(hostId: string, requestId: string): Promise<RemoteHostCommandReceipt | null> {
    if (this.closed) throw new Error('远端主机服务已停止。')
    hostId = text(hostId)
    if (this.busy.has(hostId)) throw new Error('此主机有操作正在进行，请等待结果后再核对原提交。')
    const id = text(requestId, 160)
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('请求标识无效。')
    const command = this.store.get(hostId).commands.find(item => item.requestId === id)
    return command ? this.commandView(command) : null
  }
  async reconcileRemoteHostCommand(hostId: string, commandId: string): Promise<RemoteHostCommandReceipt> {
    return this.exclusive(hostId, async () => {
      const host = this.activeHost(hostId), command = host.commands.find(item => item.commandId === commandId)
      if (!command) throw new Error('未找到此主机的原命令。')
      return this.queryCommand(host, command)
    })
  }
  async describeRemoteWorkspace(hostId: string, workItemId: string): Promise<RemoteWorkspaceView> {
    return this.workspaceRead(text(hostId), { operation: 'describe', workItemId: text(workItemId) })
  }
  async readRemoteWorkspace(input: Parameters<RemoteHostApi['readRemoteWorkspace']>[0]): Promise<RemoteWorkspaceView> {
    const hostId = text(input.hostId), binding = object(input.binding) as unknown as RemoteWorkspaceBinding
    if (!['list', 'read', 'git_status', 'git_diff', 'file_info', 'file_chunk'].includes(input.operation)) throw new Error('远端工作区操作无效。')
    const cached = this.workspaces.get(`${hostId}:${binding.workItemId}`)
    if (!cached || digest(cached.binding) !== digest(binding)) throw new Error('请先重新打开此远端工作区。')
    return this.workspaceRead(hostId, { workItemId: binding.workItemId, binding, operation: input.operation, path: input.path, cursor: input.cursor, file: input.file, offset: input.offset })
  }
  async saveRemoteWorkspaceFile(input: Parameters<RemoteHostApi['saveRemoteWorkspaceFile']>[0], selectPath?: (suggested: string) => Promise<string | undefined>): ReturnType<RemoteHostApi['saveRemoteWorkspaceFile']> {
    if (!selectPath) throw new Error('远端文件只能通过主窗口原生另存入口保存。')
    const generation = this.draftGeneration
    const assertCurrent = () => { if (this.closed || generation !== this.draftGeneration) throw new Error('窗口已变化，另存已取消。'); this.activeHost(input.hostId) }
    return this.exclusive(`download:${input.hostId}`, () => saveRemoteWorkspaceDownload(input, value => this.readRemoteWorkspace(value), selectPath, assertCurrent))
  }
  private async workspaceRead(hostId: string, request: RemoteWorkspaceRequest): Promise<RemoteWorkspaceView> {
    const host = this.activeHost(hostId), generation = this.draftGeneration, hostIdentity = digest({ identity: host.identity, deviceId: host.deviceId, projectId: host.projectId })
    const key = `${hostId}:${request.workItemId}`, cached = this.workspaces.get(key)
    if (request.binding && cached?.identity !== hostIdentity) throw new Error('远端主机身份已变化。')
    const response = await this.transport.request(host.identity, 'POST', '/remote/workspace-read', this.credentials(host).consoleToken, request, this.dial(host))
    const current = this.activeHost(hostId)
    if (generation !== this.draftGeneration || hostIdentity !== digest({ identity: current.identity, deviceId: current.deviceId, projectId: current.projectId })) throw new Error('窗口或远端连接已变化，读取结果已丢弃。')
    if (response.status !== 200) { this.workspaces.delete(key); throw new Error(typeof object(response.body).error === 'string' ? String(object(response.body).error).slice(0, 500) : '远端工作区读取失败。') }
    const result = validateWorkspaceResponse(response.body, host, request)
    if (this.workspaces.size >= 100 && !this.workspaces.has(key)) this.workspaces.clear()
    this.workspaces.set(key, { identity: hostIdentity, binding: result.binding })
    return result
  }
  async decideRemoteHostApproval(input: Parameters<RemoteHostApi['decideRemoteHostApproval']>[0]): Promise<RemoteHostApprovalReceipt> {
    const hostId = text(input.hostId), requestId = text(input.requestId, 160)
    if (!/^[A-Za-z0-9_-]+$/.test(requestId) || !['approve', 'reject'].includes(input.decision)) throw new Error('审批决定无效。')
    return this.exclusive(hostId, async () => {
      let host = this.activeHost(hostId)
      const existing = host.decisions?.find(item => item.requestId === requestId)
      if (existing) return this.decisionView(existing)
      const id = text(input.approvalId)
      if (host.decisions?.some(item => item.approvalId === id && (item.state !== 'received' || item.approval?.status === 'pending'))) throw new Error('原审批决定尚未确认，请先核对原决定。')
      const snapshot = await this.readRemoteHostTasks(hostId), target = snapshot.approvals.find(item => item.id === id)
      if (!snapshot.capabilities.includes('approve_effect') || !target || target.recordRevision !== revision(input.expectedRevision) || target.approvalDigest !== input.approvalDigest || target.expiresAt <= this.now()) throw new Error('审批目标、版本或权限已变化，请刷新。')
      const unsigned = { schemaVersion: 1 as const, approvalId: id, issuerDeviceId: host.deviceId!, decision: input.decision,
        expectedRecordRevision: target.recordRevision, approvalDigest: target.approvalDigest, createdAt: this.now(), expiresAt: Math.min(target.expiresAt, this.now() + 300_000) }
      const secret = this.credentials(host), envelope: RemoteApprovalDecisionEnvelope = { ...unsigned, signature: this.signature(secret, unsigned) }
      const decision: StoredRemoteDecision = { requestId, approvalId: id, decision: input.decision, createdAt: unsigned.createdAt, state: 'sending', sealedDecision: this.store.seal(envelope, host.storage) }
      host = this.store.update(hostId, item => { item.decisions ??= []; if (item.decisions.length >= 500) throw new Error('审批回执数量已达上限。'); item.decisions.push(decision) })
      try { await this.transport.request(host.identity, 'POST', '/remote/console-api', secret.consoleToken, { token: secret.consoleToken, decision: envelope }, this.dial(host)) } catch { /* Query only the original approval; never replay a decision. */ }
      return this.queryApproval(host, decision)
    })
  }
  async reconcileRemoteHostApproval(hostId: string, requestId: string): Promise<RemoteHostApprovalReceipt> {
    return this.exclusive(hostId, async () => {
      const host = this.activeHost(hostId), decision = host.decisions?.find(item => item.requestId === requestId)
      if (!decision) throw new Error('原审批决定不存在。')
      return this.queryApproval(host, decision)
    })
  }
  private async queryApproval(host: StoredRemoteHost, decision: StoredRemoteDecision): Promise<RemoteHostApprovalReceipt> {
    let patch: Partial<RemoteHostApprovalReceipt>
    try {
      const result = await this.transport.request(host.identity, 'GET', `/remote/console-approval?approvalId=${encodeURIComponent(decision.approvalId)}`, this.credentials(host).consoleToken, undefined, this.dial(host))
      const body = object(result.body), original = this.store.unseal<RemoteApprovalDecisionEnvelope>(decision.sealedDecision)
      if (result.status !== 200 || body.protocolVersion !== 1 || body.deviceId !== host.deviceId || body.projectId !== host.projectId) throw new Error('审批身份不匹配。')
      const item = approval(body.approval)
      if (item.id !== decision.approvalId || item.approvalDigest !== original.approvalDigest || item.recordRevision < original.expectedRecordRevision ||
        item.status === 'approved' && decision.decision !== 'approve' || item.status === 'rejected' && decision.decision !== 'reject') throw new Error('审批回执不匹配。')
      patch = { state: 'received', approval: item, error: item.status === 'pending' ? '远端尚未确认此决定，请继续核对原审批。' : undefined }
    } catch { patch = { state: 'unknown', error: '审批结果未知，请恢复连接后核对原审批，不要重复提交。' } }
    const updated = this.store.update(host.id, item => Object.assign(item.decisions!.find(value => value.requestId === decision.requestId)!, patch))
    return this.decisionView(updated.decisions!.find(item => item.requestId === decision.requestId)!)
  }
  private decisionView({ sealedDecision: _sealed, ...receipt }: StoredRemoteDecision): RemoteHostApprovalReceipt {
    return { ...receipt, state: receipt.state === 'sending' ? 'unknown' : receipt.state }
  }
  async renewRemoteHost(hostId: string): Promise<RemoteHostView> {
    return this.exclusive(text(hostId), async () => {
      const host = this.store.get(hostId)
      if (!host.deviceId || !host.projectId || !['paired', 'expired'].includes(host.status)) throw new Error('此连接无法续期。已撤销设备必须由远端重新授权。')
      const secret = this.credentials(host), createdAt = this.now()
      // An unknown reply retains the exact signed request and original token,
      // encrypted together with this host's existing credentials across restart.
      const unsigned: Omit<RemoteHostRenewEnvelope, 'signature'> = { schemaVersion: 1, kind: 'renew_console',
        issuerDeviceId: host.deviceId, projectId: host.projectId, oldConsoleTokenDigest: consoleTokenDigest(secret.consoleToken!),
        requestId: randomUUID(), createdAt, expiresAt: createdAt + 5 * 60_000 }
      const envelope: RemoteHostRenewEnvelope = host.sealedRenew ? this.store.unseal(host.sealedRenew) : { ...unsigned, signature: this.signature(secret, unsigned) }
      if (envelope.issuerDeviceId !== host.deviceId || envelope.projectId !== host.projectId || envelope.oldConsoleTokenDigest !== unsigned.oldConsoleTokenDigest) throw new Error('待核对续期请求与原连接不匹配。')
      const dial = this.dial(host)
      if (!host.sealedRenew) this.store.update(hostId, item => {
        item.sealedRenew = this.store.seal(envelope, item.storage)
        item.renewal = { requestId: envelope.requestId, createdAt: envelope.createdAt }
      })
      try {
        const response = await this.transport.request(host.identity, 'POST', '/remote/console-renew', secret.consoleToken, envelope, dial)
        const result = object(response.body)
        if (this.closed || result.protocolVersion !== 1 || result.requestId !== envelope.requestId || result.deviceId !== host.deviceId ||
          result.projectId !== host.projectId || result.oldConsoleTokenDigest !== envelope.oldConsoleTokenDigest) throw new Error('续期身份未确认。')
        if (response.status === 409 && result.status === 'not_received') {
          return remoteHostView(this.store.update(hostId, item => {
            item.sealedRenew = undefined; item.renewal = undefined
            item.error = '远端确认原续期请求未生效且已过期。可再次点击“续期连接”发起新请求。'
          }), this.now())
        }
        if (response.status !== 200 || result.status !== 'renewed' || typeof result.consoleToken !== 'string' ||
          !/^[A-Za-z0-9_-]{32}$/.test(result.consoleToken) || result.consoleToken === secret.consoleToken) throw new Error('续期结果未确认。')
        const expiresAt = revision(result.expiresAt), currentCapabilities = capabilities(result.capabilities)
        // A recovered original receipt may itself have expired. Save that exact
        // token and show expired so the user can explicitly renew it once more.
        if (expiresAt <= envelope.createdAt || expiresAt > this.now() + 24 * 60 * 60_000 + 30_000) throw new Error('续期有效期无效。')
        return remoteHostView(this.store.update(hostId, item => {
          item.sealedCredentials = this.store.seal({ ...secret, consoleToken: result.consoleToken }, item.storage)
          item.sealedRenew = undefined; item.renewal = undefined; item.status = 'paired'; item.expiresAt = expiresAt
          item.capabilities = currentCapabilities; item.lastCheckedAt = this.now(); item.error = undefined
        }), this.now())
      } catch {
        return remoteHostView(this.store.update(hostId, item => {
          item.error = '续期结果未确认。请核对原续期请求；不会重新配对或更换设备。若远端已撤销设备或移除权限，续期不会恢复授权。'
        }), this.now())
      }
    })
  }
  async revokeRemoteHost(hostId: string): Promise<RemoteHostView> {
    return this.exclusive(hostId, async () => {
      const host = this.store.get(hostId)
      if (host.sealedRenew) throw new Error('请先核对原续期结果，或直接在远端设备列表撤销。')
      if (!host.deviceId || !host.projectId || host.status === 'revoked' || host.status === 'pairing_unknown') throw new Error('此连接无法从本机确认撤销，请在远端设备列表中处理。')
      const secret = this.credentials(host), createdAt = this.now()
      const unsigned = { schemaVersion: 1 as const, kind: 'revoke_device' as const, issuerDeviceId: host.deviceId, projectId: host.projectId,
        requestId: randomUUID(), createdAt, expiresAt: createdAt + 5 * 60_000 }
      const revoke: RemoteHostRevokeEnvelope = host.sealedRevoke ? this.store.unseal(host.sealedRevoke) : { ...unsigned, signature: this.signature(secret, unsigned) }
      this.store.update(hostId, item => { item.status = 'revocation_unknown'; item.sealedRevoke = this.store.seal(revoke, item.storage) })
      try {
        const response = await this.transport.request(host.identity, 'POST', '/remote/console-revoke', secret.consoleToken, revoke, this.dial(host))
        const result = object(response.body)
        if (response.status !== 200 || result.protocolVersion !== 1 || result.deviceId !== host.deviceId || result.status !== 'revoked') throw new Error('撤销未确认')
        return remoteHostView(this.store.update(hostId, item => {
          item.status = 'revoked'; item.sealedCredentials = undefined; item.sealedRevoke = undefined; item.sealedRenew = undefined; item.renewal = undefined; item.commands = []; item.error = undefined
        }), this.now())
      } catch {
        return remoteHostView(this.store.update(hostId, item => { item.error = '未收到远端撤销确认。请在远端设备列表核对并撤销；删除本地记录不能代替远端撤权。' }), this.now())
      }
    })
  }
  async forgetRemoteHost(hostId: string): Promise<void> {
    if (this.busy.has(hostId)) throw new Error('此主机操作尚未结束，请稍后删除记录。')
    this.store.forget(hostId)
  }
  private activeHost(id: string): StoredRemoteHost {
    if (this.closed) throw new Error('远端主机服务已停止。')
    const host = this.store.get(id)
    if (host.sealedRenew) throw new Error('连接续期结果待核对，请先核对原续期请求。')
    if (host.status !== 'paired' || !host.projectId || !host.deviceId || (host.expiresAt ?? 0) <= this.now()) throw new Error('连接已过期、被撤销或尚未确认，请检查配对状态。')
    this.dial(host)
    return host
  }
  private credentials(host: StoredRemoteHost): Secrets {
    const secret = this.store.unseal<Secrets>(host.sealedCredentials)
    if (!secret.privateKey || !secret.consoleToken || !/^[A-Za-z0-9_-]{32}$/.test(secret.consoleToken)) throw new Error('远端连接凭据不完整。')
    return secret
  }
  private signature(secret: Secrets, unsigned: unknown): string {
    return sign(null, Buffer.from(canonicalJson(unsigned)), createPrivateKey({ key: Buffer.from(secret.privateKey, 'base64'), format: 'der', type: 'pkcs8' })).toString('base64')
  }
  private async queryCommand(host: StoredRemoteHost, command: StoredRemoteCommand): Promise<RemoteHostCommandReceipt> {
    let patch: Partial<RemoteHostCommandReceipt>
    try {
      const response = await this.transport.request(host.identity, 'GET', `/remote/console-command?commandId=${encodeURIComponent(command.commandId)}`, this.credentials(host).consoleToken, undefined, this.dial(host))
      if (response.status !== 200) throw new Error('命令回执不可用')
      patch = receipt(response.body, host, command)
    } catch { patch = { state: 'unknown', error: '命令结果未知。请恢复连接后核对原命令，不要重复提交。' } }
    const updated = this.store.update(host.id, item => { Object.assign(item.commands.find(current => current.commandId === command.commandId)!, patch) })
    return this.commandView(updated.commands.find(item => item.commandId === command.commandId)!)
  }
  private commandView(command: StoredRemoteCommand): RemoteHostCommandReceipt {
    const { intentDigest: _intent, sealedEnvelope: _envelope, ...view } = command
    return { ...view, state: view.state === 'sending' ? 'unknown' : view.state }
  }
  private async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('远端主机服务已停止。')
    if (this.busy.has(id)) throw new Error('此主机有操作正在进行，请等待结果。')
    this.busy.add(id)
    try { return await operation() } finally { this.busy.delete(id) }
  }
}
