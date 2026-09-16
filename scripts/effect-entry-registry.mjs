function entries(ids, contract) {
  return ids.map((id) => ({ id, ...contract }))
}

function tools(names) {
  return names.map((name) => `tool:${name}`)
}

function ipc(channels) {
  return channels.map((channel) => `ipc:${channel}`)
}

function actions(channel, names) {
  return names.map((name) => `ipc-action:${channel}#${name}`)
}

function contract(access, effectPolicy, replayPolicy, owner, rationale, extra = {}) {
  return { access, effectPolicy, replayPolicy, owner, rationale, ...extra }
}

const readOnlyTool = contract(
  'read_only', 'none', 'not_applicable',
  'src/main/task/tool-idempotency.ts',
  'The runtime permission contract classifies this tool as observation-only.'
)
const readOnlyIpc = contract(
  'read_only', 'none', 'not_applicable',
  'src/main/ipc.ts and registered IPC modules',
  'The handler returns inspection data without committing a domain or external mutation.'
)
const opaqueTool = contract(
  'mutation', 'opaque', 'manual_only',
  'src/main/task/effect-target-builder.ts',
  'The tool can mutate state but has no universal read-only query contract, so uncertain recovery stops.'
)
const opaqueIpc = contract(
  'mutation', 'opaque', 'manual_only',
  'registered IPC handler owner',
  'The IPC can cross a process or external boundary and has no safe automatic replay contract.'
)
const durableTool = contract(
  'mutation', 'durable_local', 'idempotent_resume',
  'src/main/project-workspace/store.ts',
  'The local domain store owns deterministic identity, atomic persistence, and idempotent recovery.'
)
const durableIpc = contract(
  'mutation', 'durable_local', 'idempotent_resume',
  'registered durable domain store owner',
  'The local owner provides revision checks, atomic persistence, and deterministic recovery.'
)
const ephemeralIpc = contract(
  'mutation', 'none', 'not_applicable',
  'registered window or process lifecycle owner',
  'The mutation is process-local presentation state and is never replayed after restart.',
  { boundary: 'ephemeral_local' }
)
const directUserIpc = contract(
  'mutation', 'direct_user', 'never',
  'registered native dialog IPC handler owner',
  'The operation is explicitly initiated by the user and crosses a native file dialog; it is never replayed.'
)
const delegatedIpc = (evidence) => contract(
  'mutation', 'delegated', 'downstream_barrier',
  'src/main/sessionManager.ts',
  'The operation delegates to the canonical Session/Supervisor lifecycle, which owns durable recovery and reconciliation.',
  { evidence }
)
const blockedIpc = contract(
  'mutation', 'none', 'not_applicable',
  'src/main/ipc/workflow-ledger-handlers.ts',
  'The compatibility channel authenticates the caller and rejects before executing a write.',
  { boundary: 'blocked_before_execution' }
)
const queryable = (effectTargets, owner) => contract(
  'mutation', 'queryable', 'reconcile_before_retry', owner,
  'A frozen EffectTarget has a read-only Reconciler; any retry remains explicitly authorized.',
  { effectTargets }
)

const readOnlyToolNames = [
  'browser_automation_status', 'browser_screenshot', 'browser_wait_for', 'china_notify',
  'draft_skill', 'find_file', 'genesis_orchestrate', 'get_dependencies', 'git_diff',
  'git_status', 'gitee_prepare', 'gui_list_windows', 'gui_screenshot', 'list_dir',
  'list_skills', 'load_skill', 'memory_search', 'read_file', 'route_model', 'run_skill',
  'search_code', 'search_symbol', 'task_decompose', 'view',
  'inspect_media', 'inspect_office_artifact', 'plan_office_revision'
]

const opaqueToolNames = [
  'bash', 'browser_click', 'browser_evaluate', 'browser_navigate', 'browser_type',
  'mcp_builtin_servers', 'mcp_call_tool', 'mcp_discover',
  'memory_add', 'optimize_skill', 'send_notification'
]

const durableToolNames = [
  'artifact_register', 'project_knowledge_search', 'task_decompose_and_dispatch_dag',
  'task_dispatch_dag', 'work_item_comment'
]

