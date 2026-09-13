import {
  AUTO_MODEL,
  caogenDrivePolicyView,
  type AppLanguage,
  type AppSettings,
  type CaoGenDrivePolicyView,
  type CaoGenDriveValidationDepth,
  type EngineInfo,
  type HistoryEntry,
  type McpProbeResult,
  type PluginRegistryItem,
  type PluginRegistryView,
  type ProviderHealthView,
  type ProviderView,
  type SessionMeta
} from '../../shared/types'
import { calculateBudgetReport, type BudgetReportSnapshot } from '../../shared/budget'
import {
  translateControlCenter,
  translateControlCenterFailureLabel,
  type ControlCenterTranslationKey
} from './i18n/controlCenterTranslations'

export type ControlCenterStatus = 'available' | 'needs-config' | 'external-required' | 'disabled' | 'unknown'

export interface ControlCenterProviderStatus {
  id: string
  name: string
  endpoint: string
  modelCount: number
  keyCount: number
  activeKeyLabel?: string
  budgetLabel: string
  hasToken: boolean
  tokenLabel: string
  healthLabel: string
  successRateLabel: string
  latencyLabel: string
  recentFailures: ProviderHealthView['recentFailures']
  status: ControlCenterStatus
  detail: string
  selected: boolean
}

export interface ControlCenterMcpStatus {
  total: number
  enabled: number
  probed: number
  ok: number
  failed: number
  status: ControlCenterStatus
  label: string
  items: Array<{
    id: string
    name: string
    enabled: boolean
    status: ControlCenterStatus
    label: string
  }>
}

export interface ControlCenterEngineStatus {
  kind: string
  label: string
  available: boolean
  optional: boolean
  configured: boolean
  status: ControlCenterStatus
  statusLabel: string
}

export interface ControlCenterCapability {
  title: string
  status: ControlCenterStatus
  detail: string
}

export interface ControlCenterModelRole {
  key: string
  label: string
  providerLabel: string
  modelLabel: string
  status: ControlCenterStatus
  detail: string
}

export type ControlCenterDrivePolicyView = Omit<CaoGenDrivePolicyView, 'zhLabel'> & {
  displayLabel: string
  validationDepthLabel: string
}

export interface ControlCenterView {
  policy: ControlCenterDrivePolicyView
  route: {
    driveLabel: string
    routeLabel: string
    providerLabel: string
    providerStatus: ControlCenterStatus
    modelLabel: string
    strategyLabel: string
    crossValidationLabel: string
    failoverLabel: string
    customRulesLabel: string
  }
  budget: {
    driveSessionLabel: string
    sessionLabel: string
    monthlyLabel: string
    status: ControlCenterStatus
    report: BudgetReportSnapshot
  }
  providers: ControlCenterProviderStatus[]
  providerSummary: {
    total: number
    configuredKeys: number
    totalKeys: number
    healthy: number
    missingKeys: number
  }
  modelRoles: ControlCenterModelRole[]
  mcp: ControlCenterMcpStatus
  engines: ControlCenterEngineStatus[]
  capabilities: ControlCenterCapability[]
}

export interface BuildControlCenterViewInput {
  settings: AppSettings
  providers: ProviderView[]
  health: ProviderHealthView[]
  engines: EngineInfo[]
  pluginRegistry?: PluginRegistryView
  mcpProbeResults?: Record<string, McpProbeResult>
  history?: HistoryEntry[]
  activeSessions?: SessionMeta[]
  now?: number
}

