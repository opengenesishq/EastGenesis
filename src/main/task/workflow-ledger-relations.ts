import type { TaskRunRecord, TaskRunStatus } from '../../shared/types'
import type {
  WorkflowAcceptanceRecord,
  WorkflowAcceptanceStatus,
  WorkflowArtifactRecord,
  WorkflowEvidenceLinkRecord,
  WorkflowProjectionContext,
  WorkflowRunRecord,
  WorkflowWorkItemProjectionInput,
  WorkflowWorkItemRecord,
  WorkflowWorkItemStatus,
  WorkflowWorkItemType
} from '../../shared/workflow-types'
import {
  digest,
  normalizeOptionalId
} from './workflow-ledger-codec'
import { isTaskRunRecord } from './task-run'
import { assertFrozenRoutingWrite } from './frozen-routing-policy'
import { selectTaskEvidence, type TaskEvidenceRecord } from './task-evidence-store'
import { assertWorkflowEvidenceLinkReferences } from './workflow-evidence-link-resolution'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import {
  findWorkflowAcceptance,
  findWorkflowArtifact,
  findWorkflowGoal,
  findWorkflowRun,
  findWorkflowWorkItem,
  readAcceptances,
  readEvidenceLinks,
  readWorkItems
} from './workflow-ledger-query'

export const WORK_ITEM_TRANSITIONS: Record<WorkflowWorkItemStatus, ReadonlySet<WorkflowWorkItemStatus>> = {
  backlog: new Set(['ready', 'running', 'blocked', 'verifying', 'failed', 'cancelled']),
  ready: new Set(['running', 'waiting_approval', 'blocked', 'verifying', 'failed', 'cancelled']),
  running: new Set(['waiting_approval', 'blocked', 'verifying', 'failed', 'cancelled']),
  waiting_approval: new Set(['running', 'blocked', 'failed', 'cancelled']),
  blocked: new Set(['ready', 'running', 'waiting_approval', 'verifying', 'failed', 'cancelled']),
  verifying: new Set(['running', 'waiting_approval', 'done', 'failed', 'blocked', 'cancelled']),
  done: new Set(),
  failed: new Set(['ready', 'running', 'blocked', 'verifying', 'cancelled']),
  cancelled: new Set()
}

export function assertGoalCompatibility(
  existing: { id: string; projectId?: string },
  incoming: { id: string; projectId?: string }
): void {
  if (existing.id !== incoming.id || existing.projectId !== incoming.projectId) {
    throw new WorkflowLedgerCorruptionError(`goal ${incoming.id} immutable ownership changed`)
  }
}

export function assertWorkItemCompatibility(
  existing: WorkflowWorkItemRecord,
  incoming: WorkflowWorkItemRecord
): void {
  if (
    existing.id !== incoming.id ||
    existing.projectId !== incoming.projectId ||
    existing.goalId !== incoming.goalId ||
    existing.parentId !== incoming.parentId || existing.businessLineId !== incoming.businessLineId
  ) {
    throw new WorkflowLedgerCorruptionError(`work item ${incoming.id} immutable ownership changed`)
  }
}

export function assertRunCompatibility(existing: WorkflowRunRecord, incoming: WorkflowRunRecord): void {
  assertFrozenRoutingWrite(existing.taskRun, incoming.taskRun)
  if (
    existing.id !== incoming.id ||
    existing.projectId !== incoming.projectId ||
    existing.goalId !== incoming.goalId ||
    existing.workItemId !== incoming.workItemId ||
    existing.sessionId !== incoming.sessionId ||
    existing.taskId !== incoming.taskId ||
    existing.acceptanceId !== incoming.acceptanceId ||
    existing.acceptanceRevision !== incoming.acceptanceRevision
  ) {
    throw new WorkflowLedgerCorruptionError(`run ${incoming.id} immutable ownership changed`)
  }
}

export function assertWorkItemReferences(db: WorkflowLedgerDatabase, item: WorkflowWorkItemRecord): void {
  assertGoalReference(db, item)
  assertParentReference(db, item)
  if (item.currentRunId && !item.runIds.includes(item.currentRunId)) {
    throw new WorkflowLedgerCorruptionError(`work item ${item.id} currentRunId is not in runIds`)
  }
}

