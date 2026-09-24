import type { LocalSitePreviewApi } from './local-site-preview-types'
import type { WorkspaceBehaviorApi } from './workspace-behavior-types'
import type { McpOAuthApi } from './mcp-oauth-types'
import type { WslApi } from './wsl-types'
import type { MemoryPreferencesApi } from './memory-preferences-types'
import type { MigrationSubscriptionApi } from './migration-subscription-types'
import type { PluginCatalogApi } from './plugin-catalog-types'
export interface AgentDeskApi extends PluginCatalogApi {}
export interface AgentDeskApi extends MigrationSubscriptionApi {}
export interface AgentDeskApi extends MemoryPreferencesApi {}
export interface AgentDeskApi extends WslApi {}
export interface AgentDeskApi extends LocalSitePreviewApi, WorkspaceBehaviorApi, McpOAuthApi {}
import type { RoutineInboxApi } from './routine-inbox-types'
export interface AgentDeskApi extends RoutineInboxApi {}
import type { LocalDevServerApi } from './local-dev-server-types'
import type { BrowserManagementApi } from './browser-preferences-types'
import type { PullRequestWorkspaceApi } from './pull-request-workspace-types'
export interface AgentDeskApi extends LocalDevServerApi, BrowserManagementApi, PullRequestWorkspaceApi {}
import type { BrowserTabApi, BrowserTabTarget } from './browser-tab-types'
export interface AgentDeskApi extends BrowserTabApi {}
import type { LocalSiteCatalogApi } from './local-site-catalog-types'
import type { WorktreePullRequestDraftApi } from './worktree-pr-draft-types'
export interface AgentDeskApi extends LocalSiteCatalogApi, WorktreePullRequestDraftApi {}
import type { TaskSourceApi } from './task-source-types'
import type { GoalModeApi } from './session-goal-mode'
export interface AgentDeskApi extends GoalModeApi {}
export interface AgentDeskApi extends TaskSourceApi {}
import type { FeedbackApi } from './feedback-types'
import type { ProjectHistoryApi } from './project-history'

export interface AgentDeskApi extends ProjectHistoryApi {}
import type { WorkspaceHandoffApi, WorkspaceHandoffReceipt } from './workspace-handoff-types'
export type * from './workspace-handoff-types'
import type { SideChatApi, SideChatBinding } from './side-chat-types'
import type { VoiceInputApi, VoiceInputSettings } from './voice-input-types'
export type * from './voice-input-types'
import type { TaskRunRecord } from './task-runtime-types'
import type { TaskWindowApi } from './task-window-types'
import type { TemporaryTaskApi } from './temporary-task-types'
export interface AgentDeskApi extends TemporaryTaskApi {}
import type { ProviderConnectionBinding } from './provider-connection-identity'
export type * from './task-runtime-types'
import type { OfficeRevisionApi } from './office-revision-types'
import type { SendMessagePayload } from './message-payload-types'
import type { SessionInputApi } from './session-input-types'
import type { PreparationPermissionApi } from './preparation-permission-types'
import type { TaskExecutionAuthorityApi } from './task-execution-authority-types'
import type { TaskBudgetApi } from './task-budget-types'
import type { CouncilApi } from './council-types'
import type { EffectResolution, TaskEffectRecoveryApi } from './effect-recovery-types'
export type * from './preparation-permission-types'
export type { SendMessagePayload } from './message-payload-types'
export type * from './office-revision-types'
/** 主进程、预加载与渲染进程共享的编译期类型。 */
import type { EffectRecord, EffectStatus, InteractiveOperationKind, InteractiveOperationSource, MigrationImportOperationResult, TaskRunOperationMetadata } from './effect-types'
import type { TaskDagAutoMergeView, TaskDagFinalizationRecord, TaskDagFinalizationResolution, TaskDagFinalizationView } from './task-dag-finalization-types'
import type { DigitalWorkerApi, DigitalWorkerBinding } from './digital-worker-types'
import type { ModelAttemptRecoveryApi } from './model-attempt-types'
import type { WorkflowLedgerApi } from './workflow-types'
import type { ProjectWorkspaceApi } from './project-workspace-types'
import type { BusinessLineBinding, BusinessLineSettings } from './business-line-types'
import type { SessionRuntimeRoutingBinding } from './session-runtime-continuation-types'
import type { ProjectPortfolioApi } from './project-portfolio-types'
import type { OutboundContextManifest } from './project-workspace-types'
import type { LearningApi } from './learning-types'
import type { LegacyMemoryImportInput, LegacyMemoryImportResult, LegacyMemoryPreview } from './legacy-memory-import-types'
export type * from './legacy-memory-import-types'
import type { SupervisorStateApi } from './supervisor-types'
import type { UserMessageAttachmentView } from './attachment-types'
import type { ProviderProfileApi } from './provider-profile-types'
import type { ProjectTestApi } from './project-test-types'
import type { ProjectDebugApi } from './project-debug-types'
import type { ProjectRefactorApi } from './project-refactor-types'
import type { TaskPlanApi, TaskStrategy } from './task-plan-types'
import type { MigrationApi } from './migration-types'
import type { StudioResultApi } from './studio-result-types'
import type { ProjectDataLifecycleApi } from './data-lifecycle-types'
import type { PluginInstallResult, PluginUninstallResult } from './plugin-types'
import type { TerminalEffectApi } from './terminal-operation-types'
import type { BrowserNavigationEffectApi, BrowserViewState } from './browser-operation-types'
import type { MediaApi, ProviderMediaPricing } from './media-types'
import type { SessionEntrypointApi } from './session-entrypoint-types'
import type { AssistantSearchApi } from './assistant-search-types'
import type { ExternalBrowserBridgeApi } from './external-browser-types'
import type { TaskActivityApi } from './activity-types'
export type * from './image-canvas-types'
export type * from './activity-types'
export type * from './external-browser-types'
export type * from './palace-scene-builder-types'
export type * from './assistant-search-types'
import type { NotificationConnectorInput, NotificationConnectorView } from './notification-connector-types'
import type { ProviderApiKeyInput, ProviderApiKeyUpdateInput, ProviderCredentialPolicy, ProviderCredentialRoutingMode } from './provider-credential-routing-types'
import type { ProviderAuthorization } from './provider-authorization-types'
import type { ProviderAnthropicRuntimeConfig } from './provider-anthropic-runtime-types'
import type { ProviderGeminiRuntimeConfig } from './provider-gemini-runtime-types'
import type {
  PluginRegistryItem, PluginRegistryRevealResult, PluginRegistryScanOptions,
  PluginRegistrySetEnabledResult, PluginRegistryTrustMutationResult, PluginRegistryView
} from './plugin-registry-types'
import type {
  ListProjectFilesResult, ProjectDiagnosticsResult, ProjectSymbolSearchResult,
  ReadTextFileResult, SearchProjectTextResult, SemanticCompletionResult,
  SemanticDefinitionResult, SemanticDiagnosticsResult, SemanticHoverResult,
  TypeScriptLanguageInput, WriteTextFileResult
} from './file-intelligence-types'
export type { ProviderAuthorization, ProviderAuthorizationMethod, ProviderAuthorizationStatus } from './provider-authorization-types'
export type * from './provider-anthropic-runtime-types'
export type * from './plugin-registry-types'
export type * from './file-intelligence-types'
export type { UserMessageAttachmentView } from './attachment-types'
export type * from './provider-profile-types'
export type * from './provider-profile-webdav-types'
export type * from './provider-profile-s3-types'
export type * from './project-test-types'
export type * from './project-debug-types'
export type * from './project-refactor-types'
export type * from './provider-native-import-types'
export type * from './provider-credential-routing-types'
export type * from './task-plan-types'
export type * from './migration-types'
export type * from './studio-result-types'
export type * from './personal-task-types'
export type * from './data-lifecycle-types'
export type * from './notification-connector-types'
export type * from './project-aggregate-types'
export type { PluginInstallResult, PluginUninstallResult } from './plugin-types'
export type * from './workflow-types'
export * from './workflow-repair'
export type * from './digital-worker-types'
export type * from './watercolor-character'
export type * from './project-workspace-types'
export type * from './project-portfolio-types'
export type * from './project-connector-catalog'
export { PROJECT_CONNECTOR_CATALOG } from './project-connector-catalog'
export { MANAGED_PERSONAL_WORKSPACE_ID } from './project-workspace-types'
export type * from './learning-types'
export type * from './supervisor-types'
export type * from './provider-authorization-types'
export type * from './provider-balance-types'
export type * from './terminal-operation-types'
export type * from './browser-operation-types'
export type * from './media-types'
export type * from './session-query-types'
export type * from './effect-recovery-types'
export type {
  EffectEvidenceKind,
  EffectEvidenceRecord,
  EffectLease,
  EffectRecord,
  EffectStatus,
  EffectTarget,
  FileSystemIdentity,
  InteractiveOperationKind,
  InteractiveOperationSource,
  ManagedWorktreeProjectionRecord,
  MigrationImportOperationResult,
  OfficeSourceSnapshot,
  TaskRunOperationMetadata
} from './effect-types'
export type {
  TaskDagAutoMergeConflict, TaskDagAutoMergeEntry, TaskDagAutoMergeEntryStatus, TaskDagAutoMergeRollback,
  TaskDagAutoMergeRollbackEntry, TaskDagAutoMergeStatus, TaskDagAutoMergeVerification,
  TaskDagAutoMergeVerificationStatus, TaskDagAutoMergeView, TaskDagFinalizationPatchPlan,
  TaskDagFinalizationPhase, TaskDagFinalizationRecord, TaskDagFinalizationResolution,
  TaskDagFinalizationSummary, TaskDagFinalizationVerification, TaskDagFinalizationView
} from './task-dag-finalization-types'
export type PermissionModeId = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
/** 用户可理解的任务合同；与 Experience、Drive、Provider 和 permissionMode 正交。 */
/** 本地执行策略。disabled 仅用于旧严格容器设置的 fail-closed 迁移。 */
export type SandboxMode = 'disabled' | 'restrictedLocal' | 'loose'
/** Native command lifecycle outcome; exitCode is meaningful only for exited. */ export type CommandTermination = 'exited' | 'timed_out' | 'aborted' | 'output_limit' | 'spawn_error' | 'not_started'
export type ToolRiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type ToolSemanticCapability = 'workspaceRead' | 'workspaceWrite' | 'terminal' | 'browser' | 'network'

export type PermissionRuleEffect = 'allow' | 'deny'
export type PermissionRuleRiskOperator = 'exact' | 'atLeast' | 'atMost'

/** Versioned user permission rule. Runtime-only capability grants are stored separately. */
export interface PermissionRuleConfig {
  id: string
  enabled: boolean
  effect: PermissionRuleEffect
  toolPattern: string
  pathPattern: string
  commandPattern: string
  networkHostPattern: string
  guiApplicationPattern: string
  guiWindowPattern: string
  mcpToolPattern: string
  /** RFC 6901 pointer into MCP arguments; must be paired with mcpArgumentPattern. */
  mcpArgumentPointer: string
  /** Wildcard match for the non-sensitive scalar selected by mcpArgumentPointer. */
  mcpArgumentPattern: string
  /** Capabilities covered by this rule. Composite allow rules must cover every requested capability. */
  capabilityScope: ToolSemanticCapability[]
  requirePostcondition: boolean
  riskLevel?: ToolRiskLevel
  riskOperator: PermissionRuleRiskOperator
  expiresAt?: number
}

/** Frozen Effect target identity shown in an approval request and bound to grants. */
export interface PermissionEffectScopeView {
  targetKind: string
  targetDigest: string
  summary: string
}
export type SchedulerStrategy = 'quality' | 'cost' | 'speed' | 'balanced'
export type RoutingLocalityPolicy = 'any' | 'prefer_local' | 'local_only'

export interface RoutingExpertPolicy {
  /** Empty means every configured Provider remains eligible. */
  allowedProviderIds: string[]
  /** local_only is the hard no-egress mode for model requests. */
  locality: RoutingLocalityPolicy
  /** Optional hard boundary for endpoint geography. Empty means any region. */
  allowedRegions?: string[]
  /** Optional hard boundary for endpoint host/domain. Empty means any domain. */
  allowedDomains?: string[]
  /** Permission/capability labels an endpoint must explicitly advertise. */
  requiredPermissions?: string[]
}
export type ModelRoutingTaskKind =
  | 'chat'
  | 'coding'
  | 'reasoning'
  | 'vision'
  | 'toolUse'
  | 'longContext'
  | 'review'
  | 'summarization'
  | 'research'
  | 'planning'
  | 'testing'
  | 'documentation'
export type ModelRoutingRiskLevel = 'low' | 'medium' | 'high'
export type ModelRoutingKeywordMode = 'any' | 'all'

