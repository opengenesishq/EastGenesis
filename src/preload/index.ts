import { localSitePreviewApi } from './local-site-preview'
import { workspaceBehaviorApi } from './workspace-behavior'
import { mcpOAuthApi } from './mcp-oauth'
import { wslApi } from './wsl'
import { memoryPreferencesApi } from './memory-preferences'
import { migrationSubscriptionApi } from './migration-subscriptions'
import { pluginCatalogApi } from './plugin-catalog'
import { routineInboxApi } from './routine-inbox'
import { localDevServerApi } from './local-dev-server'
import { browserManagementApi } from './browser-management'
import { pullRequestWorkspaceApi } from './pull-request-workspace'
import { browserTabsApi } from './browser-tabs'
import { localSiteCatalogApi } from './local-site-catalog'
import { worktreePullRequestDraftApi } from './worktree-pr-draft'
import { taskSourceApi } from './task-sources'
import { feedbackApi } from './feedback'
import { temporaryTaskApi } from './temporary-task'
import { projectHistoryApi } from './project-history'
import { taskActivityApi } from './activity'
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  EffectResolution,
  AgentDeskApi,
  AppSettings,
  CheckpointRestoreMode,
  CreateRoutineInput,
  DispatchSubagentsInput,
  LayeredMemorySearchInput,
  LayeredMemoryUpdateInput,
  LegacyMemoryImportInput,
  MarkRunOptions,
  RoutineRunReviewInput,
  MenuCommand,
  MemorySuggestionEvent,
  NotificationConnectorInput,
  PermissionModeId,
  PreviewAnnotationInput,
  PluginRegistryScanOptions,
  ProjectUpdate,
  ProjectMemoryDraftInput,
  ProviderGenerationProbeInput,
  ProviderModelFetchInput,
  ProviderInput,
  ProviderProfileImportDecision,
  SaveImageAttachmentBytesInput,
  SendMessagePayload,
  SessionEventPayload,
  TaskDagDispatchInput,
  TaskDecomposeInput,
  UpdateRoutineInput
} from '../shared/types'
import { resolveTaskDagFinalization } from './task-dag-finalization'
import { workflowLedgerApi } from './workflow-ledger'
import { preparationPermissionApi } from './preparation-permission'
import { taskExecutionAuthorityApi } from './task-execution-authority'
import { taskBudgetApi } from './task-budget'
import { projectWorkspaceApi } from './project-workspace'
import { dataRetentionApi } from './data-retention'
import { projectTestApi } from './project-test'
import { projectDebugApi } from './project-debug'
import { projectRefactorApi } from './project-refactor'
import { digitalWorkerApi } from './digital-worker'
import { modelAttemptRecoveryApi } from './model-attempt-recovery'
import { learningApi } from './learning'
import { supervisorApi } from './supervisor'
import { taskPlanApi } from './task-plan'
import { migrationApi } from './migration'
import { studioResultApi } from './studio-result'
import { sessionEntrypointApi } from './session-entrypoints'
import { assistantSearchApi } from './assistant-search'
import { sessionInputApi } from './session-input'
import { taskWindowApi } from './task-window'
import { voiceInputApi } from './voice-input'
import type { SideChatApi } from '../shared/side-chat-types'

const sideChatApi: SideChatApi = {
  createSideChat: input => ipcRenderer.invoke('side-chat:create', input),
  listSideChats: sourceSessionId => ipcRenderer.invoke('side-chat:list', sourceSessionId),
  getSideChat: sideChatId => ipcRenderer.invoke('side-chat:get', sideChatId),
  sendSideChatMessage: input => ipcRenderer.invoke('side-chat:send', input),
  interruptSideChat: sideChatId => ipcRenderer.invoke('side-chat:interrupt', sideChatId),
  closeSideChat: sideChatId => ipcRenderer.invoke('side-chat:close', sideChatId),
  adoptSideChatAnswer: input => ipcRenderer.invoke('side-chat:adopt', input)
}