const readOnlyIpcChannels = [
  'assistantSearch:getAttempt', 'attachments:ocr', 'browser:listAnnotations', 'browser:observe', 'dialog:pickDirectory',
  'dataRetention:evaluatePurge', 'dataRetention:get', 'dataRetention:pending',
  'engines:list', 'files:intelligence',
  'git:status', 'history:list', 'learning:list',
  'memory:layeredExport', 'memory:layeredList', 'memory:layeredSearch', 'memory:read',
  'migration:scan', 'modelAttempts:listReconciliations', 'notificationConnectors:list',
  'plugins:authorize', 'plugins:reveal', 'plugins:scan', 'preview:listAnnotations', 'projectContext:read',
  'projectContext:template', 'projects:list', 'providers:fetchModels', 'providers:health',
  'permissions:grants:list',
  'providers:authorization:accounts', 'providers:balance:capability',
  'providers:billing:capability', 'providers:billing:list', 'providers:billing:reconcile',
  'providers:fetchPricingCatalog', 'providers:list', 'providers:usage',
  'providers:gateway:models', 'providers:gateway:status',
  'quickbar:getState', 'quickbar:getWindowContext', 'quickbar:pickFiles',
  'quickbar:readClipboard', 'routines:list', 'routines:listRuns', 'routines:listTemplates',
  'sessions:list', 'sessions:outboundContextPreview', 'sessions:pendingPermissions',
  'sessions:suggestFiles', 'sessions:transcript',
  'settings-domain:get', 'settings-domain:routing:get', 'settings-domain:routing:preview', 'startSuggestions:get',
  'taskSnapshots:list', 'taskSnapshots:effectRecovery', 'terminals:list', 'transcripts:search', 'workflowLedger:diagnose',
  'workflowLedger:export', 'workflowLedger:list', 'workflowLedger:listArtifactEdges',
  'workflowLedger:listArtifactLocations', 'workflowLedger:listEvidence',
  'workflowLedger:compareArtifacts', 'workflowLedger:listDeliveryTrustedIdentities',
  'workflowLedger:projectDeliveryWorkbench', 'workflowLedger:queryArtifactGraph', 'workflowLedger:queryEvidence',
  'workflowLedger:repairPlan', 'workflowLedger:verify',
  'workflowLedger:verifyArtifactGraph', 'workflowLedger:verifyArtifactIntegrity',
  'workflowLedger:verifyEvidence', 'workflowLedger:verifyProjectDelivery',
  'workflowLedger:verifyProjectDeliveryPackage', 'workspace:diff',
  'worktrees:applyCheck', 'worktrees:conflictFiles', 'worktrees:mergeInspect',
  'worktrees:mergeReceipts', 'worktrees:summary'
]

const durableIpcChannels = [
  'appFeatures:invoke', 'attachments:copyImage', 'attachments:saveImageBytes',
  'dataRetention:createLegalHold', 'dataRetention:releaseLegalHold', 'dataRetention:updatePolicy',
  'browser:captureAnnotation', 'browser:captureElementAnnotation', 'digitalWorker:invoke',
  'history:delete', 'history:rename', 'history:setArchived', 'history:setPinned',
  'learning:approve', 'learning:delete', 'learning:reject', 'learning:revoke',
  'learning:rollback', 'memory:accept', 'memory:delete', 'memory:layeredArchive',
  'memory:layeredDelete', 'memory:layeredUpdate', 'memory:propose',
  'modelAttempts:resolveReconciliation',
  'notificationConnectors:create', 'notificationConnectors:delete',
  'notificationConnectors:setDefault', 'plugins:approve', 'preview:prepare', 'preview:prepareVisual',
  'preview:saveAnnotation', 'projectContext:write', 'projects:delete', 'projects:update',
  'projectWorkspace:invoke', 'providers:activateLocalCompute', 'providers:create',
  'providers:authorization:revoke', 'providers:billing:remove', 'providers:billing:save',
  'providers:delete', 'providers:update',
  'routines:create', 'routines:delete',
  'routines:markRun', 'routines:reviewRun', 'routines:update', 'sessions:close',
  'sessions:create', 'sessions:rename', 'sessions:setModel', 'sessions:setPermissionMode',
  'settings-domain:routing:save', 'settings-domain:update', 'supervisor:invoke', 'taskSnapshots:delete', 'taskSnapshots:recover',
  'taskSnapshots:resolveDagFinalization', 'taskSnapshots:resolveEffect', 'taskSnapshots:recheckEffect',
  'workflowLedger:createArtifact', 'workflowLedger:createArtifactAcceptance', 'workflowLedger:createArtifactEdge',
  'workflowLedger:createArtifactLocation', 'workflowLedger:createEvidence',
  'workflowLedger:createEvidenceLink', 'workflowLedger:reviewAcceptance',
  'workflowLedger:revokeDeliveryIdentity', 'workflowLedger:rotateDeliveryIdentity',
  'workflowLedger:saveAcceptance', 'workflowLedger:startAcceptanceRepair',
  'workflowLedger:trustDeliveryIdentity', 'workflowLedger:updateDeliveryTrustPolicy',
  'worktrees:exportPatch', 'worktrees:mergePatch'
]