export function buildControlCenterView(input: BuildControlCenterViewInput): ControlCenterView {
  const language = input.settings.language
  const policy = localizeDrivePolicy(caogenDrivePolicyView(input.settings.driveMode), language)
  const healthByProvider = new Map(input.health.map((item) => [item.providerId, item]))
  const selectedProviderId = input.settings.defaultProviderId
  const providerRows = input.providers.map((provider) =>
    buildProviderStatus(provider, healthByProvider.get(provider.id), selectedProviderId, language)
  )
  const selectedProvider = providerRows.find((provider) => provider.id === selectedProviderId)
  const selectedProviderMissing = Boolean(selectedProviderId) && !selectedProvider
  const allProviders = providerRows
  const providerStatus = selectedProviderMissing
    ? 'needs-config'
    : selectedProviderId
      ? (selectedProvider?.status ?? 'external-required')
      : 'needs-config'
  const defaultProviderName = selectedProviderMissing
    ? `${input.settings.defaultProviderId} ${translateControlCenter(language, 'controlCenterMissingSuffix')}`
    : (selectedProvider?.name ?? translateControlCenter(language, 'controlCenterNoProviderPreference'))
  const mcp = buildMcpStatus(input.pluginRegistry, input.mcpProbeResults ?? {}, language)
  const engines = input.engines.map((engine) => {
    const optional = engine.optional === true
    const configured = engine.configured !== false
    return {
      ...engine,
      label: engineDisplayLabel(engine, language),
      optional,
      configured,
      status: !engine.available
        ? 'external-required'
        : optional
          ? configured
            ? 'unknown'
            : 'needs-config'
          : 'available',
      statusLabel: !engine.available
        ? translateControlCenter(language, 'controlCenterEngineRuntimeUnavailable')
        : optional
          ? configured
            ? translateControlCenter(language, 'controlCenterEngineCompatibilityUnknown')
            : translateControlCenter(language, 'controlCenterEngineOptionalNoCredential')
          : translateControlCenter(language, 'controlCenterEngineAvailable')
    } satisfies ControlCenterEngineStatus
  })
  const budgetReport = calculateBudgetReport({
    settings: input.settings,
    providers: input.providers,
    history: input.history ?? [],
    activeSessions: input.activeSessions ?? [],
    now: input.now
  })
  const budgetExceeded = budgetReport.monthlyExceeded || budgetReport.activeSessions.some((session) => session.overBudget)

  return {
    policy,
    route: {
      driveLabel: policy.displayLabel,
      routeLabel: input.settings.smartModelRoutingEnabled
        ? translateControlCenter(language, 'controlCenterRouteEnabled')
        : translateControlCenter(language, 'controlCenterRouteDisabled'),
      providerLabel: defaultProviderName,
      providerStatus,
      modelLabel: modelLabel(input.settings.defaultModel, language),
      strategyLabel: strategyLabel(input.settings.schedulerStrategy, language),
      crossValidationLabel: input.settings.modelCrossValidationAutoRunEnabled
        ? translateControlCenter(language, 'controlCenterReviewEnabled')
        : translateControlCenter(language, 'controlCenterReviewDisabled'),
      failoverLabel: input.settings.failoverEnabled
        ? translateControlCenter(language, 'controlCenterFailoverEnabled')
        : translateControlCenter(language, 'controlCenterFailoverDisabled'),
      customRulesLabel: customRulesLabel(input.settings.modelRoutingRules, language)
    },
    budget: {
      driveSessionLabel: moneyLabel(policy.sessionBudgetUsd),
      sessionLabel: input.settings.budgetUsdPerSession > 0
        ? moneyLabel(input.settings.budgetUsdPerSession)
        : translateControlCenter(language, 'controlCenterUnlimited'),
      monthlyLabel: input.settings.budgetUsdPerMonth > 0
        ? moneyLabel(input.settings.budgetUsdPerMonth)
        : translateControlCenter(language, 'controlCenterUnlimited'),
      status: budgetExceeded
        ? 'needs-config'
        : input.settings.budgetUsdPerSession > 0 || input.settings.budgetUsdPerMonth > 0
          ? 'available'
          : 'unknown',
      report: budgetReport
    },
    providers: allProviders,
    providerSummary: {
      total: input.providers.length,
      configuredKeys: input.providers.filter((provider) => provider.hasToken).length,
      totalKeys: input.providers.reduce((sum, provider) => sum + providerKeyCount(provider), 0),
      healthy: providerRows.filter((provider) => provider.status === 'available').length,
      missingKeys: input.providers.filter((provider) => !provider.ready).length
    },
    modelRoles: buildModelRoles(input.settings, input.providers, language),
    mcp,
    engines,
    capabilities: buildCapabilities({
      settings: input.settings,
      providerStatus,
      selectedProviderMissing,
      selectedProviderName: defaultProviderName,
      mcp,
      engines,
      language,
      policy
    })
  }
}

