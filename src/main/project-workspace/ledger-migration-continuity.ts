import type { ProjectWorkspace } from '../../shared/project-workspace-types'
import type { WorkflowGoalRecord, WorkflowWorkItemRecord } from '../../shared/workflow-types'
import { digest } from '../task/workflow-ledger-codec'
import { readAndVerifyEvents } from '../task/workflow-ledger-query'
import {
  findWorkflowGoal,
  findWorkflowWorkItem,
  type WorkflowLedgerDatabase
} from '../task/workflow-ledger-store'
import {
  isDigest,
  isId,
  isRecord,
  migrationError,
  nonNegativeRevision,
  positiveRevision
} from './ledger-migration-errors'
import type {
  GoalMigrationDescriptor,
  ProjectedGoal,
  ProjectedWorkItem,
  ProjectionBundle,
  SourceFile,
  WorkItemMigrationDescriptor
} from './ledger-migration-source'

export const PROJECT_WORKSPACE_MIGRATION_EVENT_KIND = 'workflow.project-workspace.migrated'
export const PROJECT_WORKSPACE_MIGRATION_PAYLOAD_FORMAT = 'caogen.project-workspace-ledger-migration.v1'

export interface MigrationSourceBinding {
  path: string
  sha256: string
  sizeBytes: number
  backupPath: string
}

export interface ProjectWorkspaceMigrationPayload {
  format: typeof PROJECT_WORKSPACE_MIGRATION_PAYLOAD_FORMAT
  migrationId: string
  journalPath: string
  sqliteBackupPath: string
  workspaceId: string
  workspaceRevision: number
  stateRevision: number
  workspaceDigest: string
  projectionDigest: string
  source: MigrationSourceBinding
  workspace: ProjectWorkspace
  goals: GoalMigrationDescriptor[]
  workItems: WorkItemMigrationDescriptor[]
}

export function latestProjectWorkspaceMigration(
  db: WorkflowLedgerDatabase,
  workspaceId: string
): ProjectWorkspaceMigrationPayload | undefined {
  const event = readAndVerifyEvents(db).filter((candidate) =>
    candidate.kind === PROJECT_WORKSPACE_MIGRATION_EVENT_KIND &&
    candidate.entityType === 'system' &&
    candidate.entityId === workspaceId &&
    candidate.projectId === workspaceId
  ).at(-1)
  return event ? parseProjectWorkspaceMigrationPayload(event.payload) : undefined
}

export function assertProjectWorkspaceSourceContinuity(
  source: SourceFile,
  projection: ProjectionBundle,
  previous: ProjectWorkspaceMigrationPayload | undefined
): void {
  if (!previous) return
  const workspace = source.aggregate.workspace
  if (workspace.revision < previous.workspaceRevision || source.state.revision < previous.stateRevision) {
    throw migrationError('SOURCE_REVISION_REGRESSION', `workspace ${workspace.id} source revision regressed`)
  }
  if (workspace.revision === previous.workspaceRevision && projection.workspaceDigest !== previous.workspaceDigest) {
    throw migrationError('SOURCE_REVISION_DRIFT', `workspace ${workspace.id} changed without a revision increment`)
  }
  assertEntityContinuity(projection.goals.map((item) => item.descriptor), previous.goals, 'goal')
  assertEntityContinuity(projection.workItems.map((item) => item.descriptor), previous.workItems, 'work item')
  if (source.state.revision === previous.stateRevision && projection.projectionDigest !== previous.projectionDigest) {
    throw migrationError('SOURCE_STORE_REVISION_DRIFT', 'project workspace store changed without a store revision increment')
  }
}

export function planProjectWorkspaceGoalWrites(
  db: WorkflowLedgerDatabase,
  goals: readonly ProjectedGoal[],
  previous: ProjectWorkspaceMigrationPayload | undefined
): Set<string> {
  const writes = new Set<string>()
  const prior = new Map(previous?.goals.map((item) => [item.id, item]) ?? [])
  for (const goal of goals) {
    const existing = findWorkflowGoal(db, goal.source.id)
    if (shouldWriteEntity(existing, goal.record, goal.descriptor, prior.get(goal.source.id), 'goal')) {
      writes.add(goal.source.id)
    }
  }
  return writes
}

