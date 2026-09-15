import {
  mutateTaskSnapshotDatabase,
  readTaskSnapshotDatabase
} from './task-snapshot'
import { digest } from './workflow-ledger-codec'
import {
  findWorkflowAcceptance,
  findWorkflowArtifact,
  findWorkflowEvidenceLink,
  findWorkflowGoal,
  findWorkflowRun,
  findWorkflowWorkItem,
  appendWorkflowEvent,
  linkWorkflowEvidence,
  projectGoal,
  projectWorkflowAcceptance,
  invalidateWorkflowAcceptanceForChange,
  projectWorkItem,
  registerWorkflowArtifact,
  selectWorkflowLedger,
  setupWorkflowLedgerSchema,
} from './workflow-ledger-store'
import {
  diagnosePersistedWorkflowLedger,
  exportPersistedWorkflowLedger,
  planPersistedWorkflowLedgerRepair,
  repairPersistedWorkflowLedger
} from './workflow-ledger-maintenance'
import {
  createPersistedWorkflowArtifactEdge,
  createPersistedWorkflowArtifactLocation,
  listPersistedWorkflowArtifactEdges,
  listPersistedWorkflowArtifactLocations,
  queryPersistedWorkflowArtifactGraph,
  verifyPersistedWorkflowArtifactGraph,
  verifyPersistedWorkflowLedgerWithArtifactGraph
} from './workflow-ledger-artifact-graph-api'
import type {
  WorkflowAcceptanceInput,
  WorkflowAcceptanceRecord,
  WorkflowArtifactAcceptanceCreateInput,
  WorkflowArtifactAcceptanceCreateResult,
  WorkflowArtifactInput,
  WorkflowArtifactRecord,
  WorkflowArtifactEdgeInput,
  WorkflowArtifactEdgeRecord,
  WorkflowArtifactGraphScope,
  WorkflowArtifactGraphVerification,
  WorkflowArtifactLocationInput,
  WorkflowArtifactLocationRecord,
  WorkflowArtifactNeighborhood,
  WorkflowEvidenceInput,
  WorkflowEvidenceCreateInput,
  WorkflowEvidenceLinkInput,
  WorkflowEvidenceLinkRecord,
  WorkflowEvidenceRecord,
  WorkflowEvidenceScope,
  WorkflowEvidenceVerification,
  WorkflowGoalProjectionInput,
  WorkflowGoalRecord,
  WorkflowGoalStatus,
  WorkflowLedgerScope,
  WorkflowLedgerExportOptions,
  WorkflowLedgerExportResult,
  WorkflowLedgerPage,
  WorkflowLedgerRepairPlan,
  WorkflowLedgerRendererSelection,
  WorkflowLedgerSelection,
  WorkflowLedgerVerification,
  WorkflowProjectDeliveryWorkbench,
  WorkflowWorkItemProjectionInput,
  WorkflowWorkItemRecord,
  WorkflowWorkItemStatus
} from '../../shared/workflow-types'
import {
  appendWorkflowEvidence,
  type AppendWorkflowEvidenceOptions,
  listWorkflowEvidence as listWorkflowEvidenceRecords,
  readAllWorkflowEvidenceForIntegrity,
  selectWorkflowEvidence,
  setupWorkflowEvidenceSchema,
  verifyWorkflowEvidence as verifyWorkflowEvidenceRecords
} from './workflow-evidence-store'
import {
  findEventById,
  readAcceptances,
  readAndVerifyEvents,
  readArtifacts,
  readEvidenceLinks
} from './workflow-ledger-query'
import { assertWorkflowEvidenceEventCoverage } from './workflow-evidence-event-coverage'
import {
  readArtifactEdges,
  readArtifactLocations,
  verifyWorkflowArtifactGraph as verifyWorkflowArtifactGraphInDatabase
} from './workflow-ledger-artifact-graph-query'
import {
  applyWorkflowAcceptanceRechecks,
  buildWorkflowChangeImpactPlan,
  type WorkflowChangeImpactInput,
  type WorkflowChangeImpactPlan
} from './workflow-change-impact'
import {
  toWorkflowAcceptanceError,
  WorkflowAcceptanceGateError,
  type WorkflowAcceptanceGateOptions
} from './workflow-acceptance-guard'
import { workflowArtifactAcceptanceIdentities } from './workflow-artifact-acceptance'
import { currentArtifactLineageLeafIdsByArtifact } from './artifact-lineage'

export type WorkflowLedgerWriteOptions = WorkflowAcceptanceGateOptions

export interface WorkflowChangeImpactCommitResult {
  plan: WorkflowChangeImpactPlan
  planEventId: string
  acceptances: WorkflowAcceptanceRecord[]
}

/**
 * Persist a prepared change impact plan and fence every affected Acceptance
 * revision in one mutation-queue transaction. The plan itself is recorded
 * as a system event; Acceptance writes use the dedicated invalidation API so
 * the ordinary Acceptance state machine remains closed to regressions.
 */
