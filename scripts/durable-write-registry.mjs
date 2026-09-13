function writer(file, contract) {
  return { file, owner: file, ...contract }
}

function domain(file, schema, version, strategy, recovery, rationale, extra = {}) {
  return writer(file, { dataClass: 'domain_state', schema, version, strategy, recovery, rationale, ...extra })
}

function journal(file, schema, version, strategy, recovery, rationale, extra = {}) {
  return writer(file, { dataClass: 'journal', schema, version, strategy, recovery, rationale, ...extra })
}

function audit(file, schema, version, strategy, recovery, rationale, extra = {}) {
  return writer(file, { dataClass: 'audit_log', schema, version, strategy, recovery, rationale, ...extra })
}

function derived(file, schema, version, strategy, recovery, rationale, extra = {}) {
  return writer(file, { dataClass: 'derived_index', schema, version, strategy, recovery, rationale, ...extra })
}

function nonDomain(file, dataClass, strategy, recovery, rationale, extra = {}) {
  return writer(file, {
    dataClass,
    schema: 'not_applicable',
    version: 'not_applicable',
    strategy,
    recovery,
    rationale,
    ...extra
  })
}

function exempt(file, dataClass, strategy, rationale, exemption, extra = {}) {
  return nonDomain(file, dataClass, strategy, 'exempt', rationale, { exemption, ...extra })
}

function implemented(file, dataClass, strategy, rationale, extra = {}) {
  return nonDomain(file, dataClass, strategy, 'implemented_unverified', rationale, extra)
}

function gap(file, schema, version, strategy, rationale, gapReason, dataClass = 'domain_state', extra = {}) {
  return writer(file, {
    dataClass,
    schema,
    version,
    strategy,
    recovery: 'gap',
    rationale,
    gap: gapReason,
    ...extra
  })
}

