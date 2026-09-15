import type {
  AcceptanceResult,
  AcceptanceSpec,
  Goal,
  GoalContract,
  ProjectWorkspace,
  WorkItem,
  WorkItemLease,
  WorkItemOwner
} from '../../shared/project-workspace-types'
import {
  isGoalStatus,
  isWorkItemStatus,
  isWorkItemType
} from '../../shared/project-workspace-types'
import type {
  WorkflowGoalRecord,
  WorkflowWorkItemRecord
} from '../../shared/workflow-types'
import { digest } from '../task/workflow-ledger-codec'
import type { WorkflowLedgerDatabase } from '../task/workflow-ledger-db'
import {
  readAndVerifyEventAppendState,
  readAndVerifyEvents,
  type WorkflowEventReferenceIndex
} from '../task/workflow-ledger-query'
import { WorkflowLedgerCorruptionError } from '../task/workflow-ledger-errors'
import {
  clone,
  normalizeAcceptanceResult,
  normalizeAcceptanceSpecs,
  normalizeContract,
  normalizeOwner,
  requiredId
} from './codec'
import {
  PROJECT_WORKSPACE_MIGRATION_EVENT_KIND,
  latestProjectWorkspaceMigration,
  parseProjectWorkspaceMigrationPayload,
  type ProjectWorkspaceMigrationPayload
} from './ledger-migration-continuity'
import type {
  GoalMigrationDescriptor,
  WorkItemMigrationDescriptor
} from './ledger-migration-source'

export const VERIFIED_CANONICAL_PROJECT_WORKSPACE_VIEW_VERSION = 1 as const

export type VerifiedCanonicalProjectWorkspaceViewErrorCode =
  | 'INVALID_WORKSPACE_ID'
  | 'MIGRATION_EVENT_MISSING'
  | 'MIGRATION_EVENT_INVALID'
  | 'SOURCE_DIGEST_MISMATCH'
  | 'LEDGER_ENTITY_MISSING'
  | 'LEDGER_DIGEST_MISMATCH'
  | 'ENTITY_SET_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'RELATION_CYCLE'
  | 'REVISION_MISMATCH'
  | 'RUN_REFERENCE_INVALID'
  | 'STATUS_MISMATCH'
  | 'RUN_MAPPING_MISMATCH'
  | 'RICH_SCHEMA_INVALID'

export class VerifiedCanonicalProjectWorkspaceViewError extends Error {
  readonly code: VerifiedCanonicalProjectWorkspaceViewErrorCode

  constructor(code: VerifiedCanonicalProjectWorkspaceViewErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'VerifiedCanonicalProjectWorkspaceViewError'
    this.code = code
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause })
  }
}

export interface VerifiedCanonicalProjectWorkspaceView {
  schemaVersion: typeof VERIFIED_CANONICAL_PROJECT_WORKSPACE_VIEW_VERSION
  workspaceId: string
  workspaceRevision: number
  stateRevision: number
  migrationId: string
  projectionDigest: string
  sourceSha256: string
  workspace: ProjectWorkspace
  goals: Goal[]
  workItems: WorkItem[]
}

export async function readVerifiedCanonicalProjectWorkspaceView(
  workspaceId: string,
  rootDir?: string
): Promise<VerifiedCanonicalProjectWorkspaceView> {
  const { readTaskSnapshotDatabase } = await import('../task/task-snapshot.js')
  return readTaskSnapshotDatabase(rootDir, (db) =>
    readVerifiedCanonicalProjectWorkspaceViewFromDatabase(db, workspaceId)
  )
}

export async function listVerifiedCanonicalProjectWorkspaceIds(rootDir?: string): Promise<string[]> {
  const { readTaskSnapshotDatabase } = await import('../task/task-snapshot.js')
  return readTaskSnapshotDatabase(rootDir, listVerifiedCanonicalProjectWorkspaceIdsFromDatabase)
}

export function listVerifiedCanonicalProjectWorkspaceIdsFromDatabase(
  db: WorkflowLedgerDatabase
): string[] {
  const ids = new Set<string>()
  for (const event of readAndVerifyEvents(db)) {
    if (event.kind !== PROJECT_WORKSPACE_MIGRATION_EVENT_KIND || event.entityType !== 'system' ||
        event.entityId !== event.projectId || !event.projectId) continue
    ids.add(event.projectId)
  }
  const result = [...ids].sort()
  for (const id of result) latestProjectWorkspaceMigration(db, id)
  return result
}