export async function commitWorkflowChangeImpactPlan(
  plan: WorkflowChangeImpactPlan,
  rootDir?: string,
  now = Date.now()
): Promise<WorkflowChangeImpactCommitResult> {
  if (!Number.isFinite(now)) throw new Error('change impact commit time must be finite')
  return mutateTaskSnapshotDatabase(rootDir, (db) => commitWorkflowChangeImpactPlanInDatabase(db, plan, now))
}

function commitWorkflowChangeImpactPlanInDatabase(
  db: Parameters<typeof setupWorkflowLedgerSchema>[0],
  plan: WorkflowChangeImpactPlan,
  now: number
): WorkflowChangeImpactCommitResult {
  const { planDigest, ...unsignedPlan } = plan
  if (digest(unsignedPlan) !== planDigest) throw new Error('change impact plan digest is invalid')
  setupWorkflowLedgerSchema(db)
  const planEventId = `workflow:change-impact:${plan.planDigest}`
  const existingPlanEvent = findEventById(db, planEventId)
  if (existingPlanEvent) {
    if (existingPlanEvent.kind !== 'workflow.change-impact.plan.created' || digest(existingPlanEvent.payload) !== digest(plan)) {
      throw new Error(`change impact plan event ${planEventId} is immutable and conflicting`)
    }
    const replayAcceptances: WorkflowAcceptanceRecord[] = []
    for (const recheck of plan.acceptanceRechecks) {
      const acceptance = findWorkflowAcceptance(db, recheck.acceptanceId)
      if (!acceptance) throw new Error(`change impact replay references missing acceptance ${recheck.acceptanceId}`)
      if (acceptance.status !== recheck.nextStatus || acceptance.revision !== recheck.nextRevision) {
        throw new Error(`acceptance ${acceptance.id} is inconsistent with committed change impact ${plan.planDigest}`)
      }
      replayAcceptances.push(acceptance)
    }
    return {
      plan,
      planEventId,
      acceptances: replayAcceptances
    }
  }
  appendWorkflowEvent(db, {
    eventId: planEventId,
    streamId: plan.projectId ? `project:${plan.projectId}` : `change-impact:${plan.planDigest}`,
    entityType: 'system',
    entityId: planEventId,
    kind: 'workflow.change-impact.plan.created',
    payload: { ...plan },
    occurredAt: now,
    correlationId: plan.projectId ?? plan.planDigest
  }, plan.projectId ? { projectId: plan.projectId } : {})
  const persisted: WorkflowAcceptanceRecord[] = []
  for (const recheck of plan.acceptanceRechecks) {
    const current = findWorkflowAcceptance(db, recheck.acceptanceId)
    if (!current) throw new Error(`change impact plan references missing acceptance ${recheck.acceptanceId}`)
    if (current.status !== recheck.previousStatus || current.revision !== recheck.previousRevision) {
      throw new Error(`acceptance ${current.id} changed after impact plan`)
    }
    const [reset] = applyWorkflowAcceptanceRechecks([current], plan, now)
    const updated = invalidateWorkflowAcceptanceForChange(db, reset, { caller: 'system', actorId: 'workflow-change-impact' })
    persisted.push(updated)
  }
  return { plan, planEventId, acceptances: persisted }
}

// Keep the persisted/read-only names available from the main API facade for
// maintenance callers that do not use the renderer-facing aliases below.
export {
  exportPersistedWorkflowLedger,
  diagnosePersistedWorkflowLedger,
  planPersistedWorkflowLedgerRepair,
  repairPersistedWorkflowLedger
} from './workflow-ledger-maintenance'

export async function listPersistedWorkflowLedger(
  scope: WorkflowLedgerScope = {},
  rootDir?: string
): Promise<WorkflowLedgerSelection> {
  return readTaskSnapshotDatabase(rootDir, (db) => selectWorkflowLedger(db, scope))
}

/**
 * Renderer-facing Ledger query.  Keep the full projection available to main
 * process recovery/effect code through listPersistedWorkflowLedger, while the
 * IPC contract receives only Run metadata and a digest of the omitted TaskRun.
 */
export async function listWorkflowLedger(
  scope: WorkflowLedgerScope = {},
  rootDir?: string
): Promise<WorkflowLedgerRendererSelection> {
  const selection = await listPersistedWorkflowLedger(scope, rootDir)
  return toRendererWorkflowLedger(selection)
}

export function toRendererWorkflowLedger(
  selection: WorkflowLedgerSelection
): WorkflowLedgerRendererSelection {
  return {
    ...selection,
    runs: {
      ...selection.runs,
      items: selection.runs.items.map(({ taskRun, error, ...metadata }) => ({
        ...metadata,
        taskRunDigest: digest(taskRun),
        ...(error === undefined ? {} : { errorDigest: digest(error) })
      }))
    }
  }
}

