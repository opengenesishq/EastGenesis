import { digest } from './workflow-ledger-canonical'
import { frozenRoutingPolicyForRun, sealFrozenRoutingPolicy } from './frozen-routing-policy'
import type { SessionMeta, TaskRunRecord, SendMessagePayload } from '../../shared/types'
import type { FrozenNativeProtocol, FrozenRunRoutingPolicyV1, FrozenRoutingRuleReference } from '../../shared/frozen-routing-types'
import type { RoutingFailurePolicy } from '../../shared/routing-policy-types'
import type { ProviderConnectionIdentity } from '../../shared/provider-connection-identity'
import type { RoutingEvaluationResult, TrustedRoutingContext, RoutingEvaluationSnapshots } from '../model/routing-policy/evaluator-types'
import { evaluateRoutingRuleSet } from '../model/routing-policy/routing-policy-evaluator'
import { captureSessionRouting } from '../routing-service/session-routing-capture'
import { getProviderConnectionIdentity, listProviders } from '../providers'
import { getRoutingSettingsBoundary, getSettings } from '../settings'
import { readStoredRoutingState } from '../routing-settings/routing-settings-state'
import { prepareSessionTurnRoute } from '../model/session-turn-route'
import { resolveRuntimeSessionRoute, type ResolvedSessionRoute } from '../model/session-runtime-routing'
import { createLegacyRoutingDecisionView } from '../model/session-routing'
import { getBusinessLines } from '../../shared/business-line-types'
import { providerAllowedByRoutingExpertPolicy, isLocalProviderUrl } from '../model/routing-expert-policy'
import { resolveProviderRuntimeTarget } from '../provider/providerRuntimeTarget'
import { resolveNativeExecutorProtocol } from '../model/executor-compatibility'
import { hasExplicitModelChange } from '../session-model-change'
import { evaluateSessionRoutingControl } from '../session-routing-control'