export function readVerifiedCanonicalProjectWorkspaceViewFromDatabase(
  db: WorkflowLedgerDatabase,
  workspaceId: string
): VerifiedCanonicalProjectWorkspaceView {
  const id = requiredWorkspaceId(workspaceId)
  let verified: ReturnType<typeof readAndVerifyEventAppendState>
  try {
    verified = readAndVerifyEventAppendState(db)
  } catch (error) {
    // Keep the low-level ledger verifier strict, but expose a stable error
    // contract at the canonical ProjectWorkspace read boundary.
    if (isWorkflowLedgerCorruption(error)) {
      fail('MIGRATION_EVENT_INVALID', `Workspace ${id} canonical Ledger verification failed`, error)
    }
    throw error
  }
  const migration = readMigration(verified.events, id)
  verifyWorkspace(migration, id)
  const goalDescriptors = uniqueDescriptors(migration.goals, 'Goal')
  const workItemDescriptors = uniqueDescriptors(migration.workItems, 'WorkItem')
  verifyExplicitEntityClosure(verified.references, id, goalDescriptors, workItemDescriptors)
  const goals = goalDescriptors.map((descriptor) =>
    verifyGoal(verified.references, descriptor, id)
  )
  const workItems = workItemDescriptors.map((descriptor) =>
    verifyWorkItem(verified.references, descriptor, id)
  )
  verifyRichRelations(goals, workItems, id)
  verifyProjectionDigest(migration, goals, workItems)
  return clone({
    schemaVersion: VERIFIED_CANONICAL_PROJECT_WORKSPACE_VIEW_VERSION,
    workspaceId: id,
    workspaceRevision: migration.workspaceRevision,
    stateRevision: migration.stateRevision,
    migrationId: migration.migrationId,
    projectionDigest: migration.projectionDigest,
    sourceSha256: migration.source.sha256,
    workspace: migration.workspace,
    goals,
    workItems
  })
}

/**
 * Keep the canonical read contract stable even when the Ledger verifier is
 * loaded through a separate compiled/module boundary. The verifier remains
 * fail-closed; this guard only normalizes its public error code.
 */
function isWorkflowLedgerCorruption(error: unknown): error is WorkflowLedgerCorruptionError {
  return error instanceof WorkflowLedgerCorruptionError || (
    typeof error === 'object' && error !== null &&
    'code' in error && error.code === 'WORKFLOW_LEDGER_CORRUPTION'
  )
}

function requiredWorkspaceId(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('INVALID_WORKSPACE_ID', 'verified canonical view requires a Workspace id')
  }
  return value.trim()
}

function readMigration(
  events: ReturnType<typeof readAndVerifyEvents>,
  workspaceId: string
): ProjectWorkspaceMigrationPayload {
  try {
    const event = events.filter((candidate) =>
      candidate.kind === PROJECT_WORKSPACE_MIGRATION_EVENT_KIND &&
      candidate.entityType === 'system' &&
      candidate.entityId === workspaceId &&
      candidate.projectId === workspaceId
    ).at(-1)
    if (!event) fail('MIGRATION_EVENT_MISSING', `Workspace ${workspaceId} has no verified migration event`)
    return parseProjectWorkspaceMigrationPayload(event.payload)
  } catch (error) {
    if (error instanceof VerifiedCanonicalProjectWorkspaceViewError) throw error
    fail('MIGRATION_EVENT_INVALID', `Workspace ${workspaceId} migration event verification failed`, error)
  }
}

function verifyWorkspace(migration: ProjectWorkspaceMigrationPayload, workspaceId: string): void {
  const workspace = migration.workspace
  if (migration.workspaceId !== workspaceId || workspace.id !== workspaceId) {
    fail('IDENTITY_MISMATCH', `Workspace ${workspaceId} migration ownership differs`)
  }
  if (workspace.revision !== migration.workspaceRevision) {
    fail('REVISION_MISMATCH', `Workspace ${workspaceId} migration revision differs from its rich source`)
  }
  if (digest(workspace) !== migration.workspaceDigest) {
    fail('SOURCE_DIGEST_MISMATCH', `Workspace ${workspaceId} rich source digest differs`)
  }
}