export async function getProjectDeliveryWorkbench(
  rawProjectId: string,
  rootDir?: string
): Promise<WorkflowProjectDeliveryWorkbench> {
  const projectId = rawProjectId.trim()
  if (!projectId) throw new Error('Project ID is required')
  return readTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    setupWorkflowEvidenceSchema(db)
    verifyWorkflowArtifactGraphInDatabase(db)
    const allEvidence = readAllWorkflowEvidenceForIntegrity(db)
    verifyWorkflowEvidenceRecords(db)
    assertWorkflowEvidenceEventCoverage(allEvidence, readAndVerifyEvents(db))

    const artifacts = readArtifacts(db).filter((record) => record.projectId === projectId)
    const locations = readArtifactLocations(db).filter((record) => record.projectId === projectId)
    const evidence = allEvidence.filter((record) => record.projectId === projectId)
    const acceptances = readAcceptances(db).filter((record) => record.projectId === projectId)
    const evidenceLinks = readEvidenceLinks(db).filter((record) => record.projectId === projectId)
    const supersededIds = new Set(artifacts.flatMap((artifact) => artifact.supersedesId ? [artifact.supersedesId] : []))
    const successorIdsByArtifact = artifactSuccessors(artifacts)
    const currentIdsByArtifact = currentArtifactLineageLeafIdsByArtifact(artifacts)
    const lineageIdsByArtifact = artifactLineageIds(artifacts, successorIdsByArtifact)
    const acceptanceEvidenceIds = new Set(acceptances.flatMap((acceptance) => acceptance.evidenceRefs))
    for (const link of evidenceLinks) {
      if (link.acceptanceId) acceptanceEvidenceIds.add(link.evidenceId)
    }

    const deliveryArtifacts = artifacts
      .map((artifact) => {
        const artifactEvidenceIds = new Set(
          evidence.filter((record) => record.artifactId === artifact.id).map((record) => record.evidenceId)
        )
        for (const link of evidenceLinks) {
          if (link.artifactId === artifact.id) artifactEvidenceIds.add(link.evidenceId)
        }
        const artifactAcceptanceIds = new Set<string>()
        for (const acceptance of acceptances) {
          if (acceptance.evidenceRefs.some((evidenceId) => artifactEvidenceIds.has(evidenceId))) {
            artifactAcceptanceIds.add(acceptance.id)
          }
        }
        for (const link of evidenceLinks) {
          if (link.artifactId === artifact.id && link.acceptanceId) artifactAcceptanceIds.add(link.acceptanceId)
        }
        const artifactLocations = locations.filter((location) => location.artifactId === artifact.id)
        return {
          artifact,
          locations: artifactLocations,
          evidenceIds: [...artifactEvidenceIds].sort(),
          acceptanceIds: [...artifactAcceptanceIds].sort(),
          isCurrent: !supersededIds.has(artifact.id),
          ...(artifact.supersedesId ? { predecessorArtifactId: artifact.supersedesId } : {}),
          successorArtifactIds: [...(successorIdsByArtifact.get(artifact.id) ?? [])],
          currentArtifactIds: [...(currentIdsByArtifact.get(artifact.id) ?? [])],
          lineageArtifactIds: [...(lineageIdsByArtifact.get(artifact.id) ?? [artifact.id])],
          available: artifactLocations.some((location) => location.availability === 'available')
        }
      })
      .sort((left, right) => right.artifact.updatedAt - left.artifact.updatedAt || left.artifact.id.localeCompare(right.artifact.id))
    const countAcceptance = (status: typeof acceptances[number]['status']): number =>
      acceptances.filter((acceptance) => acceptance.status === status).length

    return {
      projectId,
      generatedAt: Date.now(),
      summary: {
        artifactCount: artifacts.length,
        currentArtifactCount: deliveryArtifacts.filter((item) => item.isCurrent).length,
        availableArtifactCount: deliveryArtifacts.filter((item) => item.available).length,
        evidenceCount: evidence.length,
        unlinkedEvidenceCount: evidence.filter((record) => !acceptanceEvidenceIds.has(record.evidenceId)).length,
        acceptanceCount: acceptances.length,
        pendingAcceptanceCount: countAcceptance('pending') + countAcceptance('verifying'),
        failedAcceptanceCount: countAcceptance('failed'),
        passedAcceptanceCount: countAcceptance('passed'),
        waivedAcceptanceCount: countAcceptance('waived')
      },
      artifacts: deliveryArtifacts,
      evidence: [...evidence].sort((left, right) => right.observedAt - left.observedAt || left.evidenceId.localeCompare(right.evidenceId)),
      acceptances: [...acceptances].sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)),
      evidenceLinks: [...evidenceLinks].sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    }
  })
}

function artifactSuccessors(
  artifacts: readonly WorkflowArtifactRecord[]
): ReadonlyMap<string, readonly string[]> {
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id))
  const successors = new Map<string, string[]>()
  for (const artifact of artifacts) {
    if (!artifact.supersedesId || !artifactIds.has(artifact.supersedesId)) continue
    const values = successors.get(artifact.supersedesId) ?? []
    values.push(artifact.id)
    successors.set(artifact.supersedesId, values)
  }
  for (const values of successors.values()) values.sort()
  return successors
}

