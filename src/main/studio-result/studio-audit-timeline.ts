import type { ModelAttemptRecord } from '../../shared/model-attempt-types'
import type { ProjectAggregateSnapshot } from '../../shared/project-aggregate-types'
import type {
  StudioExecutionAudit,
  StudioResultSnapshot,
  StudioAuditActor,
  StudioAuditTimelineItem,
  StudioAuditTimelinePage,
  StudioAuditTimelineQuery,
  StudioResultScope
} from '../../shared/studio-result-types'
import type { HistoryEntry, SessionMeta, ToolExecutionRecord } from '../../shared/types'
import { assertNoCredentialMaterial, projectAggregateDigest } from '../project-aggregate/codec'
import { projectStudioRunCosts, recordedStudioAttemptCost, type StudioRunCost } from './studio-result-service'
import { redactSensitiveText } from '../security/secret-redaction'
import { normalizeModelExecutorReceipt } from '../task/model-attempt-executor'

const FORMAT = 'caogen.studio-audit-timeline.v1' as const
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MAX_REASON_LENGTH = 500

type AggregateRun = ProjectAggregateSnapshot['workflow']['runs'][number]
type SessionCost = Pick<SessionMeta | HistoryEntry, 'id' | 'costUsd'>

export interface StudioAuditTimelineInput {
  session: SessionMeta
  aggregate: ProjectAggregateSnapshot
  attempts?: readonly ModelAttemptRecord[]
  sessionCosts?: readonly SessionCost[]
  query?: StudioAuditTimelineQuery
}

function buildFullStudioAudit(input: StudioAuditTimelineInput, runId?: string) {
  const scope = auditScope(input.session)
  const selected = selectOwnedRecords(input.session, input.aggregate, runId)
  const attempts = (input.attempts ?? []).filter((attempt) => selected.runIds.has(attempt.runId))
  const costs = projectStudioRunCosts(selected.runs, attempts)
  const items = [
    ...domainItems(input.aggregate, selected, scope),
    ...selected.runs.map((run) => runItem(run, input.aggregate, costs.get(run.id)!)),
    ...selected.runs.flatMap((run) => toolItems(run, input.aggregate)),
    ...selected.runs.flatMap((run) => effectItems(run, input.aggregate)),
    ...attempts.map((attempt) => modelAttemptItem(attempt, selected.runById, input.aggregate)),
    ...evidenceItems(input.aggregate, selected),
    ...acceptanceItems(input.aggregate, selected),
    ...missingReferenceItems(input.aggregate, selected)
  ].sort(byNewestThenId)
  const sourceDigest = digest({
    aggregateDigest: input.aggregate.aggregateDigest,
    scope,
    runId,
    attempts: attempts.map((attempt) => attempt.recordDigest),
    costs: [...costs],
    items
  })
  assertNoCredentialMaterial(items)
  return { scope, selected, attempts, items, sourceDigest }
}

/** Uses exactly the same frozen aggregate and Attempt input as the exported result. No UI page limit applies. */
export function buildStudioExecutionAudit(input: StudioAuditTimelineInput, snapshot: StudioResultSnapshot): StudioExecutionAudit {
  const { scope, selected, attempts, items, sourceDigest } = buildFullStudioAudit(input)
  if (digest(scope) !== digest(snapshot.scope) || snapshot.verification.aggregateDigest !== input.aggregate.aggregateDigest ||
      digest(selected.runs.map(run => run.id).sort()) !== digest(snapshot.runs.map(run => run.id).sort())) {
    throw new Error('STUDIO_AUDIT_SCOPE_MISMATCH: result and audit must share one verified input')
  }
  const missingModels = selected.runs.filter(run => {
    const records = attempts.filter(attempt => attempt.runId === run.id)
    return records.length === 0 || (run.taskRun.steps ?? []).some(step => !records.some(attempt => attempt.stepId === step.id))
  }).map(run => run.id)
  const missingExecutors = selected.runs.filter(run => {
    const records = attempts.filter(attempt => attempt.runId === run.id)
    return missingModels.includes(run.id) || records.some(attempt => !attempt.executorReceipt)
  }).map(run => run.id)
  const tools = selected.runs.flatMap(run => run.taskRun.toolExecutions ?? [])
  const permissions = tools.filter(tool => tool.permissionDecision === 'allow' || tool.permissionDecision === 'deny')
  const missingPermissions = selected.runs.filter(run => (run.taskRun.toolExecutions ?? []).some(tool => !tool.permissionDecision)).map(run => run.id)
  const coverage = (recorded: number, total: number, missingRunIds: string[]) => ({
    status: (recorded === 0 ? 'unavailable' : missingRunIds.length > 0 ? 'partial' : 'complete') as 'complete' | 'partial' | 'unavailable',
    recorded, total, missingRunIds
  })
  const audit: StudioExecutionAudit = {
    schemaVersion: 1, format: 'caogen.studio-execution-audit.v1', scope,
    generatedAt: snapshot.generatedAt, aggregateDigest: input.aggregate.aggregateDigest,
    resultDigest: snapshot.verification.resultDigest, sourceDigest, items, total: items.length,
    missingReferences: items.filter(item => item.integrity === 'missing_reference').length,
    coverage: {
      modelAttempts: coverage(selected.runs.filter(run => attempts.some(attempt => attempt.runId === run.id)).length, selected.runs.length, missingModels),
      executors: coverage(selected.runs.filter(run => attempts.some(attempt => attempt.runId === run.id && attempt.executorReceipt)).length,
        selected.runs.length, missingExecutors),
      permissions: coverage(permissions.length, tools.length, missingPermissions)
    }
  }
  assertNoCredentialMaterial(audit)
  return audit
}

