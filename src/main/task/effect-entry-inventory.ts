export type EffectEntryImpact = 'read_only' | 'local' | 'external'
export type EffectEntryPolicyKind =
  | 'none'
  | 'queryable'
  | 'opaque'
  | 'conditional'
  | 'delegated'
  | 'direct_user'
export type EffectEntryReplayPolicy =
  | 'not_applicable'
  | 'reconcile_before_retry'
  | 'manual_reconciliation'
  | 'downstream_barrier'
  | 'never'

export interface EffectEntryPolicy {
  impact: EffectEntryImpact
  effect: EffectEntryPolicyKind
  replay: EffectEntryReplayPolicy
  evidence?: string
}

const READ_ONLY: EffectEntryPolicy = {
  impact: 'read_only', effect: 'none', replay: 'not_applicable'
}
const LOCAL: EffectEntryPolicy = {
  impact: 'local', effect: 'none', replay: 'not_applicable'
}
const QUERYABLE: EffectEntryPolicy = {
  impact: 'external', effect: 'queryable', replay: 'reconcile_before_retry'
}
const OPAQUE: EffectEntryPolicy = {
  impact: 'external', effect: 'opaque', replay: 'manual_reconciliation'
}
const CONDITIONAL: EffectEntryPolicy = {
  impact: 'external', effect: 'conditional', replay: 'reconcile_before_retry'
}
const DIRECT_USER: EffectEntryPolicy = {
  impact: 'external', effect: 'direct_user', replay: 'never'
}

export const EFFECT_ENTRY_INVENTORY_VERSION = 32