export interface ModelRoutingRule {
  id: string
  enabled: boolean
  name: string
  /** 逗号、分号或换行分隔的关键词;任一关键词命中当前用户请求即应用该规则。 */
  match: string
  /** 默认 any;all 要求所有关键词都出现在当前用户请求中。 */
  keywordMode?: ModelRoutingKeywordMode
  /** 空数组 = 不限制任务类型;非空时命中任一推断任务类型即可。 */
  taskKinds?: ModelRoutingTaskKind[]
  /** 最低风险门槛;空值 = 不限制。 */
  minRiskLevel?: ModelRoutingRiskLevel
  /** 仅在当前有效调度策略一致时应用;空值 = 不限制。 */
  whenStrategy?: SchedulerStrategy
  /** 空字符串 = 不指定 Provider,只按模型或普通路由选择。 */
  providerId: string
  /** 空字符串 = 不指定模型,只固定 Provider 或普通路由选择。 */
  model: string
}

export type CaoGenDriveMode = 'spark' | 'core' | 'forge' | 'command' | 'genesis'

export type CaoGenDriveValidationDepth = 'light' | 'basic' | 'local' | 'guarded' | 'closedLoop'

export interface CaoGenDrivePolicyView {
  mode: CaoGenDriveMode
  label: string
  zhLabel: string
  summary: string
  schedulerStrategy: SchedulerStrategy
  defaultModel: string
  /**
   * 风险偏好描述，不再设置会话 permissionMode。
   * 收编后会话 permissionMode 由 taskStrategy 派生；此字段仅供设置页展示和 Routine 创建时参考。
   */
  defaultPermissionMode: PermissionModeId
  sessionBudgetUsd: number
  validationDepth: CaoGenDriveValidationDepth
  smartModelRoutingEnabled: boolean
  modelCrossValidationAutoRunEnabled: boolean
  toolPolicySummary: string
}

export interface ModelRoutePlanView {
  enabled: boolean
  primary: { providerId: string; providerName?: string; model: string }
  validators: Array<{ providerId: string; providerName?: string; model: string }>
  policy: 'compare-answer' | 'review-primary' | 'skip'
  reason: string
}

export interface ModelRoutingAlternativeView {
  providerId: string
  providerName?: string
  model: string
  score: number
  reliability: number
  estimatedCostUsd: number
  latencyEmaMs?: number
  scoreBreakdown?: {
    capability: number
    quality: number
    acceptanceQuality: number
    acceptanceSamples: number
    speed: number
    cost: number
    health: number
    composite: number
  }
}

/** 一次自动调度的结构化决策日志，供聊天、控制面板和 3D 办公复用。 */
export interface ModelRoutingDecisionView {
  providerId: string
  providerName?: string
  model: string
  strategy: SchedulerStrategy
  taskKinds: string[]
  complexity?: 'simple' | 'medium' | 'complex'
  riskLevel: 'low' | 'medium' | 'high'
  candidateCount: number
  score?: number
  reliability?: number
  estimatedCostUsd?: number
  latencyEmaMs?: number
  scoreBreakdown?: ModelRoutingAlternativeView['scoreBreakdown']
  /** SHA-256 of the non-secret route inputs and candidate scores. */
  decisionDigest?: string
  remainingBudgetUsd?: number
  manualOverrideApplied: boolean
  selectionReason?: string
  selectedReasons: string[]
  budgetDowngraded: boolean
  switchedProvider: boolean
  warnings: string[]
  alternatives: ModelRoutingAlternativeView[]
  createdAt: number
}

/** 会话 model 字段取此哨兵值 = 启用智能自动调度 */
export const AUTO_MODEL = 'auto'
/** 新会话 providerId 取此哨兵值 = 先跨厂商选路再创建会话。 */
export const AUTO_PROVIDER_ID = 'auto-provider'
export type SessionRoutingScope = 'fixed' | 'provider' | 'global'
export const DEEPSEEK_PROVIDER_ID = 'deepseek-official'
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat'

export const CAOGEN_DRIVE_POLICIES: readonly CaoGenDrivePolicyView[] = [
  {
    mode: 'spark',
    label: 'Spark',
    zhLabel: '星火',
    summary: '快速模型、低推理、少工具、轻验证',
    schedulerStrategy: 'cost',
    defaultModel: AUTO_MODEL,
    defaultPermissionMode: 'default',
    sessionBudgetUsd: 0.05,
    validationDepth: 'light',
    smartModelRoutingEnabled: true,
    modelCrossValidationAutoRunEnabled: false,
    toolPolicySummary: '低风险工具优先，阻止高风险、GUI、DAG 和发布类动作'
  },
  {
    mode: 'core',
    label: 'Core',
    zhLabel: '中枢',
    summary: '默认日用，均衡模型、常规工具、基础验证',
    schedulerStrategy: 'balanced',
    defaultModel: AUTO_MODEL,
    defaultPermissionMode: 'default',
    sessionBudgetUsd: 0.25,
    validationDepth: 'basic',
    smartModelRoutingEnabled: true,
    modelCrossValidationAutoRunEnabled: false,
    toolPolicySummary: '常规读写按权限模式执行，阻止 critical 风险与 Genesis 编排动作'
  },
  {
    mode: 'forge',
    label: 'Forge',
    zhLabel: '熔铸',
    summary: '多文件工程、强推理、局部测试、diff/review',
    schedulerStrategy: 'quality',
    defaultModel: AUTO_MODEL,
    defaultPermissionMode: 'acceptEdits',
    sessionBudgetUsd: 1.5,
    validationDepth: 'local',
    smartModelRoutingEnabled: true,
    modelCrossValidationAutoRunEnabled: false,
    toolPolicySummary: '自动接受编辑，命令和高风险动作仍走审批；Genesis 编排需升级到 Command/Genesis'
  },
  {
    mode: 'command',
    label: 'Command',
    zhLabel: '指挥',
    summary: '高风险任务、强模型、GUI/IDE/Git/权限强管控',
    schedulerStrategy: 'quality',
    defaultModel: AUTO_MODEL,
    defaultPermissionMode: 'default',
    sessionBudgetUsd: 5,
    validationDepth: 'guarded',
    smartModelRoutingEnabled: true,
    modelCrossValidationAutoRunEnabled: true,
    toolPolicySummary: '强模型与自动复核，GUI 可逐次审批，critical 风险仍阻止'
  },
  {
    mode: 'genesis',
    label: 'Genesis',
    zhLabel: '创生',
    summary: '多 Agent、DAG、worktree、交叉复核、自动验证、交付闭环',
    schedulerStrategy: 'quality',
    defaultModel: AUTO_MODEL,
    defaultPermissionMode: 'acceptEdits',
    sessionBudgetUsd: 12,
    validationDepth: 'closedLoop',
    smartModelRoutingEnabled: true,
    modelCrossValidationAutoRunEnabled: true,
    toolPolicySummary: '允许多 Agent/DAG 底座，编辑自动化，命令、GUI 和发布动作保留审批'
  }
]

export function normalizeCaoGenDriveMode(value: unknown): CaoGenDriveMode {
  return CAOGEN_DRIVE_POLICIES.some((policy) => policy.mode === value)
    ? (value as CaoGenDriveMode)
    : 'core'
}

export function caogenDrivePolicyView(mode: unknown): CaoGenDrivePolicyView {
  const normalized = normalizeCaoGenDriveMode(mode)
  return CAOGEN_DRIVE_POLICIES.find((policy) => policy.mode === normalized) ?? CAOGEN_DRIVE_POLICIES[1]
}

export type ProviderCircuitState = 'closed' | 'open' | 'half_open'

export interface ProviderCircuitBreakerSettings {
  /** Consecutive switchable failures required to open the circuit. */
  failureThreshold: number
  /** Successful half-open probes required to close the circuit. */
  successThreshold: number
  /** Cooldown before an open circuit permits recovery probes. */
  timeoutSeconds: number
  /** Switchable failure ratio that can open the circuit after minRequests. */
  errorRateThreshold: number
  /** Minimum generation requests before error-rate opening is evaluated. */
  minRequests: number
}

export interface ProviderHealthView {
  /** Provider id;历史健康记录里可能出现 official,但新会话不再使用空 Provider 默认。 */
  providerId: string
  successes: number
  failures: number
  consecutiveFailures: number
  probeSuccesses?: number
  probeFailures?: number
  lastProbeLatencyMs?: number
  lastProbeError?: string
  lastProbeSuccessAt?: number
  lastProbeFailureAt?: number
  lastLatencyMs?: number
  latencyEmaMs?: number
  lastError?: string
  lastSuccessAt?: number
  lastFailureAt?: number
  lastUsedAt?: number
  circuitState: ProviderCircuitState
  circuitOpenedAt?: number
  halfOpenSuccesses: number
  circuitTotalRequests: number
  circuitFailedRequests: number
  recentFailures: Array<{
    at: number
    label: string
    message: string
    switchable: boolean
  }>
  healthy: boolean
}

export interface ProviderModelPricing {
  currency: 'USD'
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion?: number
  cacheWritePerMillion?: number
  source: 'builtin' | 'provider' | 'catalog' | 'user'
  updatedAt?: number
}

export interface ProviderPricingCatalogEntry {
  key: string
  providerId: string
  providerName: string
  modelId: string
  normalizedId: string
  modelName: string
  releaseDate?: string
  pricing: ProviderModelPricing
}

export interface ProviderPricingCatalogFetchResult {
  endpoint: 'https://models.dev/api.json'
  fetchedAt: number
  requested: number
  matched: ProviderPricingCatalogEntry[]
}

export interface ProviderModelProfile {
  model: string
  displayName?: string
  aliases?: string[]
  pricing?: ProviderModelPricing
  mediaPricing?: ProviderMediaPricing
  contextWindow?: number
  capabilities?: string[]
  /** Main-owned evidence from a bounded generation probe; declarations remain separate. */
  verification?: ProviderModelVerification
}

export interface ProviderModelVerification {
  generation: 'passed' | 'failed'
  outcome: ProviderGenerationProbeOutcome
  protocol: ProviderDiagnosticGenerationProtocol
  verifiedAt: number
  /** Absent on legacy HTTP-status-only observations. */
  responseValidation?: 'protocol-json-v1'
}
export interface ProviderEndpointProfile {
  id: string
  url: string
  priority?: number
  enabled?: boolean
  protocol?: OpenAIProtocol
  /** Non-secret routing metadata used by hard policy checks. */
  region?: string
  domain?: string
  permissionTags?: string[]
}

export interface ProviderAppBinding {
  accountId?: string
  endpointId?: string
  modelMap?: Record<string, string>
}

export type ProviderReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
export type ProviderOutputVerbosity = 'low' | 'medium' | 'high'
export type ProviderServiceTier = 'auto' | 'default' | 'flex' | 'priority'

/** Typed Provider request controls. These never contain credentials. */
export interface ProviderRuntimeConfig {
  reasoningEffort?: ProviderReasoningEffort
  verbosity?: ProviderOutputVerbosity
  temperature?: number
  topP?: number
  maxOutputTokens?: number
  parallelToolCalls?: boolean
  storeResponses?: boolean
  serviceTier?: ProviderServiceTier
  anthropic?: ProviderAnthropicRuntimeConfig
  gemini?: ProviderGeminiRuntimeConfig
}

/** Versioned, non-secret extension point for provider configuration. */
export interface ProviderAdvancedConfig {
  schemaVersion: 1
  endpoints?: ProviderEndpointProfile[]
  modelProfiles?: ProviderModelProfile[]
  appBindings?: Record<string, ProviderAppBinding>
  runtime?: ProviderRuntimeConfig
  request?: {
    headers?: Record<string, string>
    query?: Record<string, string>
    body?: Record<string, unknown>
  }
  balanceQuery?: import('./provider-balance-types').ProviderBalanceQueryConfig
  billingQuery?: import('./provider-billing-query-types').ProviderBillingQueryConfig
  reliability?: import('./provider-reliability-types').ProviderReliabilityConfig; metadata?: Record<string, string>
}

export type SessionStatus = 'starting' | 'running' | 'idle' | 'error' | 'closed'
/** Agent 引擎标识:anthropic = Anthropic Messages API;openai = OpenAI-compatible API。 */
/** Native model engine identity: Anthropic Messages, Google Generative Language, or OpenAI-compatible. */
export type EngineKind = 'anthropic' | 'gemini' | 'openai'
export interface EngineInfo {
  kind: string
  label: string
  /** 该引擎在本机是否可用(CLI 已安装等) */
  available: boolean
  /** 可选引擎不参与默认启动或发布门禁。 */
  optional?: boolean
  /** 用户是否已保存候选 Provider 凭据；不代表端点协议兼容该引擎。 */
  configured?: boolean
}

export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

export type ContextPressureLevel = 'normal' | 'warning' | 'critical'

/**
 * OpenAI Responses 服务端上下文的持久投影。
 *
 * response id 只能在同一 Provider、模型、协议和凭据链内续用；
 * 它不是通用的会话身份，恢复时必须做严格匹配，失败则回退本地转录。
 */
export interface ResponsesConversationContext {
  responseId: string
  providerId: string
  model: string
  protocol: 'responses'
  keyId?: string
  generation: number
  updatedAt: number
}

