import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableFileSync } from '../durable-file'
import type { RemoteHostRenewEnvelope } from '../../shared/remote-host-types'
import { canonicalJson } from '../project-workspace/codec'

interface ConsoleRenewal { requestId: string; requestDigest: string; tokenDigest: string; expiresAt: number }
interface ConsoleSession { expiresAt: number; deviceId: string; projectId: string; renewal?: ConsoleRenewal }
const hash = (token: string): string => createHash('sha256').update(token).digest('hex')
/** Keep only token digests on disk. The mobile device retains its original URL and signing key. */
export class RemoteConsoleSessionStore {
  constructor(private readonly root: string) {}
  private path(): string { return join(this.root, 'remote', 'console-sessions.json') }
  private read(): Record<string, ConsoleSession> {
    let raw: string
    try { raw = readFileSync(this.path(), 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
    const data = JSON.parse(raw)
    if (data.version !== 1 || !data.sessions || typeof data.sessions !== 'object' || Array.isArray(data.sessions)) throw new Error('手机连接记录损坏，请重新配对。')
    const sessions: Record<string, ConsoleSession> = {}
    for (const [key, value] of Object.entries(data.sessions) as Array<[string, ConsoleSession]>) {
      if (!/^[a-f0-9]{64}$/.test(key) || !value || !Number.isSafeInteger(value.expiresAt) || typeof value.deviceId !== 'string' || typeof value.projectId !== 'string') throw new Error('手机连接记录无效，请重新配对。')
      if (value.renewal && (typeof value.renewal.requestId !== 'string' || !/^[a-f0-9]{64}$/.test(value.renewal.requestDigest) ||
        !/^[a-f0-9]{64}$/.test(value.renewal.tokenDigest) || !Number.isSafeInteger(value.renewal.expiresAt))) throw new Error('连接续期记录无效。')
      // Expired bindings are retained solely for signed renewal by the same device.
      sessions[key] = value
    }
    return sessions
  }
  put(token: string, session: ConsoleSession): void {
    const sessions = this.read()
    if (Object.keys(sessions).length >= 1000) throw new Error('手机连接数量已达上限，请撤销不再使用的设备。')
    sessions[hash(token)] = session
    writeDurableFileSync(this.path(), JSON.stringify({ version: 1, sessions }))
  }
  get(token: string): ConsoleSession | undefined {
    const session = this.readForRenew(token)
    return session && session.expiresAt > Date.now() && !session.renewal ? session : undefined
  }
  readForRenew(token: string): ConsoleSession | undefined { return /^[A-Za-z0-9_-]{32}$/.test(token) ? this.read()[hash(token)] : undefined }
  /** Called only after live device authorization and signature verification.
   * A single durable write commits the new session and original request receipt. */
  renew(token: string, envelope: RemoteHostRenewEnvelope, now = Date.now()): { status: 'renewed'; consoleToken: string; expiresAt: number } | { status: 'not_received' } {
    const sessions = this.read(), old = sessions[hash(token)], requestDigest = hash(canonicalJson(envelope))
    if (!old || envelope.oldConsoleTokenDigest !== hash(token) || old.deviceId !== envelope.issuerDeviceId || old.projectId !== envelope.projectId) throw new Error('原连接与续期身份不匹配。')
    // Derive the same unguessable token on replay without persisting plaintext.
    const nextToken = createHmac('sha256', token).update(`caogen-console-renew-v1:${requestDigest}`).digest().subarray(0, 24).toString('base64url')
    if (old.renewal) {
      if (old.renewal.requestId !== envelope.requestId || old.renewal.requestDigest !== requestDigest || old.renewal.tokenDigest !== hash(nextToken)) throw new Error('此连接已续期，请核对原续期请求。')
      if (!sessions[old.renewal.tokenDigest]) throw new Error('续期连接记录已撤销。')
      return { status: 'renewed', consoleToken: nextToken, expiresAt: old.renewal.expiresAt }
    }
    if (envelope.expiresAt <= now) return { status: 'not_received' }
    if (Object.keys(sessions).length >= 1000) throw new Error('连接记录已达上限，请在远端撤销不再使用的设备。')
    const expiresAt = now + 24 * 60 * 60_000
    old.renewal = { requestId: envelope.requestId, requestDigest, tokenDigest: hash(nextToken), expiresAt }
    sessions[hash(nextToken)] = { expiresAt, deviceId: old.deviceId, projectId: old.projectId }
    writeDurableFileSync(this.path(), JSON.stringify({ version: 1, sessions }))
    return { status: 'renewed', consoleToken: nextToken, expiresAt }
  }
  revokeDevice(deviceId: string): void {
    const sessions = this.read()
    for (const [key, value] of Object.entries(sessions)) if (value.deviceId === deviceId) delete sessions[key]
    writeDurableFileSync(this.path(), JSON.stringify({ version: 1, sessions }))
  }
}