export function assertArtifactReferences(db: WorkflowLedgerDatabase, artifact: WorkflowArtifactRecord): void {
  const refs = {
    goal: artifact.goalId ? findWorkflowGoal(db, artifact.goalId) : null,
    workItem: artifact.workItemId ? findWorkflowWorkItem(db, artifact.workItemId) : null,
    run: artifact.runId ? findWorkflowRun(db, artifact.runId) : null
  }
  assertArtifactReferencePresence(artifact, refs)
  assertArtifactOwnership(artifact, refs)
  assertArtifactHierarchy(artifact, refs)
  assertSupersedesReference(db, artifact)
}

export function assertAcceptanceReferences(db: WorkflowLedgerDatabase, acceptance: WorkflowAcceptanceRecord): void {
  const goal = acceptance.goalId ? findWorkflowGoal(db, acceptance.goalId) : null
  const workItem = acceptance.workItemId ? findWorkflowWorkItem(db, acceptance.workItemId) : null
  if (acceptance.goalId && !goal) {
    throw new WorkflowLedgerCorruptionError(`acceptance ${acceptance.id} references missing goal ${acceptance.goalId}`)
  }
  if (acceptance.workItemId && !workItem) {
    throw new WorkflowLedgerCorruptionError(`acceptance ${acceptance.id} references missing work item ${acceptance.workItemId}`)
  }
  if (goal && goal.projectId !== acceptance.projectId) {
    throw new WorkflowLedgerCorruptionError(`acceptance ${acceptance.id} crosses project boundary to goal`)
  }
  if (workItem) {
    if (workItem.projectId !== acceptance.projectId) {
      throw new WorkflowLedgerCorruptionError(`acceptance ${acceptance.id} crosses project boundary to work item`)
    }
    if (acceptance.goalId && workItem.goalId !== acceptance.goalId) {
      throw new WorkflowLedgerCorruptionError(`acceptance ${acceptance.id} goal/work item ownership differs`)
    }
  }
}

export function assertEvidenceLinkReferences(db: WorkflowLedgerDatabase, link: WorkflowEvidenceLinkRecord): void {
  if (link.evidenceOrigin === 'workflow') {
    assertWorkflowEvidenceLinkReferences(db, link)
    return
  }
  assertTaskEvidenceLinkReferences(db, link)
}

function assertTaskEvidenceLinkReferences(db: WorkflowLedgerDatabase, link: WorkflowEvidenceLinkRecord): void {
  const evidence = requireTaskEvidence(db, link)
  const artifact = link.artifactId ? findWorkflowArtifact(db, link.artifactId) : null
  const acceptance = link.acceptanceId ? findWorkflowAcceptance(db, link.acceptanceId) : null
  const run = link.runId ? findWorkflowRun(db, link.runId) : null
  if (link.artifactId && !artifact) {
    throw new WorkflowLedgerCorruptionError(`evidence link ${link.id} references missing artifact ${link.artifactId}`)
  }
  if (link.acceptanceId && !acceptance) {
    throw new WorkflowLedgerCorruptionError(`evidence link ${link.id} references missing acceptance ${link.acceptanceId}`)
  }
  if (link.runId && !run) {
    throw new WorkflowLedgerCorruptionError(`evidence link ${link.id} references missing run ${link.runId}`)
  }
  if (!run || link.runId !== evidence.runId) {
    throw new WorkflowLedgerCorruptionError(`evidence link ${link.id} run ownership differs from Task evidence`)
  }
  for (const owner of [artifact, acceptance, run]) {
    if (owner && owner.projectId !== link.projectId) {
      throw new WorkflowLedgerCorruptionError(`evidence link ${link.id} crosses project boundary`)
    }
  }
  assertTaskEvidenceRunOwnership(link, evidence, run)
  assertLinkedRecordRunOwnership(link, run, artifact, acceptance)
}

export function assertAcceptanceCompatibility(
  existing: WorkflowAcceptanceRecord,
  incoming: WorkflowAcceptanceRecord
): void {
  if (
    existing.id !== incoming.id ||
    existing.projectId !== incoming.projectId ||
    existing.goalId !== incoming.goalId ||
    existing.workItemId !== incoming.workItemId ||
    digest(existing.criteria) !== digest(incoming.criteria) ||
    digest(existing.criterionPolicies) !== digest(incoming.criterionPolicies)
  ) {
    throw new WorkflowLedgerCorruptionError(`acceptance ${incoming.id} immutable contract changed`)
  }
}

