import type { Goal, ProjectWorkspaceState, WorkItem } from '../../shared/project-workspace-types'
import type {
  ProjectWorkspaceLedgerMigrationOptions,
  ProjectWorkspaceLedgerMigrationResult
} from './ledger-migration'

export const PROJECT_WORKSPACE_LEDGER_SHADOW_JOURNAL_FORMAT =
  'caogen.project-workspace-ledger-shadow-write.v1'

export type ProjectWorkspaceLedgerShadowCheckpoint =
  | 'after_prepare'
  | 'after_source_commit'
  | 'after_projection_before_journal_commit'

export type ProjectWorkspaceLedgerShadowCommand =
  | 'goal.create'
  | 'goal.update'
  | 'goal.acceptance.set'
  | 'goal.transition'
  | 'goal.archive'
  | 'goal.restore'
  | 'work_item.create'
  | 'work_item.update'
  | 'work_item.reorder'
  | 'work_item.acceptance.set'
  | 'work_item.transition'
  | 'work_item.reopen_for_file_change'
  | 'work_item.lease.acquire'
  | 'work_item.lease.renew'
  | 'work_item.lease.release'

export type ProjectWorkspaceLedgerShadowJournalState =
  | 'prepared'
  | 'source_committed'
  | 'projection_committed'
  | 'aborted'

export type ProjectWorkspaceLedgerShadowEntityType = 'goal' | 'work_item'
export type ProjectWorkspaceLedgerShadowEntity = Goal | WorkItem

export interface ProjectWorkspaceLedgerShadowErrorRecord {
  name: string
  message: string
  code?: string
  at: number
}

export interface ProjectWorkspaceLedgerShadowSourceState {
  storeRevisionBefore: number
  entityRevisionBefore?: number
  entityDigestBefore?: string
  storeRevisionAfter?: number
  entityRevisionAfter?: number
  entityDigestAfter?: string
}

export interface ProjectWorkspaceLedgerShadowProjectionState {
  status: ProjectWorkspaceLedgerMigrationResult['status']
  stateRevision: number
  workspaceRevision: number
  projectionDigest: string
  sourceSha256: string
  migrationId?: string
  migrationJournalPath?: string
}

export interface ProjectWorkspaceLedgerShadowJournal {
  schemaVersion: 1
  format: typeof PROJECT_WORKSPACE_LEDGER_SHADOW_JOURNAL_FORMAT
  operationId: string
  command: ProjectWorkspaceLedgerShadowCommand
  entityType: ProjectWorkspaceLedgerShadowEntityType
  entityId: string
  workspaceId?: string
  state: ProjectWorkspaceLedgerShadowJournalState
  source: ProjectWorkspaceLedgerShadowSourceState
  projection?: ProjectWorkspaceLedgerShadowProjectionState
  attempts: number
  createdAt: number
  updatedAt: number
  lastError?: ProjectWorkspaceLedgerShadowErrorRecord
  journalDigest: string
}

export interface ProjectWorkspaceLedgerShadowMutation {
  command: ProjectWorkspaceLedgerShadowCommand
  entityType: ProjectWorkspaceLedgerShadowEntityType
  entityId: string
  workspaceId?: string
  requiresCanonicalAcceptance?: boolean
  fileChangeImpact?: import('./file-change-impact').ProjectWorkspaceFileChangeImpact
}

export interface ProjectWorkspaceLedgerShadowMigration {
  (
    workspaceId: string,
    rootDir?: string,
    options?: ProjectWorkspaceLedgerMigrationOptions
  ): Promise<ProjectWorkspaceLedgerMigrationResult>
}

export interface ProjectWorkspaceLedgerShadowOptions {
  now?: () => number
  migrate?: ProjectWorkspaceLedgerShadowMigration
  faultAt?: ProjectWorkspaceLedgerShadowCheckpoint
  onFault?: (
    checkpoint: ProjectWorkspaceLedgerShadowCheckpoint,
    journal: ProjectWorkspaceLedgerShadowJournal
  ) => void | Promise<void>
}

export interface ProjectWorkspaceLedgerShadowReadiness {
  enabled: true
  ready: boolean
  rootDir: string
  totalJournals: number
  pendingJournals: number
  prepared: number
  sourceCommitted: number
  projectionCommitted: number
  aborted: number
  pending: Array<{
    operationId: string
    command: ProjectWorkspaceLedgerShadowCommand
    entityType: ProjectWorkspaceLedgerShadowEntityType
    entityId: string
    workspaceId?: string
    state: 'prepared' | 'source_committed'
    attempts: number
    journalPath: string
    lastError?: ProjectWorkspaceLedgerShadowErrorRecord
  }>
}

export interface ProjectWorkspaceLedgerShadowJournalEntry {
  path: string
  journal: ProjectWorkspaceLedgerShadowJournal
}

export type ProjectWorkspaceLedgerPreparedDisposition =
  | { kind: 'not_committed' }
  | {
    kind: 'source_committed'
    state: ProjectWorkspaceState
    entity: ProjectWorkspaceLedgerShadowEntity
    workspaceId: string
  }
  | { kind: 'ambiguous'; reason: string }
