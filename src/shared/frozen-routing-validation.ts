import { fail } from './routing-policy-parse-fields'
import { frozenTargetKey } from './frozen-routing-fields'
import type { FrozenRunRoutingPolicyV1, FrozenNativeTarget } from './frozen-routing-types'

/** Validates an already compiled domain; never matches rules or chooses a target. */
export function assertFrozenRoutingStructure(policy: FrozenRunRoutingPolicyV1): void {
  const qualified = new Set(policy.qualifiedTargets.map(frozenTargetKey))
  if (!qualified.has(frozenTargetKey(policy.initialTarget))) invalid('$.initialTarget', 'Initial target must be in the frozen qualified set.')
  if (policy.retryTargets.some((target) => !qualified.has(frozenTargetKey(target)))) invalid('$.retryTargets', 'Retries cannot extend the frozen qualified set.')
  assertBaselineAndMatch(policy)
  assertRetryDomain(policy)
  assertHardDomain(policy)
  assertSelectionDomain(policy)
}

function assertBaselineAndMatch(policy: FrozenRunRoutingPolicyV1): void {
  const source = policy.baseStrategySource
  if (source.kind === 'business_line' && source.businessLineId !== policy.owner.businessLineId) invalid('$.baseStrategySource', 'Baseline business line differs from the canonical owner.')
  const match = policy.matchedRules[0]
  if (match?.scope.kind === 'business_line' && match.scope.businessLineId !== policy.owner.businessLineId) invalid('$.matchedRules', 'Matched business rule belongs to another business line.')
  if (match) return
  const effective = policy.effectivePolicy
  if (effective.selection.kind !== 'global_auto' || effective.strategy !== policy.baseStrategy || effective.failure.kind !== 'pause') {
    invalid('$.effectivePolicy', 'No-match V1 must preserve the baseline and pause; legacy fallback is not a default.')
  }
}

function assertRetryDomain(policy: FrozenRunRoutingPolicyV1): void {
  const failure = policy.effectivePolicy.failure
  if (failure.kind === 'pause' && policy.retryTargets.length) invalid('$.retryTargets', 'Pause grants no automatic retry target.')
  if (failure.kind === 'retry_same_target' && policy.retryTargets.some((target) => frozenTargetKey(target) !== frozenTargetKey(policy.initialTarget))) {
    invalid('$.retryTargets', 'Same-target retries cannot change provider, model or protocol.')
  }
  if (policy.effectivePolicy.selection.kind === 'fixed' && failure.kind === 'retry_allowed_targets') {
    invalid('$.effectivePolicy.failure', 'Fixed selection cannot grant cross-target retry.')
  }
}

function assertHardDomain(policy: FrozenRunRoutingPolicyV1): void {
  const hard = policy.hardBounds
  if (hard.allowedProviderIds.length && policy.qualifiedTargets.some((target) => !hard.allowedProviderIds.includes(target.providerId))) {
    invalid('$.qualifiedTargets', 'Qualified target violates the frozen provider allowlist.')
  }
  if (policy.qualifiedTargets.some((target) => target.declaredContextWindow !== undefined && target.declaredContextWindow < hard.minContextTokens)) {
    invalid('$.qualifiedTargets', 'A declared context limit is smaller than the frozen task requirement.')
  }
  if (policy.qualifiedTargets.some((target) => !withinIntent(policy, target))) invalid('$.qualifiedTargets', 'Qualified target violates the frozen user intent.')
}

function withinIntent(policy: FrozenRunRoutingPolicyV1, target: FrozenNativeTarget): boolean {
  const intent = policy.userIntent
  if (intent.kind === 'global') return true
  if (intent.kind === 'provider') return target.providerId === intent.providerId
  return target.providerId === intent.target.providerId && target.model === intent.target.model
}

function assertSelectionDomain(policy: FrozenRunRoutingPolicyV1): void {
  const selection = policy.effectivePolicy.selection
  const equal = (left: { providerId: string; model: string }, right: { providerId: string; model: string }) => left.providerId === right.providerId && left.model === right.model
  if (selection.kind === 'global_auto') return
  if (selection.kind === 'provider_auto') {
    if (policy.qualifiedTargets.some((target) => target.providerId !== selection.providerId)) invalid('$.qualifiedTargets', 'Selection provider cannot be broadened.')
    return
  }
  const allowed = selection.kind === 'fixed' ? [selection.target] : selection.kind === 'preferred' ? [selection.primary, ...selection.alternatives] : selection.targets
  if (policy.qualifiedTargets.some((target) => !allowed.some((item) => equal(item, target)))) invalid('$.qualifiedTargets', 'Qualified targets must be within the canonicalized selection.')
  if (selection.kind === 'preferred' && !equal(selection.primary, policy.initialTarget)) invalid('$.initialTarget', 'Preferred selection must start with its hard-qualified primary.')
}

function invalid(path: string, message: string): never { return fail('HARD_CONSTRAINT_EXCLUDED', path, message) }