export function assertAcceptanceTransition(
  current: WorkflowAcceptanceStatus,
  next: WorkflowAcceptanceStatus
): void {
  const allowed: Record<WorkflowAcceptanceStatus, ReadonlySet<WorkflowAcceptanceStatus>> = {
    pending: new Set(['verifying', 'waived']),
    verifying: new Set(['passed', 'failed']),
    passed: new Set(),
    failed: new Set(['verifying']),
    waived: new Set()
  }
  if (current !== next && !allowed[current].has(next)) {
    throw new WorkflowLedgerCorruptionError(`acceptance transition ${current} -> ${next} is not allowed`)
  }
}

export function assertAcceptanceCanProject(
  db: WorkflowLedgerDatabase,
  acceptance: WorkflowAcceptanceRecord,
  existing: WorkflowAcceptanceRecord | null
): boolean {
  if (existing) {
    assertAcceptanceCompatibility(existing, acceptance)
    if (existing.revision > acceptance.revision) return false
    if (existing.revision === acceptance.revision) {
      if (digest(existing) === digest(acceptance)) return false
      throw new WorkflowLedgerCorruptionError(`acceptance ${acceptance.id} changed without revision increment`)
    }
    if (acceptance.revision !== existing.revision + 1) {
      throw new WorkflowLedgerCorruptionError(`acceptance ${acceptance.id} revision must increment by one`)
    }
    assertAcceptanceTransition(existing.status, acceptance.status)
  }
  assertAcceptanceState(db, acceptance)
  return true
}

export function hasSatisfiedAcceptance(db: WorkflowLedgerDatabase, workItemId: string): boolean {
  return readAcceptances(db).some((acceptance) =>
    acceptance.workItemId === workItemId &&
    (acceptance.status === 'passed' || acceptance.status === 'waived')
  )
}

export function hasEvidenceLink(db: WorkflowLedgerDatabase, acceptanceId: string, evidenceId: string): boolean {
  return readEvidenceLinks(db).some((link) =>
    link.acceptanceId === acceptanceId && link.evidenceId === evidenceId
  )
}

export function statusFromTaskRun(
  status: TaskRunStatus,
  db: WorkflowLedgerDatabase,
  workItemId: string
): WorkflowWorkItemStatus {
  const existing = findWorkflowWorkItem(db, workItemId)
  if (existing?.status === 'done' || existing?.status === 'cancelled') return existing.status
  const statuses: Partial<Record<TaskRunStatus, WorkflowWorkItemStatus>> = {
    queued: 'backlog',
    planning: 'ready',
    executing: 'running',
    waiting_approval: 'waiting_approval',
    waiting_reconciliation: 'blocked',
    recovering: 'blocked',
    verifying: 'verifying',
    failed: 'failed',
    cancelled: 'cancelled'
  }
  return statuses[status] ?? 'verifying'
}

export function inferWorkItemType(role: string | undefined, taskId: string): WorkflowWorkItemType {
  const value = `${role ?? ''} ${taskId}`.toLowerCase()
  const matches: Array<[string[], WorkflowWorkItemType]> = [
    [['research', '调研'], 'research'],
    [['plan', '策划'], 'planning'],
    [['review', '审查'], 'review'],
    [['test', '测试'], 'testing'],
    [['doc', '文档'], 'documentation'],
    [['design', '设计'], 'design'],
    [['write', '写'], 'writing'],
    [['code', '开发'], 'coding']
  ]
  return matches.find(([tokens]) => tokens.some((token) => value.includes(token)))?.[1] ?? 'custom'
}

export function deriveWorkItemId(run: TaskRunRecord, context: WorkflowProjectionContext = {}): string {
  const explicit = normalizeOptionalId(context.workItemId)
  if (explicit) return explicit
  const seed = `${normalizeOptionalId(context.projectId) ?? 'unscoped'}:${run.taskId}`
  return `work-item:legacy:${digest(seed).slice(0, 32)}`
}

export function mergeRunIds(existing: readonly string[], runId: string): string[] {
  return existing.includes(runId) ? [...existing] : [...existing, runId]
}