export function planProjectWorkspaceWorkItemWrites(
  db: WorkflowLedgerDatabase,
  items: readonly ProjectedWorkItem[],
  previous: ProjectWorkspaceMigrationPayload | undefined
): Set<string> {
  const writes = new Set<string>()
  const prior = new Map(previous?.workItems.map((item) => [item.id, item]) ?? [])
  for (const item of items) {
    const existing = findWorkflowWorkItem(db, item.source.id)
    const changed = shouldWriteEntity(existing, item.record, item.descriptor, prior.get(item.source.id), 'work item')
    if (!changed && existing && !item.source.runRefs.every((runId) => existing.runIds.includes(runId))) {
      throw migrationError('TARGET_RUN_REFERENCE_REGRESSION', `work item ${item.source.id} lost a migrated Run reference`)
    }
    if (changed) writes.add(item.source.id)
  }
  return writes
}

function shouldWriteEntity(
  existing: WorkflowGoalRecord | WorkflowWorkItemRecord | null,
  incoming: WorkflowGoalRecord | WorkflowWorkItemRecord,
  current: GoalMigrationDescriptor | WorkItemMigrationDescriptor,
  previous: GoalMigrationDescriptor | WorkItemMigrationDescriptor | undefined,
  label: string
): boolean {
  if (existing) assertTargetOwnership(existing, incoming, label)
  if (!previous) return planInitialWrite(existing, current, label)
  if (!existing) throw migrationError('TARGET_ENTITY_DELETED', `${label} ${current.id} disappeared after migration`)
  if (current.sourceDigest === previous.sourceDigest) {
    assertUnchangedSourceTarget(existing, current, label)
    return false
  }
  if (existing.revision === current.sourceRevision && digest(existing) === current.ledgerDigest) return false
  if (existing.revision !== previous.sourceRevision || digest(existing) !== previous.ledgerDigest) {
    throw migrationError('TARGET_REVISION_CONFLICT', `${label} ${current.id} advanced while its JSON source also changed`)
  }
  return true
}

function planInitialWrite(
  existing: WorkflowGoalRecord | WorkflowWorkItemRecord | null,
  current: GoalMigrationDescriptor | WorkItemMigrationDescriptor,
  label: string
): boolean {
  if (!existing) return true
  if (existing.revision > current.sourceRevision) {
    throw migrationError('TARGET_REVISION_CONFLICT', `${label} ${current.id} is ahead of an unrecorded JSON source`)
  }
  if (existing.revision === current.sourceRevision) {
    if (digest(existing) === current.ledgerDigest) return false
    throw migrationError('TARGET_REVISION_CONFLICT', `${label} ${current.id} changed at source revision ${current.sourceRevision}`)
  }
  return true
}

function assertUnchangedSourceTarget(
  existing: WorkflowGoalRecord | WorkflowWorkItemRecord,
  current: GoalMigrationDescriptor | WorkItemMigrationDescriptor,
  label: string
): void {
  if (existing.revision < current.sourceRevision) {
    throw migrationError('TARGET_STATE_REGRESSION', `${label} ${current.id} revision regressed`)
  }
  if (existing.revision === current.sourceRevision && digest(existing) !== current.ledgerDigest) {
    throw migrationError('TARGET_REVISION_CONFLICT', `${label} ${current.id} changed without a JSON revision`)
  }
}

function assertTargetOwnership(
  existing: WorkflowGoalRecord | WorkflowWorkItemRecord,
  incoming: WorkflowGoalRecord | WorkflowWorkItemRecord,
  label: string
): void {
  const workItemOwnershipChanged = 'parentId' in existing && 'parentId' in incoming && (
    existing.goalId !== incoming.goalId || existing.parentId !== incoming.parentId
  )
  if (existing.projectId !== incoming.projectId || workItemOwnershipChanged) {
    throw migrationError('TARGET_OWNERSHIP_CONFLICT', `${label} ${incoming.id} has conflicting Workflow Ledger ownership`)
  }
}