function artifactLineageIds(
  artifacts: readonly WorkflowArtifactRecord[],
  successors: ReadonlyMap<string, readonly string[]>
): ReadonlyMap<string, readonly string[]> {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  const roots = artifacts
    .filter((artifact) => !artifact.supersedesId || !byId.has(artifact.supersedesId))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  const result = new Map<string, readonly string[]>()
  for (const root of roots) {
    const lineage: WorkflowArtifactRecord[] = []
    const pending = [root.id]
    const visited = new Set<string>()
    while (pending.length > 0) {
      const id = pending.shift()!
      if (visited.has(id)) continue
      visited.add(id)
      const artifact = byId.get(id)
      if (!artifact) continue
      lineage.push(artifact)
      pending.push(...(successors.get(id) ?? []))
    }
    const ids = lineage
      .sort((left, right) => left.version - right.version || left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map((artifact) => artifact.id)
    for (const id of ids) result.set(id, ids)
  }
  return result
}

export async function verifyPersistedWorkflowLedger(
  rootDir?: string
): Promise<WorkflowLedgerVerification> {
  return verifyPersistedWorkflowLedgerWithArtifactGraph(rootDir)
}

/** Export the complete, sanitised Ledger snapshot for a scope. */
export async function exportWorkflowLedger(
  options: WorkflowLedgerExportOptions = {},
  rootDir?: string
): Promise<WorkflowLedgerExportResult> {
  return exportPersistedWorkflowLedger(options, rootDir)
}

/** Return a read-only repair plan; this never mutates the snapshot database. */
export async function diagnoseWorkflowLedger(
  rootDir?: string
): Promise<WorkflowLedgerRepairPlan> {
  return diagnosePersistedWorkflowLedger(rootDir)
}

export async function planWorkflowLedgerRepair(
  rootDir?: string
): Promise<WorkflowLedgerRepairPlan> {
  return planPersistedWorkflowLedgerRepair(rootDir)
}

export async function repairWorkflowLedger(
  rootDir?: string
): Promise<WorkflowLedgerRepairPlan> {
  return repairPersistedWorkflowLedger(rootDir)
}

export async function createWorkflowGoal(
  input: WorkflowGoalProjectionInput,
  rootDir?: string,
  options: WorkflowLedgerWriteOptions = {}
): Promise<WorkflowGoalRecord> {
  try {
    return await mutateTaskSnapshotDatabase(rootDir, (db) => {
      setupWorkflowLedgerSchema(db)
      projectGoal(db, { ...input, source: input.source ?? 'explicit' }, options)
      const page = selectWorkflowLedger(db, { projectId: input.projectId, limit: 500 }).goals.items
      const goal = page.find((candidate) => candidate.id === input.id.trim())
      if (!goal) throw new Error(`workflow goal ${input.id} was not persisted`)
      return goal
    })
  } catch (error) {
    throw toWorkflowAcceptanceError(error, {
      operation: 'createWorkflowGoal',
      targetType: 'goal',
      targetId: input.id,
      projectId: input.projectId,
      toStatus: input.status
    })
  }
}

export async function createWorkflowWorkItem(
  input: WorkflowWorkItemProjectionInput,
  rootDir?: string,
  options: WorkflowLedgerWriteOptions = {}
): Promise<WorkflowWorkItemRecord> {
  try {
    return await mutateTaskSnapshotDatabase(rootDir, (db) => {
      setupWorkflowLedgerSchema(db)
      projectWorkItem(db, { ...input, source: input.source ?? 'explicit' }, options)
      const item = findWorkflowWorkItem(db, input.id.trim())
      if (!item) throw new Error(`workflow work item ${input.id} was not persisted`)
      return item
    })
  } catch (error) {
    throw toWorkflowAcceptanceError(error, {
      operation: 'createWorkflowWorkItem',
      targetType: 'work_item',
      targetId: input.id,
      projectId: input.projectId,
      toStatus: input.status
    })
  }
}

export async function createWorkflowArtifact(
  input: WorkflowArtifactInput,
  rootDir?: string
): Promise<WorkflowArtifactRecord> {
  return mutateTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    registerWorkflowArtifact(db, input)
    const artifact = findWorkflowArtifact(db, input.id.trim())
    if (!artifact) throw new Error(`workflow artifact ${input.id} was not persisted`)
    return artifact
  })
}

