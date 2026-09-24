import type { RemoteHostApi, RemoteHostExpectedConnection } from '../../shared/remote-host-types'
import type { RemoteCommandEnvelope } from '../../shared/remote-types'
import type { StoredRemoteHost, StoredRemoteCommand } from './store'
import { canonicalJson, digest } from '../project-workspace/codec'
import { approvalCandidate, commandKind, object, revision, text } from './validation'

type CommandInput = Parameters<RemoteHostApi['sendRemoteHostCommand']>[0]
const allowed = new Set(['hostId', 'kind', 'workItemId', 'routineId', 'expectedRevision', 'text', 'requestId', 'approvalCandidate', 'source', 'expectedConnection'])
export function validateCommandInput(raw: CommandInput): CommandInput {
  const input = object(raw)
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('远端命令包含不支持的参数；模型、目录及权限使用远端配置。')
  const kind = commandKind(input.kind), requestId = text(input.requestId, 160)
  if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) throw new Error('远端提交标识无效。')
  if (input.source !== undefined && input.source !== 'welcome') throw new Error('远端提交来源无效。')
  if (input.source === 'welcome' && (kind !== 'create_task' || !input.expectedConnection)) throw new Error('欢迎任务必须绑定所选远端项目。')
  if (!['create_task', 'append_task'].includes(kind) && input.text !== undefined || kind !== 'approve_effect' && input.approvalCandidate !== undefined) throw new Error('命令包含不适用的任务参数。')
  return { hostId: text(input.hostId), kind, expectedRevision: revision(input.expectedRevision), requestId,
    ...(input.workItemId === undefined ? {} : { workItemId: text(input.workItemId) }),
    ...(input.routineId === undefined ? {} : { routineId: text(input.routineId) }),
    ...(kind === 'create_task' || kind === 'append_task' ? { text: text(input.text, kind === 'create_task' ? 20_000 : 200_000) } : {}),
    ...(input.approvalCandidate === undefined ? {} : { approvalCandidate: approvalCandidate(input.approvalCandidate) }),
    ...(input.source === 'welcome' ? { source: 'welcome' as const } : {}),
    ...(input.expectedConnection === undefined ? {} : { expectedConnection: expectedConnection(input.expectedConnection) }) }
}
function expectedConnection(raw: unknown): RemoteHostExpectedConnection {
  const value = object(raw)
  if (Object.keys(value).some(key => !['projectId', 'deviceId', 'origin', 'spkiFingerprint', 'ssh'].includes(key))) throw new Error('远端连接绑定无效。')
  const origin = text(value.origin, 2048), fingerprint = text(value.spkiFingerprint)
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.origin !== origin || !/^sha256:[a-f0-9]{64}$/.test(fingerprint)) throw new Error('远端连接身份无效。')
  let ssh: RemoteHostExpectedConnection['ssh']
  if (value.ssh !== undefined) {
    const candidate = object(value.ssh)
    if (Object.keys(candidate).some(key => !['sshHostId', 'sshHostRevision', 'sshConfigDigest', 'httpsOrigin'].includes(key)) || !/^[a-f0-9]{64}$/.test(String(candidate.sshConfigDigest)) || candidate.httpsOrigin !== origin) throw new Error('原 SSH 连接绑定无效。')
    ssh = { sshHostId: text(candidate.sshHostId), sshHostRevision: revision(candidate.sshHostRevision), sshConfigDigest: candidate.sshConfigDigest as string, httpsOrigin: origin }
  }
  return { projectId: text(value.projectId), deviceId: text(value.deviceId), origin, spkiFingerprint: fingerprint, ...(ssh ? { ssh } : {}) }
}
export function hostCommandBinding(host: StoredRemoteHost): RemoteHostExpectedConnection {
  if (!host.projectId || !host.deviceId) throw new Error('远端连接尚未绑定项目。')
  return { projectId: host.projectId, deviceId: host.deviceId, origin: host.identity.origin, spkiFingerprint: host.identity.spkiFingerprint, ...(host.ssh ? { ssh: host.ssh } : {}) }
}
export function assertCommandConnection(input: CommandInput, host: StoredRemoteHost): void {
  if (input.expectedConnection && canonicalJson(input.expectedConnection) !== canonicalJson(hostCommandBinding(host))) throw new Error('所选远端主机、项目或连接身份已变化，请重新选择。')
}
function material(input: CommandInput, host: StoredRemoteHost): unknown {
  return { binding: hostCommandBinding(host), kind: input.kind, workItemId: input.workItemId ?? null, routineId: input.routineId ?? null,
    expectedRevision: input.expectedRevision, text: input.text ?? null, approvalCandidate: input.approvalCandidate ?? null, source: input.source ?? null }
}
export function commandIntentDigest(input: CommandInput, host: StoredRemoteHost): string { return digest(material(input, host)) }
export function assertOriginalCommand(input: CommandInput, host: StoredRemoteHost, stored: StoredRemoteCommand, original: RemoteCommandEnvelope): void {
  if (original.issuerDeviceId !== host.deviceId || original.scope.projectId !== host.projectId) throw new Error('原命令不属于当前连接。')
  if (stored.intentDigest) {
    if (stored.intentDigest !== commandIntentDigest(input, host)) throw new Error('同一提交标识不能用于不同目标、版本或正文；请核对原命令。')
    return
  }
  // Older outbox records have only their original signed payload. Never resend them.
  const payload = original.payload
  const sameText = input.text === (payload?.kind === 'create_task' ? payload.objective : payload?.kind === 'append_task' ? payload.text : undefined)
  const candidate = input.approvalCandidate
  const sameApproval = payload?.kind !== 'approve_effect' ? !candidate : !!candidate && candidate.sessionId === payload.sessionId &&
    candidate.permissionRequestId === payload.permissionRequestId && candidate.action === payload.action && candidate.targetDigest === payload.targetDigest && candidate.dataScope === payload.dataScope
  if (input.kind !== original.kind || input.workItemId !== original.scope.workItemId || input.routineId !== original.scope.routineId || input.expectedRevision !== original.revision || !sameText || !sameApproval || input.source !== stored.source) throw new Error('同一提交标识与原命令内容不一致。')
}