/** Build the immutable native text policy from the already trusted session route. */
export function frozenPolicyForSessionRun(
  meta: SessionMeta,
  run: TaskRunRecord,
  payload: SendMessagePayload,
  previousRun?: TaskRunRecord
) {
  if (!meta.workItemId || !meta.businessLineId || !payload.messageId) return undefined
  // A follow-up turn creates a new Run, but changing the routing rule set must
  // never retarget an already established Session continuation.  Carry the
  // previous Run's immutable target/provenance forward under the new Run and
  // message identity; the physical Engine then remains on the same protocol.
  const previousPolicy = previousRun ? frozenRoutingPolicyForRun(previousRun) : undefined
  if (previousPolicy && !hasExplicitModelChange(meta, previousRun)) {
    // Successor Runs inherit the immutable target, but the Engine still needs
    // a one-message route hand-off. Without this, native resolvers fall back
    // to the mutable scheduler after a rule/settings change.
    prepareFrozenContinuationRoute(meta, payload, previousPolicy)
    return sealFrozenRoutingPolicy({
      ...previousPolicy,
      owner: {
        ...previousPolicy.owner,
        runId: run.id,
        sessionId: run.sessionId,
        taskId: run.taskId,
        ...(meta.workspaceId ?? meta.projectId ? { projectId: meta.workspaceId ?? meta.projectId } : {}),
        ...(meta.goalId ? { goalId: meta.goalId } : {}),
        workItemId: meta.workItemId,
        businessLineId: meta.businessLineId
      },
      messageId: payload.messageId,
      frozenAt: Date.now(),
      originalPromptDigest: digest(payload.text)
    })
  }
  if (meta.routingControl && meta.routingControl.kind !== 'auto') {
    return freezeSessionRoutingControl(meta, run, payload)
  }
  // Explicit fixed targets are already user-authorized routing decisions and
  // must remain executable even when a V1 rule set is enabled but cannot
  // evaluate this custom business line.  They are frozen directly below
  // rather than being downgraded to mutable legacy routing.
  if (meta.routingScope === 'fixed' && meta.providerId && meta.model !== 'auto') {
    const provider = listProviders().find((item) => item.id === meta.providerId)
    if (!provider) return undefined
    const settings = getSettings()
    const line = getBusinessLines(settings).find((item) => item.id === meta.businessLineId)
    if (!line?.enabled) return undefined
    if (!provider.ready) return undefined
    resolveRuntimeSessionRoute({ meta, payload, settings, providers: [provider], allowAnyEngine: true })
    try {
      const runtimeTarget = resolveProviderRuntimeTarget(provider, { appId: provider.engine, model: meta.model })
      if (!providerAllowedByRoutingExpertPolicy(provider, settings.routingExpertPolicy, runtimeTarget)) return undefined
      if (settings.routingExpertPolicy.locality === 'local_only' && !isLocalProviderUrl(runtimeTarget.baseUrl)) return undefined
    } catch { return undefined }
    const connectionIdentity = getProviderConnectionIdentity(provider.id)
    const protocol = targetProtocol({ providerId: provider.id, model: meta.model })
    const target = { providerId: provider.id, model: meta.model, protocol, connectionIdentity }
    return sealFrozenRoutingPolicy({
      schemaVersion: 1, evaluatorVersion: 1, executionDomain: 'native_text',
      owner: { runId: run.id, sessionId: run.sessionId, taskId: run.taskId,
        ...(meta.workspaceId ?? meta.projectId ? { projectId: meta.workspaceId ?? meta.projectId } : {}),
        ...(meta.goalId ? { goalId: meta.goalId } : {}), workItemId: meta.workItemId, businessLineId: meta.businessLineId },
      messageId: payload.messageId, frozenAt: Date.now(), originalPromptDigest: digest(payload.text),
      // A directly-created fixed Session has no persisted V1 rule to match,
      // but it is still an explicit user routing decision. Record that
      // decision as a synthetic user rule reference so the frozen-policy
      // validator does not classify it as a legacy no-match fallback.
      ruleSetRevision: 1, ruleSetDigest: digest('fixed-target'), matchedRules: [{
        id: 'fixed-session-target', version: 1, source: { kind: 'user' }, priority: 0, scope: { kind: 'global' }
      }],
      contextDigest: digest({ businessLineId: meta.businessLineId, executionDomain: 'native_text' }),
      catalogDigest: digest([{ providerId: provider.id, model: meta.model }]),
      evaluationDigest: digest({ providerId: provider.id, model: meta.model }),
      baseStrategy: getSettings().schedulerStrategy, baseStrategySource: { kind: 'global' },
      userIntent: { kind: 'fixed', target: { providerId: provider.id, model: meta.model } },
      effectivePolicy: { selection: { kind: 'fixed', target: { providerId: provider.id, model: meta.model } }, strategy: getSettings().schedulerStrategy, failure: { kind: 'pause' } },
      initialTarget: { providerId: provider.id, model: meta.model, protocol }, qualifiedTargets: [target], retryTargets: [],
      hardBounds: { requiredCapabilities: [...(line.requiredCapabilities ?? [])], minContextTokens: Math.max(1, meta.contextTokens ?? 1), allowedProviderIds: [provider.id], locality: settings.routingExpertPolicy.locality === 'local_only' ? 'local_only' : 'any', ...freezeExpertConstraints(settings.routingExpertPolicy) }
    })
  }
  const stored = readStoredRoutingState(getRoutingSettingsBoundary().read().document)
  if (stored.mode !== 'v1_active') {
    // Before a saved V1 rule set exists, automatic Sessions still receive a
    // canonical baseline freeze. The route and any legacy failover domain are
    // selected once, then recorded so later turns cannot silently retarget
    // through mutable settings. A no-match V1 policy remains pause-only below.
    if (meta.model === 'auto' && meta.routingScope !== 'fixed') {
      try {
        const route = resolveRuntimeSessionRoute({ meta, payload, settings: getSettings(), providers: listProviders(), allowAnyEngine: true })
        if (!route) return undefined
        const provider = listProviders().find((item) => item.id === route.providerId)
        if (!provider) return undefined
        const settings = getSettings()
        const line = getBusinessLines(settings).find((item) => item.id === meta.businessLineId)
        if (!line?.enabled) return undefined
        const runtimeTarget = resolveProviderRuntimeTarget(provider, { appId: provider.engine, model: route.model })
        if (!providerAllowedByRoutingExpertPolicy(provider, settings.routingExpertPolicy, runtimeTarget)) return undefined
        const protocol = targetProtocol({ providerId: provider.id, model: route.model })
        const identity = getProviderConnectionIdentity(provider.id)
        const target = { providerId: provider.id, model: route.model, protocol, connectionIdentity: identity }
        // Legacy settings still expose provider/model failover. Freeze the
        // exact same-protocol candidate domain into this Run so a 429/auth
        // refusal can retry a known target without recapturing mutable
        // settings. Cross-protocol candidates stay out of a native Engine's
        // recovery domain and require a fresh Session/Run.
        const qualifiedTargets = (route.recoveryCatalog ?? [])
          .map((candidate) => {
            const candidateProvider = listProviders().find((item) => item.id === candidate.providerId)
            if (!candidateProvider) return undefined
            let candidateProtocol: FrozenNativeProtocol
            try { candidateProtocol = targetProtocol(candidate) } catch { return undefined }
            if (candidateProtocol !== protocol) return undefined
            try {
              const runtimeTarget = resolveProviderRuntimeTarget(candidateProvider, { appId: candidateProvider.engine, model: candidate.model })
              if (!providerAllowedByRoutingExpertPolicy(candidateProvider, settings.routingExpertPolicy, runtimeTarget)) return undefined
              if (settings.routingExpertPolicy.locality === 'local_only' && !isLocalProviderUrl(runtimeTarget.baseUrl)) return undefined
              return { providerId: candidateProvider.id, model: candidate.model, protocol: candidateProtocol,
                connectionIdentity: getProviderConnectionIdentity(candidateProvider.id) }
            } catch { return undefined }
          })
          .filter((candidate): candidate is typeof target => Boolean(candidate))
        if (!qualifiedTargets.some((candidate) => candidate.providerId === target.providerId && candidate.model === target.model)) {
          qualifiedTargets.unshift(target)
        }
        const retryTargets = qualifiedTargets
          .filter((candidate) => candidate.providerId !== target.providerId || candidate.model !== target.model)
          .map(({ providerId, model, protocol }) => ({ providerId, model, protocol }))
        const legacyFailover: RoutingFailurePolicy = settings.failoverEnabled && retryTargets.length > 0
          ? { kind: 'retry_allowed_targets' as const, maxAdditionalAttempts: Math.min(3, retryTargets.length), retryOn: ['rate_limited', 'auth_failed'] }
          : { kind: 'pause' as const }
        // The baseline route is still a one-time selection.  Arm the
        // per-message hand-off so the Engine consumes this exact target
        // instead of running the mutable legacy scheduler a second time
        // after the Run has been durably bound.
        prepareSessionTurnRoute(meta, payload, route)
        return sealFrozenRoutingPolicy({
          schemaVersion: 1, evaluatorVersion: 1, executionDomain: 'native_text',
          owner: { runId: run.id, sessionId: run.sessionId, taskId: run.taskId,
            ...(meta.workspaceId ?? meta.projectId ? { projectId: meta.workspaceId ?? meta.projectId } : {}),
            ...(meta.goalId ? { goalId: meta.goalId } : {}), workItemId: meta.workItemId, businessLineId: meta.businessLineId },
          messageId: payload.messageId, frozenAt: Date.now(), originalPromptDigest: digest(payload.text),
          // This synthetic legacy source keeps the policy distinguishable from
          // a V1 no-match default (which intentionally pauses). It records the
          // legacy failover contract in the frozen Run without inventing a
          // user-authored V1 rule.
          ruleSetRevision: 1, ruleSetDigest: digest('baseline-target'), matchedRules: retryTargets.length ? [{
            id: 'legacy-baseline-routing', version: 1,
            source: { kind: 'legacy_settings', legacyDigest: digest('baseline-target'), legacyIndex: 0 },
            priority: 0, scope: { kind: 'global' }
          }] : [],
          contextDigest: digest({ businessLineId: meta.businessLineId, executionDomain: 'native_text' }),
          catalogDigest: digest(qualifiedTargets.map(({ providerId, model, protocol }) => ({ providerId, model, protocol }))),
          evaluationDigest: digest({ providerId: provider.id, model: route.model }),
          baseStrategy: getSettings().schedulerStrategy, baseStrategySource: { kind: 'global' },
          userIntent: meta.routingScope === 'provider' ? { kind: 'provider', providerId: provider.id } : { kind: 'global' },
          effectivePolicy: { selection: { kind: 'global_auto' }, strategy: getSettings().schedulerStrategy, failure: legacyFailover },
          initialTarget: { providerId: provider.id, model: route.model, protocol }, qualifiedTargets,
          retryTargets: legacyFailover.kind === 'retry_allowed_targets' ? retryTargets : [],
          hardBounds: { requiredCapabilities: [...(line.requiredCapabilities ?? []), ...(route.recoveryTask?.requiresTools ? ['tools' as const] : []), ...(route.recoveryTask?.requiresVision ? ['vision' as const] : [])], minContextTokens: Math.max(1, route.recoveryTask?.minContextTokens ?? meta.contextTokens ?? 1), allowedProviderIds: [...settings.routingExpertPolicy.allowedProviderIds], locality: settings.routingExpertPolicy.locality === 'local_only' ? 'local_only' : 'any', ...freezeExpertConstraints(settings.routingExpertPolicy) }
        })
      } catch { return undefined }
    }
    return undefined
  }
  const capture = captureSessionRouting({ meta, prompt: payload.text, payload })
  const result = evaluateRoutingRuleSet({ rules: { kind: 'saved', value: stored.ruleSet }, context: capture.context, snapshots: capture.snapshots })
  if (result.status !== 'ready') return undefined
  const route = resolveRouteForEvaluation(meta, payload, result.initialTarget, result)
  if (route) prepareSessionTurnRoute(meta, payload, route)
  const policies = new Map(listProviders().map((provider) => [provider.id, getProviderConnectionIdentity(provider.id)]))
  return frozenPolicyFromEvaluation({ meta, run, payload, context: capture.context, snapshots: capture.snapshots, result,
    ruleSetRevision: stored.ruleSet.revision, ruleSetDigest: digest(stored.ruleSet), contextDigest: digest(capture.context),
    catalogDigest: digest(capture.snapshots.providers.map(({ id, name, engine, models }) => ({ id, name, engine, models }))),
    connectionIdentities: policies, protocolForTarget: targetProtocol })
}