const opaqueIpcChannels = [
  'assistantSearch:search', 'attachments:copyDocument', 'browser:back', 'browser:close', 'browser:forward',
  'browser:navigate', 'browser:open',
  'browser:pickElement', 'browser:reload', 'migration:import', 'plugins:installLocal', 'plugins:probeMcp',
  'plugins:setEnabled', 'plugins:uninstall', 'quickbar:captureScreenshot',
  'quickbar:prepareFiles', 'routines:runNow', 'sessions:decomposeTask',
  'sessions:dispatchSubagents', 'sessions:dispatchTaskDag', 'sessions:interrupt',
  'sessions:permission', 'sessions:restoreCheckpoint', 'sessions:rewindFiles',
  'sessions:send', 'terminals:close', 'terminals:start', 'terminals:write',
  'providers:authorization:start', 'providers:authorization:quick-start',
  'providers:authorization:quick-poll', 'providers:authorization:poll',
  'providers:authorization:bind', 'providers:authorization:refresh',
  'providers:authorization:quota', 'providers:balance:query', 'providers:billing:sync',
  'providers:probeGeneration',
  'providers:gateway:copy-token', 'providers:gateway:update'
]

const ephemeralIpcChannels = [
  'browser:bounds',
  'permissions:grants:revoke',
  'quickbar:setVisible', 'terminals:resize'
]
const directUserIpcChannels = [
  'dataRetention:saveExport', 'workflowLedger:exportArtifact',
  'workflowLedger:exportArtifactManifest', 'workflowLedger:exportDeliveryIdentityBackup',
  'workflowLedger:exportDeliveryIdentityTrustBundle', 'workflowLedger:exportProjectDeliveryManifest',
  'workflowLedger:exportProjectDeliveryPackage', 'workflowLedger:importDeliveryIdentityTrustBundle',
  'workflowLedger:restoreDeliveryIdentityBackup',
  'workflowLedger:saveProjectDeliveryPackageVerificationReceipt'
]
const blockedIpcChannels = [
  'workflowLedger:createGoal', 'workflowLedger:createWorkItem', 'workflowLedger:transitionWorkItem'
]

const readOnlyDigitalWorkerActions = [
  'exportDigitalWorkerHistory', 'getDigitalWorker', 'getDigitalWorkerAssignment',
  'getDigitalWorkerAssignmentOwnerJournal', 'getDigitalWorkerHistory',
  'getDigitalWorkerLease', 'getDigitalWorkerRoleTemplate', 'getDigitalWorkerStoreSnapshot',
  'listDigitalWorkerAssignmentHistory', 'listDigitalWorkerAssignmentOwnerAudit',
  'listDigitalWorkerAssignments', 'listDigitalWorkerAuditEvents', 'listDigitalWorkerLeases',
  'listDigitalWorkerMemory', 'listDigitalWorkerRoleTemplates', 'listDigitalWorkers',
  'recommendDigitalWorkerTeam', 'verifyDigitalWorkerStore'
]
const durableDigitalWorkerActions = [
  'acquireDigitalWorkerLease', 'activateDigitalWorker', 'approveDigitalWorkerMemory',
  'coordinateDigitalWorkerAssignmentOwner',
  'createDigitalWorker', 'createDigitalWorkerAssignment', 'createDigitalWorkerRoleTemplate',
  'deleteDigitalWorker', 'deleteDigitalWorkerMemory', 'deleteDigitalWorkerRoleTemplate',
  'heartbeatDigitalWorkerLease', 'pauseDigitalWorker', 'proposeDigitalWorkerMemory',
  'reassignDigitalWorkerAssignment', 'recoverDigitalWorkerAssignmentOwners',
  'refreshDigitalWorkerPerformance', 'rejectDigitalWorkerMemory', 'revokeDigitalWorkerMemory',
  'releaseDigitalWorkerAssignment', 'releaseDigitalWorkerLease', 'resumeDigitalWorker',
  'retireDigitalWorker', 'updateDigitalWorker', 'updateDigitalWorkerRoleTemplate'
]