export interface TaskRunProjectionPlan {
  workItemId: string
  projectId?: string
  goalId?: string
  workItemChanged: boolean
  workItemInput?: WorkflowWorkItemProjectionInput
}

export function planTaskRunProjection(
  db: WorkflowLedgerDatabase,
  run: TaskRunRecord,
  context: WorkflowProjectionContext
): TaskRunProjectionPlan {
  if (!isTaskRunRecord(run)) {
    throw new WorkflowLedgerCorruptionError(`TaskRun ${String((run as { id?: unknown }).id)} schema validation failed`)
  }
  const existingRun = findWorkflowRun(db, run.id)
  const resolved = resolveTaskRunProjection(db, run, context, existingRun)
  const orphanRecoveryRun = selectOrphanRecoveryRun(existingRun, resolved.current, run)
  const stale = !orphanRecoveryRun &&
    (isStaleRun(db, resolved.current, run) || isStaleWorkflowRun(existingRun, run))
  const baseRevision = Math.max(resolved.current?.revision ?? 0, orphanRecoveryRun?.revision ?? run.revision)
  const draftResolved = orphanRecoveryRun
    ? { ...resolved, status: statusFromTaskRun(orphanRecoveryRun.status, db, resolved.workItemId) }
    : resolved
  const draft = buildWorkItemInput(draftResolved, context, orphanRecoveryRun ?? run, baseRevision)
  const changed = !resolved.current || workItemInputDiffers(resolved.current, draft)
  return buildTaskRunProjectionPlan(resolved, context, draft, baseRevision, stale, changed)
}

function buildTaskRunProjectionPlan(
  resolved: ResolvedTaskRunProjection,
  context: WorkflowProjectionContext,
  draft: WorkflowWorkItemProjectionInput,
  baseRevision: number,
  stale: boolean,
  changed: boolean
): TaskRunProjectionPlan {
  // A Workspace-owned explicit WorkItem is projected from the rich canonical
  // source. TaskRun persistence may add/update its Run, but must not mutate the
  // WorkItem row behind that source's revision/digest contract.
  const canonicalSourceOwnsWorkItem = context.canonicalSourceAuthority === true &&
    resolved.current?.source === 'explicit'
  const revision = resolved.current?.revision === baseRevision && changed
    ? baseRevision + 1
    : baseRevision
  return {
    workItemId: resolved.workItemId,
    projectId: resolved.projectId,
    goalId: resolved.goalId,
    workItemChanged: !canonicalSourceOwnsWorkItem && !stale && changed,
    ...(stale || canonicalSourceOwnsWorkItem ? {} : { workItemInput: { ...draft, revision } })
  }
}

function selectOrphanRecoveryRun(
  existingRun: WorkflowRunRecord | null,
  currentWorkItem: WorkflowWorkItemRecord | null,
  incomingRun: TaskRunRecord
): TaskRunRecord | null {
  if (!existingRun || currentWorkItem || existingRun.revision <= incomingRun.revision) return null
  return existingRun.taskRun
}

interface ResolvedTaskRunProjection {
  workItemId: string
  current: WorkflowWorkItemRecord | null
  source: WorkflowWorkItemRecord['source']
  projectId?: string
  goalId?: string
  status: WorkflowWorkItemStatus
}

function resolveTaskRunProjection(
  db: WorkflowLedgerDatabase,
  run: TaskRunRecord,
  context: WorkflowProjectionContext,
  existingRun: WorkflowRunRecord | null
): ResolvedTaskRunProjection {
  const claimedWorkItemId = normalizeOptionalId(context.workItemId)
  const explicitWorkItemId = context.source === 'explicit' ? claimedWorkItemId : undefined
  const orphanWorkItem = resolveOrphanProjectionWorkItem(db, run.id, existingRun, claimedWorkItemId)
  assertProjectionWorkItemOwnership(run.id, existingRun, claimedWorkItemId)
  const workItemId = selectProjectionWorkItemId(run, context, existingRun, orphanWorkItem, claimedWorkItemId)
  const current = findWorkflowWorkItem(db, workItemId)
  if (explicitWorkItemId && !current) {
    throw new WorkflowLedgerCorruptionError(
      `run ${run.id} references missing explicit work item ${explicitWorkItemId}`
    )
  }
  assertProjectionScope(run.id, context, existingRun, current)
  const source = resolveProjectionSource(context, current, explicitWorkItemId)
  const ownership = resolveProjectionOwnership(existingRun, context, current, orphanWorkItem)
  const status = statusFromTaskRun(run.status, db, workItemId)
  return {
    workItemId,
    current,
    source,
    ...ownership,
    status
  }
}

