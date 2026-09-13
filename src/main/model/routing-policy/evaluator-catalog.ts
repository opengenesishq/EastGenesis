import { buildModelProfiles } from '../model-profile'
import { findConfiguredModelProfile } from '../configured-model-profile'
import { eligibleRouteProfiles } from '../model-route-constraints'
import { providerAllowedByRoutingExpertPolicy } from '../routing-expert-policy'
import { resolveProviderRuntimeTarget } from '../../provider/providerRuntimeTarget'
import { isModelRouteError } from '../model-route-error'
import type { ProviderView } from '../../../shared/types'
import type { TaskProfile } from '../model-profile'
import type { ModelRouteRequest } from '../model-router'
import type { RoutingTargetRef, RoutingDiagnostic } from '../../../shared/routing-policy-types'
import type { RoutingCatalogEntry, RoutingEvaluationSnapshots, TargetExclusion } from './evaluator-types'
import { issue } from './evaluator-rules'
import { buildProviderCapabilityCard } from '../../../shared/provider-capability-card'
import type { ProviderModelCapability } from '../../../shared/provider-model-capability-summary'

/** One target/alias resolver for all selections. Never infer targets from names. */
export function canonicalTarget(provider: ProviderView, model: string): RoutingTargetRef {
  const raw = model.trim()
  const configured = findConfiguredModelProfile(raw, provider.advancedConfig?.modelProfiles)
    ?? findConfiguredModelProfile(stripGeminiPrefix(provider, raw), provider.advancedConfig?.modelProfiles)
  return { providerId: provider.id, model: stripGeminiPrefix(provider, configured?.model ?? raw) }
}

export function targetKey(target: RoutingTargetRef): string { return JSON.stringify([target.providerId, target.model]) }

export function resolveCatalogTarget(catalog: RoutingCatalogEntry[], target: RoutingTargetRef): RoutingCatalogEntry | undefined {
  const provider = catalog.find((entry) => entry.provider.id === target.providerId)?.provider
  if (!provider) return undefined
  const key = targetKey(canonicalTarget(provider, target.model))
  return catalog.find((entry) => targetKey(entry.target) === key)
}

export function buildRoutingCatalog(providers: ProviderView[]): RoutingCatalogEntry[] {
  const rows = providers.flatMap((provider) => buildModelProfiles({ providerId: provider.id, providerName: provider.name,
    models: provider.models, modelProfiles: provider.advancedConfig?.modelProfiles, engine: provider.engine
  }).map((profile): RoutingCatalogEntry => ({ provider, profile, target: canonicalTarget(provider, profile.model),
    pricingBasis: validDeclaredPricing(provider, profile.model) ? 'declared' : 'heuristic_estimate',
    capabilityCard: buildProviderCapabilityCard(provider, findConfiguredModelProfile(profile.model, provider.advancedConfig?.modelProfiles) ?? { model: profile.model }) })))
  rows.sort((a, b) => targetKey(a.target).localeCompare(targetKey(b.target)) || a.profile.model.localeCompare(b.profile.model))
  const unique = new Map<string, RoutingCatalogEntry>()
  for (const entry of rows) if (!unique.has(targetKey(entry.target))) unique.set(targetKey(entry.target), entry)
  return [...unique.values()]
}

export function qualifyCatalog(input: {
  entries: RoutingCatalogEntry[]; task: TaskProfile; request: ModelRouteRequest; snapshots: RoutingEvaluationSnapshots
}): { entries: RoutingCatalogEntry[]; excluded: TargetExclusion[] } {
  const entries: RoutingCatalogEntry[] = []
  const excluded: TargetExclusion[] = []
  for (const entry of input.entries) {
    const diagnostics = qualifyEntry(entry, input)
    if (diagnostics.length) excluded.push({ target: entry.target, diagnostics })
    else entries.push(entry)
  }
  return { entries, excluded }
}

