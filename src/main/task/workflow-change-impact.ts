import type {
  WorkflowAcceptanceRecord,
  WorkflowArtifactEdgeRecord,
  WorkflowArtifactRecord,
  WorkflowEvidenceLinkRecord
} from '../../shared/workflow-types'
import { canonicalJson, digest } from './workflow-ledger-codec'
import { workflowAcceptanceStatusAfterChange } from './workflow-acceptance-change-policy'

/**
 * Relations whose direction means that a changed source can invalidate the
 * target. Ambiguous/custom relations are reported for human review instead of
 * being treated as safe dependencies.
 */
export const CHANGE_PROPAGATING_RELATIONS: readonly WorkflowArtifactEdgeRecord['relation'][] = [
  'derived_from',
  'produced_from',
  'input_to',
  'output_of',
  'supports',
  'verifies',
  'references',
  'depends_on'
]

const PROPAGATING_RELATIONS = new Set<WorkflowArtifactEdgeRecord['relation']>(CHANGE_PROPAGATING_RELATIONS)

export type ChangeImpactDisposition = 'rerun' | 'review' | 'protected'

export interface WorkflowChangeImpactArtifact {
  artifactId: string
  disposition: ChangeImpactDisposition
  reason: 'changed' | 'downstream' | 'ambiguous_relation' | 'protected' | 'manual_modification' | 'protected_work_item'
  viaArtifactId?: string
  viaRelation?: WorkflowArtifactEdgeRecord['relation']
}

export interface WorkflowAcceptanceRecheck {
  acceptanceId: string
  previousStatus: WorkflowAcceptanceRecord['status']
  nextStatus: 'pending' | 'failed'
  previousRevision: number
  nextRevision: number
  workItemId?: string
  reason: 'changed_artifact' | 'downstream_artifact' | 'ambiguous_artifact' | 'protected_artifact'
}

export interface WorkflowChangeImpactPlan {
  schemaVersion: 1
  contract: 'workflow-change-impact-v1'
  projectId?: string
  changedArtifactIds: string[]
  artifacts: WorkflowChangeImpactArtifact[]
  impactedArtifactIds: string[]
  reviewArtifactIds: string[]
  protectedArtifactIds: string[]
  impactedWorkItemIds: string[]
  rerunWorkItemIds: string[]
  reviewWorkItemIds: string[]
  acceptanceRechecks: WorkflowAcceptanceRecheck[]
  unresolvedReferences: string[]
  planDigest: string
}

export interface WorkflowChangeImpactInput {
  projectId?: string
  changedArtifactIds: readonly string[]
  artifacts: readonly WorkflowArtifactRecord[]
  edges: readonly WorkflowArtifactEdgeRecord[]
  acceptances: readonly WorkflowAcceptanceRecord[]
  evidenceLinks?: readonly WorkflowEvidenceLinkRecord[]
  protectedArtifactIds?: readonly string[]
  manuallyModifiedArtifactIds?: readonly string[]
}

export class WorkflowChangeImpactError extends Error {
  readonly code:
    | 'invalid_input'
    | 'duplicate_artifact'
    | 'missing_artifact'
    | 'cross_project_reference'
    | 'missing_acceptance'
    | 'invalid_acceptance_revision'

  constructor(code: WorkflowChangeImpactError['code'], message: string) {
    super(message)
    this.name = 'WorkflowChangeImpactError'
    this.code = code
  }
}

/**
 * Build a deterministic, fail-closed impact plan from the canonical Artifact
 * Graph. The function is intentionally pure: a caller must persist the plan
 * and acceptance revisions through the Workflow Ledger transaction that owns
 * the source change.
 */
