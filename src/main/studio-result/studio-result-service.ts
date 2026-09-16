import type { HistoryEntry, SessionMeta } from '../../shared/types'
import type { ProjectAggregateSnapshot } from '../../shared/project-aggregate-types'
import {
  STUDIO_RESULT_EXPORT_FORMAT,
  STUDIO_RESULT_FORMAT,
  STUDIO_RESULT_SCHEMA_VERSION,
  type StudioResultAcceptance,
  type StudioResultArtifact,
  type StudioResultArtifactDeliveryStatus,
  type StudioResultDeliveryCategory,
  type StudioResultCostSummary,
  type StudioResultEvidence,
  type StudioResultExportResult,
  type StudioResultIssue,
  type StudioResultRun,
  type StudioResultSnapshot,
  type StudioResultTest,
  type StudioResultTestStatus,
  type StudioResultTimelineItem,
  type StudioResultWorkItem
} from '../../shared/studio-result-types'
import type {
  WorkflowAcceptanceRecord,
  WorkflowEvidenceLinkRecord,
  WorkflowEvidenceRecord
} from '../../shared/workflow-types'
import {
  assertNoCredentialMaterial,
  projectAggregateCanonicalJson,
  projectAggregateDigest
} from '../project-aggregate/codec'
import { workflowAcceptanceRepairWorkItemId } from '../task/workflow-acceptance-repair-coordinator'
import { assertWorkflowArtifactUriSafe } from '../task/workflow-ledger-artifact-security'
import {
  artifactAcceptanceDeliveryScope,
  currentArtifactLineageLeafIds,
  currentArtifactLineageLeafIdsByArtifact
} from '../task/artifact-lineage'

const TERMINAL_WORK_ITEM_STATUSES = new Set(['done', 'failed', 'cancelled'])
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const CHANGE_ARTIFACT_KINDS = new Set(['patch', 'diff', 'code', 'source', 'pull_request'])
const TEST_EVIDENCE_KINDS = new Set(['test_result', 'security_scan', 'delivery_check', 'review_result'])