export async function createWorkflowArtifactAcceptance(
  input: WorkflowArtifactAcceptanceCreateInput,
  rootDir?: string
): Promise<WorkflowArtifactAcceptanceCreateResult> {
  const artifactId = input.artifactId.trim()
  if (!artifactId) throw new Error('Artifact ID is required')
  return mutateTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    setupWorkflowEvidenceSchema(db)
    const artifact = findWorkflowArtifact(db, artifactId)
    if (!artifact) throw new Error(`workflow artifact ${artifactId} was not found`)
    assertArtifactAcceptanceOwnership(db, artifact)
    const projectId = artifact.projectId
    if (!projectId) throw new Error(`workflow artifact ${artifactId} has no Project ownership`)

    const { acceptanceId, criterionId, evidenceId, linkId } =
      workflowArtifactAcceptanceIdentities(artifactId)
    const existingAcceptance = findWorkflowAcceptance(db, acceptanceId)
    const observedAt = existingAcceptance?.createdAt ?? Date.now()
    const criteria = [`交付物 ${artifact.title} 可定位、内容正确且满足交付要求`]
    const acceptance = existingAcceptance ?? projectWorkflowAcceptance(db, {
      id: acceptanceId,
      projectId,
      criteria,
      criterionPolicies: [{
        criterionId,
        criterionIndex: 0,
        evidenceKind: 'delivery_check',
        allowedSources: ['runtime', 'human']
      }],
      status: 'pending',
      revision: 1,
      createdAt: observedAt,
      updatedAt: observedAt
    }, { caller: 'user', actorId: 'artifact-acceptance-authoring' })
    assertArtifactAcceptanceContract(artifact.id, acceptance, projectId, criteria, criterionId)

    const bindingEvidence = recordWorkflowEvidence(db, {
      evidenceId,
      projectId,
      ...(artifact.goalId ? { goalId: artifact.goalId } : {}),
      ...(artifact.workItemId ? { workItemId: artifact.workItemId } : {}),
      ...(artifact.runId ? { runId: artifact.runId } : {}),
      artifactId: artifact.id,
      kind: 'observation',
      title: `Artifact Acceptance binding: ${artifact.title}`,
      summary: 'Canonical binding record only; passing this Acceptance still requires matching delivery_check Evidence.',
      contentDigest: digest({ contract: 'artifact-acceptance-binding-v1', artifactId, acceptanceId }),
      metadata: { contract: 'artifact-acceptance-binding-v1', acceptanceId }
    }, {
      source: 'runtime',
      verifier: 'artifact-acceptance-authoring',
      observedAt
    })
    const bindingLink = linkWorkflowEvidence(db, {
      id: linkId,
      evidenceId,
      projectId,
      ...(artifact.runId ? { runId: artifact.runId } : {}),
      artifactId: artifact.id,
      acceptanceId,
      evidenceOrigin: 'workflow',
      relation: 'supports',
      createdAt: observedAt
    })
    return {
      acceptance,
      bindingEvidence,
      bindingLink,
      disposition: existingAcceptance ? 'existing' : 'created'
    }
  })
}

function assertArtifactAcceptanceOwnership(
  db: Parameters<typeof findWorkflowArtifact>[0],
  artifact: WorkflowArtifactRecord
): void {
  const goal = artifact.goalId ? findWorkflowGoal(db, artifact.goalId) : null
  const workItem = artifact.workItemId ? findWorkflowWorkItem(db, artifact.workItemId) : null
  const run = artifact.runId ? findWorkflowRun(db, artifact.runId) : null
  if (artifact.goalId && !goal) throw new Error(`workflow artifact ${artifact.id} references missing Goal`)
  if (artifact.workItemId && !workItem) throw new Error(`workflow artifact ${artifact.id} references missing WorkItem`)
  if (artifact.runId && !run) throw new Error(`workflow artifact ${artifact.id} references missing Run`)
  for (const owner of [goal, workItem, run]) {
    if (owner && owner.projectId !== artifact.projectId) {
      throw new Error(`workflow artifact ${artifact.id} crosses Project ownership`)
    }
  }
  if (workItem && artifact.goalId && workItem.goalId !== artifact.goalId) {
    throw new Error(`workflow artifact ${artifact.id} Goal/WorkItem ownership differs`)
  }
  if (run && (run.workItemId !== artifact.workItemId || run.goalId !== artifact.goalId)) {
    throw new Error(`workflow artifact ${artifact.id} Run ownership differs`)
  }
}

function assertArtifactAcceptanceContract(
  artifactId: string,
  acceptance: WorkflowAcceptanceRecord,
  projectId: string,
  criteria: readonly string[],
  criterionId: string
): void {
  const policy = acceptance.criterionPolicies?.[0]
  if (acceptance.projectId !== projectId || acceptance.goalId !== undefined || acceptance.workItemId !== undefined ||
      digest(acceptance.criteria) !== digest(criteria) || acceptance.criterionPolicies?.length !== 1 ||
      policy?.criterionId !== criterionId || policy.criterionIndex !== 0 || policy.evidenceKind !== 'delivery_check' ||
      digest(policy.allowedSources) !== digest(['runtime', 'human'])) {
    throw new Error(`Artifact Acceptance contract conflicts with persisted record: ${artifactId}`)
  }
}

export async function createWorkflowArtifactEdge(
  input: WorkflowArtifactEdgeInput,
  rootDir?: string
): Promise<WorkflowArtifactEdgeRecord> {
  return createPersistedWorkflowArtifactEdge(input, rootDir)
}

export async function createWorkflowArtifactLocation(
  input: WorkflowArtifactLocationInput,
  rootDir?: string
): Promise<WorkflowArtifactLocationRecord> {
  return createPersistedWorkflowArtifactLocation(input, rootDir)
}

export async function listWorkflowArtifactEdges(
  scope: WorkflowArtifactGraphScope = {},
  rootDir?: string
): Promise<WorkflowLedgerPage<WorkflowArtifactEdgeRecord>> {
  return listPersistedWorkflowArtifactEdges(scope, rootDir)
}