function assertEntityContinuity<T extends GoalMigrationDescriptor | WorkItemMigrationDescriptor>(
  current: readonly T[],
  previous: readonly T[],
  label: string
): void {
  const currentById = new Map(current.map((item) => [item.id, item]))
  for (const prior of previous) {
    const item = currentById.get(prior.id)
    if (!item) throw migrationError('SOURCE_ENTITY_DELETED', `${label} ${prior.id} was deleted from the JSON source`)
    if (item.projectId !== prior.projectId ||
        ('goalId' in item && 'goalId' in prior && (item.goalId !== prior.goalId || item.parentId !== prior.parentId))) {
      throw migrationError('SOURCE_OWNERSHIP_CHANGED', `${label} ${prior.id} changed immutable ownership`)
    }
    if (item.sourceRevision < prior.sourceRevision) {
      throw migrationError('SOURCE_REVISION_REGRESSION', `${label} ${prior.id} source revision regressed`)
    }
    if (item.sourceRevision === prior.sourceRevision && item.sourceDigest !== prior.sourceDigest) {
      throw migrationError('SOURCE_REVISION_DRIFT', `${label} ${prior.id} changed without a revision increment`)
    }
  }
}

export function parseProjectWorkspaceMigrationPayload(value: unknown): ProjectWorkspaceMigrationPayload {
  if (!isRecord(value) || !hasPayloadEnvelope(value) || !hasPayloadCollections(value)) {
    throw migrationError('MIGRATION_EVENT_INVALID', 'ProjectWorkspace migration event payload is invalid')
  }
  const source = value.source
  if (!isRecord(source) || !hasSourceBinding(source)) {
    throw migrationError('MIGRATION_EVENT_INVALID', 'ProjectWorkspace migration source binding is invalid')
  }
  return {
    ...(value as unknown as ProjectWorkspaceMigrationPayload),
    goals: (value.goals as unknown[]).map(parseGoalDescriptor),
    workItems: (value.workItems as unknown[]).map(parseWorkItemDescriptor)
  }
}

function hasPayloadEnvelope(value: Record<string, unknown>): boolean {
  return value.format === PROJECT_WORKSPACE_MIGRATION_PAYLOAD_FORMAT &&
    isId(value.migrationId) && isId(value.journalPath) && isId(value.sqliteBackupPath) &&
    isId(value.workspaceId) && positiveRevision(value.workspaceRevision) &&
    nonNegativeRevision(value.stateRevision) && isDigest(value.workspaceDigest) &&
    isDigest(value.projectionDigest)
}

function hasPayloadCollections(value: Record<string, unknown>): boolean {
  return isRecord(value.source) && isRecord(value.workspace) &&
    Array.isArray(value.goals) && Array.isArray(value.workItems)
}

function hasSourceBinding(value: Record<string, unknown>): boolean {
  return isId(value.path) && isDigest(value.sha256) &&
    nonNegativeRevision(value.sizeBytes) && isId(value.backupPath)
}

function parseGoalDescriptor(value: unknown): GoalMigrationDescriptor {
  if (!isRecord(value) || !isId(value.id) || !positiveRevision(value.sourceRevision) ||
      !isDigest(value.sourceDigest) || !isDigest(value.ledgerDigest) || !isId(value.projectId) || !isRecord(value.source)) {
    throw migrationError('MIGRATION_EVENT_INVALID', 'ProjectWorkspace Goal migration descriptor is invalid')
  }
  return value as unknown as GoalMigrationDescriptor
}

function parseWorkItemDescriptor(value: unknown): WorkItemMigrationDescriptor {
  if (!isRecord(value) || !isId(value.id) || !positiveRevision(value.sourceRevision) ||
      !isDigest(value.sourceDigest) || !isDigest(value.ledgerDigest) || !isId(value.projectId) ||
      (value.goalId !== undefined && !isId(value.goalId)) ||
      (value.parentId !== undefined && !isId(value.parentId)) ||
      !Array.isArray(value.runRefs) || !value.runRefs.every(isId) || !isRecord(value.source)) {
    throw migrationError('MIGRATION_EVENT_INVALID', 'ProjectWorkspace WorkItem migration descriptor is invalid')
  }
  return value as unknown as WorkItemMigrationDescriptor
}
