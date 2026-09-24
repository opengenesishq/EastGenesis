import type { RemoteHostView } from '../../../../shared/remote-host-types'
import type { RemoteSshBinding } from '../../../../shared/ssh-types'

export interface WelcomeRemoteTarget {
  kind: 'remote'
  hostId: string
  projectId: string
  deviceId: string
  origin: string
  spkiFingerprint: string
  ssh?: RemoteSshBinding
  hostLabel: string
  projectLabel: string
}
export type WelcomeExecutionTarget = { kind: 'local' } | WelcomeRemoteTarget
export interface RemoteIntakeReference {
  target: WelcomeRemoteTarget
  requestId: string
  createdAt: number
  draftVersion: number
  intentDigest: string
  commandId?: string
}
export function remoteTarget(host: RemoteHostView): WelcomeRemoteTarget {
  if (!host.deviceId || !host.projectId) throw new Error('配对尚未确认。')
  return { kind: 'remote', hostId: host.id, projectId: host.projectId, deviceId: host.deviceId,
    origin: host.identity.origin, spkiFingerprint: host.identity.spkiFingerprint,
    ...(host.ssh ? { ssh: { ...host.ssh } } : {}), hostLabel: host.label, projectLabel: host.projectName ?? host.projectId }
}
export function remoteConnection(target: WelcomeRemoteTarget) {
  return { projectId: target.projectId, deviceId: target.deviceId, origin: target.origin,
    spkiFingerprint: target.spkiFingerprint, ...(target.ssh ? { ssh: { ...target.ssh } } : {}) }
}
export function sameRemoteTarget(target: WelcomeRemoteTarget, host: RemoteHostView): boolean {
  if (host.id !== target.hostId || host.projectId !== target.projectId || host.deviceId !== target.deviceId ||
    host.identity.origin !== target.origin || host.identity.spkiFingerprint !== target.spkiFingerprint) return false
  return sameRemoteConnection(remoteConnection(target), { projectId: host.projectId!, deviceId: host.deviceId!, origin: host.identity.origin, spkiFingerprint: host.identity.spkiFingerprint, ssh: host.ssh })
}
export function sameRemoteConnection(left: ReturnType<typeof remoteConnection>, right: ReturnType<typeof remoteConnection>): boolean {
  return left.projectId === right.projectId && left.deviceId === right.deviceId && left.origin === right.origin && left.spkiFingerprint === right.spkiFingerprint &&
    ((!left.ssh && !right.ssh) || !!left.ssh && !!right.ssh && left.ssh.sshHostId === right.ssh.sshHostId && left.ssh.sshHostRevision === right.ssh.sshHostRevision && left.ssh.sshConfigDigest === right.ssh.sshConfigDigest && left.ssh.httpsOrigin === right.ssh.httpsOrigin)
}
export function parseExecutionTarget(value: unknown): WelcomeExecutionTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.kind === 'local') return { kind: 'local' }
  if (row.kind !== 'remote' || !['hostId', 'projectId', 'deviceId', 'origin', 'spkiFingerprint', 'hostLabel', 'projectLabel'].every(key => typeof row[key] === 'string' && !!row[key] && (row[key] as string).length <= 2048)) return null
  try { const origin = new URL(row.origin as string); if (origin.protocol !== 'https:' || origin.origin !== row.origin) return null } catch { return null }
  if (!/^sha256:[a-f0-9]{64}$/.test(row.spkiFingerprint as string)) return null
  const ssh = row.ssh as RemoteSshBinding | undefined
  if (ssh && (typeof ssh !== 'object' || typeof ssh.sshHostId !== 'string' || !Number.isSafeInteger(ssh.sshHostRevision) ||
    !/^[a-f0-9]{64}$/.test(ssh.sshConfigDigest) || ssh.httpsOrigin !== row.origin)) return null
  return { kind: 'remote', hostId: row.hostId as string, projectId: row.projectId as string, deviceId: row.deviceId as string,
    origin: row.origin as string, spkiFingerprint: row.spkiFingerprint as string, hostLabel: row.hostLabel as string, projectLabel: row.projectLabel as string,
    ...(ssh ? { ssh: { sshHostId: ssh.sshHostId, sshHostRevision: ssh.sshHostRevision, sshConfigDigest: ssh.sshConfigDigest, httpsOrigin: ssh.httpsOrigin } } : {}) }
}
export function parseRemoteIntakes(value: unknown): RemoteIntakeReference[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(row => {
    if (!row || typeof row !== 'object') return []
    const target = parseExecutionTarget(row.target)
    if (target?.kind !== 'remote' || typeof row.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(row.requestId) ||
      !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.draftVersion) || !/^[a-f0-9]{64}$/.test(row.intentDigest) ||
      row.commandId !== undefined && (typeof row.commandId !== 'string' || row.commandId.length > 160)) return []
    return [{ target, requestId: row.requestId, createdAt: row.createdAt, draftVersion: row.draftVersion, intentDigest: row.intentDigest,
      ...(row.commandId ? { commandId: row.commandId } : {}) }]
  })
}
