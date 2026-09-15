import { AUTO_MODEL, type AgentEvent, type AppSettings, type CreateSessionOptions, type HistoryEntry, type SessionMeta, type SendMessagePayload, type CaoGenDriveMode } from '../../shared/types'
import { getBusinessLines, resolveBusinessLineId } from '../../shared/business-line-types'
import { getRoutingSettingsBoundary, getSettings } from '../settings'
import { listProviders, getProviderConnectionIdentity } from '../providers'
import { listHistory } from '../history'
import { calculateMonthlyBudgetSnapshot } from './monthly-budget'
import { settingsForCaoGenDrive } from './drive'
import { resolveSessionModelRoute, type SessionRouteResult } from './session-routing'
import { ModelRouteError } from './model-route-error'
import { resolveProviderRuntimeTarget } from '../provider/providerRuntimeTarget'
import { applyBusinessLineCreationPolicy, filterBusinessLineModels } from '../business-line-execution-policy'
import { nativeBudgetSnapshot } from './native-request-budget'
import { buildModelProfiles } from './model-profile'
import { captureSessionRouting } from '../routing-service/session-routing-capture'
import { evaluateRoutingRuleSet } from './routing-policy/routing-policy-evaluator'
import { readStoredRoutingState } from '../routing-settings/routing-settings-state'

export type ResolvedSessionRoute = Extract<SessionRouteResult, { kind: 'routed' }>
type RoutingSession = Pick<SessionMeta, 'id' | 'sdkSessionId' | 'createdAt' | 'providerId' | 'model' | 'routingScope' | 'engine' | 'driveMode' | 'costUsd' | 'budgetUsd' | 'cwd' | 'sourceCwd' | 'contextTokens' | 'businessLineId'>

/** One routing policy serves session creation and every native protocol runtime. */
export function resolveRuntimeSessionRoute(input: {
  meta: RoutingSession
  payload: SendMessagePayload
  settings?: AppSettings
  providers?: ReturnType<typeof listProviders>
  history?: HistoryEntry[]
  allowAnyEngine?: boolean
  rootDir?: string
}): ResolvedSessionRoute | undefined {
  const { meta, payload } = input
  const settings = settingsForCaoGenDrive(input.settings ?? getSettings(), meta.driveMode)
  const businessLine = meta.businessLineId ? requireBusinessLine(settings, meta.businessLineId) : undefined
  const providers = filterBusinessLineModels(input.providers ?? listProviders(), businessLine).filter((provider) =>
    meta.routingScope !== 'provider' || provider.id === meta.providerId
  )
  if (meta.model !== AUTO_MODEL) return validateFixedBusinessLineModel(meta, providers, businessLine)
  if (meta.routingScope === 'fixed') throw new ModelRouteError('ROUTING_MANUAL_TARGET_UNAVAILABLE', '固定模型模式必须指定具体模型。')
  const history = input.history ?? listHistory()
  const monthly = calculateMonthlyBudgetSnapshot({ settings, history, currentSession: meta })
  const budget = nativeBudgetSnapshot(meta, { settings, history }, input.rootDir)
  if (budget.sessionUnknown && budget.sessionRemainingUsd !== undefined) throw new ModelRouteError('ROUTING_BUDGET_EXHAUSTED', '会话存在费用待对账的请求，有限预算暂不可继续发送。')
  const result = resolveSessionModelRoute({
    ...routingSettings(settings), enabled: true, currentModel: meta.model,
    providerId: meta.providerId, providers, engine: meta.engine,
    connectionIdentities: Object.fromEntries(providers.flatMap((provider) => {
      try { return [[provider.id, getProviderConnectionIdentity(provider.id)]] }
      catch { return [] } // Missing trusted identity cannot borrow legacy model-name observations.
    })),
    // Runtime instances own protocol-specific replay state; cross-engine switching requires a new instance.
    allowAnyEngine: input.allowAnyEngine === true,
    driveMode: meta.driveMode, payload, businessLineStrategy: businessLine?.routingPreference,
    sessionCostUsd: budget.sessionSpentUsd, sessionBudgetUsd: meta.budgetUsd,
    estimatedContextTokens: meta.contextTokens,
    monthlyBudgetRemainingUsd: budget.monthlyRemainingUsd ?? monthly.remainingUsd, projectPath: meta.sourceCwd ?? meta.cwd
  })
  if (result.kind !== 'routed') throw new ModelRouteError('ROUTING_NO_CANDIDATES', '自动调度未产生可执行的模型。')
  return bindRuntimeRouteModel(result, providers)
}

