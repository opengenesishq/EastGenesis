import type { ProviderView, RoutingExpertPolicy, SchedulerStrategy } from '../../../shared/types'
import type { TaskProfile, TaskProfileInput, ModelProfile } from '../model-profile'
import type { ModelRouterBudget, ModelRouteCandidate, ModelRouteDecision, ModelRouteHealthInput } from '../model-router'
import type { RoutingDiagnostic, RoutingRuleFields, RoutingRuleSource, RoutingSelection, RoutingFailurePolicy, RoutingTargetRef, RoutingUserIntent } from '../../../shared/routing-policy-types'
import type { ModelRouteScoringSignal } from '../model-router'
import type {
  ProviderCapabilityCard,
  ProviderCapabilityCardState,
  ProviderCapabilityVerificationState
} from '../../../shared/provider-capability-card'

/** Internal main input. Never expose this shape directly over IPC. */
export interface TrustedRoutingContext {
  executionDomain: 'native_text'
  originalPrompt: string
  businessLine: { id: string; enabled: boolean; requiredCapabilities: readonly ('tools' | 'vision')[] }
  userIntent: RoutingUserIntent
  /** Before matching. The winning rule.strategy never feeds back into conditions. */
  baseStrategy: SchedulerStrategy
  baseStrategySource: { kind: 'global' } | { kind: 'business_line'; businessLineId: string }
  task: Omit<TaskProfileInput, 'prompt' | 'strategy'>
}

export interface TargetHardEligibility {
  target: RoutingTargetRef
  /** Main has checked connection readiness, outbound and DigitalWorker restrictions. */
  allowed: boolean
  reasons: string[]
  /** Opaque config identity only; not a URL, key, token or header digest. */
  connectionFingerprint: string
}

export interface RoutingEvaluationSnapshots {
  providers: ProviderView[]
  expertPolicy: RoutingExpertPolicy
  budget?: ModelRouterBudget
  targetEligibility: readonly TargetHardEligibility[]
  providerHealth: Record<string, ModelRouteHealthInput>
  scoringSignals: readonly ModelRouteScoringSignal[]
}

export type RoutingRuleSourceInput =
  | { kind: 'saved'; value: unknown }
  | { kind: 'draft'; value: unknown; sourcesById: Readonly<Record<string, RoutingRuleSource>> }

export interface RoutingEvaluatorInput {
  rules: RoutingRuleSourceInput
  context: TrustedRoutingContext
  snapshots: RoutingEvaluationSnapshots
}

export interface EvaluatedRule extends RoutingRuleFields {
  version: number | null
  source: RoutingRuleSource
}
export interface EffectiveRoutingPolicy {
  selection: RoutingSelection
  strategy: SchedulerStrategy
  failure: RoutingFailurePolicy
  source: 'matched_rule' | 'explicit_v1_default'
}
export interface RoutingCatalogEntry {
  provider: ProviderView
  profile: ModelProfile
  target: RoutingTargetRef
  pricingBasis: 'declared' | 'heuristic_estimate'
  /** Read-only declaration/probe projection; it never authorizes dispatch by itself. */
  capabilityCard: ProviderCapabilityCard
}
export interface TargetExclusion { target: RoutingTargetRef; diagnostics: RoutingDiagnostic[] }

interface RoutingEvaluationBase {
  executionDomain: 'native_text'
  matchedRules: EvaluatedRule[]
  overriddenRuleIds: string[]
  diagnostics: RoutingDiagnostic[]
  excludedTargets: TargetExclusion[]
  limitations: {
    kind: 'local_configuration_only'
    providerRequestsMade: false
    realTaskVerified: false
    reservationsMade: false
    coversMediaGeneration: false
  }
}

export type RoutingEvaluationResult = RoutingEvaluationBase & (
  | { status: 'blocked'; task?: TaskProfile; effectivePolicy?: EffectiveRoutingPolicy }
  | {
      status: 'ready'; task: TaskProfile; effectivePolicy: EffectiveRoutingPolicy
      initialTarget: RoutingTargetRef
      /** Hard-qualified set; failure=pause does not grant recovery into this set. */
      qualifiedTargets: RoutingTargetRef[]
      /** Only when failure allows cross-target retry; no dispatch is authorized here. */
      allowedAlternatives: RoutingTargetRef[]
      rankedCandidates: ModelRouteCandidate[]
      pricing: Array<{
        target: RoutingTargetRef
        basis: RoutingCatalogEntry['pricingBasis']
        note: string
        capabilityState: ProviderCapabilityCardState
        verificationState: ProviderCapabilityVerificationState
      }>
      modelDecision: ModelRouteDecision
      decisionDigest: string
    }
)
