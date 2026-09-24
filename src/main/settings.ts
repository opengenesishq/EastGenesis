import { normalizeWslPreferences } from '../shared/wsl-types'
import { normalizeVoiceInputSettings } from '../shared/voice-input-types'
import { normalizeWorkspaceBehavior } from '../shared/workspace-behavior-types'
import { normalizeDesktopGitPreferences } from '../shared/desktop-git-preferences'
import { normalizeNotificationPreferences, normalizeTerminalPreferences } from '../shared/desktop-behavior-preferences'
import { normalizeDesktopPersonalization } from '../shared/desktop-personalization'
import { normalizeSuggestedPrompts } from '../shared/suggested-prompt-settings'
import { normalizeSessionFollowUpBehavior } from '../shared/session-follow-up'
import { normalizeMemoryPreferences } from '../shared/memory-preferences-types'
import { normalizeBrowserDebugPreferences } from '../shared/browser-debug-types'
import { app } from 'electron'
import { join } from 'node:path'
import { compareAndWriteSettingsFile, readSettingsFileSnapshot, SETTINGS_SCHEMA_VERSION, UnsupportedSettingsSchemaError } from './settings-file-storage'
import { createSettingsRoutingBoundary } from './routing-settings/settings-boundary'
import { preserveRoutingSettingsDomain, assertOrdinaryRoutingPatchAllowed } from './routing-settings/routing-settings-state'
import type { RoutingSettingsDocument } from './routing-settings/routing-settings-types'
import { normalizeCaoGenDriveMode } from '../shared/types'
import { mergeBusinessLineSettings, normalizeBusinessLineSettings, validateBusinessLinePatch } from './business-line-settings'
import { migrateLegacyPermissionRules, normalizePermissionRules } from './permission/tool-permission'
import type {
  AppSettings,
  ModelRoutingRule,
  ModelRoutingTaskKind,
  OfficeQualityMode,
  PermissionRuleConfig,
  ProviderCircuitBreakerSettings,
  RoutingExpertPolicy,
  SchedulerStrategy
} from '../shared/types'
import { normalizeDesktopFonts } from '../shared/desktop-fonts'
import { normalizeDesktopShortcuts, validateDesktopShortcuts } from '../shared/desktop-shortcuts'

const SIDEBAR_MIN_WIDTH = 208
const SIDEBAR_MAX_WIDTH = 420
const WORKBENCH_SIDE_MIN_WIDTH = 320
const WORKBENCH_SIDE_MAX_WIDTH = 720
const WORKBENCH_DOCK_MIN_HEIGHT = 220
const WORKBENCH_DOCK_MAX_HEIGHT = 520
const CHAT_SCALE_MIN = 0.85
const CHAT_SCALE_MAX = 1.25
const MODEL_ROUTING_TASK_KINDS = new Set<ModelRoutingTaskKind>([
  'chat',
  'coding',
  'reasoning',
  'vision',
  'toolUse',
  'longContext',
  'review',
  'summarization',
  'research',
  'planning',
  'testing',
  'documentation'
])