export function buildStudioResultSnapshot(
  session: SessionMeta,
  aggregate: ProjectAggregateSnapshot | undefined,
  sessionCosts: ReadonlyArray<Pick<SessionMeta | HistoryEntry, 'id' | 'costUsd'>> = [],
  now = Date.now()
): StudioResultSnapshot {
  assertSessionScope(session)
  assertTimestamp(now)
  if (!session.workspaceId) return buildUnboundSnapshot(session.id, now)
  if (!aggregate) throw new Error(`Studio result aggregate is missing for Project ${session.workspaceId}`)
  assertAggregateScope(session, aggregate)

  const {
    goal,
    workItems,
    workItemIds,
    runs,
    runIds,
    artifacts,
    artifactIds,
    acceptances,
    acceptanceIds,
    evidenceLinks,
    workflowEvidence,
    taskEvidence
  } = selectResultRecords(session, aggregate)
  const costBySession = normalizedSessionCosts(sessionCosts)
  const projectedRuns = runs.map((run) => projectRun(run, costBySession.get(run.sessionId)))
  const projectedAcceptances = acceptances.map((acceptance) =>
    projectAcceptance(acceptance, aggregate.workItems, evidenceLinks, aggregate.workflow.artifacts))
  const blockingAcceptances = projectedAcceptances.filter((acceptance) =>
    acceptance.deliveryScope === 'blocking')
  // A repair can emit the successor from a different WorkItem. Resolve
  // deliverable leaves against the whole Project, then keep this result view
  // ownership-scoped when projecting records below.
  const currentArtifactIds = currentArtifactLineageLeafIds(aggregate.workflow.artifacts)
  const currentArtifactIdsByArtifact = currentArtifactLineageLeafIdsByArtifact(aggregate.workflow.artifacts)
  const projectedArtifacts = artifacts.map((artifact) => projectArtifact(
    artifact,
    aggregate,
    evidenceLinks,
    acceptanceIds,
    currentArtifactIds,
    currentArtifactIdsByArtifact,
    new Map(projectedAcceptances.map((acceptance) => [acceptance.id, acceptance.status]))
  ))
  const projectedEvidence = projectEvidence(workflowEvidence, taskEvidence)
  const tests = buildTests(projectedArtifacts, workflowEvidence, projectedAcceptances, evidenceLinks)
  const risks = buildRisks(goal, workItems, projectedRuns, projectedArtifacts, blockingAcceptances)
  const openItems = buildOpenItems(workItems, projectedRuns, projectedArtifacts, blockingAcceptances)
  const approvals = buildApprovals(goal, workItems, projectedRuns, workflowEvidence, blockingAcceptances)
  const timeline = selectTimeline(aggregate, session, workItemIds, runIds, artifactIds, acceptanceIds)
  const cost = buildCostSummary(projectedRuns)

  const withoutVerification = {
    schemaVersion: STUDIO_RESULT_SCHEMA_VERSION,
    format: STUDIO_RESULT_FORMAT,
    state: 'ready' as const,
    generatedAt: now,
    scope: {
      sessionId: session.id,
      level: session.workItemId ? 'work_item' as const : session.goalId ? 'goal' as const : 'project' as const,
      workspaceId: session.workspaceId,
      ...(session.goalId ? { goalId: session.goalId } : {}),
      ...(session.workItemId ? { workItemId: session.workItemId } : {})
    },
    workspace: {
      id: aggregate.workspace.id,
      name: aggregate.workspace.name,
      kind: aggregate.workspace.kind,
      status: aggregate.workspace.status,
      revision: aggregate.workspace.revision
    },
    ...(goal ? { goal: {
      id: goal.id,
      title: goal.title,
      objective: goal.objective,
      status: goal.status,
      riskLevel: goal.riskLevel,
      constraints: [...goal.constraints],
      successCriteria: [...goal.successCriteria],
      ...(goal.dueAt === undefined ? {} : { dueAt: goal.dueAt }),
      revision: goal.revision
    } } : {}),
    workItems: workItems.map(projectWorkItem),
    runs: projectedRuns,
    artifacts: projectedArtifacts,
    evidence: projectedEvidence,
    acceptances: projectedAcceptances,
    tests,
    risks,
    openItems,
    approvals,
    timeline,
    cost,
    summary: {
      runs: projectedRuns.length,
      artifacts: projectedArtifacts.length,
      currentArtifacts: projectedArtifacts.filter((artifact) => artifact.deliveryScope === 'current').length,
      historicalArtifacts: projectedArtifacts.filter((artifact) => artifact.deliveryScope === 'historical').length,
      availableArtifacts: projectedArtifacts.filter((artifact) => artifact.locations.some((location) => location.availability === 'available')).length,
      readyArtifacts: projectedArtifacts.filter((artifact) => artifact.deliveryStatus === 'ready').length,
      attentionArtifacts: projectedArtifacts.filter((artifact) =>
        !['ready', 'superseded'].includes(artifact.deliveryStatus)).length,
      evidence: projectedEvidence.length,
      acceptances: blockingAcceptances.length,
      passedAcceptances: blockingAcceptances.filter((acceptance) => acceptance.status === 'passed').length,
      tests: tests.length,
      changes: projectedArtifacts.filter((artifact) => CHANGE_ARTIFACT_KINDS.has(artifact.kind)).length,
      openItems: openItems.length,
      approvals: approvals.length,
      risks: risks.length
    }
  }
  const snapshot: StudioResultSnapshot = {
    ...withoutVerification,
    verification: {
      canonicalAggregateVerified: true,
      sanitized: true,
      identityDigest: aggregate.identityDigest,
      aggregateDigest: aggregate.aggregateDigest,
      resultDigest: sha256(withoutVerification)
    }
  }
  assertNoCredentialMaterial(snapshot)
  return snapshot
}

function projectEvidence(
  workflowEvidence: readonly WorkflowEvidenceRecord[],
  taskEvidence: readonly { evidenceId: string; kind?: string; effectId: string; runId: string; observedAt: number; verifier: string; evidenceDigest: string }[]
): StudioResultEvidence[] {
  return [
    ...workflowEvidence.map(projectWorkflowEvidence),
    ...taskEvidence.map((evidence): StudioResultEvidence => ({
      id: evidence.evidenceId,
      origin: 'task_effect',
      kind: evidence.kind ?? 'effect',
      title: `Effect evidence ${shortId(evidence.effectId)}`,
      runId: evidence.runId,
      observedAt: evidence.observedAt,
      verifier: evidence.verifier,
      contentDigest: evidence.evidenceDigest
    }))
  ].sort(byObservedAtThenId)
}