function verifyGoal(
  references: WorkflowEventReferenceIndex,
  descriptor: GoalMigrationDescriptor,
  workspaceId: string
): Goal {
  const source = descriptor.source
  assertRichGoal(source, descriptor.id)
  if (digest(source) !== descriptor.sourceDigest) {
    fail('SOURCE_DIGEST_MISMATCH', `Goal ${descriptor.id} rich source digest differs`)
  }
  if (source.id !== descriptor.id || source.projectId !== descriptor.projectId || source.projectId !== workspaceId) {
    fail('IDENTITY_MISMATCH', `Goal ${descriptor.id} rich source ownership differs`)
  }
  if (source.revision !== descriptor.sourceRevision) {
    fail('REVISION_MISMATCH', `Goal ${descriptor.id} rich source revision differs`)
  }
  const ledger = requireGoal(references, descriptor.id)
  verifyLedgerDigest(ledger, descriptor.ledgerDigest, 'Goal', descriptor.id)
  verifyGoalMapping(source, ledger)
  return clone(source)
}

function verifyWorkItem(
  references: WorkflowEventReferenceIndex,
  descriptor: WorkItemMigrationDescriptor,
  workspaceId: string
): WorkItem {
  const source = descriptor.source
  assertRichWorkItem(source, descriptor.id)
  if (digest(source) !== descriptor.sourceDigest) {
    fail('SOURCE_DIGEST_MISMATCH', `WorkItem ${descriptor.id} rich source digest differs`)
  }
  if (source.id !== descriptor.id || source.projectId !== descriptor.projectId || source.projectId !== workspaceId ||
      source.goalId !== descriptor.goalId || source.parentId !== descriptor.parentId) {
    fail('IDENTITY_MISMATCH', `WorkItem ${descriptor.id} rich source ownership differs`)
  }
  if (source.revision !== descriptor.sourceRevision) {
    fail('REVISION_MISMATCH', `WorkItem ${descriptor.id} rich source revision differs`)
  }
  if (!sameIds(source.runRefs, descriptor.runRefs)) {
    fail('RUN_MAPPING_MISMATCH', `WorkItem ${descriptor.id} migration Run references differ from its rich source`)
  }
  verifyRunReferences(references, source)
  const ledger = requireWorkItem(references, descriptor.id)
  verifyLedgerDigest(ledger, descriptor.ledgerDigest, 'WorkItem', descriptor.id)
  verifyWorkItemMapping(source, ledger)
  return clone(source)
}

function requireGoal(references: WorkflowEventReferenceIndex, id: string): WorkflowGoalRecord {
  const goal = references.goals.get(id)
  if (!goal) fail('LEDGER_ENTITY_MISSING', `Goal ${id} is missing from the Workflow Ledger`)
  return goal
}

function requireWorkItem(references: WorkflowEventReferenceIndex, id: string): WorkflowWorkItemRecord {
  const item = references.workItems.get(id)
  if (!item) fail('LEDGER_ENTITY_MISSING', `WorkItem ${id} is missing from the Workflow Ledger`)
  return item
}

function verifyLedgerDigest(record: object, expected: string, label: string, id: string): void {
  if (digest(record) !== expected) {
    fail('LEDGER_DIGEST_MISMATCH', `${label} ${id} differs from its committed migration Ledger digest`)
  }
}

function verifyExplicitEntityClosure(
  references: WorkflowEventReferenceIndex,
  workspaceId: string,
  goals: readonly GoalMigrationDescriptor[],
  workItems: readonly WorkItemMigrationDescriptor[]
): void {
  const explicitGoalIds = [...references.goals.values()].filter((goal) =>
    goal.projectId === workspaceId && goal.source === 'explicit'
  ).map((goal) => goal.id).sort()
  const explicitWorkItemIds = [...references.workItems.values()].filter((item) =>
    item.projectId === workspaceId && item.source === 'explicit'
  ).map((item) => item.id).sort()
  assertEntitySet(goals.map((goal) => goal.id).sort(), explicitGoalIds, 'Goal', workspaceId)
  assertEntitySet(workItems.map((item) => item.id).sort(), explicitWorkItemIds, 'WorkItem', workspaceId)
}