export function buildStudioAuditTimelinePage(input: StudioAuditTimelineInput): StudioAuditTimelinePage {
  const query = normalizeQuery(input.query)
  const { scope, items, sourceDigest } = buildFullStudioAudit(input, query.runId)
  const offset = query.cursor ? decodeCursor(query.cursor, sourceDigest, query.runId) : 0
  const pageItems = items.slice(offset, offset + query.limit)
  const hasMore = offset + pageItems.length < items.length
  const missingReferences = items.filter((item) => item.integrity === 'missing_reference').length
  const withoutPageDigest = {
    schemaVersion: 1 as const,
    format: FORMAT,
    state: 'ready' as const,
    scope,
    items: pageItems,
    total: items.length,
    hasMore,
    ...(hasMore ? { nextCursor: encodeCursor(offset + pageItems.length, sourceDigest, query.runId) } : {}),
    integrity: {
      projectAggregate: 'verified' as const,
      modelAttemptLedger: 'verified' as const,
      missingReferences,
      sourceDigest
    }
  }
  const page: StudioAuditTimelinePage = {
    ...withoutPageDigest,
    integrity: {
      ...withoutPageDigest.integrity,
      pageDigest: digest(withoutPageDigest)
    }
  }
  assertNoCredentialMaterial(page)
  return page
}

export function buildUnboundStudioAuditTimeline(session: SessionMeta): StudioAuditTimelinePage {
  return {
    schemaVersion: 1,
    format: FORMAT,
    state: 'unbound',
    scope: auditScope(session),
    items: [],
    total: 0,
    hasMore: false,
    integrity: {
      projectAggregate: 'unavailable',
      modelAttemptLedger: 'unavailable',
      missingReferences: 0
    }
  }
}

export function buildFailedStudioAuditTimeline(
  session: SessionMeta,
  errorCode: NonNullable<StudioAuditTimelinePage['errorCode']>
): StudioAuditTimelinePage {
  return {
    schemaVersion: 1,
    format: FORMAT,
    state: 'integrity_error',
    scope: auditScope(session),
    items: [],
    total: 0,
    hasMore: false,
    integrity: {
      projectAggregate: errorCode === 'PROJECT_INTEGRITY' ? 'failed' : 'unavailable',
      modelAttemptLedger: errorCode === 'MODEL_ATTEMPT_INTEGRITY' ? 'failed' : 'unavailable',
      missingReferences: 0
    },
    errorCode
  }
}

function auditScope(session: SessionMeta): StudioResultScope {
  return {
    sessionId: session.id,
    level: session.workItemId ? 'work_item' : session.goalId ? 'goal' : session.workspaceId ? 'project' : 'conversation',
    ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
    ...(session.goalId ? { goalId: session.goalId } : {}),
    ...(session.workItemId ? { workItemId: session.workItemId } : {})
  }
}