function selectResultRecords(session: SessionMeta, aggregate: ProjectAggregateSnapshot) {
  const goal = session.goalId ? aggregate.goals.find((candidate) => candidate.id === session.goalId) : undefined
  const workItems = selectWorkItems(session, aggregate)
  const workItemIds = new Set(workItems.map((item) => item.id))
  const runs = selectRuns(session, aggregate)
  const runIds = new Set(runs.map((run) => run.id))
  const artifacts = selectArtifacts(session, aggregate, workItems, workItemIds, runIds)
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id))
  const acceptances = selectAcceptances(session, aggregate, workItemIds, runIds, artifactIds)
  const acceptanceIds = new Set(acceptances.map((acceptance) => acceptance.id))
  const evidenceLinks = selectEvidenceLinks(aggregate, runIds, artifactIds, acceptanceIds)
  const workflowEvidence = selectWorkflowEvidence(
    session,
    aggregate,
    workItemIds,
    runIds,
    artifactIds,
    new Set(evidenceLinks.map((link) => link.evidenceId))
  )
  const taskEvidence = aggregate.workflow.taskEvidence.filter((evidence) => runIds.has(evidence.runId))
  return {
    goal, workItems, workItemIds, runs, runIds, artifacts, artifactIds, acceptances,
    acceptanceIds, evidenceLinks, workflowEvidence, taskEvidence
  }
}

function selectRuns(session: SessionMeta, aggregate: ProjectAggregateSnapshot) {
  return aggregate.workflow.runs.filter((run) =>
    session.workItemId ? run.workItemId === session.workItemId
      : session.goalId ? run.goalId === session.goalId
        : true
  )
}

function selectArtifacts(
  session: SessionMeta,
  aggregate: ProjectAggregateSnapshot,
  workItems: ReturnType<typeof selectWorkItems>,
  workItemIds: ReadonlySet<string>,
  runIds: ReadonlySet<string>
) {
  const refs = new Set(workItems.flatMap((item) => item.artifactRefs))
  return aggregate.workflow.artifacts.filter((artifact) =>
    refs.has(artifact.id) ||
    Boolean(artifact.runId && runIds.has(artifact.runId)) ||
    Boolean(artifact.workItemId && workItemIds.has(artifact.workItemId)) ||
    (!session.workItemId && Boolean(session.goalId && artifact.goalId === session.goalId)) ||
    (!session.goalId && !session.workItemId)
  )
}

function selectEvidenceLinks(
  aggregate: ProjectAggregateSnapshot,
  runIds: ReadonlySet<string>,
  artifactIds: ReadonlySet<string>,
  acceptanceIds: ReadonlySet<string>
): WorkflowEvidenceLinkRecord[] {
  return aggregate.workflow.evidenceLinks.filter((link) =>
    Boolean(link.runId && runIds.has(link.runId)) ||
    Boolean(link.artifactId && artifactIds.has(link.artifactId)) ||
    Boolean(link.acceptanceId && acceptanceIds.has(link.acceptanceId))
  )
}

function selectWorkflowEvidence(
  session: SessionMeta,
  aggregate: ProjectAggregateSnapshot,
  workItemIds: ReadonlySet<string>,
  runIds: ReadonlySet<string>,
  artifactIds: ReadonlySet<string>,
  linkedEvidenceIds: ReadonlySet<string>
): WorkflowEvidenceRecord[] {
  return aggregate.workflow.workflowEvidence.filter((evidence) =>
    linkedEvidenceIds.has(evidence.evidenceId) ||
    Boolean(evidence.runId && runIds.has(evidence.runId)) ||
    Boolean(evidence.artifactId && artifactIds.has(evidence.artifactId)) ||
    Boolean(evidence.workItemId && workItemIds.has(evidence.workItemId)) ||
    (!session.workItemId && Boolean(session.goalId && evidence.goalId === session.goalId)) ||
    (!session.goalId && !session.workItemId)
  )
}

export function buildStudioResultExport(snapshot: StudioResultSnapshot): StudioResultExportResult {
  if (snapshot.state !== 'ready' || !snapshot.verification.canonicalAggregateVerified) {
    throw new Error('STUDIO_RESULT_UNBOUND: canonical Project ownership is required before export')
  }
  const withoutDigest = {
    schemaVersion: STUDIO_RESULT_SCHEMA_VERSION,
    format: STUDIO_RESULT_EXPORT_FORMAT,
    snapshot,
    verification: snapshot.verification
  }
  const exportDigest = sha256(withoutDigest)
  const bundle = { ...withoutDigest, exportDigest }
  assertNoCredentialMaterial(bundle)
  return {
    schemaVersion: STUDIO_RESULT_SCHEMA_VERSION,
    format: STUDIO_RESULT_EXPORT_FORMAT,
    json: `${projectAggregateCanonicalJson(bundle)}\n`,
    exportDigest,
    bundle
  }
}