export interface SessionMeta extends BusinessLineBinding, SessionRuntimeRoutingBinding {
  reasoningEffort?: ProviderReasoningEffort
  memoryOverrides?: import('./memory-preferences-types').MemoryOverrides
  executionEnvironment?: import('./wsl-types').ExecutionEnvironmentBinding
  sideChat?: SideChatBinding
  workspaceHandoff?: WorkspaceHandoffReceipt
  workspaceHandoffPending?: string
  id: string
  /** Session-only memory identity retained by explicit resume; never inherited by new tasks or forks. */
  taskMemorySessionId?: string
  title: string
  cwd: string
  /** CaoGen Drive 档位:控制默认模型路由、预算、验证深度和工具权限策略。 */
  driveMode?: CaoGenDriveMode
  /** 父会话 ID;存在时此会话是主会话派出的真实子 Agent。 */
  parentSessionId?: string
  /** 一次子代理编排批次 ID,用于聚合同一轮派活。 */
  orchestrationId?: string
  /** 子代理任务 ID;父会话下唯一。 */
  childTaskId?: string
  /** 子代理角色/分工,如 frontend/backend/test/review。 */
  childRole?: string
  /** 是否使用 CaoGen managed Git worktree 隔离运行。 */
  isolated?: boolean
  /** 用户最初选择的目录;隔离会话中 cwd 会改为 worktree 内对应目录。 */
  sourceCwd?: string
  /** 旧目录型 Project 身份；仅用于兼容路径/规则，不是 1.0 Workspace 所有权。 */
  projectId?: string
  /** 1.0 ProjectWorkspace 的 canonical 所有权边界。 */
  workspaceId?: string
  /** 显式关联的 canonical Goal；存在时必须同时存在 workspaceId。 */
  goalId?: string
  /** 显式关联的 canonical WorkItem；Run 不得用 Session/DAG 身份替代它。 */
  workItemId?: string
  digitalWorkerBinding?: DigitalWorkerBinding
  /** 明确不归属项目的会话;仍保留工作目录供工具执行。 */
  unassigned?: boolean
  /** Assistant 托管个人 Workspace 的稳定容器身份；不等同于 canonical 工作流 Workspace 所有权。 */
  personalWorkspaceId?: string
  /** 创建该任务时的界面模式快照；只影响任务入口展示，不改变全局偏好或执行合同。 */
  experienceModeOverride?: 'assistant' | 'studio'
  /** 原仓库根目录。 */
  repoRoot?: string
  /** CaoGen 管理的 worktree 根目录。 */
  worktreePath?: string
  /** worktree 分支名。 */
  branch?: string
  /** 创建 worktree 时的基点分支;detached HEAD 时为空。 */
  baseBranch?: string | null
  /** 创建 worktree 时的 HEAD sha。 */
  baseSha?: string
  /** managed worktree 生命周期状态。 */
  worktreeState?: 'active' | 'removed'
  /** 空字符串表示跟随 CLI 默认模型 */
  model: string
  /** 此会话当前绑定的 Provider ID;全局自动模式会在创建时选定。 */
  providerId: string
  /** fixed=指定模型;provider=仅厂商内调度;global=跨厂商调度。 */
  routingScope?: SessionRoutingScope
  /** 本会话预算上限;0/undefined = 继承 Provider 或全局设置。 */
  budgetUsd?: number
  /** 下次 resume SDK 会话时截断到此用户消息/检查点。 */
  resumeSessionAt?: string
  /** Agent 引擎;由会话 Provider 配置自动决定。 */
  engine?: EngineKind
  /** 查看/规划/执行；决定任务是否可以产生外部或工作区副作用。 */
  taskStrategy: TaskStrategy
  /** Once enabled, recovery/import requires an explicit local file grant; never reset to legacy. */
  taskExecutionAuthorityRequired?: true
  /**
   * 权限模式（派生只读）。
   * 收编后此字段由 derivePermissionModeFromStrategy(taskStrategy) 派生，
   * 不再接受用户或模型直接设置。旧值仅用于老会话迁移检测。
   * 值域不变:'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
   *   - 'plan':保留用于向后兼容，不再被派生给任何 TaskStrategy
   *   - 'bypassPermissions':仅 Routine 可用，会话内不出现
   */
  permissionMode: PermissionModeId
  status: SessionStatus
  sdkSessionId?: string
  /** 显式跨 Provider/模型分叉的直接来源；仅用于本地账本继承，不可作为 SDK resume id。 */
  conversationForkSourceSdkSessionId?: string
  /** 消息级分叉的截断边界；新账本只继承该 checkpoint 对应用户轮次之前的历史。 */
  conversationForkCheckpointId?: string
  /** 分叉来源的 CaoGen Session；用于把新 Run 绑定到明确的前驱，而不复用旧 Session 身份。 */
  conversationForkSourceSessionId?: string
  /** 分叉时观察到的 canonical source Run；新 Session 会创建独立 successor Run。 */
  conversationForkSourceRunId?: string
  /** OpenAI Responses 服务端上下文；仅在严格身份匹配时恢复。 */
  responsesContext?: ResponsesConversationContext
  costUsd: number
  usage: UsageTotals
  contextTokens: number
  contextWindowTokens?: number
  contextRemainingTokens?: number
  contextUsageRatio?: number
  contextPressure?: ContextPressureLevel
  createdAt: number
  lastError?: string
}
export interface HistoryEntry extends BusinessLineBinding, SessionRuntimeRoutingBinding, Pick<SessionMeta, 'budgetUsd'> {
  reasoningEffort?: ProviderReasoningEffort
  memoryOverrides?: import('./memory-preferences-types').MemoryOverrides
  executionEnvironment?: import('./wsl-types').ExecutionEnvironmentBinding
  sideChat?: SideChatBinding
  workspaceHandoff?: WorkspaceHandoffReceipt
  workspaceHandoffPending?: string
  id: string
  taskMemorySessionId?: string
  title: string
  cwd: string
  driveMode?: CaoGenDriveMode
  parentSessionId?: string
  orchestrationId?: string
  childTaskId?: string
  childRole?: string
  isolated?: boolean
  sourceCwd?: string
  /** 旧目录型 Project 身份；仅用于兼容路径/规则。 */
  projectId?: string
  workspaceId?: string
  goalId?: string
  workItemId?: string
  digitalWorkerBinding?: DigitalWorkerBinding
  unassigned?: boolean
  personalWorkspaceId?: string
  /** 创建该任务时的界面模式快照；历史恢复时仅作展示参考。 */
  experienceModeOverride?: 'assistant' | 'studio'
  repoRoot?: string
  worktreePath?: string
  branch?: string
  baseBranch?: string | null
  baseSha?: string
  worktreeState?: 'active' | 'removed'
  model: string
  providerId: string
  routingScope?: SessionRoutingScope
  engine?: EngineKind
  /** 旧历史缺失时迁移为 execute。 */
  taskStrategy?: TaskStrategy
  taskExecutionAuthorityRequired?: true
  permissionMode: PermissionModeId
  sdkSessionId: string
  /** 显式跨 Provider/模型分叉的直接来源；新会话拥有独立 sdkSessionId。 */
  conversationForkSourceSdkSessionId?: string
  conversationForkCheckpointId?: string
  conversationForkSourceSessionId?: string
  conversationForkSourceRunId?: string
  /** OpenAI Responses 服务端上下文；仅在严格身份匹配时恢复。 */
  responsesContext?: ResponsesConversationContext
  createdAt: number
  updatedAt: number
  costUsd: number
  resumeSessionAt?: string
  /** 归档:从主列表收起到归档区(不删) */
  archived?: boolean
  /** 置顶:排在最前 */
  pinned?: boolean
}
export interface CreateSessionOptions extends BusinessLineBinding {
  reasoningEffort?: ProviderReasoningEffort
  executionEnvironment?: import('./wsl-types').ExecutionEnvironmentSelection
  /** Main-process-only side-chat binding; never accepted from renderer IPC. */
  sideChat?: SideChatBinding
  cwd: string
  /** 旧目录型 Project 身份；新工作流归属使用 workspaceId。 */
  projectId?: string
  /** 1.0 ProjectWorkspace 的 canonical 所有权边界。 */
  workspaceId?: string
  goalId?: string
  workItemId?: string
  unassigned?: boolean
  personalWorkspaceId?: string
  /** 单任务界面模式覆盖；不得写回全局 experienceMode 偏好。 */
  experienceModeOverride?: 'assistant' | 'studio'
  driveMode?: CaoGenDriveMode
  parentSessionId?: string
  orchestrationId?: string
  childTaskId?: string
  childRole?: string
  /** undefined = Git 仓库自动隔离;false = 主工作区直接运行;true = 强制隔离。 */
  isolated?: boolean
  model?: string
  providerId?: string
  routingScope?: SessionRoutingScope
  /** 全局自动调度在创建引擎前用首条请求选定初始 Provider。 */
  initialPrompt?: string
  budgetUsd?: number
  resumeSessionAt?: string
  /** 兼容旧调用;新会话会忽略此值并从 Provider 解析引擎。 */
  engine?: EngineKind
  /** 可选执行器约束；模型选择不得改变该执行器，旧 engine 提示仍按原规则兼容。 */
  executorEngine?: EngineKind
  taskStrategy?: TaskStrategy
  /**
   * @deprecated 收编后此字段被后端忽略。
   * permissionMode 由 taskStrategy 派生，不接受外部设置。
   * 保留字段仅为向后兼容旧调用方(IDE bridge、resumeFromHistory 等)。
   */
  permissionMode?: PermissionModeId
  /** 传入历史会话的 sdkSessionId 可恢复上下文 */
  resumeSdkSessionId?: string
  /** 从历史账本创建全新会话；与 resumeSdkSessionId 互斥，不复用任何 Provider 服务端上下文。 */
  forkFromSdkSessionId?: string
  /** 可选的消息级分叉边界；只能与 forkFromSdkSessionId 同时使用。 */
  forkCheckpointId?: string
  title?: string
}

export interface DispatchSubagentTaskInput {
  id?: string
  title?: string
  role?: string
  prompt: string
  cwd?: string
  isolated?: boolean
  driveMode?: CaoGenDriveMode
  model?: string
  providerId?: string
  engine?: EngineKind
  /**
   * @deprecated 收编后子会话 permissionMode 由 taskStrategy 派生，此字段被忽略。
   */
  permissionMode?: PermissionModeId
  /** 新增:子任务策略。未指定时继承父会话 taskStrategy。 */
  taskStrategy?: TaskStrategy
}

export interface DispatchSubagentsInput {
  tasks: DispatchSubagentTaskInput[]
  cwd?: string
  isolated?: boolean
  driveMode?: CaoGenDriveMode
  model?: string
  providerId?: string
  engine?: EngineKind
  permissionMode?: PermissionModeId
}

export interface SubagentDispatchItem {
  taskId: string
  prompt: string
  meta: SessionMeta
}

export interface SubagentDispatchResult {
  orchestrationId: string
  parentSessionId: string
  children: SubagentDispatchItem[]
}

export interface SubagentResult {
  orchestrationId?: string
  childTaskId?: string
  childSessionId: string
  childRole?: string
  status: 'done' | 'error'
  resultText?: string
  costUsd?: number
  durationMs?: number
}

export type TaskDagRole = 'frontend' | 'backend' | 'qa' | 'docs' | 'devops' | 'review' | 'general'

export type TaskDagComplexity = 'single' | 'multi'

export interface TaskDagTask {
  id: string
  title: string
  description: string
  dependencies: string[]
  role: TaskDagRole
  prompt: string
  /** Approved Project plan steps bind child Runs to their projected canonical WorkItem. */
  workItemId?: string
}

export interface TaskDag {
  id: string
  title: string
  source: string
  complexity: TaskDagComplexity
  createdAt: number
  tasks: TaskDagTask[]
}

export interface TaskDecomposeInput {
  request: string
  cwd?: string
  /** 强推理模型拆解开关;false 时只使用本地启发式拆解。 */
  useModel?: boolean
  /** 可选:覆盖用于 DAG 拆解的 Provider。 */
  providerId?: string
  /** 可选:覆盖用于 DAG 拆解的模型。 */
  model?: string
}

export interface TaskDecomposeResult {
  dag: TaskDag
  strategy: 'local-heuristic' | 'model'
  reason: string
  warnings: string[]
}

export type TaskDagTaskStatus = 'waiting' | 'running' | 'success' | 'failed'
export type TaskDagExecutionStatus = 'waiting' | 'running' | 'success' | 'failed'

export interface TaskDagExecutionTask {
  task: TaskDagTask
  status: TaskDagTaskStatus
  attempts: number
  sessionIds: string[]
  startedAt?: number
  completedAt?: number
  resultText?: string
  error?: string
}

export interface TaskDagExecutionView {
  id: string
  parentSessionId: string
  dag: TaskDag
  status: TaskDagExecutionStatus
  maxRetries: number
  startedAt: number
  completedAt?: number
  layers: string[][]
  tasks: TaskDagExecutionTask[]
  summary?: string
  error?: string
  autoMerge?: TaskDagAutoMergeView
  finalization?: TaskDagFinalizationView
}

