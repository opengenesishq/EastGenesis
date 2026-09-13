import { selectConstrainedCandidate } from '../model-route-constraints'
import { isModelRouteError } from '../model-route-error'
import { isLocalProviderUrl } from '../routing-expert-policy'
import type { ModelRouteRequest, ModelRouteDecision, ModelRouteCandidate } from '../model-router'
import type { TaskProfile } from '../model-profile'
import type { RoutingTargetRef } from '../../../shared/routing-policy-types'
import type { RoutingCatalogEntry, RoutingEvaluationSnapshots, TargetExclusion } from './evaluator-types'
import { routeModelFromSnapshot } from '../model-router'
import { targetKey } from './evaluator-catalog'
import { issue } from './evaluator-rules'

interface RankingInput {
  entries: RoutingCatalogEntry[]; task: TaskProfile; request: ModelRouteRequest
  snapshots: RoutingEvaluationSnapshots; requiredInitial?: RoutingTargetRef
}

/** Calls the real router's patched snapshot entry. No scoring formula is copied. */
export function rankQualifiedCatalog(input: RankingInput): {
  entries: RoutingCatalogEntry[]; excluded: TargetExclusion[]; decision?: ModelRouteDecision
} {
  if (!input.entries.length) return { entries: [], excluded: [] }
  const unbounded = score(input, input.entries, undefined, false)
  const budget = filterHardBudget(input, unbounded.candidates)
  if (!budget.entries.length) return budget
  const selected = requiredOrPreferredLocal(input, budget.entries, unbounded.candidates)
  if (input.requiredInitial && !selected) return { ...budget, decision: undefined }
  return { ...budget, decision: score(input, budget.entries, selected, true) }
}

function score(input: RankingInput, entries: RoutingCatalogEntry[], selected: RoutingCatalogEntry | undefined, useBudget: boolean): ModelRouteDecision {
  const request: ModelRouteRequest = { ...input.request,
    budget: useBudget ? input.snapshots.budget : undefined,
    manualOverride: selected ? { providerId: selected.provider.id, model: selected.profile.model,
      reason: input.requiredInitial ? 'Explicit fixed/preferred target after hard intersection.' : 'prefer_local within the hard-qualified set.' } : undefined }
  return routeModelFromSnapshot({ task: input.task, profiles: entries.map((entry) => entry.profile),
    request, scoringSignals: input.snapshots.scoringSignals })
}

function filterHardBudget(input: RankingInput, candidates: ModelRouteCandidate[]): {
  entries: RoutingCatalogEntry[]; excluded: TargetExclusion[]
} {
  if (!input.snapshots.budget?.hardLimit) return { entries: input.entries, excluded: [] }
  const entries: RoutingCatalogEntry[] = []
  const excluded: TargetExclusion[] = []
  for (const entry of input.entries) {
    const candidate = candidateFor(entry, candidates)
    try { selectConstrainedCandidate([candidate], input.snapshots.budget, undefined); entries.push(entry) }
    catch (error) {
      if (!isModelRouteError(error)) throw error
      excluded.push({ target: entry.target, diagnostics: [issue('HARD_CONSTRAINT_EXCLUDED', '$.budget', error.message)] })
    }
  }
  return { entries, excluded }
}

function requiredOrPreferredLocal(input: RankingInput, entries: RoutingCatalogEntry[], ranked: ModelRouteCandidate[]): RoutingCatalogEntry | undefined {
  if (input.requiredInitial) return entries.find((entry) => targetKey(entry.target) === targetKey(input.requiredInitial!))
  if (input.snapshots.expertPolicy.locality !== 'prefer_local') return undefined
  const local = entries.filter((entry) => isLocalProviderUrl(entry.provider.baseUrl))
  return ranked.flatMap((candidate) => local.filter((entry) => entry.provider.id === candidate.profile.providerId
    && entry.profile.model === candidate.profile.model))[0]
}

function candidateFor(entry: RoutingCatalogEntry, candidates: ModelRouteCandidate[]): ModelRouteCandidate {
  const candidate = candidates.find((item) => item.profile.providerId === entry.provider.id && item.profile.model === entry.profile.model)
  if (!candidate) throw new Error('A scored candidate is missing from the explicit snapshot')
  return candidate
}