function prepareFrozenContinuationRoute(
  meta: SessionMeta,
  payload: SendMessagePayload,
  policy: FrozenRunRoutingPolicyV1
): void {
  const target = policy.initialTarget
  const provider = listProviders().find((item) => item.id === target.providerId)
  if (!provider) throw new Error(`冻结路由目标 ${target.providerId} 不再可用。`)
  // A continuation preserves its target, but new input still has to fit that
  // target (for example, adding an image to a text-only conversation).
  resolveRuntimeSessionRoute({ meta: { ...meta, providerId: target.providerId, model: target.model, routingScope: 'fixed', routingControl: undefined },
    payload, settings: getSettings(), providers: [provider], allowAnyEngine: true })
  let route: ResolvedSessionRoute | undefined
  try {
    route = resolveRuntimeSessionRoute({
      meta: { ...meta, providerId: target.providerId, model: 'auto', engine: meta.engine, routingControl: undefined },
      payload,
      settings: getSettings(),
      providers: listProviders(),
      allowAnyEngine: true
    })
  } catch {
    route = undefined
  }
  const pinned: ResolvedSessionRoute = route
    ? { ...route, providerId: target.providerId, providerName: provider.name, model: target.model,
      switchedProvider: target.providerId !== meta.providerId,
      decision: { ...route.decision, providerId: target.providerId, providerName: provider.name,
        model: target.model, decisionDigest: policy.evaluationDigest,
        strategy: policy.effectivePolicy.strategy, selectionReason: '续接复用 Run 冻结目标' },
      // Validators are a separate network fan-out and are not part of the
      // frozen Run target set. Disable the mutable plan on continuation so a
      // changed rule cannot introduce an unfrozen Provider request.
      crossValidationPlan: { enabled: false,
        primary: { providerId: target.providerId, providerName: provider.name, model: target.model },
        validators: [], policy: 'skip', reason: '冻结路由续接' } }
    : {
      kind: 'routed', providerId: target.providerId, providerName: provider.name, model: target.model,
      reason: '续接复用 Run 冻结目标', switchedProvider: target.providerId !== meta.providerId,
      decision: createLegacyRoutingDecisionView({ providerId: target.providerId, providerName: provider.name,
        model: target.model, strategy: policy.effectivePolicy.strategy, complexity: 'medium', candidateCount: policy.qualifiedTargets.length,
        switchedProvider: target.providerId !== meta.providerId, reason: '续接复用 Run 冻结目标' }),
      crossValidationPlan: { enabled: false, primary: { providerId: target.providerId, providerName: provider.name, model: target.model }, validators: [], policy: 'skip', reason: '冻结路由续接' },
      recoveryCatalog: policy.qualifiedTargets.map((candidate) => ({ providerId: candidate.providerId, model: candidate.model })),
      recoveryTask: { requiresTools: policy.hardBounds.requiredCapabilities.includes('tools'), requiresVision: policy.hardBounds.requiredCapabilities.includes('vision'), minContextTokens: policy.hardBounds.minContextTokens }
    }
  prepareSessionTurnRoute(meta, payload, pinned)
}