const readOnlyProjectWorkspaceActions = [
  'authorization:get', 'collaborationInbox:list', 'comments:list', 'comments:listProject',
  'get', 'knowledge:preview', 'goals:get', 'goals:list', 'invitations:list', 'list',
  'members:get', 'members:list', 'sharedApprovals:get', 'sharedApprovals:list',
  'portfolio:get', 'squads:get', 'squads:list', 'workItems:get', 'workItems:list', 'contents:list'
]
const durableProjectWorkspaceActions = [
  'connectors:mutate', 'knowledge:search',
  'archive', 'collaborationInbox:mark', 'comments:create', 'comments:delete', 'comments:update', 'create', 'createWithTemplate', 'delete',
  'export:data', 'goals:acceptance', 'goals:archive', 'goals:create',
  'goals:restore', 'goals:transition', 'goals:update', 'goalTask:create',
  'invitations:accept', 'invitations:create', 'invitations:revoke',
  'members:create', 'members:revoke', 'members:restore', 'members:update',
  'portfolio:dependencies:create', 'portfolio:dependencies:remove',
  'portfolio:milestones:create', 'portfolio:milestones:delete', 'portfolio:milestones:update',
  'sharedApprovals:create', 'sharedApprovals:decide', 'sharedApprovals:revoke',
  'restore', 'squads:archive', 'squads:create', 'squads:members:add',
  'squads:members:remove', 'squads:restore', 'squads:update', 'templates:apply', 'update',
  'workItems:acceptance', 'workItems:create', 'workItems:lease:acquire',
  'workItems:lease:release', 'workItems:lease:renew', 'workItems:reorder',
  'workItems:transfer', 'workItems:transition', 'workItems:update'
]

const readOnlySupervisorActions = ['events', 'get', 'list']
const durableSupervisorActions = [
  'approval:request', 'approval:resolve', 'block', 'cancel', 'complete', 'create', 'fail',
  'control:lease:claim', 'lease:acquire', 'lease:heartbeat', 'lease:reassign', 'lease:release', 'pause',
  'reconcile', 'recover', 'resume', 'retry', 'start'
]

