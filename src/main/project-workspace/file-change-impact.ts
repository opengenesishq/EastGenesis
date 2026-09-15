import type { Goal, ProjectWorkspaceState, WorkItem } from '../../shared/project-workspace-types'
import type { StudioResultFileCheck } from '../../shared/studio-result-file-change-types'
import type { WorkflowChangeImpactPlan } from '../task/workflow-change-impact'
import { buildWorkflowChangeImpactPlan } from '../task/workflow-change-impact'
import { digest } from '../task/workflow-ledger-codec'
import type { WorkflowLedgerDatabase } from '../task/workflow-ledger-db'
import { readAcceptances, readArtifacts, readEvidenceLinks, findEventById } from '../task/workflow-ledger-query'
import { appendWorkflowEvent, verifyWorkflowLedger } from '../task/workflow-ledger-store'
import { verifyWorkflowEvidence } from '../task/workflow-evidence-store'
import { assertAcceptanceEvidenceRefs } from '../task/workflow-acceptance-guard'
import { readArtifactEdges, verifyWorkflowArtifactGraphStructure } from '../task/workflow-ledger-artifact-graph-query'
import { commitWorkflowChangeImpactPlanInDatabase } from '../task/workflow-ledger-api'
import { appendEvent, ProjectWorkspacePersistence } from './persistence'
import { assertProjectAuthorized, projectMutationActor } from './project-authorization'
import { readVerifiedCanonicalProjectWorkspaceViewFromDatabase } from './ledger-canonical-view'
import { readWorkflowFileChangeRepairDatabase } from '../task/workflow-file-change-reader'
import { verifyWorkflowArtifactGraph } from '../task/workflow-ledger-artifact-graph-query'
import type { ProjectWorkspaceCanonicalWriteOptions } from './canonical-write'

/** Serialized inside the existing canonical-write journal, including recovery. */
export interface ProjectWorkspaceFileChangeImpact {
  projectId: string
  plan: WorkflowChangeImpactPlan
  now: number
  fileCheck?: { fingerprint: string; sessionId: string; result: StudioResultFileCheck }
}

export interface ProjectWorkspaceFileChangeReopenResult {
  reopenedWorkItemIds: string[]
  reopenedGoalIds: string[]
}

/** Dedicated system operation. It never starts a Run or changes the normal transition tables. */
export async function commitProjectWorkspaceFileChangeImpact(
  input: Omit<ProjectWorkspaceFileChangeImpact, 'now'> & { rootDir?: string; now?: number },
  options: Pick<ProjectWorkspaceCanonicalWriteOptions, 'faultAt' | 'onFault'> = {}
): Promise<ProjectWorkspaceFileChangeReopenResult> {
  const impact: ProjectWorkspaceFileChangeImpact = structuredClone({
    projectId: input.projectId, plan: input.plan, now: input.now ?? Date.now(), fileCheck: input.fileCheck
  })
  assertFileChangeImpactEnvelope(impact)
  const persistence = new ProjectWorkspacePersistence(input.rootDir)
  await persistence.open()
  const { createProjectWorkspaceCanonicalWriteBoundary } = await import('./canonical-write')
  const boundary = createProjectWorkspaceCanonicalWriteBoundary(persistence.rootDir, options)
  // Finish a prior canonical commit before taking the source revision fence.
  await boundary.reconcile()
  const replayed = await readWorkflowFileChangeRepairDatabase(persistence.rootDir, db => {
    if (!findEventById(db, `workflow:change-impact:${impact.plan.planDigest}`)) return false
    commitWorkflowChangeImpactPlanInDatabase(db, impact.plan, impact.now)
    assertFileCheckReplay(db, impact)
    verifyWorkflowArtifactGraph(db)
    return true
  })
  if (replayed) return { reopenedWorkItemIds: [], reopenedGoalIds: [] }
  const before = await persistence.read()
  const affectedIds = affectedWorkItemIds(impact.plan)
  const anchor = before.workItems.find(item => item.projectId === impact.projectId && affectedIds.has(item.id))
  if (!anchor) throw new Error('STUDIO_FILE_CHECK_SCOPE: file change has no canonical WorkItem')
  let result: ProjectWorkspaceFileChangeReopenResult = { reopenedWorkItemIds: [], reopenedGoalIds: [] }
  await boundary.execute({
    command: 'work_item.reopen_for_file_change', entityType: 'work_item', entityId: anchor.id,
    workspaceId: impact.projectId, fileChangeImpact: impact
  }, hook => persistence.withBeforeCommit(hook, () => persistence.mutate({ expectedStoreRevision: before.revision }, ({ state }) => {
    const project = state.workspaces.find(candidate => candidate.id === impact.projectId)
    if (!project) throw new Error('STUDIO_FILE_CHECK_SCOPE: Project no longer exists')
    assertProjectAuthorized(state, project, projectMutationActor(), 'edit')
    result = reopenFileChangeEntities(state, impact)
    return state.workItems.find(item => item.id === anchor.id)!
  })))
  return result
}

