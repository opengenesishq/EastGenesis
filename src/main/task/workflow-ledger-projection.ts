import type { TaskRunRecord, TaskSnapshotRecord } from '../../shared/types'
import type { WorkflowProjectionContext, WorkflowRunRecord } from '../../shared/workflow-types'
import { taskSnapshotTaskIdMatchesRun } from './task-snapshot-identity'
import { selectTaskEvidence } from './task-evidence-store'
import {
  findWorkflowRun,
  findWorkflowWorkItem,
  projectTaskRun,
  appendWorkflowEvent,
  WorkflowLedgerCorruptionError,
  type WorkflowLedgerDatabase
} from './workflow-ledger-store'
import { readAndVerifyEvents } from './workflow-ledger-query'
import { projectWorkspaceAuthorityOwnsWorkItem } from '../project-workspace/ledger-import-authority'
import { captureRunRequirements } from './run-requirement-snapshot'

export function workflowContextForSnapshot(snapshot: TaskSnapshotRecord): WorkflowProjectionContext {
  const meta = snapshot.meta
  const workspaceId = optionalScopeId(meta.workspaceId, 'Snapshot workspaceId')
  const goalId = optionalScopeId(meta.goalId, 'Snapshot goalId')
  const explicitWorkItemId = optionalScopeId(meta.workItemId, 'Snapshot workItemId')
  if ((goalId || explicitWorkItemId) && !workspaceId) {
    throw new WorkflowLedgerCorruptionError(
      `session ${snapshot.sessionId} canonical Goal/WorkItem ownership is missing workspaceId`
    )
  }
  if (workspaceId && !explicitWorkItemId) {
    throw new WorkflowLedgerCorruptionError(
      `session ${snapshot.sessionId} workspace-bound Run is missing canonical workItemId`
    )
  }
  const derivedWorkItemId = meta.orchestrationId && meta.childTaskId
    ? `work-item:dag:${meta.orchestrationId}:${meta.childTaskId}`
    : undefined
  return {
    projectId: workspaceId ?? optionalScopeId(meta.projectId, 'Snapshot legacy projectId'),
    goalId,
    workItemId: explicitWorkItemId ?? derivedWorkItemId,
    workItemTitle: snapshot.title,
    role: meta.childRole,
    source: explicitWorkItemId ? 'explicit' : meta.childTaskId ? 'dag' : 'legacy-derived'
  }
}

export function projectRunIntoWorkflow(
  db: WorkflowLedgerDatabase,
  run: TaskRunRecord,
  context: WorkflowProjectionContext
): void {
  const requirements = findWorkflowRun(db, run.id) ? undefined : captureRunRequirements(db, run, context)
  projectTaskRun(db, run, context)
  if (requirements) appendWorkflowEvent(db, { eventId: `workflow:run:${run.id}:requirements`,
    streamId: `run:${run.id}`, entityType: 'run', entityId: run.id, kind: 'workflow.run.requirements.captured',
    payload: requirements, occurredAt: run.createdAt }, { projectId: context.projectId, goalId: context.goalId,
    workItemId: context.workItemId, runId: run.id, sessionId: run.sessionId })
}

export function resolveRunWorkflowProjectionContext(
  db: WorkflowLedgerDatabase,
  run: TaskRunRecord,
  projectId?: string,
  snapshot?: TaskSnapshotRecord
): WorkflowProjectionContext {
  const priorProjection = findWorkflowRun(db, run.id)
  return priorProjection
    ? contextFromPriorProjection(db, run, priorProjection, projectId, snapshot)
    : contextFromSnapshot(db, run, projectId, snapshot)
}

function contextFromPriorProjection(
  db: WorkflowLedgerDatabase,
  run: TaskRunRecord,
  priorProjection: WorkflowRunRecord,
  projectId?: string,
  snapshot?: TaskSnapshotRecord
): WorkflowProjectionContext {
  assertSnapshotOwnership(run, snapshot)
  const snapshotContext = snapshot ? workflowContextForSnapshot(snapshot) : {}
  assertProvidedProjectOwnership(
    run.id, priorProjection.projectId, projectClaimForSnapshot(run.id, projectId, snapshot), 'project'
  )
  assertProvidedProjectOwnership(
    run.id, priorProjection.projectId, snapshotContext.projectId, 'Snapshot project'
  )
  assertProvidedProjectOwnership(
    run.id, priorProjection.projectId, operationProjectId(run, snapshot), 'operation project'
  )
  if (snapshotContext.goalId && snapshotContext.goalId !== priorProjection.goalId) {
    throw new WorkflowLedgerCorruptionError(`run ${run.id} Snapshot goal ownership differs from WorkflowRun`)
  }
  if (snapshotContext.workItemId && snapshotContext.workItemId !== priorProjection.workItemId) {
    throw new WorkflowLedgerCorruptionError(`run ${run.id} Snapshot work item ownership differs from WorkflowRun`)
  }
  const priorWorkItem = findWorkflowWorkItem(db, priorProjection.workItemId)
  return {
    ...snapshotContext,
    projectId: priorProjection.projectId,
    goalId: priorProjection.goalId,
    workItemId: priorProjection.workItemId,
    parentWorkItemId: priorWorkItem?.parentId,
    source: priorWorkItem?.source ?? snapshotContext.source ?? 'recovery',
    canonicalSourceAuthority: canonicalProjectWorkspaceOwnsWorkItem(
      db,
      priorProjection.projectId,
      priorProjection.workItemId
    )
  }
}

