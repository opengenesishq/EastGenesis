import type { WorkflowLedgerVerification } from '../../shared/workflow-types'
import type { TaskEvidenceVerification } from './task-evidence-store'
import type { WorkflowLedgerReadMode, WorkflowRecoveryVerification } from './workflow-ledger-recovery'
import type { WorkflowLedgerAuthorizedPurgeVerification } from './workflow-ledger-authorized-purge'
import type { ConversationLedgerArchiveVerification } from './conversation-ledger-store'

export const WORKFLOW_LEDGER_READINESS_FORMAT = 'caogen.workflow-ledger.canonical-readiness.v1' as const
export const WORKFLOW_LEDGER_MIGRATION_JOURNAL_FORMAT = 'caogen.workflow-ledger.canonical-migration-journal.v1' as const
export const WORKFLOW_LEDGER_MIGRATION_KIND = 'workflow-ledger-canonical-readiness' as const
export const WORKFLOW_LEDGER_MIGRATION_VERSION = 1 as const

export type WorkflowLedgerMigrationSourceKind = 'sqlite' | 'legacy_json' | 'empty'
export type WorkflowLedgerMigrationPath =
  | 'existing_v7'
  | 'existing_v8'
  | 'existing_current'
  | 'legacy_upgrade'
  | 'canonical_upgrade'
/** Candidate acceptance policy persisted so crash recovery uses the original source semantics. */
export type WorkflowLedgerMigrationMode = 'shadow' | 'canonical'
export type WorkflowLedgerMigrationState =
  | 'prepared'
  | 'backup_verified'
  | 'migrated_verified'
  | 'committed'
  | 'rollback_pending'
  | 'rolled_back'

export type WorkflowLedgerMigrationCheckpoint =
  | 'after_prepared_journal'
  | 'after_backup_write'
  | 'after_backup_verified'
  | 'after_migrated_verified'
  | 'before_source_rename'
  | 'after_source_rename'
  | 'before_journal_commit'
  | 'after_journal_commit'
  | 'before_rollback_source_change'
  | 'after_rollback_source_change'
  | 'before_rollback_journal_commit'
  | 'after_rollback_journal_commit'

export interface WorkflowLedgerCanonicalReadinessDiagnostic {
  code: string
  category: 'corruption' | 'additive_projection' | 'canonical_compatibility'
  scope?: 'legacy' | 'canonical' | 'parity' | 'shared'
  message: string
  entityId?: string
  table?: string
}

export interface WorkflowLedgerCanonicalReadinessReport {
  schemaVersion: 1
  format: typeof WORKFLOW_LEDGER_READINESS_FORMAT
  mode: 'shadow'
  status: 'ready' | 'repairable' | 'blocked'
  safeForShadowUse: boolean
  readyForCanonicalRead: boolean
  repairableAdditiveProjection: boolean
  sourceKind: WorkflowLedgerMigrationSourceKind
  sourcePath: string
  sourceSha256: string
  sourceSizeBytes: number
  storeId?: string
  storeVersion: number | null
  assessedAt: number
  counts: {
    taskSnapshots: number
    taskRuns: number
    workflowRuns: number
    workflowRecoverySessions: number
    dagFinalizations: number
    snapshotsWithoutRun: number
    activeRunsWithoutSnapshot: number
    terminalRunsWithoutSnapshot: number
    matchingRuns: number
    conversationStreams: number
    conversationGenerations: number
    conversationEvents: number
    currentConversationEvents: number
  }
  digests: {
    taskRuns: string
    workflowRuns: string
    taskSnapshots: string
    conversationLedger: string
  }
  verification?: {
    workflowLedger?: WorkflowLedgerVerification
    taskEvidence?: TaskEvidenceVerification
    taskDagFinalizations?: {
      valid: true
      count: number
    }
    workflowRecovery?: WorkflowRecoveryVerification
    conversationLedger?: ConversationLedgerArchiveVerification
  }
  authorizedPurges?: WorkflowLedgerAuthorizedPurgeVerification
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
  reportDigest: string
}

