import { inferTaskProfile } from '../model-profile'
import { digest } from '../../task/workflow-ledger-codec'
import type { ModelRouteRequest, ModelRouteDecision } from '../model-router'
import type { TaskProfile } from '../model-profile'
import type { RoutingTargetRef } from '../../../shared/routing-policy-types'
import type { EffectiveRoutingPolicy, EvaluatedRule, RoutingCatalogEntry, RoutingEvaluatorInput, RoutingEvaluationResult } from './evaluator-types'
import { readEvaluatorRules, matchRoutingRules, effectivePolicy, issue } from './evaluator-rules'
import { buildRoutingCatalog, qualifyCatalog, targetKey } from './evaluator-catalog'
import { compileRoutingSelection } from './evaluator-selection'
import { rankQualifiedCatalog } from './evaluator-ranking'
import { validateEvaluationBoundary } from './evaluator-validation'

const LIMITATIONS = Object.freeze({ kind: 'local_configuration_only' as const, providerRequestsMade: false as const,
  realTaskVerified: false as const, reservationsMade: false as const, coversMediaGeneration: false as const })
type EvaluationBase = Pick<RoutingEvaluationResult, 'executionDomain' | 'matchedRules' | 'overriddenRuleIds' | 'diagnostics' | 'excludedTargets' | 'limitations'>

/** The only new entry point. No Session/Run/Attempt, file write, probe or reservation. */
export function evaluateRoutingRuleSet(input: RoutingEvaluatorInput): RoutingEvaluationResult {
  const base: EvaluationBase = { executionDomain: 'native_text', matchedRules: [], overriddenRuleIds: [],
    diagnostics: [], excludedTargets: [], limitations: LIMITATIONS }
  const boundary = validateEvaluationBoundary(input)
  if (boundary.length) return { ...base, status: 'blocked', diagnostics: boundary }
  const parsed = readEvaluatorRules(input.rules)
  if (parsed.ok === false) return { ...base, status: 'blocked', diagnostics: parsed.diagnostics }
  const baselineTask = inferTrustedTask(input)
  const match = matchRoutingRules(parsed.rules, input.context, baselineTask)
  base.matchedRules = match.matched
  base.overriddenRuleIds = match.overriddenRuleIds
  if (match.conflicts.length) return { ...base, status: 'blocked', task: baselineTask, diagnostics: match.conflicts }
  const policy = effectivePolicy(match.matched[0], input.context)
  const task = { ...baselineTask, strategy: policy.strategy }
  return evaluateCandidateIntersection({ input, base, policy, task, rules: parsed.rules })
}

function inferTrustedTask(input: RoutingEvaluatorInput): TaskProfile {
  const context = input.context
  const task = inferTaskProfile({ ...context.task, prompt: context.originalPrompt, strategy: context.baseStrategy,
    requiresTools: context.businessLine.requiredCapabilities.includes('tools') ? true : context.task.requiresTools })
  const requiresVision = task.requiresVision || context.businessLine.requiredCapabilities.includes('vision')
  return { ...task, requiresVision, taskKinds: requiresVision ? [...new Set([...task.taskKinds, 'vision' as const])] : task.taskKinds }
}

interface IntersectionInput {
  input: RoutingEvaluatorInput; base: EvaluationBase; policy: EffectiveRoutingPolicy; task: TaskProfile; rules: EvaluatedRule[]
}

function evaluateCandidateIntersection(state: IntersectionInput): RoutingEvaluationResult {
  const { input, base, policy, task } = state
  const catalog = buildRoutingCatalog(input.snapshots.providers)
  const scoped = compileRoutingSelection({ catalog, selection: policy.selection, intent: input.context.userIntent })
  const request = routeRequest(input, task)
  const hard = qualifyCatalog({ entries: scoped.entries, task, request, snapshots: input.snapshots })
  base.excludedTargets = [...scoped.excluded, ...hard.excluded]
  if (requiredTargetMissing(scoped.requiredInitial, hard.entries)) return blockedInitial(base, policy, task)
  const ranked = rankQualifiedCatalog({ entries: hard.entries, task, request, snapshots: input.snapshots, requiredInitial: scoped.requiredInitial })
  base.excludedTargets.push(...ranked.excluded)
  if (requiredTargetMissing(scoped.requiredInitial, ranked.entries)) return blockedInitial(base, policy, task)
  if (!ranked.decision) return { ...base, status: 'blocked', effectivePolicy: policy, task,
    diagnostics: [issue('HARD_CONSTRAINT_EXCLUDED', '$.selection', 'No target remains after user scope, rule, connection, capability, permission and budget intersection.')] }
  return readyResult(state, ranked.entries, ranked.decision)
}

