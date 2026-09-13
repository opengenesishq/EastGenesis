import {
  DRIVE_MODE_OPTIONS,
  modelOptionsForProvider,
  STRATEGY_OPTIONS
} from '../store'
import {
  buildControlCenterView,
  type ControlCenterStatus,
  type ControlCenterView
} from '../controlCenter'
import { formatCost } from '../format'
import { translate, type TParams } from '../i18n'
import { AUTO_MODEL } from '../../../shared/types'
import type {
  AppSettings,
  AppLanguage,
  CaoGenDriveMode,
  EngineInfo,
  HistoryEntry,
  McpProbeResult,
  PluginRegistryItem,
  PluginRegistryView,
  ProviderHealthView,
  ProviderView,
  SchedulerStrategy,
  SessionMeta
} from '../../../shared/types'

interface Props {
  settings: AppSettings
  providers: ProviderView[]
  history: HistoryEntry[]
  activeSessions: SessionMeta[]
  health: ProviderHealthView[]
  engines: EngineInfo[]
  pluginRegistry?: PluginRegistryView
  mcpProbeResults: Record<string, McpProbeResult>
  loading: boolean
  mcpProbing: boolean
  error: string
  onRefresh: () => void
  onProbeMcp: (items: PluginRegistryItem[]) => void
  onSettingsPatch: (patch: Partial<AppSettings>) => void
  onAddProvider: () => void
  onEditProvider: (provider: ProviderView) => void
}

type Translate = (key: string, params?: TParams) => string

const DRIVE_OPTION_LABEL_KEYS: Record<CaoGenDriveMode, string> = {
  spark: 'controlCenterDriveSpark',
  core: 'controlCenterDriveCore',
  forge: 'controlCenterDriveForge',
  command: 'controlCenterDriveCommand',
  genesis: 'controlCenterDriveGenesis'
}

const STRATEGY_OPTION_LABEL_KEYS: Record<SchedulerStrategy, string> = {
  balanced: 'controlCenterStrategyBalanced',
  speed: 'controlCenterStrategySpeed',
  quality: 'controlCenterStrategyQuality',
  cost: 'controlCenterStrategyCost'
}