export function buildWorkflowChangeImpactPlan(input: WorkflowChangeImpactInput): WorkflowChangeImpactPlan {
  const artifactsById = indexArtifacts(input)
  const projectId = normalizeOptionalId(input.projectId)
  const changedIds = uniqueRequiredIds(input.changedArtifactIds, 'changed artifact')
  const protectedIds = new Set(uniqueRequiredIds(input.protectedArtifactIds ?? [], 'protected artifact'))
  const manuallyModifiedIds = new Set(uniqueRequiredIds(input.manuallyModifiedArtifactIds ?? [], 'manually modified artifact'))
  const unresolvedReferences: string[] = []

  for (const id of [...protectedIds, ...manuallyModifiedIds]) {
    if (!artifactsById.has(id)) unresolvedReferences.push(id)
  }
  for (const id of changedIds) {
    const artifact = artifactsById.get(id)
    if (!artifact) throw new WorkflowChangeImpactError('missing_artifact', `changed artifact ${id} is missing`)
    assertProject(projectId, artifact.projectId, `changed artifact ${id}`)
  }

  const outgoing = new Map<string, WorkflowArtifactEdgeRecord[]>()
  for (const edge of input.edges) {
    const from = artifactsById.get(edge.fromArtifactId)
    const to = artifactsById.get(edge.toArtifactId)
    if (!from || !to) {
      throw new WorkflowChangeImpactError('missing_artifact', `edge ${edge.id} references a missing artifact`)
    }
    assertProject(projectId, edge.projectId, `edge ${edge.id}`)
    if (from.projectId !== to.projectId) {
      throw new WorkflowChangeImpactError('cross_project_reference', `edge ${edge.id} crosses project boundary`)
    }
    const list = outgoing.get(from.id) ?? []
    list.push(edge)
    outgoing.set(from.id, list)
  }
  for (const list of outgoing.values()) list.sort((left, right) => left.id.localeCompare(right.id))

  const impactById = new Map<string, WorkflowChangeImpactArtifact>()
  const queue = [...changedIds]
  const queued = new Set(queue)
  for (const id of changedIds) {
    impactById.set(id, {
      artifactId: id,
      disposition: protectedIds.has(id) || manuallyModifiedIds.has(id) ? 'protected' : 'rerun',
      reason: protectedIds.has(id) ? 'protected' : manuallyModifiedIds.has(id) ? 'manual_modification' : 'changed'
    })
  }

  while (queue.length > 0) {
    const sourceId = queue.shift()!
    for (const edge of outgoing.get(sourceId) ?? []) {
      const targetId = edge.toArtifactId
      const targetProtected = protectedIds.has(targetId) || manuallyModifiedIds.has(targetId)
      if (!PROPAGATING_RELATIONS.has(edge.relation)) {
        unresolvedReferences.push(`ambiguous-edge:${edge.id}`)
        const current = impactById.get(targetId)
        if (!current || current.disposition !== 'protected') {
          impactById.set(targetId, {
            artifactId: targetId,
            disposition: targetProtected ? 'protected' : 'review',
            reason: targetProtected ? 'protected' : 'ambiguous_relation',
            viaArtifactId: sourceId,
            viaRelation: edge.relation
          })
        }
        continue
      }
      if (!impactById.has(targetId)) {
        impactById.set(targetId, {
          artifactId: targetId,
          disposition: targetProtected ? 'protected' : 'rerun',
          reason: targetProtected ? 'protected' : 'downstream',
          viaArtifactId: sourceId,
          viaRelation: edge.relation
        })
      }
      if (!queued.has(targetId)) {
        queue.push(targetId)
        queued.add(targetId)
      }
    }
  }

  // A WorkItem rerun can rewrite any of its outputs, including a protected
  // sibling outside the traversed subgraph. Without output-level execution
  // constraints the entire affected WorkItem requires human review.
  const protectedWorkItemIds = new Set([...artifactsById.values()]
    .filter((artifact) => protectedIds.has(artifact.id) || manuallyModifiedIds.has(artifact.id))
    .flatMap((artifact) => artifact.workItemId ? [artifact.workItemId] : []))
  const impacts = [...impactById.values()].map((impact): WorkflowChangeImpactArtifact => {
    const workItemId = artifactsById.get(impact.artifactId)?.workItemId
    return impact.disposition === 'rerun' && workItemId && protectedWorkItemIds.has(workItemId)
      ? { ...impact, disposition: 'review', reason: 'protected_work_item' }
      : impact
  }).sort((left, right) => left.artifactId.localeCompare(right.artifactId))
  const impactedIds = impacts.filter((item) => item.disposition === 'rerun').map((item) => item.artifactId)
  const reviewIds = impacts.filter((item) => item.disposition === 'review').map((item) => item.artifactId)
  const protectedImpactIds = impacts.filter((item) => item.disposition === 'protected').map((item) => item.artifactId)
  const impactedForWorkItems = impacts.filter((item) => item.disposition !== 'protected')
  const impactedWorkItemIds = uniqueSorted(impactedForWorkItems.flatMap((item) => {
    const workItemId = artifactsById.get(item.artifactId)?.workItemId
    return workItemId ? [workItemId] : []
  }))
  const rerunWorkItemIds = uniqueSorted(impactedForWorkItems
    .filter((item) => item.disposition === 'rerun')
    .flatMap((item) => {
      const workItemId = artifactsById.get(item.artifactId)?.workItemId
      return workItemId ? [workItemId] : []
    }))
  const reviewWorkItemIds = uniqueSorted(impactedForWorkItems
    .filter((item) => item.disposition === 'review')
    .flatMap((item) => {
      const workItemId = artifactsById.get(item.artifactId)?.workItemId
      return workItemId ? [workItemId] : []
    }))

  const artifactToAcceptanceIds = acceptanceArtifactIndex(input, artifactsById, unresolvedReferences)
  const acceptanceRechecks = input.acceptances
    .filter((acceptance) => shouldRecheckAcceptance(acceptance, impactedWorkItemIds, impacts, artifactToAcceptanceIds))
    .map((acceptance) => ({
      acceptanceId: acceptance.id,
      previousStatus: acceptance.status,
      nextStatus: workflowAcceptanceStatusAfterChange(acceptance.status),
      previousRevision: acceptance.revision,
      nextRevision: acceptance.revision + 1,
      ...(acceptance.workItemId ? { workItemId: acceptance.workItemId } : {}),
      reason: acceptanceReason(acceptance, impactedWorkItemIds, impacts, artifactToAcceptanceIds, artifactsById)
    }))
    .sort((left, right) => left.acceptanceId.localeCompare(right.acceptanceId))

  const base = {
    schemaVersion: 1 as const,
    contract: 'workflow-change-impact-v1' as const,
    ...(projectId ? { projectId } : {}),
    changedArtifactIds: [...changedIds].sort(),
    artifacts: impacts,
    impactedArtifactIds: impactedIds,
    reviewArtifactIds: reviewIds,
    protectedArtifactIds: protectedImpactIds,
    impactedWorkItemIds,
    rerunWorkItemIds,
    reviewWorkItemIds,
    acceptanceRechecks,
    unresolvedReferences: uniqueSorted(unresolvedReferences)
  }
  return { ...base, planDigest: digest(base) }
}