function normalizeQuery(query: StudioAuditTimelineQuery | undefined): Required<Pick<StudioAuditTimelineQuery, 'limit'>> & Omit<StudioAuditTimelineQuery, 'limit'> {
  const limit = query?.limit ?? DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`Studio audit timeline limit must be between 1 and ${MAX_LIMIT}`)
  }
  if (query?.runId !== undefined && (!query.runId.trim() || query.runId.includes('\0'))) {
    throw new Error('Studio audit timeline Run ID is invalid')
  }
  if (query?.cursor !== undefined && (!query.cursor || query.cursor.length > 2048)) {
    throw new Error('Studio audit timeline cursor is invalid')
  }
  return {
    limit,
    ...(query?.runId ? { runId: query.runId.trim() } : {}),
    ...(query?.cursor ? { cursor: query.cursor } : {})
  }
}

function selectOwnedRecords(session: SessionMeta, aggregate: ProjectAggregateSnapshot, runFilter?: string) {
  const workItems = session.workItemId
    ? aggregate.workItems.filter((item) => item.id === session.workItemId)
    : session.goalId
      ? aggregate.workItems.filter((item) => item.goalId === session.goalId)
      : aggregate.workItems
  const workItemIds = new Set(workItems.map((item) => item.id))
  let runs = aggregate.workflow.runs.filter((run) => workItemIds.has(run.workItemId))
  if (runFilter) {
    if (!runs.some((run) => run.id === runFilter)) throw new Error('Studio audit timeline Run is outside the Session scope')
    runs = runs.filter((run) => run.id === runFilter)
  }
  const runIds = new Set(runs.map((run) => run.id))
  const sessionIds = new Set(runs.map((run) => run.sessionId))
  const runFiltered = Boolean(runFilter)
  const artifactIds = new Set(aggregate.workflow.artifacts.filter((artifact) =>
    runFiltered
      ? Boolean(artifact.runId && runIds.has(artifact.runId))
      : Boolean(artifact.runId && runIds.has(artifact.runId)) || Boolean(artifact.workItemId && workItemIds.has(artifact.workItemId))
  ).map((artifact) => artifact.id))
  // Artifact checks intentionally have no WorkItem ownership: their result
  // cannot approve the whole task. Include them through the existing evidence
  // bindings without changing that authority boundary.
  const linkedAcceptanceIds = new Set(aggregate.workflow.evidenceLinks.flatMap((link) =>
    link.acceptanceId && (Boolean(link.runId && runIds.has(link.runId)) ||
      ((!runFiltered || !link.runId) && Boolean(link.artifactId && artifactIds.has(link.artifactId))))
      ? [link.acceptanceId]
      : []))
  const acceptances = aggregate.workflow.acceptances.filter((acceptance) =>
    linkedAcceptanceIds.has(acceptance.id) ||
    Boolean(acceptance.workItemId && workItemIds.has(acceptance.workItemId)) ||
    (!session.workItemId && Boolean(session.goalId && acceptance.goalId === session.goalId)) ||
    (!session.goalId && !session.workItemId)
  )
  const acceptanceIds = new Set(acceptances.map((acceptance) => acceptance.id))
  return {
    workItems,
    workItemIds,
    runs,
    runIds,
    runById: new Map(runs.map((run) => [run.id, run])),
    sessionIds,
    runFiltered,
    artifactIds,
    acceptances,
    acceptanceIds
  }
}