function engineDisplayLabel(engine: EngineInfo, language: AppLanguage): string {
  if (engine.kind === 'openai') {
    return translateControlCenter(language, 'controlCenterOpenAiEngine')
  }
  return engine.label
}

function customRulesLabel(
  rules: AppSettings['modelRoutingRules'] | undefined,
  language: AppLanguage
): string {
  const normalized = rules ?? []
  const total = normalized.length
  const enabled = normalized.filter((rule) =>
    rule.enabled && Boolean(
      rule.match.trim() ||
      rule.taskKinds?.length ||
      rule.minRiskLevel ||
      rule.whenStrategy
    )
  ).length
  if (total === 0) return translateControlCenter(language, 'controlCenterCustomRulesDisabled')
  return translateControlCenter(language, 'controlCenterCustomRulesEnabled', { enabled, total })
}

function buildModelRoles(
  settings: AppSettings,
  providers: ProviderView[],
  language: AppLanguage
): ControlCenterModelRole[] {
  return [
    buildModelRole('lowCost', 'controlCenterRoleLowCost', settings.lowCostProviderId, settings.lowCostModel, providers, language),
    buildModelRole('strongReasoning', 'controlCenterRoleStrongReasoning', settings.strongReasoningProviderId, settings.strongReasoningModel, providers, language),
    buildModelRole('review', 'controlCenterRoleReview', settings.reviewProviderId, settings.reviewModel, providers, language),
    buildModelRole('fallback', 'controlCenterRoleFallback', settings.fallbackProviderId, settings.fallbackModel, providers, language)
  ]
}

function buildModelRole(
  key: string,
  labelKey: ControlCenterTranslationKey,
  providerId: string,
  model: string,
  providers: ProviderView[],
  language: AppLanguage
): ControlCenterModelRole {
  const provider = providerId ? providers.find((item) => item.id === providerId) : undefined
  const hasProvider = Boolean(providerId)
  const hasModel = Boolean(model)
  const status: ControlCenterStatus = !hasProvider && !hasModel
    ? 'disabled'
    : hasProvider && !provider
      ? 'needs-config'
      : provider && !provider.ready
        ? 'external-required'
        : provider && hasModel && provider.models.length > 0 && !provider.models.includes(model)
          ? 'needs-config'
          : 'available'
  const providerLabel = hasProvider
    ? (provider?.name ?? `${providerId} ${translateControlCenter(language, 'controlCenterMissingSuffix')}`)
    : translateControlCenter(language, 'controlCenterNoSpecificProvider')
  const modelLabel = hasModel ? model : translateControlCenter(language, 'controlCenterNoSpecificModel')
  const detail = !hasProvider && !hasModel
    ? translateControlCenter(language, 'controlCenterRoleAutomatic')
    : status === 'needs-config'
      ? translateControlCenter(language, 'controlCenterRoleMismatch')
      : status === 'external-required'
        ? translateControlCenter(language, 'controlCenterRoleKeyRequired')
        : translateControlCenter(language, 'controlCenterRolePreference')
  return {
    key,
    label: translateControlCenter(language, labelKey),
    providerLabel,
    modelLabel,
    status,
    detail
  }
}