export function assertFileChangeImpactEnvelope(impact: ProjectWorkspaceFileChangeImpact): void {
  const { planDigest, ...unsignedPlan } = impact.plan
  if (!impact.projectId || impact.plan.projectId !== impact.projectId || !Number.isFinite(impact.now) ||
      impact.plan.contract !== 'workflow-change-impact-v1' || impact.plan.schemaVersion !== 1 ||
      digest(unsignedPlan) !== planDigest || impact.plan.changedArtifactIds.length === 0) {
    throw new Error('STUDIO_FILE_CHECK_PLAN: invalid canonical change impact')
  }
  if (impact.fileCheck && (!impact.fileCheck.fingerprint || !impact.fileCheck.sessionId ||
      impact.fileCheck.result.planDigest !== planDigest ||
      digest([...impact.fileCheck.result.changedArtifactIds].sort()) !== digest([...impact.plan.changedArtifactIds].sort()) ||
      digest(impact.fileCheck.result.acceptanceIds) !== digest(impact.plan.acceptanceRechecks.map(item => item.acceptanceId)))) {
    throw new Error('STUDIO_FILE_CHECK_PLAN: file check differs from its change impact')
  }
}

/** Recheck the durable plan against the DB while the shared task write barrier is held. */
export function validateProjectWorkspaceFileChangeImpact(
  db: WorkflowLedgerDatabase,
  impact: ProjectWorkspaceFileChangeImpact,
  desired: ProjectWorkspaceState
): void {
  assertFileChangeImpactEnvelope(impact)
  verifyWorkflowArtifactGraphStructure(db)
  verifyWorkflowEvidence(db)
  verifyWorkflowLedger(db, { deferFileReadsForArtifactIds: new Set(impact.plan.changedArtifactIds) })
  const acceptances = readAcceptances(db).filter(item => item.projectId === impact.projectId)
  for (const acceptance of acceptances) {
    assertAcceptanceEvidenceRefs(db, acceptance, new Set(impact.plan.changedArtifactIds))
  }
  const existing = findEventById(db, `workflow:change-impact:${impact.plan.planDigest}`)
  if (existing) {
    // Recovery after the candidate rename must prove the exact committed plan.
    commitWorkflowChangeImpactPlanInDatabase(db, impact.plan, impact.now)
    assertFileCheckReplay(db, impact)
    return
  }
  const actual = buildWorkflowChangeImpactPlan({
    projectId: impact.projectId,
    changedArtifactIds: impact.plan.changedArtifactIds,
    manuallyModifiedArtifactIds: impact.plan.changedArtifactIds,
    artifacts: readArtifacts(db).filter(item => item.projectId === impact.projectId),
    acceptances,
    edges: readArtifactEdges(db).filter(item => item.projectId === impact.projectId),
    evidenceLinks: readEvidenceLinks(db).filter(item => item.projectId === impact.projectId)
  })
  if (digest(actual) !== digest(impact.plan)) throw new Error('STUDIO_FILE_CHECK_STALE: change impact changed before commit')
  const current = readVerifiedCanonicalProjectWorkspaceViewFromDatabase(db, impact.projectId)
  // Reconstruct the only permitted source changes from the verified canonical
  // rich entities. No arbitrary done->verifying write enters this boundary.
  const expected = structuredClone({ workItems: current.workItems, goals: current.goals, events: [] })
  reopenFileChangeEntities(expected, impact)
  for (const kind of ['workItems', 'goals'] as const) {
    const actualEntities = desired[kind].filter(item => item.projectId === impact.projectId)
    if (digest(actualEntities) !== digest(expected[kind])) {
      throw new Error(`STUDIO_FILE_CHECK_STALE: canonical ${kind} changed before commit`)
    }
  }
}