export const IPC_EFFECT_ENTRY_POLICIES = mergePolicyGroups(
  policyGroup([
    'assistantSearch:getAttempt',
    'attachments:ocr',
    'browser:listAnnotations', 'browser:observe', 'browser:pickElement',
    'browser-debug:status', 'browser-debug:snapshot',
    'dataRetention:evaluatePurge', 'dataRetention:get', 'dataRetention:pending',
    'engines:list',
    'files:intelligence',
    'git:status',
    'history:list',
    'learning:list',
    'memory:layeredExport', 'memory:layeredList', 'memory:layeredSearch', 'memory:read',
    'migration:scan',
    'modelAttempts:listReconciliations',
    'notificationConnectors:list',
    'plugins:authorize', 'plugins:scan',
    'preview:listAnnotations', 'preview:prepare', 'preview:prepareVisual',
    'projectContext:read', 'projectContext:template',
    'projects:list',
    'permissions:grants:list',
    'providers:authorization:accounts', 'providers:balance:capability',
    'providers:billing:capability', 'providers:billing:list', 'providers:billing:reconcile',
    'providers:fetchModels', 'providers:fetchPricingCatalog', 'providers:gateway:models',
    'providers:gateway:status', 'providers:health', 'providers:list', 'providers:usage',
    'routines:list', 'routines:listRuns', 'routines:listTemplates',
    'sessions:decomposeTask', 'sessions:list', 'sessions:outboundContextPreview', 'sessions:pendingPermissions',
    'sessions:suggestFiles', 'sessions:transcript',
    'settings-domain:get', 'settings-domain:routing:get', 'settings-domain:routing:preview',
    'startSuggestions:get',
    'taskSnapshots:list', 'taskSnapshots:effectRecovery',
    'terminals:list',
    'transcripts:search',
    'workflowLedger:compareArtifacts', 'workflowLedger:diagnose', 'workflowLedger:export', 'workflowLedger:list',
    'workflowLedger:listArtifactEdges', 'workflowLedger:listArtifactLocations',
    'workflowLedger:listEvidence', 'workflowLedger:projectDeliveryWorkbench', 'workflowLedger:queryArtifactGraph',
    'workflowLedger:queryEvidence', 'workflowLedger:repairPlan', 'workflowLedger:verify',
    'workflowLedger:verifyArtifactGraph', 'workflowLedger:verifyArtifactIntegrity', 'workflowLedger:verifyEvidence',
    'workflowLedger:listDeliveryTrustedIdentities', 'workflowLedger:verifyProjectDelivery',
    'workflowLedger:verifyProjectDeliveryPackage',
    'workspace:diff',
    'worktrees:applyCheck', 'worktrees:conflictFiles', 'worktrees:exportPatch',
    'worktrees:mergeInspect', 'worktrees:mergePatch', 'worktrees:mergeReceipts',
    'worktrees:summary', 'worktrees:handoff-state'
  ], READ_ONLY),
  policyGroup([
    'appFeatures:invoke',
    'dataRetention:createLegalHold', 'dataRetention:releaseLegalHold', 'dataRetention:updatePolicy',
    'browser:captureAnnotation', 'browser:captureElementAnnotation',
    'browser-debug:grant', 'browser-debug:revoke',
    'digitalWorker:invoke',
    'history:delete', 'history:rename', 'history:setArchived', 'history:setPinned',
    'learning:approve', 'learning:delete', 'learning:reject', 'learning:revoke', 'learning:rollback',
    'memory:accept', 'memory:delete', 'memory:layeredArchive', 'memory:layeredDelete',
    'memory:layeredUpdate', 'memory:propose',
    'modelAttempts:resolveReconciliation',
    'notificationConnectors:create', 'notificationConnectors:delete',
    'notificationConnectors:setDefault',
    'permissions:grants:revoke',
    'plugins:approve', 'plugins:setEnabled',
    'preview:saveAnnotation',
    'projects:delete', 'projects:update',
      'projectWorkspace:invoke',
    'providers:activateLocalCompute', 'providers:authorization:revoke',
    'providers:billing:remove', 'providers:billing:save',
    'providers:create', 'providers:delete', 'providers:gateway:update', 'providers:update',
    'routines:create', 'routines:delete', 'routines:markRun', 'routines:reviewRun', 'routines:update',
    'sessions:close', 'sessions:interrupt', 'sessions:permission', 'sessions:rename',
    'sessions:setModel', 'sessions:setRoutingControl', 'sessions:setPermissionMode',
    'settings-domain:update', 'settings-domain:routing:save',
    'supervisor:invoke',
    'taskSnapshots:delete', 'taskSnapshots:resolveDagFinalization', 'taskSnapshots:resolveEffect', 'taskSnapshots:recheckEffect',
    'workflowLedger:createArtifact', 'workflowLedger:createArtifactAcceptance', 'workflowLedger:createArtifactEdge',
    'workflowLedger:createArtifactLocation', 'workflowLedger:createEvidence',
    'workflowLedger:createEvidenceLink', 'workflowLedger:createGoal',
    'workflowLedger:createWorkItem', 'workflowLedger:reviewAcceptance', 'workflowLedger:startAcceptanceRepair',
    'workflowLedger:revokeDeliveryIdentity', 'workflowLedger:saveAcceptance',
    'workflowLedger:rotateDeliveryIdentity', 'workflowLedger:transitionWorkItem',
    'workflowLedger:trustDeliveryIdentity', 'workflowLedger:updateDeliveryTrustPolicy'
  ], LOCAL),
  policyGroup([
    'files:write',
    'git:commit', 'git:stage', 'git:stageAll', 'git:unstage',
    'projectContext:write',
    'workspace:applyHunk', 'workspace:discardHunk',
    'worktrees:handoff', 'worktrees:applyPatch', 'worktrees:createPr', 'worktrees:remove'
  ], QUERYABLE),
  policyGroup(['migration:apply', 'migration:rollback'], {
    ...QUERYABLE, evidence: 'executeMigrationApplyEffect/executeMigrationRollbackEffect'
  }),
  policyGroup(['plugins:installLocal'], {
    ...QUERYABLE, evidence: 'installLocalPluginWithEffect'
  }),
  policyGroup(['plugins:uninstall'], {
    ...QUERYABLE, evidence: 'uninstallPluginWithEffect'
  }),
  policyGroup([
    'attachments:copyDocument', 'attachments:copyImage', 'attachments:saveImageBytes',
    'browser:back', 'browser:forward', 'browser:navigate', 'browser:open', 'browser:open-workspace', 'browser:reload',
    'plugins:probeMcp',
    'terminals:close', 'terminals:resize', 'terminals:start', 'terminals:start-workspace', 'terminals:write'
  ], OPAQUE),
  policyGroup(['assistantSearch:search'], {
    ...OPAQUE, evidence: 'broker.search'
  }),
  policyGroup(['migration:import'], {
    ...OPAQUE, evidence: 'executeMigrationImportEffect'
  }),
  policyGroup([
    'providers:authorization:start', 'providers:authorization:quick-start',
    'providers:authorization:quick-poll', 'providers:authorization:poll',
    'providers:authorization:bind', 'providers:authorization:refresh',
    'providers:authorization:quota', 'providers:balance:query', 'providers:billing:sync',
    'providers:probeGeneration'
  ], {
    ...OPAQUE, evidence: 'executeProviderOperationEffect'
  }),
  policyGroup(['browser:bounds', 'browser:close'], LOCAL),
  policyGroup([
    'dataRetention:saveExport',
    'dialog:pickDirectory',
    'plugins:reveal',
    'providers:gateway:copy-token',
    'sessions:restoreCheckpoint', 'sessions:rewindFiles',
    'workflowLedger:exportArtifact', 'workflowLedger:exportArtifactManifest',
    'workflowLedger:exportProjectDeliveryManifest', 'workflowLedger:exportProjectDeliveryPackage',
    'workflowLedger:exportDeliveryIdentityBackup', 'workflowLedger:exportDeliveryIdentityTrustBundle',
    'workflowLedger:importDeliveryIdentityTrustBundle', 'workflowLedger:restoreDeliveryIdentityBackup',
    'workflowLedger:saveProjectDeliveryPackageVerificationReceipt'
  ], DIRECT_USER),
  policyGroup(['memory:taskAdd'], { impact: 'local', effect: 'direct_user', replay: 'never' }),
  delegatedPolicyGroup({
    'routines:runNow': 'runRoutineNow',
    'sessions:create': 'sessionManager.create',
    'personalTasks:command': 'PersonalTaskService.submit -> sessionManager.send',
    'sessions:dispatchSubagents': 'sessionManager.dispatchSubagents',
    'sessions:dispatchTaskDag': 'sessionManager.dispatchTaskDag',
    'sessions:send': 'sessionManager.send',
    'taskSnapshots:recover': 'sessionManager.recoverTaskSnapshot'
  })
)

