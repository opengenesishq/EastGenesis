import type { FrozenNativeProtocol, FrozenRunRoutingPolicyV1 } from '../../shared/frozen-routing-types'
import type { ProviderConnectionIdentity } from '../../shared/provider-connection-identity'
import { parseFrozenRoutingPolicy } from '../../shared/frozen-routing-parser'
import type { TaskRunRecord } from '../../shared/types'
import { digest } from './workflow-ledger-canonical'

export type FrozenRoutingErrorCode = 'INVALID_POLICY' | 'POLICY_CONFLICT' | 'OWNER_MISMATCH' | 'FIRST_BINDING_REQUIRED'
  | 'RUN_ALREADY_STARTED' | 'STALE_RUN' | 'MISSING_SNAPSHOT' | 'BINDING_UNAVAILABLE'
export class FrozenRoutingPolicyError extends Error {
  readonly name = 'FrozenRoutingPolicyError'
  constructor(readonly code: FrozenRoutingErrorCode, message: string) { super(message) }
}

export function sealFrozenRoutingPolicy(input: Omit<FrozenRunRoutingPolicyV1, 'policyDigest'>): FrozenRunRoutingPolicyV1 {
  const candidate = parsePolicy({ ...input, policyDigest: '0'.repeat(64) })
  candidate.policyDigest = contentDigest(candidate)
  return deepFreeze(candidate)
}

export function verifyFrozenRoutingPolicy(value: unknown): FrozenRunRoutingPolicyV1 {
  const parsed = parsePolicy(value)
  if (contentDigest(parsed) !== parsed.policyDigest) throw new FrozenRoutingPolicyError('INVALID_POLICY', 'Frozen routing content digest does not match its immutable policy.')
  return deepFreeze(parsed)
}

/** Presence is intentional: a malformed/undefined new field must not become legacy. */
export function frozenRoutingPolicyForRun(run: object): FrozenRunRoutingPolicyV1 | undefined {
  if (!Object.hasOwn(run, 'routingPolicy')) return undefined
  const record = run as Record<string, unknown>
  const policy = verifyFrozenRoutingPolicy(record.routingPolicy)
  const owner = policy.owner
  if (owner.runId !== record.id || owner.sessionId !== record.sessionId || owner.taskId !== record.taskId) {
    throw new FrozenRoutingPolicyError('OWNER_MISMATCH', 'Frozen routing owner differs from TaskRun identity.')
  }
  if (record.messageId !== undefined && policy.messageId !== record.messageId) {
    throw new FrozenRoutingPolicyError('OWNER_MISMATCH', 'Frozen routing input identity differs from TaskRun message.')
  }
  return policy
}

export function isFrozenRoutingPolicyForRun(run: object): boolean {
  try { frozenRoutingPolicyForRun(run); return true } catch { return false }
}

export function mergeFrozenRoutingPolicy(current: TaskRunRecord, incoming: TaskRunRecord): FrozenRunRoutingPolicyV1 | undefined {
  const previous = frozenRoutingPolicyForRun(current)
  const next = frozenRoutingPolicyForRun(incoming)
  if (current.id !== incoming.id) return next
  if ((previous || next) && (current.sessionId !== incoming.sessionId || current.taskId !== incoming.taskId)) {
    throw new FrozenRoutingPolicyError('OWNER_MISMATCH', 'A bound Run cannot change session or task ownership.')
  }
  if (previous && incoming.messageId !== undefined && incoming.messageId !== previous.messageId) {
    throw new FrozenRoutingPolicyError('OWNER_MISMATCH', 'A bound Run cannot change its original user message identity.')
  }
  if (previous && next && previous.policyDigest !== next.policyDigest) {
    throw new FrozenRoutingPolicyError('POLICY_CONFLICT', 'A Run routing policy is immutable; a fresher revision cannot replace it.')
  }
  return previous ?? next
}

/** Generic writes cannot create a policy binding or erase an existing binding. */
export function assertFrozenRoutingWrite(previous: TaskRunRecord | undefined, next: TaskRunRecord): void {
  const currentPolicy = previous && frozenRoutingPolicyForRun(previous)
  const nextPolicy = frozenRoutingPolicyForRun(next)
  if (!currentPolicy && nextPolicy) throw new FrozenRoutingPolicyError('FIRST_BINDING_REQUIRED', 'Use the canonical first-binding barrier for a new routing policy.')
  if (currentPolicy && (!nextPolicy || currentPolicy.policyDigest !== nextPolicy.policyDigest)) {
    throw new FrozenRoutingPolicyError('POLICY_CONFLICT', 'Ordinary persistence cannot change or remove the frozen routing policy.')
  }
}

/**
 * Check the concrete target immediately before a physical Provider request.
 *
 * Recovery code is allowed to change SessionMeta while it searches for a
 * permitted retry target.  That mutable projection is not the authority for a
 * Run that has already started: the canonical Run's frozen policy is.  Callers
 * pass the main-owned opaque connection identity (never endpoint or secrets)
 * and the wire protocol selected by the adapter.
 */
export function assertFrozenRunRequestTarget(input: {
  run: TaskRunRecord | undefined
  providerId: string
  model: string
  protocol: FrozenNativeProtocol
  connectionIdentity: ProviderConnectionIdentity
}): void {
  if (!input.run) throw new FrozenRoutingPolicyError('FIRST_BINDING_REQUIRED', 'Provider request has no canonical TaskRun.')
  const policy = frozenRoutingPolicyForRun(input.run)
  if (!policy) throw new FrozenRoutingPolicyError('FIRST_BINDING_REQUIRED', 'Provider request requires a frozen routing policy.')
  const target = policy.qualifiedTargets.find((candidate) =>
    candidate.providerId === input.providerId && candidate.model === input.model && candidate.protocol === input.protocol)
  if (!target) throw new FrozenRoutingPolicyError('POLICY_CONFLICT', 'Provider request target is outside the Run frozen routing domain.')
  if (target.connectionIdentity.generationId !== input.connectionIdentity.generationId ||
      target.connectionIdentity.revision !== input.connectionIdentity.revision) {
    throw new FrozenRoutingPolicyError('POLICY_CONFLICT', 'Provider connection identity changed after routing was frozen.')
  }
}

function parsePolicy(value: unknown): FrozenRunRoutingPolicyV1 {
  const result = parseFrozenRoutingPolicy(value)
  if (result.ok === false) throw new FrozenRoutingPolicyError('INVALID_POLICY', result.diagnostics.map((item) => `${item.path}: ${item.message}`).join('; '))
  return result.value
}

function contentDigest(policy: FrozenRunRoutingPolicyV1): string {
  const { policyDigest: _digest, ...content } = policy
  return digest(content)
}

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child)
  return Object.freeze(value)
}