function domainItems(
  aggregate: ProjectAggregateSnapshot,
  selected: ReturnType<typeof selectOwnedRecords>,
  scope: StudioResultScope
): StudioAuditTimelineItem[] {
  const ownedIds = new Set([
    ...(!scope.goalId && !scope.workItemId ? [aggregate.projectId] : []),
    ...(scope.goalId && !scope.workItemId ? [scope.goalId] : []),
    ...selected.workItemIds,
    ...selected.runIds,
    ...selected.artifactIds,
    ...selected.acceptanceIds
  ])
  return aggregate.audit.flatMap((entry) => {
    const value = record(entry.value)
    const entityId = firstString(value, ['entityId', 'workItemId', 'goalId', 'runId', 'artifactId', 'acceptanceId', 'projectId', 'id'])
    if ((scope.goalId || scope.workItemId) && (!entityId || !ownedIds.has(entityId))) return []
    const occurredAt = timestamp(entry.occurredAt)
    if (occurredAt === undefined) return []
    const runId = firstString(value, ['runId']) ?? (selected.runIds.has(entityId ?? '') ? entityId : undefined)
    const run = runId ? selected.runById.get(runId) : undefined
    const status = firstString(value, ['status', 'state', 'result']) ?? 'recorded'
    return [{
      id: `domain:${entry.id}`,
      occurredAt,
      category: 'domain' as const,
      action: firstString(value, ['kind', 'type', 'action']) ?? entry.source,
      status,
      actor: actorForRun(run, aggregate),
      projectId: aggregate.projectId,
      ...(scope.goalId ? { goalId: scope.goalId } : {}),
      ...(run?.workItemId ? { workItemId: run.workItemId } : {}),
      ...(runId ? { runId } : {}),
      ...(firstString(value, ['entityType', 'targetType']) ? { entityType: firstString(value, ['entityType', 'targetType']) } : {}),
      ...(entityId ? { entityId } : {}),
      ...(safeReason(firstString(value, ['reason', 'routeReason', 'message'])) ? { reason: safeReason(firstString(value, ['reason', 'routeReason', 'message'])) } : {}),
      ...(safeDigest(firstString(value, ['resultDigest', 'outputDigest', 'contentDigest', 'digest']))
        ? { resultDigest: safeDigest(firstString(value, ['resultDigest', 'outputDigest', 'contentDigest', 'digest'])) }
        : {}),
      integrity: 'verified' as const
    }]
  })
}

function runItem(run: AggregateRun, aggregate: ProjectAggregateSnapshot, cost: StudioRunCost): StudioAuditTimelineItem {
  return {
    id: `run:${run.id}:${run.revision}`,
    occurredAt: run.finishedAt ?? run.updatedAt,
    category: 'run',
    action: `run.${run.status}`,
    status: run.status,
    actor: actorForRun(run, aggregate),
    projectId: aggregate.projectId,
    ...(run.goalId ? { goalId: run.goalId } : {}),
    workItemId: run.workItemId,
    runId: run.id,
    entityType: 'run',
    entityId: run.id,
    ...cost,
    ...(run.taskRun.routingPolicy?.executionDomain ? { executionDomain: run.taskRun.routingPolicy.executionDomain } : {}),
    resultDigest: prefixedDigest(projectAggregateDigest(run.taskRun)),
    integrity: 'verified'
  }
}

function modelAttemptItem(
  attempt: ModelAttemptRecord,
  runs: ReadonlyMap<string, AggregateRun>,
  aggregate: ProjectAggregateSnapshot
): StudioAuditTimelineItem {
  const run = runs.get(attempt.runId)
  const reason = safeReason(attempt.routeReason)
  const costUsd = recordedStudioAttemptCost(attempt)
  const executorReceipt = normalizeModelExecutorReceipt(attempt.executorReceipt, attempt)
  return {
    id: `model-attempt:${attempt.id}:${attempt.revision}`,
    occurredAt: attempt.completedAt ?? attempt.startedAt,
    category: 'model_attempt',
    action: `model_attempt.${attempt.status}`,
    status: attempt.outcome ?? attempt.status,
    actor: actorForRun(run, aggregate),
    projectId: aggregate.projectId,
    ...(run?.goalId ? { goalId: run.goalId } : {}),
    workItemId: run?.workItemId ?? attempt.workItemId,
    runId: attempt.runId,
    entityType: 'model_attempt',
    entityId: attempt.id,
    ...(reason ? { reason } : {}),
    providerId: compact(attempt.providerId, 160),
    model: compact(attempt.model, 160),
    protocol: compact(attempt.protocol, 120),
    adapterVersion: compact(attempt.adapterVersion, 160),
    ...(executorReceipt ? { executorReceipt, executionDomain: executorReceipt.executionDomain } : {}),
    requestId: attempt.requestId,
    ...(attempt.keyLabel ? { keyLabel: compact(attempt.keyLabel, 120) } : {}),
    ...(costUsd === undefined ? {} : { costUsd }),
    resultDigest: prefixedDigest(attempt.recordDigest),
    integrity: 'verified'
  }
}