function resolveOrphanProjectionWorkItem(
  db: WorkflowLedgerDatabase,
  runId: string,
  existingRun: WorkflowRunRecord | null,
  explicitWorkItemId: string | undefined
): WorkflowWorkItemRecord | null {
  if (existingRun || explicitWorkItemId) return null
  return findOrphanWorkItemForRun(db, runId)
}

function assertProjectionWorkItemOwnership(
  runId: string,
  existingRun: WorkflowRunRecord | null,
  explicitWorkItemId: string | undefined
): void {
  if (existingRun && explicitWorkItemId && explicitWorkItemId !== existingRun.workItemId) {
    throw new WorkflowLedgerCorruptionError(
      `run ${runId} immutable work item ownership changed during projection`
    )
  }
}

function assertProjectionScope(
  runId: string,
  context: WorkflowProjectionContext,
  existingRun: WorkflowRunRecord | null,
  currentWorkItem: WorkflowWorkItemRecord | null
): void {
  const projectId = normalizeOptionalId(context.projectId)
  const goalId = normalizeOptionalId(context.goalId)
  if (goalId && !projectId) {
    throw new WorkflowLedgerCorruptionError(`run ${runId} Goal ownership is missing project/workspace scope`)
  }
  if (existingRun) {
    assertProjectionScopeClaim(runId, 'project/workspace', projectId, existingRun.projectId)
    assertProjectionScopeClaim(runId, 'goal', goalId, existingRun.goalId)
  }
  if (currentWorkItem) {
    assertProjectionScopeClaim(runId, 'project/workspace', projectId, currentWorkItem.projectId)
    assertProjectionScopeClaim(runId, 'goal', goalId, currentWorkItem.goalId)
  }
}

function assertProjectionScopeClaim(
  runId: string,
  label: string,
  incoming: string | undefined,
  persisted: string | undefined
): void {
  if (incoming !== undefined && incoming !== persisted) {
    throw new WorkflowLedgerCorruptionError(
      `run ${runId} ${label} scope differs from persisted WorkItem/Run ownership`
    )
  }
}

function selectProjectionWorkItemId(
  run: TaskRunRecord,
  context: WorkflowProjectionContext,
  existingRun: WorkflowRunRecord | null,
  orphanWorkItem: WorkflowWorkItemRecord | null,
  explicitWorkItemId: string | undefined
): string {
  return existingRun?.workItemId ?? orphanWorkItem?.id ?? explicitWorkItemId ?? deriveWorkItemId(run, context)
}

function resolveProjectionSource(
  context: WorkflowProjectionContext,
  current: WorkflowWorkItemRecord | null,
  explicitWorkItemId: string | undefined
): WorkflowWorkItemRecord['source'] {
  return context.source ?? current?.source ?? (explicitWorkItemId ? 'explicit' : 'legacy-derived')
}

function resolveProjectionOwnership(
  existingRun: WorkflowRunRecord | null,
  context: WorkflowProjectionContext,
  current: WorkflowWorkItemRecord | null,
  orphanWorkItem: WorkflowWorkItemRecord | null
): Pick<ResolvedTaskRunProjection, 'projectId' | 'goalId'> {
  if (existingRun) return { projectId: existingRun.projectId, goalId: existingRun.goalId }
  return {
    projectId: normalizeOptionalId(context.projectId) ?? current?.projectId ?? orphanWorkItem?.projectId,
    goalId: normalizeOptionalId(context.goalId) ?? current?.goalId ?? orphanWorkItem?.goalId
  }
}

function workItemInputDiffers(
  current: WorkflowWorkItemRecord,
  incoming: WorkflowWorkItemProjectionInput
): boolean {
  return digest(workItemComparable(current)) !== digest(workItemComparable(incoming))
}