export const DURABLE_WRITE_REGISTRY = [
  domain(
    'src/main/budget/request-budget-store.ts', 'RequestBudgetDocument', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists request budget sessions and idempotent reservations before billable model or media work.'
  ),
  exempt(
    'src/main/agent/context-loader.ts', 'workspace_effect', 'direct_write',
    'Writes user-controlled Project context instead of an internal CaoGen record.',
    'Project context is user workspace content and has no CaoGen domain schema.'
  ),
  exempt(
    'src/main/agent/tools/office-artifact.ts', 'user_artifact', 'effect_guarded_workspace',
    'Publishes a requested Office or PDF artifact under a frozen Effect target.',
    'Office payload formats are user artifacts; their Effect metadata is stored separately.'
  ),
  exempt(
    'src/main/agent/tools/search-replace.ts', 'workspace_effect', 'effect_guarded_workspace',
    'Mutates a user file under identity, content, permission, and Effect guards.',
    'Arbitrary workspace files are user-owned and cannot share one CaoGen schema version.'
  ),
  exempt(
    'src/main/office-revision/effect.ts', 'user_artifact', 'effect_guarded_workspace',
    'Publishes a new Office revision only at a frozen, validated workspace target after canonical approval.',
    'Office bytes are user artifacts; the canonical Effect and lifecycle records own their recovery boundary.'
  ),
  exempt(
    'src/main/personal-task/personal-task-directory.ts', 'workspace_effect', 'effect_guarded_workspace',
    'Creates and verifies the per-WorkItem personal workspace directory boundary.',
    'Directories are workspace scope state and contain no standalone CaoGen domain document.'
  ),
  domain(
    'src/main/personal-task/personal-task-submission-store.ts', 'PersonalTaskSubmissionRecord', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists idempotent personal-task submission receipts used to recover canonical Goal, WorkItem, and Session ownership.'
  ),
  journal(
    'src/main/assignment-owner-coordinator/journal.ts',
    'caogen.assignment-owner-coordinator.json', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists assignment ownership decisions and audit events with revision checks.'
  ),
  implemented(
    'src/main/attachmentOps.ts', 'user_artifact', 'atomic_rename',
    'Publishes immutable attachment bytes after hash and path validation.'
  ),
  implemented(
    'src/main/durable-file.ts', 'migration_backup', 'atomic_fsync_rename',
    'Provides the shared fsync, atomic publication, private-mode, and directory durability primitive.'
  ),
  domain(
    'src/main/browserAnnotations.ts', 'caogen.browser-annotation', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists versioned browser annotation documents durably and upgrades validated legacy records on read.'
  ),
  exempt(
    'src/main/browserView.ts', 'user_artifact', 'direct_write',
    'Writes captured browser screenshots referenced by separately stored annotations.',
    'Screenshot bytes are opaque artifacts; metadata is covered by the annotation writer.'
  ),
  implemented(
    'src/main/code-forge/patch-artifact.ts', 'user_artifact', 'atomic_link',
    'Publishes content-addressed patch artifacts with fsync and no-replace hard-link commit.'
  ),
  journal(
    'src/main/data-lifecycle/project-deletion-backup-store.ts',
    'caogen.project-deletion-backup', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists the digest-bound Project deletion rollback aggregate before destructive phases.'
  ),
  implemented(
    'src/main/data-lifecycle/project-deletion-coordinator.ts', 'workspace_effect', 'delegated_atomic',
    'Deletes Project-owned roots only while advancing a resumable deletion operation.',
    { delegate: 'src/main/data-lifecycle/project-deletion-journal.ts' }
  ),
  journal(
    'src/main/data-lifecycle/project-deletion-journal.ts',
    'caogen.project-deletion-journal', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Records resumable deletion phases before and after each destructive boundary.'
  ),
  journal(
    'src/main/data-lifecycle/project-deletion-proof-store.ts',
    'caogen.project-deletion-proof', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists a digest-bound terminal proof for completed permanent Project deletion.'
  ),
  exempt(
    'src/main/data-lifecycle/data-lifecycle-mutation-lock.ts', 'ephemeral_runtime', 'ephemeral',
    'Creates the private parent directory used by the cross-process data-lifecycle mutation lock.',
    'The lock and its directory are process coordination state recovered through owner liveness, not domain data.'
  ),
  implemented(
    'src/main/data-lifecycle/project-effect-artifact-portability.ts', 'user_artifact', 'atomic_fsync_rename',
    'Materializes and removes digest-bound app-private Git index Effect artifacts under Project import and deletion journals.'
  ),
  domain(
    'src/main/data-lifecycle/retention-authority-store.ts',
    'caogen.data-retention-authority', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists CAS retention policy, immutable legal-hold history, and a monotonic mutation audit chain.'
  ),
  journal(
    'src/main/data-lifecycle/project-import-journal.ts',
    'caogen.project-import-journal', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Records resumable Project import phases and the frozen source identity.'
  ),
  journal(
    'src/main/data-lifecycle/project-import-source-store.ts',
    'caogen.project-import-source', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists the validated Project import source used by resumable import recovery.'
  ),
  domain(
    'src/main/data-lifecycle/project-session-purge.ts',
    'versioned Project-owned session stores', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Rewrites versioned Session stores and removes only terminal worktree projections/receipts under the Project deletion journal.'
  ),
  domain(
    'src/main/data-lifecycle/project-session-portability.ts',
    'Project Session portable projection set', '1', 'delegated_atomic', 'implemented_unverified',
    'Imports versioned Session stores and owned files under the resumable Project import journal.',
    { delegate: 'src/main/data-lifecycle/project-import-journal.ts' }
  ),
  implemented(
    'src/main/data-lifecycle/project-test-evidence.ts', 'user_artifact', 'delegated_atomic',
    'Removes Project-owned test evidence only through the shared Project Session purge boundary.',
    { delegate: 'src/main/data-lifecycle/project-session-purge.ts' }
  ),
  journal(
    'src/main/data-lifecycle/session-deletion-journal.ts',
    'caogen.session-deletion-journal', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Records the frozen Session identity and resumable deletion phases before destructive boundaries.'
  ),
  journal(
    'src/main/projectRefactorJournal.ts',
    'caogen.project-refactor-journal', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists digest-bound TypeScript refactor snapshots before mutation and supports bounded startup compensation or rollback.'
  ),
  domain(
    'src/main/data-lifecycle/workflow-project-purge.ts',
    'workflow ledger SQLite plus artifact content', '9', 'delegated_atomic', 'implemented_unverified',
    'Purges canonical workflow rows and content under the Project deletion coordinator.',
    { delegate: 'src/main/data-lifecycle/project-deletion-journal.ts' }
  ),
  domain(
    'src/main/digital-worker/persistence.ts',
    'DigitalWorkerStoreDocument', 'store 2 / record 1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists DigitalWorker identities, assignments, leases, and audit history.'
  ),
  exempt(
    'src/main/fileOps.ts', 'workspace_effect', 'effect_guarded_workspace',
    'Writes user workspace files under frozen path and content preconditions.',
    'Arbitrary user file contents do not use an internal CaoGen store schema.'
  ),
  exempt(
    'src/main/git/git-helper.ts', 'ephemeral_runtime', 'direct_write',
    'Creates isolated temporary Git hook and object directories for guarded commands.',
    'All discovered filesystem writes are process-scoped Git safety scaffolding.'
  ),
  journal(
    'src/main/git/git-index-artifact.ts',
    'caogen.git-index-artifact', '1', 'atomic_link', 'implemented_unverified',
    'Publishes immutable Git index artifacts and validates their frozen identity and digest.'
  ),
  exempt(
    'src/main/git/git-index-state.ts', 'workspace_effect', 'effect_guarded_workspace',
    'Restores the external Git index under a reconciled Effect and frozen repository identity.',
    'The Git index is repository-owned state; CaoGen stores its recovery artifact separately.'
  ),
  exempt(
    'src/main/git/managed-worktree-effect.ts', 'workspace_effect', 'effect_guarded_workspace',
    'Creates and removes Git worktrees under queryable Effect reconciliation.',
    'Git worktree state is external repository state rather than a CaoGen domain document.'
  ),
  exempt(
    'src/main/git/pull-request-effect.ts', 'ephemeral_runtime', 'ephemeral',
    'Creates isolated temporary directories for remote Git and pull-request probes.',
    'The directories are deleted after each probe and contain no durable domain state.'
  ),
  exempt(
    'src/main/git/worktree-hunk-effect.ts', 'ephemeral_runtime', 'ephemeral',
    'Builds a temporary sandbox to preflight a single reverse patch.',
    'The sandbox is deleted after validation and is never a recovery source.'
  ),
  exempt(
    'src/main/gui/gui-controller.ts', 'ephemeral_runtime', 'ephemeral',
    'Writes short-lived automation scripts used by the GUI controller.',
    'Generated scripts are execution scratch files and are not restored after restart.'
  ),
  exempt(
    'src/main/gui/macos-controller.ts', 'ephemeral_runtime', 'ephemeral',
    'Writes and removes temporary macOS automation scripts.',
    'Generated scripts are execution scratch files and are not durable application data.'
  ),
  exempt(
    'src/main/gui/windows-controller.ts', 'ephemeral_runtime', 'ephemeral',
    'Writes short-lived Windows automation scripts.',
    'Generated scripts are execution scratch files and are not durable application data.'
  ),
  domain(
    'src/main/history.ts', 'HistoryStoreDocument', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists the versioned visible session history and recovery metadata before publishing cache updates.'
  ),
  exempt(
    'src/main/imageOcr.ts', 'ephemeral_runtime', 'ephemeral',
    'Materializes temporary image bytes for an OCR subprocess.',
    'The OCR input is removed after use and never participates in restart recovery.'
  ),
  derived(
    'src/main/indexer/index.ts', 'Project code-index SQLite metadata', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Exports the rebuildable sql.js code index durably and rejects unsupported schema metadata.'
  ),
  implemented(
    'src/main/ipc/data-retention-handlers.ts', 'user_artifact', 'atomic_fsync_rename',
    'Publishes a user-selected redacted retention authority audit export with durable replacement.'
  ),
  exempt(
    'src/main/project-workspace/managed-personal-workspace.ts', 'workspace_effect', 'effect_guarded_workspace',
    'Creates the app-owned personal workspace root for unassigned sessions.',
    'The empty directory is a workspace boundary and contains no domain record by itself.'
  ),
  implemented(
    'src/main/learning/learning-materialization.ts', 'user_artifact', 'atomic_fsync_rename',
    'Publishes approved Skill materialization with a digest and a learning-store journal.'
  ),
  domain(
    'src/main/learning/learning-store.ts',
    'LearningPersistedState', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists drafts, approvals, revocations, audit events, and materialization state.'
  ),
  domain(
    'src/main/managed-worktree-lifecycle.ts', 'ManagedWorktreeRegistryDocument', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists a versioned managed-worktree registry while accepting and migrating legacy arrays.'
  ),
  domain(
    'src/main/memory/memory-manager.ts',
    'LayeredMemoryStore', '1', 'atomic_rename', 'implemented_unverified',
    'Persists the canonical layered Memory index with an explicit store version.'
  ),
  domain(
    'src/main/memoryStore.ts', 'caogen.project-memory-entry', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Retains the legacy per-entry Memory bridge with versioned documents and durable upgrade-on-read publication.'
  ),
  implemented(
    'src/main/migration-apply.ts', 'migration_backup', 'delegated_atomic',
    'Creates private migration staging and backup directories before applying decisions.',
    { delegate: 'src/main/migration-safety.ts' }
  ),
  journal(
    'src/main/migration-contract.ts', 'caogen.migration-contract', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists digest-bound migration state transitions, target progress, and recovery decisions durably.'
  ),
  implemented(
    'src/main/migration-safety.ts', 'migration_backup', 'atomic_rename',
    'Publishes validated file and directory snapshots through same-parent rename staging.'
  ),
  domain(
    'src/main/modelStats.ts', 'ModelStatsFile', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists routing outcome counters and latency moving averages before updating the in-memory view.'
  ),
  domain(
    'src/main/notification/notification-connector-store.ts',
    'StoredNotificationConnector', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists encrypted notification connector metadata and revisions.'
  ),
  audit(
    'src/main/permission/audit-log.ts', 'AuditLogRecordV1 JSONL', '1', 'append_log', 'implemented_unverified',
    'Appends v1 permission and tool execution records, preserves legacy or torn-tail evidence behind JSONL framing, and fsyncs each append plus newly-created POSIX directory entries.'
  ),
  implemented(
    'src/main/plugin/plugin-directory-effect.ts', 'user_artifact', 'atomic_rename',
    'Stages managed plugin content and publishes install or uninstall transitions through rename.'
  ),
  domain(
    'src/main/pluginRegistry.ts', 'PluginRegistryState', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists plugin enablement state independently from scanned plugin content.'
  ),
  domain(
    'src/main/previewAnnotations.ts', 'caogen.preview-annotation', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists versioned preview review annotations durably and upgrades validated legacy records on read.'
  ),
  exempt(
    'src/main/previewVisual.ts', 'ephemeral_runtime', 'ephemeral',
    'Writes sanitized Quick Look metadata inside a process-owned temporary preview root.',
    'All generated preview files are removed after the in-memory preview is produced.'
  ),
  domain(
    'src/main/project-aggregate/project-aggregate-seal-store.ts',
    'caogen.project-aggregate-seals', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists digest-sealed Project aggregate revisions and object counts.'
  ),
  domain(
    'src/main/project-portfolio/store.ts',
    'caogen.project-portfolio', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists cross-Project dependencies and Project-owned milestones with revision checks and cycle validation.'
  ),
  domain(
    'src/main/media/media-store.ts',
    'caogen.media-studio', '2', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists versioned Project-owned video productions, shots, assets, MediaJobs and canonical operation bindings.'
  ),
  implemented(
    'src/main/media/media-ffmpeg.ts', 'user_artifact', 'atomic_fsync_rename',
    'Publishes digest-addressed imported and composed media bytes after file and directory synchronization.'
  ),
  implemented(
    'src/main/media/media-provider-runtime.ts', 'user_artifact', 'atomic_fsync_rename',
    'Publishes bounded remote Provider media outputs by digest after resumable streaming and directory synchronization.'
  ),
  implemented(
    'src/main/media/media-runtime.ts', 'user_artifact', 'delegated_atomic',
    'Removes managed media source bytes only inside the Media Store purge state machine.',
    { delegate: 'src/main/media/media-store.ts' }
  ),
  domain(
    'src/main/remote/store.ts',
    'caogen.remote-continuation', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists device bindings, signed command queue, approval records, runner leases and redacted audit metadata; private key material is never accepted by the store.'
  ),
  audit(
    'src/main/projectTestRunner.ts',
    'caogen-project-test-evidence', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists bounded, redacted test outcomes without raw workspace paths or full command output.'
  ),
  exempt(
    'src/main/project-workspace/ledger-shadow-lock.ts', 'ephemeral_runtime', 'ephemeral',
    'Persists a versioned exclusive lock owner only for cross-process serialization.',
    'Lock files are reaped by process liveness and are not recovered as domain state.'
  ),
  domain(
    'src/main/project-workspace/persistence.ts',
    'caogen.project-workspace', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists Project, Goal, WorkItem, Squad, and Comment state under a file lock.'
  ),
  derived(
    'src/main/project-workspace/project-connector-cache.ts',
    'caogen.project-connector-cache', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Publishes rebuildable connector content and citation metadata with content digests and durable replacement.'
  ),
  exempt(
    'src/main/project-workspace/workspace-session-cwd.ts', 'workspace_effect', 'effect_guarded_workspace',
    'Creates a Project-owned working directory for a bound session.',
    'The directory is a workspace boundary and has no standalone domain document.'
  ),
  domain(
    'src/main/projects.ts', 'ProjectStoreDocument', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists the versioned recent and archived Project list used by the application shell.'
  ),
  domain(
    'src/main/provider/providerAuthorizationStore.ts',
    'ProviderAuthorizationAccount', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists versioned Provider authorization accounts, encrypted credentials, and non-secret quota observations with atomic replacement.'
  ),
  domain(
    'src/main/provider/providerBillingStore.ts',
    'ProviderBillingStoreDocument', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists digest-bound external billing statements without credentials, response bodies, source files, or remote URLs.'
  ),
  domain(
    'src/main/provider/providerGatewayStore.ts',
    'ProviderGatewayDocument and ProviderGatewayUsageDocument', '1',
    'atomic_fsync_rename', 'implemented_unverified',
    'Persists encrypted loopback gateway configuration and bounded non-content usage records with symlink rejection.'
  ),
  implemented(
    'src/main/provider/providerNativeConfigImport.ts', 'migration_backup', 'atomic_fsync_rename',
    'Publishes digest-bound native Provider import backups through fsynced atomic replacement.'
  ),
  domain(
    'src/main/provider/providerProfileService.ts',
    'caogen.provider-profile and backup', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Publishes Provider profile exports and digest-bound rollback backups atomically.'
  ),
  domain(
    'src/main/provider/providerProfileBackupWriter.ts',
    'caogen-provider-profile-backup', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Publishes credential-free automatic Provider configuration versions before ordinary create, update, and delete mutations.'
  ),
  domain(
    'src/main/provider/providerProfileSync.ts',
    'caogen-provider-profile-sync envelope and local state', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Publishes credential-free, digest-bound sync revisions and reconciles interrupted local state updates by exact profile equality.'
  ),
  domain(
    'src/main/provider/providerProfileWebDavSync.ts',
    'caogen-provider-profile-webdav-config', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists an OS-encrypted WebDAV credential reference, ancestor digest, auto-sync policy, and bounded status.'
  ),
  domain(
    'src/main/provider/providerProfileS3Sync.ts',
    'caogen-provider-profile-s3-config', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists OS-encrypted S3 credential references, ancestor digest, auto-sync policy, and bounded status.'
  ),
  journal(
    'src/main/provider/providerProfileOperationJournal.ts',
    'caogen-provider-profile-operation-journal', '2', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists digest-bound Provider Profile operation phases and reconciliation conflicts.'
  ),
  implemented(
    'src/main/provider/providerStoreMutationLock.ts', 'ephemeral_runtime', 'atomic_fsync_rename',
    'Publishes cross-process Provider Store lock ownership and bounded crash-recovery tombstones.'
  ),
  domain(
    'src/main/providerHealth.ts',
    'ProviderHealthFile', '1', 'atomic_rename', 'implemented_unverified',
    'Persists bounded Provider health and failure history for routing decisions.'
  ),
  domain(
    'src/main/provider/providerStoreRepository.ts', 'caogen.provider-store', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Serializes versioned Provider configuration and encrypted credential references durably behind the global mutation lock.'
  ),
  domain(
    'src/main/routines/routine-runner.ts',
    'RoutineRunFile', '1', 'atomic_rename', 'implemented_unverified',
    'Persists bounded Routine run, review, artifact, and resumption state.'
  ),
  domain(
    'src/main/routineStore.ts',
    'RoutineFile', '1', 'atomic_rename', 'implemented_unverified',
    'Persists versioned Routine definitions through same-directory rename publication.'
  ),
  exempt(
    'src/main/sandbox/local-execution.ts', 'workspace_effect', 'effect_guarded_workspace',
    'Mutates user files through frozen preconditions, no-follow handles, and Effect recovery.',
    'Arbitrary workspace files are external state and do not share a CaoGen schema version.'
  ),
  domain(
    'src/main/session-active-registry.ts', 'ActiveSessionRegistryDocument', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists a versioned active-session restart registry while accepting legacy arrays.'
  ),
  domain(
    'src/main/search/search-broker.ts', 'caogen.search-broker.v1', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists bounded idempotent Search attempts and adapter outcomes before publishing canonical Evidence references.'
  ),
  journal(
    'src/main/session-runtime-continuation-store.ts', 'ActiveSessionRegistryDocument runtime continuation receipt', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists the digest-bound runtime continuation commit receipt used to align a Session after restart.'
  ),
  journal(
    'src/main/session-creation-journal.ts',
    'PendingSessionCreationRecord', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists the pre-creation session intent needed to resume or abandon startup safely.'
  ),
  domain(
    'src/main/settings-file-storage.ts', 'RoutingSettingsDocument', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists versioned application, routing, permission, layout, and Office settings through compare-and-swap atomic replacement.'
  ),
  implemented(
    'src/main/skill/skill-optimizer.ts', 'user_artifact', 'atomic_rename',
    'Publishes optimized Skill content through a same-directory temporary file and rename.'
  ),
  implemented(
    'src/main/task/artifact-lifecycle-api.ts', 'user_artifact', 'delegated_atomic',
    'Coordinates artifact content quarantine with canonical workflow metadata mutation.',
    { delegate: 'src/main/task/task-snapshot.ts' }
  ),
  implemented(
    'src/main/task/artifact-lifecycle-content.ts', 'user_artifact', 'atomic_fsync_rename',
    'Publishes immutable digest-addressed Artifact blobs after file fsync and digest verification.'
  ),
  implemented(
    'src/main/task/workflow-artifact-delivery.ts', 'user_artifact', 'atomic_fsync_rename',
    'Publishes verified delivery manifests and ZIP packages after byte verification, file fsync, atomic rename, and directory sync.'
  ),
  implemented(
    'src/main/task/workflow-artifact-export.ts', 'user_artifact', 'atomic_fsync_rename',
    'Copies verified canonical Artifact bytes to user-selected paths with file and directory durability.'
  ),
  domain(
    'src/main/task/workflow-delivery-identity.ts',
    'caogen.workflow-delivery-identity and encrypted backup', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists the encrypted local Ed25519 delivery identity and publishes passphrase-encrypted user backups durably.'
  ),
  domain(
    'src/main/task/workflow-delivery-trust-store.ts',
    'caogen.workflow-delivery-identity-trust-store', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists bounded trusted/revoked delivery identities and organization trust policy with CAS revision, signed portable trust bundles, fsync, atomic publication, and byte readback.'
  ),
  exempt(
    'src/main/task/effect-reconciler.ts', 'ephemeral_runtime', 'ephemeral',
    'Removes temporary reconciliation probe directories after read-only observation.',
    'Probe directories are process-scoped and never serve as durable Effect evidence.'
  ),
  domain(
    'src/main/task/supervisor-state.ts',
    'SupervisorStateDocument', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists Run state, leases, fencing tokens, approvals, budgets, and ordered events.'
  ),
  domain(
    'src/main/task/task-plan-contract-store.ts',
    'TaskPlanContractStore', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists versioned Task plans, approvals, and canonical projection receipts.'
  ),
  domain(
    'src/main/task/task-snapshot.ts',
    'workflow ledger and Task Snapshot SQLite', '9', 'sqlite_transaction_export', 'implemented_unverified',
    'Serializes sql.js mutations and publishes the exported database through fsync and rename.'
  ),
  journal(
    'src/main/task/workflow-ledger-migration-storage.ts',
    'caogen.workflow-ledger migration journal', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Persists migration journals, candidates, backups, and readiness evidence durably.'
  ),
  implemented(
    'src/main/task/workflow-ledger-migration.ts', 'migration_backup', 'delegated_atomic',
    'Coordinates resumable workflow-ledger migration directories and cleanup.',
    { delegate: 'src/main/task/workflow-ledger-migration-storage.ts' }
  ),
  exempt(
    'src/main/terminal.ts', 'ephemeral_runtime', 'ephemeral',
    'Repairs the executable bit on a packaged node-pty helper when necessary.',
    'The helper is rebuildable package content and is unrelated to user or domain recovery.'
  ),
  audit(
    'src/main/transcript.ts', 'ConversationLedgerEntry JSONL', '1', 'append_log', 'implemented_unverified',
    'Persists sealed canonical entries through fsynced append and fsync-before-rename replacement; redacted receipts are rebuildable projections.'
  ),
  implemented(
    'src/main/utils/backup.ts', 'migration_backup', 'atomic_fsync_rename',
    'Publishes private pre-edit backup bytes only after file fsync, atomic rename, and directory fsync.'
  ),
  exempt(
    'src/main/vendorIcons.ts', 'ephemeral_runtime', 'direct_write',
    'Caches downloaded Provider icons for presentation.',
    'Icon cache entries are derived, replaceable, and never a recovery source.'
  ),
  audit(
    'src/main/worktreeMerge.ts', 'caogen.worktree-merge-receipts', '1', 'atomic_fsync_rename', 'implemented_unverified',
    'Durably publishes exported patches and the bounded, versioned merge receipt history.'
  ),
  exempt(
    'src/main/worktrees.ts', 'user_artifact', 'direct_write',
    'Exports a generated patch artifact for a managed worktree.',
    'Patch export is an explicit user artifact that can be regenerated from the worktree.'
  )
].sort((left, right) => left.file.localeCompare(right.file))