function toolItems(run: AggregateRun, aggregate: ProjectAggregateSnapshot): StudioAuditTimelineItem[] {
  return (run.taskRun.toolExecutions ?? []).map((tool) => ({
    id: `tool:${run.id}:${tool.id}:${tool.status}`,
    occurredAt: tool.finishedAt ?? tool.updatedAt,
    category: 'tool',
    action: `tool.${tool.status}`,
    status: tool.permissionDecision === 'deny' ? 'denied' : tool.status,
    actor: actorForRun(run, aggregate),
    projectId: aggregate.projectId,
    ...(run.goalId ? { goalId: run.goalId } : {}),
    workItemId: run.workItemId,
    runId: run.id,
    entityType: 'tool_execution',
    entityId: tool.id,
    toolName: tool.toolName,
    ...(tool.permissionDecision ? { reason: `permission:${tool.permissionDecision}`, permissionDecision: tool.permissionDecision } : {}),
    ...(tool.requestId ? { requestId: tool.requestId } : {}),
    ...(tool.approvalResolvedEventId ? { approvalResolvedEventId: tool.approvalResolvedEventId } : {}),
    ...(tool.effectId ? { effectId: tool.effectId } : {}),
    ...(safeDigest(tool.outputDigest) ? { resultDigest: safeDigest(tool.outputDigest) } : {}),
    integrity: 'verified'
  }))
}

function effectItems(run: AggregateRun, aggregate: ProjectAggregateSnapshot): StudioAuditTimelineItem[] {
  return (run.taskRun.effects ?? []).flatMap((effect) => {
    const actor = actorForRun(run, aggregate)
    const base: StudioAuditTimelineItem = {
      id: `effect:${run.id}:${effect.id}:${effect.revision}`,
      occurredAt: effect.terminalAt ?? effect.updatedAt,
      category: 'effect',
      action: `effect.${effect.status}`,
      status: effect.status,
      actor,
      projectId: aggregate.projectId,
      ...(run.goalId ? { goalId: run.goalId } : {}),
      workItemId: run.workItemId,
      runId: run.id,
      entityType: 'effect',
      entityId: effect.id,
      effectId: effect.id,
      toolName: effect.toolName,
      targetKind: effect.target.kind,
      resultDigest: prefixedDigest(effect.targetDigest),
      integrity: 'verified'
    }
    return [base, ...effect.evidence.map((evidence): StudioAuditTimelineItem => ({
      id: `effect-evidence:${run.id}:${effect.id}:${evidence.id}`,
      occurredAt: evidence.observedAt,
      category: 'evidence',
      action: `effect_evidence.${evidence.kind}`,
      status: 'recorded',
      actor: evidence.kind === 'manual_confirmation' ? humanActor(evidence.verifier) : systemActor(evidence.verifier),
      projectId: aggregate.projectId,
      ...(run.goalId ? { goalId: run.goalId } : {}),
      workItemId: run.workItemId,
      runId: run.id,
      entityType: 'effect_evidence',
      entityId: evidence.id,
      effectId: effect.id,
      toolName: effect.toolName,
      targetKind: effect.target.kind,
      resultDigest: prefixedDigest(evidence.digest),
      evidenceId: evidence.id,
      integrity: 'verified'
    }))]
  })
}