export async function listWorkflowArtifactLocations(
  scope: WorkflowArtifactGraphScope = {},
  rootDir?: string
): Promise<WorkflowLedgerPage<WorkflowArtifactLocationRecord>> {
  return listPersistedWorkflowArtifactLocations(scope, rootDir)
}

export async function queryWorkflowArtifactGraph(
  artifactId: string,
  rootDir?: string
): Promise<WorkflowArtifactNeighborhood> {
  return queryPersistedWorkflowArtifactGraph(artifactId, rootDir)
}

export async function verifyWorkflowArtifactGraph(
  rootDir?: string
): Promise<WorkflowArtifactGraphVerification> {
  return verifyPersistedWorkflowArtifactGraph(rootDir)
}

export async function createWorkflowEvidence(
  input: WorkflowEvidenceCreateInput,
  rootDir?: string,
  authority: Pick<AppendWorkflowEvidenceOptions, 'source' | 'verifier' | 'observedAt'> = {
    source: 'runtime',
    verifier: 'main-process'
  }
): Promise<WorkflowEvidenceRecord> {
  return mutateTaskSnapshotDatabase(rootDir, (db) => recordWorkflowEvidence(db, input, authority))
}

/** Shared in-transaction Evidence projection for compound durable writes. */
export function recordWorkflowEvidence(
  db: Parameters<typeof appendWorkflowEvidence>[0],
  input: WorkflowEvidenceCreateInput,
  authority: Pick<AppendWorkflowEvidenceOptions, 'source' | 'verifier' | 'observedAt'> = {
    source: 'runtime',
    verifier: 'main-process'
  }
): WorkflowEvidenceRecord {
  setupWorkflowLedgerSchema(db)
  setupWorkflowEvidenceSchema(db)
  assertWorkflowEvidenceReferences(db, input)
  const record = appendWorkflowEvidence(db, input as WorkflowEvidenceInput, authority)
  appendWorkflowEvent(db, {
    eventId: `workflow:evidence-record:${record.evidenceId}`,
    streamId: record.runId ? `run:${record.runId}` : `project:${record.projectId}`,
    entityType: 'system',
    entityId: record.evidenceId,
    kind: 'workflow.evidence.recorded',
    payload: { ...record },
    occurredAt: record.createdAt,
    correlationId: record.runId ?? record.workItemId ?? record.goalId ?? record.evidenceId
  }, {
    projectId: record.projectId,
    goalId: record.goalId,
    workItemId: record.workItemId,
    runId: record.runId
  })
  assertWorkflowEvidenceEventCoverage([record], readAndVerifyEvents(db))
  return record
}

export async function listWorkflowEvidence(
  scope: WorkflowEvidenceScope = {},
  rootDir?: string
): Promise<WorkflowEvidenceRecord[]> {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowEvidenceSchema(db)
    const records = listWorkflowEvidenceRecords(db, scope)
    assertWorkflowEvidenceEventCoverage(records, readAndVerifyEvents(db))
    return records
  })
}

export async function queryWorkflowEvidence(
  scope: WorkflowEvidenceScope = {},
  rootDir?: string
): Promise<WorkflowLedgerPage<WorkflowEvidenceRecord>> {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowEvidenceSchema(db)
    const page = selectWorkflowEvidence(db, scope)
    assertWorkflowEvidenceEventCoverage(page.items, readAndVerifyEvents(db))
    return page
  })
}

export async function verifyWorkflowEvidence(
  rootDir?: string
): Promise<WorkflowEvidenceVerification> {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowEvidenceSchema(db)
    const records = readAllWorkflowEvidenceForIntegrity(db)
    const verification = verifyWorkflowEvidenceRecords(db)
    assertWorkflowEvidenceEventCoverage(records, readAndVerifyEvents(db))
    return verification
  })
}

export async function saveWorkflowAcceptance(
  input: WorkflowAcceptanceInput,
  rootDir?: string,
  options: WorkflowLedgerWriteOptions = {}
): Promise<WorkflowAcceptanceRecord> {
  try {
    return await mutateTaskSnapshotDatabase(rootDir, (db) => {
      setupWorkflowLedgerSchema(db)
      projectWorkflowAcceptance(db, input, options)
      const acceptance = findWorkflowAcceptance(db, input.id.trim())
      if (!acceptance) throw new Error(`workflow acceptance ${input.id} was not persisted`)
      return acceptance
    })
  } catch (error) {
    throw toWorkflowAcceptanceError(error, {
      operation: 'saveWorkflowAcceptance',
      targetType: 'acceptance',
      targetId: input.id,
      projectId: input.projectId,
      acceptanceId: input.id,
      toStatus: input.status,
      caller: options.caller as never,
      actorId: options.actorId
    })
  }
}

export interface ApplyPersistedWorkflowChangeImpactInput extends Pick<WorkflowChangeImpactInput, 'changedArtifactIds' | 'protectedArtifactIds' | 'manuallyModifiedArtifactIds'> {
  projectId?: string
  rootDir?: string
  now?: number
}

/**
 * Compute and persist a change-impact invalidation in one task database
 * mutation. The planner remains pure, while this facade owns the atomic
 * Workflow Ledger write of every affected Acceptance revision.
 */