export interface TaskDagRuntimeDispatchOptions {
  cwd?: string
  isolated?: boolean
  driveMode?: CaoGenDriveMode
  model?: string
  providerId?: string
  engine?: EngineKind
  permissionMode?: PermissionModeId
  taskTimeoutMs: number
}

export interface TaskDagRuntimeRunningTask {
  taskId: string
  sessionId: string
}

export interface TaskDagRuntimeAutoMergeOptions {
  enabled: boolean
  verificationCommand?: string
}

export interface TaskDagRuntimeMergeSession {
  sessionId: string
  taskId?: string
  repoRoot?: string
  worktreePath?: string
  baseSha?: string
  branch?: string
  resultText?: string
}

export interface TaskDagRuntimeSnapshot {
  council?: import('./council-types').CouncilRuntimeBinding
  executionId: string
  parentSessionId: string
  capturedAt: number
  dispatchOptions: TaskDagRuntimeDispatchOptions
  runningTasks: TaskDagRuntimeRunningTask[]
  recoveryBlockedError?: string
  mergeSessions?: TaskDagRuntimeMergeSession[]
  autoMerge?: TaskDagRuntimeAutoMergeOptions
}
export interface TaskDagDispatchInput {
  dag: TaskDag
  cwd?: string
  isolated?: boolean
  driveMode?: CaoGenDriveMode
  model?: string
  providerId?: string
  engine?: EngineKind
  permissionMode?: PermissionModeId
  maxRetries?: number
  /** Per-child timeout in milliseconds. Omit for the default watchdog; <=0 disables it. */
  taskTimeoutMs?: number
  /** 自动合并默认关闭；显式开启后才会把成功子任务 worktree 合回主工作区。 */
  autoMerge?: boolean
  /** 覆盖 caogen.md 中的验收命令，主要用于测试和临时调度。 */
  verificationCommand?: string
}

export interface TaskDagDispatchResult {
  execution: TaskDagExecutionView
  /** 当前调度调用已经启动的 child sessions;后续依赖层通过 task-dag-update 同步。 */
  children: SubagentDispatchItem[]
}

export type TaskSnapshotReason =
  | 'created'
  | 'important-event'
  | 'event-batch'
  | 'shutdown'
  | 'recovered'

/** 会话事件的耐久身份:seq 用于有序回放,eventId 用于跨重启去重。 */
export interface AgentEventIdentity {
  schemaVersion: 1
  streamId: string
  eventId: string
  seq: number
  occurredAt: number
  causationId?: string
  correlationId?: string
}

export interface AgentEventCursor {
  seq: number
  eventId?: string
}

export interface TaskSnapshotWorktreeInfo {
  isolated?: boolean
  sourceCwd?: string
  repoRoot?: string
  worktreePath?: string
  branch?: string
  baseBranch?: string | null
  baseSha?: string
  state?: 'active' | 'removed'
}

export interface TaskSnapshotExecutionPosition {
  status: SessionStatus
  lastSeq: number
  /** 显式恢复游标;旧快照只有 lastSeq 时仍可恢复。 */
  cursor?: AgentEventCursor
  lastEventId?: string
  lastEventKind?: AgentEvent['kind']
  lastEventAt: number
  sdkSessionId?: string
  resumeSessionAt?: string
  lastCheckpointMessageId?: string
  lastUserMessageId?: string
}

export interface TaskSnapshotReplayCandidate {
  messageId: string
  text: string
  seq: number
  capturedAt: number
  reason: 'running-user-message'
}

export type TaskSnapshotSubtaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'closed'

export interface TaskSnapshotSubtaskState {
  taskId?: string
  role?: string
  sessionId: string
  status: TaskSnapshotSubtaskStatus
  resultText?: string
  costUsd?: number
  branch?: string
  worktreePath?: string
}

export interface ConversationLedgerIntegrityView {
  schemaVersion: 1
  valid: boolean
  mode: 'empty' | 'legacy' | 'sealed'
  entryCount: number
  headDigest?: string
  error?: string
}

export interface TaskSnapshotRecord {
  id: string
  taskId: string
  sessionId: string
  title: string
  projectPath: string
  engine?: EngineKind
  model: string
  providerId: string
  createdAt: number
  updatedAt: number
  eventCount: number
  reason: TaskSnapshotReason
  meta: SessionMeta
  execution: TaskSnapshotExecutionPosition
  /** Provider 无关会话账本的持久完整性投影；旧快照可缺失。 */
  conversationLedger?: ConversationLedgerIntegrityView
  run?: TaskRunRecord
  replayCandidate?: TaskSnapshotReplayCandidate
  worktree?: TaskSnapshotWorktreeInfo
  transcript: TranscriptEntry[]
  subtasks: TaskSnapshotSubtaskState[]
  dagExecutions: TaskDagExecutionView[]
  dagRuntimes?: TaskDagRuntimeSnapshot[]
}

export type AppLanguage = 'zh' | 'en'

/** 主题偏好:白天(主白副黑)/ 夜晚(主黑副白)/ 跟随系统 */
export type AppTheme = 'light' | 'dark' | 'system'

/** 收藏的项目目录(快速新建会话) */
export interface Project {
  id: string
  name: string
  path: string
  lastUsedAt: number
  /** 归档项目保留会话关联，但不参与新建会话选择。 */
  archived?: boolean
}

export interface ProjectUpdate {
  name?: string
  archived?: boolean
}

export type ProjectContextFileName = 'caogen.md' | '.caogen.md' | 'README.md'

export interface ProjectContextSource {
  fileName: ProjectContextFileName
  path: string
  bytes: number
  truncated: boolean
}

export interface ProjectDetectedStack {
  packageName?: string
  packageManager?: string
  nodeScripts: Array<{ name: string; command: string }>
  dependencies: Array<{ name: string; version: string; scope: 'runtime' | 'dev' }>
  techStack: string[]
  python?: { projectName?: string; dependencies: string[] }
  go?: { module?: string; version?: string; requirements: string[] }
  rust?: { packageName?: string; dependencies: string[] }
}

export interface ProjectContextReadResult {
  projectRoot: string
  source?: ProjectContextSource
  content: string
  detected: ProjectDetectedStack
  template: string
  prompt: string
}

/** 项目记忆:确认制条目(agent 提议 → 用户批准)。按项目隔离 */
export interface ProjectMemoryEntry {
  id: string
  kind: string
  title: string
  body: string
  source: string
  reason: string
  createdAt: string
  updatedAt: string
  version?: number
  supersedes?: string
  digest?: string
}
export interface ProjectMemoryDraft extends ProjectMemoryEntry {
  status: 'draft'
}
export interface ProjectMemoryDraftInput {
  kind: string
  title: string
  body: string
  source: string
  reason: string
  supersedes?: string
}
export interface ReadProjectMemoryResult {
  projectHash: string
  markdown: string
  entries: ProjectMemoryEntry[]
  drafts: ProjectMemoryDraft[]
}

export type MemoryLayer = 'working' | 'project' | 'user'

export interface LayeredMemoryEntry {
  id: string
  layer: MemoryLayer
  projectHash?: string
  sessionId?: string
  workItemId?: string
  title: string
  body: string
  source: string
  tags: string[]
  createdAt: string
  updatedAt: string
  lastUsedAt: string
  archivedAt?: string
  vector: Record<string, number>
}

export interface LayeredMemoryWriteInput {
  layer: MemoryLayer
  projectRoot?: string
  title: string
  body: string
  source: string
  tags?: string[]
}

export interface LayeredMemoryUpdateInput {
  expectedUpdatedAt?: string
  title?: string
  body?: string
  tags?: string[]
  archivedAt?: string | null
}

export interface LayeredMemorySearchInput {
  query: string
  projectRoot?: string
  layers?: MemoryLayer[]
  includeArchived?: boolean
  limit?: number
}

export interface LayeredMemorySearchHit {
  entry: LayeredMemoryEntry
  score: number
}

export interface MemorySuggestionEvent {
  sessionId: string
  text: string
}

export type StartSuggestionPriority = 'high' | 'medium' | 'low'

export interface StartSuggestion {
  id: string
  title: string
  body: string
  source: string
  priority: StartSuggestionPriority
  prompt: string
}

export type OfficeQualityMode = 'auto' | 'high' | 'balanced' | 'low'
export type OfficeSpaceTheme = 'control-room' | 'creative-studio' | 'quiet-library'
export type OfficeOutfitPalette = 'role-default' | 'graphite' | 'teal' | 'rose'
export type OfficeHairStyle = 'role-default' | 'short' | 'long' | 'tied'
export type OfficeTeamLayout = 'grid' | 'team-photo'
export interface OfficeSettings {
  /** 3D 控制室画质;auto 仅持久化请求档位,实际档位由运行时测量决定。 */
  qualityMode: OfficeQualityMode
  /** 高清像素独立于阴影/特效；adaptive 明确允许以分辨率换取速度。 */
  resolutionMode?: 'sharp' | 'adaptive'
  /** 显示桌上厂商工牌 */
  showBadges: boolean
  /** 控制室动效强度倍率(0.2 静态 ~ 1.2 活跃) */
  liveliness: number
  /** 趣味外观:给小人加猫耳 */
  catEars: boolean
  /** 原创空间主题，不改变真实任务/状态投影。 */
  spaceTheme: OfficeSpaceTheme
  /** 水墨角色服装色调；仅作为原创资产视觉处理。 */
  outfitPalette: OfficeOutfitPalette
  /** 水墨角色发型轮廓。 */
  hairStyle: OfficeHairStyle
  /** 常规工位或团队合影式排布。 */
  teamLayout: OfficeTeamLayout
}

export type ChatDensity = 'comfortable' | 'compact'

export interface LayoutSettings {
  /** One-time migration marker for the compact desktop sidebar geometry. */
  sidebarDesignVersion?: number
  /** 桌面侧栏是否收回;窄屏仍走抽屉模式。 */
  sidebarCollapsed: boolean
  /** 桌面侧栏宽度(px)。 */
  sidebarWidth: number
  /** 工作台右侧工具面板宽度(px)。 */
  workbenchSideWidth: number
  /** 工作台底部终端 Dock 高度(px)。 */
  workbenchDockHeight: number
  /** 聊天内容缩放倍率。 */
  chatScale: number
  /** 聊天内容密度。 */
  chatDensity: ChatDensity
}