const api: AgentDeskApi = {
  clearSessionGoalMode: sessionId => ipcRenderer.invoke('session-goal-mode:clear', sessionId),
  inspectLocalRuntimes: () => ipcRenderer.invoke('environment:runtimes'),
  ...localSitePreviewApi,
  ...workspaceBehaviorApi,
  ...mcpOAuthApi,
  ...wslApi,
  ...memoryPreferencesApi,
  ...migrationSubscriptionApi,
  ...pluginCatalogApi,
  ...routineInboxApi,
  ...localDevServerApi,
  ...browserManagementApi,
  ...pullRequestWorkspaceApi,
  ...taskSourceApi,
  ...browserTabsApi,
  ...localSiteCatalogApi,
  ...worktreePullRequestDraftApi,
  ...feedbackApi,
  ...temporaryTaskApi,
  ...projectHistoryApi,
  ...taskActivityApi,
  ...sideChatApi,
  ...voiceInputApi,
  ...taskWindowApi,
  ...preparationPermissionApi,
  ...taskExecutionAuthorityApi,
  ...taskBudgetApi,
  ...sessionInputApi,
  ...sessionEntrypointApi,
  ...assistantSearchApi,
  listPendingPermissions: (sessionId: string) =>
    ipcRenderer.invoke('sessions:pendingPermissions', sessionId),
  getTranscript: (sessionId: string) => ipcRenderer.invoke('sessions:transcript', sessionId),
  suggestFiles: (sessionId: string, query: string) =>
    ipcRenderer.invoke('sessions:suggestFiles', sessionId, query),
  rewindFiles: (sessionId: string, messageId: string, dryRun: boolean) =>
    ipcRenderer.invoke('sessions:rewindFiles', sessionId, messageId, dryRun),
  restoreCheckpoint: (
    sessionId: string,
    messageId: string,
    mode: CheckpointRestoreMode,
    dryRun: boolean
  ) => ipcRenderer.invoke('sessions:restoreCheckpoint', sessionId, messageId, mode, dryRun),
  decomposeTask: (parentSessionId: string, input: TaskDecomposeInput) =>
    ipcRenderer.invoke('sessions:decomposeTask', parentSessionId, input),
  dispatchSubagents: (parentSessionId: string, input: DispatchSubagentsInput) =>
    ipcRenderer.invoke('sessions:dispatchSubagents', parentSessionId, input),
  dispatchTaskDag: (parentSessionId: string, input: TaskDagDispatchInput) =>
    ipcRenderer.invoke('sessions:dispatchTaskDag', parentSessionId, input),
  listTaskSnapshots: () => ipcRenderer.invoke('taskSnapshots:list'),
  ...workflowLedgerApi,
  ...projectWorkspaceApi,
  ...dataRetentionApi,
  ...projectTestApi,
  ...projectDebugApi,
  ...projectRefactorApi,
  ...digitalWorkerApi,
  ...modelAttemptRecoveryApi,
  ...learningApi,
  ...supervisorApi,
  ...taskPlanApi,
  ...studioResultApi,
  recoverTaskSnapshot: (snapshotId: string) =>
    ipcRenderer.invoke('taskSnapshots:recover', snapshotId),
  resolveTaskEffect: (
    snapshotId: string,
    effectId: string,
    expectedRevision: number,
    resolution: EffectResolution,
    note?: string
  ) => ipcRenderer.invoke(
    'taskSnapshots:resolveEffect',
    snapshotId,
    effectId,
    expectedRevision,
    resolution,
    note
  ),
  getTaskEffectRecovery: (sessionId, runId, taskId) => ipcRenderer.invoke('taskSnapshots:effectRecovery', sessionId, runId, taskId),
  recheckTaskEffect: (snapshotId, effectId, expectedRevision) => ipcRenderer.invoke('taskSnapshots:recheckEffect', snapshotId, effectId, expectedRevision),
  resolveTaskDagFinalization,
  deleteTaskSnapshot: (snapshotId: string) =>
    ipcRenderer.invoke('taskSnapshots:delete', snapshotId),
  copyImageAttachment: (sessionId: string, sourcePath: string) =>
    ipcRenderer.invoke('attachments:copyImage', sessionId, sourcePath),
  copyDocumentAttachment: (sessionId: string, sourcePath: string) =>
    ipcRenderer.invoke('attachments:copyDocument', sessionId, sourcePath),
  saveImageAttachmentBytes: (sessionId: string, input: SaveImageAttachmentBytesInput) =>
    ipcRenderer.invoke('attachments:saveImageBytes', sessionId, input),
  ocrImageAttachment: (sessionId: string, imagePath: string) =>
    ipcRenderer.invoke('attachments:ocr', sessionId, imagePath),
  sendMessage: (sessionId: string, payload: string | SendMessagePayload) =>
    ipcRenderer.invoke('sessions:send', sessionId, payload),
  previewOutboundContext: (sessionId: string, payload: SendMessagePayload) =>
    ipcRenderer.invoke('sessions:outboundContextPreview', sessionId, payload),
  interrupt: (sessionId: string) => ipcRenderer.invoke('sessions:interrupt', sessionId),
  closeSession: (sessionId: string) => ipcRenderer.invoke('sessions:close', sessionId),
  respondPermission: (sessionId: string, requestId: string, allow: boolean, message?: string) =>
    ipcRenderer.invoke('sessions:permission', sessionId, requestId, allow, message),
  setPermissionMode: (sessionId: string, mode: PermissionModeId) =>
    ipcRenderer.invoke('sessions:setPermissionMode', sessionId, mode),
  setRoutingControl: (sessionId: string, control: import('../shared/session-routing-control-types').SessionRoutingControl) =>
    ipcRenderer.invoke('sessions:setRoutingControl', sessionId, control),
  setModel: (sessionId: string, model: string) =>
    ipcRenderer.invoke('sessions:setModel', sessionId, model),
  renameSession: (sessionId: string, title: string) =>
    ipcRenderer.invoke('sessions:rename', sessionId, title),
  listHistory: () => ipcRenderer.invoke('history:list'),
  searchTranscripts: (query: string) => ipcRenderer.invoke('transcripts:search', query),
  setHistoryArchived: (id: string, archived: boolean) =>
    ipcRenderer.invoke('history:setArchived', id, archived),
  setHistoryPinned: (id: string, pinned: boolean) =>
    ipcRenderer.invoke('history:setPinned', id, pinned),
  renameHistory: (id: string, title: string) => ipcRenderer.invoke('history:rename', id, title),
  deleteHistory: (id: string) => ipcRenderer.invoke('history:delete', id),
  getSettings: () => ipcRenderer.invoke('settings-domain:get'),
  onSettingsChanged: cb => {
    const listener = (): void => cb()
    ipcRenderer.on('settings-domain:changed', listener)
    return () => ipcRenderer.removeListener('settings-domain:changed', listener)
  },
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings-domain:update', patch),
  getRoutingRuleSet: () => ipcRenderer.invoke('settings-domain:routing:get'),
  previewRoutingRuleSet: (input) => ipcRenderer.invoke('settings-domain:routing:preview', input),
  saveRoutingRuleSet: (input) => ipcRenderer.invoke('settings-domain:routing:save', input),
  listToolCapabilityGrants: () => invokeMain('permissions:grants:list', 'tool'),
  revokeToolCapabilityGrant: (grantId) => invokeMain('permissions:grants:revoke', 'tool', grantId),
  revokeAllToolCapabilityGrants: () => invokeMain('permissions:grants:revoke', 'tool'),
  queryProviderUsage: (query) => ipcRenderer.invoke('providers:usage', query ?? {}),
  getProviderGatewayStatus: () => ipcRenderer.invoke('providers:gateway:status'),
  updateProviderGateway: (input) => ipcRenderer.invoke('providers:gateway:update', input),
  listProviderGatewayModels: () => ipcRenderer.invoke('providers:gateway:models'),
  copyProviderGatewayToken: () => ipcRenderer.invoke('providers:gateway:copy-token'),
  listProviderBillingStatements: (providerId) => ipcRenderer.invoke('providers:billing:list', providerId),
  saveProviderBillingStatement: (input) => ipcRenderer.invoke('providers:billing:save', input),
  removeProviderBillingStatement: (providerId, statementId) =>
    ipcRenderer.invoke('providers:billing:remove', providerId, statementId),
  reconcileProviderBilling: (providerId) => ipcRenderer.invoke('providers:billing:reconcile', providerId),
  inspectProviderBillingQuery: (providerId) =>
    ipcRenderer.invoke('providers:billing:capability', providerId),
  syncProviderBillingStatement: (input) =>
    ipcRenderer.invoke('providers:billing:sync', input),
  startProviderAuthorization: (providerId, service) =>
    ipcRenderer.invoke('providers:authorization:start', providerId, service),
  startQuickProviderAuthorization: (service) =>
    ipcRenderer.invoke('providers:authorization:quick-start', service),
  pollQuickProviderAuthorization: (flowId) =>
    ipcRenderer.invoke('providers:authorization:quick-poll', flowId),
  pollProviderAuthorization: (providerId, flowId) =>
    ipcRenderer.invoke('providers:authorization:poll', providerId, flowId),
  listProviderAuthorizationAccounts: (providerId) =>
    ipcRenderer.invoke('providers:authorization:accounts', providerId),
  bindProviderAuthorizationAccount: (providerId, accountId, mutation) =>
    ipcRenderer.invoke('providers:authorization:bind', providerId, accountId, mutation),
  refreshProviderAuthorization: (providerId) =>
    ipcRenderer.invoke('providers:authorization:refresh', providerId),
  revokeProviderAuthorization: (providerId, accountId) =>
    ipcRenderer.invoke('providers:authorization:revoke', providerId, accountId),
  queryProviderAuthorizationQuota: (providerId, accountId) =>
    ipcRenderer.invoke('providers:authorization:quota', providerId, accountId),
  inspectProviderBalance: (providerId) =>
    ipcRenderer.invoke('providers:balance:capability', providerId),
  queryProviderBalance: (providerId) =>
    ipcRenderer.invoke('providers:balance:query', providerId),
  listNotificationConnectors: () => ipcRenderer.invoke('notificationConnectors:list'),
  createNotificationConnector: (input: NotificationConnectorInput) =>
    ipcRenderer.invoke('notificationConnectors:create', input),
  deleteNotificationConnector: (id: string) => ipcRenderer.invoke('notificationConnectors:delete', id),
  setDefaultNotificationConnector: (id: string) => ipcRenderer.invoke('notificationConnectors:setDefault', id),
  listProviders: () => ipcRenderer.invoke('providers:list'),
  activateLocalCompute: (options) => ipcRenderer.invoke('providers:activateLocalCompute', options),
  createProvider: (provider: ProviderInput) => ipcRenderer.invoke('providers:create', provider),
  updateProvider: (id: string, patch: Partial<ProviderInput>) =>
    ipcRenderer.invoke('providers:update', id, patch),
  deleteProvider: (id: string) => ipcRenderer.invoke('providers:delete', id),
  fetchProviderModels: (opts: ProviderModelFetchInput) =>
    ipcRenderer.invoke('providers:fetchModels', opts),
  probeProviderGeneration: (opts: ProviderGenerationProbeInput) =>
    ipcRenderer.invoke('providers:probeGeneration', opts),
  fetchProviderPricingCatalog: (models: string[]) =>
    ipcRenderer.invoke('providers:fetchPricingCatalog', models),
  listProviderHealth: () => invokeMain('providers:health'),
  exportProviderProfile: () => invokeMain('appFeatures:invoke', 'provider-profile', 'export'),
  previewProviderProfileImport: () => invokeMain('appFeatures:invoke', 'provider-profile', 'preview'),
  applyProviderProfileImport: (previewId: string, decisions: ProviderProfileImportDecision[]) =>
    invokeMain('appFeatures:invoke', 'provider-profile', 'apply', previewId, decisions),
  listProviderProfileBackups: () => invokeMain('appFeatures:invoke', 'provider-profile', 'backups'),
  previewProviderProfileBackup: (backupId: string) =>
    invokeMain('appFeatures:invoke', 'provider-profile', 'backup-preview', backupId),
  applyProviderProfileBackupPreview: (previewId: string) =>
    invokeMain('appFeatures:invoke', 'provider-profile', 'backup-apply', previewId),
  rollbackProviderProfileBackup: (backupId: string) =>
    invokeMain('appFeatures:invoke', 'provider-profile', 'rollback', backupId),
  deleteProviderProfileBackup: (backupId: string) =>
    invokeMain('appFeatures:invoke', 'provider-profile', 'backup-delete', backupId),
  getProviderProfileSyncStatus: () =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 'status'),
  chooseProviderProfileSyncDirectory: () =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 'choose-directory'),
  disconnectProviderProfileSync: () =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 'disconnect'),
  previewProviderProfileSync: () =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 'preview'),
  publishProviderProfileSync: (previewId: string, allowDiverged: boolean) =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 'publish', previewId, allowDiverged),
  applyProviderProfileSync: (previewId: string, decisions: ProviderProfileImportDecision[]) =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 'apply', previewId, decisions),
  getProviderProfileWebDavConfig: () =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 'webdav-config'),
  saveProviderProfileWebDavConfig: (input) =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 'webdav-save', input),
  removeProviderProfileWebDavConfig: () =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 'webdav-remove'),
  testProviderProfileWebDavConnection: () =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 'webdav-test'),
  previewProviderProfileWebDavSync: () =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 'webdav-preview'),
  publishProviderProfileWebDavSync: (previewId: string, allowDiverged: boolean) =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 'webdav-publish', previewId, allowDiverged),
  applyProviderProfileWebDavSync: (previewId: string, decisions: ProviderProfileImportDecision[]) =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 'webdav-apply', previewId, decisions),
  listProviderProfileWebDavHistory: () =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 'webdav-history-list'),
  previewProviderProfileWebDavHistory: (revisionId: string) =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 'webdav-history-preview', revisionId),
  applyProviderProfileWebDavHistory: (previewId: string, decisions: ProviderProfileImportDecision[]) =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 'webdav-history-apply', previewId, decisions),
  getProviderProfileS3Config: () =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 's3-config'),
  saveProviderProfileS3Config: (input) =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 's3-save', input),
  removeProviderProfileS3Config: () =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 's3-remove'),
  testProviderProfileS3Connection: () =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 's3-test'),
  previewProviderProfileS3Sync: () =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 's3-preview'),
  publishProviderProfileS3Sync: (previewId: string, allowDiverged: boolean) =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 's3-publish', previewId, allowDiverged),
  applyProviderProfileS3Sync: (previewId: string, decisions: ProviderProfileImportDecision[]) =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 's3-apply', previewId, decisions),
  listProviderProfileS3History: () =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 's3-history-list'),
  previewProviderProfileS3History: (revisionId: string) =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 's3-history-preview', revisionId),
  applyProviderProfileS3History: (previewId: string, decisions: ProviderProfileImportDecision[]) =>
    invokeMain('appFeatures:invoke', 'provider-profile-sync', 's3-history-apply', previewId, decisions),
  previewNativeProviderImports: (client) =>
    invokeMain('appFeatures:invoke', 'provider-profile', 'native-preview', client),
  applyNativeProviderImport: (previewId, action) =>
    invokeMain('appFeatures:invoke', 'provider-profile', 'native-apply', previewId, action),
  previewCodexNativeProviderImport: () =>
    invokeMain('appFeatures:invoke', 'provider-profile', 'native-codex-preview'),
  applyCodexNativeProviderImport: (previewId, action) =>
    invokeMain('appFeatures:invoke', 'provider-profile', 'native-codex-apply', previewId, action),
  listProviderNativeImportBackups: () =>
    invokeMain('appFeatures:invoke', 'provider-profile', 'native-backups'),
  rollbackProviderNativeImportBackup: (backupId) =>
    invokeMain('appFeatures:invoke', 'provider-profile', 'native-rollback', backupId),
  listEngines: () => ipcRenderer.invoke('engines:list'),
  scanPluginRegistry: (sessionId?: string, options?: PluginRegistryScanOptions) =>
    ipcRenderer.invoke('plugins:scan', sessionId, options),
  revealPluginRegistryItem: (path: string, sessionId?: string) =>
    ipcRenderer.invoke('plugins:reveal', path, sessionId),
  setPluginRegistryItemEnabled: (item, enabled, sessionId?: string) =>
    ipcRenderer.invoke('plugins:setEnabled', item, enabled, sessionId),
  approvePluginRegistryItem: (item, sessionId?: string) =>
    ipcRenderer.invoke('plugins:approve', item, sessionId),
  authorizePluginRegistryItem: (item, sessionId?: string) =>
    ipcRenderer.invoke('plugins:authorize', item, sessionId),
  probeMcpServers: (items, sessionId?: string) =>
    ipcRenderer.invoke('plugins:probeMcp', items, sessionId),
  installLocalPlugin: (sourcePath?: string, overwrite?: boolean) =>
    ipcRenderer.invoke('plugins:installLocal', sourcePath, overwrite),
  uninstallPlugin: (targetPath: string) => ipcRenderer.invoke('plugins:uninstall', targetPath),
  listRoutines: () => ipcRenderer.invoke('routines:list'),
  createRoutine: (input: CreateRoutineInput) => ipcRenderer.invoke('routines:create', input),
  deleteRoutine: (id: string) => ipcRenderer.invoke('routines:delete', id),
  updateRoutine: (id: string, patch: UpdateRoutineInput) =>
    ipcRenderer.invoke('routines:update', id, patch),
  markRoutineRun: (id: string, options?: MarkRunOptions) =>
    ipcRenderer.invoke('routines:markRun', id, options),
  runRoutineNow: (id: string) => ipcRenderer.invoke('routines:runNow', id),
  listRoutineRuns: (routineId?: string) => ipcRenderer.invoke('routines:listRuns', routineId),
  reviewRoutineRun: (runId: string, input: RoutineRunReviewInput) =>
    ipcRenderer.invoke('routines:reviewRun', runId, input),
  listRoutineTemplates: () => ipcRenderer.invoke('routines:listTemplates'),
  getStartSuggestions: (sessionId: string) => ipcRenderer.invoke('startSuggestions:get', sessionId),
  gitStatus: (sessionId: string) => ipcRenderer.invoke('git:status', sessionId),
  stageFiles: (sessionId: string, paths: string[]) => ipcRenderer.invoke('git:stage', sessionId, paths),
  stageAll: (sessionId: string) => ipcRenderer.invoke('git:stageAll', sessionId),
  unstageFiles: (sessionId: string, paths: string[]) => ipcRenderer.invoke('git:unstage', sessionId, paths),
  gitCommit: (sessionId: string, message: string) => ipcRenderer.invoke('git:commit', sessionId, message),
  getWorkspaceDiff: (sessionId: string) => ipcRenderer.invoke('workspace:diff', sessionId),
  applyWorkspaceHunk: (sessionId: string, filePath: string, hunkPatch: string) =>
    ipcRenderer.invoke('workspace:applyHunk', sessionId, filePath, hunkPatch),
  discardWorkspaceHunk: (sessionId: string, filePath: string, hunkPatch: string) =>
    ipcRenderer.invoke('workspace:discardHunk', sessionId, filePath, hunkPatch),
  getWorkspaceHandoff: (sessionId: string) => ipcRenderer.invoke('worktrees:handoff-state', sessionId),
  handoffWorkspace: (sessionId: string) => ipcRenderer.invoke('worktrees:handoff', sessionId),
  getWorktreeSummary: (sessionId: string) => ipcRenderer.invoke('worktrees:summary', sessionId),
  exportWorktreePatch: (sessionId: string) => ipcRenderer.invoke('worktrees:exportPatch', sessionId),
  inspectWorktreeMerge: (sessionId: string) => ipcRenderer.invoke('worktrees:mergeInspect', sessionId),
  createWorktreeMergePatch: (sessionId: string) => ipcRenderer.invoke('worktrees:mergePatch', sessionId),
  checkWorktreeApply: (sessionId: string) => ipcRenderer.invoke('worktrees:applyCheck', sessionId),
  applyWorktreePatch: (sessionId: string) => ipcRenderer.invoke('worktrees:applyPatch', sessionId),
  getWorktreeConflictFiles: (sessionId: string) =>
    ipcRenderer.invoke('worktrees:conflictFiles', sessionId),
  listWorktreeMergeReceipts: () => ipcRenderer.invoke('worktrees:mergeReceipts'),
  createWorktreePullRequest: (sessionId, input) =>
    ipcRenderer.invoke('worktrees:createPr', sessionId, input),
  removeWorktree: (sessionId: string, opts?: { deleteBranch?: boolean; force?: boolean }) =>
    ipcRenderer.invoke('worktrees:remove', sessionId, opts),
  listProjectFiles: (sessionId: string) => invokeMain('files:intelligence', 'list', sessionId),
  searchProjectText: (sessionId: string, query: string) => invokeMain('files:intelligence', 'search', sessionId, query),
  listProjectDiagnostics: (sessionId: string) => invokeMain('files:intelligence', 'diagnostics', sessionId),
  searchProjectSymbols: (sessionId: string, query: string, limit?: number) =>
    invokeMain('files:intelligence', 'symbols', sessionId, query, limit),
  resolveProjectDefinition: (sessionId: string, path: string, symbol: string) =>
    invokeMain('files:intelligence', 'definition', sessionId, path, symbol),
  getTypeScriptCompletions: (sessionId, input) =>
    invokeMain('files:intelligence', 'typescriptCompletions', sessionId, input),
  getTypeScriptHover: (sessionId, input) =>
    invokeMain('files:intelligence', 'typescriptHover', sessionId, input),
  getTypeScriptDefinitions: (sessionId, input) =>
    invokeMain('files:intelligence', 'typescriptDefinitions', sessionId, input),
  getTypeScriptDiagnostics: (sessionId, input) =>
    invokeMain('files:intelligence', 'typescriptDiagnostics', sessionId, input),
  readTextFile: (sessionId: string, path: string) => invokeMain('files:intelligence', 'read', sessionId, path),
  writeTextFile: (sessionId: string, path: string, content: string) =>
    ipcRenderer.invoke('files:write', sessionId, path, content),
  preparePreview: (sessionId: string, path: string) => ipcRenderer.invoke('preview:prepare', sessionId, path),
  preparePreviewVisual: (sessionId: string, path: string) =>
    ipcRenderer.invoke('preview:prepareVisual', sessionId, path),
  savePreviewAnnotation: (sessionId: string, input: PreviewAnnotationInput) =>
    ipcRenderer.invoke('preview:saveAnnotation', sessionId, input),
  listPreviewAnnotations: (sessionId: string, path?: string) =>
    ipcRenderer.invoke('preview:listAnnotations', sessionId, path),
  openWorkspaceBrowser: (url) => ipcRenderer.invoke('browser:open-workspace', url),
  openBrowser: (sessionId: string, url?: string) => ipcRenderer.invoke('browser:open', sessionId, url),
  navigateBrowser: (sessionId, url, target) =>
    ipcRenderer.invoke('browser:navigate', sessionId, url, target),
  setBrowserBounds: (sessionId: string, bounds) => ipcRenderer.invoke('browser:bounds', sessionId, bounds),
  browserGoBack: (sessionId, target) => ipcRenderer.invoke('browser:back', sessionId, target),
  browserGoForward: (sessionId, target) => ipcRenderer.invoke('browser:forward', sessionId, target),
  reloadBrowser: (sessionId, target) => ipcRenderer.invoke('browser:reload', sessionId, target),
  closeBrowser: (sessionId: string) => ipcRenderer.invoke('browser:close', sessionId),
  captureBrowserAnnotation: (sessionId, note, target) =>
    ipcRenderer.invoke('browser:captureAnnotation', sessionId, note, target),
  listBrowserAnnotations: (sessionId: string) =>
    ipcRenderer.invoke('browser:listAnnotations', sessionId),
  pickBrowserElement: (sessionId, target) => ipcRenderer.invoke('browser:pickElement', sessionId, target),
  captureBrowserElementAnnotation: (sessionId, pick, note, target) =>
    ipcRenderer.invoke('browser:captureElementAnnotation', sessionId, pick, note, target),
  observeBrowser: (sessionId, target) => ipcRenderer.invoke('browser:observe', sessionId, target),
  onBrowserEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: Parameters<typeof cb>[0]): void => {
      cb(event)
    }
    ipcRenderer.on('browser:event', listener)
    return () => {
      ipcRenderer.removeListener('browser:event', listener)
    }
  },
  setDesktopShortcutCapture: (active) => ipcRenderer.invoke('desktop-shortcuts:capture', active),
  onMenuCommand: (cb) => {
    const listeners: Array<[string, (e: IpcRendererEvent, value?: unknown) => void]> = [
      ['menu:new-session', () => cb({ type: 'new-session' })],
      ['menu:settings', () => cb({ type: 'settings' })],
      ['menu:command-palette', () => cb({ type: 'command-palette' })],
      ['menu:open-search', () => cb({ type: 'open-search' })],
      [
        'menu:select-session',
        (_e, value) => {
          const index = typeof value === 'number' ? value : Number(value)
          if (Number.isInteger(index) && index >= 0) cb({ type: 'select-session', index } satisfies MenuCommand)
        }
      ]
    ]
    for (const [channel, listener] of listeners) ipcRenderer.on(channel, listener)
    return () => {
      for (const [channel, listener] of listeners) ipcRenderer.removeListener(channel, listener)
    }
  },
  listTerminals: () => ipcRenderer.invoke('terminals:list'),
  startWorkspaceTerminal: (input) => ipcRenderer.invoke('terminals:start-workspace', input),
  startTerminal: (sessionId: string, opts?: { cols?: number; rows?: number; reuse?: boolean }) =>
    ipcRenderer.invoke('terminals:start', sessionId, opts),
  writeTerminal: (id: string, data: string) => ipcRenderer.invoke('terminals:write', id, data),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminals:resize', id, cols, rows),
  closeTerminal: (id: string) => ipcRenderer.invoke('terminals:close', id),
  onTerminalEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: Parameters<typeof cb>[0]): void => {
      cb(event)
    }
    ipcRenderer.on('terminal:event', listener)
    return () => {
      ipcRenderer.removeListener('terminal:event', listener)
    }
  },
  ...migrationApi,
  importMigrationAssets: (cwd: string, paths: string[]) =>
    ipcRenderer.invoke('migration:import', cwd, paths),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  updateProject: (id: string, patch: ProjectUpdate) =>
    ipcRenderer.invoke('projects:update', id, patch),
  deleteProject: (id: string) => ipcRenderer.invoke('projects:delete', id),
  readProjectContext: (projectPath: string) =>
    ipcRenderer.invoke('projectContext:read', projectPath),
  writeProjectContext: (projectPath: string, content: string) =>
    ipcRenderer.invoke('projectContext:write', projectPath, content),
  generateProjectContextTemplate: (projectPath: string) =>
    ipcRenderer.invoke('projectContext:template', projectPath),
  readProjectMemory: (sessionId: string) => ipcRenderer.invoke('memory:read', sessionId),
  readMemoryRetention: (sessionId: string) => ipcRenderer.invoke('memory:retentionRead', sessionId),
  previewMemoryRetention: (sessionId: string, input: import('../shared/memory-retention-types').MemoryRetentionInput) =>
    ipcRenderer.invoke('memory:retentionPreview', sessionId, input),
  saveMemoryRetention: (sessionId: string, input: import('../shared/memory-retention-types').MemoryRetentionSaveInput) =>
    ipcRenderer.invoke('memory:retentionSave', sessionId, input),
  previewLegacyProjectMemory: (sessionId: string) => ipcRenderer.invoke('memory:legacyPreview', sessionId),
  importLegacyProjectMemory: (sessionId: string, input: LegacyMemoryImportInput) =>
    ipcRenderer.invoke('memory:legacyImport', sessionId, input),
  proposeMemoryDraft: (sessionId: string, input: ProjectMemoryDraftInput) =>
    ipcRenderer.invoke('memory:propose', sessionId, input),
  acceptMemoryDraft: (sessionId: string, draftId: string) =>
    ipcRenderer.invoke('memory:accept', sessionId, draftId),
  deleteMemoryEntry: (sessionId: string, entryId: string) =>
    ipcRenderer.invoke('memory:delete', sessionId, entryId),
  listLayeredMemories: (sessionId?: string) => ipcRenderer.invoke('memory:layeredList', sessionId),
  addTaskMemory: (sessionId: string, input: { title: string; body: string }) => ipcRenderer.invoke('memory:taskAdd', sessionId, input),
  searchLayeredMemories: (sessionId: string | undefined, input: LayeredMemorySearchInput) =>
    ipcRenderer.invoke('memory:layeredSearch', sessionId, input),
  archiveLayeredMemories: (olderThanDays?: number) =>
    ipcRenderer.invoke('memory:layeredArchive', olderThanDays),
  exportLayeredMemories: () => ipcRenderer.invoke('memory:layeredExport'),
  updateLayeredMemory: (entryId: string, input: LayeredMemoryUpdateInput, sessionId?: string) =>
    ipcRenderer.invoke('memory:layeredUpdate', entryId, input, sessionId),
  deleteLayeredMemory: (entryId: string, sessionId?: string) => ipcRenderer.invoke('memory:layeredDelete', entryId, sessionId),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  onDesktopNotification: (cb) => {
    const listener = (_e: IpcRendererEvent, sessionId: string): void => { cb(sessionId) }
    ipcRenderer.on('desktop-notification:activate', listener)
    ipcRenderer.send('desktop-notification:ready')
    return () => { ipcRenderer.removeListener('desktop-notification:activate', listener) }
  },
  onSessionEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: SessionEventPayload): void => {
      cb(payload.sessionId, payload.event, payload.seq, payload.eventId, payload.occurredAt)
    }
    ipcRenderer.on('session:event', listener)
    return () => {
      ipcRenderer.removeListener('session:event', listener)
    }
  },
  onMemorySuggestion: (cb) => {
    const listener = (_e: IpcRendererEvent, event: MemorySuggestionEvent): void => {
      cb(event)
    }
    ipcRenderer.on('memory:suggestion', listener)
    return () => {
      ipcRenderer.removeListener('memory:suggestion', listener)
    }
  }
}

function invokeMain<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

contextBridge.exposeInMainWorld('agentDesk', api)
