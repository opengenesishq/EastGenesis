import type { MediaExecutionBinding, MediaJobInput, MediaJobRecord, MediaProviderProfile } from '../../shared/media-types'
import type { MediaFrozenRouteV2, MediaFrozenRouteV1 } from '../../shared/media-routing-types'
import { stableValueDigest } from '../task/tool-idempotency'
import { defaultMediaOperation } from './media-route-selection'

/** Separate media domain: native text rules are not evidence for a billable media submission. */
export function freezeMediaRoute(input: MediaJobInput, binding: MediaExecutionBinding): MediaFrozenRouteV2 {
  const model = binding.target?.model ?? binding.profile.model
  return {
    schemaVersion: 2,
    executionDomain: 'media',
    capability: input.capability,
    operation: input.operation ?? defaultMediaOperation(input.capability),
    mediaProviderId: binding.profile.id,
    ...(binding.profile.providerId ? { providerId: binding.profile.providerId } : {}),
    ...(model ? { model } : {}),
    ...(input.businessLineId ? { businessLineId: input.businessLineId } : {}),
    endpointClass: binding.profile.endpointClass,
    ...(binding.target ? { target: structuredClone(binding.target) } : {}),
    decisionDigest: mediaRouteSnapshotDigest(binding),
    frozenAt: Date.now()
  }
}

/** Recheck the persisted route against the actual job and request adapter. */
export function assertFrozenMediaRouteBinding(job: MediaJobRecord, profile: MediaProviderProfile, providerId: string): void {
  const binding = job.executionBinding
  if (!binding || !Object.hasOwn(binding, 'frozenRoute')) return // Legacy jobs keep their original target/credential binding.
  const frozen = binding.frozenRoute
  const mismatches = frozen ? [
    (frozen.schemaVersion !== 1 && frozen.schemaVersion !== 2) && 'schemaVersion', frozen.executionDomain !== 'media' && 'executionDomain',
    frozen.capability !== job.capability && 'capability', frozen.operation !== job.operation && 'operation',
    frozen.mediaProviderId !== job.mediaProviderId && 'mediaProviderId', frozen.providerId !== providerId && 'providerId',
    frozen.model !== (job.model ?? profile.model) && 'model', frozen.endpointClass !== profile.endpointClass && 'endpointClass',
    (frozen.businessLineId !== undefined && frozen.businessLineId !== job.businessLineId) && 'businessLineId',
    stableValueDigest(frozen.target) !== stableValueDigest(binding.target) && 'target',
    frozen.decisionDigest !== digestForFrozenRoute(frozen, binding) && 'decisionDigest'
  ].filter((value): value is string => Boolean(value)) : ['missing']
  if (mismatches.length) {
    throw new Error(`媒体任务冻结路由与任务或当前 Provider 配置不一致，已阻止执行（${mismatches.join(',')}）。`)
  }
}

/** Digest the complete non-secret route decision so persisted bindings cannot be edited piecemeal. */
export function mediaRouteSnapshotDigest(binding: MediaExecutionBinding): string {
  const profile = binding.profile
  const decision = binding.decision
  // The binding is persisted as JSON before the first operation commits. Use
  // the same JSON representation for hashing so optional `undefined` fields
  // omitted by serialization cannot invalidate an otherwise unchanged V2
  // route on the subsequent submit/poll/download/cancel read.
  const snapshot = JSON.parse(JSON.stringify({
    // MediaProviderProfile and MediaRouteDecision contain no credential material;
    // hashing them whole prevents a partial persisted edit from being accepted.
    profile,
    target: binding.target,
    decision,
    requestDigest: binding.requestDigest, contentDigest: binding.contentDigest
  }))
  return stableValueDigest(snapshot)
}

/**
 * V1 records were persisted before the digest was expanded. Keep their exact
 * field allow-list forever; V2 never falls back to this weaker representation.
 */
export function mediaRouteSnapshotDigestV1(binding: MediaExecutionBinding): string {
  const { profile, target, decision } = binding
  return stableValueDigest({
    profile: {
      id: profile.id,
      providerId: profile.providerId,
      model: profile.model,
      endpointClass: profile.endpointClass,
      capabilities: profile.capabilities,
      operations: profile.operations
    },
    target,
    decision: {
      mode: decision.mode,
      strategy: decision.strategy,
      mediaProviderId: decision.mediaProviderId,
      providerId: decision.providerId,
      model: decision.model
    },
    requestDigest: binding.requestDigest,
    contentDigest: binding.contentDigest
  })
}

function digestForFrozenRoute(route: MediaFrozenRouteV1 | MediaFrozenRouteV2, binding: MediaExecutionBinding): string {
  if (route.schemaVersion === 1) return mediaRouteSnapshotDigestV1(binding)
  if (route.schemaVersion === 2) return mediaRouteSnapshotDigest(binding)
  // Keep this explicit even though the caller checks schemaVersion: an unknown
  // version must never be accepted through an accidental fallback.
  return '__unsupported_frozen_route_schema__'
}