const readOnlyAppFeatureActions = [
  'office-revision/inspect', 'office-revision/plan',
  'session-query/discover',
  'provider-profile/backups', 'provider-profile/backup-preview', 'provider-profile/native-backups',
  'provider-profile/native-codex-preview', 'provider-profile/preview',
  'provider-profile-sync/status', 'provider-profile-sync/preview',
  'provider-profile-sync/webdav-config', 'provider-profile-sync/webdav-preview',
  'provider-profile-sync/webdav-history-list', 'provider-profile-sync/webdav-history-preview',
  'provider-profile-sync/s3-config', 'provider-profile-sync/s3-preview',
  'provider-profile-sync/s3-history-list', 'provider-profile-sync/s3-history-preview',
  'studio-result/export',
  'studio-result/audit', 'studio-result/get', 'task-plan/get'
]
const durableAppFeatureActions = [
  'provider-profile/export', 'provider-profile/native-codex-apply',
  'provider-profile/native-rollback',
  'provider-profile-sync/choose-directory', 'provider-profile-sync/disconnect',
  'provider-profile-sync/webdav-save', 'provider-profile-sync/webdav-remove',
  'provider-profile-sync/s3-save', 'provider-profile-sync/s3-remove',
  'studio-result/save', 'task-plan/approve', 'task-plan/create-version', 'task-plan/generate',
  'task-plan/revoke', 'task-plan/strategy'
]
const queryableAppFeatureActions = [
  'provider-profile/apply', 'provider-profile/backup-apply', 'provider-profile/backup-delete', 'provider-profile/rollback',
  'provider-profile-sync/publish', 'provider-profile-sync/apply',
  'provider-profile-sync/webdav-publish', 'provider-profile-sync/webdav-apply',
  'provider-profile-sync/webdav-history-apply',
  'provider-profile-sync/s3-publish', 'provider-profile-sync/s3-apply',
  'provider-profile-sync/s3-history-apply'
]
const opaqueAppFeatureActions = ['provider-profile-sync/webdav-test', 'provider-profile-sync/s3-test']
const readOnlyMediaActions = ['continuity:check', 'ffmpeg:get', 'get', 'job:reconcile', 'provider:list']
const durableMediaActions = [
  'asset:adopt', 'asset:bind', 'asset:egress', 'asset:import', 'asset:purge',
  'asset:retention', 'asset:voice-clone', 'bible:delete', 'bible:upsert',
  'budget:update', 'compose', 'continuity-lock:delete', 'continuity-lock:upsert',
  'dialogue:delete', 'dialogue:upsert', 'production:create', 'production:revise',
  'provider:delete', 'provider:upsert', 'shot:create', 'shot:update', 'storage:update',
  'timeline:update'
]
const queryableMediaActions = ['job:advance', 'job:cancel', 'job:submit']