/** Apply only the planned Acceptance state transition; persistence remains the caller's transaction. */
export function applyWorkflowAcceptanceRechecks(
  acceptances: readonly WorkflowAcceptanceRecord[],
  plan: WorkflowChangeImpactPlan,
  now: number
): WorkflowAcceptanceRecord[] {
  if (!Number.isFinite(now)) throw new WorkflowChangeImpactError('invalid_input', 'acceptance update time must be finite')
  const rechecks = new Map(plan.acceptanceRechecks.map((item) => [item.acceptanceId, item]))
  return acceptances.map((acceptance) => {
    const recheck = rechecks.get(acceptance.id)
    if (!recheck) return structuredClone(acceptance)
    if (acceptance.revision !== recheck.previousRevision || acceptance.status !== recheck.previousStatus ||
      recheck.nextRevision !== acceptance.revision + 1 ||
      recheck.nextStatus !== workflowAcceptanceStatusAfterChange(acceptance.status)) {
      throw new WorkflowChangeImpactError('invalid_acceptance_revision', `acceptance ${acceptance.id} changed after impact plan`)
    }
    return {
      ...structuredClone(acceptance),
      status: recheck.nextStatus,
      evidenceRefs: [],
      criterionEvidence: undefined,
      revision: recheck.nextRevision,
      updatedAt: now,
      verifier: undefined,
      verifiedAt: undefined,
      waiverReason: undefined,
      waivedBy: undefined,
      notes: appendNote(acceptance.notes, `recheck required by change impact ${plan.planDigest}`)
    }
  })
}

function indexArtifacts(input: WorkflowChangeImpactInput): Map<string, WorkflowArtifactRecord> {
  const byId = new Map<string, WorkflowArtifactRecord>()
  for (const artifact of input.artifacts) {
    if (!artifact.id || byId.has(artifact.id)) {
      throw new WorkflowChangeImpactError('duplicate_artifact', `artifact ${artifact.id || '<empty>'} is duplicated or invalid`)
    }
    assertProject(normalizeOptionalId(input.projectId), artifact.projectId, `artifact ${artifact.id}`)
    byId.set(artifact.id, artifact)
  }
  return byId
}