function bindRuntimeRouteModel(route: ResolvedSessionRoute, providers: ReturnType<typeof listProviders>): ResolvedSessionRoute {
  const provider = providers.find((candidate) => candidate.id === route.providerId)
  if (!provider) throw new ModelRouteError('ROUTING_NO_CANDIDATES', '已选 Provider 不再可用。')
  const profile = provider.advancedConfig?.modelProfiles?.find((candidate) =>
    candidate.model.toLowerCase() === route.model.toLowerCase() || candidate.aliases?.some((alias) => alias.toLowerCase() === route.model.toLowerCase())
  )
  const canonical = profile?.model ?? route.model
  const target = resolveProviderRuntimeTarget(provider, { appId: provider.engine, model: route.model })
  const canonicalTarget = resolveProviderRuntimeTarget(provider, { appId: provider.engine, model: canonical })
  // Declared aliases carry the same profile; app-specific remaps to another model need a new scored candidate.
  if (target.model !== canonical || canonicalTarget.model !== canonical) {
    throw new ModelRouteError('ROUTING_MANUAL_TARGET_UNAVAILABLE', '模型映射改变了自动调度目标，请将实际模型加入候选后重试。')
  }
  const wireModel = provider.engine === 'gemini' ? canonical.replace(/^models\//, '') : canonical
  if (wireModel === route.model) return route
  return {
    ...route, model: wireModel, decision: { ...route.decision, model: wireModel },
    crossValidationPlan: { ...route.crossValidationPlan, primary: { ...route.crossValidationPlan.primary, model: wireModel } }
  }
}

export function resolveCreationModelRoute(input: {
  opts: CreateSessionOptions
  settings: AppSettings
  driveMode: CaoGenDriveMode
  providerId: string
  model: string
}): ResolvedSessionRoute | undefined {
  const meta = {
    id: '', createdAt: Date.now(), providerId: input.providerId, model: input.model, driveMode: input.driveMode,
    routingScope: input.opts.routingScope ?? (input.providerId ? 'provider' : 'global'),
    costUsd: 0, contextTokens: 0, budgetUsd: input.opts.budgetUsd,
    cwd: input.opts.cwd, businessLineId: input.opts.businessLineId
  } as SessionMeta
  const payload = { text: input.opts.initialPrompt?.trim() || input.opts.title?.trim() || '通用任务' }
  // A native Engine is constructed immediately after this function returns. If
  // a saved V1 rule selects another provider/protocol, creation must resolve
  // that target before the Engine is instantiated; waiting until first send
  // leaves an OpenAI Engine holding an Anthropic frozen target (and vice versa).
  if (input.model === AUTO_MODEL && input.opts.routingScope !== 'provider') {
    const stored = readStoredRoutingState(getRoutingSettingsBoundary().read().document)
    if (stored.mode === 'v1_active') {
      const capture = captureSessionRouting({ meta, prompt: payload.text })
      const result = evaluateRoutingRuleSet({ rules: { kind: 'saved', value: stored.ruleSet }, context: capture.context, snapshots: capture.snapshots })
      if (result.status !== 'ready') {
        const reason = result.diagnostics.map((item) => item.message).join('；') || 'V1 路由规则没有可执行目标。'
        throw new ModelRouteError('ROUTING_NO_CANDIDATES', reason)
      }
      const base = resolveRuntimeSessionRoute({ meta, payload, settings: input.settings, allowAnyEngine: true })
      if (!base) throw new ModelRouteError('ROUTING_NO_CANDIDATES', '自动调度未产生可执行的模型。')
      const provider = listProviders().find((candidate) => candidate.id === result.initialTarget.providerId)
      if (!provider) throw new ModelRouteError('ROUTING_NO_CANDIDATES', '规则选中的 Provider 不再可用。')
      const switchedProvider = provider.id !== input.providerId
      return {
        ...base,
        providerId: provider.id,
        providerName: provider.name,
        model: result.initialTarget.model,
        switchedProvider,
        decision: { ...base.decision, providerId: provider.id, providerName: provider.name,
          model: result.initialTarget.model, strategy: result.task.strategy,
          taskKinds: result.task.taskKinds, riskLevel: result.task.riskLevel,
          candidateCount: result.rankedCandidates.length, decisionDigest: result.decisionDigest,
          manualOverrideApplied: result.effectivePolicy.source === 'matched_rule',
          selectionReason: 'V1 evaluator selected canonical initial target' },
        crossValidationPlan: { ...base.crossValidationPlan,
          primary: { ...base.crossValidationPlan.primary, providerId: provider.id, providerName: provider.name, model: result.initialTarget.model } },
        recoveryCatalog: result.qualifiedTargets.map((target) => ({ providerId: target.providerId, model: target.model })),
        recoveryTask: { requiresTools: result.task.requiresTools, requiresVision: result.task.requiresVision, minContextTokens: result.task.minContextTokens }
      }
    }
  }
  return resolveRuntimeSessionRoute({ meta, payload, settings: input.settings, allowAnyEngine: true })
}

export function sessionRouteEvent(route: ResolvedSessionRoute): Extract<AgentEvent, { kind: 'routing' }> {
  return {
    kind: 'routing', providerId: route.providerId, providerName: route.providerName,
    model: route.model, reason: route.reason, decision: route.decision, crossValidationPlan: route.crossValidationPlan
  }
}

function routingSettings(settings: AppSettings) {
  return {
    strategy: settings.schedulerStrategy, settingsBudgetUsd: settings.budgetUsdPerSession,
    fallbackProviderId: settings.fallbackProviderId, fallbackModel: settings.fallbackModel,
    lowCostProviderId: settings.lowCostProviderId, lowCostModel: settings.lowCostModel,
    strongReasoningProviderId: settings.strongReasoningProviderId, strongReasoningModel: settings.strongReasoningModel,
    reviewProviderId: settings.reviewProviderId, reviewModel: settings.reviewModel,
    researchProviderId: settings.researchProviderId, researchModel: settings.researchModel,
    planningProviderId: settings.planningProviderId, planningModel: settings.planningModel,
    codingProviderId: settings.codingProviderId, codingModel: settings.codingModel,
    testingProviderId: settings.testingProviderId, testingModel: settings.testingModel,
    documentationProviderId: settings.documentationProviderId, documentationModel: settings.documentationModel,
    modelRoutingRules: settings.modelRoutingRules, routingExpertPolicy: settings.routingExpertPolicy
  }
}

export function sessionBusinessLine(input: {
  opts: CreateSessionOptions; history?: HistoryEntry; parent?: SessionMeta; settings: AppSettings; resuming: boolean
}): string {
  const { opts, history, parent, settings } = input
  const inherited = input.resuming ? history?.businessLineId : opts.businessLineId ?? history?.businessLineId ?? parent?.businessLineId
  const id = inherited ?? resolveBusinessLineId(history ?? parent ?? opts)
  const line = requireBusinessLine(settings, id)
  opts.budgetUsd = opts.budgetUsd ?? history?.budgetUsd ?? parent?.budgetUsd
  applyBusinessLineCreationPolicy(opts, line)
  return line.id
}

function validateFixedBusinessLineModel(meta: RoutingSession, providers: ReturnType<typeof listProviders>, line?: ReturnType<typeof requireBusinessLine>): undefined {
  if (!line?.requiredCapabilities?.length) return undefined
  const provider = providers.find((candidate) => candidate.id === meta.providerId)
  const profile = provider && buildModelProfiles({ providerId: provider.id, providerName: provider.name,
    models: provider.models, modelProfiles: provider.advancedConfig?.modelProfiles, engine: provider.engine
  }).find((candidate) => candidate.model === meta.model)
  const satisfies = profile && line.requiredCapabilities.every((capability) => capability === 'tools' ? profile.supportsTools : profile.supportsVision)
  if (!satisfies) throw new ModelRouteError('ROUTING_MANUAL_TARGET_UNAVAILABLE', '指定模型不满足业务线所需能力')
  return undefined
}

function requireBusinessLine(settings: AppSettings, id: string) {
  const line = getBusinessLines(settings).find((candidate) => candidate.id === id)
  if (!line || !line.enabled) throw new Error(`业务线不存在或已停用：${id}`)
  return line
}