const DEFAULTS: AppSettings = {
  suggestedPrompts: normalizeSuggestedPrompts(undefined),
  followUpBehavior: normalizeSessionFollowUpBehavior(undefined),
  memoryPreferences: normalizeMemoryPreferences(undefined),
  browserDebug: normalizeBrowserDebugPreferences(undefined),
  desktopFonts: normalizeDesktopFonts(undefined),
  desktopShortcuts: {},
  driveMode: 'core',
  defaultTaskStrategy: 'execute',
  ...normalizeBusinessLineSettings({ experienceMode: 'assistant' }),
  experienceRecommendationDismissedId: '',
  defaultModel: '',
  defaultPermissionMode: 'default',
  defaultProviderId: '',
  fallbackProviderId: '',
  fallbackModel: '',
  lowCostProviderId: '',
  lowCostModel: '',
  strongReasoningProviderId: '',
  strongReasoningModel: '',
  reviewProviderId: '',
  reviewModel: '',
  researchProviderId: '',
  researchModel: '',
  planningProviderId: '',
  planningModel: '',
  codingProviderId: '',
  codingModel: '',
  testingProviderId: '',
  testingModel: '',
  documentationProviderId: '',
  documentationModel: '',
  schedulerStrategy: 'balanced',
  modelRoutingRules: [],
  smartModelRoutingEnabled: false,
  modelCrossValidationAutoRunEnabled: false,
  routingExpertPolicy: { allowedProviderIds: [], locality: 'any', allowedRegions: [], allowedDomains: [], requiredPermissions: [] },
  budgetUsdPerSession: 0,
  budgetUsdPerMonth: 0,
  failoverEnabled: true,
  providerCircuitBreaker: {
    failureThreshold: 4,
    successThreshold: 2,
    timeoutSeconds: 60,
    errorRateThreshold: 0.6,
    minRequests: 10
  },
  language: 'zh',
  theme: 'light',
  persona: '',
  allowedTools: '',
  disallowedTools: '',
  sandboxMode: 'restrictedLocal',
  chinaEcosystemMirrorEnabled: false,
  chinaNpmRegistry: '',
  chinaPipIndexUrl: '',
  permissionAllowlist: '',
  permissionDenylist: '',
  permissionTemporaryAllowlist: '',
  permissionRulesVersion: 2,
  permissionRules: [],
  limitedFileExecutionEnabled: false,
  guiAutomationEnabled: false,
  guiAutomationTemporaryGrantUntil: 0,
  notificationsEnabled: true,
  preventDisplaySleep: true,
  autoSkillLearningEnabled: false,
  office: {
    qualityMode: 'auto', resolutionMode: 'adaptive', showBadges: true, liveliness: 1, catEars: false,
    spaceTheme: 'control-room', outfitPalette: 'role-default', hairStyle: 'role-default', teamLayout: 'grid'
  },
  layout: {
    sidebarDesignVersion: 2,
    sidebarCollapsed: false,
    sidebarWidth: 228,
    workbenchSideWidth: 400,
    workbenchDockHeight: 340,
    chatScale: 1,
    chatDensity: 'comfortable'
  }
}

let cache: AppSettings | null = null

function clampNumber(value: unknown, fallback: number, min: number, max: number, precision = 0): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const clamped = Math.min(max, Math.max(min, numeric))
  if (precision <= 0) return Math.round(clamped)
  const factor = 10 ** precision
  return Math.round(clamped * factor) / factor
}