function buildUnboundSnapshot(sessionId: string, now: number): StudioResultSnapshot {
  const withoutVerification = {
    schemaVersion: STUDIO_RESULT_SCHEMA_VERSION,
    format: STUDIO_RESULT_FORMAT,
    state: 'unbound' as const,
    generatedAt: now,
    scope: { sessionId, level: 'conversation' as const },
    workItems: [],
    runs: [],
    artifacts: [],
    evidence: [],
    acceptances: [],
    tests: [],
    risks: [],
    openItems: [],
    approvals: [],
    timeline: [],
    cost: { knownUsd: 0, knownRunCount: 0, totalRunCount: 0, coverage: 'unavailable' as const },
    summary: {
      runs: 0, artifacts: 0, currentArtifacts: 0, historicalArtifacts: 0, availableArtifacts: 0, readyArtifacts: 0, attentionArtifacts: 0, evidence: 0, acceptances: 0,
      passedAcceptances: 0, tests: 0, changes: 0, openItems: 0, approvals: 0, risks: 0
    }
  }
  return {
    ...withoutVerification,
    verification: {
      canonicalAggregateVerified: false,
      sanitized: true,
      resultDigest: sha256(withoutVerification)
    }
  }
}

function assertSessionScope(session: SessionMeta): void {
  if (!session?.id?.trim()) throw new Error('Studio result requires a Session ID')
  if ((session.goalId || session.workItemId) && !session.workspaceId) {
    throw new Error(`Session ${session.id} has canonical child ownership without a Project`)
  }
  if (session.workItemId && !session.goalId) {
    throw new Error(`Session ${session.id} has a WorkItem without a Goal`)
  }
}

function assertAggregateScope(session: SessionMeta, aggregate: ProjectAggregateSnapshot): void {
  if (aggregate.projectId !== session.workspaceId || aggregate.workspace.id !== session.workspaceId) {
    throw new Error(`Studio result Project ownership mismatch for Session ${session.id}`)
  }
  if (session.goalId && !aggregate.goals.some((goal) => goal.id === session.goalId)) {
    throw new Error(`Studio result Goal ${session.goalId} is missing from Project ${aggregate.projectId}`)
  }
  if (session.workItemId) {
    const workItem = aggregate.workItems.find((item) => item.id === session.workItemId)
    if (!workItem) throw new Error(`Studio result WorkItem ${session.workItemId} is missing from Project ${aggregate.projectId}`)
    if (workItem.goalId !== session.goalId) {
      throw new Error(`Studio result WorkItem ${session.workItemId} is not owned by Goal ${session.goalId}`)
    }
  }
}

function selectWorkItems(session: SessionMeta, aggregate: ProjectAggregateSnapshot) {
  if (session.workItemId) return aggregate.workItems.filter((item) => item.id === session.workItemId)
  if (session.goalId) return aggregate.workItems.filter((item) => item.goalId === session.goalId)
  return [...aggregate.workItems]
}

function selectAcceptances(
  session: SessionMeta,
  aggregate: ProjectAggregateSnapshot,
  workItemIds: ReadonlySet<string>,
  runIds: ReadonlySet<string>,
  artifactIds: ReadonlySet<string>
): WorkflowAcceptanceRecord[] {
  const linkedAcceptanceIds = new Set(aggregate.workflow.evidenceLinks.flatMap((link) =>
    link.acceptanceId && (Boolean(link.runId && runIds.has(link.runId)) ||
      Boolean(link.artifactId && artifactIds.has(link.artifactId)))
      ? [link.acceptanceId]
      : []))
  return aggregate.workflow.acceptances.filter((acceptance) =>
    linkedAcceptanceIds.has(acceptance.id) ||
    Boolean(acceptance.workItemId && workItemIds.has(acceptance.workItemId)) ||
    (!session.workItemId && Boolean(session.goalId && acceptance.goalId === session.goalId)) ||
    (!session.goalId && !session.workItemId)
  )
}

function projectWorkItem(item: ProjectAggregateSnapshot['workItems'][number]): StudioResultWorkItem {
  return {
    id: item.id,
    ...(item.goalId ? { goalId: item.goalId } : {}),
    ...(item.parentId ? { parentId: item.parentId } : {}),
    title: item.title,
    ...(item.description ? { description: item.description } : {}),
    type: item.type,
    status: item.status,
    priority: item.priority,
    ...(item.dueAt === undefined ? {} : { dueAt: item.dueAt }),
    ...(item.owner ? { ownerLabel: item.owner.displayName ?? item.owner.id } : {}),
    runRefs: [...item.runRefs],
    artifactRefs: [...item.artifactRefs],
    revision: item.revision
  }
}