function routeRequest(input: RoutingEvaluatorInput, task: TaskProfile): ModelRouteRequest {
  return { ...input.context.task, prompt: input.context.originalPrompt, providers: input.snapshots.providers,
    strategy: task.strategy, providerHealth: input.snapshots.providerHealth, crossValidation: { enabled: false } }
}

function requiredTargetMissing(required: RoutingTargetRef | undefined, entries: RoutingCatalogEntry[]): boolean {
  return required !== undefined && !entries.some((entry) => targetKey(entry.target) === targetKey(required))
}

function blockedInitial(base: EvaluationBase, policy: EffectiveRoutingPolicy, task: TaskProfile): RoutingEvaluationResult {
  return { ...base, status: 'blocked', effectivePolicy: policy, task,
    diagnostics: [issue('HARD_CONSTRAINT_EXCLUDED', '$.selection', 'The explicit fixed or preferred primary is not hard-qualified; alternatives cannot replace it before an allowed known failure.')] }
}

function readyResult(state: IntersectionInput, entries: RoutingCatalogEntry[], decision: ModelRouteDecision): RoutingEvaluationResult {
  const initial = entries.find((entry) => entry.profile.providerId === decision.selected.profile.providerId
    && entry.profile.model === decision.selected.profile.model)!
  const ranked = decision.candidates.map((candidate) => entries.find((entry) => entry.profile.providerId === candidate.profile.providerId
    && entry.profile.model === candidate.profile.model)!)
  const alternatives = state.policy.failure.kind === 'retry_allowed_targets'
    ? ranked.filter((entry) => targetKey(entry.target) !== targetKey(initial.target)).map((entry) => entry.target) : []
  const output = { ...state.base, status: 'ready' as const, effectivePolicy: state.policy, task: state.task,
    initialTarget: initial.target, qualifiedTargets: ranked.map((entry) => entry.target), allowedAlternatives: alternatives,
    rankedCandidates: decision.candidates, pricing: ranked.map((entry) => ({ target: entry.target, basis: entry.pricingBasis,
      capabilityState: entry.capabilityCard.evidence.state,
      verificationState: entry.capabilityCard.evidence.verification.state,
      note: entry.pricingBasis === 'declared' ? 'Declared token price; full wire bound still requires validation.'
        : 'Heuristic estimate from the existing profile; actual price is unknown and this is not a guaranteed spend bound.' })),
    modelDecision: decision }
  return { ...output, decisionDigest: evaluationDigest(state, output, entries) }
}

function evaluationDigest(state: IntersectionInput, result: unknown, entries: RoutingCatalogEntry[]): string {
  const snapshots = state.input.snapshots
  return `sha256:${digest({ evaluatorVersion: 1, domain: 'native_text', rules: state.rules,
    originalPromptDigest: digest(state.input.context.originalPrompt), userIntent: state.input.context.userIntent,
    businessLine: state.input.context.businessLine, baselineStrategy: state.input.context.baseStrategy,
    baselineStrategySource: state.input.context.baseStrategySource,
    task: state.task, expertPolicy: snapshots.expertPolicy, budget: snapshots.budget,
    catalog: entries.map((entry) => ({ target: entry.target, profile: entry.profile })),
    eligibility: snapshots.targetEligibility.map((row) => ({ target: row.target, allowed: row.allowed, connectionFingerprint: row.connectionFingerprint })),
    scoringSignals: snapshots.scoringSignals, providerHealth: snapshots.providerHealth, result })}`
}