function contextFromSnapshot(
  db: WorkflowLedgerDatabase,
  run: TaskRunRecord,
  projectId?: string,
  snapshot?: TaskSnapshotRecord
): WorkflowProjectionContext {
  if (!snapshot) {
    const operationProject = operationProjectId(run)
    if (!operationProject) {
      throw new WorkflowLedgerCorruptionError(
        `run ${run.id} Workflow ownership cannot be proven without a Snapshot or prior WorkflowRun`
      )
    }
    return {
      projectId: resolveProjectClaims(run.id, [
        { label: 'project', projectId: projectClaimForSnapshot(run.id, projectId, snapshot) },
        { label: 'operation project', projectId: operationProject }
      ]),
      source: 'recovery'
    }
  }
  assertSnapshotOwnership(run, snapshot)
  const snapshotContext = workflowContextForSnapshot(snapshot)
  const resolvedProjectId = resolveProjectClaims(run.id, [
    { label: 'project', projectId: projectClaimForSnapshot(run.id, projectId, snapshot) },
    { label: 'Snapshot project', projectId: snapshotContext.projectId },
    { label: 'operation project', projectId: operationProjectId(run, snapshot) }
  ])
  return {
    ...snapshotContext,
    projectId: resolvedProjectId,
    canonicalSourceAuthority: canonicalProjectWorkspaceOwnsWorkItem(
      db,
      resolvedProjectId,
      snapshotContext.workItemId
    )
  }
}

function canonicalProjectWorkspaceOwnsWorkItem(
  db: WorkflowLedgerDatabase,
  projectId: string | undefined,
  workItemId: string | undefined
): boolean {
  if (!projectId || !workItemId) return false
  return readAndVerifyEvents(db).some((event) =>
    projectWorkspaceAuthorityOwnsWorkItem(event, projectId, workItemId)
  )
}

interface ProjectClaim {
  label: string
  projectId?: string
}

function resolveProjectClaims(runId: string, claims: readonly ProjectClaim[]): string | undefined {
  let resolved: ProjectClaim | undefined
  for (const claim of claims) {
    const projectId = normalizedProjectId(runId, claim)
    if (projectId === undefined) continue
    if (resolved?.projectId !== undefined && resolved.projectId !== projectId) {
      throw new WorkflowLedgerCorruptionError(
        `run ${runId} ${claim.label} ownership differs from ${resolved.label}`
      )
    }
    resolved = { ...claim, projectId }
  }
  return resolved?.projectId
}

function operationProjectId(
  run: TaskRunRecord,
  snapshot?: TaskSnapshotRecord
): string | undefined {
  const projectId = normalizedProjectId(run.id, {
    label: 'operation project',
    projectId: run.operation?.projectId
  })
  return legacyProjectClaimForWorkspace(projectId, snapshot)
}

function projectClaimForSnapshot(
  runId: string,
  projectId: string | undefined,
  snapshot: TaskSnapshotRecord | undefined
): string | undefined {
  const normalized = normalizedProjectId(runId, { label: 'project', projectId })
  return legacyProjectClaimForWorkspace(normalized, snapshot)
}

function legacyProjectClaimForWorkspace(
  projectId: string | undefined,
  snapshot: TaskSnapshotRecord | undefined
): string | undefined {
  if (!snapshot?.meta.workspaceId || projectId === undefined) return projectId
  const legacyProjectId = optionalScopeId(snapshot.meta.projectId, 'Snapshot legacy projectId')
  return projectId === legacyProjectId ? undefined : projectId
}

function optionalScopeId(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (!normalized || /[\0-\x1f\x7f]/.test(value)) {
    throw new WorkflowLedgerCorruptionError(`${label} is empty or invalid`)
  }
  return normalized
}

function normalizedProjectId(runId: string, claim: ProjectClaim): string | undefined {
  if (claim.projectId === undefined) return undefined
  const projectId = claim.projectId.trim()
  if (projectId) return projectId
  throw new WorkflowLedgerCorruptionError(`run ${runId} ${claim.label} ownership is empty`)
}