function projectRun(
  run: ProjectAggregateSnapshot['workflow']['runs'][number],
  costUsd: number | undefined
): StudioResultRun {
  return {
    id: run.id,
    sessionId: run.sessionId,
    workItemId: run.workItemId,
    status: run.status,
    attempt: run.attempt,
    revision: run.revision,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    taskRunDigest: projectAggregateDigest(run.taskRun),
    ...('error' in run && typeof run.error === 'string' ? { errorDigest: sha256(run.error) } : {}),
    ...(costUsd === undefined ? {} : { costUsd })
  }
}

function projectArtifact(
  artifact: ProjectAggregateSnapshot['workflow']['artifacts'][number],
  aggregate: ProjectAggregateSnapshot,
  links: WorkflowEvidenceLinkRecord[],
  acceptanceIds: ReadonlySet<string>,
  currentArtifactIds: ReadonlySet<string>,
  currentArtifactIdsByArtifact: ReadonlyMap<string, readonly string[]>,
  acceptanceStatusById: ReadonlyMap<string, WorkflowAcceptanceRecord['status']>
): StudioResultArtifact {
  const artifactLinks = links.filter((link) => link.artifactId === artifact.id)
  const locations = aggregate.workflow.artifactLocations
    .filter((location) => location.artifactId === artifact.id)
    .map((location) => ({
      id: location.id,
      kind: location.kind,
      availability: location.availability,
      ...(location.uri ? { uri: location.uri } : {}),
      ...(location.path ? { path: location.path } : {}),
      ...(location.checksum ? { checksum: location.checksum } : {}),
      ...(location.sizeBytes === undefined ? {} : { sizeBytes: location.sizeBytes }),
      ...(location.mediaType ? { mediaType: location.mediaType } : {})
    }))
  const evidenceIds = [...new Set(artifactLinks.map((link) => link.evidenceId))].sort()
  const linkedAcceptanceIds = [...new Set(artifactLinks.flatMap((link) =>
    link.acceptanceId && acceptanceIds.has(link.acceptanceId) ? [link.acceptanceId] : []
  ))].sort()
  const deliveryScope = currentArtifactIds.has(artifact.id) ? 'current' as const : 'historical' as const
  return {
    id: artifact.id,
    ...(artifact.runId ? { runId: artifact.runId } : {}),
    ...(artifact.workItemId ? { workItemId: artifact.workItemId } : {}),
    title: artifact.title,
    kind: artifact.kind,
    version: artifact.version,
    digest: artifact.digest,
    ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
    deliveryCategory: artifactDeliveryCategory(artifact.kind, artifact.mediaType),
    deliveryStatus: artifactDeliveryStatus(
      deliveryScope,
      locations.some((location) => location.availability === 'available'),
      evidenceIds,
      linkedAcceptanceIds,
      acceptanceStatusById
    ),
    ...(artifact.supersedesId ? { supersedesId: artifact.supersedesId } : {}),
    currentArtifactIds: [...(currentArtifactIdsByArtifact.get(artifact.id) ?? [])],
    deliveryScope,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    locations,
    inboundRelations: aggregate.workflow.artifactEdges.filter((edge) => edge.toArtifactId === artifact.id).length,
    outboundRelations: aggregate.workflow.artifactEdges.filter((edge) => edge.fromArtifactId === artifact.id).length,
    evidenceIds,
    acceptanceIds: linkedAcceptanceIds
  }
}