function isStaleRun(
  db: WorkflowLedgerDatabase,
  current: WorkflowWorkItemRecord | null,
  run: TaskRunRecord
): boolean {
  if (!current) return false
  if (current.runIds.includes(run.id) && current.revision > run.revision) return true
  const currentRunId = current.currentRunId
  if (!currentRunId || currentRunId === run.id) return false
  const currentRun = findWorkflowRun(db, currentRunId)
  // A WorkItem pointing at an unavailable current Run is itself an unresolved
  // recovery state; an incoming historical Run must not silently take over.
  if (!currentRun) return true
  return compareRunFreshness(currentRun, run) > 0
}

function isStaleWorkflowRun(current: WorkflowRunRecord | null, run: TaskRunRecord): boolean {
  return Boolean(current && current.revision > run.revision)
}

function compareRunFreshness(current: WorkflowRunRecord, incoming: TaskRunRecord): number {
  // Revisions are local to one Run. A follow-up turn creates a new Run at
  // revision 1, so comparing revisions across IDs would incorrectly keep the
  // older Run as the WorkItem owner and omit the new Run from runIds.
  if (current.id !== incoming.id) {
    if (current.createdAt !== incoming.createdAt) return current.createdAt - incoming.createdAt
    if (current.updatedAt !== incoming.updatedAt) return current.updatedAt - incoming.updatedAt
    return current.id.localeCompare(incoming.id)
  }
  if (current.revision !== incoming.revision) return current.revision - incoming.revision
  if (current.attempt !== incoming.attempt) return current.attempt - incoming.attempt
  return current.updatedAt - incoming.updatedAt
}

function findOrphanWorkItemForRun(
  db: WorkflowLedgerDatabase,
  runId: string
): WorkflowWorkItemRecord | null {
  const matches = readWorkItems(db).filter((item) =>
    item.runIds.includes(runId) || item.currentRunId === runId
  )
  if (matches.length > 1) {
    throw new WorkflowLedgerCorruptionError(
      `run ${runId} is claimed by multiple orphan WorkItems`
    )
  }
  return matches[0] ?? null
}

function buildWorkItemInput(
  resolved: ResolvedTaskRunProjection,
  context: WorkflowProjectionContext,
  run: TaskRunRecord,
  revision: number
): WorkflowWorkItemProjectionInput {
  const current = resolved.current
  return {
    id: resolved.workItemId,
    projectId: resolved.projectId,
    goalId: resolved.goalId,
    parentId: context.parentWorkItemId ?? current?.parentId,
    type: context.workItemType ?? current?.type ?? inferWorkItemType(context.role, run.taskId),
    title: context.workItemTitle?.trim() || current?.title || `Work item ${run.taskId}`,
    description: context.workItemDescription ?? current?.description,
    role: context.role ?? current?.role,
    status: resolved.status,
    revision,
    source: resolved.source,
    runIds: mergeRunIds(current?.runIds ?? [], run.id),
    currentRunId: run.id,
    createdAt: current?.createdAt ?? run.createdAt,
    updatedAt: run.updatedAt,
    dueAt: current?.dueAt
  }
}

function workItemComparable(
  item: WorkflowWorkItemRecord | WorkflowWorkItemProjectionInput
): Record<string, unknown> {
  return {
    id: item.id,
    projectId: item.projectId,
    goalId: item.goalId,
    parentId: item.parentId,
    type: item.type,
    title: item.title,
    description: item.description,
    role: item.role,
    status: item.status,
    source: item.source,
    runIds: item.runIds,
    currentRunId: item.currentRunId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    dueAt: item.dueAt
  }
}

export function buildWorkflowRun(
  db: WorkflowLedgerDatabase,
  run: TaskRunRecord,
  workItemId: string,
  projectId?: string,
  goalId?: string,
  existing?: WorkflowRunRecord | null
): WorkflowRunRecord {
  const acceptanceBinding = existing
    ? runAcceptanceBinding(existing)
    : selectActiveRunAcceptanceBinding(db, workItemId, projectId, goalId)
  return {
    schemaVersion: 1,
    id: run.id,
    projectId,
    goalId,
    workItemId,
    sessionId: run.sessionId,
    taskId: run.taskId,
    ...acceptanceBinding,
    status: run.status,
    revision: run.revision,
    attempt: run.attempt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    taskRun: run
  }
}