export interface WorkflowLedgerMigrationSource {
  sourceKind: WorkflowLedgerMigrationSourceKind
  sourcePath: string
  targetPath: string
  sourceBytes: Uint8Array
  targetExisted: boolean
}

export interface WorkflowLedgerMigrationFileDigest {
  path: string
  sha256: string
  sizeBytes: number
}

export interface WorkflowLedgerCanonicalMigrationJournal {
  schemaVersion: 1
  format: typeof WORKFLOW_LEDGER_MIGRATION_JOURNAL_FORMAT
  migrationKind: typeof WORKFLOW_LEDGER_MIGRATION_KIND
  migrationVersion: typeof WORKFLOW_LEDGER_MIGRATION_VERSION
  migrationId: string
  migrationPath: WorkflowLedgerMigrationPath
  mode: WorkflowLedgerMigrationMode
  state: WorkflowLedgerMigrationState
  fromVersion: number
  toVersion: number
  sourceKind: WorkflowLedgerMigrationSourceKind
  sourcePath: string
  targetPath: string
  targetExisted: boolean
  source: WorkflowLedgerMigrationFileDigest
  backup: WorkflowLedgerMigrationFileDigest
  candidate?: WorkflowLedgerMigrationFileDigest
  migrated?: WorkflowLedgerMigrationFileDigest
  readiness?: WorkflowLedgerCanonicalReadinessReport
  createdAt: number
  updatedAt: number
  committedAt?: number
  rollbackPreparedAt?: number
  rolledBackAt?: number
  transitions: Array<{ state: WorkflowLedgerMigrationState; at: number }>
  /** Exact system-owned Acceptance invalidation permitted during a canonical source command. */
  acceptanceChangeImpact?: WorkflowLedgerMigrationAcceptanceChangeImpact
}

export interface WorkflowLedgerMigrationAcceptanceChangeImpact {
  plan: import('./workflow-change-impact').WorkflowChangeImpactPlan
  now: number
}

export interface PreparedWorkflowLedgerMigration {
  migrationId: string
  journalPath: string
  backupPath: string
  journal: WorkflowLedgerCanonicalMigrationJournal
  alreadyCommitted: boolean
}

export interface WorkflowLedgerTaskStoreReadiness {
  disposition: 'ready_existing_v8' | 'ready_existing_current' | 'migrated' | 'blocked'
  report: WorkflowLedgerCanonicalReadinessReport
  migration?: PreparedWorkflowLedgerMigration
}

export interface WorkflowLedgerMigrationFaultOptions {
  faultAt?: WorkflowLedgerMigrationCheckpoint
  now?: () => number
}

export interface WorkflowLedgerRollbackOptions extends WorkflowLedgerMigrationFaultOptions {
  expectedTargetPath: string
}

export interface EnsureWorkflowLedgerTaskStoreReadyOptions extends WorkflowLedgerMigrationFaultOptions {
  databasePath: string
  legacyJsonPath: string
  supportedStoreVersion: number
  targetStoreVersion: number
  readMode?: WorkflowLedgerReadMode
  buildCandidate: (source: WorkflowLedgerMigrationSource) => Promise<Uint8Array> | Uint8Array
  backupsRoot?: string
  forceRefresh?: boolean
}

export class WorkflowLedgerMigrationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkflowLedgerMigrationError'
    this.code = code
  }
}

export class WorkflowLedgerMigrationFault extends Error {
  readonly checkpoint: WorkflowLedgerMigrationCheckpoint

  constructor(checkpoint: WorkflowLedgerMigrationCheckpoint) {
    super(`Injected Workflow Ledger migration fault at ${checkpoint}`)
    this.name = 'WorkflowLedgerMigrationFault'
    this.checkpoint = checkpoint
  }
}