function assertEntitySet(
  descriptorIds: readonly string[],
  ledgerIds: readonly string[],
  label: string,
  workspaceId: string
): void {
  if (!sameIds(descriptorIds, ledgerIds)) {
    fail(
      'ENTITY_SET_MISMATCH',
      `Workspace ${workspaceId} ${label} descriptors do not close over the current explicit Ledger set`
    )
  }
}

function verifyRunReferences(references: WorkflowEventReferenceIndex, item: WorkItem): void {
  for (const runId of item.runRefs) {
    const run = references.runs.get(runId)
    if (!run) fail('RUN_REFERENCE_INVALID', `WorkItem ${item.id} references missing Run ${runId}`)
    if (run.projectId !== item.projectId || run.goalId !== item.goalId || run.workItemId !== item.id) {
      fail('RUN_REFERENCE_INVALID', `Run ${runId} crosses WorkItem ${item.id} ownership`)
    }
  }
}

function verifyGoalMapping(source: Goal, ledger: WorkflowGoalRecord): void {
  if (ledger.id !== source.id || ledger.projectId !== source.projectId || ledger.source !== 'explicit') {
    fail('IDENTITY_MISMATCH', `Goal ${source.id} Ledger identity differs from its rich source`)
  }
  if (ledger.revision !== source.revision) {
    fail('REVISION_MISMATCH', `Goal ${source.id} Ledger revision differs from its rich source`)
  }
  if (ledger.status !== source.status) {
    fail('STATUS_MISMATCH', `Goal ${source.id} Ledger status differs from its rich source`)
  }
  const expected: WorkflowGoalRecord = {
    schemaVersion: 1,
    id: source.id,
    projectId: source.projectId,
    title: source.title,
    objective: source.objective,
    status: source.status,
    revision: source.revision,
    source: 'explicit',
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    dueAt: source.dueAt,
    archivedAt: source.archivedAt
  }
  if (digest(ledger) !== digest(expected)) {
    fail('RICH_SCHEMA_INVALID', `Goal ${source.id} slim Ledger projection is not losslessly mapped from its rich source`)
  }
}

function verifyWorkItemMapping(source: WorkItem, ledger: WorkflowWorkItemRecord): void {
  if (ledger.id !== source.id || ledger.projectId !== source.projectId || ledger.goalId !== source.goalId ||
      ledger.parentId !== source.parentId || ledger.source !== 'explicit') {
    fail('IDENTITY_MISMATCH', `WorkItem ${source.id} Ledger identity differs from its rich source`)
  }
  if (ledger.revision !== source.revision) {
    fail('REVISION_MISMATCH', `WorkItem ${source.id} Ledger revision differs from its rich source`)
  }
  if (ledger.status !== source.status) {
    fail('STATUS_MISMATCH', `WorkItem ${source.id} Ledger status differs from its rich source`)
  }
  if (!sameIds(ledger.runIds, source.runRefs) || ledger.currentRunId !== source.runRefs.at(-1)) {
    fail('RUN_MAPPING_MISMATCH', `WorkItem ${source.id} Ledger Run mapping differs from its rich source`)
  }
  const expected: WorkflowWorkItemRecord = {
    schemaVersion: 1,
    id: source.id,
    projectId: source.projectId,
    goalId: source.goalId,
    parentId: source.parentId,
    businessLineId: source.businessLineId,
    type: source.type,
    ...(source.role === undefined ? {} : { role: source.role }),
    title: source.title,
    description: source.description,
    status: source.status,
    revision: source.revision,
    source: 'explicit',
    runIds: [...source.runRefs],
    currentRunId: source.runRefs.at(-1),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    dueAt: source.dueAt
  }
  if (digest(ledger) !== digest(expected)) {
    fail('RICH_SCHEMA_INVALID', `WorkItem ${source.id} slim Ledger projection is not losslessly mapped from its rich source`)
  }
}

function verifyProjectionDigest(
  migration: ProjectWorkspaceMigrationPayload,
  goals: readonly Goal[],
  workItems: readonly WorkItem[]
): void {
  const projection = {
    workspace: migration.workspace,
    goals: [...goals],
    workItems: [...workItems]
  }
  if (digest(projection) !== migration.projectionDigest) {
    fail('SOURCE_DIGEST_MISMATCH', `Workspace ${migration.workspaceId} aggregate projection digest differs`)
  }
}