function artifactDeliveryCategory(
  kind: ProjectAggregateSnapshot['workflow']['artifacts'][number]['kind'],
  mediaType?: string
): StudioResultDeliveryCategory {
  if (['document', 'spreadsheet', 'presentation', 'pdf'].includes(kind)) return 'office'
  if (['source', 'code', 'patch', 'diff', 'pull_request'].includes(kind)) return 'code'
  if (kind === 'release_package') return 'package'
  if (mediaType && /^(image|video|audio)\//.test(mediaType)) return 'media'
  if (['report', 'requirement', 'design', 'test_report'].includes(kind)) return 'report'
  return 'other'
}

function artifactDeliveryStatus(
  scope: StudioResultArtifact['deliveryScope'],
  available: boolean,
  evidenceIds: readonly string[],
  acceptanceIds: readonly string[],
  acceptanceStatusById: ReadonlyMap<string, WorkflowAcceptanceRecord['status']>
): StudioResultArtifactDeliveryStatus {
  if (scope === 'historical') return 'superseded'
  if (!available) return 'unavailable'
  if (evidenceIds.length === 0) return 'evidence_missing'
  if (acceptanceIds.length === 0) return 'verification_pending'
  const statuses = acceptanceIds.map((id) => acceptanceStatusById.get(id))
  if (statuses.includes('failed')) return 'failed'
  return statuses.every((status) => status === 'passed' || status === 'waived')
    ? 'ready'
    : 'verification_pending'
}

function projectWorkflowEvidence(evidence: WorkflowEvidenceRecord): StudioResultEvidence {
  const sourceUri = researchSourceUri(evidence)
  return {
    id: evidence.evidenceId,
    origin: 'workflow',
    kind: evidence.kind,
    source: evidence.source,
    title: evidence.title,
    ...(evidence.summary ? { summary: evidence.summary } : {}),
    ...(sourceUri ? { sourceUri } : {}),
    ...(evidence.kind === 'research_source' && evidence.metadata?.contentKind === 'search_snippet'
      ? { sourceContentKind: 'search_snippet' as const } : {}),
    ...(evidence.runId ? { runId: evidence.runId } : {}),
    ...(evidence.artifactId ? { artifactId: evidence.artifactId } : {}),
    observedAt: evidence.observedAt,
    verifier: evidence.verifier,
    contentDigest: evidence.contentDigest
  }
}

function researchSourceUri(evidence: WorkflowEvidenceRecord): string | undefined {
  if (evidence.kind !== 'research_source' || !evidence.uri || evidence.uri.includes('[REDACTED]')) return undefined
  try {
    const url = new URL(evidence.uri)
    if (!['https:', 'http:'].includes(url.protocol)) return undefined
    assertWorkflowArtifactUriSafe(evidence.uri)
    return evidence.uri
  } catch { return undefined }
}

function projectAcceptance(
  acceptance: WorkflowAcceptanceRecord,
  workItems: ProjectAggregateSnapshot['workItems'],
  links: readonly WorkflowEvidenceLinkRecord[],
  artifacts: ProjectAggregateSnapshot['workflow']['artifacts']
): StudioResultAcceptance {
  const covered = new Set((acceptance.criterionEvidence ?? [])
    .filter((criterion) => criterion.evidenceRefs.length > 0)
    .map((criterion) => criterion.criterionIndex))
  const repair = acceptance.status === 'failed'
    ? workItems.find((item) => item.id === workflowAcceptanceRepairWorkItemId(acceptance.id, acceptance.revision))
    : undefined
  const linkedArtifactIds = new Set(links.flatMap((link) =>
    link.acceptanceId === acceptance.id && link.artifactId ? [link.artifactId] : []))
  const deliveryScope = artifactAcceptanceDeliveryScope(linkedArtifactIds, artifacts)
  return {
    id: acceptance.id,
    ...(acceptance.goalId ? { goalId: acceptance.goalId } : {}),
    ...(acceptance.workItemId ? { workItemId: acceptance.workItemId } : {}),
    status: acceptance.status,
    deliveryScope,
    criteria: [...acceptance.criteria],
    coveredCriteria: covered.size,
    evidenceRefs: [...acceptance.evidenceRefs],
    ...(acceptance.verifier ? { verifier: acceptance.verifier } : {}),
    ...(acceptance.verifiedAt === undefined ? {} : { verifiedAt: acceptance.verifiedAt }),
    ...(acceptance.waiverReason ? { waiverReason: acceptance.waiverReason } : {}),
    ...(acceptance.waivedBy ? { waivedBy: acceptance.waivedBy } : {}),
    ...(acceptance.notes ? { notes: acceptance.notes } : {}),
    ...(repair ? { repairWorkItemId: repair.id, repairWorkItemStatus: repair.status } : {}),
    revision: acceptance.revision,
    updatedAt: acceptance.updatedAt
  }
}

function buildTests(
  artifacts: StudioResultArtifact[],
  evidence: WorkflowEvidenceRecord[],
  acceptances: StudioResultAcceptance[],
  links: WorkflowEvidenceLinkRecord[]
): StudioResultTest[] {
  const acceptanceById = new Map(acceptances.map((acceptance) => [acceptance.id, acceptance]))
  const evidenceStatus = (evidenceId: string): StudioResultTestStatus => {
    const statuses = links
      .filter((link) => link.evidenceId === evidenceId && link.acceptanceId)
      .map((link) => acceptanceById.get(link.acceptanceId!)?.status)
    if (statuses.includes('failed')) return 'failed'
    if (statuses.includes('passed')) return 'passed'
    return 'recorded'
  }
  return [
    ...artifacts.filter((artifact) => artifact.kind === 'test_report').map((artifact): StudioResultTest => ({
      id: `artifact:${artifact.id}`,
      title: artifact.title,
      status: artifact.acceptanceIds.some((id) => acceptanceById.get(id)?.status === 'failed')
        ? 'failed'
        : artifact.acceptanceIds.some((id) => acceptanceById.get(id)?.status === 'passed') ? 'passed' : 'recorded',
      source: 'artifact',
      artifactId: artifact.id,
      digest: artifact.digest,
      observedAt: artifact.updatedAt
    })),
    ...evidence.filter((item) => TEST_EVIDENCE_KINDS.has(item.kind)).map((item): StudioResultTest => ({
      id: `evidence:${item.evidenceId}`,
      title: item.title,
      status: evidenceStatus(item.evidenceId),
      source: 'evidence',
      evidenceId: item.evidenceId,
      digest: item.contentDigest,
      observedAt: item.observedAt
    }))
  ].sort((left, right) => left.observedAt - right.observedAt || left.id.localeCompare(right.id))
}

function buildRisks(
  goal: ProjectAggregateSnapshot['goals'][number] | undefined,
  workItems: ProjectAggregateSnapshot['workItems'],
  runs: StudioResultRun[],
  artifacts: StudioResultArtifact[],
  acceptances: StudioResultAcceptance[]
): StudioResultIssue[] {
  const risks: StudioResultIssue[] = []
  if (goal && goal.riskLevel !== 'low') {
    risks.push(issue('risk', goal.riskLevel === 'high' ? 'critical' : 'warning', `Goal 风险级别：${goal.riskLevel}`, goal.status, 'goal', goal.id))
  }
  for (const item of workItems.filter((candidate) => candidate.status === 'blocked' || candidate.status === 'failed')) {
    risks.push(issue('risk', item.status === 'failed' ? 'critical' : 'warning', item.title, item.status, 'work_item', item.id))
  }
  for (const run of runs.filter((candidate) => candidate.status === 'failed' || candidate.status === 'waiting_reconciliation')) {
    risks.push(issue('risk', 'critical', `Run ${shortId(run.id)}`, run.status, 'run', run.id))
  }
  for (const acceptance of acceptances.filter((candidate) => candidate.status === 'failed')) {
    risks.push(issue('risk', 'critical', `验收 ${shortId(acceptance.id)} 未通过`, acceptance.status, 'acceptance', acceptance.id))
  }
  for (const artifact of artifacts) {
    for (const location of artifact.locations.filter((candidate) => ['unavailable', 'deleted'].includes(candidate.availability))) {
      risks.push(issue('risk', 'warning', `${artifact.title} 不可用`, location.availability, 'artifact', artifact.id, location.id))
    }
  }
  return uniqueIssues(risks)
}

function buildOpenItems(
  workItems: ProjectAggregateSnapshot['workItems'],
  runs: StudioResultRun[],
  artifacts: StudioResultArtifact[],
  acceptances: StudioResultAcceptance[]
): StudioResultIssue[] {
  return uniqueIssues([
    ...workItems.filter((item) => !TERMINAL_WORK_ITEM_STATUSES.has(item.status))
      .map((item) => issue('open_item', item.status === 'blocked' ? 'critical' : 'info', item.title, item.status, 'work_item', item.id)),
    ...runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status))
      .map((run) => issue('open_item', run.status === 'waiting_reconciliation' ? 'critical' : 'info', `Run ${shortId(run.id)}`, run.status, 'run', run.id)),
    ...acceptances.filter((acceptance) => !['passed', 'waived'].includes(acceptance.status))
      .map((acceptance) => issue('open_item', acceptance.status === 'failed' ? 'critical' : 'info', `验收 ${shortId(acceptance.id)}`, acceptance.status, 'acceptance', acceptance.id)),
    ...artifacts.flatMap((artifact) => artifact.locations
      .filter((location) => location.availability !== 'available')
      .map((location) => issue('open_item', 'warning', `${artifact.title} · ${location.kind}`, location.availability, 'artifact', artifact.id, location.id)))
  ])
}