function healthTime(timestamp: number, language: AppLanguage): string {
  return new Date(timestamp).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export default function ControlCenter({
  settings,
  providers,
  history,
  activeSessions,
  health,
  engines,
  pluginRegistry,
  mcpProbeResults,
  loading,
  mcpProbing,
  error,
  onRefresh,
  onProbeMcp,
  onSettingsPatch,
  onAddProvider,
  onEditProvider
}: Props): React.JSX.Element {
  const t: Translate = (key, params) => translate(settings.language, key, params)
  const view = buildControlCenterView({
    settings,
    providers,
    history,
    activeSessions,
    health,
    engines,
    pluginRegistry,
    mcpProbeResults
  })
  const mcpItems = pluginRegistry?.items.filter((item) => item.kind === 'mcp') ?? []
  const budgetExceeded = view.budget.report.monthlyExceeded || view.budget.report.activeSessions.some((session) => session.overBudget)

  const setBudget = (key: 'budgetUsdPerSession' | 'budgetUsdPerMonth', value: string): void => {
    const budget = Number(value)
    onSettingsPatch({ [key]: Number.isFinite(budget) && budget > 0 ? budget : 0 })
  }

  return (
    <div className="control-center">
      <div className="control-center-head">
        <div>
          <h3 className="settings-h3">{t('controlCenterTitle')}</h3>
          <p className="settings-hint">{t('controlCenterSubtitle')}</p>
        </div>
        <div className="control-center-actions">
          <button className="btn btn-ghost btn-sm" disabled={loading} onClick={onRefresh}>
            {loading ? t('controlCenterRefreshing') : t('controlCenterRefresh')}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={mcpProbing || mcpItems.length === 0}
            onClick={() => onProbeMcp(mcpItems)}
          >
            {mcpProbing ? t('controlCenterProbingMcp') : t('controlCenterProbeMcp')}
          </button>
        </div>
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      <ControlSummaryGrid
        settings={settings}
        view={view}
        t={t}
      />

      <section className="control-section">
        <div className="settings-section-head">
          <h3 className="settings-h3">{t('controlCenterDriveAndRouting')}</h3>
          <StatusPill status={settings.smartModelRoutingEnabled ? 'available' : 'disabled'} label={view.route.routeLabel} />
        </div>
        <div className="control-form-grid">
          <label className="field-label">
            {t('controlCenterDrive')}
            <select
              className="select select-block"
              value={settings.driveMode}
              onChange={(event) => onSettingsPatch({ driveMode: event.target.value as CaoGenDriveMode })}
            >
              {DRIVE_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(DRIVE_OPTION_LABEL_KEYS[option.value])}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            {t('controlCenterProviderPreference')}
            <select
              className="select select-block"
              value={settings.defaultProviderId}
              onChange={(event) => {
                const defaultProviderId = event.target.value
                onSettingsPatch({ defaultProviderId, defaultModel: defaultProviderId ? AUTO_MODEL : '' })
              }}
            >
              <option value="">{t('controlCenterNoProviderPreference')}</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            {t('controlCenterModelPreference')}
            <select
              className="select select-block"
              value={settings.defaultModel}
              onChange={(event) => onSettingsPatch({ defaultModel: event.target.value })}
            >
              <option value="">{t('controlCenterNoModelPreference')}</option>
              {modelOptionsForProvider(
                providers,
                settings.defaultProviderId,
                t('controlCenterAutomaticRouting'),
                settings.defaultModel
              ).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            {t('controlCenterSchedulingStrategy')}
            <select
              className="select select-block"
              value={settings.schedulerStrategy}
              onChange={(event) => onSettingsPatch({ schedulerStrategy: event.target.value as SchedulerStrategy })}
            >
              {STRATEGY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(STRATEGY_OPTION_LABEL_KEYS[option.value])}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="control-switch-row">
          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings.smartModelRoutingEnabled}
              onChange={(event) => onSettingsPatch({ smartModelRoutingEnabled: event.target.checked })}
            />
            {t('controlCenterSmartRouting')}
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings.modelCrossValidationAutoRunEnabled}
              disabled={!settings.smartModelRoutingEnabled}
              onChange={(event) => onSettingsPatch({ modelCrossValidationAutoRunEnabled: event.target.checked })}
            />
            {t('controlCenterAutomaticReview')}
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings.failoverEnabled}
              onChange={(event) => onSettingsPatch({ failoverEnabled: event.target.checked })}
            />
            {t('controlCenterFailover')}
          </label>
        </div>
        <div className="control-route-note">
          <span>{view.policy.toolPolicySummary}</span>
          <span>{t('controlCenterValidation')}={view.policy.validationDepthLabel}</span>
          <span>{view.route.crossValidationLabel}</span>
          <span>{view.route.customRulesLabel}</span>
        </div>
        <div className="control-mini-list control-role-list">
          {view.modelRoles.map((role) => (
            <div key={role.key} className="control-mini-row">
              <span>
                {role.label}: {role.providerLabel} / {role.modelLabel}
              </span>
              <StatusPill status={role.status} label={statusLabel(role.status, t)} />
            </div>
          ))}
        </div>
      </section>

      <section className="control-section">
        <div className="settings-section-head">
          <h3 className="settings-h3">{t('controlCenterBudget')}</h3>
          <StatusPill
            status={view.budget.status}
            label={budgetExceeded
              ? t('controlCenterBudgetOver')
              : view.budget.status === 'unknown'
                ? t('controlCenterUnlimited')
                : t('controlCenterBudgetConfigured')}
          />
        </div>
        <div className="control-form-grid">
          <label className="field-label">
            {t('controlCenterSessionBudgetLimit')}
            <input
              className="input input-block"
              type="number"
              min="0"
              step="0.01"
              value={settings.budgetUsdPerSession || ''}
              placeholder={t('controlCenterZeroUnlimited')}
              onChange={(event) => setBudget('budgetUsdPerSession', event.target.value)}
            />
          </label>
          <label className="field-label">
            {t('controlCenterMonthlyBudgetLimit')}
            <input
              className="input input-block"
              type="number"
              min="0"
              step="0.01"
              value={settings.budgetUsdPerMonth || ''}
              placeholder={t('controlCenterZeroUnlimited')}
              onChange={(event) => setBudget('budgetUsdPerMonth', event.target.value)}
            />
          </label>
        </div>
        <div className="control-budget-stats">
          <span>
            {t('controlCenterSpentThisMonth', {
              amount: formatCost(view.budget.report.monthlySpentUsd)
            })}
          </span>
          <span>
            {view.budget.report.monthlyRemainingUsd === undefined
              ? t('controlCenterRemaining', { amount: t('controlCenterUnlimited') })
              : t('controlCenterRemaining', {
                  amount: formatCost(view.budget.report.monthlyRemainingUsd)
                })}
          </span>
          <span>
            {t('controlCenterActiveSessionsCost', {
              amount: formatCost(view.budget.report.activeCostUsd)
            })}
          </span>
          <span>
            {t('controlCenterHistoricalSessionsCost', {
              amount: formatCost(view.budget.report.historicalCostUsd)
            })}
          </span>
        </div>
        {view.budget.report.monthlyRatio !== undefined && (
          <div
            className={`control-budget-progress ${view.budget.report.monthlyExceeded ? 'is-over' : ''}`}
            title={`${Math.round(view.budget.report.monthlyRatio * 100)}%`}
          >
            <span style={{ width: `${Math.max(2, view.budget.report.monthlyRatio * 100)}%` }} />
          </div>
        )}
        <BudgetReportLists report={view.budget.report} t={t} />
      </section>

      <section className="control-section">
        <div className="settings-section-head">
          <h3 className="settings-h3">{t('controlCenterProvidersAndKeys')}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onAddProvider}>
            {t('controlCenterAddProvider')}
          </button>
        </div>
        <div className="control-provider-stats">
          <span>
            {t('controlCenterKeyCount', { count: view.providerSummary.totalKeys })} /{' '}
            {t('controlCenterProviderCount', { count: view.providerSummary.configuredKeys })}
          </span>
          <span>
            {t('controlCenterHealthyCount', {
              healthy: view.providerSummary.healthy,
              total: view.providerSummary.total
            })}
          </span>
          <span>{t('controlCenterMissingKeyCount', { count: view.providerSummary.missingKeys })}</span>
        </div>
        <div className="provider-list">
          {view.providers.map((provider) => {
            const rawProvider = providers.find((item) => item.id === provider.id)
            return (
              <div key={provider.id} className={`provider-row control-provider-row ${provider.selected ? 'control-row-selected' : ''}`}>
                <div className="provider-row-body">
                  <div className="provider-row-name">
                    {provider.name}
                    {provider.selected && (
                      <StatusPill status="available" label={t('controlCenterDefault')} />
                    )}
                    <StatusPill status={provider.status} label={provider.tokenLabel} />
                  </div>
                  <div className="provider-row-sub">
                    {provider.endpoint} · {t('controlCenterModelCount', { count: provider.modelCount })} ·{' '}
                    {provider.healthLabel}
                  </div>
                  <div className="control-provider-health-meta">
                    <span>{provider.successRateLabel}</span>
                    <span>{provider.latencyLabel}</span>
                  </div>
                  <div className="control-row-detail">{provider.detail}</div>
                  {provider.recentFailures.length > 0 && (
                    <details className="control-provider-failures">
                      <summary>
                        {t('controlCenterRecentFailures', { count: provider.recentFailures.length })}
                      </summary>
                      <div className="control-provider-failure-list">
                        {provider.recentFailures.map((failure, index) => (
                          <div key={`${failure.at}:${failure.label}:${index}`} className="control-provider-failure-row">
                            <span>{healthTime(failure.at, settings.language)}</span>
                            <strong>{failure.label}</strong>
                            <span>
                              {failure.switchable
                                ? t('controlCenterCanFailover')
                                : t('controlCenterNeedsLocalAction')}
                            </span>
                            <code>{failure.message}</code>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
                <div className="provider-row-actions">
                  {rawProvider && (
                    <button className="btn btn-ghost btn-sm" onClick={() => onEditProvider(rawProvider)}>
                      {t('controlCenterEdit')}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="control-section">
        <div className="settings-section-head">
          <h3 className="settings-h3">{t('controlCenterMcpAndAgentEngines')}</h3>
          <StatusPill status={view.mcp.status} label={view.mcp.label} />
        </div>
        <div className="control-tool-grid">
          <div>
            <div className="control-subhead">MCP</div>
            {view.mcp.items.length === 0 ? (
              <div className="provider-empty">{t('controlCenterNoMcpDeclarations')}</div>
            ) : (
              <div className="control-mini-list">
                {view.mcp.items.map((item) => (
                  <div key={item.id} className="control-mini-row">
                    <span>{item.name}</span>
                    <StatusPill status={item.status} label={item.label} />
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="control-subhead">{t('controlCenterAgentEngines')}</div>
            <div className="control-mini-list">
              {view.engines.map((engine) => (
                <div key={engine.kind} className="control-mini-row">
                  <span>{engine.label}</span>
                  <StatusPill status={engine.status} label={engine.statusLabel} />
                </div>
              ))}
              {view.engines.length === 0 && (
                <div className="provider-empty">{t('controlCenterNoLocalEngines')}</div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="control-section">
        <h3 className="settings-h3">{t('controlCenterBoundaries')}</h3>
        <div className="control-capability-list">
          {view.capabilities.map((capability) => (
            <div key={capability.title} className="control-capability-row">
              <div>
                <div className="control-capability-title">{capability.title}</div>
                <div className="control-row-detail">{capability.detail}</div>
              </div>
              <StatusPill status={capability.status} label={statusLabel(capability.status, t)} />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function ControlSummaryGrid({
  settings,
  view,
  t
}: {
  settings: AppSettings
  view: ControlCenterView
  t: Translate
}): React.JSX.Element {
  const routingStatus = settings.smartModelRoutingEnabled ? view.route.providerStatus : 'disabled'
  const remaining = view.budget.report.monthlyRemainingUsd
  return (
    <div className="control-summary-grid">
      <SummaryCard
        title={t('controlCenterSummaryDrive')}
        status="available"
        statusText={statusLabel('available', t)}
        value={view.route.driveLabel}
        detail={view.policy.summary}
      />
      <SummaryCard
        title={t('controlCenterSummaryRouting')}
        status={routingStatus}
        statusText={statusLabel(routingStatus, t)}
        value={view.route.routeLabel}
        detail={`${view.route.providerLabel} · ${view.route.modelLabel} · ${view.route.strategyLabel}`}
      />
      <SummaryCard
        title={t('controlCenterSummaryBudget')}
        status={view.budget.status}
        statusText={statusLabel(view.budget.status, t)}
        value={`${formatCost(view.budget.report.monthlySpentUsd)} / ${view.budget.report.monthlyLimitUsd > 0 ? formatCost(view.budget.report.monthlyLimitUsd) : '∞'}`}
        detail={`${view.budget.report.monthKey} · ${remaining === undefined
          ? t('controlCenterUnlimited')
          : t('controlCenterRemaining', { amount: formatCost(remaining) })}`}
      />
      <SummaryCard
        title={t('controlCenterSummaryTools')}
        status={view.mcp.status}
        statusText={statusLabel(view.mcp.status, t)}
        value={view.mcp.label}
        detail={t('controlCenterAgentEnginesReady', {
          ready: view.engines.filter((engine) => engine.status === 'available').length,
          total: view.engines.length
        })}
      />
    </div>
  )
}

function BudgetReportLists({
  report,
  t
}: {
  report: ControlCenterView['budget']['report']
  t: Translate
}): React.JSX.Element {
  return (
    <div className="control-budget-report-grid">
      <div>
        <div className="control-subhead">{t('controlCenterProviderMonthlyCost')}</div>
        <div className="control-budget-list">
          {report.providers.map((provider) => (
            <div key={provider.providerId} className="control-budget-row">
              <span>
                <strong>{provider.providerName}</strong>
                <small>
                  {t('controlCenterSessionCount', { count: provider.sessionCount })} ·{' '}
                  {t('controlCenterActiveCount', { count: provider.activeSessions })}
                  {provider.currentSessionLimitUsd
                    ? ` · ${t('controlCenterSessionCap', {
                        amount: formatCost(provider.currentSessionLimitUsd)
                      })}`
                    : ''}
                </small>
              </span>
              <strong>{formatCost(provider.spentUsd)}</strong>
            </div>
          ))}
          {report.providers.length === 0 && (
            <div className="provider-empty">{t('controlCenterNoMonthlyCost')}</div>
          )}
        </div>
      </div>
      <div>
        <div className="control-subhead">{t('controlCenterTopCostSessions')}</div>
        <div className="control-budget-list">
          {report.topSessions.map((session) => (
            <div key={`${session.active ? 'active' : 'history'}:${session.id}`} className="control-budget-row">
              <span>
                <strong>{session.title}</strong>
                <small>
                  {session.providerName} / {session.model}
                  {session.active
                    ? ` · ${t('controlCenterSessionActive')}`
                    : ` · ${t('controlCenterSessionHistory')}`}
                  {session.sessionLimitUsd
                    ? ` · ${t('controlCenterCap', {
                        amount: formatCost(session.sessionLimitUsd)
                      })}`
                    : ''}
                </small>
              </span>
              <strong className={session.overBudget ? 'control-budget-over' : ''}>
                {formatCost(session.costUsd)}
              </strong>
            </div>
          ))}
          {report.topSessions.length === 0 && (
            <div className="provider-empty">{t('controlCenterNoMonthlySessionCost')}</div>
          )}
        </div>
      </div>
    </div>
  )
}

function SummaryCard({
  title,
  value,
  detail,
  status,
  statusText
}: {
  title: string
  value: string
  detail: string
  status: ControlCenterStatus
  statusText: string
}): React.JSX.Element {
  return (
    <div className="control-summary-card">
      <div className="control-summary-top">
        <span>{title}</span>
        <StatusPill status={status} label={statusText} />
      </div>
      <div className="control-summary-value">{value}</div>
      <div className="control-summary-detail">{detail}</div>
    </div>
  )
}

function StatusPill({ status, label }: { status: ControlCenterStatus; label: string }): React.JSX.Element {
  return <span className={`control-pill control-pill-${status}`}>{label}</span>
}

function statusLabel(status: ControlCenterStatus, t: Translate): string {
  if (status === 'available') return t('controlCenterStatusAvailable')
  if (status === 'needs-config') return t('controlCenterStatusNeedsConfig')
  if (status === 'external-required') return t('controlCenterStatusExternalRequired')
  if (status === 'disabled') return t('controlCenterStatusDisabled')
  return t('controlCenterStatusUnknown')
}