function verifyRichRelations(goals: readonly Goal[], workItems: readonly WorkItem[], workspaceId: string): void {
  const goalById = new Map(goals.map((goal) => [goal.id, goal]))
  const itemById = new Map(workItems.map((item) => [item.id, item]))
  for (const item of workItems) {
    const goal = item.goalId ? goalById.get(item.goalId) : undefined
    if (item.goalId && (!goal || goal.projectId !== workspaceId)) {
      fail('IDENTITY_MISMATCH', `WorkItem ${item.id} references a Goal outside Workspace ${workspaceId}`)
    }
    if (item.parentId && itemById.get(item.parentId)?.projectId !== workspaceId) {
      fail('IDENTITY_MISMATCH', `WorkItem ${item.id} references a parent outside Workspace ${workspaceId}`)
    }
    for (const dependencyId of item.dependencyIds) {
      if (itemById.get(dependencyId)?.projectId !== workspaceId) {
        fail('IDENTITY_MISMATCH', `WorkItem ${item.id} references a dependency outside Workspace ${workspaceId}`)
      }
    }
    if (goal && item.inheritedGoalContract && digest(goal.contract) !== digest(item.inheritedGoalContract)) {
      fail('RICH_SCHEMA_INVALID', `WorkItem ${item.id} inherited Goal Contract differs from Goal ${goal.id}`)
    }
  }
  assertAcyclic(workItems, (item) => item.parentId ? [item.parentId] : [], 'parent')
  assertAcyclic(workItems, (item) => item.dependencyIds, 'dependency')
}