function normalizeLayout(raw: unknown): AppSettings['layout'] {
  const layout = raw && typeof raw === 'object' ? (raw as Partial<AppSettings['layout']>) : {}
  const sidebarWidth = layout.sidebarDesignVersion === 2
    ? layout.sidebarWidth
    : layout.sidebarWidth === 264 ? DEFAULTS.layout.sidebarWidth : layout.sidebarWidth
  return {
    sidebarDesignVersion: 2,
    sidebarCollapsed:
      typeof layout.sidebarCollapsed === 'boolean' ? layout.sidebarCollapsed : DEFAULTS.layout.sidebarCollapsed,
    sidebarWidth: clampNumber(sidebarWidth, DEFAULTS.layout.sidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
    workbenchSideWidth: clampNumber(
      layout.workbenchSideWidth,
      DEFAULTS.layout.workbenchSideWidth,
      WORKBENCH_SIDE_MIN_WIDTH,
      WORKBENCH_SIDE_MAX_WIDTH
    ),
    workbenchDockHeight: clampNumber(
      layout.workbenchDockHeight,
      DEFAULTS.layout.workbenchDockHeight,
      WORKBENCH_DOCK_MIN_HEIGHT,
      WORKBENCH_DOCK_MAX_HEIGHT
    ),
    chatScale: clampNumber(layout.chatScale, DEFAULTS.layout.chatScale, CHAT_SCALE_MIN, CHAT_SCALE_MAX, 2),
    chatDensity: layout.chatDensity === 'compact' ? 'compact' : 'comfortable'
  }
}

function normalizeOfficeQualityMode(raw: unknown, fallback: OfficeQualityMode): OfficeQualityMode {
  return raw === 'auto' || raw === 'high' || raw === 'balanced' || raw === 'low' ? raw : fallback
}

function normalizeOffice(raw: unknown, fallback: AppSettings['office']): AppSettings['office'] {
  const office = raw && typeof raw === 'object' ? (raw as Partial<AppSettings['office']>) : {}
  return {
    qualityMode: normalizeOfficeQualityMode(office.qualityMode, fallback.qualityMode),
    resolutionMode: office.resolutionMode === 'adaptive'
      ? 'adaptive'
      : office.resolutionMode === 'sharp'
        ? 'sharp'
        : fallback.resolutionMode ?? (office.qualityMode === 'auto' ? 'adaptive' : 'sharp'),
    showBadges: typeof office.showBadges === 'boolean' ? office.showBadges : fallback.showBadges,
    liveliness: clampNumber(office.liveliness, fallback.liveliness, 0.2, 1.2, 1),
    catEars: typeof office.catEars === 'boolean' ? office.catEars : fallback.catEars,
    spaceTheme: office.spaceTheme === 'creative-studio' || office.spaceTheme === 'quiet-library'
      ? office.spaceTheme : 'control-room',
    outfitPalette: office.outfitPalette === 'graphite' || office.outfitPalette === 'teal' || office.outfitPalette === 'rose'
      ? office.outfitPalette : 'role-default',
    hairStyle: office.hairStyle === 'short' || office.hairStyle === 'long' || office.hairStyle === 'tied'
      ? office.hairStyle : 'role-default',
    teamLayout: office.teamLayout === 'team-photo' ? 'team-photo' : 'grid'
  }
}

function normalizeSchedulerStrategy(raw: unknown, fallback: SchedulerStrategy): SchedulerStrategy {
  return raw === 'quality' || raw === 'cost' || raw === 'speed' || raw === 'balanced' ? raw : fallback
}

function normalizeRoutingExpertPolicy(
  raw: unknown,
  fallback: RoutingExpertPolicy
): RoutingExpertPolicy {
  const value = raw && typeof raw === 'object' ? raw as Partial<RoutingExpertPolicy> : {}
  const allowedProviderIds = Array.isArray(value.allowedProviderIds)
    ? [...new Set(value.allowedProviderIds
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean))].slice(0, 100)
    : fallback.allowedProviderIds
  const locality = value.locality === 'any' || value.locality === 'prefer_local' || value.locality === 'local_only'
    ? value.locality
    : fallback.locality
  const normalizeList = (raw: unknown, fallbackValue: string[] | undefined): string[] => Array.isArray(raw)
    ? [...new Set(raw.filter((item): item is string => typeof item === 'string').map((item) => item.trim().toLowerCase()).filter(Boolean))].slice(0, 100)
    : [...(fallbackValue ?? [])]
  return { allowedProviderIds, locality,
    allowedRegions: normalizeList(value.allowedRegions, fallback.allowedRegions),
    allowedDomains: normalizeList(value.allowedDomains, fallback.allowedDomains),
    requiredPermissions: normalizeList(value.requiredPermissions, fallback.requiredPermissions) }
}

function normalizeDefaultTaskStrategy(
  raw: unknown,
  fallback: AppSettings['defaultTaskStrategy']
): AppSettings['defaultTaskStrategy'] {
  return raw === 'view' || raw === 'plan' || raw === 'execute' ? raw : fallback
}

function normalizeProviderCircuitBreaker(
  raw: unknown,
  fallback: ProviderCircuitBreakerSettings
): ProviderCircuitBreakerSettings {
  const value = raw && typeof raw === 'object' ? raw as Partial<ProviderCircuitBreakerSettings> : {}
  return {
    failureThreshold: clampNumber(value.failureThreshold, fallback.failureThreshold, 1, 20),
    successThreshold: clampNumber(value.successThreshold, fallback.successThreshold, 1, 10),
    timeoutSeconds: clampNumber(value.timeoutSeconds, fallback.timeoutSeconds, 0, 300),
    errorRateThreshold: clampNumber(value.errorRateThreshold, fallback.errorRateThreshold, 0.01, 1, 2),
    minRequests: clampNumber(value.minRequests, fallback.minRequests, 1, 100)
  }
}

function mergePermissionRules(
  current: PermissionRuleConfig[],
  incoming: PermissionRuleConfig[]
): PermissionRuleConfig[] {
  const byId = new Map(current.map((rule) => [rule.id, rule]))
  for (const rule of incoming) byId.set(rule.id, rule)
  return normalizePermissionRules([...byId.values()])
}

function normalizeSandboxMode(raw: unknown): AppSettings['sandboxMode'] {
  if (raw === 'disabled' || raw === 'strictDocker') return 'disabled'
  if (raw === 'loose') return 'loose'
  if (raw === 'restrictedLocal' || raw === 'standardSystem') return 'restrictedLocal'
  return DEFAULTS.sandboxMode
}

function normalizeModelRoutingRules(raw: unknown): ModelRoutingRule[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(normalizeModelRoutingRule)
    .filter((item): item is ModelRoutingRule => Boolean(item))
    .slice(0, 20)
}