function qualifyEntry(entry: RoutingCatalogEntry, input: {
  task: TaskProfile; request: ModelRouteRequest; snapshots: RoutingEvaluationSnapshots
}): RoutingDiagnostic[] {
  const { snapshots } = input
  const path = `$.catalog.${entry.provider.id}.${entry.profile.model}`
  if (!entry.provider.ready) return [issue('HARD_CONSTRAINT_EXCLUDED', path, 'Connection is not ready.')]
  try {
    if (!providerAllowedByRoutingExpertPolicy(entry.provider, snapshots.expertPolicy, resolveProviderRuntimeTarget(entry.provider, { appId: entry.provider.engine, model: entry.profile.model }))) {
      return [issue('HARD_CONSTRAINT_EXCLUDED', path, 'Expert provider, locality, region, domain or permission policy excludes this connection.')]
    }
  } catch { return [issue('HARD_CONSTRAINT_EXCLUDED', path, 'Endpoint binding is unavailable.')] }
  const trusted = snapshots.targetEligibility.filter((row) => targetKey(row.target) === targetKey(entry.target))
  if (trusted.length !== 1 || !trusted[0].connectionFingerprint) {
    return [issue('HARD_CONSTRAINT_EXCLUDED', path, 'An exact trusted connection/permission snapshot is required.')]
  }
  if (!trusted[0].allowed) return [issue('HARD_CONSTRAINT_EXCLUDED', path,
    `Trusted connection/permission restrictions exclude this target: ${trusted[0].reasons.join('; ')}`)]
  return qualifyCapabilitiesAndPrice(entry, input, path)
}

function qualifyCapabilitiesAndPrice(entry: RoutingCatalogEntry, input: {
  task: TaskProfile; request: ModelRouteRequest; snapshots: RoutingEvaluationSnapshots
}, path: string): RoutingDiagnostic[] {
  // A declaration describes a low-risk candidate, but it is not evidence
  // that a high-risk dispatch can produce a protocol-valid result. The card
  // currently verifies generation only; keep this gate scoped to native text
  // until capability-specific probes exist.
  if (input.task.riskLevel === 'high' && entry.capabilityCard.evidence.verification.state !== 'verified') {
    return [issue('HARD_CONSTRAINT_EXCLUDED', path,
      'High-risk routing requires a successful protocol-valid generation verification; declared capability is insufficient.')]
  }
  // Generation verification proves text only. High-risk native-text tasks that
  // exercise tools or image understanding need a capability-specific probe;
  // declarations and the text probe cannot authorize those dispatches.
  if (input.task.riskLevel === 'high') {
    const required = requiredCapabilityVerification(input.task)
    const missing = required.filter((capability) => !entry.capabilityCard.verifiedCapabilities.includes(capability))
    if (missing.length > 0) {
      return [issue('HARD_CONSTRAINT_EXCLUDED', path,
        `High-risk routing requires capability-specific verification for: ${missing.join(', ')}.`)]
    }
  }
  try { eligibleRouteProfiles([entry.profile], input.task, { ...input.request, manualOverride: undefined }) }
  catch (error) {
    if (!isModelRouteError(error)) throw error
    return [issue('HARD_CONSTRAINT_EXCLUDED', path, error.message)]
  }
  const budget = input.snapshots.budget
  if (budget?.hardLimit && budget.remainingUsd !== undefined && entry.pricingBasis !== 'declared') {
    return [issue('HARD_CONSTRAINT_EXCLUDED', path, 'Finite hard budget requires declared token prices; inferred cost is not a spend bound.')]
  }
  return []
}

function requiredCapabilityVerification(task: TaskProfile): ProviderModelCapability[] {
  const required: ProviderModelCapability[] = []
  if (task.requiresTools) required.push('tools')
  if (task.requiresVision) required.push('vision')
  return required
}

function stripGeminiPrefix(provider: ProviderView, model: string): string {
  return provider.engine === 'gemini' ? model.replace(/^models\//, '') : model
}

function validDeclaredPricing(provider: ProviderView, model: string): boolean {
  const price = findConfiguredModelProfile(model, provider.advancedConfig?.modelProfiles)?.pricing
  return Boolean(price && Number.isFinite(price.inputPerMillion) && price.inputPerMillion >= 0
    && Number.isFinite(price.outputPerMillion) && price.outputPerMillion >= 0)
}