function runAcceptanceBinding(
  run: WorkflowRunRecord
): Pick<WorkflowRunRecord, 'acceptanceId' | 'acceptanceRevision'> {
  return run.acceptanceId === undefined
    ? {}
    : { acceptanceId: run.acceptanceId, acceptanceRevision: run.acceptanceRevision }
}

function selectActiveRunAcceptanceBinding(
  db: WorkflowLedgerDatabase,
  workItemId: string,
  projectId: string | undefined,
  goalId: string | undefined
): Pick<WorkflowRunRecord, 'acceptanceId' | 'acceptanceRevision'> {
  const active = readAcceptances(db).filter((acceptance) =>
    acceptance.projectId === projectId &&
    acceptance.goalId === goalId &&
    acceptance.workItemId === workItemId &&
    (acceptance.status === 'pending' || acceptance.status === 'verifying')
  )
  return active.length === 1
    ? { acceptanceId: active[0].id, acceptanceRevision: active[0].revision }
    : {}
}

function assertGoalReference(db: WorkflowLedgerDatabase, item: WorkflowWorkItemRecord): void {
  if (!item.goalId) return
  const goal = findWorkflowGoal(db, item.goalId)
  if (!goal) throw new WorkflowLedgerCorruptionError(`work item ${item.id} references missing goal ${item.goalId}`)
  if (goal.projectId !== item.projectId) {
    throw new WorkflowLedgerCorruptionError(`work item ${item.id} crosses project boundary to goal ${item.goalId}`)
  }
}

function assertParentReference(db: WorkflowLedgerDatabase, item: WorkflowWorkItemRecord): void {
  if (!item.parentId) return
  const parent = findWorkflowWorkItem(db, item.parentId)
  if (!parent) throw new WorkflowLedgerCorruptionError(`work item ${item.id} references missing parent ${item.parentId}`)
  if (parent.projectId !== item.projectId) {
    throw new WorkflowLedgerCorruptionError(`work item ${item.id} crosses project boundary to parent ${item.parentId}`)
  }
}

type ArtifactRefs = {
  goal: { projectId?: string } | null
  workItem: WorkflowWorkItemRecord | null
  run: WorkflowRunRecord | null
}

function assertArtifactReferencePresence(artifact: WorkflowArtifactRecord, refs: ArtifactRefs): void {
  if (artifact.goalId && !refs.goal) throw new WorkflowLedgerCorruptionError(`artifact ${artifact.id} references missing goal ${artifact.goalId}`)
  if (artifact.workItemId && !refs.workItem) throw new WorkflowLedgerCorruptionError(`artifact ${artifact.id} references missing work item ${artifact.workItemId}`)
  if (artifact.runId && !refs.run) throw new WorkflowLedgerCorruptionError(`artifact ${artifact.id} references missing run ${artifact.runId}`)
}

function assertArtifactOwnership(artifact: WorkflowArtifactRecord, refs: ArtifactRefs): void {
  for (const owner of [refs.goal, refs.workItem, refs.run]) {
    if (owner && owner.projectId !== artifact.projectId) {
      throw new WorkflowLedgerCorruptionError(`artifact ${artifact.id} crosses project boundary`)
    }
  }
}

function assertArtifactHierarchy(artifact: WorkflowArtifactRecord, refs: ArtifactRefs): void {
  if (refs.workItem && artifact.goalId && refs.workItem.goalId !== artifact.goalId) {
    throw new WorkflowLedgerCorruptionError(`artifact ${artifact.id} goal/work item ownership differs`)
  }
  if (refs.run && artifact.workItemId && refs.run.workItemId !== artifact.workItemId) {
    throw new WorkflowLedgerCorruptionError(`artifact ${artifact.id} run/work item ownership differs`)
  }
}

function assertSupersedesReference(db: WorkflowLedgerDatabase, artifact: WorkflowArtifactRecord): void {
  if (!artifact.supersedesId) return
  const previous = findWorkflowArtifact(db, artifact.supersedesId)
  if (!previous) throw new WorkflowLedgerCorruptionError(`artifact ${artifact.id} supersedes missing artifact ${artifact.supersedesId}`)
  if (previous.projectId !== artifact.projectId || previous.kind !== artifact.kind || artifact.version <= previous.version) {
    throw new WorkflowLedgerCorruptionError(`artifact ${artifact.id} supersedes incompatible artifact ${artifact.supersedesId}`)
  }
}