function buildProviderStatus(
  provider: ProviderView,
  health: ProviderHealthView | undefined,
  selectedProviderId: string,
  language: AppLanguage
): ControlCenterProviderStatus {
  const totalCalls = (health?.successes ?? 0) + (health?.failures ?? 0)
  const successRate = totalCalls > 0 ? Math.round(((health?.successes ?? 0) / totalCalls) * 100) : undefined
  const latency = health?.latencyEmaMs ?? health?.lastLatencyMs
  const latestFailure = health?.recentFailures?.[0]
  const healthLabel = providerHealthLabel(health, successRate, latency, language)
  const missingModels = provider.models.length === 0
  const status: ControlCenterStatus = !provider.ready
    ? 'external-required'
    : health && !health.healthy
      ? 'needs-config'
      : missingModels
        ? 'needs-config'
        : 'available'
  const detail = !provider.ready
    ? translateControlCenter(language, 'controlCenterProviderKeyRequired')
    : health && !health.healthy
      ? latestFailure?.message ?? health.lastError ?? translateControlCenter(language, 'controlCenterProviderHealthFailing')
      : missingModels
        ? translateControlCenter(language, 'controlCenterModelListEmpty')
        : provider.openaiProtocol === 'chat'
          ? translateControlCenter(language, 'controlCenterOpenAiChatProtocol')
          : translateControlCenter(language, 'controlCenterReadyForRouting')

  return {
    id: provider.id,
    name: provider.name,
    endpoint: provider.baseUrl || translateControlCenter(language, 'controlCenterLocalLoginEndpoint'),
    modelCount: provider.models.length,
    keyCount: providerKeyCount(provider),
    activeKeyLabel: provider.activeKeyLabel,
    budgetLabel: provider.budgetUsd > 0
      ? moneyLabel(provider.budgetUsd)
      : translateControlCenter(language, 'controlCenterInheritsGlobalBudget'),
    hasToken: provider.hasToken,
    tokenLabel: providerTokenLabel(provider, language),
    healthLabel,
    successRateLabel: successRate === undefined
      ? translateControlCenter(language, 'controlCenterNoSamples')
      : translateControlCenter(language, 'controlCenterSuccessRate', { rate: successRate }),
    latencyLabel: latency
      ? `${Math.round(latency)}ms EMA`
      : translateControlCenter(language, 'controlCenterNoLatencySample'),
    recentFailures: (health?.recentFailures ?? []).map((failure) => ({
      ...failure,
      label: translateControlCenterFailureLabel(language, failure.label)
    })),
    status,
    detail,
    selected: provider.id === selectedProviderId
  }
}

function providerHealthLabel(
  health: ProviderHealthView | undefined,
  successRate: number | undefined,
  latency: number | undefined,
  language: AppLanguage
): string {
  if (!health) return translateControlCenter(language, 'controlCenterNotProbed')
  const failure = health.recentFailures?.[0]
  const failureSuffix = failure
    ? ` · ${translateControlCenterFailureLabel(language, failure.label)}`
    : ''
  if (health.circuitState === 'open') {
    return `${translateControlCenter(language, 'controlCenterCircuitOpen')}${failureSuffix}`
  }
  if (health.circuitState === 'half_open') {
    return `${translateControlCenter(language, 'controlCenterHalfOpenRecovery')} · ${translateControlCenter(language, 'controlCenterProbeSuccesses', { count: health.halfOpenSuccesses })}`
  }
  if (health.healthy) {
    return `${translateControlCenter(language, 'controlCenterHealthy')} · ${successRate ?? '-'}%${latency ? ` · ${Math.round(latency)}ms EMA` : ''}`
  }
  return `${translateControlCenter(language, 'controlCenterFailing')} · ${translateControlCenter(language, 'controlCenterConsecutiveFailures', { count: health.consecutiveFailures })}${failureSuffix}`
}

function providerTokenLabel(provider: ProviderView, language: AppLanguage): string {
  if (provider.authMode === 'none') {
    return translateControlCenter(language, 'controlCenterLocalNoKeyRequired')
  }
  if (!provider.hasToken) return translateControlCenter(language, 'controlCenterKeyMissing')
  const count = providerKeyCount(provider)
  const countLabel = translateControlCenter(
    language,
    count === 1 ? 'controlCenterOneKey' : 'controlCenterManyKeys',
    { count }
  )
  return `${countLabel}${provider.activeKeyLabel ? ` · ${provider.activeKeyLabel}` : ''}`
}

function providerKeyCount(provider: ProviderView): number {
  return provider.keyCount ?? (provider.hasToken ? 1 : 0)
}