function normalizeModelRoutingRule(item: unknown, index: number): ModelRoutingRule | null {
  if (!item || typeof item !== 'object') return null
  const record = item as Partial<ModelRoutingRule>
  const name = boundedRoutingText(record.name, 80, false)
  const match = boundedRoutingText(record.match, 500, false)
  const taskKinds = normalizeRoutingTaskKinds(record.taskKinds)
  const minRiskLevel = normalizeRoutingRisk(record.minRiskLevel)
  const whenStrategy = normalizeRoutingStrategy(record.whenStrategy)
  const providerId = boundedRoutingText(record.providerId)
  const model = boundedRoutingText(record.model)
  if (![name, match, taskKinds.length, minRiskLevel, whenStrategy, providerId, model].some(Boolean)) return null
  return {
    id: routingRuleId(record.id, index),
    enabled: record.enabled !== false,
    name,
    match,
    keywordMode: record.keywordMode === 'all' ? 'all' : 'any',
    taskKinds,
    minRiskLevel,
    whenStrategy,
    providerId,
    model
  }
}

function routingRuleId(value: unknown, index: number): string {
  return typeof value === 'string' && value.trim() ? value.trim() : `rule-${index + 1}`
}

function boundedRoutingText(value: unknown, maxLength?: number, trim = true): string {
  if (typeof value !== 'string') return ''
  const normalized = trim ? value.trim() : value
  return maxLength === undefined ? normalized : normalized.slice(0, maxLength)
}

function normalizeRoutingTaskKinds(value: unknown): ModelRoutingTaskKind[] {
  if (!Array.isArray(value)) return []
  const valid = value.filter((item): item is ModelRoutingTaskKind =>
    MODEL_ROUTING_TASK_KINDS.has(item as ModelRoutingTaskKind))
  return [...new Set(valid)].slice(0, MODEL_ROUTING_TASK_KINDS.size)
}

function normalizeRoutingRisk(value: unknown): ModelRoutingRule['minRiskLevel'] {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined
}

function normalizeRoutingStrategy(value: unknown): ModelRoutingRule['whenStrategy'] {
  return value === 'quality' || value === 'cost' || value === 'speed' || value === 'balanced'
    ? value
    : undefined
}

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function normalizeSettingsDocument(document: RoutingSettingsDocument): AppSettings {
  const { routingRuleSet: _mainOwnedRuleSet, ...publicDocument } = document
  const persisted = publicDocument as Partial<AppSettings> & { _schemaVersion?: unknown; sandboxDockerImage?: unknown; chinaDockerRegistryMirror?: unknown }
  const {
    _schemaVersion: _schemaVersion,
    sandboxMode,
    sandboxDockerImage: _legacyDockerImage,
    chinaDockerRegistryMirror: _legacyDockerRegistryMirror,
    ...raw
  } = persisted
  const normalizedVoiceInput = normalizeVoiceInputSettings(raw.voiceInput)
  return {
    ...DEFAULTS,
    ...raw,
    ...normalizeBusinessLineSettings(raw),
    ...(normalizedVoiceInput === undefined ? {} : { voiceInput: normalizedVoiceInput }),
    desktopPersonalization: normalizeDesktopPersonalization(raw.desktopPersonalization),
    notificationPreferences: normalizeNotificationPreferences(raw.notificationPreferences),
    terminalPreferences: normalizeTerminalPreferences(raw.terminalPreferences),
    wsl: normalizeWslPreferences(raw.wsl),
    workspaceBehavior: normalizeWorkspaceBehavior(raw.workspaceBehavior),
    gitPreferences: normalizeDesktopGitPreferences(raw.gitPreferences),
    desktopFonts: normalizeDesktopFonts(raw.desktopFonts),
    desktopShortcuts: normalizeDesktopShortcuts(raw.desktopShortcuts),
    suggestedPrompts: normalizeSuggestedPrompts(raw.suggestedPrompts),
    followUpBehavior: normalizeSessionFollowUpBehavior(raw.followUpBehavior),
    memoryPreferences: normalizeMemoryPreferences(raw.memoryPreferences),
    browserDebug: normalizeBrowserDebugPreferences(raw.browserDebug),
    driveMode: normalizeCaoGenDriveMode(raw.driveMode),
    defaultTaskStrategy: normalizeDefaultTaskStrategy(raw.defaultTaskStrategy, DEFAULTS.defaultTaskStrategy),
    experienceRecommendationDismissedId: normalizeRecommendationId(raw.experienceRecommendationDismissedId),
    sandboxMode: normalizeSandboxMode(sandboxMode),
    schedulerStrategy: normalizeSchedulerStrategy(raw.schedulerStrategy, DEFAULTS.schedulerStrategy),
    modelRoutingRules: normalizeModelRoutingRules(raw.modelRoutingRules),
    routingExpertPolicy: normalizeRoutingExpertPolicy(raw.routingExpertPolicy, DEFAULTS.routingExpertPolicy),
    providerCircuitBreaker: normalizeProviderCircuitBreaker(
      raw.providerCircuitBreaker,
      DEFAULTS.providerCircuitBreaker
    ),
    permissionAllowlist: '',
    permissionDenylist: '',
    permissionTemporaryAllowlist: '',
    allowedTools: '',
    disallowedTools: '',
    permissionRulesVersion: 2,
    limitedFileExecutionEnabled: normalizeLimitedFileExecution(raw.limitedFileExecutionEnabled),
    permissionRules: mergePermissionRules(
      normalizePermissionRules(raw.permissionRules, false),
      migrateLegacyPermissionRules(raw)
    ),
    // Legacy global grants are invalidated during migration. Scoped GUI grants
    // are runtime capabilities and are never persisted in settings.json.
    guiAutomationTemporaryGrantUntil: 0,
    office: normalizeOffice(raw.office, DEFAULTS.office),
    layout: normalizeLayout(raw.layout)
  }
}

