import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { RemoteHostCommandReceipt, RemoteHostView, RemoteHostApprovalReceipt } from '../../shared/remote-host-types'
import type { ProtectedStorageBackend } from '../security/protected-storage-runtime'
import { writeDurableFileSync } from '../durable-file'

export interface StoredRemoteCommand extends RemoteHostCommandReceipt { requestId: string; sealedEnvelope: string; intentDigest?: string }
export interface StoredRemoteDecision extends RemoteHostApprovalReceipt { sealedDecision: string }
export interface StoredRemoteHost extends Omit<RemoteHostView, 'commands' | 'decisions'> {
  sealedCredentials?: string
  sealedRevoke?: string
  sealedRenew?: string
  commands: StoredRemoteCommand[]
  decisions?: StoredRemoteDecision[]
}
export class RemoteHostStore {
  private readonly sessionHosts = new Map<string, StoredRemoteHost>()
  private readonly sessionSecrets = new Map<string, string>()
  constructor(private readonly root: string, private readonly protection: ProtectedStorageBackend) {}
  available(): boolean {
    try { return this.protection.isEncryptionAvailable() && !['basic_text', 'unavailable'].includes(this.protection.getSelectedStorageBackend()) } catch { return false }
  }
  seal(value: unknown, storage: 'encrypted' | 'session' = 'encrypted'): string {
    if (storage === 'session') {
      const key = `mem:${randomUUID()}`
      this.sessionSecrets.set(key, JSON.stringify(value)); return key
    }
    if (!this.available()) throw new Error('系统凭据加密不可用，无法保存远端连接。请使用受信任的正式应用。')
    return `enc:${this.protection.encryptString(JSON.stringify(value)).toString('base64')}`
  }
  unseal<T>(value: string | undefined): T {
    if (value?.startsWith('mem:')) {
      const memory = this.sessionSecrets.get(value)
      if (!memory) throw new Error('仅本次运行的连接已失效，请重新配对。')
      return JSON.parse(memory) as T
    }
    if (!this.available() || !value?.startsWith('enc:')) throw new Error('无法解锁远端连接凭据。')
    try { return JSON.parse(this.protection.decryptString(Buffer.from(value.slice(4), 'base64'))) as T }
    catch { throw new Error('无法解锁远端连接凭据。请在远端撤销旧配对后重新连接。') }
  }
  read(): StoredRemoteHost[] {
    return [...this.readPersistent(), ...structuredClone([...this.sessionHosts.values()])]
  }
  private readPersistent(): StoredRemoteHost[] {
    let text: string
    try { text = readFileSync(join(this.root, 'remote-hosts', 'hosts.json'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const data = JSON.parse(text)
    if (data.version !== 1 || !Array.isArray(data.hosts) || data.hosts.length > 100) throw new Error('远端主机目录格式无效。')
    for (const host of data.hosts) {
      if (!host || host.storage !== 'encrypted' || typeof host.id !== 'string' || typeof host.label !== 'string' || !host.identity ||
        !/^sha256:[a-f0-9]{64}$/.test(host.identity.spkiFingerprint) || !Array.isArray(host.commands) || host.commands.length > 500 ||
        (host.decisions !== undefined && (!Array.isArray(host.decisions) || host.decisions.length > 500)) || !Array.isArray(host.capabilities) || !['paired', 'expired', 'pairing_unknown', 'revocation_unknown', 'revoked'].includes(host.status)) throw new Error('远端主机目录记录无效。')
      const url = new URL(host.identity.origin)
      if (url.protocol !== 'https:' || url.origin !== host.identity.origin || url.username || url.password) throw new Error('远端主机来源无效。')
      if (host.ssh && (host.ssh.httpsOrigin !== host.identity.origin || typeof host.ssh.sshHostId !== 'string' || !Number.isSafeInteger(host.ssh.sshHostRevision) || !/^[a-f0-9]{64}$/.test(host.ssh.sshConfigDigest))) throw new Error('远端 SSH 绑定无效。')
      if (host.sealedCredentials && !host.sealedCredentials.startsWith('enc:')) throw new Error('远端凭据必须加密保存。')
      if (host.sealedRenew && !host.sealedRenew.startsWith('enc:')) throw new Error('连接续期请求必须加密保存。')
    }
    return data.hosts
  }
  get(id: string): StoredRemoteHost {
    const host = this.read().find(item => item.id === id)
    if (!host) throw new Error('远端主机不存在。')
    return host
  }
  save(host: StoredRemoteHost): void {
    if (host.storage === 'session') {
      if (!this.sessionHosts.has(host.id) && this.sessionHosts.size >= 100) throw new Error('本次运行的连接数量已达上限。')
      this.sessionHosts.set(host.id, structuredClone(host)); this.pruneSessionSecrets(); return
    }
    const hosts = this.readPersistent(), index = hosts.findIndex(item => item.id === host.id)
    if (index < 0) { if (hosts.length >= 100) throw new Error('远端主机目录已达上限。'); hosts.push(host) } else hosts[index] = host
    this.write(hosts)
  }
  update(id: string, edit: (host: StoredRemoteHost) => void): StoredRemoteHost {
    const host = this.get(id); edit(host); this.save(host); return host
  }
  forget(id: string): void {
    if (this.sessionHosts.delete(id)) { this.pruneSessionSecrets(); return }
    this.write(this.readPersistent().filter(host => host.id !== id))
  }
  private pruneSessionSecrets(): void {
    const used = new Set([...this.sessionHosts.values()].flatMap(host => [host.sealedCredentials, host.sealedRevoke, host.sealedRenew, ...host.commands.map(command => command.sealedEnvelope), ...(host.decisions ?? []).map(decision => decision.sealedDecision)]))
    for (const key of this.sessionSecrets.keys()) if (!used.has(key)) this.sessionSecrets.delete(key)
  }
  private write(hosts: StoredRemoteHost[]): void { writeDurableFileSync(join(this.root, 'remote-hosts', 'hosts.json'), JSON.stringify({ version: 1, hosts })) }
}
export function remoteHostView(host: StoredRemoteHost, now = Date.now()): RemoteHostView {
  const { sealedCredentials: _credentials, sealedRevoke: _revoke, sealedRenew: _renew, commands, decisions, ...view } = host
  return { ...view, status: view.status === 'paired' && (view.expiresAt ?? 0) <= now ? 'expired' : view.status,
    decisions: decisions?.map(({ sealedDecision: _decision, ...receipt }) => ({ ...receipt, state: receipt.state === 'sending' ? 'unknown' : receipt.state })),
    commands: commands.map(({ sealedEnvelope: _envelope, intentDigest: _intent, ...command }) => ({ ...command, state: command.state === 'sending' ? 'unknown' : command.state })) }
}