function acceptanceArtifactIndex(
  input: WorkflowChangeImpactInput,
  artifactsById: ReadonlyMap<string, WorkflowArtifactRecord>,
  unresolvedReferences: string[]
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  const links = input.evidenceLinks ?? []
  const acceptanceIds = new Set(input.acceptances.map((acceptance) => acceptance.id))
  for (const link of links) {
    if (link.artifactId && !artifactsById.has(link.artifactId)) {
      unresolvedReferences.push(`evidence-link-artifact:${link.id}`)
      continue
    }
    if (link.acceptanceId && !acceptanceIds.has(link.acceptanceId)) {
      throw new WorkflowChangeImpactError('missing_acceptance', `evidence link ${link.id} references missing acceptance ${link.acceptanceId}`)
    }
    if (!link.artifactId || !link.acceptanceId) continue
    const set = index.get(link.artifactId) ?? new Set<string>()
    set.add(link.acceptanceId)
    index.set(link.artifactId, set)
  }
  return index
}

function shouldRecheckAcceptance(
  acceptance: WorkflowAcceptanceRecord,
  impactedWorkItemIds: readonly string[],
  impacts: readonly WorkflowChangeImpactArtifact[],
  artifactToAcceptanceIds: ReadonlyMap<string, ReadonlySet<string>>
): boolean {
  if (acceptance.workItemId && impactedWorkItemIds.includes(acceptance.workItemId)) return true
  return impacts.some((impact) => artifactToAcceptanceIds.get(impact.artifactId)?.has(acceptance.id))
}

function acceptanceReason(
  acceptance: WorkflowAcceptanceRecord,
  impactedWorkItemIds: readonly string[],
  impacts: readonly WorkflowChangeImpactArtifact[],
  artifactToAcceptanceIds: ReadonlyMap<string, ReadonlySet<string>>,
  artifactsById: ReadonlyMap<string, WorkflowArtifactRecord>
): WorkflowAcceptanceRecheck['reason'] {
  const linked = impacts.find((impact) => artifactToAcceptanceIds.get(impact.artifactId)?.has(acceptance.id))
  if (linked?.disposition === 'protected' || linked?.reason === 'protected_work_item') return 'protected_artifact'
  if (linked?.reason === 'ambiguous_relation') return 'ambiguous_artifact'
  if (linked?.reason === 'changed') return 'changed_artifact'
  if (acceptance.workItemId && impactedWorkItemIds.includes(acceptance.workItemId)) {
    const scoped = impacts.filter((impact) => artifactsById.get(impact.artifactId)?.workItemId === acceptance.workItemId)
    if (scoped.some((impact) => impact.reason === 'changed' && impact.disposition !== 'protected')) return 'changed_artifact'
    if (scoped.some((impact) => impact.reason === 'ambiguous_relation')) return 'ambiguous_artifact'
    if (scoped.some((impact) => impact.disposition === 'protected' || impact.reason === 'protected_work_item')) return 'protected_artifact'
    return 'downstream_artifact'
  }
  return 'downstream_artifact'
}

function assertProject(expected: string | undefined, actual: string | undefined, label: string): void {
  if (expected !== undefined && actual !== expected) {
    throw new WorkflowChangeImpactError('cross_project_reference', `${label} is outside project ${expected}`)
  }
}

function normalizeOptionalId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (!normalized) throw new WorkflowChangeImpactError('invalid_input', 'identifier must not be empty')
  return normalized
}

function uniqueRequiredIds(values: readonly string[], label: string): string[] {
  return [...new Set(values.map((value) => {
    const normalized = normalizeOptionalId(value)
    if (!normalized) throw new WorkflowChangeImpactError('invalid_input', `${label} id must not be empty`)
    return normalized
  }))]
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function appendNote(existing: string | undefined, note: string): string {
  return existing ? `${existing}\n${note}` : note
}

// Keep this imported helper visible to static consumers that compare the plan
// payload without recomputing its digest themselves.
export function canonicalWorkflowChangeImpactPlan(plan: Omit<WorkflowChangeImpactPlan, 'planDigest'>): string {
  return canonicalJson(plan)
}

// Source dependency recall is re-exported here so V2-011 consumers can use a
// single change-impact contract entrypoint. The implementation remains in a
// separate module to keep the core planner pure and testable.
export {
  buildWorkflowChangeImpactPlanFromSources,
  recallWorkflowSourceDependencies
} from './workflow-source-impact'
export type {
  WorkflowSourceChangeImpactInput,
  WorkflowSourceChangeImpactPlan,
  WorkflowSourceDependencyRecall,
  WorkflowSourceDependencyRecallInput,
  WorkflowSourceFileInput
} from './workflow-source-impact'