export interface AppSettings extends BusinessLineSettings {
  wsl?: import('./wsl-types').WslPreferences
  workspaceBehavior?: import('./workspace-behavior-types').WorkspaceBehaviorPreferences
  gitPreferences?: import('./desktop-git-preferences').DesktopGitPreferences
  desktopPersonalization?: import('./desktop-personalization').DesktopPersonalizationSettings
  notificationPreferences?: import('./desktop-behavior-preferences').DesktopNotificationPreferences
  terminalPreferences?: import('./desktop-behavior-preferences').TerminalPreferences
  /** Visibility of task examples and opt-in task-context suggestions. */
  suggestedPrompts?: import('./suggested-prompt-settings').SuggestedPromptSettings
  followUpBehavior?: import('./session-follow-up').SessionFollowUpBehavior
  memoryPreferences?: import('./memory-preferences-types').MemoryPreferences
  browserDebug?: import('./browser-debug-types').BrowserDebugPreferences
  /** Optional overrides; omitted shortcuts retain the shared registry defaults. */
  desktopShortcuts?: import('./desktop-shortcuts').DesktopShortcutSettings
  /** Local font families for interface text and code/terminal surfaces. */
  desktopFonts?: import('./desktop-fonts').DesktopFontSettings
  /** Optional desktop companion window preference. */
  voiceInput?: VoiceInputSettings
  /** CaoGen Drive 默认档位;新会话默认继承此档位。 */
  driveMode: CaoGenDriveMode
  /** 新任务默认策略;单个 Session 可以显式覆盖且不改写该偏好。 */
  defaultTaskStrategy: TaskStrategy
  /** 助手、项目工作台或视频工作室的默认顶层入口。 */
  experienceMode: 'assistant' | 'studio' | 'video'
  /** 用户已忽略的可解释体验建议；只隐藏同一输入版本，不允许系统静默应用建议。 */
  experienceRecommendationDismissedId: string
  /** 空字符串 = 跟随 CLI 默认 */
  defaultModel: string
  defaultPermissionMode: PermissionModeId
  /** 新会话默认使用的 Provider ID;空字符串 = 不设置默认,创建时必须显式选择。 */
  defaultProviderId: string
  /** 自动调度备用 Provider/模型;空字符串 = 不设置。 */
  fallbackProviderId: string
  fallbackModel: string
  /** 成本优先或轻量任务偏好的 Provider/模型;空字符串 = 交给自动路由。 */
  lowCostProviderId: string
  lowCostModel: string
  /** 复杂推理/高风险任务偏好的 Provider/模型;空字符串 = 交给自动路由。 */
  strongReasoningProviderId: string
  strongReasoningModel: string
  /** 审查/复核任务偏好的 Provider/模型;空字符串 = 交给自动路由。 */
  reviewProviderId: string
  reviewModel: string
  /** 调研任务偏好;空字符串 = 按长上下文/视觉/总结能力自动选择。 */
  researchProviderId: string
  researchModel: string
  /** 策划与方案任务偏好。 */
  planningProviderId: string
  planningModel: string
  /** 开发与编码任务偏好。 */
  codingProviderId: string
  codingModel: string
  /** 测试、QA 与验收任务偏好。 */
  testingProviderId: string
  testingModel: string
  /** 文档、README 与规格编写任务偏好。 */
  documentationProviderId: string
  documentationModel: string
  /** 自动调度策略 */
  schedulerStrategy: SchedulerStrategy
  /** 用户自定义调度规则;按顺序匹配用户请求关键词。 */
  modelRoutingRules: ModelRoutingRule[]
  /** 多模型智能混合调度: 默认关闭, 开启后 auto 会话按任务/预算/覆盖路由 */
  smartModelRoutingEnabled: boolean
  /** P2-003 自动交叉验证执行开关；默认关闭，仅在智能调度生成复核计划后派发第二模型 */
  modelCrossValidationAutoRunEnabled: boolean
  /** 专家路由边界；在初始选路、恢复和实际 Provider 请求前强制执行。 */
  routingExpertPolicy: RoutingExpertPolicy
  /** 单会话全局预算上限;0 = 不限制 */
  budgetUsdPerSession: number
  /** 月度总预算上限;0 = 不限制,用于 P2-003 成本管控和自动降级 */
  budgetUsdPerMonth: number
  /** 厂商故障时自动切换到其他 Provider 重试(M4.1) */
  failoverEnabled: boolean
  /** Provider circuit breaker thresholds and recovery policy. */
  providerCircuitBreaker: ProviderCircuitBreakerSettings
  /** 界面语言 */
  language: AppLanguage
  /** 主题:light 白天 / dark 夜晚 / system 跟随系统 */
  theme: AppTheme
  /** 人设:追加到系统提示词的自定义指令 */
  persona: string
  /** 权限:工具白名单(每行一个,空=不限制) */
  allowedTools: string
  /** 权限:工具黑名单(每行一个) */
  disallowedTools: string
  /** 本地执行策略;disabled 为旧严格容器设置的确认态,其他模式也都不是系统级沙箱。 */
  sandboxMode: SandboxMode
  /** 国产生态镜像:默认关闭;开启后才向本地命令注入 npm/pip 镜像配置 */
  chinaEcosystemMirrorEnabled: boolean
  /** 国产生态镜像:npm registry,仅 chinaEcosystemMirrorEnabled=true 时生效 */
  chinaNpmRegistry: string
  /** 国产生态镜像:pip index-url,仅 chinaEcosystemMirrorEnabled=true 时生效 */
  chinaPipIndexUrl: string
  /** 权限白名单规则:支持 tool/path/risk 组合;空表示不额外放行 */
  permissionAllowlist: string
  /** 权限黑名单规则:支持 tool/path/risk 组合;空表示不额外拒绝 */
  permissionDenylist: string
  /** 临时允许规则:同白名单,可追加 until=<ms 时间戳> */
  permissionTemporaryAllowlist: string
  /** 结构化权限规则 schema 版本。 */
  permissionRulesVersion: 2
  /** 结构化用户权限规则；旧文本规则加载后迁移到这里。 */
  permissionRules: PermissionRuleConfig[]
  /** Opt-in native file-only execution, requiring explicit tool and path allow rules. */
  limitedFileExecutionEnabled: boolean
  /** 权限:GUI 自动化总开关;默认关闭,避免 Agent 直接操作真实桌面。 */
  guiAutomationEnabled: boolean
  /** @deprecated 旧全局 GUI grant 占位；主进程始终归零，不再作为授权依据。 */
  guiAutomationTemporaryGrantUntil: number
  /** 桌面通知:关闭后任务完成/权限/失败均不弹系统通知 */
  notificationsEnabled: boolean
  /** 会话运行时阻止显示器休眠(prevent-display-sleep) */
  preventDisplaySleep: boolean
  /** 自动 Skill 沉淀:任务成功完成后后台复盘、验证并写入项目本地 Skill 库。默认关闭。 */
  autoSkillLearningEnabled: boolean
  /** Agent 控制室外观设置 */
  office: OfficeSettings
  /** 工作台布局、缩放和可调节面板设置 */
  layout: LayoutSettings
}

export interface Provider extends ProviderConnectionBinding {
  id: string
  name: string
  /** 空字符串 = 该 Provider 使用引擎/本机默认端点;不会作为新会话隐式默认。 */
  baseUrl: string
  /** 旧版/活动 token 兼容镜像;空字符串也可能表示环境变量或仅当前进程密钥。仅存在于主进程。 */
  encryptedToken: string
  /** 多 API Key 记录;持久化密钥使用安全加密串,sessionOnly 密钥只在当前主进程内存中存在。 */
  apiKeys?: ProviderApiKey[]
  /** 旧版请求头或 Base URL 中不安全/不受支持的信息已被移除,需要用户检查并重新保存。 */
  credentialMigrationRequired?: boolean
  /** 当前活动 API Key;为空时使用第一个可用 key。 */
  activeKeyId?: string
  credentialRoutingMode?: ProviderCredentialRoutingMode
  /** 此 Provider 支持的模型列表(供 UI 下拉) */
  models: string[]
  /** 鉴权方式。旧数据缺省为 api-key；none 只允许本机回环 OpenAI 兼容服务。 */
  authMode?: ProviderAuthMode
  /** 此 Provider 绑定的执行引擎;会话从 Provider 自动继承。 */
  engine?: EngineKind
  /**
   * 允许列表内的非敏感标准/路由元数据头,每行 "Name: value",由原生 HTTP 引擎注入请求。
   * 未知头、畸形行、鉴权/密钥头和疑似凭据值禁止保存;凭据必须通过 Provider API 密钥字段配置。
   */
  customHeaders?: string
  /** 由主进程使用当前 Provider token 注入的受管鉴权头名称;不包含头值。 */
  credentialHeaderNames?: string[]
  /** Provider 级预算上限;0/undefined = 继承全局设置 */
  budgetUsd?: number
  /**
   * OpenAI 引擎协议:'responses'(OpenAI 官方 Responses API,默认)或
   * 'chat'(通用 /v1/chat/completions,DeepSeek/Qwen/网关/自部署 vLLM 等)。
   * 仅 openai 引擎读取;Anthropic Messages 引擎忽略。
   */
  openaiProtocol?: OpenAIProtocol
  /** 用户备注 */
  note?: string
  authorization?: ProviderAuthorization
  advancedConfig?: ProviderAdvancedConfig
  createdAt: number
}

export interface ProviderApiKey {
  id: string
  label: string
  encryptedToken: string
  /** true = 密钥仅保留在当前主进程内存中,不会写入磁盘。 */
  sessionOnly?: boolean
  createdAt: number
  lastUsedAt?: number
  lastFailureAt?: number
  lastFailureReason?: string
  disabled?: boolean
  policy?: ProviderCredentialPolicy
}

export type ProviderCredentialStorage =
  | 'none'
  | 'encrypted'
  | 'session'
  | 'legacy-b64'
  | 'unavailable'
  | 'mixed'

export interface ProviderApiKeyView {
  id: string
  label: string
  createdAt: number
  lastUsedAt?: number
  lastFailureAt?: number
  lastFailureReason?: string
  disabled: boolean
  active: boolean
  credentialStorage: ProviderCredentialStorage
  /** 当前主进程是否能够解析并使用该密钥。 */
  available: boolean
  policy: ProviderCredentialPolicy
  monthlySpendUsd: number
  balanceRemainingUsd?: number
  routingBlockedReason?: string
}

/** OpenAI 引擎可用的 API 协议 */
export type OpenAIProtocol = 'responses' | 'chat'

/** Provider 鉴权方式；none 仅用于无需密钥的本机回环服务。 */
export type ProviderAuthMode = 'api-key' | 'none'

/** 渲染进程可见的 Provider:不含密钥,只标记是否已配置 token */
export interface ProviderView {
  id: string
  name: string
  baseUrl: string
  models: string[]
  authMode: ProviderAuthMode
  /** 已具备可路由条件：无需鉴权，或至少有一把当前可用密钥。 */
  ready: boolean
  engine: EngineKind
  customHeaders?: string
  credentialHeaderNames?: string[]
  budgetUsd: number
  openaiProtocol?: OpenAIProtocol
  note?: string
  authorization?: ProviderAuthorization
  advancedConfig?: ProviderAdvancedConfig
  createdAt: number
  hasToken: boolean
  credentialStorage: ProviderCredentialStorage
  credentialMigrationRequired?: boolean
  keyCount?: number
  activeKeyId?: string
  activeKeyLabel?: string
  credentialRoutingMode: ProviderCredentialRoutingMode
  credentialRouteReason?: string
  apiKeys?: ProviderApiKeyView[]
}

export interface ImageAttachmentView {
  id: string
  hash: string
  path: string
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | string
  bytes: number
  createdAt: string
}

export type ImageAttachmentResult =
  | ({ ok: true } & ImageAttachmentView)
  | { ok: false; error: string; effectStatus?: EffectStatus; operationId?: string; snapshotId?: string }

export interface DocumentAttachmentView {
  id: string
  hash: string
  path: string
  name: string
  mime: 'text/plain; charset=utf-8'
  bytes: number
  createdAt: string
  dataClass: 'S2' | 'S3'
}

export type DocumentAttachmentResult =
  | ({ ok: true } & DocumentAttachmentView)
  | { ok: false; error: string; effectStatus?: EffectStatus; operationId?: string; snapshotId?: string }

/** OCR 结果(引擎:macOS Vision 或 tesseract) */
export interface ImageOcrResult {
  ok: boolean
  text?: string
  engine?: 'vision' | 'tesseract'
  error?: string
}

export interface SaveImageAttachmentBytesInput {
  data: string | ArrayBuffer
  mime?: string
}

export interface ProviderInput {
  name: string
  baseUrl: string
  models: string[]
  authMode?: ProviderAuthMode
  engine?: EngineKind
  customHeaders?: string
  /** 额外受管鉴权头名称;头值始终取 Broker 中的 Provider token。 */
  credentialHeaderNames?: string[]
  budgetUsd?: number
  openaiProtocol?: OpenAIProtocol
  note?: string
  authorization?: ProviderAuthorization
  /** null explicitly clears an existing Provider's advanced configuration. */
  advancedConfig?: ProviderAdvancedConfig | null
  /** 明文 token,经 IPC 传入主进程;安全存储可用时加密落盘,否则仅当前进程可用。 */
  token?: string
  /** 主/活动密钥标签;不含密钥值,可回传渲染进程。 */
  tokenLabel?: string
  /** 新增的明文 token 列表;安全存储不可用时不会持久化。 */
  additionalTokens?: ProviderApiKeyInput[]
  /** 只更新密钥元数据,不包含明文 token。 */
  keyUpdates?: ProviderApiKeyUpdateInput[]
  /** 删除指定 key;删除后不会回传任何密钥值。 */
  removeKeyIds?: string[]
  /** 设置活动 key;为空或不存在时回落到第一个可用 key。 */
  activeKeyId?: string
  credentialRoutingMode?: ProviderCredentialRoutingMode
}

export type ProviderModelErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'gateway'
  | 'not_found'
  | 'unknown'

export interface ProviderModelFetchInput {
  baseUrl: string
  engine?: EngineKind
  token?: string
  providerId?: string
  customHeaders?: string
  credentialHeaderNames?: string[]
  openaiProtocol?: OpenAIProtocol
  authMode?: ProviderAuthMode
}

export type ProviderModelAttemptResult =
  | 'success'
  | 'auth'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'not_found'
  | 'invalid_response'

export interface ProviderModelFetchAttempt {
  /** Path only. Origin, query parameters, credentials, and response bodies are never exposed. */
  endpointPath: string
  result: ProviderModelAttemptResult
  status?: number
}

export type ProviderDiagnosticGenerationProtocol =
  | 'openai-responses'
  | 'openai-chat-completions'
  | 'anthropic-messages'
  | 'google-generative-language'

export type ProviderDiagnosticCredentialSource = 'explicit' | 'stored-active' | 'none'

export interface ProviderModelDiagnosticContext {
  engine: EngineKind
  generationProtocol: ProviderDiagnosticGenerationProtocol
  /** Path only. The Provider origin, query string, model id, and credentials are excluded. */
  generationEndpointPath: string
  credentialSource: ProviderDiagnosticCredentialSource
  /** Optional user-defined key label; never contains the credential value. */
  credentialLabel?: string
  catalogProbeOnly: true
}

export type ProviderModelFailureReason =
  | 'credentials_missing'
  | 'credentials_rejected'
  | 'base_url_invalid'
  | 'base_url_or_credentials_mismatch'
  | 'model_catalog_unavailable'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'network_unavailable'
  | 'unknown'