export async function applyPersistedWorkflowChangeImpact(
  input: ApplyPersistedWorkflowChangeImpactInput
): Promise<{ plan: WorkflowChangeImpactPlan; acceptances: WorkflowAcceptanceRecord[] }> {
  return mutateTaskSnapshotDatabase(input.rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    setupWorkflowEvidenceSchema(db)
    verifyWorkflowArtifactGraphInDatabase(db)
    const projectId = input.projectId?.trim() || undefined
    const artifacts = readArtifacts(db).filter((record) => !projectId || record.projectId === projectId)
    const edges = readArtifactEdges(db).filter((record) => !projectId || record.projectId === projectId)
    const acceptances = readAcceptances(db).filter((record) => !projectId || record.projectId === projectId)
    const evidenceLinks = readEvidenceLinks(db).filter((record) => !projectId || record.projectId === projectId)
    const plan = buildWorkflowChangeImpactPlan({
      projectId,
      changedArtifactIds: input.changedArtifactIds,
      protectedArtifactIds: input.protectedArtifactIds,
      manuallyModifiedArtifactIds: input.manuallyModifiedArtifactIds,
      artifacts,
      edges,
      acceptances,
      evidenceLinks
    })
    const committed = commitWorkflowChangeImpactPlanInDatabase(db, plan, input.now ?? Date.now())
    const persistedById = new Map(committed.acceptances.map((acceptance) => [acceptance.id, acceptance]))
    return { plan, acceptances: acceptances.map((acceptance) => persistedById.get(acceptance.id) ?? acceptance) }
  })
}

export async function createWorkflowEvidenceLink(
  input: WorkflowEvidenceLinkInput,
  rootDir?: string
): Promise<WorkflowEvidenceLinkRecord> {
  try {
    return await mutateTaskSnapshotDatabase(rootDir, (db) => {
      setupWorkflowLedgerSchema(db)
      linkWorkflowEvidence(db, input)
      const link = findWorkflowEvidenceLink(db, input.id.trim())
      if (!link) throw new Error(`workflow evidence link ${input.id} was not persisted`)
      return link
    })
  } catch (error) {
    throw toWorkflowAcceptanceError(error, {
      operation: 'createWorkflowEvidenceLink',
      targetType: 'evidence_link',
      targetId: input.id,
      projectId: input.projectId,
      acceptanceId: input.acceptanceId,
      evidenceId: input.evidenceId
    })
  }
}

function assertWorkflowEvidenceReferences(
  db: Parameters<typeof appendWorkflowEvidence>[0],
  input: WorkflowEvidenceCreateInput
): void {
  const refs = resolveWorkflowEvidenceReferences(db, input)
  assertWorkflowEvidenceProjectBoundary(input, refs)
  assertWorkflowEvidenceHierarchy(input, refs)
}

interface WorkflowEvidenceReferences {
  goal: ReturnType<typeof findWorkflowGoal>
  workItem: ReturnType<typeof findWorkflowWorkItem>
  run: ReturnType<typeof findWorkflowRun>
  artifact: ReturnType<typeof findWorkflowArtifact>
}

function resolveWorkflowEvidenceReferences(
  db: Parameters<typeof appendWorkflowEvidence>[0],
  input: WorkflowEvidenceCreateInput
): WorkflowEvidenceReferences {
  const refs: WorkflowEvidenceReferences = {
    goal: input.goalId ? findWorkflowGoal(db, input.goalId.trim()) : null,
    workItem: input.workItemId ? findWorkflowWorkItem(db, input.workItemId.trim()) : null,
    run: input.runId ? findWorkflowRun(db, input.runId.trim()) : null,
    artifact: input.artifactId ? findWorkflowArtifact(db, input.artifactId.trim()) : null
  }
  for (const [label, id, record] of [
    ['goal', input.goalId, refs.goal],
    ['work item', input.workItemId, refs.workItem],
    ['run', input.runId, refs.run],
    ['artifact', input.artifactId, refs.artifact]
  ] as const) {
    if (id && !record) throw new Error(`workflow evidence ${input.evidenceId} references missing ${label} ${id}`)
  }
  return refs
}

function assertWorkflowEvidenceProjectBoundary(
  input: WorkflowEvidenceCreateInput,
  refs: WorkflowEvidenceReferences
): void {
  for (const record of Object.values(refs)) {
    if (record && record.projectId !== input.projectId) {
      throw new Error(`workflow evidence ${input.evidenceId} crosses project boundary`)
    }
  }
}

function assertWorkflowEvidenceHierarchy(
  input: WorkflowEvidenceCreateInput,
  refs: WorkflowEvidenceReferences
): void {
  if (refs.workItem && input.goalId && refs.workItem.goalId !== input.goalId) {
    throw new Error(`workflow evidence ${input.evidenceId} goal/work item ownership differs`)
  }
  assertWorkflowEvidenceRunHierarchy(input, refs.run)
  assertWorkflowEvidenceArtifactHierarchy(input, refs.artifact)
}

