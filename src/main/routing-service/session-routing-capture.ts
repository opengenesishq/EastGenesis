import type { RoutingPreviewContext } from '../../shared/routing-policy-types'
import type { SessionMeta, SendMessagePayload } from '../../shared/types'
import { sessionRoutingControl, sessionRoutingIntent } from '../../shared/session-routing-control-types'
import { listProviders, getProviderConnectionIdentity } from '../providers'
import { getHealth } from '../providerHealth'
import { captureModelRouteScoringSignal } from '../model/model-router'
import { buildModelProfiles, inferTaskProfile } from '../model/model-profile'
import type { RoutingEvaluationSnapshots, TrustedRoutingContext } from '../model/routing-policy/evaluator-types'
import { buildRoutingCatalog } from '../model/routing-policy/evaluator-catalog'
import { providerAllowedByRoutingExpertPolicy } from '../model/routing-expert-policy'
import { getBusinessLines } from '../../shared/business-line-types'
import { getSettings } from '../settings'
import { nativeBudgetSnapshot } from '../model/native-request-budget'
import { settingsForCaoGenDrive, driveRouteTuning, driveRiskAtLeast } from '../model/drive'
import { resolveProviderRuntimeTarget } from '../provider/providerRuntimeTarget'
import { isLocalProviderUrl } from '../model/routing-expert-policy'
import { evaluateNativeExecutorCompatibility } from '../model/executor-compatibility'

/** Main-owned capture used by canonical Session previews and first Run binding. */
export function captureSessionRouting(input: { meta: SessionMeta; prompt: string; payload?: Pick<SendMessagePayload, 'images' | 'documents'> }): {
  context: TrustedRoutingContext; snapshots: RoutingEvaluationSnapshots; authority: any
} {
  const settings = settingsForCaoGenDrive(getSettings(), input.meta.driveMode)
  const line = getBusinessLines(settings).find((item) => item.id === input.meta.businessLineId)
  if (!line?.enabled || !input.meta.businessLineId) throw new Error('业务线不存在或已停用。')
  const providers = listProviders()
  const tuning = driveRouteTuning(input.meta.driveMode)
  const profiles = providers.flatMap((provider) => buildModelProfiles({ providerId: provider.id, providerName: provider.name, models: provider.models, modelProfiles: provider.advancedConfig?.modelProfiles, engine: provider.engine }))
  const task = inferTaskProfile({ prompt: input.prompt, strategy: line.routingPreference ?? settings.schedulerStrategy,
    attachments: [ ...(input.payload?.images ?? []).map(() => ({ mime: 'image/*' })),
      ...(input.payload?.documents ?? []).map(() => ({ mime: 'application/octet-stream' })) ],
    requiresTools: true, requestedTasks: tuning.requestedTasks, expectedOutputTokens: tuning.expectedOutputTokens })
  const context: TrustedRoutingContext = { executionDomain: 'native_text', originalPrompt: input.prompt,
    businessLine: { id: line.id, enabled: true, requiredCapabilities: line.requiredCapabilities ?? [] },
    // Fixed intent is independent of the old scheduler; only V1 evaluates it.
    userIntent: sessionRoutingIntent(input.meta),
    baseStrategy: line.routingPreference ?? settings.schedulerStrategy,
    baseStrategySource: line.routingPreference ? { kind: 'business_line', businessLineId: line.id } : { kind: 'global' },
    task: { requiresTools: task.requiresTools, contextTokens: input.meta.contextTokens,
      requestedTasks: tuning.requestedTasks, expectedOutputTokens: tuning.expectedOutputTokens,
      riskLevel: driveRiskAtLeast(task.riskLevel, tuning.riskFloor) }
  }
  const budget = nativeBudgetSnapshot(input.meta, { settings })
  const connectionIdentities = Object.fromEntries(providers.map((provider) => [provider.id, getProviderConnectionIdentity(provider.id)]))
  const identities = new Map(providers.map((provider) => [provider.id, JSON.stringify(connectionIdentities[provider.id])]))
  const catalog = buildRoutingCatalog(providers)
  const remaining = [budget.sessionRemainingUsd, budget.monthlyRemainingUsd].filter((value): value is number => value !== undefined)
  const snapshots: RoutingEvaluationSnapshots = { providers, expertPolicy: settings.routingExpertPolicy,
    budget: remaining.length === 0 ? undefined : { remainingUsd: Math.min(...remaining), hardLimit: true },
    targetEligibility: buildTargetEligibility(catalog, task, settings.routingExpertPolicy, identities),
    providerHealth: Object.fromEntries(providers.map((provider) => { const health = getHealth(provider.id); return [provider.id, { healthy: health.healthy, circuitState: health.circuitState, latencyEmaMs: health.latencyEmaMs }] })),
    connectionIdentities,
    scoringSignals: profiles.map((profile) => captureModelRouteScoringSignal(profile, { providers, connectionIdentities })) }
  return { context, snapshots, authority: { kind: 'session', sessionId: input.meta.id, revision: 0,
    businessLineId: line.id,
    providerId: input.meta.providerId, model: input.meta.model,
    routingScope: input.meta.routingScope ?? 'global', routingControl: sessionRoutingControl(input.meta), driveMode: input.meta.driveMode ?? null,
    connectionIdentities: Object.fromEntries(identities) } }
}

