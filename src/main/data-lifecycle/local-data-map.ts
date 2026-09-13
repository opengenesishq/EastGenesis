export type LocalDataOwnerScope =
  | 'application'
  | 'project'
  | 'session'
  | 'provider'
  | 'user'
  | 'mixed'
  | 'cache'
  | 'external_resource'

export type LocalDataSensitivity = 'internal' | 'personal' | 'confidential' | 'credential'
export type LocalDataImplementationStatus = 'enforced' | 'partial' | 'inventory_only'
export type LocalDataExportMode = 'full' | 'redacted' | 'manifest_only' | 'excluded' | 'regenerable'
export type LocalDataDeleteMode = 'none' | 'record' | 'owner_scope' | 'project_cascade' | 'cache_purge'
export type ExternalDeleteBoundary = 'not_applicable' | 'external_untouched'

export interface LocalDataLifecycleEntry {
  id: string
  title: string
  paths: string[]
  sourceModules: string[]
  owner: {
    scope: LocalDataOwnerScope
    key: string
  }
  sensitivity: LocalDataSensitivity
  backup: {
    behavior: 'none' | 'aggregate_export' | 'private_local' | 'external_owner' | 'regenerable'
    status: LocalDataImplementationStatus
  }
  retention: {
    rule: string
    status: LocalDataImplementationStatus
  }
  export: {
    mode: LocalDataExportMode
    status: LocalDataImplementationStatus
  }
  deletion: {
    softDelete: LocalDataDeleteMode
    purge: LocalDataDeleteMode
    externalDelete: ExternalDeleteBoundary
    status: LocalDataImplementationStatus
  }
  implementationStatus: LocalDataImplementationStatus
  projectObjects?: ProjectAggregateObject[]
  gaps: string[]
}

export const PROJECT_AGGREGATE_OBJECTS = [
  'Workspace',
  'Resource',
  'Goal',
  'WorkItem',
  'Squad',
  'Comment',
  'DigitalWorker',
  'Assignment',
  'Lease',
  'Run',
  'Artifact',
  'Evidence',
  'Acceptance',
  'Memory',
  'Budget',
  'Policy',
  'Audit'
] as const

export type ProjectAggregateObject = (typeof PROJECT_AGGREGATE_OBJECTS)[number]