function assertWorkflowEvidenceRunHierarchy(
  input: WorkflowEvidenceCreateInput,
  run: WorkflowEvidenceReferences['run']
): void {
  if (!run) return
  if (input.workItemId && run.workItemId !== input.workItemId) {
    throw new Error(`workflow evidence ${input.evidenceId} run/work item ownership differs`)
  }
  if (input.goalId && run.goalId !== input.goalId) {
    throw new Error(`workflow evidence ${input.evidenceId} run/goal ownership differs`)
  }
}

function assertWorkflowEvidenceArtifactHierarchy(
  input: WorkflowEvidenceCreateInput,
  artifact: WorkflowEvidenceReferences['artifact']
): void {
  if (!artifact) return
  if (input.runId && artifact.runId !== input.runId) {
    throw new Error(`workflow evidence ${input.evidenceId} artifact/run ownership differs`)
  }
  if (input.workItemId && artifact.workItemId !== input.workItemId) {
    throw new Error(`workflow evidence ${input.evidenceId} artifact/work item ownership differs`)
  }
  if (input.goalId && artifact.goalId !== input.goalId) {
    throw new Error(`workflow evidence ${input.evidenceId} artifact/goal ownership differs`)
  }
}

export async function transitionWorkflowWorkItem(
  id: string,
  status: WorkflowWorkItemStatus,
  expectedRevision: number,
  rootDir?: string,
  options: WorkflowLedgerWriteOptions = {}
): Promise<WorkflowWorkItemRecord> {
  const normalizedId = id.trim()
  if (!normalizedId) throw new Error('workflow work item id is required')
  if (!Number.isInteger(expectedRevision) || expectedRevision <= 0) {
    throw new Error('workflow work item expectedRevision must be a positive integer')
  }
  try {
    return await mutateTaskSnapshotDatabase(rootDir, (db) => {
      setupWorkflowLedgerSchema(db)
      const current = findWorkflowWorkItem(db, normalizedId)
      if (!current) throw new Error(`workflow work item ${normalizedId} not found`)
      if (current.revision !== expectedRevision) {
        throw new WorkflowAcceptanceGateError(
          'WORKFLOW_REVISION_CONFLICT',
          `stale_revision: workflow work item ${normalizedId} is at ${current.revision}`,
          {
            operation: 'transitionWorkflowWorkItem',
            targetType: 'work_item',
            targetId: normalizedId,
            projectId: current.projectId,
            expectedRevision,
            actualRevision: current.revision,
            fromStatus: current.status,
            toStatus: status,
            caller: options.caller as never,
            actorId: options.actorId
          }
        )
      }
      projectWorkItem(db, {
        ...current,
        status,
        revision: current.revision + 1,
        updatedAt: Date.now()
      }, options)
      const updated = findWorkflowWorkItem(db, normalizedId)
      if (!updated) throw new Error(`workflow work item ${normalizedId} disappeared after transition`)
      return updated
    })
  } catch (error) {
    throw toWorkflowAcceptanceError(error, {
      operation: 'transitionWorkflowWorkItem',
      targetType: 'work_item',
      targetId: normalizedId,
      toStatus: status,
      expectedRevision,
      caller: options.caller as never,
      actorId: options.actorId
    })
  }
}

/** Goal transition counterpart to the existing WorkItem CAS API. */
export async function transitionWorkflowGoal(
  id: string,
  status: WorkflowGoalStatus,
  expectedRevision: number,
  rootDir?: string,
  options: WorkflowLedgerWriteOptions = {}
): Promise<WorkflowGoalRecord> {
  const normalizedId = id.trim()
  if (!normalizedId) throw new Error('workflow goal id is required')
  if (!Number.isInteger(expectedRevision) || expectedRevision <= 0) {
    throw new Error('workflow goal expectedRevision must be a positive integer')
  }
  try {
    return await mutateTaskSnapshotDatabase(rootDir, (db) => {
      setupWorkflowLedgerSchema(db)
      const current = findWorkflowGoal(db, normalizedId)
      if (!current) throw new Error(`workflow goal ${normalizedId} not found`)
      if (current.revision !== expectedRevision) {
        throw new WorkflowAcceptanceGateError(
          'WORKFLOW_REVISION_CONFLICT',
          `stale_revision: workflow goal ${normalizedId} is at ${current.revision}`,
          {
            operation: 'transitionWorkflowGoal',
            targetType: 'goal',
            targetId: normalizedId,
            projectId: current.projectId,
            expectedRevision,
            actualRevision: current.revision,
            fromStatus: current.status,
            toStatus: status,
            caller: options.caller as never,
            actorId: options.actorId
          }
        )
      }
      projectGoal(db, {
        ...current,
        status,
        revision: current.revision + 1,
        updatedAt: Date.now()
      }, options)
      const updated = findWorkflowGoal(db, normalizedId)
      if (!updated) throw new Error(`workflow goal ${normalizedId} disappeared after transition`)
      return updated
    })
  } catch (error) {
    throw toWorkflowAcceptanceError(error, {
      operation: 'transitionWorkflowGoal',
      targetType: 'goal',
      targetId: normalizedId,
      toStatus: status,
      expectedRevision,
      caller: options.caller as never,
      actorId: options.actorId
    })
  }
}
