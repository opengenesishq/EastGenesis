import type {
  WorkflowAcceptanceRecord,
  WorkflowEvidenceLinkRecord,
  WorkflowEventRecord,
  WorkflowRunInboxRecord
} from './workflow-types'

export interface RunAcceptanceSelection {
  acceptance?: WorkflowAcceptanceRecord
  contractConfirmed: boolean
  evidenceRefs: string[]
  boundEvidenceRefs: string[]
  missingEvidenceRefs: string[]
}

/** Read-only verification shared by the Inbox and Run detail. A revision is
 * local to an Acceptance; newer status updates do not change its contract. */
export function selectCurrentRunAcceptance(input: {
  run: WorkflowRunInboxRecord
  acceptances: readonly WorkflowAcceptanceRecord[]
  events?: readonly WorkflowEventRecord[]
  evidenceLinks?: readonly WorkflowEvidenceLinkRecord[]
}): RunAcceptanceSelection {
  const { run } = input
  const candidates = input.acceptances.filter(acceptance => sameOwner(acceptance, run) &&
    (!run.acceptanceId || acceptance.id === run.acceptanceId))
  // Legacy unbound Runs may display a single contract as pending, but cannot
  // borrow a completed result or guess between several unrelated contracts.
  if (candidates.length !== 1) return {
    contractConfirmed: false, evidenceRefs: [], boundEvidenceRefs: [], missingEvidenceRefs: []
  }
  const current = candidates[0]
  const revision = run.acceptanceRevision
  const hasBinding = run.acceptanceId === current.id && Number.isSafeInteger(revision) && (revision ?? 0) > 0
  const captured = hasBinding && current.revision > revision!
    ? readBoundContract(input.events ?? [], run)
    : undefined
  const contractConfirmed = hasBinding && (current.revision === revision ||
    (captured !== undefined && sameContract(captured, current)))
  const contract = !contractConfirmed && captured ? captured : current
  const evidenceRefs = [...new Set([
    ...contract.evidenceRefs,
    ...(contract.criterionEvidence ?? []).flatMap(criterion => criterion.evidenceRefs)
  ])].sort()
  const verifyingLinks = (input.evidenceLinks ?? []).filter(link =>
    link.projectId === run.projectId && link.runId === run.id &&
    link.acceptanceId === current.id && link.relation === 'verifies')
  const linkedIds = new Set(verifyingLinks.map(link => link.evidenceId))
  const boundEvidenceRefs = evidenceRefs.filter(id => linkedIds.has(id))
  const missingEvidenceRefs = evidenceRefs.filter(id => !linkedIds.has(id))
  const criterionBindingsValid = (contract.criterionEvidence ?? []).every(criterion =>
    criterion.evidenceRefs.every(id => verifyingLinks.some(link =>
      link.evidenceId === id && link.criterionId === criterion.criterionId)))
  // Empty criteria remain valid. Acceptance waivers are written at WorkItem
  // scope without a Run identity. Their actor/reason alone therefore cannot
  // certify a newer Run: a terminal projection needs this Run's evidence too.
  const runEvidenceConfirmed = contract.evidenceRefs.length > 0 && missingEvidenceRefs.length === 0 && criterionBindingsValid
  const resultConfirmed = current.status === 'passed' ? runEvidenceConfirmed
    : current.status !== 'waived' || Boolean(current.waiverReason && current.waivedBy && runEvidenceConfirmed)
  return {
    acceptance: contractConfirmed && resultConfirmed ? current : {
      ...contract, status: 'pending', verifier: undefined, verifiedAt: undefined, waivedBy: undefined, waiverReason: undefined
    },
    contractConfirmed,
    evidenceRefs,
    boundEvidenceRefs,
    missingEvidenceRefs
  }
}

function readBoundContract(events: readonly WorkflowEventRecord[], run: WorkflowRunInboxRecord): WorkflowAcceptanceRecord | undefined {
  const matches = events.filter(event => event.eventId === `workflow:acceptance:${run.acceptanceId}:revision:${run.acceptanceRevision}`)
  if (matches.length !== 1) return undefined
  const event = matches[0]
  const record = event.payload as unknown as WorkflowAcceptanceRecord
  if (event.entityType !== 'acceptance' || event.entityId !== run.acceptanceId ||
      !['acceptance.created', 'acceptance.updated', 'acceptance.invalidated_by_change'].includes(event.kind) ||
      !sameOwner(event, run) || !sameOwner(record, run) || record.id !== run.acceptanceId ||
      record.schemaVersion !== 1 || record.revision !== run.acceptanceRevision ||
      !Array.isArray(record.criteria) || !record.criteria.every(value => typeof value === 'string') ||
      !Array.isArray(record.evidenceRefs) || !record.evidenceRefs.every(value => typeof value === 'string')) return undefined
  return record
}

function sameOwner(record: { projectId?: string; goalId?: string; workItemId?: string }, run: WorkflowRunInboxRecord): boolean {
  return record.projectId === run.projectId && record.goalId === run.goalId && record.workItemId === run.workItemId
}

function sameContract(left: WorkflowAcceptanceRecord, right: WorkflowAcceptanceRecord): boolean {
  const policies = (record: WorkflowAcceptanceRecord): string => JSON.stringify(record.criterionPolicies?.map(policy => ({
    criterionId: policy.criterionId,
    criterionIndex: policy.criterionIndex,
    evidenceKind: policy.evidenceKind,
    allowedSources: [...policy.allowedSources].sort()
  })).sort((a, b) => a.criterionIndex - b.criterionIndex) ?? null)
  try {
    return JSON.stringify(left.criteria) === JSON.stringify(right.criteria) && policies(left) === policies(right)
  } catch {
    return false
  }
}