/** Read-only capture for a new-task preview. It deliberately has no Session,
 * Run, reservation, probe, or Provider transport side effect. */
export function captureNewTaskRouting(input: {
  context: TrustedRoutingContext; authority: unknown
}): { context: TrustedRoutingContext; snapshots: RoutingEvaluationSnapshots; authority: any } {
  const settings = getSettings()
  const providers = listProviders()
  const profiles = providers.flatMap((provider) => buildModelProfiles({ providerId: provider.id, providerName: provider.name,
    models: provider.models, modelProfiles: provider.advancedConfig?.modelProfiles, engine: provider.engine }))
  const task = inferTaskProfile({ prompt: input.context.originalPrompt,
    strategy: input.context.baseStrategy, requiresTools: input.context.task.requiresTools })
  const connectionIdentities = Object.fromEntries(providers.map((provider) => [provider.id, getProviderConnectionIdentity(provider.id)]))
  const identities = new Map(providers.map((provider) => [provider.id, JSON.stringify(connectionIdentities[provider.id])]))
  const catalog = buildRoutingCatalog(providers)
  const budget = nativeBudgetSnapshot({
    id: '', sdkSessionId: undefined, createdAt: Date.now(), costUsd: 0,
    budgetUsd: settings.budgetUsdPerSession, providerId: '', driveMode: settings.driveMode
  }, { settings })
  const remaining = [budget.sessionRemainingUsd, budget.monthlyRemainingUsd].filter((value): value is number => value !== undefined)
  const snapshots: RoutingEvaluationSnapshots = { providers, expertPolicy: settings.routingExpertPolicy,
    budget: remaining.length === 0 ? undefined : { remainingUsd: Math.min(...remaining), hardLimit: true },
    targetEligibility: buildTargetEligibility(catalog, task, settings.routingExpertPolicy, identities),
    providerHealth: Object.fromEntries(providers.map((provider) => { const health = getHealth(provider.id); return [provider.id, { healthy: health.healthy, circuitState: health.circuitState, latencyEmaMs: health.latencyEmaMs }] })),
    connectionIdentities,
    scoringSignals: profiles.map((profile) => captureModelRouteScoringSignal(profile, { providers, connectionIdentities })) }
  return { context: input.context, snapshots,
    authority: { ...(typeof input.authority === 'object' && input.authority ? input.authority : {}), kind: 'new_task',
      connectionIdentities: Object.fromEntries(identities) } }
}

/** Main-owned hard gate shared by Session and new-task captures. The evaluator
 * must receive an explicit exclusion reason before ranking; a later adapter
 * check is too late because it can already have selected or persisted a target. */
function buildTargetEligibility(
  catalog: ReturnType<typeof buildRoutingCatalog>,
  task: ReturnType<typeof inferTaskProfile>,
  policy: Parameters<typeof providerAllowedByRoutingExpertPolicy>[1],
  identities: ReadonlyMap<string, string | undefined>
): RoutingEvaluationSnapshots['targetEligibility'] {
  return catalog.map((entry) => {
    const reasons: string[] = []
    if (!entry.provider.ready) reasons.push('Provider connection is not ready or has no usable credential.')
    try {
      const runtimeTarget = resolveProviderRuntimeTarget(entry.provider, { appId: entry.provider.engine, model: entry.profile.model })
      if (!providerAllowedByRoutingExpertPolicy(entry.provider, policy, runtimeTarget)) reasons.push('Routing expert provider/region/domain/permission policy excludes this target.')
      if (policy.locality === 'local_only' && !isLocalProviderUrl(runtimeTarget.baseUrl)) reasons.push('Effective endpoint binding is remote under local_only routing policy.')
    } catch (error) {
      reasons.push(`Provider endpoint binding is unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    const compatibility = evaluateNativeExecutorCompatibility({ provider: entry.provider, profile: entry.profile, requirements: task })
    reasons.push(...compatibility.modelReasons, ...compatibility.executorReasons)
    const connectionFingerprint = identities.get(entry.provider.id)
    if (!connectionFingerprint) reasons.push('Provider connection identity is unavailable.')
    return { target: entry.target, allowed: reasons.length === 0, reasons,
      connectionFingerprint: connectionFingerprint ?? '' }
  })
}