function buildApprovals(
  goal: ProjectAggregateSnapshot['goals'][number] | undefined,
  workItems: ProjectAggregateSnapshot['workItems'],
  runs: StudioResultRun[],
  evidence: WorkflowEvidenceRecord[],
  acceptances: StudioResultAcceptance[]
): StudioResultIssue[] {
  const approvals: StudioResultIssue[] = []
  if (goal?.status === 'waiting_approval') approvals.push(issue('approval', 'warning', goal.title, goal.status, 'goal', goal.id))
  approvals.push(...workItems.filter((item) => item.status === 'waiting_approval')
    .map((item) => issue('approval', 'warning', item.title, item.status, 'work_item', item.id)))
  approvals.push(...runs.filter((run) => run.status === 'waiting_approval')
    .map((run) => issue('approval', 'warning', `Run ${shortId(run.id)}`, run.status, 'run', run.id)))
  approvals.push(...evidence.filter((item) => item.kind === 'approval')
    .map((item) => issue('approval', 'info', item.title, 'recorded', 'evidence', item.evidenceId)))
  approvals.push(...acceptances.filter((item) => item.status === 'waived')
    .map((item) => issue('approval', 'warning', `验收豁免 ${shortId(item.id)}`, item.status, 'acceptance', item.id)))
  return uniqueIssues(approvals)
}