export const EFFECT_ENTRY_REGISTRY = [
  ...entries(tools(readOnlyToolNames), readOnlyTool),
  ...entries(tools(opaqueToolNames), opaqueTool),
  ...entries(tools(durableToolNames), durableTool),
  ...entries(tools(['write_file', 'search_replace', 'edit_file']),
    queryable(['file_content'], 'src/main/task/effect-target-builder.ts')),
  ...entries(tools(['gui_activate_window', 'gui_click', 'gui_hotkey', 'gui_scroll', 'gui_type']),
    queryable(['gui_postcondition'], 'src/main/gui/gui-effect.ts')),
  ...entries(tools(['create_document', 'create_pdf', 'create_presentation', 'create_spreadsheet']),
    queryable(['office_artifact'], 'src/main/agent/tools/office-artifact.ts')),
  ...entries(tools(['revise_office_artifact']),
    queryable(['office_artifact_revision'], 'src/main/office-revision/effect.ts')),
  ...entries(tools(['create_video_production', 'submit_media_job', 'advance_media_job', 'reconcile_media_job']),
    contract('mutation', 'delegated', 'downstream_barrier', 'src/main/media/media-runtime.ts',
      'The exact native media tools delegate through trusted task scope to deterministic media storage and frozen per-job Effect leases.',
      { evidence: 'executeMediaTool -> validateMediaAgentMutation -> MediaRuntime -> prepareEffectExecution/media store durable identities' })),
  ...entries(tools(['git_stage', 'git_stage_all']),
    queryable(['git_index_update'], 'src/main/git/git-index-effect.ts')),
  ...entries(tools(['git_commit']), queryable(['git_commit'], 'src/main/task/effect-reconciler.ts')),
  ...entries(tools(['git_merge']), queryable(['git_merge'], 'src/main/task/effect-reconciler.ts')),
  ...entries(tools(['git_push']), queryable(['git_push'], 'src/main/task/effect-reconciler.ts')),
  ...entries(tools(['git_create_pr']),
    queryable(['pull_request_create'], 'src/main/git/pull-request-effect.ts')),
  ...entries(tools(['git_create_issue']),
    queryable(['issue_create'], 'src/main/git/pull-request-effect.ts')),
  ...entries(tools(['code_forge_delivery']),
    queryable(['code_forge_patch'], 'src/main/code-forge/patch-effect.ts')),

  ...entries(ipc(readOnlyIpcChannels), readOnlyIpc),
  ...entries(ipc(['personalTasks:command']), delegatedIpc('PersonalTaskService.submit -> sessionManager.send')),
  ...entries(ipc(durableIpcChannels), durableIpc),
  ...entries(ipc(opaqueIpcChannels), opaqueIpc),
  ...entries(ipc(ephemeralIpcChannels), ephemeralIpc),
  ...entries(ipc(directUserIpcChannels), directUserIpc),
  ...entries(ipc(blockedIpcChannels), blockedIpc),
  ...entries(ipc(['files:write']), queryable(['file_content'], 'src/main/ipc/renderer-mutation-handlers.ts')),
  ...entries(ipc(['git:commit']), queryable(['git_commit'], 'src/main/ipc/renderer-mutation-handlers.ts')),
  ...entries(ipc(['git:stage', 'git:stageAll', 'git:unstage', 'workspace:applyHunk']),
    queryable(['git_index_update'], 'src/main/ipc/renderer-mutation-handlers.ts')),
  ...entries(ipc(['workspace:discardHunk']),
    queryable(['file_content'], 'src/main/ipc/renderer-mutation-handlers.ts')),
  ...entries(ipc(['worktrees:applyPatch']),
    queryable(['worktree_patch_apply'], 'src/main/ipc/worktree-operation-handlers.ts')),
  ...entries(ipc(['migration:apply', 'migration:rollback']),
    queryable(['migration_operation'], 'src/main/migrationEffect.ts')),
  ...entries(ipc(['worktrees:createPr']),
    queryable(['pull_request_create'], 'src/main/ipc/worktree-operation-handlers.ts')),
  ...entries(ipc(['worktrees:remove']),
    queryable(['git_worktree_remove'], 'src/main/ipc/worktree-operation-handlers.ts')),

  ...entries(actions('digitalWorker:invoke', readOnlyDigitalWorkerActions), readOnlyIpc),
  ...entries(actions('digitalWorker:invoke', durableDigitalWorkerActions), durableIpc),
  ...entries(actions('projectWorkspace:invoke', readOnlyProjectWorkspaceActions), readOnlyIpc),
  ...entries(actions('projectWorkspace:invoke', durableProjectWorkspaceActions), durableIpc),
  ...entries(actions('projectWorkspace:invoke', ['export']), directUserIpc),
  ...entries(actions('projectWorkspace:invoke', ['import:data']),
    queryable(['project_portable_import'], 'src/main/project-import-effect.ts')),
  ...entries(actions('projectWorkspace:invoke', ['purge']),
    queryable(['project_permanent_deletion'], 'src/main/project-deletion-effect.ts')),
  ...entries(actions('supervisor:invoke', readOnlySupervisorActions), readOnlyIpc),
  ...entries(actions('supervisor:invoke', durableSupervisorActions), durableIpc),
  ...entries(actions('appFeatures:invoke', readOnlyAppFeatureActions), readOnlyIpc),
  ...entries(actions('appFeatures:invoke', durableAppFeatureActions), durableIpc),
  ...entries(actions('appFeatures:invoke', opaqueAppFeatureActions), opaqueIpc),
  ...entries(actions('appFeatures:invoke', readOnlyMediaActions.map((action) => `media/${action}`)), readOnlyIpc),
  ...entries(actions('appFeatures:invoke', durableMediaActions.map((action) => `media/${action}`)), durableIpc),
  ...entries(actions('appFeatures:invoke', queryableMediaActions.map((action) => `media/${action}`)),
    queryable(['media_job_operation'], 'src/main/media/media-runtime.ts')),
  ...entries(actions('appFeatures:invoke', queryableAppFeatureActions),
    queryable(['provider_profile_operation', 'media_job_operation'], 'src/main/provider/provider-profile-operation-delivery.ts and src/main/media/media-runtime.ts')),
  ...entries(actions('appFeatures:invoke', ['task-plan/dispatch']),
    delegatedIpc('sessionManager.dispatchApprovedTaskPlan')),

  ...entries(['external:connector:pull-request-create'],
    queryable(['pull_request_create'], 'src/main/git/pull-request-effect.ts')),
  ...entries(['external:connector:issue-create'],
    queryable(['issue_create'], 'src/main/git/pull-request-effect.ts')),
  ...entries([
    'external:connector:mcp-tool-call', 'external:connector:notification-send',
    'external:provider:anthropic-model-request', 'external:provider:openai-model-request'
  ], opaqueIpc)
]