export type ProviderModelSuggestedAction =
  | 'enter_credentials'
  | 'review_credentials'
  | 'review_base_url_and_credentials'
  | 'enter_models_manually'
  | 'retry_later'
  | 'check_network'
  | 'review_configuration'

export interface ProviderModelFetchError {
  kind: ProviderModelErrorKind
  message: string
  status?: number
  providerId?: string
  baseUrl: string
  reasonCode: ProviderModelFailureReason
  suggestedAction: ProviderModelSuggestedAction
  credentialStyle: {
    authMode: ProviderAuthMode
    headerNames: string[]
  }
  diagnosticContext: ProviderModelDiagnosticContext
  attempts: ProviderModelFetchAttempt[]
}

export interface ProviderModelFetchResult {
  ok: boolean
  providerId?: string
  baseUrl: string
  cacheKey: string
  models: string[]
  fetchedAt?: number
  latencyMs?: number
  stale: boolean
  error?: ProviderModelFetchError
}

export interface ProviderGenerationProbeInput extends ProviderModelFetchInput {
  model: string
}

export type ProviderGenerationProbeOutcome =
  | 'success'
  | 'auth'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'not_found'
  | 'invalid_request'
  | 'invalid_response'

export interface ProviderGenerationProbeResult {
  ok: boolean
  providerId?: string
  protocol: ProviderDiagnosticGenerationProtocol
  /** Path only. Provider origin, query values, model id, credentials, and response bodies are excluded. */
  endpointPath: string
  credentialSource: ProviderDiagnosticCredentialSource
  credentialLabel?: string
  credentialHeaderNames: string[]
  outcome: ProviderGenerationProbeOutcome
  status?: number
  latencyMs: number
  responseValidation?: 'protocol-json-v1'
  /** The probe intentionally requests at most one output token and may be billable. */
  billableRequest: true
}

export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown; signature?: string }

export interface PermissionRequestInfo {
  requestId: string
  toolName: string
  input: unknown
  toolUseId?: string
  decisionReason?: string
  duplicateExecutionId?: string
  riskLevel?: ToolRiskLevel
  /** Main-process-computed capabilities exercised by this tool call. */
  capabilities: ToolSemanticCapability[]
  /** Main-process-computed description; absent when a scoped temporary grant is unsafe. */
  guiGrantScope?: string
  /** Main-process-computed exact non-GUI capability; absent for unstable or high-risk operations. */
  toolGrantScope?: string
  /** Main-process-frozen Effect target; absent for read-only or non-effect calls. */
  effectScope?: PermissionEffectScopeView
}

export interface GuiAutomationGrantView {
  id: string
  kind: 'gui'
  sessionId: string
  toolName: string
  scopeLabel: string
  issuedAt: number
  expiresAt: number
}

export interface ToolCapabilityGrantView {
  id: string
  kind: 'tool'
  sessionId: string
  toolName: string
  scopeLabel: string
  issuedAt: number
  expiresAt: number
  effectTargetDigest: string
}

export type AgentEvent =
  | { kind: 'status'; status: SessionStatus; error?: string }
  | {
      kind: 'init'
      sdkSessionId: string
      model?: string
      tools?: string[]
      permissionMode?: string
    }
  | { kind: 'meta'; meta: SessionMeta }
  | {
      kind: 'user-message'
      text: string
      messageId?: string
      /** Digest of the original text, attachment versions and typed intent for durable send reconciliation. */
      payloadDigest?: string
      attachments?: UserMessageAttachmentView[]
    }
  | {
      kind: 'checkpoint'
      messageId: string
      userMessageId?: string
      scope?: 'chat' | 'both'
    }
  | {
      kind: 'checkpoint-restore'
      messageId: string
      mode?: CheckpointRestoreMode
      filesChanged: string[]
      insertions?: number
      deletions?: number
      chatRemovedEntries?: number
      note?: string
    }
  | {
      kind: 'routing'
      model: string
      reason: string
      providerId: string
      providerName?: string
      decision?: ModelRoutingDecisionView
      crossValidationPlan?: ModelRoutePlanView
    }
  | {
      /** 跨厂商故障切换:旧 Provider 失败,已自动切到新 Provider 重试 */
      kind: 'failover'
      fromProviderId: string
      toProviderId: string
      fromName: string
      toName: string
      /** 切换后使用的模型(目标厂商无模型列表时为空,走其默认) */
      model?: string
      reason: string
    }
  | {
      /** 同一 Provider 内的 API Key 故障切换;仅包含标签和 id,绝不包含密钥值。 */
      kind: 'provider-key-failover'
      providerId: string
      providerName: string
      fromKeyId: string
      fromKeyLabel: string
      toKeyId: string
      toKeyLabel: string
      reason: string
    }
  | {
      /** Same-Provider model recovery; contains routing metadata only. */
      kind: 'provider-model-failover'
      providerId: string
      providerName: string
      fromModel: string
      toModel: string
      reason: string
    }
  | {
      /** Session-scoped OpenAI protocol recovery; never mutates the saved Provider. */
      kind: 'provider-protocol-failover'
      providerId: string
      providerName: string
      model: string
      fromProtocol: 'responses'
      toProtocol: 'chat'
      reason: string
    }
  | {
      /** Automatic Provider recovery is exhausted and requires explicit user action. */
      kind: 'provider-recovery-exhausted'
      engine: EngineKind
      providerId: string
      providerName: string
      model: string
      reason: string
    }
  | { kind: 'text-delta'; text: string }
  | { kind: 'thinking-delta'; text: string }
  | { kind: 'tool-start'; toolUseId: string; name: string }
  | { kind: 'assistant-message'; blocks: AssistantBlock[] }
  | {
      kind: 'tool-result'
      toolUseId: string
      content: string
      isError: boolean
      /** Structured process exit code when the native tool executed a command. */
      exitCode?: number
      commandTermination?: CommandTermination
      effectStatus?: EffectStatus
    }
  | { kind: 'permission-request'; request: PermissionRequestInfo }
  | { kind: 'permission-resolved'; requestId: string; behavior: 'allow' | 'deny' }
  | {
      kind: 'turn-result'
      subtype: string
      isError: boolean
      costUsd?: number
      usage?: UsageTotals
      durationMs?: number
      numTurns?: number
      resultText?: string
    }
  | ({ kind: 'subagent-result' } & SubagentResult)
  | { kind: 'task-dag-update'; execution: TaskDagExecutionView }
  | {
      /** SDK Hook 事件桥:把引擎生命周期钩子转发到时间线(可观测性) */
      kind: 'hook-event'
      event: string
      toolName?: string
      detail?: string
      /** 用户 shell 钩子执行结果(配置了才有) */
      shellCommand?: string
      shellOk?: boolean
      shellOutput?: string
    }

/** 文件回退结果(对应 SDK RewindFilesResult) */
export interface RewindResult {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

export type CheckpointRestoreMode = 'code' | 'chat' | 'both'

export interface TranscriptRestorePlanView {
  ok: boolean
  checkpointId: string
  checkpointFound: boolean
  checkpointSeq?: number
  userSeq?: number
  userMessageId?: string
  userText?: string
  keepThroughSeq: number
  removeFromSeq?: number
  keptEntries: number
  removedEntries: number
  removedKinds: AgentEvent['kind'][]
  reason?: string
}

export interface CheckpointRestoreResult {
  mode: CheckpointRestoreMode
  checkpointId: string
  canRewind: boolean
  applied?: boolean
  code?: RewindResult
  chat?: TranscriptRestorePlanView
  transcript?: TranscriptEntry[]
  filesChanged?: string[]
  insertions?: number
  deletions?: number
  chatRemovedEntries?: number
  error?: string
  note?: string
}

export type RoutinePermissionMode = PermissionModeId

export interface RoutineNotificationOptions {
  /** 是否为该 Routine 发送桌面通知 */
  enabled: boolean
  /** 执行成功后通知 */
  onSuccess: boolean
  /** 执行失败后通知 */
  onFailure: boolean
}

export interface Routine extends Record<string, unknown> {
  goalContinuation?: import('./routine-heartbeat-types').RoutineGoalContinuation
  goalContinuationState?: import('./routine-heartbeat-types').RoutineGoalContinuationState
  executionTarget?: import('./routine-heartbeat-types').RoutineSessionTarget
  id: string
  name: string
  prompt: string
  content?: string
  projectId?: string
  goalTemplateId?: string
  digitalWorkerId?: string
  projectCwd?: string
  schedule: string
  timeZone?: string
  startAt?: number
  scheduleState?: import('./routine-schedule').RoutineScheduleState
  scheduleError?: string
  frequency?: string
  providerId: string
  model: string
  engine?: EngineKind
  reasoningEffort?: ProviderReasoningEffort
  executionLocation?: 'local' | 'worktree'
  permissionMode: RoutinePermissionMode
  budgetUsd: number
  notification: RoutineNotificationOptions
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
  nextRunAt?: number
}

export type CreateRoutineInput = {
  executionTarget?: { kind: 'existing_session'; sessionId: string } | null
  id?: string
  name: string
  prompt?: string
  content?: string
  projectId?: string
  goalTemplateId?: string
  digitalWorkerId?: string
  projectCwd?: string
  schedule?: string
  timeZone?: string
  startAt?: number
  frequency?: string
  providerId?: string
  model?: string
  engine?: EngineKind
  reasoningEffort?: ProviderReasoningEffort
  executionLocation?: 'local' | 'worktree'
  permissionMode?: RoutinePermissionMode
  budgetUsd?: number
  notification?: RoutineNotificationOptions
  enabled?: boolean
  createdAt?: number
  updatedAt?: number
  lastRunAt?: number | null
  nextRunAt?: number | null
} & Record<string, unknown>

export type UpdateRoutineInput = {
  executionTarget?: { kind: 'existing_session'; sessionId: string } | null
  name?: string
  prompt?: string
  content?: string
  projectId?: string | null
  goalTemplateId?: string | null
  digitalWorkerId?: string | null
  projectCwd?: string
  schedule?: string
  timeZone?: string
  startAt?: number
  frequency?: string
  providerId?: string
  model?: string
  engine?: EngineKind
  reasoningEffort?: ProviderReasoningEffort
  executionLocation?: 'local' | 'worktree'
  permissionMode?: RoutinePermissionMode
  budgetUsd?: number
  notification?: RoutineNotificationOptions
  enabled?: boolean
  lastRunAt?: number | null
  nextRunAt?: number | null
} & Record<string, unknown>

export interface MarkRunOptions {
  ranAt?: number
  nextRunAt?: number | null
}

export type RoutineRunStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type RoutineInboxStatus = 'running' | 'waiting_approval' | 'needs_review' | 'accepted' | 'rejected' | 'failed'
export type RoutineDispatchState = 'preparing' | 'session_created' | 'prompt_accepted'
export type RoutineReviewDecision = 'accepted' | 'rejected'

export interface RoutineRunRecord {
  heartbeat?: import('./routine-heartbeat-types').RoutineHeartbeatRun
  id: string
  routineId: string
  routineName: string
  projectId?: string
  goalId?: string
  workItemId?: string
  projectCwd: string
  startedAt: number
  finishedAt?: number
  status: RoutineRunStatus
  inboxStatus: RoutineInboxStatus
  dispatchState: RoutineDispatchState
  sessionId?: string
  workflowRunId?: string
  /** Canonical persisted result produced by this automation run. */
  artifactId?: string
  /** Immutable Workflow Evidence bound to the result Artifact and creating Run. */
  evidenceId?: string
  /** Stable observation timestamp used for idempotent result finalization. */
  resultObservedAt?: number
  nextRunAt?: number | null
  resultText?: string
  error?: string
  reviewDecision?: RoutineReviewDecision
  reviewNote?: string
  reviewedAt?: number
}

export interface RoutineRunReviewInput {
  decision: 'accept' | 'reject'
  note?: string
}

export interface RoutineTemplate {
  id: string
  name: string
  description: string
  content: string
  frequency: string
  permissionMode: RoutinePermissionMode
  tags: string[]
}

export interface GitFileStatus {
  path: string
  oldPath?: string
  indexStatus: string
  worktreeStatus: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'unknown'
}

export interface GitStatus {
  ok: boolean
  cwd: string
  branch: string
  files: GitFileStatus[]
  staged: number
  unstaged: number
  untracked: number
  error?: string
}

export type GitOperationResult = { ok: true } | { ok: false; error: string }

export type GitCommitResult = { ok: true; sha: string } | { ok: false; error: string }

export type WorkspaceHunkResult = ({ ok: true } | { ok: false; error: string }) & {
  effectStatus?: EffectStatus
  operationId?: string
  snapshotId?: string
}

export interface WorkspaceDiffLine {
  type: 'context' | 'add' | 'delete'
  text: string
  oldLine?: number
  newLine?: number
}

export interface WorkspaceDiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  patch?: string
  lines: WorkspaceDiffLine[]
}

export interface WorkspaceDiffFile {
  oldPath: string
  newPath: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary' | 'unknown'
  hunks: WorkspaceDiffHunk[]
  binary?: boolean
}

