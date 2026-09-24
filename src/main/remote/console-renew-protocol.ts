import { createHash, createPublicKey, verify } from 'node:crypto'
import type { RemoteHostRenewEnvelope } from '../../shared/remote-host-types'
import { canonicalJson } from '../project-workspace/codec'

export const consoleTokenDigest = (token: string): string => createHash('sha256').update(token).digest('hex')

/** Authenticate even a stale envelope so its original durable receipt can be read.
 * The store separately rejects stale requests which have never been applied. */
export function verifyConsoleRenew(value: unknown, publicKey: string, deviceId: string, projectId: string, token: string, now = Date.now()): RemoteHostRenewEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('连接续期请求无效。')
  const input = value as RemoteHostRenewEnvelope
  const allowed = new Set(['schemaVersion', 'kind', 'issuerDeviceId', 'projectId', 'oldConsoleTokenDigest', 'requestId', 'createdAt', 'expiresAt', 'signature'])
  if (Object.keys(input).some(key => !allowed.has(key)) || input.schemaVersion !== 1 || input.kind !== 'renew_console' ||
    input.issuerDeviceId !== deviceId || input.projectId !== projectId || input.oldConsoleTokenDigest !== consoleTokenDigest(token) ||
    typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(input.requestId) ||
    !Number.isSafeInteger(input.createdAt) || !Number.isSafeInteger(input.expiresAt) || input.createdAt > now + 30_000 ||
    input.expiresAt <= input.createdAt || input.expiresAt - input.createdAt > 5 * 60_000 ||
    typeof input.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(input.signature)) throw new Error('连接续期身份或有效期无效。')
  const { signature, ...unsigned } = input
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonicalJson(unsigned)), key, Buffer.from(signature, 'base64'))) throw new Error('连接续期签名无效。')
  return input
}