function requireTaskEvidence(
  db: WorkflowLedgerDatabase,
  link: WorkflowEvidenceLinkRecord
): TaskEvidenceRecord {
  try {
    const evidence = selectTaskEvidence(db).find((record) => record.evidenceId === link.evidenceId)
    if (!evidence) {
      throw new WorkflowLedgerCorruptionError(
        `evidence link ${link.id} references missing Task evidence ${link.evidenceId}`
      )
    }
    return evidence
  } catch (error) {
    if (error instanceof WorkflowLedgerCorruptionError) throw error
    throw new WorkflowLedgerCorruptionError('task_evidence schema is unavailable')
  }
}

function assertTaskEvidenceRunOwnership(
  link: WorkflowEvidenceLinkRecord,
  evidence: TaskEvidenceRecord,
  run: WorkflowRunRecord
): void {
  const evidenceProjectId = evidence.projectId ?? run.projectId
  if (link.projectId !== evidenceProjectId ||
      (evidence.projectId !== undefined && evidence.projectId !== run.projectId)) {
    throw new WorkflowLedgerCorruptionError(
      `evidence link ${link.id} project ownership differs from Task evidence Run`
    )
  }
  if (evidence.sessionId !== run.sessionId || evidence.taskId !== run.taskId) {
    throw new WorkflowLedgerCorruptionError(
      `evidence link ${link.id} session/task ownership differs from Task evidence Run`
    )
  }
}

function assertLinkedRecordRunOwnership(
  link: WorkflowEvidenceLinkRecord,
  run: WorkflowRunRecord,
  artifact: WorkflowArtifactRecord | null,
  acceptance: WorkflowAcceptanceRecord | null
): void {
  if (artifact) {
    assertOptionalRunScope(link.id, 'artifact', artifact, run)
  }
  if (acceptance) {
    assertOptionalRunScope(link.id, 'acceptance', acceptance, run)
  }
  if (artifact && acceptance) {
    assertLinkedScopeAgreement(link.id, artifact, acceptance)
  }
}

function assertOptionalRunScope(
  linkId: string,
  label: string,
  record: { goalId?: string; workItemId?: string; runId?: string },
  run: WorkflowRunRecord
): void {
  if (record.runId !== undefined && record.runId !== run.id) {
    throw new WorkflowLedgerCorruptionError(`evidence link ${linkId} ${label}/run ownership differs`)
  }
  if (record.workItemId !== undefined && record.workItemId !== run.workItemId) {
    throw new WorkflowLedgerCorruptionError(`evidence link ${linkId} ${label}/work item ownership differs`)
  }
  if (record.goalId !== undefined && record.goalId !== run.goalId) {
    throw new WorkflowLedgerCorruptionError(`evidence link ${linkId} ${label}/goal ownership differs`)
  }
}

function assertLinkedScopeAgreement(
  linkId: string,
  artifact: WorkflowArtifactRecord,
  acceptance: WorkflowAcceptanceRecord
): void {
  for (const field of ['goalId', 'workItemId'] as const) {
    if (artifact[field] !== undefined && acceptance[field] !== undefined && artifact[field] !== acceptance[field]) {
      throw new WorkflowLedgerCorruptionError(`evidence link ${linkId} linked ${field} ownership differs`)
    }
  }
}

export function assertAcceptanceState(db: WorkflowLedgerDatabase, acceptance: WorkflowAcceptanceRecord): void {
  if (acceptance.status === 'passed') {
    if (acceptance.evidenceRefs.length === 0) {
      throw new WorkflowLedgerCorruptionError(`acceptance ${acceptance.id} cannot pass without evidence`)
    }
    for (const evidenceId of acceptance.evidenceRefs) {
      if (!hasEvidenceLink(db, acceptance.id, evidenceId)) {
        throw new WorkflowLedgerCorruptionError(`acceptance ${acceptance.id} is missing evidence link ${evidenceId}`)
      }
    }
  }
  if (acceptance.status === 'waived' && (!acceptance.waiverReason || !acceptance.waivedBy)) {
    throw new WorkflowLedgerCorruptionError(`acceptance ${acceptance.id} waiver requires reason and actor`)
  }
}