function buildMcpStatus(
  pluginRegistry: PluginRegistryView | undefined,
  mcpProbeResults: Record<string, McpProbeResult>,
  language: AppLanguage
): ControlCenterMcpStatus {
  if (!pluginRegistry) {
    return {
      total: 0,
      enabled: 0,
      probed: 0,
      ok: 0,
      failed: 0,
      status: 'unknown',
      label: translateControlCenter(language, 'controlCenterMcpNotScanned'),
      items: []
    }
  }
  const mcpItems = pluginRegistry.items.filter((item) => item.kind === 'mcp')
  const enabledItems = mcpItems.filter((item) => item.enabled)
  const probed = enabledItems.filter((item) => mcpProbeResults[item.id])
  const ok = probed.filter((item) => mcpProbeResults[item.id]?.ok)
  const failed = probed.filter((item) => mcpProbeResults[item.id] && !mcpProbeResults[item.id].ok)
  const status: ControlCenterStatus =
    mcpItems.length === 0
      ? 'needs-config'
      : enabledItems.length === 0
        ? 'disabled'
        : probed.length === 0
          ? 'unknown'
          : failed.length > 0
            ? 'needs-config'
            : 'available'

  return {
    total: mcpItems.length,
    enabled: enabledItems.length,
    probed: probed.length,
    ok: ok.length,
    failed: failed.length,
    status,
    label:
      mcpItems.length === 0
        ? translateControlCenter(language, 'controlCenterNoMcp')
        : probed.length === 0
          ? translateControlCenter(language, 'controlCenterMcpEnabledNotProbed', {
              enabled: enabledItems.length,
              total: mcpItems.length
            })
          : translateControlCenter(language, 'controlCenterMcpReachable', {
              ok: ok.length,
              probed: probed.length
            }),
    items: mcpItems
      .slice(0, 8)
      .map((item) => buildMcpItemStatus(item, mcpProbeResults[item.id], language))
  }
}

function buildMcpItemStatus(
  item: PluginRegistryItem,
  probe: McpProbeResult | undefined,
  language: AppLanguage
): ControlCenterMcpStatus['items'][number] {
  if (!item.enabled) {
    return {
      id: item.id,
      name: item.name,
      enabled: false,
      status: 'disabled',
      label: translateControlCenter(language, 'controlCenterMcpDisabled')
    }
  }
  if (!probe) {
    return {
      id: item.id,
      name: item.name,
      enabled: true,
      status: 'unknown',
      label: translateControlCenter(language, 'controlCenterNotProbed')
    }
  }
  return {
    id: item.id,
    name: item.name,
    enabled: true,
    status: probe.ok ? 'available' : 'needs-config',
    label: probe.ok
      ? `${probe.transport} · ${probe.latencyMs ?? '?'}ms`
      : probe.error ?? translateControlCenter(language, 'controlCenterMcpProbeFailed')
  }
}

function buildCapabilities(input: {
  settings: AppSettings
  providerStatus: ControlCenterStatus
  selectedProviderMissing: boolean
  selectedProviderName: string
  mcp: ControlCenterMcpStatus
  engines: ControlCenterEngineStatus[]
  language: AppLanguage
  policy: ControlCenterDrivePolicyView
}): ControlCenterCapability[] {
  const availableEngines = input.engines.filter((engine) => engine.status === 'available')
  return [
    {
      title: translateControlCenter(input.language, 'controlCenterCapabilityDrivePolicy'),
      status: 'available',
      detail: `${input.policy.summary} · ${translateControlCenter(input.language, 'controlCenterValidation')}=${input.policy.validationDepthLabel}`
    },
    {
      title: translateControlCenter(input.language, 'controlCenterCapabilityModelRouting'),
      status: input.settings.smartModelRoutingEnabled ? input.providerStatus : 'disabled',
      detail: input.settings.smartModelRoutingEnabled
        ? `${input.selectedProviderName} · ${strategyLabel(input.settings.schedulerStrategy, input.language)}`
        : translateControlCenter(input.language, 'controlCenterRoutingOffDetail')
    },
    {
      title: translateControlCenter(input.language, 'controlCenterCapabilityProviderCredential'),
      status: input.selectedProviderMissing ? 'needs-config' : input.providerStatus,
      detail: input.selectedProviderMissing
        ? translateControlCenter(input.language, 'controlCenterProviderIdMissing')
        : translateControlCenter(input.language, 'controlCenterCredentialState', {
            provider: input.selectedProviderName
          })
    },
    {
      title: translateControlCenter(input.language, 'controlCenterCapabilityMcpTools'),
      status: input.mcp.status,
      detail: input.mcp.label
    },
    {
      title: translateControlCenter(input.language, 'controlCenterCapabilityAgentEngines'),
      status: availableEngines.length > 0 ? 'available' : 'external-required',
      detail: availableEngines.length > 0
        ? availableEngines.map((engine) => engine.label).join(', ')
        : translateControlCenter(input.language, 'controlCenterNoAgentEngineAvailable')
    }
  ]
}

