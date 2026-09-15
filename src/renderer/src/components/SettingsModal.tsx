import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Bell,
  Blocks,
  Clock3,
  Database,
  FolderCog,
  LayoutDashboard,
  Palette,
  Plug,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  X
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { DRIVE_MODE_OPTIONS, modelOptionsForProvider, PERMISSION_OPTIONS, STRATEGY_OPTIONS, useStore } from '../store'
import type { SettingsTab } from '../store/settings-navigation'
import { useT } from '../i18n'
import { AUTO_MODEL } from '../../../shared/types'
import type {
  AppLanguage,
  AppTheme,
  CaoGenDriveMode,
  EngineInfo,
  GuiAutomationGrantView,
  McpProbeResult,
  PermissionRuleConfig,
  PermissionRuleRiskOperator,
  PermissionModeId,
  PluginRegistryItem,
  PluginRegistryView,
  ProviderHealthView,
  ProviderModelFetchError,
  ProviderView,
  SchedulerStrategy,
  SessionMeta,
  TaskStrategy,
  ToolCapabilityGrantView,
  ToolRiskLevel,
  ToolSemanticCapability
} from '../../../shared/types'
import ProviderEditor from './ProviderEditor'
import ControlCenter from './ControlCenterWithWorkflow'
import ProviderList from './settings/ProviderList'
import { useProviderRecoverySettings } from './settings/useProviderRecoverySettings'
import ProjectSettings from '../pages/ProjectSettings'
import MigrationManager from './settings/MigrationManager'
import { requireMcpProbeResults } from '../store/task-recovery-actions'
import NotificationConnectorManager from './settings/NotificationConnectorManager'
import ProviderUsageDashboard from './settings/ProviderUsageDashboard'
import ProviderGatewayPanel from './settings/ProviderGatewayPanel'
import OfficeAppearanceSettings, { DEFAULT_OFFICE_SETTINGS } from './settings/OfficeAppearanceSettings'
import DataRetentionSettings from './settings/DataRetentionSettings'
import RoutingRulesPanel from './settings/RoutingRulesPanel'
type ProviderSettingsSurface = 'configuration' | 'gateway' | 'usage'
type ProviderProbeState = {
  providerId: string
  ok: boolean
  message: string
  error?: ProviderModelFetchError
} | null
const PERMISSION_CAPABILITY_OPTIONS: Array<{ value: ToolSemanticCapability; labelKey: string }> = [
  { value: 'workspaceRead', labelKey: 'permissionCapabilityWorkspaceRead' },
  { value: 'workspaceWrite', labelKey: 'permissionCapabilityWorkspaceWrite' },
  { value: 'terminal', labelKey: 'permissionCapabilityTerminal' },
  { value: 'browser', labelKey: 'permissionCapabilityBrowser' },
  { value: 'network', labelKey: 'permissionCapabilityNetwork' }
]

const PERMISSION_RISK_LEVELS: ToolRiskLevel[] = ['low', 'medium', 'high', 'critical']

const TASK_MODEL_ROLE_OPTIONS = [
  { labelKey: 'modelRoleResearch', providerKey: 'researchProviderId', modelKey: 'researchModel' },
  { labelKey: 'modelRolePlanning', providerKey: 'planningProviderId', modelKey: 'planningModel' },
  { labelKey: 'modelRoleCoding', providerKey: 'codingProviderId', modelKey: 'codingModel' },
  { labelKey: 'modelRoleTesting', providerKey: 'testingProviderId', modelKey: 'testingModel' },
  { labelKey: 'modelRoleDocumentation', providerKey: 'documentationProviderId', modelKey: 'documentationModel' }
] as const

function uniqueModelOptions(
  providers: ProviderView[],
  providerId: string,
  currentModel: string
): Array<{ value: string; label: string }> {
  const seen = new Set<string>()
  const options: Array<{ value: string; label: string }> = []
  const add = (value: string, label = value): void => {
    const clean = value.trim()
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    options.push({ value: clean, label })
  }
  const scopedProviders = providerId ? providers.filter((provider) => provider.id === providerId) : providers
  for (const provider of scopedProviders) {
    for (const model of provider.models) add(model)
  }
  add(currentModel)
  return options
}

function ProviderSettingsSection({ surface, providers, health, providerProbe, checkingProviderId, onSurfaceChange, onAdd, onProbe, onEdit, onRemove }: {
  surface: ProviderSettingsSurface
  providers: ProviderView[]
  health: ProviderHealthView[]
  providerProbe: ProviderProbeState
  checkingProviderId: string
  onSurfaceChange: (surface: ProviderSettingsSurface) => void
  onAdd: () => void
  onProbe: (provider: ProviderView) => void
  onEdit: (provider: ProviderView | 'new') => void
  onRemove: (provider: ProviderView) => void
}): React.JSX.Element {
  const t = useT()
  const surfaces: Array<[ProviderSettingsSurface, string]> = [
    ['configuration', t('providerSettingsConfiguration')],
    ['gateway', t('providerSettingsGateway')],
    ['usage', t('providerSettingsUsage')]
  ]
  return <>
    <nav className="provider-settings-surfaces" aria-label={t('providerSettingsViews')}>
      {surfaces.map(([value, label]) => <button type="button" key={value} className={surface === value ? 'active' : ''} aria-current={surface === value ? 'page' : undefined} data-provider-surface={value} onClick={() => onSurfaceChange(value)}>{label}</button>)}
    </nav>
    {surface === 'configuration' && <ProviderList providers={providers} health={health} providerProbe={providerProbe} checkingProviderId={checkingProviderId} onAdd={onAdd} onProbe={onProbe} onEdit={onEdit} onRemove={onRemove} />}
    {surface === 'usage' && <ProviderUsageDashboard providers={providers} />}
    {surface === 'gateway' && <ProviderGatewayPanel />}
  </>
}