export const AGENT_TOOL_EFFECT_ENTRY_POLICIES = mergePolicyGroups(
  policyGroup(['inspect_media', 'inspect_office_artifact', 'plan_office_revision'], READ_ONLY),
  delegatedPolicyGroup({
    create_video_production: 'MediaStore.createVideoProduction deterministic creation identity',
    submit_media_job: 'MediaRuntime.submitMediaJob request budget and executeInteractiveOperationEffect',
    advance_media_job: 'MediaRuntime.advanceMediaJob original MediaJob effect lease',
    reconcile_media_job: 'MediaRuntime.reconcileMediaJob verified original-job query lease'
  }),
  policyGroup([
    'browser_automation_status', 'browser_read', 'browser_screenshot', 'browser_wait_for', 'browser_debug_snapshot',
    'china_notify', 'draft_skill', 'find_file', 'genesis_orchestrate',
    'get_dependencies', 'git_diff', 'git_status', 'gitee_prepare',
    'gui_list_windows', 'gui_screenshot', 'list_dir', 'list_skills', 'load_skill',
    'memory_search', 'read_file', 'route_model', 'run_skill', 'search_code',
    'search_symbol', 'task_decompose', 'view'
  ], READ_ONLY),
  policyGroup([
    'revise_office_artifact', 'create_document', 'create_pdf', 'create_presentation', 'create_spreadsheet',
    'edit_file', 'git_commit', 'git_create_issue', 'git_create_pr', 'git_merge',
    'git_push', 'git_stage', 'git_stage_all', 'write_file', 'workspace_handoff', 'task_handoff'
  ], QUERYABLE),
  policyGroup(['artifact_register', 'project_knowledge_search', 'work_item_comment'], LOCAL),
  policyGroup([
    'code_forge_delivery', 'search_replace',
    'gui_activate_window', 'gui_click', 'gui_hotkey', 'gui_scroll', 'gui_type'
  ], CONDITIONAL),
  policyGroup([
    'bash',
    'browser_click', 'browser_evaluate', 'browser_navigate', 'browser_type', 'browser_debug_evaluate',
    'mcp_builtin_servers', 'mcp_call_tool', 'mcp_discover',
    'memory_add', 'optimize_skill', 'send_notification',
    'task_decompose_and_dispatch_dag', 'task_dispatch_dag'
  ], OPAQUE)
)