export interface WorkspaceDiff {
  ok: boolean
  cwd: string
  files: WorkspaceDiffFile[]
  rawBytes: number
  truncated?: boolean
  error?: string
}

export interface ManagedWorktreeView {
  sessionId: string
  repoRoot: string
  sourceCwd: string
  worktreePath: string
  cwd: string
  branch: string
  baseSha: string
  baseBranch: string | null
  state: 'active' | 'removed'
  createdAt: number
  updatedAt: number
}

export interface WorktreeSummary {
  ok: boolean
  isolated: boolean
  record?: ManagedWorktreeView
  changedFiles: number
  insertions?: number
  deletions?: number
  dirty: boolean
  error?: string
}

export type WorktreeConflictRisk = 'low' | 'medium' | 'unknown'

export type WorktreeMergeSummary =
  | {
      ok: true
      repoRoot: string
      worktreePath: string
      baseSha: string
      headSha: string
      changedFiles: number
      insertions: number
      deletions: number
      conflictRisk: WorktreeConflictRisk
    }
  | { ok: false; error: string }

export type WorktreePatchResult =
  | {
      ok: true
      repoRoot?: string
      worktreePath?: string
      baseSha?: string
      headSha?: string
      path?: string
      patchText?: string
      bytes?: number
      sha256?: string
      workflowArtifactId?: string
      workflowEvidenceId?: string
      workflowAcceptanceId?: string
    }
  | { ok: false; error: string; savedPatch?: { path: string; bytes: number } }

export type WorktreeApplyCheckResult =
  | { ok: true; canApply: true }
  | { ok: true; canApply: false; error: string }
  | { ok: false; error: string }

export type WorktreeApplyResult =
  | {
      ok: true
      repoRoot: string
      worktreePath?: string
      baseSha?: string
      headSha?: string
      path?: string
      bytes: number
      changedFiles: number
      applied: boolean
      effectStatus?: EffectStatus
      operationId?: string
      snapshotId?: string
      reconciliationRequired?: boolean
    }
  | {
      ok: false
      error: string
      effectStatus?: EffectStatus
      operationId?: string
      snapshotId?: string
      reconciliationRequired?: boolean
    }

export interface WorktreeRemoveResult {
  ok: boolean
  record?: ManagedWorktreeView
  error?: string
}

export type WorktreePullRequestTool = 'gh' | 'glab'

/** 冲突三栏:单文件三份内容(基线/worktree/主工作区) */
export interface WorktreeConflictFile {
  path: string
  base: string
  worktree: string
  main: string
  baseMissing?: boolean
  worktreeMissing?: boolean
  mainMissing?: boolean
  truncated?: boolean
}

/** 单对象可选字段形态(同 GitResult 模式),规避非严格 tsc 判别联合收窄问题 */
export interface WorktreeConflictFilesResult {
  ok: boolean
  files?: WorktreeConflictFile[]
  truncatedList?: boolean
  error?: string
}

/** 合并回执:applyWorktreePatch 成功后落盘的验收记录 */
export interface WorktreeMergeReceipt {
  sessionId: string
  branch: string
  baseSha: string
  filesChanged: number
  insertions: number
  deletions: number
  mergedAt: number
  patchSha256: string
}

export type WorktreePullRequestResult =
  | {
      ok: true
      created: true
      tool: WorktreePullRequestTool
      branch: string
      url: string
      pushed: boolean
      effectStatus?: EffectStatus
      operationId?: string
      snapshotId?: string
    }
  | {
      ok: true
      created: false
      message: string
      effectStatus?: EffectStatus
      operationId?: string
      snapshotId?: string
    }
  | {
      ok: false
      error: string
      effectStatus?: EffectStatus
      operationId?: string
      snapshotId?: string
    }

export type PreviewType = 'html' | 'markdown' | 'text' | 'csv' | 'json' | 'image' | 'pdf' | 'office' | 'unknown'
export type PreviewMode = 'text' | 'asset' | 'unsupported'

export interface PreparedPreview {
  ok: boolean
  path?: string
  type?: PreviewType
  mode?: PreviewMode
  mime?: string
  bytes?: number
  mtimeMs?: number
  content?: string
  dataUrl?: string
  error?: string
}

export interface OfficeVisualPreview {
  ok: boolean
  path?: string
  dataUrl?: string
  previewUrl?: string
  width?: number
  height?: number
  bytes?: number
  mtimeMs?: number
  source: 'quick-look'
  fidelity: 'system-document-preview' | 'first-page-thumbnail'
  warning?: string
  error?: string
}

export interface PreviewAnnotationLocator {
  page?: number
  row?: number
  column?: number
  quote?: string
  selector?: string
}

export interface PreviewAnnotation {
  id: string
  sessionId: string
  path: string
  type?: PreviewType
  mime?: string
  note: string
  locator?: PreviewAnnotationLocator
  boundingBox?: BrowserAnnotationBoundingBox
  screenshotPath?: string
  createdAt: string
}