export default function SettingsPage(): React.JSX.Element {
  const t = useT()
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const history = useStore((s) => s.history)
  const sessionOrder = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const updateSettings = useStore((s) => s.updateSettings)
  const updateProvider = useStore((s) => s.updateProvider)
  const deleteProvider = useStore((s) => s.deleteProvider)
  const refreshProviders = useStore((s) => s.refreshProviders)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const { closeEditor, editing, setEditing } = useProviderRecoverySettings(providers)
  const settingsTab = useStore((s) => s.settingsTab)
  const [tab, setTab] = useState<SettingsTab>(() => settingsTab)
  const [settingsSearch, setSettingsSearch] = useState('')
  const [providerSurface, setProviderSurface] = useState<ProviderSettingsSurface>('configuration')
  const tabsRef = useRef<HTMLElement>(null)
  // 本地草稿,保存时统一提交
  const [draft, setDraft] = useState(settings)
  const [health, setHealth] = useState<ProviderHealthView[]>([])
  const [guiGrants, setGuiGrants] = useState<GuiAutomationGrantView[]>([])
  const [toolGrants, setToolGrants] = useState<ToolCapabilityGrantView[]>([])
  const [checkingProviderId, setCheckingProviderId] = useState('')
  const [providerProbe, setProviderProbe] = useState<ProviderProbeState>(null)
  const [engines, setEngines] = useState<EngineInfo[]>([])
  const [pluginRegistry, setPluginRegistry] = useState<PluginRegistryView | undefined>(undefined)
  const [mcpProbeResults, setMcpProbeResults] = useState<Record<string, McpProbeResult>>({})
  const [controlLoading, setControlLoading] = useState(false)
  const [controlMcpProbing, setControlMcpProbing] = useState(false)
  const [controlError, setControlError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const activeSession = useStore((s) => (s.activeId ? s.sessions[s.activeId] : undefined))
  const activeId = useStore((s) => s.activeId)
  const projects = useStore((s) => s.projects)
  const selectedDrive = DRIVE_MODE_OPTIONS.find((option) => option.value === draft.driveMode) ?? DRIVE_MODE_OPTIONS[1]
  const draftOffice = draft.office ?? DEFAULT_OFFICE_SETTINGS
  const activeSessions = useMemo<SessionMeta[]>(
    () => sessionOrder.flatMap((sessionId) => {
      const session = sessions[sessionId]
      return session ? [session.meta] : []
    }),
    [sessionOrder, sessions]
  )
  const permissionGrants = useMemo(
    () => [...guiGrants, ...toolGrants].sort((left, right) => left.expiresAt - right.expiresAt),
    [guiGrants, toolGrants]
  )

  useEffect(() => {
    void window.agentDesk.listProviderHealth().then(setHealth)
  }, [])

  useEffect(() => {
    if (settingsTab) setTab(settingsTab)
  }, [settingsTab])

  useEffect(() => {
    if (tab === 'control') void refreshControlCenter()
  }, [tab, activeId])

  useEffect(() => {
    if (tab === 'permissions') {
      void Promise.all([
        window.agentDesk.listGuiAutomationGrants(),
        window.agentDesk.listToolCapabilityGrants()
      ]).then(([gui, tools]) => {
        setGuiGrants(gui)
        setToolGrants(tools)
      })
    }
  }, [tab])

  useEffect(() => {
    tabsRef.current
      ?.querySelector<HTMLElement>(`[data-settings-tab="${tab}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [tab])

  const set = <K extends keyof typeof draft>(key: K, val: (typeof draft)[K]): void =>
    setDraft((d) => ({ ...d, [key]: val }))
  const patchDraft = (patch: Partial<typeof draft>): void =>
    setDraft((d) => ({ ...d, ...patch }))
  const setBudget = (value: string): void => {
    const budget = Number(value)
    set('budgetUsdPerSession', Number.isFinite(budget) && budget > 0 ? budget : 0)
  }
  const setMonthlyBudget = (value: string): void => {
    const budget = Number(value)
    set('budgetUsdPerMonth', Number.isFinite(budget) && budget > 0 ? budget : 0)
  }
  const setOffice = (patch: Partial<typeof draftOffice>): void =>
    setDraft((d) => ({ ...d, office: { ...(d.office ?? DEFAULT_OFFICE_SETTINGS), ...patch } }))
  const setLayout = (patch: Partial<typeof draft.layout>): void =>
    setDraft((d) => ({ ...d, layout: { ...d.layout, ...patch } }))
  const setProviderCircuitBreaker = (patch: Partial<typeof draft.providerCircuitBreaker>): void =>
    setDraft((d) => ({
      ...d,
      providerCircuitBreaker: { ...d.providerCircuitBreaker, ...patch }
    }))
  const setRoutingExpertPolicy = (patch: Partial<typeof draft.routingExpertPolicy>): void =>
    setDraft((d) => ({
      ...d,
      routingExpertPolicy: { ...d.routingExpertPolicy, ...patch }
    }))
  const setRoutingProviderAllowed = (providerId: string, allowed: boolean): void => {
    setDraft((d) => {
      const allIds = providers.map((provider) => provider.id)
      const current = d.routingExpertPolicy.allowedProviderIds
      const effective = current.length === 0 ? allIds : current
      const next = allowed
        ? [...new Set([...effective, providerId])]
        : effective.filter((id) => id !== providerId)
      return {
        ...d,
        routingExpertPolicy: {
          ...d.routingExpertPolicy,
          allowedProviderIds: next.length === allIds.length ? [] : next
        }
      }
    })
  }
  const updatePermissionRule = (id: string, patch: Partial<PermissionRuleConfig>): void =>
    setDraft((d) => ({
      ...d,
      permissionRules: d.permissionRules.map((rule) => rule.id === id ? { ...rule, ...patch } : rule)
    }))
  const addPermissionRule = (): void =>
    setDraft((d) => ({ ...d, permissionRules: [...d.permissionRules, createPermissionRule()] }))
  const deletePermissionRule = (id: string): void =>
    setDraft((d) => ({
      ...d,
      permissionRules: d.permissionRules.filter((rule) => rule.id !== id)
    }))

  const closeSettings = (): void => {
    void refreshProviders().catch(() => undefined)
    setShowSettings(false)
  }

  const save = async (): Promise<void> => {
    if (draft.permissionRules.some((rule) =>
      !rule.toolPattern.trim() && !rule.pathPattern.trim() && !rule.commandPattern.trim() &&
      !rule.networkHostPattern.trim() && !rule.guiApplicationPattern.trim() &&
      !rule.guiWindowPattern.trim() && !rule.mcpToolPattern.trim() &&
      !rule.mcpArgumentPointer.trim() && !rule.mcpArgumentPattern.trim() &&
      !rule.requirePostcondition && !rule.riskLevel
    )) {
      setSaveError(t('permissionRuleMissingSelector'))
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      // Routing rules have their own versioned CAS editor. Do not include the
      // legacy field in ordinary settings writes: once V1 is active, the main
      // process intentionally rejects that domain on this path.
      const { modelRoutingRules: _legacyRoutingRules, ...ordinaryDraft } = draft
      await updateSettings(ordinaryDraft)
      await refreshProviders()
      setShowSettings(false)
    } catch (error) {
      setSaveError(error instanceof Error && error.message ? error.message : t('settingsSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const refreshControlCenter = async (): Promise<void> => {
    setControlLoading(true)
    setControlError('')
    try {
      await refreshProviders()
      const [nextHealth, nextEngines, nextPluginRegistry] = await Promise.all([
        window.agentDesk.listProviderHealth(),
        window.agentDesk.listEngines(),
        window.agentDesk.scanPluginRegistry(activeId ?? undefined)
      ])
      setHealth(nextHealth)
      setEngines(nextEngines)
      setPluginRegistry(nextPluginRegistry)
    } catch (err) {
      setControlError(err instanceof Error ? err.message : String(err))
    } finally {
      setControlLoading(false)
    }
  }

  const probeControlMcp = async (items: PluginRegistryItem[]): Promise<void> => {
    setControlMcpProbing(true)
    setControlError('')
    try {
      const results = await requireMcpProbeResults(await window.agentDesk.probeMcpServers(items, activeId ?? undefined), () => useStore.getState().refreshTaskSnapshots())
      setMcpProbeResults((prev) => {
        const merged = { ...prev }
        for (const result of results) merged[result.id] = result
        return merged
      })
    } catch (err) {
      setControlError(err instanceof Error ? err.message : String(err))
    } finally {
      setControlMcpProbing(false)
    }
  }

  const remove = async (p: ProviderView): Promise<void> => {
    await deleteProvider(p.id)
  }

  const openProviderEditor = (target: ProviderView | 'new'): void => {
    setTab('providers')
    setEditing(target)
  }

  const probeProvider = async (p: ProviderView): Promise<void> => {
    setCheckingProviderId(p.id)
    setProviderProbe(null)
    try {
      const result = await window.agentDesk.fetchProviderModels({
        baseUrl: p.baseUrl,
        providerId: p.id,
        engine: p.engine,
        openaiProtocol: p.openaiProtocol
      })
      if (result.ok) {
        await updateProvider(p.id, { models: result.models })
        const nextHealth = await window.agentDesk.listProviderHealth()
        setHealth(nextHealth)
        setProviderProbe({
          providerId: p.id,
          ok: true,
          message: t('providerProbeOk', {
            n: result.models.length,
            latencyMs: result.latencyMs ?? 0
          })
        })
      } else {
        const nextHealth = await window.agentDesk.listProviderHealth()
        setHealth(nextHealth)
        setProviderProbe({
          providerId: p.id,
          ok: false,
          message: t('providerProbeFailed', { message: result.error?.message ?? t('fetchModelsFailed') }),
          error: result.error
        })
      }
    } catch (err) {
      const nextHealth = await window.agentDesk.listProviderHealth().catch(() => health)
      setHealth(nextHealth)
      setProviderProbe({
        providerId: p.id,
        ok: false,
        message: t('providerProbeFailed', { message: err instanceof Error ? err.message : String(err) })
      })
    } finally {
      setCheckingProviderId('')
    }
  }

  const TABS: Array<{ id: SettingsTab; label: string; icon: LucideIcon }> = [
    { id: 'control', label: t('tabControlCenter'), icon: LayoutDashboard },
    { id: 'routing', label: '智能路由', icon: Sparkles },
    { id: 'general', label: t('tabGeneral'), icon: Settings2 },
    { id: 'permissions', label: t('tabPermissions'), icon: ShieldCheck },
    { id: 'project', label: t('tabProject'), icon: FolderCog },
    { id: 'persona', label: t('tabPersona'), icon: Sparkles },
    { id: 'office', label: t('tabOffice'), icon: Palette },
    { id: 'providers', label: t('tabProviders'), icon: Plug },
    { id: 'notifications', label: t('tabNotifications'), icon: Bell },
    { id: 'plugins', label: t('tabPlugins'), icon: Blocks },
    { id: 'data', label: t('tabDataRetention'), icon: Clock3 },
    { id: 'migrate', label: t('tabMigrate'), icon: Database }
  ]
  const TAB_GROUPS: Array<{ label: string; ids: SettingsTab[] }> = [
    { label: t('settingsGroupWorkspace'), ids: ['control', 'routing', 'general', 'permissions', 'project'] },
    { label: t('settingsGroupPersonalization'), ids: ['persona', 'office'] },
    { label: t('settingsGroupIntegrations'), ids: ['providers', 'notifications', 'plugins'] },
    { label: t('settingsGroupData'), ids: ['data', 'migrate'] }
  ]
  const searchTerm = settingsSearch.trim().toLocaleLowerCase()
  const searchTerms: Partial<Record<SettingsTab, string>> = {
    control: 'model routing provider health usage control center',
    routing: 'versioned routing rules provider model preview fallback budget business line',
    general: 'language theme startup layout',
    permissions: 'permission access terminal browser workspace',
    project: 'project rules workspace',
    persona: 'instructions prompt persona',
    office: 'appearance control room animation',
    providers: 'provider model api key oauth pricing billing usage balance',
    notifications: 'notification message webhook',
    plugins: 'plugin skill mcp',
    data: 'retention legal hold purge delete privacy data lifecycle',
    migrate: 'migration import export data'
  }
  const tabMatches = (item: { id: SettingsTab; label: string }): boolean =>
    !searchTerm || `${item.label} ${searchTerms[item.id] ?? ''}`.toLocaleLowerCase().includes(searchTerm)

  return (
    <section className="settings-page" aria-label={t('settingsTitle')}>
      <header className="settings-page-header drag-region">
        <button
          type="button"
          className="settings-page-back no-drag"
          aria-label={t('backToWorkspace')}
          title={t('backToWorkspace')}
          onClick={closeSettings}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <h1 className="settings-page-title">{t('settingsTitle')}</h1>
      </header>

      <div className="settings-body">
          <nav ref={tabsRef} className="settings-tabs" aria-label={t('settingsNavigation')}>
            <div className="settings-search">
              <Search size={14} aria-hidden="true" />
              <input
                className="settings-search-input"
                aria-label={t('settingsSearchPlaceholder')}
                placeholder={t('settingsSearchPlaceholder')}
                value={settingsSearch}
                onChange={(event) => setSettingsSearch(event.target.value)}
              />
              {settingsSearch && (
                <button
                  type="button"
                  className="settings-search-clear"
                  aria-label={t('clearSearch')}
                  title={t('clearSearch')}
                  onClick={() => setSettingsSearch('')}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </div>
            {TAB_GROUPS.map((group) => {
              const items = TABS.filter((item) => group.ids.includes(item.id) && tabMatches(item))
              if (items.length === 0) return null
              return (
                <div className="settings-tab-group" key={group.label}>
                  <span className="settings-tab-group-label">{group.label}</span>
                  {items.map((tb) => (
                    <button
                      type="button"
                      key={tb.id}
                      data-settings-tab={tb.id}
                      className={`settings-tab ${tab === tb.id ? 'active' : ''}`}
                      aria-current={tab === tb.id ? 'page' : undefined}
                      onClick={() => {
                        setEditing(null)
                        setTab(tb.id)
                      }}
                    >
                      <tb.icon size={14} aria-hidden="true" />
                      <span>{tb.label}</span>
                    </button>
                  ))}
                </div>
              )
            })}
            {TABS.every((item) => !tabMatches(item)) && <div className="settings-search-empty">{t('settingsSearchEmpty')}</div>}
          </nav>

          <main className="settings-pane">
            <div className="settings-pane-content">
            {editing ? (
              <ProviderEditor
                provider={editing === 'new' ? null : editing}
                initialDiagnostic={editing !== 'new' && providerProbe?.providerId === editing.id
                  ? providerProbe.error
                  : undefined}
                onClose={closeEditor}
              />
            ) : (
              <>
            {tab === 'control' && (
              <ControlCenter
                settings={draft}
                providers={providers}
                history={history}
                activeSessions={activeSessions}
                health={health}
                engines={engines}
                pluginRegistry={pluginRegistry}
                mcpProbeResults={mcpProbeResults}
                loading={controlLoading}
                mcpProbing={controlMcpProbing}
                error={controlError}
                onRefresh={() => void refreshControlCenter()}
                onProbeMcp={(items) => void probeControlMcp(items)}
                onSettingsPatch={patchDraft}
                onAddProvider={() => openProviderEditor('new')}
                onEditProvider={(provider) => openProviderEditor(provider)}
              />
            )}

            {tab === 'routing' && <RoutingRulesPanel />}

            {tab === 'general' && (
              <>
                <label className="field-label">{t('language')}</label>
                <select
                  className="select select-block"
                  value={draft.language}
                  onChange={(e) => set('language', e.target.value as AppLanguage)}
                >
                  <option value="zh">简体中文</option>
                  <option value="en">English</option>
                </select>

                <label className="field-label">{t('theme')}</label>
                <select
                  className="select select-block"
                  value={draft.theme}
                  onChange={(e) => {
                    const v = e.target.value as AppTheme
                    set('theme', v)
                    setSaveError('')
                    void updateSettings({ theme: v }).catch(() => setSaveError(t('settingsSaveFailed')))
                  }}
                >
                  <option value="light">{t('themeLight')}</option>
                  <option value="dark">{t('themeDark')}</option>
                  <option value="system">{t('themeSystem')}</option>
                </select>

                <label className="field-label">{t('driveMode')}</label>
                <select
                  className="select select-block"
                  value={draft.driveMode}
                  onChange={(e) => set('driveMode', e.target.value as CaoGenDriveMode)}
                >
                  {DRIVE_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="settings-hint">
                  {selectedDrive.summary} · ${selectedDrive.budgetUsd}/session · {selectedDrive.toolPolicySummary}
                </p>
                <p className="settings-hint">{t('driveModeOrthogonalHint')}</p>

                <label className="field-label">{t('defaultTaskStrategy')}</label>
                <select
                  className="select select-block"
                  value={draft.defaultTaskStrategy}
                  onChange={(event) => set('defaultTaskStrategy', event.target.value as TaskStrategy)}
                >
                  <option value="view">{t('taskStrategyView')}</option>
                  <option value="plan">{t('taskStrategyPlan')}</option>
                  <option value="execute">{t('taskStrategyExecute')}</option>
                </select>
                <p className="settings-hint">{t('defaultTaskStrategyHint')}</p>

                <label className="field-label">{t('defaultProvider')}</label>
                <select
                  className="select select-block"
                  value={draft.defaultProviderId}
                  onChange={(e) => {
                    const defaultProviderId = e.target.value
                    patchDraft({ defaultProviderId, defaultModel: defaultProviderId ? AUTO_MODEL : '' })
                  }}
                >
                  <option value="">{t('noDefaultProvider')}</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>

                <label className="field-label">{t('defaultModel')}</label>
                <select
                  className="select select-block"
                  value={draft.defaultModel}
                  onChange={(e) => set('defaultModel', e.target.value)}
                >
                  <option value="">{t('noDefaultModel')}</option>
                  {modelOptionsForProvider(
                    providers,
                    draft.defaultProviderId,
                    t('autoRoute'),
                    draft.defaultModel
                  ).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <div className="settings-section">
                  <div className="settings-section-head">
                    <h3 className="settings-h3">{t('modelRolesSection')}</h3>
                  </div>
                  <p className="settings-hint">{t('modelRolesHint')}</p>
                  <div className="model-task-role-list">
                    {TASK_MODEL_ROLE_OPTIONS.map((role) => {
                      const providerId = draft[role.providerKey]
                      const model = draft[role.modelKey]
                      return (
                        <div key={role.providerKey} className="settings-grid-2 model-task-role-row">
                          <label className="field-label">
                            {t(role.labelKey)} · {t('modelRoleProvider')}
                            <select
                              className="select select-block"
                              value={providerId}
                              onChange={(e) =>
                                patchDraft({
                                  [role.providerKey]: e.target.value,
                                  [role.modelKey]: ''
                                })
                              }
                            >
                              <option value="">{t('noRoleProvider')}</option>
                              {providers.map((provider) => (
                                <option key={provider.id} value={provider.id}>
                                  {provider.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="field-label">
                            {t(role.labelKey)} · {t('modelRoleModel')}
                            <select
                              className="select select-block"
                              value={model}
                              onChange={(e) => patchDraft({ [role.modelKey]: e.target.value })}
                            >
                              <option value="">{t('noRoleModel')}</option>
                              {uniqueModelOptions(providers, providerId, model).map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                      )
                    })}
                  </div>
                  <h4 className="settings-h4 model-role-advanced-title">{t('modelRolesAdvanced')}</h4>
                  <div className="settings-grid-2">
                    <label className="field-label">
                      {t('modelRoleLowCost')} · {t('modelRoleProvider')}
                      <select
                        className="select select-block"
                        value={draft.lowCostProviderId}
                        onChange={(e) => patchDraft({ lowCostProviderId: e.target.value })}
                      >
                        <option value="">{t('noRoleProvider')}</option>
                        {providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-label">
                      {t('modelRoleLowCost')} · {t('modelRoleModel')}
                      <select
                        className="select select-block"
                        value={draft.lowCostModel}
                        onChange={(e) => patchDraft({ lowCostModel: e.target.value })}
                      >
                        <option value="">{t('noRoleModel')}</option>
                        {uniqueModelOptions(providers, draft.lowCostProviderId, draft.lowCostModel).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="settings-grid-2">
                    <label className="field-label">
                      {t('modelRoleStrongReasoning')} · {t('modelRoleProvider')}
                      <select
                        className="select select-block"
                        value={draft.strongReasoningProviderId}
                        onChange={(e) => patchDraft({ strongReasoningProviderId: e.target.value })}
                      >
                        <option value="">{t('noRoleProvider')}</option>
                        {providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-label">
                      {t('modelRoleStrongReasoning')} · {t('modelRoleModel')}
                      <select
                        className="select select-block"
                        value={draft.strongReasoningModel}
                        onChange={(e) => patchDraft({ strongReasoningModel: e.target.value })}
                      >
                        <option value="">{t('noRoleModel')}</option>
                        {uniqueModelOptions(providers, draft.strongReasoningProviderId, draft.strongReasoningModel).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="settings-grid-2">
                    <label className="field-label">
                      {t('modelRoleReview')} · {t('modelRoleProvider')}
                      <select
                        className="select select-block"
                        value={draft.reviewProviderId}
                        onChange={(e) => patchDraft({ reviewProviderId: e.target.value })}
                      >
                        <option value="">{t('noRoleProvider')}</option>
                        {providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-label">
                      {t('modelRoleReview')} · {t('modelRoleModel')}
                      <select
                        className="select select-block"
                        value={draft.reviewModel}
                        onChange={(e) => patchDraft({ reviewModel: e.target.value })}
                      >
                        <option value="">{t('noRoleModel')}</option>
                        {uniqueModelOptions(providers, draft.reviewProviderId, draft.reviewModel).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="settings-grid-2">
                    <label className="field-label">
                      {t('modelRoleFallback')} · {t('modelRoleProvider')}
                      <select
                        className="select select-block"
                        value={draft.fallbackProviderId}
                        onChange={(e) => patchDraft({ fallbackProviderId: e.target.value })}
                      >
                        <option value="">{t('noRoleProvider')}</option>
                        {providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-label">
                      {t('modelRoleFallback')} · {t('modelRoleModel')}
                      <select
                        className="select select-block"
                        value={draft.fallbackModel}
                        onChange={(e) => patchDraft({ fallbackModel: e.target.value })}
                      >
                        <option value="">{t('noRoleModel')}</option>
                        {uniqueModelOptions(providers, draft.fallbackProviderId, draft.fallbackModel).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>

                <div className="settings-section" data-routing-legacy-notice>
                  <div className="settings-section-head">
                    <h3 className="settings-h3">{t('customRoutingRules')}</h3>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTab('routing')}>
                      {t('openRoutingRules')}
                    </button>
                  </div>
                  <p className="settings-hint">{t('routingRulesManagedInRoutingTab')}</p>
                </div>

                <label className="field-label">{t('schedulerStrategy')}</label>
                <select
                  className="select select-block"
                  value={draft.schedulerStrategy}
                  onChange={(e) => set('schedulerStrategy', e.target.value as SchedulerStrategy)}
                >
                  {STRATEGY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <fieldset className="routing-rule-task-field">
                  <legend>{t('routingExpertPolicy')}</legend>
                  <div className="settings-grid-2">
                    <label className="field-label">
                      {t('routingLocality')}
                      <select
                        className="select select-block"
                        value={draft.routingExpertPolicy.locality}
                        onChange={(event) => setRoutingExpertPolicy({
                          locality: event.target.value === 'prefer_local' || event.target.value === 'local_only'
                            ? event.target.value
                            : 'any'
                        })}
                      >
                        <option value="any">{t('routingLocalityAny')}</option>
                        <option value="prefer_local">{t('routingLocalityPreferLocal')}</option>
                        <option value="local_only">{t('routingLocalityLocalOnly')}</option>
                      </select>
                    </label>
                    <div className="field-label">
                      <span>{t('routingAllowedProviders')}</span>
                      {providers.length === 0 ? (
                        <small>{t('routingAllowedProvidersAll')}</small>
                      ) : (
                        <div className="routing-rule-task-grid">
                          {providers.map((provider) => (
                            <label key={provider.id} className="routing-rule-task-option">
                              <input
                                type="checkbox"
                                checked={draft.routingExpertPolicy.allowedProviderIds.length === 0
                                  || draft.routingExpertPolicy.allowedProviderIds.includes(provider.id)}
                                onChange={(event) => setRoutingProviderAllowed(provider.id, event.target.checked)}
                              />
                              <span>{provider.name}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </fieldset>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.smartModelRoutingEnabled}
                    onChange={(e) => set('smartModelRoutingEnabled', e.target.checked)}
                  />
                  P2-003 多模型智能混合调度
                </label>
                <p className="settings-hint">默认关闭。开启后仅 auto 会话会按任务类型、预算和手动覆盖选择 Provider/Model，并为关键代码任务生成复核计划。</p>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.modelCrossValidationAutoRunEnabled}
                    disabled={!draft.smartModelRoutingEnabled}
                    onChange={(e) => set('modelCrossValidationAutoRunEnabled', e.target.checked)}
                  />
                  P2-003 自动第二模型 Code Review
                </label>
                <p className="settings-hint">
                  默认关闭。仅在智能调度生成复核计划后启动 plan 权限子会话，不直接修改文件。
                </p>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.failoverEnabled}
                    onChange={(e) => set('failoverEnabled', e.target.checked)}
                  />
                  {t('failoverEnabled')}
                </label>
                <p className="settings-hint">{t('failoverHint')}</p>
                <details className="settings-section">
                  <summary className="settings-h3">{t('providerCircuitSettings')}</summary>
                  <div className="settings-grid-2">
                    <label className="field-label">
                      {t('providerCircuitFailureThreshold')}
                      <input
                        className="input input-block"
                        type="number"
                        min={1}
                        max={20}
                        disabled={!draft.failoverEnabled}
                        value={draft.providerCircuitBreaker.failureThreshold}
                        onChange={(e) => setProviderCircuitBreaker({ failureThreshold: Number(e.target.value) })}
                      />
                    </label>
                    <label className="field-label">
                      {t('providerCircuitSuccessThreshold')}
                      <input
                        className="input input-block"
                        type="number"
                        min={1}
                        max={10}
                        disabled={!draft.failoverEnabled}
                        value={draft.providerCircuitBreaker.successThreshold}
                        onChange={(e) => setProviderCircuitBreaker({ successThreshold: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                  <div className="settings-grid-2">
                    <label className="field-label">
                      {t('providerCircuitTimeout')}
                      <input
                        className="input input-block"
                        type="number"
                        min={0}
                        max={300}
                        disabled={!draft.failoverEnabled}
                        value={draft.providerCircuitBreaker.timeoutSeconds}
                        onChange={(e) => setProviderCircuitBreaker({ timeoutSeconds: Number(e.target.value) })}
                      />
                    </label>
                    <label className="field-label">
                      {t('providerCircuitErrorRate')}
                      <input
                        className="input input-block"
                        type="number"
                        min={1}
                        max={100}
                        disabled={!draft.failoverEnabled}
                        value={Math.round(draft.providerCircuitBreaker.errorRateThreshold * 100)}
                        onChange={(e) => setProviderCircuitBreaker({ errorRateThreshold: Number(e.target.value) / 100 })}
                      />
                    </label>
                  </div>
                  <label className="field-label">
                    {t('providerCircuitMinRequests')}
                    <input
                      className="input input-block"
                      type="number"
                      min={1}
                      max={100}
                      disabled={!draft.failoverEnabled}
                      value={draft.providerCircuitBreaker.minRequests}
                      onChange={(e) => setProviderCircuitBreaker({ minRequests: Number(e.target.value) })}
                    />
                  </label>
                </details>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.notificationsEnabled}
                    onChange={(e) => set('notificationsEnabled', e.target.checked)}
                  />
                  {t('notificationsEnabled')}
                </label>
                <p className="settings-hint">{t('notificationsHint')}</p>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.chinaEcosystemMirrorEnabled}
                    onChange={(e) => set('chinaEcosystemMirrorEnabled', e.target.checked)}
                  />
                  {t('chinaMirrorEnabled')}
                </label>
                <p className="settings-hint">{t('chinaMirrorHint')}</p>
                <div className="settings-grid-2">
                  <label className="field-label">
                    {t('chinaNpmRegistry')}
                    <input
                      className="input input-block"
                      value={draft.chinaNpmRegistry}
                      disabled={!draft.chinaEcosystemMirrorEnabled}
                      placeholder="https://registry.npmmirror.com"
                      onChange={(e) => set('chinaNpmRegistry', e.target.value)}
                    />
                  </label>
                  <label className="field-label">
                    {t('chinaPipIndexUrl')}
                    <input
                      className="input input-block"
                      value={draft.chinaPipIndexUrl}
                      disabled={!draft.chinaEcosystemMirrorEnabled}
                      placeholder="https://pypi.tuna.tsinghua.edu.cn/simple"
                      onChange={(e) => set('chinaPipIndexUrl', e.target.value)}
                    />
                  </label>
                </div>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.preventDisplaySleep}
                    onChange={(e) => set('preventDisplaySleep', e.target.checked)}
                  />
                  {t('preventDisplaySleep')}
                </label>
                <p className="settings-hint">{t('preventDisplaySleepHint')}</p>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.autoSkillLearningEnabled}
                    onChange={(e) => set('autoSkillLearningEnabled', e.target.checked)}
                  />
                  P2-002 自动 Skill 沉淀与调用
                </label>
                <p className="settings-hint">
                  默认关闭。开启后成功任务会后台复盘并验证 Skill，下次同类任务会注入匹配 Skill。
                </p>

                <label className="field-label">单会话预算上限 ($)</label>
                <input
                  className="input input-block"
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.budgetUsdPerSession || ''}
                  placeholder="0 = 不限制"
                  onChange={(e) => setBudget(e.target.value)}
                />
                <p className="settings-hint">达到预算后会拦截下一轮发送；0 表示不限制。</p>

                <label className="field-label">月度预算上限($)</label>
                <input
                  className="input input-block"
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.budgetUsdPerMonth || ''}
                  placeholder="0 = 不限制"
                  onChange={(e) => setMonthlyBudget(e.target.value)}
                />
                <p className="settings-hint">按当前自然月统计历史会话费用；达到上限后会拦截下一轮发送，auto 调度会优先降级到低成本模型。</p>

              </>
            )}

            {tab === 'permissions' && (
              <>
                <label className="field-label">{t('defaultPermMode')}</label>
                <select
                  className="select select-block"
                  value={draft.defaultPermissionMode}
                  onChange={(e) => set('defaultPermissionMode', e.target.value as PermissionModeId)}
                >
                  {PERMISSION_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <label className="field-label">{t('localExecutionLabel')}</label>
                {draft.sandboxMode === 'disabled' ? (
                  <div className="notice notice-error">
                    <p>{t('legacyDockerMigrationWarning')}</p>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => set('sandboxMode', 'restrictedLocal')}
                    >
                      {t('enableLocalExecution')}
                    </button>
                  </div>
                ) : (
                  <p className="settings-hint">{t('localExecutionHint')}</p>
                )}

                <div className="settings-section permission-rule-section">
                  <div className="settings-section-head">
                    <h3 className="settings-h3">{t('permissionRulesTitle')}</h3>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={addPermissionRule}>
                      {t('permissionRuleAdd')}
                    </button>
                  </div>
                  <p className="settings-hint">{t('permissionRulesHint')}</p>
                  <label className="settings-check">
                    <input type="checkbox" checked={draft.limitedFileExecutionEnabled} onChange={(event) => set('limitedFileExecutionEnabled', event.target.checked)} data-limited-file-execution />
                    限定文件执行
                  </label>
                  <p className="settings-hint">开启后，正式目录仅允许下面同时指定工具和路径的有效允许规则，支持文本编辑及 Office 文件生成和修订。保存后，停用、删除或到期的规则会阻止后续写入。准备区继续使用单独授权；命令、桌面、连接器和委派操作不可用。此设置适用于所有任务；相对路径以各任务目录为准，限定项目请填写绝对路径。</p>
                  <p className="settings-hint">例如：允许工具 write_file，路径 reports/**，能力勾选“工作区写入”。Office 修订输出位于 artifacts/**，需同时勾选工作区读取与写入。关闭时沿用原执行权限，不代表授予新的动作审批。</p>
                  {draft.permissionRules.length === 0 ? (
                    <div className="permission-rule-empty">{t('permissionRulesEmpty')}</div>
                  ) : (
                    <div className="permission-rule-list">
                      {draft.permissionRules.map((rule) => {
                        const missingSelector = !rule.toolPattern.trim() &&
                          !rule.pathPattern.trim() && !rule.commandPattern.trim() &&
                          !rule.networkHostPattern.trim() && !rule.guiApplicationPattern.trim() &&
                          !rule.guiWindowPattern.trim() && !rule.mcpToolPattern.trim() &&
                          !rule.mcpArgumentPointer.trim() && !rule.mcpArgumentPattern.trim() &&
                          rule.capabilityScope.length === 0 && !rule.requirePostcondition && !rule.riskLevel
                        return (
                          <div key={rule.id} className="permission-rule-card" data-permission-rule-id={rule.id}>
                            <div className="permission-rule-head">
                              <label className="settings-check permission-rule-toggle">
                                <input
                                  type="checkbox"
                                  checked={rule.enabled}
                                  onChange={(event) => updatePermissionRule(rule.id, { enabled: event.target.checked })}
                                />
                                {t('permissionRuleEnabled')}
                              </label>
                              <select
                                className={`select permission-rule-effect ${rule.effect}`}
                                value={rule.effect}
                                aria-label={t('permissionRuleEffect')}
                                onChange={(event) => updatePermissionRule(rule.id, {
                                  effect: event.target.value === 'allow' ? 'allow' : 'deny'
                                })}
                              >
                                <option value="deny">{t('permissionRuleDeny')}</option>
                                <option value="allow">{t('permissionRuleAllow')}</option>
                              </select>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm permission-rule-delete"
                                title={t('permissionRuleDelete')}
                                aria-label={t('permissionRuleDelete')}
                                onClick={() => deletePermissionRule(rule.id)}
                              >
                                ×
                              </button>
                            </div>
                            <div className="settings-grid-2 permission-rule-targets">
                              <label className="field-label">
                                {t('permissionRuleTool')}
                                <input
                                  className="input input-block"
                                  value={rule.toolPattern}
                                  placeholder="write_file / gui_*"
                                  onChange={(event) => updatePermissionRule(rule.id, {
                                    toolPattern: event.target.value
                                  })}
                                />
                              </label>
                              <label className="field-label">
                                {t('permissionRulePath')}
                                <input
                                  className="input input-block"
                                  value={rule.pathPattern}
                                  placeholder="src/**"
                                  onChange={(event) => updatePermissionRule(rule.id, {
                                    pathPattern: event.target.value
                                  })}
                                />
                              </label>
                            </div>
                            <details className="permission-rule-semantics">
                              <summary>{t('permissionRuleSemanticScope')}</summary>
                              <div className="permission-rule-capability-scope">
                                <div className="field-label">{t('permissionRuleCapabilities')}</div>
                                <div className="permission-rule-capability-grid">
                                  {PERMISSION_CAPABILITY_OPTIONS.map((option) => (
                                    <label key={option.value} className="settings-check">
                                      <input
                                        type="checkbox"
                                        data-permission-capability={option.value}
                                        checked={rule.capabilityScope.includes(option.value)}
                                        onChange={(event) => updatePermissionRule(rule.id, {
                                          capabilityScope: event.target.checked
                                            ? PERMISSION_CAPABILITY_OPTIONS
                                              .map((candidate) => candidate.value)
                                              .filter((capability) => capability === option.value ||
                                                rule.capabilityScope.includes(capability))
                                            : rule.capabilityScope.filter((capability) => capability !== option.value)
                                        })}
                                      />
                                      {t(option.labelKey)}
                                    </label>
                                  ))}
                                </div>
                              </div>
                              <div className="settings-grid-2 permission-rule-semantic-grid">
                                <label className="field-label">
                                  {t('permissionRuleCommand')}
                                  <input
                                    className="input input-block"
                                    value={rule.commandPattern}
                                    placeholder="npm test*"
                                    onChange={(event) => updatePermissionRule(rule.id, {
                                      commandPattern: event.target.value
                                    })}
                                  />
                                </label>
                                <label className="field-label">
                                  {t('permissionRuleNetworkHost')}
                                  <input
                                    className="input input-block"
                                    value={rule.networkHostPattern}
                                    placeholder="*.example.com"
                                    onChange={(event) => updatePermissionRule(rule.id, {
                                      networkHostPattern: event.target.value
                                    })}
                                  />
                                </label>
                                <label className="field-label">
                                  {t('permissionRuleGuiApplication')}
                                  <input
                                    className="input input-block"
                                    value={rule.guiApplicationPattern}
                                    placeholder="Code.exe"
                                    onChange={(event) => updatePermissionRule(rule.id, {
                                      guiApplicationPattern: event.target.value
                                    })}
                                  />
                                </label>
                                <label className="field-label">
                                  {t('permissionRuleGuiWindow')}
                                  <input
                                    className="input input-block"
                                    value={rule.guiWindowPattern}
                                    placeholder="*Settings*"
                                    onChange={(event) => updatePermissionRule(rule.id, {
                                      guiWindowPattern: event.target.value
                                    })}
                                  />
                                </label>
                                <label className="field-label">
                                  {t('permissionRuleMcpTool')}
                                  <input
                                    className="input input-block"
                                    value={rule.mcpToolPattern}
                                    placeholder="read_*"
                                    onChange={(event) => updatePermissionRule(rule.id, {
                                      mcpToolPattern: event.target.value
                                    })}
                                  />
                                </label>
                                <label className="field-label">
                                  {t('permissionRuleMcpArgumentPointer')}
                                  <input
                                    className="input input-block"
                                    value={rule.mcpArgumentPointer}
                                    placeholder="/scope/project"
                                    onChange={(event) => updatePermissionRule(rule.id, {
                                      mcpArgumentPointer: event.target.value
                                    })}
                                  />
                                </label>
                                <label className="field-label">
                                  {t('permissionRuleMcpArgumentPattern')}
                                  <input
                                    className="input input-block"
                                    value={rule.mcpArgumentPattern}
                                    placeholder="project-*"
                                    onChange={(event) => updatePermissionRule(rule.id, {
                                      mcpArgumentPattern: event.target.value
                                    })}
                                  />
                                </label>
                                <label className="settings-check permission-rule-postcondition">
                                  <input
                                    type="checkbox"
                                    checked={rule.requirePostcondition}
                                    onChange={(event) => updatePermissionRule(rule.id, {
                                      requirePostcondition: event.target.checked
                                    })}
                                  />
                                  {t('permissionRuleRequirePostcondition')}
                                </label>
                              </div>
                            </details>
                            <div className="permission-rule-conditions">
                              <label className="field-label">
                                {t('permissionRuleRisk')}
                                <select
                                  className="select select-block"
                                  value={rule.riskLevel ? rule.riskOperator : 'none'}
                                  onChange={(event) => {
                                    const value = event.target.value
                                    updatePermissionRule(rule.id, value === 'none'
                                      ? { riskLevel: undefined }
                                      : {
                                          riskLevel: rule.riskLevel ?? 'medium',
                                          riskOperator: value as PermissionRuleRiskOperator
                                        })
                                  }}
                                >
                                  <option value="none">{t('permissionRuleRiskAny')}</option>
                                  <option value="exact">{t('permissionRuleRiskExact')}</option>
                                  <option value="atLeast">{t('permissionRuleRiskAtLeast')}</option>
                                  <option value="atMost">{t('permissionRuleRiskAtMost')}</option>
                                </select>
                              </label>
                              <label className="field-label">
                                {t('permissionRuleLevel')}
                                <select
                                  className="select select-block"
                                  value={rule.riskLevel ?? 'medium'}
                                  disabled={!rule.riskLevel}
                                  onChange={(event) => updatePermissionRule(rule.id, {
                                    riskLevel: event.target.value as ToolRiskLevel
                                  })}
                                >
                                  {PERMISSION_RISK_LEVELS.map((level) => (
                                    <option key={level} value={level}>{level}</option>
                                  ))}
                                </select>
                              </label>
                              <label className="field-label">
                                {t('permissionRuleExpiry')}
                                <select
                                  className="select select-block"
                                  value={rule.expiresAt ? 'timed' : 'permanent'}
                                  onChange={(event) => updatePermissionRule(rule.id, {
                                    expiresAt: event.target.value === 'timed' ? Date.now() + 60 * 60 * 1000 : undefined
                                  })}
                                >
                                  <option value="permanent">{t('permissionRulePermanent')}</option>
                                  <option value="timed">{t('permissionRuleTimed')}</option>
                                </select>
                              </label>
                            </div>
                            {rule.expiresAt && (
                              <label className="field-label permission-rule-expiry-value">
                                {t('permissionRuleExpiresAt')}
                                <input
                                  className="input input-block"
                                  type="datetime-local"
                                  value={permissionRuleExpiryValue(rule.expiresAt)}
                                  onChange={(event) => {
                                    const expiresAt = new Date(event.target.value).getTime()
                                    updatePermissionRule(rule.id, {
                                      expiresAt: Number.isFinite(expiresAt) ? expiresAt : rule.expiresAt
                                    })
                                  }}
                                />
                              </label>
                            )}
                            {missingSelector && (
                              <p className="permission-rule-error">{t('permissionRuleMissingSelector')}</p>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.guiAutomationEnabled}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        guiAutomationEnabled: e.target.checked,
                        guiAutomationTemporaryGrantUntil: e.target.checked
                          ? d.guiAutomationTemporaryGrantUntil
                          : 0
                      }))
                    }
                  />
                  {t('guiAutomationEnabled')}
                </label>
                <p className="settings-hint">{t('guiAutomationHint')}</p>
                {permissionGrants.length > 0 && (
                  <div className="gui-grant-section">
                    <div className="gui-grant-heading">
                      <span>{t('guiActiveGrants')}</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => void Promise.all([
                          window.agentDesk.revokeAllGuiAutomationGrants(),
                          window.agentDesk.revokeAllToolCapabilityGrants()
                        ]).then(() => {
                          setGuiGrants([])
                          setToolGrants([])
                        })}
                      >
                        {t('guiGrantRevokeAll')}
                      </button>
                    </div>
                    <div className="gui-grant-list">
                      {permissionGrants.map((grant) => (
                        <div key={grant.id} className="gui-grant-row">
                          <div>
                            <strong>{grant.toolName}</strong>
                            <span>{grant.scopeLabel}</span>
                            <small>{new Date(grant.expiresAt).toLocaleTimeString()}</small>
                          </div>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => void (grant.kind === 'gui'
                              ? window.agentDesk.revokeGuiAutomationGrant(grant.id).then((revoked) => {
                                  if (revoked) setGuiGrants((current) => current.filter((item) => item.id !== grant.id))
                                })
                              : window.agentDesk.revokeToolCapabilityGrant(grant.id).then((revoked) => {
                                  if (revoked) setToolGrants((current) => current.filter((item) => item.id !== grant.id))
                                }))}
                          >
                            {t('guiGrantRevoke')}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {tab === 'project' && <ProjectSettings />}

            {tab === 'persona' && (
              <>
                <label className="field-label">{t('personaLabel')}</label>
                <p className="settings-hint">{t('personaHint')}</p>
                <textarea
                  className="input input-block textarea"
                  rows={8}
                  value={draft.persona}
                  placeholder={t('personaPlaceholder')}
                  onChange={(e) => set('persona', e.target.value)}
                />
              </>
            )}

            {tab === 'office' && (
              <OfficeAppearanceSettings layout={draft.layout} office={draftOffice} onLayoutChange={setLayout} onOfficeChange={setOffice} />
            )}

            {tab === 'providers' && (
              <ProviderSettingsSection surface={providerSurface} providers={providers} health={health} providerProbe={providerProbe} checkingProviderId={checkingProviderId} onSurfaceChange={setProviderSurface} onAdd={() => openProviderEditor('new')} onProbe={(provider) => void probeProvider(provider)} onEdit={openProviderEditor} onRemove={(provider) => void remove(provider)} />
            )}

            {tab === 'notifications' && <NotificationConnectorManager />}

            {tab === 'plugins' && (
              <>
                <h3 className="settings-h3">{t('tabPlugins')}</h3>
                <p className="settings-hint">{t('pluginsInfo')}</p>
                <div className="plugins-paths">
                  <code>~/.caogen/skills/</code>
                  <code>~/.caogen/plugins/</code>
                  <code>.caogen/mcp/mcp.json</code>
                </div>
              </>
            )}

            {tab === 'data' && <DataRetentionSettings />}

            {tab === 'migrate' && (
              <MigrationManager defaultDirectory={activeSession?.meta.cwd ?? projects[0]?.path} />
            )}
              </>
            )}
            </div>
          </main>
      </div>

        {!editing && <footer className="settings-page-actions">
          {saveError && (
            <div className="settings-save-error" role="alert" data-settings-save-error>
              {saveError}
            </div>
          )}
          <button className="btn btn-ghost" disabled={saving} onClick={closeSettings}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? t('saving') : t('save')}
          </button>
        </footer>}
    </section>
  )
}

function createPermissionRule(): PermissionRuleConfig {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    id: `permission-${suffix}`,
    enabled: true,
    effect: 'deny',
    toolPattern: '',
    pathPattern: '',
    commandPattern: '',
    networkHostPattern: '',
    guiApplicationPattern: '',
    guiWindowPattern: '',
    mcpToolPattern: '',
    mcpArgumentPointer: '',
    mcpArgumentPattern: '',
    capabilityScope: [],
    requirePostcondition: false,
    riskOperator: 'exact'
  }
}

function permissionRuleExpiryValue(expiresAt: number | undefined): string {
  if (!expiresAt) return ''
  const value = new Date(expiresAt)
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