function modelLabel(model: string, language: AppLanguage): string {
  if (model === AUTO_MODEL) return translateControlCenter(language, 'controlCenterAutoRoute')
  if (!model) return translateControlCenter(language, 'controlCenterNoModelPreferenceValue')
  return model
}

function strategyLabel(
  strategy: AppSettings['schedulerStrategy'],
  language: AppLanguage
): string {
  if (strategy === 'quality') {
    return translateControlCenter(language, 'controlCenterStrategyQuality')
  }
  if (strategy === 'cost') return translateControlCenter(language, 'controlCenterStrategyCost')
  if (strategy === 'speed') return translateControlCenter(language, 'controlCenterStrategySpeed')
  return translateControlCenter(language, 'controlCenterStrategyBalanced')
}

const DRIVE_COPY_KEYS: Record<
  CaoGenDrivePolicyView['mode'],
  {
    display: ControlCenterTranslationKey
    summary: ControlCenterTranslationKey
    tools: ControlCenterTranslationKey
  }
> = {
  spark: {
    display: 'controlCenterDriveSpark',
    summary: 'controlCenterDriveSummarySpark',
    tools: 'controlCenterDriveToolsSpark'
  },
  core: {
    display: 'controlCenterDriveCore',
    summary: 'controlCenterDriveSummaryCore',
    tools: 'controlCenterDriveToolsCore'
  },
  forge: {
    display: 'controlCenterDriveForge',
    summary: 'controlCenterDriveSummaryForge',
    tools: 'controlCenterDriveToolsForge'
  },
  command: {
    display: 'controlCenterDriveCommand',
    summary: 'controlCenterDriveSummaryCommand',
    tools: 'controlCenterDriveToolsCommand'
  },
  genesis: {
    display: 'controlCenterDriveGenesis',
    summary: 'controlCenterDriveSummaryGenesis',
    tools: 'controlCenterDriveToolsGenesis'
  }
}

const VALIDATION_COPY_KEYS: Record<CaoGenDriveValidationDepth, ControlCenterTranslationKey> = {
  light: 'controlCenterValidationLight',
  basic: 'controlCenterValidationBasic',
  local: 'controlCenterValidationLocal',
  guarded: 'controlCenterValidationGuarded',
  closedLoop: 'controlCenterValidationClosedLoop'
}

function localizeDrivePolicy(
  policy: CaoGenDrivePolicyView,
  language: AppLanguage
): ControlCenterDrivePolicyView {
  const copyKeys = DRIVE_COPY_KEYS[policy.mode]
  return {
    mode: policy.mode,
    label: policy.label,
    displayLabel: translateControlCenter(language, copyKeys.display),
    summary: translateControlCenter(language, copyKeys.summary),
    schedulerStrategy: policy.schedulerStrategy,
    defaultModel: policy.defaultModel,
    defaultPermissionMode: policy.defaultPermissionMode,
    sessionBudgetUsd: policy.sessionBudgetUsd,
    validationDepth: policy.validationDepth,
    validationDepthLabel: translateControlCenter(language, VALIDATION_COPY_KEYS[policy.validationDepth]),
    smartModelRoutingEnabled: policy.smartModelRoutingEnabled,
    modelCrossValidationAutoRunEnabled: policy.modelCrossValidationAutoRunEnabled,
    toolPolicySummary: translateControlCenter(language, copyKeys.tools)
  }
}

function moneyLabel(value: number): string {
  return `$${value.toFixed(value >= 1 ? 2 : 3)}`
}
