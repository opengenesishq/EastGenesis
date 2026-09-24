import { createPublicKey, verify } from 'node:crypto'
import type { RemoteHostRevokeEnvelope } from '../../shared/remote-host-types'
import { canonicalJson } from '../project-workspace/codec'

export function verifyRemoteHostRevoke(value: unknown, publicKey: string, deviceId: string, projectId: string, now = Date.now()): RemoteHostRevokeEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('撤销请求无效')
  const input = value as RemoteHostRevokeEnvelope
  const allowed = new Set(['schemaVersion', 'kind', 'issuerDeviceId', 'projectId', 'requestId', 'createdAt', 'expiresAt', 'signature'])
  if (Object.keys(input).some(key => !allowed.has(key)) || input.schemaVersion !== 1 || input.kind !== 'revoke_device' ||
    input.issuerDeviceId !== deviceId || input.projectId !== projectId || typeof input.requestId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,160}$/.test(input.requestId) || !Number.isSafeInteger(input.createdAt) || !Number.isSafeInteger(input.expiresAt) ||
    input.createdAt > now + 30_000 || input.expiresAt <= now || input.expiresAt - input.createdAt > 5 * 60_000 || input.expiresAt <= input.createdAt || typeof input.signature !== 'string') throw new Error('撤销请求身份或有效期无效')
  const { signature, ...unsigned } = input
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonicalJson(unsigned)), key, Buffer.from(signature, 'base64'))) throw new Error('撤销请求签名无效')
  return input
}