export interface PreviewAnnotationInput {
  id?: string
  sessionId: string
  path: string
  type?: PreviewType | null
  mime?: string | null
  note: string
  locator?: PreviewAnnotationLocator | null
  boundingBox?: BrowserAnnotationBoundingBox | null
  screenshotPath?: string | null
  createdAt?: string
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserAnnotationBoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserAnnotationViewport {
  width: number
  height: number
  deviceScaleFactor?: number
}

export interface BrowserAnnotation {
  tabId?: string
  contextEpoch?: string
  navigationRevision?: number
  id: string
  sessionId: string
  url: string
  title?: string
  selector?: string
  boundingBox?: BrowserAnnotationBoundingBox
  screenshotPath?: string
  note: string
  consoleErrors: string[]
  viewport?: BrowserAnnotationViewport
  createdAt: string
}

export type BrowserEvent =
  | { kind: 'state'; sessionId: string; state: BrowserViewState }
  | { kind: 'annotation'; sessionId: string; annotation: BrowserAnnotation }
  | { kind: 'closed'; sessionId: string }
  | { kind: 'error'; sessionId?: string; message: string }

/** DOM 圈选结果:pickElement 注入拾取器后用户选定的元素信息 */
export interface BrowserPickResult {
  pickId?: string
  cancelled: boolean
  url?: string
  title?: string
  selector?: string
  text?: string
  boundingBox?: BrowserAnnotationBoundingBox
  viewport?: BrowserAnnotationViewport
}

/** Agent 只读观测:当前页面状态快照(不注入不点击) */
export interface BrowserObservation {
  sessionId: string
  url: string
  title: string
  loading: boolean
  pageTextSnippet: string
  consoleErrors: string[]
  networkFailures: string[]
}

export interface SessionEventPayload {
  sessionId: string
  /** 会话内单调递增;渲染进程用它对"转录回放 + 实时广播"去重 */
  seq: number
  streamId: string
  eventId: string
  occurredAt: number
  causationId?: string
  correlationId?: string
  event: AgentEvent
}

/** 转录文件(JSONL)中的一行 */
export interface TranscriptEntry {
  seq: number
  /** Canonical Conversation Ledger 封链版本；旧 JSONL 缺失时按 legacy 前缀读取。 */
  ledgerVersion?: 1
  /** 前一条耐久事件 digest；legacy 前缀后第一条使用 legacy anchor。 */
  previousDigest?: string
  /** 当前耐久事件的 SHA-256 canonical digest。 */
  digest?: string
  /** 可选仅用于兼容旧 JSONL;新写入的转录总是携带身份。 */
  eventId?: string
  occurredAt?: number
  streamId?: string
  causationId?: string
  correlationId?: string
  event: AgentEvent
}

/** 会话全文搜索:单条命中片段 */
export interface TranscriptSearchHit {
  seq: number
  role: 'user' | 'assistant'
  /** 命中词前后 ±60 字符的上下文片段 */
  snippet: string
}

/** 会话全文搜索:按会话聚合的命中结果 */
export interface TranscriptSearchResult {
  sdkSessionId: string
  title: string
  cwd: string
  hits: TranscriptSearchHit[]
  /** 文件被跳过等异常说明(如转录超过大小上限) */
  note?: string
}

export type MenuCommand =
  | { type: 'new-session' }
  | { type: 'settings' }
  | { type: 'command-palette' }
  | { type: 'open-search' }
  | { type: 'select-session'; index: number }

/** 通过 contextBridge 暴露给渲染进程的 API */
export interface AgentDeskApi extends FeedbackApi, TaskActivityApi, ExternalBrowserBridgeApi, WorkspaceHandoffApi, SideChatApi, VoiceInputApi, TaskWindowApi, TaskEffectRecoveryApi, CouncilApi, PreparationPermissionApi, TaskExecutionAuthorityApi, TaskBudgetApi, SessionInputApi, WorkflowLedgerApi, ProjectWorkspaceApi, ProjectPortfolioApi, MediaApi, ProjectTestApi, ProjectDebugApi, ProjectRefactorApi, DigitalWorkerApi, ModelAttemptRecoveryApi, LearningApi, SupervisorStateApi, ProviderProfileApi, TaskPlanApi, MigrationApi, StudioResultApi, ProjectDataLifecycleApi, TerminalEffectApi, BrowserNavigationEffectApi, SessionEntrypointApi, OfficeRevisionApi, AssistantSearchApi {
  inspectLocalRuntimes(): Promise<import('./local-runtime-types').LocalRuntimeStatus>
  listPendingPermissions(sessionId: string): Promise<PermissionRequestInfo[]>
  getTranscript(sessionId: string): Promise<TranscriptEntry[]>
  suggestFiles(sessionId: string, query: string): Promise<string[]>
  rewindFiles(sessionId: string, messageId: string, dryRun: boolean): Promise<RewindResult>
  restoreCheckpoint(
    sessionId: string,
    messageId: string,
    mode: CheckpointRestoreMode,
    dryRun: boolean
  ): Promise<CheckpointRestoreResult>
  listTaskSnapshots(): Promise<TaskSnapshotRecord[]>
  recoverTaskSnapshot(snapshotId: string): Promise<SessionMeta>
  resolveTaskEffect(
    snapshotId: string,
    effectId: string,
    expectedRevision: number,
    resolution: EffectResolution,
    note?: string
  ): Promise<{ snapshot: TaskSnapshotRecord; resumedSession?: SessionMeta }>
  resolveTaskDagFinalization(
    executionId: string,
    expectedRevision: number,
    resolution: TaskDagFinalizationResolution
  ): Promise<TaskDagFinalizationRecord>
  deleteTaskSnapshot(snapshotId: string): Promise<boolean>
  decomposeTask(parentSessionId: string, input: TaskDecomposeInput): Promise<TaskDecomposeResult>
  dispatchSubagents(
    parentSessionId: string,
    input: DispatchSubagentsInput
  ): Promise<SubagentDispatchResult>
  dispatchTaskDag(
    parentSessionId: string,
    input: TaskDagDispatchInput
  ): Promise<TaskDagDispatchResult>
  copyImageAttachment(sessionId: string, sourcePath: string): Promise<ImageAttachmentResult>
  copyDocumentAttachment(sessionId: string, sourcePath: string): Promise<DocumentAttachmentResult>
  saveImageAttachmentBytes(
    sessionId: string,
    input: SaveImageAttachmentBytesInput
  ): Promise<ImageAttachmentResult>
  /** OCR 附件图片(Vision/tesseract 降级;无引擎时 ok=false 如实报告) */
  ocrImageAttachment(sessionId: string, imagePath: string): Promise<ImageOcrResult>
  sendMessage(sessionId: string, payload: string | SendMessagePayload): Promise<boolean>
  previewOutboundContext(sessionId: string, payload: SendMessagePayload): Promise<OutboundContextManifest>
  interrupt(sessionId: string): Promise<void>
  closeSession(sessionId: string): Promise<void>
  respondPermission(
    sessionId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ): Promise<void>
  setPermissionMode(sessionId: string, mode: PermissionModeId): Promise<void>
  setModel(sessionId: string, model: string): Promise<void>
  setRoutingControl(sessionId: string, control: import('./session-routing-control-types').SessionRoutingControl): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
  listHistory(): Promise<HistoryEntry[]>
  /** 会话全文搜索:跨历史会话检索转录中的消息内容 */
  searchTranscripts(query: string): Promise<TranscriptSearchResult[]>
  setHistoryArchived(id: string, archived: boolean): Promise<void>
  setHistoryPinned(id: string, pinned: boolean): Promise<void>
  renameHistory(id: string, title: string): Promise<void>
  deleteHistory(id: string): Promise<boolean>
  getSettings(): Promise<AppSettings>
  onSettingsChanged(cb: () => void): () => void
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getRoutingRuleSet(): Promise<import('./routing-policy-types').RoutingRuleReadResult>
  previewRoutingRuleSet(input: import('./routing-policy-types').RoutingRulePreviewInput): Promise<import('./routing-policy-types').RoutingRulePreviewResult>
  saveRoutingRuleSet(input: import('./routing-policy-types').RoutingRuleSaveInput): Promise<import('./routing-policy-types').RoutingRuleSaveResult>
  listGuiAutomationGrants(): Promise<GuiAutomationGrantView[]>
  revokeGuiAutomationGrant(grantId: string): Promise<boolean>
  revokeAllGuiAutomationGrants(): Promise<number>
  listToolCapabilityGrants(): Promise<ToolCapabilityGrantView[]>
  revokeToolCapabilityGrant(grantId: string): Promise<boolean>
  revokeAllToolCapabilityGrants(): Promise<number>
  queryProviderUsage(query?: import('./provider-usage-types').ProviderUsageQuery): Promise<import('./provider-usage-types').ProviderUsageSummary>
  getProviderGatewayStatus(): Promise<import('./provider-gateway-types').ProviderGatewayStatusView>
  updateProviderGateway(input: import('./provider-gateway-types').ProviderGatewayUpdateInput): Promise<import('./provider-gateway-types').ProviderGatewayStatusView>
  listProviderGatewayModels(): Promise<import('./provider-gateway-types').ProviderGatewayModelView[]>
  copyProviderGatewayToken(): Promise<boolean>
  listProviderBillingStatements(providerId: string): Promise<import('./provider-billing-types').ProviderBillingStatementView[]>
  saveProviderBillingStatement(input: import('./provider-billing-types').ProviderBillingStatementInput): Promise<import('./provider-billing-types').ProviderBillingStatementView>
  removeProviderBillingStatement(providerId: string, statementId: string): Promise<boolean>
  reconcileProviderBilling(providerId: string): Promise<import('./provider-billing-types').ProviderBillingReconciliationView[]>
  inspectProviderBillingQuery(providerId: string): Promise<import('./provider-billing-query-types').ProviderBillingQueryCapabilityView>
  syncProviderBillingStatement(input: import('./provider-billing-query-types').ProviderBillingSyncInput): Promise<import('./provider-billing-query-types').ProviderBillingSyncResult>
  startProviderAuthorization(
    providerId: string,
    service?: import('./provider-authorization-types').ProviderAuthorizationService
  ): Promise<import('./provider-authorization-types').ProviderDeviceAuthorizationView>
  pollProviderAuthorization(providerId: string, flowId: string): Promise<import('./provider-authorization-types').ProviderAuthorizationPollResult>
  startQuickProviderAuthorization(service?: import('./provider-authorization-types').ProviderAuthorizationService): Promise<import('./provider-authorization-types').ProviderQuickDeviceAuthorizationView>
  pollQuickProviderAuthorization(flowId: string): Promise<import('./provider-authorization-types').ProviderQuickAuthorizationPollResult>
  listProviderAuthorizationAccounts(providerId: string): Promise<import('./provider-authorization-types').ProviderAuthorizationAccountView[]>
  bindProviderAuthorizationAccount(providerId: string, accountId: string, mutation?: import('./provider-authorization-types').ProviderAuthorizationMutation): Promise<ProviderView>
  refreshProviderAuthorization(providerId: string): Promise<ProviderView>
  revokeProviderAuthorization(providerId: string, accountId?: string): Promise<ProviderView>
  queryProviderAuthorizationQuota(providerId: string, accountId?: string): Promise<import('./provider-authorization-types').ProviderAuthorizationQuotaView>
  inspectProviderBalance(providerId: string): Promise<import('./provider-balance-types').ProviderBalanceCapabilityView>
  queryProviderBalance(providerId: string): Promise<import('./provider-balance-types').ProviderBalanceView>
  listNotificationConnectors(): Promise<NotificationConnectorView[]>
  createNotificationConnector(input: NotificationConnectorInput): Promise<NotificationConnectorView>
  deleteNotificationConnector(id: string): Promise<boolean>
  setDefaultNotificationConnector(id: string): Promise<NotificationConnectorView>
  scanPluginRegistry(
    sessionId?: string,
    options?: PluginRegistryScanOptions
  ): Promise<PluginRegistryView>
  revealPluginRegistryItem(path: string, sessionId?: string): Promise<PluginRegistryRevealResult>
  setPluginRegistryItemEnabled(
    item: PluginRegistryItem,
    enabled: boolean,
    sessionId?: string
  ): Promise<PluginRegistrySetEnabledResult>
  approvePluginRegistryItem(
    item: PluginRegistryItem,
    sessionId?: string
  ): Promise<PluginRegistryTrustMutationResult>
  authorizePluginRegistryItem(
    item: PluginRegistryItem,
    sessionId?: string
  ): Promise<PluginRegistryTrustMutationResult>
  /** MCP 运行态探测:stdio 真握手 / http 可达性(最多 20 项) */
  probeMcpServers(items: PluginRegistryItem[], sessionId?: string): Promise<import('./mcp-probe-types').McpProbeOperationResult>
  /** 本地安装插件:不传路径则弹目录选择器;仅复制入 ~/.caogen/plugins */
  installLocalPlugin(sourcePath?: string, overwrite?: boolean): Promise<PluginInstallResult>
  /** 卸载托管插件:移入回收站(可恢复),仅限 ~/.caogen/plugins 内 */
  uninstallPlugin(targetPath: string): Promise<PluginUninstallResult>
  listRoutines(): Promise<Routine[]>
  createRoutine(input: CreateRoutineInput): Promise<Routine>
  deleteRoutine(id: string): Promise<boolean>
  updateRoutine(id: string, patch: UpdateRoutineInput): Promise<Routine | null>
  markRoutineRun(id: string, options?: MarkRunOptions): Promise<Routine | null>
  runRoutineNow(id: string): Promise<RoutineRunRecord | null>
  listRoutineRuns(routineId?: string): Promise<RoutineRunRecord[]>
  reviewRoutineRun(runId: string, input: RoutineRunReviewInput): Promise<RoutineRunRecord | null>
  listRoutineTemplates(): Promise<RoutineTemplate[]>
  getStartSuggestions(sessionId: string): Promise<StartSuggestion[]>
  gitStatus(sessionId: string): Promise<GitStatus>
  stageFiles(sessionId: string, paths: string[]): Promise<GitOperationResult>
  stageAll(sessionId: string): Promise<GitOperationResult>
  unstageFiles(sessionId: string, paths: string[]): Promise<GitOperationResult>
  gitCommit(sessionId: string, message: string): Promise<GitCommitResult>
  getWorkspaceDiff(sessionId: string): Promise<WorkspaceDiff>
  applyWorkspaceHunk(sessionId: string, filePath: string, hunkPatch: string): Promise<WorkspaceHunkResult>
  discardWorkspaceHunk(sessionId: string, filePath: string, hunkPatch: string): Promise<WorkspaceHunkResult>
  getWorktreeSummary(sessionId: string): Promise<WorktreeSummary>
  exportWorktreePatch(sessionId: string): Promise<WorktreePatchResult>
  inspectWorktreeMerge(sessionId: string): Promise<WorktreeMergeSummary>
  createWorktreeMergePatch(sessionId: string): Promise<WorktreePatchResult>
  checkWorktreeApply(sessionId: string): Promise<WorktreeApplyCheckResult>
  applyWorktreePatch(sessionId: string): Promise<WorktreeApplyResult>
  /** 冲突三栏:apply-check 被拒时取冲突文件的 基线/worktree/主工作区 三份内容 */
  getWorktreeConflictFiles(sessionId: string): Promise<WorktreeConflictFilesResult>
  /** 合并回执列表(最新在前),验收"上次到底合了什么" */
  listWorktreeMergeReceipts(): Promise<WorktreeMergeReceipt[]>
  createWorktreePullRequest(sessionId: string, input?: import('./worktree-pr-draft-types').WorktreePullRequestDraftSubmitInput): Promise<WorktreePullRequestResult>
  removeWorktree(
    sessionId: string,
    opts?: { deleteBranch?: boolean; force?: boolean }
  ): Promise<WorktreeRemoveResult>
  listProjectFiles(sessionId: string): Promise<ListProjectFilesResult>
  searchProjectText(sessionId: string, query: string): Promise<SearchProjectTextResult>
  listProjectDiagnostics(sessionId: string): Promise<ProjectDiagnosticsResult>
  searchProjectSymbols(sessionId: string, query: string, limit?: number): Promise<ProjectSymbolSearchResult>
  resolveProjectDefinition(sessionId: string, path: string, symbol: string): Promise<ProjectSymbolSearchResult>
  getTypeScriptCompletions(sessionId: string, input: TypeScriptLanguageInput): Promise<SemanticCompletionResult>
  getTypeScriptHover(sessionId: string, input: TypeScriptLanguageInput): Promise<SemanticHoverResult>
  getTypeScriptDefinitions(sessionId: string, input: TypeScriptLanguageInput): Promise<SemanticDefinitionResult>
  getTypeScriptDiagnostics(sessionId: string, input: TypeScriptLanguageInput): Promise<SemanticDiagnosticsResult>
  readTextFile(sessionId: string, path: string): Promise<ReadTextFileResult>
  writeTextFile(sessionId: string, path: string, content: string): Promise<WriteTextFileResult>
  preparePreview(sessionId: string, path: string): Promise<PreparedPreview>
  preparePreviewVisual(sessionId: string, path: string): Promise<OfficeVisualPreview>
  savePreviewAnnotation(sessionId: string, input: PreviewAnnotationInput): Promise<PreviewAnnotation>
  listPreviewAnnotations(sessionId: string, path?: string): Promise<PreviewAnnotation[]>
  setBrowserBounds(sessionId: string, bounds: BrowserBounds): Promise<void>
  closeBrowser(sessionId: string): Promise<void>
  captureBrowserAnnotation(sessionId: string, note: string, target?: BrowserTabTarget): Promise<BrowserAnnotation>
  listBrowserAnnotations(sessionId: string): Promise<BrowserAnnotation[]>
  pickBrowserElement(sessionId: string, target?: BrowserTabTarget): Promise<BrowserPickResult>
  captureBrowserElementAnnotation(
    sessionId: string,
    pick: BrowserPickResult,
    note: string,
    target?: BrowserTabTarget
  ): Promise<BrowserAnnotation>
  observeBrowser(sessionId: string, target?: BrowserTabTarget): Promise<BrowserObservation>
  onBrowserEvent(cb: (event: BrowserEvent) => void): () => void
  importMigrationAssets(cwd: string, paths: string[]): Promise<MigrationImportOperationResult>
  listProjects(): Promise<Project[]>
  updateProject(id: string, patch: ProjectUpdate): Promise<Project | null>
  deleteProject(id: string): Promise<void>
  readProjectContext(projectPath: string): Promise<ProjectContextReadResult>
  writeProjectContext(projectPath: string, content: string): Promise<import('./project-context-types').ProjectContextOperationResult<ProjectContextReadResult>>
  generateProjectContextTemplate(projectPath: string): Promise<string>
  readProjectMemory(sessionId: string): Promise<ReadProjectMemoryResult>
  readMemoryRetention(sessionId: string): Promise<import('./memory-retention-types').MemoryRetentionView>
  previewMemoryRetention(sessionId: string, input: import('./memory-retention-types').MemoryRetentionInput): Promise<import('./memory-retention-types').MemoryRetentionPreview>
  saveMemoryRetention(sessionId: string, input: import('./memory-retention-types').MemoryRetentionSaveInput): Promise<import('./memory-retention-types').MemoryRetentionView>
  previewLegacyProjectMemory(sessionId: string): Promise<LegacyMemoryPreview>
  importLegacyProjectMemory(sessionId: string, input: LegacyMemoryImportInput): Promise<LegacyMemoryImportResult>
  proposeMemoryDraft(sessionId: string, input: ProjectMemoryDraftInput): Promise<ProjectMemoryDraft>
  acceptMemoryDraft(sessionId: string, draftId: string): Promise<ProjectMemoryEntry>
  deleteMemoryEntry(sessionId: string, entryId: string): Promise<{ id: string; deleted: boolean; deletedFrom: Array<'confirmed' | 'drafts'> }>
  addTaskMemory(sessionId: string, input: { title: string; body: string }): Promise<LayeredMemoryEntry>
  listLayeredMemories(sessionId?: string): Promise<LayeredMemoryEntry[]>
  searchLayeredMemories(
    sessionId: string | undefined,
    input: LayeredMemorySearchInput
  ): Promise<LayeredMemorySearchHit[]>
  archiveLayeredMemories(olderThanDays?: number): Promise<number>
  exportLayeredMemories(): Promise<string>
  updateLayeredMemory(entryId: string, input: LayeredMemoryUpdateInput, sessionId?: string): Promise<LayeredMemoryEntry | null>
  deleteLayeredMemory(entryId: string, sessionId?: string): Promise<boolean>
  pickDirectory(): Promise<string | null>
  pathForFile(file: File): string
  setDesktopShortcutCapture(active: boolean): Promise<void>
  onMenuCommand(cb: (command: MenuCommand) => void): () => void
  onDesktopNotification(cb: (sessionId: string) => void): () => void
  onSessionEvent(
    cb: (sessionId: string, event: AgentEvent, seq: number, eventId?: string, occurredAt?: number) => void
  ): () => void
  onMemorySuggestion(cb: (event: MemorySuggestionEvent) => void): () => void
}