function resolveRouteForEvaluation(meta: SessionMeta, payload: SendMessagePayload, target: { providerId: string; model: string }, result: Extract<RoutingEvaluationResult, { status: 'ready' }>) {
  // The evaluator is allowed to choose a different engine/provider.  Ask the
  // legacy route helper only for the mutable metadata shape, with cross-engine
  // candidates enabled; the selected pair below is always the evaluator's.
  const route = resolveRuntimeSessionRoute({ meta, payload, settings: getSettings(), providers: listProviders(), allowAnyEngine: true })
  if (!route) return undefined
  const provider = listProviders().find((item) => item.id === target.providerId)
  if (!provider) return undefined
  // The V1 evaluator owns the selected target. Reuse the already-built
  // runtime route only for engine/cross-validation metadata, then replace its
  // mutable selected pair with the evaluator's canonical target. This avoids a
  // second health/ranking pass deciding a different Provider.
  const switchedProvider = target.providerId !== meta.providerId
  return {
    ...route,
    providerId: target.providerId,
    model: target.model,
    switchedProvider,
    decision: { ...route.decision, providerId: target.providerId, providerName: provider.name,
      model: target.model, decisionDigest: result.decisionDigest, strategy: result.task.strategy,
      taskKinds: result.task.taskKinds, riskLevel: result.task.riskLevel, candidateCount: result.rankedCandidates.length,
      manualOverrideApplied: result.effectivePolicy.source === 'matched_rule', selectionReason: 'V1 evaluator selected canonical initial target' },
    crossValidationPlan: { ...route.crossValidationPlan,
      primary: { ...route.crossValidationPlan.primary, providerId: target.providerId, providerName: provider.name, model: target.model } }
  }
}

