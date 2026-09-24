import { createPublicKey, verify } from 'node:crypto'
import { canonicalJson, digest } from '../project-workspace/codec'
import { REMOTE_TASK_HANDOFF_ACTIONS, type RemoteTaskHandoffAction, type RemoteTaskHandoffEnvelope } from '../../shared/remote-task-handoff-types'

const ID = /^[a-zA-Z0-9_-]{1,160}$/
export const REMOTE_TASK_HANDOFF_MAX_PAYLOAD_BYTES = 240 * 1024

export function taskHandoffPayload(action: unknown, value: unknown): { action: RemoteTaskHandoffAction; payload: Record<string, unknown> } {
  if (typeof action !== 'string' || !(REMOTE_TASK_HANDOFF_ACTIONS as readonly string[]).includes(action)) throw new Error('任务移交动作无效。')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务移交参数无效。')
  // Freeze exactly the JSON bytes that the transport will send before hashing.
  const serialized = JSON.stringify(value)
  if (!serialized || Buffer.byteLength(serialized) > REMOTE_TASK_HANDOFF_MAX_PAYLOAD_BYTES) throw new Error('任务移交分块过大。')
  const payload = JSON.parse(serialized) as Record<string, unknown>
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('任务移交参数无效。')
  if (!['capabilities', 'destinations'].includes(action) && (typeof payload.id !== 'string' || !ID.test(payload.id))) throw new Error('任务移交必须携带原移交 ID。')
  return { action: action as RemoteTaskHandoffAction, payload }
}

export function verifyTaskHandoffEnvelope(value: unknown, publicKey: string, deviceId: string, projectId: string, now = Date.now()): RemoteTaskHandoffEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务移交信封无效。')
  const input = value as RemoteTaskHandoffEnvelope
  const allowed = new Set(['schemaVersion', 'kind', 'requestId', 'action', 'issuerDeviceId', 'projectId', 'createdAt', 'expiresAt', 'payloadDigest', 'payload', 'signature'])
  if (Object.keys(input).some(key => !allowed.has(key)) || input.schemaVersion !== 1 || input.kind !== 'task_handoff' ||
    input.issuerDeviceId !== deviceId || input.projectId !== projectId || typeof input.requestId !== 'string' || !ID.test(input.requestId) ||
    !Number.isSafeInteger(input.createdAt) || input.createdAt < 1 || !Number.isSafeInteger(input.expiresAt) ||
    input.createdAt > now + 30_000 || input.expiresAt <= now || input.expiresAt <= input.createdAt || input.expiresAt - input.createdAt > 5 * 60_000 ||
    typeof input.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(input.signature) || typeof input.payloadDigest !== 'string') throw new Error('任务移交身份、有效期或签名格式无效。')
  const { payload } = taskHandoffPayload(input.action, input.payload)
  if (input.payloadDigest !== digest(payload)) throw new Error('任务移交参数摘要不匹配。')
  const { signature, ...unsigned } = input
  let valid = false
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
    valid = key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(canonicalJson(unsigned)), key, Buffer.from(signature, 'base64'))
  } catch { /* Invalid or revoked device keys never authorize a request. */ }
  if (!valid) throw new Error('任务移交签名无效。')
  return { ...input, payload }
}