function assertProvidedProjectOwnership(
  runId: string,
  ownedProjectId: string | undefined,
  providedProjectId: string | undefined,
  label: string
): void {
  if (providedProjectId !== undefined && ownedProjectId !== providedProjectId) {
    throw new WorkflowLedgerCorruptionError(`run ${runId} ${label} ownership differs from WorkflowRun`)
  }
}

function assertSnapshotOwnership(run: TaskRunRecord, snapshot: TaskSnapshotRecord | undefined): void {
  if (!snapshot) return
  if (
    snapshot.sessionId !== run.sessionId ||
    !taskSnapshotTaskIdMatchesRun(snapshot.taskId, run) ||
    (snapshot.run && (
      snapshot.run.id !== run.id ||
      !taskSnapshotTaskIdMatchesRun(snapshot.taskId, snapshot.run)
    ))
  ) {
    throw new WorkflowLedgerCorruptionError(`run ${run.id} ownership differs from Snapshot`)
  }
}

export function backfillWorkflowLedger(
  db: WorkflowLedgerDatabase,
  runs: readonly TaskRunRecord[],
  snapshots: readonly TaskSnapshotRecord[]
): boolean {
  const snapshotBySession = new Map(snapshots.map((snapshot) => [snapshot.sessionId, snapshot]))
  const runCountBySession = new Map<string, number>()
  for (const run of runs) {
    runCountBySession.set(run.sessionId, (runCountBySession.get(run.sessionId) ?? 0) + 1)
  }
  const evidenceProjectByRun = taskEvidenceProjectBindings(db)
  let changed = false
  for (const run of runs) {
    const sessionSnapshot = snapshotBySession.get(run.sessionId)
    const snapshot = matchingSnapshotForRun(
      run,
      sessionSnapshot,
      runCountBySession.get(run.sessionId) ?? 0
    )
    const priorProjection = findWorkflowRun(db, run.id)
    const evidenceProjectId = evidenceProjectByRun.get(run.id)
    const context = priorProjection
      ? contextFromPriorProjection(db, run, priorProjection, evidenceProjectId, snapshot)
      : snapshot
        ? contextFromSnapshot(db, run, evidenceProjectId, snapshot)
        : contextFromSessionSnapshot(run, evidenceProjectId, sessionSnapshot) ??
          recoveryContextForRun(run, evidenceProjectId)
    changed = projectTaskRun(db, run, context) || changed
  }
  return changed
}

function matchingSnapshotForRun(
  run: TaskRunRecord,
  snapshot: TaskSnapshotRecord | undefined,
  sessionRunCount: number
): TaskSnapshotRecord | undefined {
  if (!snapshot) return undefined
  if (snapshot.run) return snapshot.run.id === run.id ? snapshot : undefined
  return sessionRunCount === 1 && snapshot.taskId === run.taskId ? snapshot : undefined
}

function contextFromSessionSnapshot(
  run: TaskRunRecord,
  evidenceProjectId: string | undefined,
  snapshot: TaskSnapshotRecord | undefined
): WorkflowProjectionContext | undefined {
  if (!snapshot || snapshot.sessionId !== run.sessionId ||
      !taskSnapshotTaskIdMatchesRun(snapshot.taskId, run)) {
    return undefined
  }
  const snapshotContext = workflowContextForSnapshot(snapshot)
  return {
    ...snapshotContext,
    projectId: resolveProjectClaims(run.id, [
      { label: 'Snapshot project', projectId: snapshotContext.projectId },
      { label: 'Task evidence project', projectId: evidenceProjectId },
      { label: 'operation project', projectId: operationProjectId(run, snapshot) }
    ])
  }
}

function recoveryContextForRun(
  run: TaskRunRecord,
  evidenceProjectId: string | undefined
): WorkflowProjectionContext {
  return {
    projectId: resolveProjectClaims(run.id, [
      { label: 'Task evidence project', projectId: evidenceProjectId },
      { label: 'operation project', projectId: operationProjectId(run) }
    ]),
    source: 'recovery'
  }
}

function taskEvidenceProjectBindings(db: WorkflowLedgerDatabase): Map<string, string> {
  const bindings = new Map<string, string>()
  for (const evidence of selectTaskEvidence(db)) {
    if (!evidence.projectId) continue
    const prior = bindings.get(evidence.runId)
    if (prior && prior !== evidence.projectId) {
      throw new WorkflowLedgerCorruptionError(
        `run ${evidence.runId} has conflicting Task evidence project ownership`
      )
    }
    bindings.set(evidence.runId, evidence.projectId)
  }
  return bindings
}