export const LOCAL_DATA_LIFECYCLE_MAP: LocalDataLifecycleEntry[] = [
  {
    id: 'project-workspace',
    title: 'Canonical Project Workspace and permanent deletion coordination',
    paths: [
      'userData/project-workspace.json',
      'userData/project-portfolio.json',
      'userData/remote-continuation.json',
      'userData/private/project-deletion-journal.json',
      'userData/private/project-deletion-backups/<project-hash>/<operation-hash>.json',
      'userData/private/project-deletion-proofs/<project-hash>/<operation-hash>.json',
      'userData/private/project-import-journal.json',
      'userData/private/project-import-sources/<project-hash>/<operation-hash>.json'
    ],
    sourceModules: [
      'src/main/project-workspace/persistence.ts',
      'src/main/project-workspace/store.ts',
      'src/main/project-portfolio/store.ts',
      'src/main/remote/store.ts',
      'src/main/data-lifecycle/project-deletion-backup-store.ts',
      'src/main/data-lifecycle/project-deletion-proof-store.ts',
      'src/main/data-lifecycle/project-deletion-journal.ts',
      'src/main/data-lifecycle/project-session-purge.ts',
      'src/main/data-lifecycle/project-import-journal.ts',
      'src/main/data-lifecycle/project-import-source-store.ts',
      'src/main/data-lifecycle/project-import-coordinator.ts',
      'src/main/data-lifecycle/project-import-validation.ts'
    ],
    owner: { scope: 'project', key: 'workspace.id' },
    sensitivity: 'personal',
    backup: { behavior: 'aggregate_export', status: 'partial' },
    retention: { rule: 'Archived and soft-deleted records remain until explicit purge; permanent purge is gated by the private retention authority.', status: 'enforced' },
    export: { mode: 'redacted', status: 'partial' },
    deletion: {
      softDelete: 'record',
      purge: 'record',
      externalDelete: 'external_untouched',
      status: 'enforced'
    },
    implementationStatus: 'partial',
    projectObjects: ['Workspace', 'Resource', 'Goal', 'WorkItem', 'Squad', 'Comment'],
    gaps: ['Current participant-set export/import, private backup readback, minimum-retention deadlines, legal-hold blocking, atomic authority/delete ordering, and journal-backed expiry resume are implemented for Project purge; all-Store ownership, non-requested age-policy automation, and remaining external/data-source boundaries remain open.']
  },
  {
    id: 'media-studio',
    title: 'Video production, shot assets, and MediaJob state',
    paths: [
      'userData/media-studio.json',
      'userData/media-files/<sha256(projectId)>',
      'userData/media-provider-outputs/<sha256> (legacy cleanup only)'
    ],
    sourceModules: [
      'src/main/media/media-store.ts',
      'src/main/media/media-runtime.ts',
      'src/main/media/media-reconciliation-scheduler.ts',
      'src/main/media/media-provider-runtime.ts',
      'src/main/media/media-ffmpeg.ts',
      'src/main/media/media-job-effect-target.ts'
    ],
    owner: { scope: 'project', key: 'projectId' },
    sensitivity: 'confidential',
    backup: { behavior: 'aggregate_export', status: 'partial' },
    retention: { rule: 'Production/MediaJob metadata persists to Project purge; unreferenced MediaAsset content can use append-only expiry policy subject to minimum retention and legal hold.', status: 'partial' },
    export: { mode: 'full', status: 'partial' },
    deletion: {
      softDelete: 'none',
      purge: 'owner_scope',
      externalDelete: 'external_untouched',
      status: 'partial'
    },
    implementationStatus: 'partial',
    gaps: ['Project slice and canonical source_ref bytes are portable; schema v10 adds Project quota, resumable Provider downloads, automatic reconciliation, per-asset retention revisions, pending retry and canonical purge tombstones. Runtime fault injection, ENOSPC/strong-kill evidence, Provider-owned remote deletion and full inventory enforcement remain open.']
  },
  {
    id: 'data-retention-authority',
    title: 'Application retention policy and legal-hold authority',
    paths: ['userData/private/data-retention-authority.json'],
    sourceModules: [
      'src/main/data-lifecycle/retention-authority-store.ts',
      'src/main/data-lifecycle/retention-authority.ts',
      'src/main/data-lifecycle/retention-authority-export.ts',
      'src/main/data-lifecycle/data-lifecycle-mutation-lock.ts',
      'src/main/ipc/data-retention-handlers.ts'
    ],
    owner: { scope: 'application', key: 'application policy plus Project/Session subject identity' },
    sensitivity: 'confidential',
    backup: { behavior: 'private_local', status: 'partial' },
    retention: { rule: 'Current policy, released holds, and append-only mutation audit persist until an explicit future application-data reset contract.', status: 'enforced' },
    export: { mode: 'redacted', status: 'partial' },
    deletion: { softDelete: 'none', purge: 'none', externalDelete: 'not_applicable', status: 'enforced' },
    implementationStatus: 'partial',
    gaps: ['Trusted CAS mutations, default and subject-specific Project/Session minimum retention, application/Project/Session legal holds, durable release history, atomic deletion/compaction ordering, redacted audit export, pending-deletion UI, and journal-backed expiry resume are implemented in current source. Remaining Store enforcement, application-data reset, non-requested age-policy automation, and runtime evidence remain open.']
  },
  {
    id: 'workflow-ledger',
    title: 'Workflow Ledger and Artifact content',
    paths: [
      'userData/task-snapshots.db',
      'userData/task-snapshots.json',
      'userData/artifact-blobs/sha256/<digest>',
      'userData/artifact-source-files/<project-hash>/<artifact-hash>.<ext>'
    ],
    sourceModules: [
      'src/main/task/task-snapshot.ts',
      'src/main/task/conversation-ledger-archive.ts',
      'src/main/task/conversation-ledger-store.ts',
      'src/main/task/artifact-lifecycle-content.ts',
      'src/main/task/workflow-ledger-migration-storage.ts',
      'src/main/task/workflow-ledger-migration.ts'
    ],
    owner: { scope: 'project', key: 'projectId' },
    sensitivity: 'confidential',
    backup: { behavior: 'aggregate_export', status: 'partial' },
    retention: { rule: 'Records persist indefinitely; artifact purge exists only for explicit artifact lifecycle operations.', status: 'partial' },
    export: { mode: 'redacted', status: 'partial' },
    deletion: {
      softDelete: 'record',
      purge: 'record',
      externalDelete: 'external_untouched',
      status: 'partial'
    },
    implementationStatus: 'partial',
    projectObjects: ['Run', 'Artifact', 'Evidence', 'Acceptance', 'Budget', 'Policy', 'Audit'],
    gaps: ['Standalone Session deletion now removes only its deletable recovery snapshot and private Conversation Ledger archive while preserving canonical Run, ModelAttempt, Artifact, Evidence, Acceptance, and budget history; runtime/strong-kill proof, unified retention, and all-Store proof remain open.']
  },
  {
    id: 'digital-workers',
    title: 'DigitalWorker, Assignment, and lease state',
    paths: ['userData/digital-workers.json'],
    sourceModules: [
      'src/main/digital-worker/persistence.ts',
      'src/main/digital-worker/domain-store.ts'
    ],
    owner: { scope: 'project', key: 'projectId' },
    sensitivity: 'personal',
    backup: { behavior: 'aggregate_export', status: 'partial' },
    retention: { rule: 'Retired workers and assignment history persist until a future project purge.', status: 'inventory_only' },
    export: { mode: 'full', status: 'partial' },
    deletion: {
      softDelete: 'record',
      purge: 'owner_scope',
      externalDelete: 'not_applicable',
      status: 'partial'
    },
    implementationStatus: 'partial',
    projectObjects: ['DigitalWorker', 'Assignment', 'Lease'],
    gaps: ['Project cascade purge is implemented; Worker retirement retention deadlines remain open.']
  },
  {
    id: 'assignment-owner-journal',
    title: 'Assignment ownership recovery journal',
    paths: ['userData/assignment-owner-coordinator.json'],
    sourceModules: ['src/main/assignment-owner-coordinator/journal.ts'],
    owner: { scope: 'project', key: 'projectId' },
    sensitivity: 'internal',
    backup: { behavior: 'none', status: 'inventory_only' },
    retention: { rule: 'Recovery entries persist until reconciliation overwrites the journal.', status: 'partial' },
    export: { mode: 'excluded', status: 'enforced' },
    deletion: { softDelete: 'none', purge: 'owner_scope', externalDelete: 'not_applicable', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['Project purge is implemented; bounded compaction remains open.']
  },
  {
    id: 'learning',
    title: 'Learning, Memory, and Skill review records',
    paths: [
      'userData/learning/projects/<project-hash>/learning.json',
      'projectRoot/.caogen/learning-state/projects/<project-hash>/learning.json'
    ],
    sourceModules: [
      'src/main/learning/learning-store.ts',
      'src/main/memoryStore.ts',
      'src/main/memory/memory-manager.ts'
    ],
    owner: { scope: 'project', key: 'projectId or normalized project root hash' },
    sensitivity: 'confidential',
    backup: { behavior: 'aggregate_export', status: 'partial' },
    retention: { rule: 'Approved, rejected, revoked, and audit records persist; expiry affects use, not physical retention.', status: 'partial' },
    export: { mode: 'full', status: 'partial' },
    deletion: {
      softDelete: 'record',
      purge: 'record',
      externalDelete: 'external_untouched',
      status: 'partial'
    },
    implementationStatus: 'partial',
    projectObjects: ['Memory'],
    gaps: ['Legacy buckets and canonical Learning do not share one retention clock or project purge transaction.']
  },
  {
    id: 'learning-materializations', title: 'Approved Skill materializations',
    paths: ['projectRoot/.caogen/skills/<skill>/SKILL.md'],
    sourceModules: ['src/main/learning/learning-materialization.ts', 'src/main/learning/learning-lifecycle.ts', 'src/main/skill/skill-optimizer.ts', 'src/main/data-lifecycle/project-external-file-manifest.ts'],
    owner: { scope: 'external_resource', key: 'Project Resource id and Skill relative path' }, sensitivity: 'confidential',
    backup: { behavior: 'external_owner', status: 'enforced' },
    retention: { rule: 'Files remain under the external Project Resource owner lifecycle.', status: 'enforced' },
    export: { mode: 'manifest_only', status: 'partial' },
    deletion: { softDelete: 'none', purge: 'none', externalDelete: 'external_untouched', status: 'enforced' },
    implementationStatus: 'partial',
    gaps: ['Resource-bound .caogen Skills have a digest/size manifest and remain externally owned; byte restoration, legacy roots, and non-Resource user-selected roots remain open.']
  },
  {
    id: 'project-aggregate-seals',
    title: 'Project aggregate integrity seals',
    paths: ['userData/project-aggregate-seals.json'],
    sourceModules: ['src/main/project-aggregate/project-aggregate-seal-store.ts'],
    owner: { scope: 'project', key: 'projectId' },
    sensitivity: 'internal',
    backup: { behavior: 'regenerable', status: 'partial' },
    retention: { rule: 'Latest seal per Project persists indefinitely.', status: 'inventory_only' },
    export: { mode: 'manifest_only', status: 'enforced' },
    deletion: { softDelete: 'none', purge: 'owner_scope', externalDelete: 'not_applicable', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['Seal removal is coordinated with Project purge; seal retention outside deletion remains undefined.']
  },
  {
    id: 'session-history',
    title: 'Session history',
    paths: ['userData/sessions.json'],
    sourceModules: ['src/main/history.ts', 'src/main/data-lifecycle/session-deletion-coordinator.ts'],
    owner: { scope: 'session', key: 'session.id with optional workspaceId' },
    sensitivity: 'confidential',
    backup: { behavior: 'aggregate_export', status: 'partial' },
    retention: { rule: 'Sessions persist until explicit deletion, subject to the application retention authority minimum deadline and active legal holds.', status: 'partial' },
    export: { mode: 'full', status: 'partial' },
    deletion: { softDelete: 'none', purge: 'record', externalDelete: 'external_untouched', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['Standalone explicit deletion is journaled, residual-scanned, retention/legal-hold gated, atomically ordered with authority mutations, and automatically resumed after a queued request becomes eligible; runtime/strong-kill evidence and full cross-Store transactional proof remain open.']
  },
  {
    id: 'active-sessions',
    title: 'Active session restart registry',
    paths: ['userData/active-sessions.json'],
    sourceModules: ['src/main/session-active-registry.ts', 'src/main/data-lifecycle/session-deletion-coordinator.ts'],
    owner: { scope: 'session', key: 'session.id' },
    sensitivity: 'confidential',
    backup: { behavior: 'aggregate_export', status: 'partial' },
    retention: { rule: 'Entries are removed when a session is no longer restorable.', status: 'partial' },
    export: { mode: 'full', status: 'partial' },
    deletion: { softDelete: 'none', purge: 'record', externalDelete: 'not_applicable', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['Standalone deletion removes stale matching records only after active runtime/worktree guards; stale-entry maximum age and runtime evidence are not defined.']
  },
  {
    id: 'session-creation-journal',
    title: 'Session creation recovery journal',
    paths: ['userData/session-creation-journal.json'],
    sourceModules: ['src/main/session-creation-journal.ts', 'src/main/data-lifecycle/session-deletion-coordinator.ts'],
    owner: { scope: 'session', key: 'requestId and sessionId' },
    sensitivity: 'internal',
    backup: { behavior: 'aggregate_export', status: 'partial' },
    retention: { rule: 'Completed recovery entries remain in the journal without a time-based cap.', status: 'inventory_only' },
    export: { mode: 'full', status: 'partial' },
    deletion: { softDelete: 'none', purge: 'record', externalDelete: 'not_applicable', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['Standalone deletion removes matching creation records in current source; no bounded compaction policy or runtime evidence exists.']
  },
  {
    id: 'session-deletion-journal',
    title: 'Standalone Session deletion recovery journal',
    paths: ['userData/private/session-deletion-journal.json'],
    sourceModules: [
      'src/main/data-lifecycle/session-deletion-journal.ts',
      'src/main/data-lifecycle/session-deletion-coordinator.ts'
    ],
    owner: { scope: 'session', key: 'operationId, sessionId, and sdkSessionId' },
    sensitivity: 'internal',
    backup: { behavior: 'none', status: 'inventory_only' },
    retention: { rule: 'Pending operations are never compacted. Completed receipts keep at most the newest 255 entries for 90 days; active application/Project/Session legal holds retain matching receipts beyond both limits.', status: 'enforced' },
    export: { mode: 'excluded', status: 'enforced' },
    deletion: { softDelete: 'none', purge: 'record', externalDelete: 'not_applicable', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['Restart continuation, frozen retention/legal-hold scope, legal-hold-aware completed-receipt compaction, and a shared authority/delete/compaction lock are implemented in current source; strong-kill evidence, authorization receipt binding, and compaction runtime proof remain open.']
  },
  {
    id: 'transcripts',
    title: 'Session transcripts and event receipts',
    paths: ['userData/transcripts/<sdk-session-id>.jsonl', 'userData/event-receipts/<sdk-session-id>.jsonl'],
    sourceModules: [
      'src/main/transcript.ts',
      'src/main/task/conversation-ledger-store.ts',
      'src/main/data-lifecycle/session-deletion-coordinator.ts'
    ],
    owner: { scope: 'session', key: 'sdkSessionId' },
    sensitivity: 'confidential',
    backup: { behavior: 'aggregate_export', status: 'partial' },
    retention: { rule: 'Append-only records persist without an age or size limit.', status: 'inventory_only' },
    export: { mode: 'full', status: 'partial' },
    deletion: { softDelete: 'none', purge: 'record', externalDelete: 'not_applicable', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['Standalone explicit deletion removes JSONL and private Conversation Ledger archive in current source; age/size compaction, legal hold, and runtime evidence remain open.']
  },
  {
    id: 'attachments',
    title: 'Session attachment copies',
    paths: ['userData/attachments/<session-id>/<attachment>'],
    sourceModules: ['src/main/attachmentOps.ts', 'src/main/ipc.ts', 'src/main/data-lifecycle/session-deletion-coordinator.ts'],
    owner: { scope: 'session', key: 'sessionId' },
    sensitivity: 'confidential',
    backup: { behavior: 'aggregate_export', status: 'partial' },
    retention: { rule: 'Copied attachments persist without a session cascade policy.', status: 'inventory_only' },
    export: { mode: 'full', status: 'partial' },
    deletion: { softDelete: 'none', purge: 'record', externalDelete: 'external_untouched', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['Standalone explicit deletion removes copied attachments in current source; external originals remain untouched and runtime evidence is open.']
  },
  {
    id: 'task-plans',
    title: 'Task plan contracts',
    paths: ['userData/task-plans/task-plan-contracts.json'],
    sourceModules: ['src/main/task/task-plan-contract-store.ts', 'src/main/data-lifecycle/session-deletion-coordinator.ts'],
    owner: { scope: 'session', key: 'sessionId with workspaceId' },
    sensitivity: 'confidential',
    backup: { behavior: 'aggregate_export', status: 'partial' },
    retention: { rule: 'Contracts persist indefinitely.', status: 'inventory_only' },
    export: { mode: 'full', status: 'partial' },
    deletion: { softDelete: 'none', purge: 'record', externalDelete: 'not_applicable', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['Standalone explicit deletion removes the private plan contract in current source; age-based retention, legal hold, and runtime evidence remain open.']
  },
  {
    id: 'supervisor-state',
    title: 'Supervisor run control state',
    paths: ['userData/supervisor-state.json'],
    sourceModules: ['src/main/task/supervisor-state.ts'],
    owner: { scope: 'project', key: 'projectId and runId' },
    sensitivity: 'internal',
    backup: { behavior: 'none', status: 'inventory_only' },
    retention: { rule: 'Run control state persists indefinitely.', status: 'inventory_only' },
    export: { mode: 'excluded', status: 'enforced' },
    deletion: { softDelete: 'none', purge: 'owner_scope', externalDelete: 'not_applicable', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['Project cascade purge is implemented; completed-run compaction remains open.']
  },
  {
    id: 'task-audit',
    title: 'Permission and task audit log',
    paths: ['userData/task-audit/<session-id>.jsonl'],
    sourceModules: ['src/main/permission/audit-log.ts', 'src/main/data-lifecycle/session-deletion-coordinator.ts'],
    owner: { scope: 'session', key: 'sessionId' },
    sensitivity: 'confidential',
    backup: { behavior: 'aggregate_export', status: 'partial' },
    retention: { rule: 'Append-only audit records persist indefinitely.', status: 'inventory_only' },
    export: { mode: 'full', status: 'partial' },
    deletion: { softDelete: 'none', purge: 'record', externalDelete: 'not_applicable', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['Standalone explicit deletion removes the private Session audit file in current source; retention, compaction, legal hold, and runtime evidence remain open.']
  },
  {
    id: 'project-test-evidence', title: 'Project test execution evidence',
    paths: ['userData/project-test-evidence/<workspace-hash>/<evidence-id>.json'], sourceModules: ['src/main/projectTestRunner.ts', 'src/main/data-lifecycle/project-test-evidence.ts'],
    owner: { scope: 'mixed', key: 'projectId and sessionId' }, sensitivity: 'confidential', backup: { behavior: 'aggregate_export', status: 'partial' }, export: { mode: 'full', status: 'partial' },
    retention: { rule: 'Evidence persists until its owning Project is purged; no age-based deadline is enforced.', status: 'partial' },
    deletion: { softDelete: 'none', purge: 'project_cascade', externalDelete: 'not_applicable', status: 'partial' }, implementationStatus: 'partial', gaps: ['Schema v2 evidence is Project portable and purgeable; legacy v1 evidence has no durable Project/Session owner and unified retention remains open.']
  },
  { id: 'effect-artifacts', title: 'Effect reconciliation artifacts', paths: ['userData/effect-artifacts/<effect-kind>/<digest>'], sourceModules: ['src/main/git/git-index-artifact.ts', 'src/main/data-lifecycle/project-effect-artifact-portability.ts', 'src/main/code-forge/patch-artifact.ts'], owner: { scope: 'session', key: 'Project-owned Run/Session and effectId' }, sensitivity: 'confidential', backup: { behavior: 'aggregate_export', status: 'partial' }, export: { mode: 'full', status: 'partial' }, retention: { rule: 'Project-owned Git index artifacts persist while referenced and are removed with the last Project owner; no age-based expiry exists.', status: 'partial' }, deletion: { softDelete: 'none', purge: 'project_cascade', externalDelete: 'not_applicable', status: 'partial' }, implementationStatus: 'partial', gaps: ['Git index artifact bytes are portable, digest-verified, shared-reference-safe, and deletion-proofed; legacy orphan discovery, non-Git future Effect artifact kinds, and unified age/legal-hold retention remain open.']
  },
  {
    id: 'providers',
    title: 'Provider profiles and encrypted credential references',
    paths: ['userData/providers.json'],
    sourceModules: [
      'src/main/providers.ts',
      'src/main/providerCredentialBroker.ts',
      'src/main/provider/providerProfileStore.ts'
    ],
    owner: { scope: 'provider', key: 'providerId and keyId' },
    sensitivity: 'credential',
    backup: { behavior: 'private_local', status: 'partial' },
    retention: { rule: 'Provider and encrypted credentials persist until explicit provider/key deletion.', status: 'partial' },
    export: { mode: 'redacted', status: 'enforced' },
    deletion: { softDelete: 'none', purge: 'record', externalDelete: 'external_untouched', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['Credential expiry and external provider-side revocation cannot be enforced locally.']
  },
  {
    id: 'notification-connectors',
    title: 'Global notification connectors and encrypted webhook credentials',
    paths: ['userData/notification-connectors.json'],
    sourceModules: [
      'src/main/notification/notification-connector-store.ts',
      'src/main/notification/notification-effect.ts'
    ],
    owner: { scope: 'user', key: 'local application profile and connector id' },
    sensitivity: 'credential',
    backup: { behavior: 'private_local', status: 'inventory_only' },
    retention: { rule: 'Connectors persist until the user explicitly deletes them.', status: 'enforced' },
    export: { mode: 'excluded', status: 'enforced' },
    deletion: { softDelete: 'none', purge: 'record', externalDelete: 'external_untouched', status: 'enforced' },
    implementationStatus: 'partial',
    gaps: ['Connectors are global application configuration and are intentionally excluded from Project export and Project deletion; full application-data export/reset remains open.']
  },
  {
    id: 'provider-authorizations',
    title: 'Provider OAuth authorization accounts and encrypted tokens',
    paths: ['userData/provider-authorizations.json'],
    sourceModules: ['src/main/provider/providerAuthorizationStore.ts'],
    owner: { scope: 'provider', key: 'providerId and authorization accountId' },
    sensitivity: 'credential',
    backup: { behavior: 'private_local', status: 'partial' },
    retention: { rule: 'Authorization records persist until explicit revocation or Provider deletion.', status: 'partial' },
    export: { mode: 'excluded', status: 'enforced' },
    deletion: { softDelete: 'none', purge: 'record', externalDelete: 'external_untouched', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['Remote provider-side revocation and expiry depend on each authorization service; full application-data reset remains open.']
  },
  {
    id: 'provider-health-and-model-stats',
    title: 'Provider health and model routing statistics',
    paths: ['userData/provider-health.json', 'userData/model-stats.json'],
    sourceModules: ['src/main/providerHealth.ts', 'src/main/modelStats.ts'],
    owner: { scope: 'provider', key: 'providerId or model id' },
    sensitivity: 'internal',
    backup: { behavior: 'regenerable', status: 'enforced' },
    retention: { rule: 'Rolling failure detail is bounded, aggregate counters persist indefinitely.', status: 'partial' },
    export: { mode: 'regenerable', status: 'enforced' },
    deletion: { softDelete: 'none', purge: 'cache_purge', externalDelete: 'not_applicable', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['No user-facing reset or age-based aggregate expiry is implemented.']
  },
  {
    id: 'provider-billing-statements', title: 'Provider billing reconciliation statements',
    paths: ['userData/provider-billing-statements.json'], sourceModules: ['src/main/provider/providerBillingStore.ts'], owner: { scope: 'provider', key: 'providerId and statementId' }, sensitivity: 'confidential',
    backup: { behavior: 'none', status: 'inventory_only' }, export: { mode: 'excluded', status: 'inventory_only' }, retention: { rule: 'At most 2,000 statements persist until individually removed; no age-based deadline is enforced.', status: 'partial' },
    deletion: { softDelete: 'none', purge: 'record', externalDelete: 'not_applicable', status: 'partial' }, implementationStatus: 'partial', gaps: ['Per-statement removal exists; Provider deletion cascade, application-data export/reset, and age-based retention remain open.']
  },
  {
    id: 'provider-gateway', title: 'Local Provider gateway configuration and usage ledger',
    paths: ['userData/private/provider-gateway.json', 'userData/private/provider-gateway-usage.json'], sourceModules: ['src/main/provider/providerGatewayStore.ts'],
    owner: { scope: 'application', key: 'local application profile and gateway request id' }, sensitivity: 'credential', backup: { behavior: 'private_local', status: 'inventory_only' }, export: { mode: 'excluded', status: 'enforced' },
    retention: { rule: 'Configuration persists; usage is bounded to the latest 10,000 records.', status: 'partial' },
    deletion: { softDelete: 'none', purge: 'none', externalDelete: 'not_applicable', status: 'inventory_only' }, implementationStatus: 'partial', gaps: ['Gateway disablement does not erase its listener credential or usage ledger; application-data reset and explicit purge controls remain open.']
  },
  {
    id: 'provider-profile-backups',
    title: 'Credential-scrubbed Provider profile rollback backups',
    paths: ['userData/provider-profile-backups/<backup-id>.json'],
    sourceModules: ['src/main/provider/providerProfileService.ts', 'src/main/provider/providerProfileStore.ts', 'src/main/provider/providerProfileBackupWriter.ts'],
    owner: { scope: 'user', key: 'backupId' }, sensitivity: 'confidential', backup: { behavior: 'private_local', status: 'enforced' },
    retention: { rule: 'Backups are retained for at most 50 valid versions and 90 days; unresolved operation references are protected until reconciliation.', status: 'enforced' },
    export: { mode: 'excluded', status: 'enforced' }, deletion: { softDelete: 'none', purge: 'none', externalDelete: 'external_untouched', status: 'inventory_only' },
    implementationStatus: 'partial',
    gaps: ['New backups retain Provider configuration and nonPersistentCredentialCount/excludedCredentialCount metadata, but exclude encryptedToken, API keys, active key bindings, session-only credentials, and other recoverable credential material.', 'On read or startup reconciliation, a valid legacy backup is atomically rewritten in place with credentials removed, an updated excludedCredentialCount, a new digest, and private file mode; invalid backups remain unavailable for rollback.', 'Retention is local to this backup Store; application-wide legal hold and cross-Store retention remain open.']
  },
  {
    id: 'provider-profile-operations',
    title: 'Provider profile import and rollback operation journal',
    paths: ['userData/provider-profile-operations/journal.json'],
    sourceModules: [
      'src/main/provider/providerProfileOperationJournal.ts',
      'src/main/provider/providerProfileService.ts'
    ],
    owner: { scope: 'user', key: 'operationId' },
    sensitivity: 'confidential',
    backup: { behavior: 'none', status: 'enforced' },
    retention: { rule: 'The journal retains at most 256 entries: one unresolved prepared operation and up to 255 most-recent terminal entries; compaction occurs when a new operation is prepared, with no age-based expiry.', status: 'enforced' },
    export: { mode: 'excluded', status: 'enforced' },
    deletion: { softDelete: 'none', purge: 'none', externalDelete: 'not_applicable', status: 'inventory_only' },
    implementationStatus: 'partial',
    gaps: [
      'The journal stores operation phase, Store snapshot digests, backup IDs plus frozen backup digests, and timestamps rather than Provider values or credentials.',
      'No user-facing purge control exists; an unresolved operation is retained until startup/service reconciliation classifies it as committed or aborted, while a third Store digest or backup substitution moves it to waiting_reconciliation and requires manual reconciliation.'
    ]
  },
  {
    id: 'provider-profile-sync', title: 'Credential-free Provider profile synchronization',
    paths: ['userData/provider-profile-sync/state.json', 'userData/provider-profile-webdav/config.json', 'userData/provider-profile-s3/config.json', '<selected-sync-folder-or-WebDAV-or-S3>/caogen-provider-sync-and-history'],
    sourceModules: ['src/main/provider/providerProfileSync.ts', 'src/main/provider/providerProfileWebDavSync.ts', 'src/main/provider/providerProfileS3Sync.ts'], owner: { scope: 'user', key: 'deviceId and revisionId' },
    sensitivity: 'credential', backup: { behavior: 'external_owner', status: 'enforced' }, export: { mode: 'redacted', status: 'enforced' },
    retention: { rule: 'The current envelope and every published history revision persist until the user or sync service removes them.', status: 'inventory_only' },
    implementationStatus: 'partial', deletion: { softDelete: 'none', purge: 'none', externalDelete: 'external_untouched', status: 'inventory_only' },
    gaps: ['WebDAV and S3 credentials are OS-encrypted locally; remote profiles reject credentials. Disconnect leaves history untouched, and remote/local retention controls remain open.']
  },
  {
    id: 'provider-native-import-backups',
    title: 'Credential-scrubbed native Provider import rollback backups',
    paths: ['userData/provider-native-import-backups/<backup-id>.json'],
    sourceModules: ['src/main/provider/providerNativeConfigImport.ts'],
    owner: { scope: 'user', key: 'backupId' },
    sensitivity: 'confidential',
    backup: { behavior: 'private_local', status: 'enforced' },
    retention: { rule: 'Unrolled backups persist until removed outside the service; no count or age limit is enforced.', status: 'inventory_only' },
    export: { mode: 'excluded', status: 'enforced' },
    deletion: { softDelete: 'none', purge: 'none', externalDelete: 'external_untouched', status: 'inventory_only' },
    implementationStatus: 'partial',
    gaps: [
      'Backups include only renderer-safe Provider views and imported key identifiers; secret values and encrypted credential material are excluded.',
      'No maximum backup count, expiry, or user purge control exists.'
    ]
  },
  {
    id: 'workflow-delivery-identity',
    title: 'System-encrypted CaoGen Project delivery signing identity',
    paths: [
      'userData/private/workflow-delivery-identity.json',
      'userData/private/workflow-delivery-identity-trust.json'
    ],
    sourceModules: [
      'src/main/task/workflow-delivery-identity.ts',
      'src/main/task/workflow-delivery-trust-store.ts'
    ],
    owner: { scope: 'user', key: 'local CaoGen application profile' },
    sensitivity: 'credential',
    backup: { behavior: 'private_local', status: 'enforced' },
    retention: { rule: 'The local Ed25519 identity, bounded retired-key lineage, trusted/revoked identity records, and organization trust policy persist until application data is reset; key rotation retains a revoked continuity record.', status: 'enforced' },
    export: { mode: 'redacted', status: 'enforced' },
    deletion: { softDelete: 'none', purge: 'owner_scope', externalDelete: 'not_applicable', status: 'partial' },
    implementationStatus: 'partial',
    gaps: [
      'The PKCS#8 private key is persisted only inside an Electron safeStorage envelope; optional portable backups are separately encrypted with scrypt and AES-256-GCM, while manifests and trust bundles contain only public material.',
      'Trusted external identities and the three-mode organization trust policy use a digest-protected CAS Store with revocation tombstones; signed trust export/import, encrypted identity recovery, rotation, retired-key continuity, and policy enforcement are implemented_unverified.'
    ]
  },
  {
    id: 'provider-store-mutation-lock',
    title: 'Cross-process Provider Store mutation lock and bounded recovery tombstones',
    paths: [
      'userData/.provider-store-mutation.lock/owner.json',
      'userData/.provider-store-mutation.lock.candidate-<owner-id>/owner.json',
      'userData/.provider-store-mutation.lock.released-<owner-id>/owner.json',
      'userData/.provider-store-mutation.lock.recovered-<owner-id>/owner.json'
    ],
    sourceModules: [
      'src/main/provider/providerStoreMutationLock.ts',
      'src/main/provider/providerStoreRepository.ts'
    ],
    owner: { scope: 'application', key: 'ownerId and local process pid' },
    sensitivity: 'internal',
    backup: { behavior: 'regenerable', status: 'enforced' },
    retention: { rule: 'The active lock is removed after release. Released tombstones are immediately eligible for cleanup; dead candidate and recovered artifacts are retained for a five-minute grace period. Acquisition fails closed when 64 residual artifacts remain.', status: 'enforced' },
    export: { mode: 'excluded', status: 'enforced' },
    deletion: { softDelete: 'none', purge: 'cache_purge', externalDelete: 'not_applicable', status: 'enforced' },
    implementationStatus: 'partial',
    gaps: [
      'POSIX mode and symlink defenses are covered locally; a Windows ACL-specific verification gate is still absent.',
      'PID liveness is conservative: a reused live PID fails closed and requires stale-lock investigation rather than risking concurrent writes.'
    ]
  },
  {
    id: 'settings',
    title: 'Application settings and routing policy',
    paths: ['userData/settings.json'],
    sourceModules: ['src/main/settings.ts'],
    owner: { scope: 'user', key: 'local application profile' },
    sensitivity: 'personal',
    backup: { behavior: 'none', status: 'inventory_only' },
    retention: { rule: 'Latest settings overwrite the prior snapshot.', status: 'enforced' },
    export: { mode: 'redacted', status: 'inventory_only' },
    deletion: { softDelete: 'none', purge: 'owner_scope', externalDelete: 'not_applicable', status: 'inventory_only' },
    implementationStatus: 'partial',
    gaps: ['No complete settings export/reset contract exists.']
  },
  {
    id: 'routines',
    title: 'Routine definitions and bounded run history',
    paths: ['userData/routines/routines.json', 'userData/routines/routine-runs.json'],
    sourceModules: [
      'src/main/routineStore.ts',
      'src/main/routines/routine-runner.ts',
      'src/main/routines/routine-project-store.ts',
      'src/main/data-lifecycle/project-import-coordinator.ts',
      'src/main/data-lifecycle/project-deletion-coordinator.ts'
    ],
    owner: { scope: 'mixed', key: 'routineId and optional projectId' },
    sensitivity: 'confidential',
    backup: { behavior: 'none', status: 'inventory_only' },
    retention: { rule: 'Definitions persist; run history is bounded by the store maximum.', status: 'partial' },
    export: { mode: 'full', status: 'enforced' },
    deletion: { softDelete: 'none', purge: 'project_cascade', externalDelete: 'external_untouched', status: 'enforced' },
    implementationStatus: 'partial',
    gaps: ['Routine deletion does not delete outputs in external systems; Project deletion records those boundaries separately.']
  },
  {
    id: 'project-refactor-journals', title: 'Project refactor recovery journals',
    paths: ['userData/project-refactor-journal/<operation-id>.json'], sourceModules: ['src/main/projectRefactorJournal.ts'],
    owner: { scope: 'session', key: 'sessionId and operationId' }, sensitivity: 'confidential',
    backup: { behavior: 'none', status: 'inventory_only' },
    retention: { rule: 'Bounded journals persist through recovery; terminal records may be compacted when capacity is reached.', status: 'partial' },
    export: { mode: 'excluded', status: 'enforced' },
    deletion: { softDelete: 'none', purge: 'record', externalDelete: 'external_untouched', status: 'partial' },
    implementationStatus: 'partial', gaps: ['Recovery and capacity limits are enforced; unified Project/Session deletion and legal-hold coverage remain open.']
  },
  {
    id: 'managed-worktrees',
    title: 'Managed worktree registry, patches, and merge receipts',
    paths: ['userData/worktrees/index.json', 'userData/patches/<session-id>.patch', 'userData/patches/<session-id>-<timestamp>.patch', 'userData/worktree-merges.json'],
    sourceModules: [
      'src/main/managed-worktree-lifecycle.ts',
      'src/main/git/managed-worktree-effect.ts',
      'src/main/worktrees.ts',
      'src/main/worktreeMerge.ts',
      'src/main/data-lifecycle/session-deletion-coordinator.ts'
    ],
    owner: { scope: 'session', key: 'sessionId' },
    sensitivity: 'confidential',
    backup: { behavior: 'none', status: 'inventory_only' },
    retention: { rule: 'Registry tracks lifecycle, while patches and receipts persist indefinitely.', status: 'partial' },
    export: { mode: 'manifest_only', status: 'partial' },
    deletion: { softDelete: 'none', purge: 'record', externalDelete: 'external_untouched', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['Project and standalone deletion remove only removed registry projections plus exact/timestamped patches and merge receipts; active worktrees remain blocked until their Effect completes, and runtime proof remains open.']
  },
  {
    id: 'migration-backups',
    title: 'Private asset migration rollback backups',
    paths: ['userData/private/migration-backups/<backup-id>', 'userHome/.caogen-private/migration-backups/<backup-id>'],
    sourceModules: ['src/main/migration-apply.ts', 'src/main/ipc.ts'],
    owner: { scope: 'user', key: 'backupId' },
    sensitivity: 'credential',
    backup: { behavior: 'private_local', status: 'enforced' },
    retention: { rule: 'Backups persist indefinitely for rollback.', status: 'inventory_only' },
    export: { mode: 'excluded', status: 'enforced' },
    deletion: { softDelete: 'none', purge: 'record', externalDelete: 'external_untouched', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['No expiry or maximum backup count is enforced.']
  },
  {
    id: 'annotations',
    title: 'Browser and document preview annotations',
    paths: ['userData/browser-annotations/<session-id>/<id>.json', 'userData/preview-annotations/<session-id>/<id>.json'],
    sourceModules: [
      'src/main/browserAnnotations.ts',
      'src/main/browserView.ts',
      'src/main/previewAnnotations.ts',
      'src/main/data-lifecycle/session-deletion-coordinator.ts'
    ],
    owner: { scope: 'session', key: 'sessionId or annotation id' },
    sensitivity: 'confidential',
    backup: { behavior: 'none', status: 'inventory_only' },
    retention: { rule: 'Annotations persist until individually deleted.', status: 'partial' },
    export: { mode: 'full', status: 'partial' },
    deletion: { softDelete: 'none', purge: 'record', externalDelete: 'external_untouched', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['Project and standalone Session deletion now remove both annotation directories in current source; referenced external screenshots, runtime evidence, and unified retention remain open.']
  },
  {
    id: 'plugins',
    title: 'Plugin registry state and managed installations',
    paths: ['userData/plugin-registry-state.json', 'userHome/.caogen/plugins/<managed-plugin>'],
    sourceModules: [
      'src/main/pluginRegistry.ts',
      'src/main/pluginInstall.ts',
      'src/main/plugin/plugin-directory-effect.ts',
      'src/main/ipc.ts'
    ],
    owner: { scope: 'external_resource', key: 'plugin registry item key and installation path' },
    sensitivity: 'personal',
    backup: { behavior: 'external_owner', status: 'inventory_only' },
    retention: { rule: 'Registry preference persists; managed plugin files remain until explicit uninstall.', status: 'partial' },
    export: { mode: 'manifest_only', status: 'partial' },
    deletion: { softDelete: 'none', purge: 'record', externalDelete: 'external_untouched', status: 'enforced' },
    implementationStatus: 'partial',
    gaps: ['Project deletion never implies plugin uninstall; user-home ownership remains separate.']
  },
  {
    id: 'office-artifact-outputs', title: 'User-owned Artifact outputs and delivery exports',
    paths: ['projectRoot/<user-selected-relative-path>.{docx,xlsx,pptx,pdf}', '<user-selected-artifact-or-delivery-export-path>'],
    sourceModules: ['src/main/agent/tools/office-artifact.ts', 'src/main/task/artifact-lifecycle-producer.ts', 'src/main/task/workflow-artifact-delivery.ts', 'src/main/task/workflow-artifact-export.ts', 'src/main/data-lifecycle/project-portable-runtime.ts', 'src/main/data-lifecycle/project-external-file-manifest.ts'],
    owner: { scope: 'external_resource', key: 'canonical Artifact id and frozen Project-relative output path' }, sensitivity: 'confidential',
    backup: { behavior: 'aggregate_export', status: 'partial' },
    retention: { rule: 'Generated files remain under the user-owned Project workspace lifecycle.', status: 'enforced' },
    export: { mode: 'full', status: 'partial' },
    deletion: { softDelete: 'none', purge: 'none', externalDelete: 'external_untouched', status: 'enforced' },
    implementationStatus: 'partial',
    gaps: ['Canonical Office Artifact bytes and manifests are portable while originals remain external; legacy or unregistered output discovery and unified retention remain open.']
  },
  {
    id: 'project-connector-cache',
    title: 'Project Connector bounded content cache',
    paths: ['userData/project-connector-cache/<sha256(projectId)>/<sha256(resourceId)>/{current.json,<content-digest>.txt}'],
    sourceModules: ['src/main/project-workspace/project-connector-cache.ts'],
    owner: { scope: 'project', key: 'projectId and Resource id' },
    sensitivity: 'confidential',
    backup: { behavior: 'regenerable', status: 'enforced' },
    retention: { rule: 'Purged on authorization revocation, Resource removal, explicit cache purge, or permanent Project deletion.', status: 'enforced' },
    export: { mode: 'excluded', status: 'enforced' },
    deletion: { softDelete: 'none', purge: 'cache_purge', externalDelete: 'external_untouched', status: 'enforced' },
    implementationStatus: 'enforced',
    gaps: ['No global cache quota or LRU eviction policy exists.']
  },
  {
    id: 'indexes-and-cache',
    title: 'Project indexes and regenerable visual caches',
    paths: ['projectRoot/.caogen/index.db', 'userData/vendor-icons/<provider>.png'],
    sourceModules: ['src/main/indexer/index.ts', 'src/main/vendorIcons.ts'],
    owner: { scope: 'cache', key: 'project root or provider icon URL' },
    sensitivity: 'internal',
    backup: { behavior: 'regenerable', status: 'enforced' },
    retention: { rule: 'Caches persist until manual application-data or project cache cleanup.', status: 'inventory_only' },
    export: { mode: 'regenerable', status: 'enforced' },
    deletion: { softDelete: 'none', purge: 'cache_purge', externalDelete: 'external_untouched', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['No unified cache quota, LRU, or Project deletion hook exists.']
  },
  {
    id: 'legacy-projects',
    title: 'Legacy directory Project favorites',
    paths: ['userData/projects.json'],
    sourceModules: ['src/main/projects.ts'],
    owner: { scope: 'user', key: 'legacy project id' },
    sensitivity: 'personal',
    backup: { behavior: 'none', status: 'inventory_only' },
    retention: { rule: 'Bounded to the most recent Project records and explicit deletion.', status: 'enforced' },
    export: { mode: 'manifest_only', status: 'inventory_only' },
    deletion: { softDelete: 'record', purge: 'record', externalDelete: 'external_untouched', status: 'enforced' },
    implementationStatus: 'partial',
    gaps: ['Legacy Project deletion is not canonical Project aggregate deletion.']
  },
  {
    id: 'workspace-execution',
    title: 'Directory-free Project execution roots',
    paths: ['userData/workspace-execution/<workspace-hash>'],
    sourceModules: ['src/main/project-workspace/workspace-session-cwd.ts', 'src/main/ipc/unassigned-session.ts'],
    owner: { scope: 'project', key: 'workspaceId hash' },
    sensitivity: 'confidential',
    backup: { behavior: 'aggregate_export', status: 'partial' },
    retention: { rule: 'Execution files persist without a Project purge hook.', status: 'inventory_only' },
    export: { mode: 'full', status: 'partial' },
    deletion: { softDelete: 'none', purge: 'owner_scope', externalDelete: 'external_untouched', status: 'partial' },
    implementationStatus: 'partial',
    gaps: ['Application-owned execution root purge is implemented; user-selected Resource roots remain external and untouched.']
  }
]

export interface PersistenceScanExclusion {
  sourceModule: string
  boundary: 'external_user_action' | 'runtime_only' | 'delegates_to_registered_store'
  reason: string
}

export const PERSISTENCE_SCAN_EXCLUSIONS: PersistenceScanExclusion[] = [
  {
    sourceModule: 'src/main/agent/context-loader.ts',
    boundary: 'external_user_action',
    reason: 'Initializes files in a user-selected project root; application-data deletion must leave them untouched.'
  },
  {
    sourceModule: 'src/main/fileOps.ts',
    boundary: 'external_user_action',
    reason: 'Writes user-selected workspace files; CaoGen application data deletion must leave them untouched.'
  },
  {
    sourceModule: 'src/main/previewOps.ts',
    boundary: 'runtime_only',
    reason: 'Creates bounded temporary preview material outside the durable Store contract.'
  },
  {
    sourceModule: 'src/main/previewVisual.ts',
    boundary: 'runtime_only',
    reason: 'Creates regenerable temporary visual preview files.'
  },
  {
    sourceModule: 'src/main/imageOcr.ts',
    boundary: 'runtime_only',
    reason: 'Creates temporary OCR input files and removes them after use.'
  },
  {
    sourceModule: 'src/main/gitDiff.ts',
    boundary: 'external_user_action',
    reason: 'Reads or mutates a user-owned Git working tree through an explicit action.'
  },
  {
    sourceModule: 'src/main/git/git-helper.ts',
    boundary: 'external_user_action',
    reason: 'Writes guarded Git metadata and temporary commit material inside a user-owned repository.'
  },
  {
    sourceModule: 'src/main/git/git-index-state.ts',
    boundary: 'external_user_action',
    reason: 'Writes the user-owned Git index through explicit Effect operations with reconciliation.'
  },
  {
    sourceModule: 'src/main/gitOps.ts',
    boundary: 'external_user_action',
    reason: 'Mutates user-owned Git repositories only through explicit Git actions.'
  },
  {
    sourceModule: 'src/main/worktreeMerge.ts',
    boundary: 'delegates_to_registered_store',
    reason: 'Merge receipts are registered under managed-worktrees; repository mutation is external.'
  },
  {
    sourceModule: 'src/main/migration-scan-store.ts',
    boundary: 'runtime_only',
    reason: 'Holds bounded migration scan state in memory only.'
  },
  {
    sourceModule: 'src/main/migration-safety.ts',
    boundary: 'delegates_to_registered_store',
    reason: 'Provides atomic primitives for registered migration backups and explicit external target writes.'
  },
  {
    sourceModule: 'src/main/providerCredentialBroker.ts',
    boundary: 'delegates_to_registered_store',
    reason: 'Encrypted references are persisted only through the registered providers Store.'
  }
]

export const NFR_PRIV_001_FOUNDATION_STATUS = {
  requirementId: 'NFR-PRIV-001',
  status: 'partial' as const,
  proven: [
    'Every currently detected durable main-process Store is registered or explicitly classified outside application persistence.',
    'Project aggregate object coverage is machine checked.',
    'Credential exports are redacted or excluded.',
    'External resource deletion boundaries are explicit.',
    'The current Project/Session deletion participant set emits a private, restart-verifiable deletion proof bound to backup readback, authorized purge history, and zero residuals.',
    'A private CAS retention authority now provides one Project/Session minimum-retention clock, subject overrides, application/Project/Session legal holds, durable release history, fail-closed deletion-stage checks, atomic mutation ordering, redacted export, and queued expiry resume.'
  ],
  open: [
    'One transactional owner-scoped export across every registered Store.',
    'Extend the retention authority to every remaining owner-scoped Store and define non-requested age-policy automation without broadening destructive defaults.',
    'Complete participant coverage and deletion proof beyond the current journaled Project/Session cascade.',
    'External connector deletion contracts and actor authorization recomputation.',
    'Full Project import and user-facing proof history/export controls.'
  ]
}
