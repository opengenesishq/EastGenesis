import type { SchedulerStrategy } from './types'
import type { ProviderConnectionIdentity } from './provider-connection-identity'
import type { RoutingFailurePolicy, RoutingRuleScope, RoutingRuleSource, RoutingSelection, RoutingTargetRef, RoutingUserIntent } from './routing-policy-types'

export type FrozenNativeProtocol = 'openai.chat-completions' | 'openai.responses' | 'anthropic.messages' | 'google.generative-language'
export interface FrozenNativeTarget extends RoutingTargetRef { protocol: FrozenNativeProtocol }
export interface FrozenRoutingQualifiedTarget extends FrozenNativeTarget {
  /** Main-owned opaque configuration generation; never a URL, credential or secret hash. */
  connectionIdentity: ProviderConnectionIdentity
  declaredContextWindow?: number
}
export interface FrozenRoutingOwner {
  runId: string
  sessionId: string
  taskId: string
  projectId?: string
  goalId?: string
  workItemId: string
  businessLineId: string
}
export interface FrozenRoutingRuleReference {
  id: string
  version: number
  source: RoutingRuleSource
  priority: number
  scope: RoutingRuleScope
}
export interface FrozenRoutingHardBounds {
  requiredCapabilities: Array<'tools' | 'vision'>
  minContextTokens: number
  allowedProviderIds: string[]
  locality: 'any' | 'local_only'
  remainingBudgetUsd?: number
  allowedRegions?: string[]
  allowedDomains?: string[]
  requiredPermissions?: string[]
}

/** An immutable native-only decision bound to one canonical Run before execution. */
export interface FrozenRunRoutingPolicyV1 {
  schemaVersion: 1
  evaluatorVersion: 1
  executionDomain: 'native_text'
  owner: FrozenRoutingOwner
  messageId: string
  frozenAt: number
  /** Every digest in this record is lowercase, unprefixed SHA-256 hex. */
  originalPromptDigest: string
  ruleSetRevision: number
  ruleSetDigest: string
  matchedRules: FrozenRoutingRuleReference[]
  contextDigest: string
  catalogDigest: string
  evaluationDigest: string
  baseStrategy: SchedulerStrategy
  baseStrategySource: { kind: 'global' } | { kind: 'business_line'; businessLineId: string }
  userIntent: RoutingUserIntent
  /** Execution references are canonical model IDs; original aliases remain in the rule-set digest. */
  effectivePolicy: { selection: RoutingSelection; strategy: SchedulerStrategy; failure: RoutingFailurePolicy }
  initialTarget: FrozenNativeTarget
  qualifiedTargets: FrozenRoutingQualifiedTarget[]
  /** Includes the initial target for permitted same-target retries; pause has none. */
  retryTargets: FrozenNativeTarget[]
  hardBounds: FrozenRoutingHardBounds
  policyDigest: string
}

export interface BindFrozenRoutingPolicyInput {
  runId: string
  sessionId: string
  expectedRunRevision: number
  policy: FrozenRunRoutingPolicyV1
}