function freezeSessionRoutingControl(meta: SessionMeta, run: TaskRunRecord, payload: SendMessagePayload): FrozenRunRoutingPolicyV1 {
  const { capture, result, rules } = evaluateSessionRoutingControl(meta, payload)
  const provider = listProviders().find(item => item.id === result.initialTarget.providerId)
  if (!provider) throw new Error('任务路由目标已不可用。')
  const protocol = targetProtocol(result.initialTarget)
  if (result.allowedAlternatives.some(target => targetProtocol(target) !== protocol)) {
    throw new Error('备选连接的协议已变化，请重新确认当前任务的备选范围。')
  }
  const switchedProvider = provider.id !== meta.providerId
  const target = { ...result.initialTarget, providerName: provider.name }
  const route: ResolvedSessionRoute = {
    kind: 'routed', ...target, switchedProvider, reason: '采用当前任务明确选择的路由',
    decision: { ...createLegacyRoutingDecisionView({ ...target, strategy: result.task.strategy,
      complexity: 'medium', candidateCount: result.rankedCandidates.length, switchedProvider,
      reason: '采用当前任务明确选择的路由' }), decisionDigest: result.decisionDigest,
      taskKinds: result.task.taskKinds, riskLevel: result.task.riskLevel, manualOverrideApplied: true },
    crossValidationPlan: { enabled: false, primary: target, validators: [], policy: 'skip', reason: '任务路由仅允许明确选择的目标' },
    recoveryCatalog: result.qualifiedTargets,
    recoveryTask: { requiresTools: result.task.requiresTools, requiresVision: result.task.requiresVision, minContextTokens: result.task.minContextTokens }
  }
  const policy = frozenPolicyFromEvaluation({ meta, run, payload, context: capture.context,
    snapshots: capture.snapshots, result, ruleSetRevision: 1, ruleSetDigest: digest(rules),
    contextDigest: digest(capture.context), catalogDigest: digest(capture.snapshots),
    connectionIdentities: new Map(listProviders().map(item => [item.id, getProviderConnectionIdentity(item.id)])),
    protocolForTarget: targetProtocol })
  prepareSessionTurnRoute(meta, payload, route)
  return policy
}