export const GATEWAY_ACTION_EFFECT_ENTRY_POLICIES = {
  'projectWorkspace:invoke': mergePolicyGroups(
    policyGroup([
      'authorization:get', 'collaborationInbox:list', 'comments:list', 'comments:listProject',
      'get', 'knowledge:preview', 'goals:get', 'goals:list', 'invitations:list', 'list',
      'members:get', 'members:list', 'sharedApprovals:get', 'sharedApprovals:list',
      'portfolio:get', 'squads:get', 'squads:list', 'workItems:get', 'workItems:list', 'contents:list'
    ], READ_ONLY),
    policyGroup([
      'connectors:mutate', 'knowledge:search',
      'archive', 'collaborationInbox:mark', 'comments:create', 'comments:delete', 'comments:update', 'create', 'createWithTemplate', 'delete',
      'export:data', 'goals:acceptance', 'goals:archive', 'goals:create', 'goals:restore',
      'goals:transition', 'goals:update', 'goalTask:create', 'restore',
      'invitations:accept', 'invitations:create', 'invitations:revoke',
      'members:create', 'members:revoke', 'members:restore', 'members:update',
      'portfolio:dependencies:create', 'portfolio:dependencies:remove',
      'portfolio:milestones:create', 'portfolio:milestones:delete', 'portfolio:milestones:update',
      'sharedApprovals:create', 'sharedApprovals:decide', 'sharedApprovals:revoke',
      'squads:archive', 'squads:create', 'squads:members:add', 'squads:members:remove',
      'squads:restore', 'squads:update', 'templates:apply', 'update',
      'workItems:acceptance', 'workItems:create', 'workItems:lease:acquire',
      'workItems:lease:release', 'workItems:lease:renew', 'workItems:reorder',
      'workItems:transfer', 'workItems:transition', 'workItems:update'
    ], LOCAL),
    policyGroup(['import:data', 'purge'], QUERYABLE),
    policyGroup(['export'], DIRECT_USER)
  ),
  'digitalWorker:invoke': mergePolicyGroups(
    policyGroup([
      'exportDigitalWorkerHistory', 'getDigitalWorker', 'getDigitalWorkerAssignment',
      'getDigitalWorkerAssignmentOwnerJournal', 'getDigitalWorkerHistory',
      'getDigitalWorkerLease', 'getDigitalWorkerRoleTemplate', 'getDigitalWorkerStoreSnapshot',
      'listDigitalWorkerAssignmentHistory', 'listDigitalWorkerAssignmentOwnerAudit',
      'listDigitalWorkerAssignments', 'listDigitalWorkerAuditEvents', 'listDigitalWorkerLeases',
      'listDigitalWorkerMemory', 'listDigitalWorkerRoleTemplates', 'listDigitalWorkers',
      'recommendDigitalWorkerTeam', 'verifyDigitalWorkerStore'
    ], READ_ONLY),
    policyGroup([
      'acquireDigitalWorkerLease', 'activateDigitalWorker', 'approveDigitalWorkerMemory',
      'coordinateDigitalWorkerAssignmentOwner', 'createDigitalWorker',
      'createDigitalWorkerAssignment', 'createDigitalWorkerRoleTemplate',
      'deleteDigitalWorker', 'deleteDigitalWorkerMemory', 'deleteDigitalWorkerRoleTemplate',
      'heartbeatDigitalWorkerLease', 'pauseDigitalWorker',
      'proposeDigitalWorkerMemory', 'reassignDigitalWorkerAssignment',
      'recoverDigitalWorkerAssignmentOwners', 'refreshDigitalWorkerPerformance',
      'rejectDigitalWorkerMemory', 'revokeDigitalWorkerMemory',
      'releaseDigitalWorkerAssignment', 'releaseDigitalWorkerLease',
      'resumeDigitalWorker', 'retireDigitalWorker', 'updateDigitalWorker',
      'updateDigitalWorkerRoleTemplate'
    ], LOCAL)
  ),
  'supervisor:invoke': mergePolicyGroups(
    policyGroup(['events', 'get', 'list'], READ_ONLY),
    policyGroup([
      'approval:request', 'approval:resolve', 'block', 'cancel', 'complete', 'create',
      'control:lease:claim', 'fail', 'lease:acquire', 'lease:heartbeat', 'lease:reassign', 'lease:release',
      'pause', 'reconcile', 'recover', 'resume', 'retry', 'start'
    ], LOCAL)
  ),
  'appFeatures:invoke': mergePolicyGroups(
    policyGroup(['voice-input/transcribe'], DIRECT_USER),
    policyGroup([
      'office-revision/inspect', 'office-revision/plan',
      'session-query/discover',
      'provider-profile/backups', 'provider-profile/backup-preview',
      'voice-input/prepare', 'provider-profile/native-preview',
      'provider-profile/native-backups', 'provider-profile/native-codex-preview',
      'provider-profile/preview',
      'provider-profile-sync/status', 'provider-profile-sync/preview',
      'provider-profile-sync/webdav-config', 'provider-profile-sync/webdav-preview',
      'provider-profile-sync/webdav-history-list', 'provider-profile-sync/webdav-history-preview',
      'provider-profile-sync/s3-config', 'provider-profile-sync/s3-preview',
      'provider-profile-sync/s3-history-list', 'provider-profile-sync/s3-history-preview',
      'studio-result/audit', 'studio-result/export', 'studio-result/get', 'task-plan/get'
    ], READ_ONLY),
    policyGroup([
      'voice-input/permission', 'voice-input/cancel', 'provider-profile/native-apply',
      'provider-profile/export', 'provider-profile/native-codex-apply',
      'provider-profile/native-rollback',
      'provider-profile-sync/choose-directory', 'provider-profile-sync/disconnect',
      'provider-profile-sync/webdav-save', 'provider-profile-sync/webdav-remove',
      'provider-profile-sync/s3-save', 'provider-profile-sync/s3-remove',
      'studio-result/save', 'task-plan/approve', 'task-plan/create-version', 'task-plan/generate', 'task-plan/compile-mission',
      'task-plan/revoke', 'task-plan/strategy'
    ], LOCAL),
    policyGroup([
      'provider-profile/apply', 'provider-profile/backup-apply', 'provider-profile/backup-delete', 'provider-profile/rollback',
      'provider-profile-sync/publish', 'provider-profile-sync/apply',
      'provider-profile-sync/webdav-publish', 'provider-profile-sync/webdav-apply',
      'provider-profile-sync/webdav-history-apply',
      'provider-profile-sync/s3-publish', 'provider-profile-sync/s3-apply',
      'provider-profile-sync/s3-history-apply'
    ], {
      ...QUERYABLE,
      evidence: 'executeProviderProfileOperationDelivery'
    }),
    policyGroup([
      'provider-profile-sync/webdav-test', 'provider-profile-sync/s3-test'
    ], OPAQUE),
    policyGroup([
      'media/continuity:check', 'media/ffmpeg:get', 'media/get', 'media/job:reconcile', 'media/provider:list'
    ], READ_ONLY),
    policyGroup([
      'media/asset:adopt', 'media/asset:bind', 'media/asset:egress', 'media/asset:import', 'media/asset:purge',
      'media/asset:retention', 'media/asset:voice-clone', 'media/bible:delete', 'media/bible:upsert',
      'media/budget:update', 'media/compose', 'media/continuity-lock:delete', 'media/continuity-lock:upsert',
      'media/dialogue:delete', 'media/dialogue:upsert', 'media/production:create', 'media/production:revise',
      'media/provider:delete', 'media/provider:upsert', 'media/shot:create', 'media/shot:update', 'media/storage:update',
      'media/timeline:update'
    ], LOCAL),
    policyGroup(['media/job:advance', 'media/job:cancel', 'media/job:submit'], {
      ...QUERYABLE,
      evidence: 'executeMediaJobEffect'
    }),
    delegatedPolicyGroup({
      'task-plan/dispatch': 'sessionManager.dispatchApprovedTaskPlan'
    })
  )
} as const