function evidenceItems(
  aggregate: ProjectAggregateSnapshot,
  selected: ReturnType<typeof selectOwnedRecords>
): StudioAuditTimelineItem[] {
  const linkedIds = new Set(aggregate.workflow.evidenceLinks.filter((link) =>
    selected.runFiltered
      ? Boolean(link.runId && selected.runIds.has(link.runId)) ||
        (!link.runId && (Boolean(link.acceptanceId && selected.acceptanceIds.has(link.acceptanceId)) ||
          Boolean(link.artifactId && selected.artifactIds.has(link.artifactId))))
      : Boolean(link.runId && selected.runIds.has(link.runId)) ||
        Boolean(link.acceptanceId && selected.acceptanceIds.has(link.acceptanceId)) ||
        Boolean(link.artifactId && selected.artifactIds.has(link.artifactId))
  ).map((link) => link.evidenceId))
  const workflow = aggregate.workflow.workflowEvidence.filter((evidence) =>
    (!evidence.runId || selected.runIds.has(evidence.runId)) &&
    (!evidence.workItemId || selected.workItemIds.has(evidence.workItemId))
  ).filter((evidence) =>
    selected.runFiltered
      ? Boolean(evidence.runId && selected.runIds.has(evidence.runId)) || (!evidence.runId && linkedIds.has(evidence.evidenceId))
      : linkedIds.has(evidence.evidenceId) || Boolean(evidence.runId && selected.runIds.has(evidence.runId)) ||
        Boolean(evidence.workItemId && selected.workItemIds.has(evidence.workItemId))
  ).map((evidence): StudioAuditTimelineItem => ({
    id: `workflow-evidence:${evidence.evidenceId}`,
    occurredAt: evidence.observedAt,
    category: evidence.kind === 'approval' ? 'approval' : 'evidence',
    action: `evidence.${evidence.kind}`,
    status: 'recorded',
    actor: evidence.source === 'human' ? humanActor(evidence.verifier) : systemActor(evidence.verifier),
    projectId: aggregate.projectId,
    ...(evidence.goalId ? { goalId: evidence.goalId } : {}),
    ...(evidence.workItemId ? { workItemId: evidence.workItemId } : {}),
    ...(evidence.runId ? { runId: evidence.runId } : {}),
    entityType: 'evidence',
    entityId: evidence.evidenceId,
    ...(evidence.summary ? { reason: safeReason(evidence.summary) } : {}),
    resultDigest: prefixedDigest(evidence.contentDigest),
    evidenceId: evidence.evidenceId,
    integrity: 'verified'
  }))
  const task = aggregate.workflow.taskEvidence.filter((evidence) => selected.runIds.has(evidence.runId))
    .map((evidence): StudioAuditTimelineItem => ({
      id: `task-evidence:${evidence.evidenceId}`,
      occurredAt: evidence.observedAt,
      category: 'evidence',
      action: `evidence.${evidence.kind ?? 'effect'}`,
      status: 'recorded',
      actor: systemActor(evidence.verifier),
      projectId: aggregate.projectId,
      runId: evidence.runId,
      entityType: 'evidence',
      entityId: evidence.evidenceId,
      resultDigest: prefixedDigest(evidence.evidenceDigest),
      evidenceId: evidence.evidenceId,
      integrity: 'verified'
    }))
  return [...workflow, ...task]
}

function acceptanceItems(
  aggregate: ProjectAggregateSnapshot,
  selected: ReturnType<typeof selectOwnedRecords>
): StudioAuditTimelineItem[] {
  return selected.acceptances.map((acceptance): StudioAuditTimelineItem => ({
    id: `acceptance:${acceptance.id}:${acceptance.revision}`,
    occurredAt: acceptance.verifiedAt ?? acceptance.updatedAt,
    category: 'acceptance',
    action: `acceptance.${acceptance.status}`,
    status: acceptance.status,
    actor: acceptance.verifier || acceptance.waivedBy
      ? humanActor(acceptance.verifier ?? acceptance.waivedBy ?? 'Local user')
      : systemActor('EastGenesis'),
    projectId: aggregate.projectId,
    ...(acceptance.goalId ? { goalId: acceptance.goalId } : {}),
    ...(acceptance.workItemId ? { workItemId: acceptance.workItemId } : {}),
    entityType: 'acceptance',
    entityId: acceptance.id,
    ...(safeReason(acceptance.waiverReason ?? acceptance.notes) ? { reason: safeReason(acceptance.waiverReason ?? acceptance.notes) } : {}),
    resultDigest: prefixedDigest(projectAggregateDigest(acceptance)),
    acceptanceId: acceptance.id,
    integrity: 'verified'
  }))
}

function missingReferenceItems(
  aggregate: ProjectAggregateSnapshot,
  selected: ReturnType<typeof selectOwnedRecords>
): StudioAuditTimelineItem[] {
  const items: StudioAuditTimelineItem[] = []
  const evidenceIds = new Set([
    ...aggregate.workflow.workflowEvidence.map((evidence) => evidence.evidenceId),
    ...aggregate.workflow.taskEvidence.map((evidence) => evidence.evidenceId)
  ])
  const effectIds = new Set(selected.runs.flatMap((run) => (run.taskRun.effects ?? []).map((effect) => effect.id)))
  for (const acceptance of selected.acceptances) {
    for (const evidenceId of acceptance.evidenceRefs.filter((id) => !evidenceIds.has(id))) {
      items.push(missingItem(
        `missing:acceptance:${acceptance.id}:evidence:${evidenceId}`,
        acceptance.updatedAt,
        aggregate.projectId,
        acceptance.goalId,
        acceptance.workItemId,
        undefined,
        'acceptance_evidence',
        evidenceId,
        acceptance.id
      ))
    }
  }
  for (const run of selected.runs) {
    for (const tool of (run.taskRun.toolExecutions ?? []).filter((entry) => entry.effectId && !effectIds.has(entry.effectId))) {
      items.push(missingItem(
        `missing:tool:${tool.id}:effect:${tool.effectId}`,
        tool.updatedAt,
        aggregate.projectId,
        run.goalId,
        run.workItemId,
        run.id,
        'tool_effect',
        tool.effectId ?? '',
        undefined,
        tool
      ))
    }
  }
  return items
}