function selectTimeline(
  aggregate: ProjectAggregateSnapshot,
  session: SessionMeta,
  workItemIds: ReadonlySet<string>,
  runIds: ReadonlySet<string>,
  artifactIds: ReadonlySet<string>,
  acceptanceIds: ReadonlySet<string>
): StudioResultTimelineItem[] {
  const ownedIds = new Set<string>([
    aggregate.projectId,
    ...(session.goalId ? [session.goalId] : []),
    ...workItemIds,
    ...runIds,
    ...artifactIds,
    ...acceptanceIds
  ])
  return aggregate.audit.flatMap((entry) => {
    const value = record(entry.value)
    const entityId = firstString(value, ['entityId', 'workItemId', 'goalId', 'runId', 'artifactId', 'acceptanceId', 'projectId', 'id'])
    if ((session.goalId || session.workItemId) && entityId && !ownedIds.has(entityId)) return []
    const occurredAt = typeof entry.occurredAt === 'number' ? entry.occurredAt : Date.parse(entry.occurredAt)
    if (!Number.isFinite(occurredAt)) return []
    return [{
      id: entry.id,
      source: entry.source,
      occurredAt,
      kind: firstString(value, ['kind', 'type', 'action']) ?? entry.source,
      ...(firstString(value, ['entityType', 'targetType']) ? { entityType: firstString(value, ['entityType', 'targetType']) } : {}),
      ...(entityId ? { entityId } : {})
    }]
  }).sort((left, right) => right.occurredAt - left.occurredAt || left.id.localeCompare(right.id)).slice(0, 100)
}

function buildCostSummary(runs: StudioResultRun[]): StudioResultCostSummary {
  const known = runs.filter((run) => run.costUsd !== undefined)
  return {
    knownUsd: Math.round(known.reduce((total, run) => total + (run.costUsd ?? 0), 0) * 1_000_000) / 1_000_000,
    knownRunCount: known.length,
    totalRunCount: runs.length,
    coverage: known.length === 0 ? 'unavailable' : known.length === runs.length ? 'complete' : 'partial'
  }
}

function normalizedSessionCosts(values: ReadonlyArray<Pick<SessionMeta | HistoryEntry, 'id' | 'costUsd'>>): Map<string, number> {
  const costs = new Map<string, number>()
  for (const value of values) {
    if (!value?.id || !Number.isFinite(value.costUsd) || value.costUsd < 0) continue
    costs.set(value.id, Math.round(value.costUsd * 1_000_000) / 1_000_000)
  }
  return costs
}

function issue(
  kind: StudioResultIssue['kind'],
  severity: StudioResultIssue['severity'],
  title: string,
  status: string,
  refType: StudioResultIssue['refType'],
  refId: string,
  suffix = ''
): StudioResultIssue {
  return { id: `${kind}:${refType}:${refId}${suffix ? `:${suffix}` : ''}`, kind, severity, title, status, refType, refId }
}

function uniqueIssues(items: StudioResultIssue[]): StudioResultIssue[] {
  return [...new Map(items.map((item) => [item.id, item])).values()].sort((left, right) =>
    issueRank(right.severity) - issueRank(left.severity) || left.title.localeCompare(right.title)
  )
}

function issueRank(value: StudioResultIssue['severity']): number {
  return value === 'critical' ? 3 : value === 'warning' ? 2 : 1
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return undefined
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Studio result timestamp must be a non-negative safe integer')
}

function sha256(value: unknown): string {
  return `sha256:${projectAggregateDigest(value)}`
}

function shortId(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value
}

function byObservedAtThenId(left: StudioResultEvidence, right: StudioResultEvidence): number {
  return left.observedAt - right.observedAt || left.id.localeCompare(right.id)
}