/** Runs after the reopened projection and before full verification/export. */
export function commitProjectWorkspaceFileChangeImpactInDatabase(
  db: WorkflowLedgerDatabase,
  impact: ProjectWorkspaceFileChangeImpact
): void {
  const committed = commitWorkflowChangeImpactPlanInDatabase(db, impact.plan, impact.now)
  if (!impact.fileCheck) return
  const { fingerprint, result, sessionId } = impact.fileCheck
  appendWorkflowEvent(db, {
    eventId: fileCheckEventId(impact), streamId: `project:${impact.projectId}`,
    entityType: 'system', entityId: impact.projectId,
    kind: 'workflow.studio.result.files.checked', occurredAt: impact.now, correlationId: sessionId,
    payload: { fingerprint, result, acceptancesAfter: committed.acceptances.map(({ id, revision, status }) => ({ id, revision, status })) }
  }, { projectId: impact.projectId })
}

function affectedWorkItemIds(plan: WorkflowChangeImpactPlan): Set<string> {
  return new Set([...plan.impactedWorkItemIds, ...plan.acceptanceRechecks.flatMap(item => item.workItemId ? [item.workItemId] : [])])
}

function reopenFileChangeEntities(
  state: Pick<ProjectWorkspaceState, 'workItems' | 'goals' | 'events'>,
  impact: ProjectWorkspaceFileChangeImpact
): ProjectWorkspaceFileChangeReopenResult {
  const affectedIds = affectedWorkItemIds(impact.plan)
  const items = state.workItems.filter(item => item.projectId === impact.projectId && affectedIds.has(item.id))
  if (items.length !== affectedIds.size) throw new Error('STUDIO_FILE_CHECK_SCOPE: affected WorkItem is missing or belongs to another Project')
  const goalIds = new Set(items.flatMap(item => item.goalId ? [item.goalId] : []))
  const result: ProjectWorkspaceFileChangeReopenResult = { reopenedWorkItemIds: [], reopenedGoalIds: [] }
  for (const item of items) {
    if (item.status === 'done') { item.status = 'verifying'; result.reopenedWorkItemIds.push(item.id) }
    if (item.acceptance) item.acceptance = { status: 'pending', evidenceRefs: [] }
    recordFileChangeReview(state, item, 'work_item', impact)
  }
  for (const goal of state.goals.filter(goal => goal.projectId === impact.projectId && goalIds.has(goal.id))) {
    if (goal.status === 'completed') { goal.status = 'verifying'; goal.completedAt = undefined; result.reopenedGoalIds.push(goal.id) }
    // Preserve an archived Goal's visibility choice while removing its stale completion state.
    if (goal.status === 'archived' && goal.archivedFromStatus === 'completed') goal.archivedFromStatus = 'verifying'
    if (goal.acceptanceResult) goal.acceptanceResult = { status: 'pending', evidenceRefs: [] }
    recordFileChangeReview(state, goal, 'goal', impact)
  }
  return result
}

function recordFileChangeReview(
  state: Pick<ProjectWorkspaceState, 'events'>,
  entity: WorkItem | Goal,
  entityType: 'work_item' | 'goal',
  impact: ProjectWorkspaceFileChangeImpact
): void {
  entity.updatedAt = impact.now
  entity.revision += 1
  appendEvent(state as ProjectWorkspaceState, impact.projectId, entityType, entity.id,
    `${entityType}.file_change_review_requested`, entity.revision,
    { planDigest: impact.plan.planDigest, status: entity.status, changedArtifactIds: impact.plan.changedArtifactIds }, impact.now)
}

function fileCheckEventId(impact: ProjectWorkspaceFileChangeImpact): string {
  return `studio:file-check:${digest({ fingerprint: impact.fileCheck!.fingerprint, planDigest: impact.plan.planDigest })}`
}

function assertFileCheckReplay(db: WorkflowLedgerDatabase, impact: ProjectWorkspaceFileChangeImpact): void {
  if (!impact.fileCheck) return
  const event = findEventById(db, fileCheckEventId(impact))
  if (!event || event.kind !== 'workflow.studio.result.files.checked' ||
      event.payload.fingerprint !== impact.fileCheck.fingerprint || digest(event.payload.result) !== digest(impact.fileCheck.result)) {
    throw new Error('STUDIO_FILE_CHECK_REPLAY: canonical change impact has no matching file observation')
  }
}