function missingItem(
  id: string,
  occurredAt: number,
  projectId: string,
  goalId: string | undefined,
  workItemId: string | undefined,
  runId: string | undefined,
  relation: string,
  entityId: string,
  acceptanceId?: string,
  tool?: ToolExecutionRecord
): StudioAuditTimelineItem {
  return {
    id,
    occurredAt,
    category: 'integrity',
    action: 'reference.missing',
    status: 'missing_reference',
    actor: systemActor('EastGenesis integrity verifier'),
    projectId,
    ...(goalId ? { goalId } : {}),
    ...(workItemId ? { workItemId } : {}),
    ...(runId ? { runId } : {}),
    entityType: relation,
    entityId,
    reason: relation,
    ...(tool?.toolName ? { toolName: tool.toolName } : {}),
    ...(acceptanceId ? { acceptanceId } : {}),
    integrity: 'missing_reference'
  }
}

function actorForRun(run: AggregateRun | undefined, aggregate: ProjectAggregateSnapshot): StudioAuditActor {
  const binding = run?.taskRun.digitalWorkerBinding
  if (binding?.kind !== 'assigned') return systemActor('EastGenesis')
  const worker = aggregate.digitalWorkers.find((candidate) => candidate.id === binding.workerId)
  const assignment = aggregate.assignments.find((candidate) => candidate.id === binding.assignmentId)
  const role = worker
    ? aggregate.policies.find((candidate) => candidate.ownerKind === 'digital_worker' && candidate.ownerId === worker.id && candidate.policyKind === 'role')?.value
    : undefined
  const roleLabel = typeof role === 'string' && role.trim()
    ? role.trim()
    : worker?.roleTemplateId
  return {
    kind: 'digital_worker',
    label: compact(worker?.displayName ?? binding.workerId, 120),
    ...(roleLabel ? { role: compact(roleLabel, 120) } : {}),
    workerId: binding.workerId,
    assignmentId: assignment?.id ?? binding.assignmentId
  }
}

function systemActor(label: string): StudioAuditActor {
  return { kind: 'system', label: compact(label, 120) || 'EastGenesis' }
}

function humanActor(label: string): StudioAuditActor {
  return { kind: 'human', label: compact(label, 120) || 'Local user' }
}

function encodeCursor(offset: number, sourceDigest: string, runId: string | undefined): string {
  return Buffer.from(JSON.stringify({ v: 1, offset, sourceDigest, runId: runId ?? null }), 'utf8').toString('base64url')
}

function decodeCursor(value: string, sourceDigest: string, runId: string | undefined): number {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    if (parsed.v !== 1 || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0 ||
        parsed.sourceDigest !== sourceDigest || parsed.runId !== (runId ?? null)) {
      throw new Error('cursor mismatch')
    }
    return Number(parsed.offset)
  } catch {
    throw new Error('Studio audit timeline cursor is stale or invalid; restart pagination')
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function firstString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return undefined
}

function safeReason(value: string | undefined): string | undefined {
  const normalized = compact(value ?? '', MAX_REASON_LENGTH)
  return normalized || undefined
}

function safeDigest(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.replace(/^sha256:/, '')
  return /^[a-f0-9]{64}$/i.test(normalized) ? `sha256:${normalized.toLowerCase()}` : undefined
}

function prefixedDigest(value: string): string {
  return value.startsWith('sha256:') ? value : `sha256:${value}`
}

function timestamp(value: number | string): number | undefined {
  const parsed = typeof value === 'number' ? value : Date.parse(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function compact(value: string, max: number): string {
  return redactSensitiveText(value).trim().replace(/\s+/g, ' ').slice(0, max)
}

function digest(value: unknown): string {
  return prefixedDigest(projectAggregateDigest(value))
}

function byNewestThenId(left: StudioAuditTimelineItem, right: StudioAuditTimelineItem): number {
  return right.occurredAt - left.occurredAt || left.id.localeCompare(right.id)
}