function assertAcyclic(
  items: readonly WorkItem[],
  edges: (item: WorkItem) => readonly string[],
  relation: string
): void {
  const byId = new Map(items.map((item) => [item.id, item]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) fail('RELATION_CYCLE', `WorkItem ${relation} relation contains a cycle at ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    const item = byId.get(id)
    if (item) for (const next of edges(item)) visit(next)
    visiting.delete(id)
    visited.add(id)
  }
  for (const item of items) visit(item.id)
}

function assertRichGoal(value: Goal, id: string): void {
  try {
    if (!value || value.schemaVersion !== 1 || value.id !== id || !isGoalStatus(value.status) ||
        !finiteTimestamp(value.createdAt) || !finiteTimestamp(value.updatedAt) ||
        !positiveRevision(value.revision) || typeof value.title !== 'string' || value.title.length === 0) {
      fail('RICH_SCHEMA_INVALID', `Goal ${id} rich source shape is invalid`)
    }
    const contract = normalizeContract(value.contract)
    const flattened = goalContractFromFlattened(value)
    if (digest(contract) !== digest(value.contract) || digest(contract) !== digest(flattened)) {
      fail('RICH_SCHEMA_INVALID', `Goal ${id} contract and flattened fields differ`)
    }
    verifyAcceptanceResult(value.acceptanceResult, `Goal ${id}`)
  } catch (error) {
    if (error instanceof VerifiedCanonicalProjectWorkspaceViewError) throw error
    fail('RICH_SCHEMA_INVALID', `Goal ${id} rich source validation failed`, error)
  }
}

function assertRichWorkItem(value: WorkItem, id: string): void {
  try {
    assertWorkItemIdentityShape(value, id)
    assertWorkItemStateShape(value, id)
    if (value.role !== undefined && requiredId(value.role, `WorkItem ${id} role`) !== value.role) {
      fail('RICH_SCHEMA_INVALID', `WorkItem ${id} role is not normalized`)
    }
    verifyIdList(value.dependencyIds, `WorkItem ${id} dependencies`)
    verifyIdList(value.artifactRefs, `WorkItem ${id} Artifact references`)
    verifyIdList(value.runRefs, `WorkItem ${id} Run references`)
    verifyAcceptanceSpecs(value.acceptanceSpec, `WorkItem ${id}`)
    verifyAcceptanceResult(value.acceptance, `WorkItem ${id}`)
    verifyOwner(value.owner, `WorkItem ${id}`)
    verifyLease(value.lease, `WorkItem ${id}`)
    if (value.inheritedGoalContract) {
      const contract = normalizeContract(value.inheritedGoalContract)
      if (digest(contract) !== digest(value.inheritedGoalContract)) {
        fail('RICH_SCHEMA_INVALID', `WorkItem ${id} inherited Goal Contract is not normalized`)
      }
    }
  } catch (error) {
    if (error instanceof VerifiedCanonicalProjectWorkspaceViewError) throw error
    fail('RICH_SCHEMA_INVALID', `WorkItem ${id} rich source validation failed`, error)
  }
}

function assertWorkItemIdentityShape(value: WorkItem, id: string): void {
  if (!value || value.schemaVersion !== 1 || value.id !== id) {
    fail('RICH_SCHEMA_INVALID', `WorkItem ${id} rich source identity is invalid`)
  }
  if (typeof value.projectId !== 'string' || value.projectId.length === 0 ||
      typeof value.title !== 'string' || value.title.length === 0) {
    fail('RICH_SCHEMA_INVALID', `WorkItem ${id} rich source text identity is invalid`)
  }
}

function assertWorkItemStateShape(value: WorkItem, id: string): void {
  if (!isWorkItemStatus(value.status) || !isWorkItemType(value.type) || !positiveRevision(value.revision)) {
    fail('RICH_SCHEMA_INVALID', `WorkItem ${id} rich source state is invalid`)
  }
  if (!finiteTimestamp(value.createdAt) || !finiteTimestamp(value.updatedAt) || !Number.isFinite(value.priority) ||
      (value.boardOrder !== undefined && !Number.isFinite(value.boardOrder))) {
    fail('RICH_SCHEMA_INVALID', `WorkItem ${id} rich source revision metadata is invalid`)
  }
}

function goalContractFromFlattened(goal: Goal): GoalContract {
  return normalizeContract({
    objective: goal.objective,
    background: goal.background,
    constraints: goal.constraints,
    successCriteria: goal.successCriteria,
    budget: goal.budget,
    dueAt: goal.dueAt,
    riskLevel: goal.riskLevel,
    forbiddenActions: goal.forbiddenActions,
    acceptance: goal.acceptance
  })
}

function verifyAcceptanceSpecs(value: AcceptanceSpec[], label: string): void {
  const normalized = normalizeAcceptanceSpecs(value, `${label} Acceptance`)
  if (digest(normalized) !== digest(value)) {
    fail('RICH_SCHEMA_INVALID', `${label} Acceptance specs are not normalized`)
  }
}

function verifyAcceptanceResult(value: AcceptanceResult | undefined, label: string): void {
  const normalized = normalizeAcceptanceResult(value)
  if (digest(normalized) !== digest(value)) {
    fail('RICH_SCHEMA_INVALID', `${label} Acceptance result is not normalized`)
  }
}

function verifyOwner(value: WorkItemOwner | undefined, label: string): void {
  const normalized = normalizeOwner(value)
  if (digest(normalized) !== digest(value)) {
    fail('RICH_SCHEMA_INVALID', `${label} owner is not normalized`)
  }
}

function verifyLease(value: WorkItemLease | undefined, label: string): void {
  if (!value) return
  if (typeof value.id !== 'string' || value.id.length === 0 || typeof value.ownerId !== 'string' ||
      value.ownerId.length === 0 || !finiteTimestamp(value.acquiredAt) || !finiteTimestamp(value.expiresAt) ||
      !positiveRevision(value.fencingToken) || value.expiresAt <= value.acquiredAt) {
    fail('RICH_SCHEMA_INVALID', `${label} lease is invalid`)
  }
}

function verifyIdList(value: readonly string[], label: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0) ||
      new Set(value).size !== value.length) {
    fail('RICH_SCHEMA_INVALID', `${label} are invalid`)
  }
}

function uniqueDescriptors<T extends { id: string }>(values: readonly T[], label: string): T[] {
  const ids = new Set<string>()
  for (const value of values) {
    if (ids.has(value.id)) fail('MIGRATION_EVENT_INVALID', `duplicate ${label} descriptor ${value.id}`)
    ids.add(value.id)
  }
  return [...values]
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function positiveRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function fail(
  code: VerifiedCanonicalProjectWorkspaceViewErrorCode,
  message: string,
  cause?: unknown
): never {
  throw new VerifiedCanonicalProjectWorkspaceViewError(code, message, cause)
}