export function getSettings(): AppSettings {
  if (cache) return cache
  try {
    cache = normalizeSettingsDocument(readSettingsFileSnapshot(settingsFile()).document)
  } catch (error) {
    if (error instanceof UnsupportedSettingsSchemaError) throw error
    cache = {
      ...DEFAULTS,
      providerCircuitBreaker: { ...DEFAULTS.providerCircuitBreaker },
      routingExpertPolicy: { ...DEFAULTS.routingExpertPolicy, allowedProviderIds: [] },
      office: { ...DEFAULTS.office },
      layout: { ...DEFAULTS.layout }
    }
  }
  return cache
}

/** Writer authority is read from the durable settings domain, never a tool's old snapshot. */
export function readCurrentPermissionSettings(rootDir?: string): AppSettings {
  return normalizeSettingsDocument(readSettingsFileSnapshot(rootDir ? join(rootDir, 'settings.json') : settingsFile()).document)
}

function normalizeLimitedFileExecution(value: unknown): boolean {
  if (value === undefined) return false // Explicit compatibility for older settings.
  if (typeof value !== 'boolean') throw new Error('限定文件执行设置必须是布尔值。')
  return value
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  validateBusinessLinePatch(patch)
  const snapshot = readSettingsFileSnapshot(settingsFile())
  assertOrdinaryRoutingPatchAllowed(snapshot.document, patch)
  const prev = normalizeSettingsDocument(snapshot.document)
  const migratedLegacyRules = migrateLegacyPermissionRules(patch)
  const permissionRules = mergePermissionRules(
    patch.permissionRules === undefined ? prev.permissionRules : normalizePermissionRules(patch.permissionRules),
    migratedLegacyRules
  )
  const normalizedVoiceInput = normalizeVoiceInputSettings(patch.voiceInput === undefined ? prev.voiceInput : patch.voiceInput)
  const next = {
    ...prev,
    ...patch,
    ...mergeBusinessLineSettings(prev, patch),
    ...(normalizedVoiceInput === undefined ? {} : { voiceInput: normalizedVoiceInput }),
    desktopPersonalization: normalizeDesktopPersonalization(patch.desktopPersonalization === undefined ? prev.desktopPersonalization : patch.desktopPersonalization),
    notificationPreferences: normalizeNotificationPreferences(patch.notificationPreferences === undefined ? prev.notificationPreferences : patch.notificationPreferences),
    terminalPreferences: normalizeTerminalPreferences(patch.terminalPreferences === undefined ? prev.terminalPreferences : patch.terminalPreferences),
    wsl: normalizeWslPreferences(patch.wsl === undefined ? prev.wsl : patch.wsl),
    workspaceBehavior: normalizeWorkspaceBehavior(patch.workspaceBehavior === undefined ? prev.workspaceBehavior : patch.workspaceBehavior),
    gitPreferences: normalizeDesktopGitPreferences(patch.gitPreferences === undefined ? prev.gitPreferences : patch.gitPreferences),
    desktopFonts: normalizeDesktopFonts(patch.desktopFonts === undefined ? prev.desktopFonts : patch.desktopFonts),
    desktopShortcuts: patch.desktopShortcuts === undefined ? prev.desktopShortcuts : validateDesktopShortcuts(patch.desktopShortcuts),
    suggestedPrompts: normalizeSuggestedPrompts(patch.suggestedPrompts === undefined ? prev.suggestedPrompts : patch.suggestedPrompts),
    followUpBehavior: normalizeSessionFollowUpBehavior(patch.followUpBehavior === undefined ? prev.followUpBehavior : patch.followUpBehavior),
    memoryPreferences: normalizeMemoryPreferences(patch.memoryPreferences === undefined ? prev.memoryPreferences : patch.memoryPreferences),
    browserDebug: normalizeBrowserDebugPreferences(patch.browserDebug === undefined ? prev.browserDebug : patch.browserDebug),
    driveMode: patch.driveMode === undefined ? prev.driveMode : normalizeCaoGenDriveMode(patch.driveMode),
    defaultTaskStrategy: patch.defaultTaskStrategy === undefined
      ? prev.defaultTaskStrategy
      : normalizeDefaultTaskStrategy(patch.defaultTaskStrategy, prev.defaultTaskStrategy),
    experienceRecommendationDismissedId: patch.experienceRecommendationDismissedId === undefined
      ? prev.experienceRecommendationDismissedId
      : normalizeRecommendationId(patch.experienceRecommendationDismissedId),
    sandboxMode: patch.sandboxMode === undefined ? prev.sandboxMode : normalizeSandboxMode(patch.sandboxMode),
    schedulerStrategy:
      patch.schedulerStrategy === undefined
        ? prev.schedulerStrategy
        : normalizeSchedulerStrategy(patch.schedulerStrategy, prev.schedulerStrategy),
    modelRoutingRules:
      patch.modelRoutingRules === undefined ? prev.modelRoutingRules : normalizeModelRoutingRules(patch.modelRoutingRules),
    routingExpertPolicy: normalizeRoutingExpertPolicy(patch.routingExpertPolicy, prev.routingExpertPolicy),
    providerCircuitBreaker: normalizeProviderCircuitBreaker(
      patch.providerCircuitBreaker,
      prev.providerCircuitBreaker
    ),
    allowedTools: '',
    disallowedTools: '',
    permissionAllowlist: '',
    permissionDenylist: '',
    permissionTemporaryAllowlist: '',
    permissionRulesVersion: 2 as const,
    limitedFileExecutionEnabled: normalizeLimitedFileExecution(patch.limitedFileExecutionEnabled === undefined ? prev.limitedFileExecutionEnabled : patch.limitedFileExecutionEnabled),
    permissionRules,
    guiAutomationTemporaryGrantUntil: 0,
    office: normalizeOffice(patch.office, prev.office),
    layout: normalizeLayout({ ...prev.layout, ...(patch.layout ?? {}) })
  }
  try {
    const document = preserveRoutingSettingsDomain({ authoritative: snapshot.document, requestedPatch: patch, candidate: { _schemaVersion: SETTINGS_SCHEMA_VERSION, ...next } })
    const receipt = compareAndWriteSettingsFile(settingsFile(), { expectedToken: snapshot.token, document })
    if (receipt.status === 'conflict') throw new Error('Settings changed before save; reload before retrying.')
  } catch (err) {
    cache = null
    console.error('[agent-desk] 保存设置失败:', err)
    throw err
  }
  cache = next
  for (const listener of settingsListeners) {
    try { listener() } catch (error) { console.error('[agent-desk] settings listener failed:', error) }
  }
  return next
}

const settingsListeners = new Set<() => void>()
export function subscribeSettingsChanges(listener: () => void): () => void {
  settingsListeners.add(listener)
  return () => settingsListeners.delete(listener)
}

function normalizeRecommendationId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return normalized.length <= 500 && /^[A-Za-z0-9:._-]*$/.test(normalized) ? normalized : ''
}

/** Main-only boundary for the versioned rule service; no renderer mutation is registered here. */
export function getRoutingSettingsBoundary() {
  return createSettingsRoutingBoundary({ file: settingsFile, invalidateCache: () => { cache = null } })
}