function targetProtocol(target: { providerId: string; model: string }): FrozenNativeProtocol {
  const provider = listProviders().find((item) => item.id === target.providerId)
  if (!provider) throw new Error('Provider unavailable')
  return resolveNativeExecutorProtocol(provider, target.model)
}

/**
 * Convert a *ready* evaluator result to the immutable Run record.  Keeping
 * this conversion separate from SessionRoute is intentional: a SessionRoute
 * is a mutable runtime projection and cannot invent rule provenance,
 * connection snapshots, or hard-qualified retry targets.
 */
export function frozenPolicyFromEvaluation(input: {
  meta: SessionMeta
  run: TaskRunRecord
  payload: SendMessagePayload
  context: TrustedRoutingContext
  snapshots: RoutingEvaluationSnapshots
  result: RoutingEvaluationResult
  ruleSetRevision: number
  ruleSetDigest: string
  contextDigest: string
  catalogDigest: string
  connectionIdentities: ReadonlyMap<string, ProviderConnectionIdentity>
  protocolForTarget: (target: { providerId: string; model: string }) => FrozenNativeProtocol
  now?: number
}): FrozenRunRoutingPolicyV1 {
  if (input.result.status !== 'ready') throw new Error('无法冻结 blocked 的路由求值结果。')
  const { meta, run, payload, context, snapshots, result } = input
  if (!payload.messageId) throw new Error('冻结路由缺少消息身份。')
  if (context.executionDomain !== 'native_text' || context.businessLine.id !== meta.businessLineId || !context.businessLine.enabled) {
    throw new Error('路由求值上下文与 canonical Session/业务线不一致。')
  }
  if (result.matchedRules.some((rule) => rule.version === null)) {
    throw new Error('冻结路由不能绑定未解析版本的规则来源。')
  }
  const qualifiedTargets = result.qualifiedTargets.map((target) => {
    const identity = input.connectionIdentities.get(target.providerId)
    if (!identity) throw new Error(`目标 ${target.providerId}/${target.model} 缺少主进程 connection identity。`)
    return { ...target, protocol: input.protocolForTarget(target), connectionIdentity: identity }
  })
  const initial = result.initialTarget
  if (!qualifiedTargets.some((target) => target.providerId === initial.providerId && target.model === initial.model)) {
    throw new Error('求值结果的 initialTarget 不在 qualifiedTargets 中。')
  }
  const policy: Omit<FrozenRunRoutingPolicyV1, 'policyDigest'> = {
    schemaVersion: 1 as const, evaluatorVersion: 1 as const, executionDomain: 'native_text' as const,
    owner: { runId: run.id, sessionId: run.sessionId, taskId: run.taskId,
      ...(meta.workspaceId ?? meta.projectId ? { projectId: meta.workspaceId ?? meta.projectId } : {}),
      ...(meta.goalId ? { goalId: meta.goalId } : {}), workItemId: meta.workItemId!, businessLineId: meta.businessLineId! }, messageId: payload.messageId,
    frozenAt: input.now ?? Date.now(), originalPromptDigest: digest(payload.text), ruleSetRevision: input.ruleSetRevision,
    ruleSetDigest: input.ruleSetDigest, matchedRules: result.matchedRules.map(toFrozenRuleReference), contextDigest: input.contextDigest,
    catalogDigest: input.catalogDigest, evaluationDigest: stripDigestPrefix(result.decisionDigest), baseStrategy: context.baseStrategy,
    baseStrategySource: context.baseStrategySource, userIntent: context.userIntent,
    effectivePolicy: { selection: result.effectivePolicy.selection, strategy: result.effectivePolicy.strategy, failure: result.effectivePolicy.failure }, initialTarget: { ...initial, protocol: input.protocolForTarget(initial) }, qualifiedTargets,
    retryTargets: result.effectivePolicy.failure.kind === 'retry_allowed_targets' ? result.allowedAlternatives.map((target) => ({ ...target, protocol: input.protocolForTarget(target) })) : [],
    hardBounds: { requiredCapabilities: [...new Set([...(context.businessLine.requiredCapabilities ?? []), ...(result.task.requiresTools ? ['tools' as const] : []), ...(result.task.requiresVision ? ['vision' as const] : [])])], minContextTokens: Math.max(1, result.task.minContextTokens),
      allowedProviderIds: [...snapshots.expertPolicy.allowedProviderIds], locality: snapshots.expertPolicy.locality === 'local_only' ? 'local_only' : 'any', ...freezeExpertConstraints(snapshots.expertPolicy) }
  }
  return sealFrozenRoutingPolicy(policy)
}