/**
 * Resolve the inventory contract used by the native tool Effect runtime.
 *
 * IPC and gateway entries are intentionally not inferred from a tool name:
 * they have an explicit channel/action boundary owned by their caller. Native
 * tools, however, enter the Effect ledger with their canonical tool id, so a
 * direct lookup is the only safe default. Unknown names stay unclassified and
 * therefore retain the runtime's existing fail-closed target handling.
 */
export function effectEntryPolicyForTool(toolName: string): EffectEntryPolicy | undefined {
  const id = toolName.trim()
  return AGENT_TOOL_EFFECT_ENTRY_POLICIES[id] ?? IPC_EFFECT_ENTRY_POLICIES[id]
}

export function effectEntryReplayPolicyForTool(toolName: string): EffectEntryReplayPolicy | undefined {
  return effectEntryPolicyForTool(toolName)?.replay
}

export const EFFECT_FREE_AGENT_TOOL_NAMES = Object.freeze(
  Object.entries(AGENT_TOOL_EFFECT_ENTRY_POLICIES)
    .filter(([, policy]) => policy.impact === 'read_only')
    .map(([name]) => name)
)

function policyGroup(ids: readonly string[], policy: EffectEntryPolicy): Record<string, EffectEntryPolicy> {
  return Object.fromEntries(ids.map((id) => [id, policy]))
}

function delegatedPolicyGroup(entries: Record<string, string>): Record<string, EffectEntryPolicy> {
  return Object.fromEntries(Object.entries(entries).map(([id, evidence]) => [id, {
    impact: 'external', effect: 'delegated', replay: 'downstream_barrier', evidence
  } satisfies EffectEntryPolicy]))
}

function mergePolicyGroups(...groups: Array<Record<string, EffectEntryPolicy>>): Record<string, EffectEntryPolicy> {
  const result: Record<string, EffectEntryPolicy> = {}
  for (const group of groups) {
    for (const [id, policy] of Object.entries(group)) {
      if (result[id]) throw new Error(`Effect entry policy declared twice: ${id}`)
      result[id] = Object.freeze({ ...policy })
    }
  }
  return Object.freeze(result)
}