function stripDigestPrefix(value: string): string {
  const stripped = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value
  if (!/^[a-f0-9]{64}$/.test(stripped)) throw new Error('求值结果缺少合法 evaluation digest。')
  return stripped
}

function toFrozenRuleReference(rule: RoutingEvaluationResult['matchedRules'][number]): FrozenRoutingRuleReference {
  if (rule.version === null) throw new Error(`规则 ${rule.id} 缺少不可变版本。`)
  return { id: rule.id, version: rule.version, source: rule.source, priority: rule.priority, scope: rule.scope }
}

function ruleMayMatch(rule: { scope: { kind: string; businessLineId?: string }; when: { keywords?: { mode: 'any' | 'all'; values: string[] }; taskKinds?: string[]; minRiskLevel?: string; whenStrategy?: string } }, prompt: string, taskKinds: string[], risk: string, strategy: string, businessLineId: string): boolean {
  if (rule.scope.kind === 'business_line' && rule.scope.businessLineId !== businessLineId) return false
  const when = rule.when
  const keywords = when.keywords?.values.map((value) => prompt.toLocaleLowerCase('en-US').includes(value.toLocaleLowerCase('en-US'))) ?? []
  if (keywords.length && (when.keywords?.mode === 'all' ? !keywords.every(Boolean) : !keywords.some(Boolean))) return false
  if (when.taskKinds?.length && !when.taskKinds.some((kind) => taskKinds.includes(kind))) return false
  if (when.whenStrategy && when.whenStrategy !== strategy) return false
  if (when.minRiskLevel && ({ low: 0, medium: 1, high: 2 }[risk as 'low' | 'medium' | 'high'] ?? 0) < ({ low: 0, medium: 1, high: 2 }[when.minRiskLevel as 'low' | 'medium' | 'high'] ?? 0)) return false
  return true
}

function freezeExpertConstraints(policy: import('../../shared/types').RoutingExpertPolicy) {
  return { allowedRegions: [...(policy.allowedRegions ?? [])], allowedDomains: [...(policy.allowedDomains ?? [])], requiredPermissions: [...(policy.requiredPermissions ?? [])] }
}
