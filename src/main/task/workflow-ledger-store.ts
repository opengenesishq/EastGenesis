import type { TaskRunRecord } from '../../shared/types'
import { assertFrozenRoutingWrite } from './frozen-routing-policy'
import type {
  WorkflowAcceptanceInput,
  WorkflowAcceptanceRecord,
  WorkflowArtifactInput,
  WorkflowArtifactRecord,
  WorkflowEvidenceLinkInput,
  WorkflowEvidenceLinkRecord,
  WorkflowEventInput,
  WorkflowEventRecord,
  WorkflowGoalProjectionInput,
  WorkflowGoalRecord,
  WorkflowGoalStatus,
  WorkflowLedgerVerification,
  WorkflowProjectionContext,
  WorkflowRunRecord,
  WorkflowWorkItemProjectionInput,
  WorkflowWorkItemRecord
} from '../../shared/workflow-types'
import {
  digest,
  eventImmutable,
  normalizeAcceptanceInput,
  normalizeArtifactInput,
  normalizeEvidenceLinkInput,
  normalizeEventInput,
  normalizeGoalInput,
  normalizeWorkItemInput,
  normalizeOptionalId,
  requiredId,
  SCHEMA_VERSION
} from './workflow-ledger-codec'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import {
  insertAcceptance,
  insertArtifact,
  insertEvidenceLink,
  insertEvent,
  insertGoal,
  insertRun,
  insertWorkItem,
  setupWorkflowLedgerSchema
} from './workflow-ledger-sql'
import {
  findEventById,
  findWorkflowAcceptance,
  findWorkflowArtifact,
  findWorkflowEvidenceLink,
  findWorkflowGoal,
  findWorkflowRun,
  findWorkflowWorkItem,
  assertWorkflowEventReferences,
  assertWorkflowEventReferencesWithIndex,
  readAcceptances,
  readAndVerifyEventAppendState,
  readAndVerifyEvents,
  readArtifacts,
  readEvidenceLinks,
  readGoals,
  readWorkflowEventChain,
  readRuns,
  readWorkItems,
  selectWorkflowAcceptances,
  selectWorkflowArtifacts,
  selectWorkflowEvidenceLinks,
  selectWorkflowEvents,
  selectWorkflowGoals,
  selectWorkflowLedger,
  selectWorkflowRuns,
  selectWorkflowWorkItems,
  type WorkflowEventAppendState
} from './workflow-ledger-query'
import {
  assertAcceptanceCanProject,
  assertAcceptanceReferences,
  assertAcceptanceState,
  assertArtifactReferences,
  assertEvidenceLinkReferences,
  assertGoalCompatibility,
  assertRunCompatibility,
  assertWorkItemCompatibility,
  assertWorkItemReferences,
  buildWorkflowRun,
  deriveWorkItemId,
  hasSatisfiedAcceptance,
  planTaskRunProjection,
  WORK_ITEM_TRANSITIONS
} from './workflow-ledger-relations'
import {
  assertAcceptanceEvidenceRefs,
  assertAcceptanceWriteAuthorization,
  assertEvidenceLinkProjectBoundary,
  assertWorkflowAcceptanceGate,
  type WorkflowAcceptanceGateOptions
} from './workflow-acceptance-guard'
import {
  readAllWorkflowEvidenceForIntegrity,
  verifyWorkflowEvidence
} from './workflow-evidence-store'
import { assertWorkflowEvidenceEventCoverage } from './workflow-evidence-event-coverage'
import { selectTaskEvidence, type TaskEvidenceRecord } from './task-evidence-store'

export type { WorkflowLedgerDatabase } from './workflow-ledger-db'
export { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
export { setupWorkflowLedgerSchema } from './workflow-ledger-sql'
export {
  findWorkflowAcceptance,
  findWorkflowArtifact,
  findWorkflowEvidenceLink,
  findWorkflowGoal,
  findWorkflowRun,
  findWorkflowWorkItem,
  selectWorkflowAcceptances,
  selectWorkflowArtifacts,
  selectWorkflowEvidenceLinks,
  selectWorkflowEvents,
  selectWorkflowGoals,
  selectWorkflowLedger,
  selectWorkflowRuns,
  selectWorkflowWorkItems
} from './workflow-ledger-query'
export { deriveWorkItemId } from './workflow-ledger-relations'
export {
  WorkflowAcceptanceGateError,
  assertAcceptanceEvidenceRefs,
  assertAcceptanceWriteAuthorization,
  assertEvidenceLinkProjectBoundary,
  assertWorkflowAcceptanceGate,
  hasSatisfiedWorkflowAcceptance,
  normalizeWorkflowCaller,
  toWorkflowAcceptanceError
} from './workflow-acceptance-guard'

export interface WorkflowProjectionWriteOptions extends WorkflowAcceptanceGateOptions {
  /** Keep the legacy projection escape hatch for recovery/backfill callers. */
  enforceTransition?: boolean
  /** Explicit nested form used by callers that already have an options object. */
  acceptance?: WorkflowAcceptanceGateOptions
}

function acceptanceGateOptions(options: WorkflowProjectionWriteOptions = {}): WorkflowAcceptanceGateOptions {
  return options.acceptance ?? options
}

export function projectGoal(
  db: WorkflowLedgerDatabase,
  input: WorkflowGoalProjectionInput,
  options: WorkflowProjectionWriteOptions = {}
): boolean {
  return projectGoalWithEventState(db, input, options)
}

function projectGoalWithEventState(
  db: WorkflowLedgerDatabase,
  input: WorkflowGoalProjectionInput,
  options: WorkflowProjectionWriteOptions,
  eventState?: WorkflowEventAppendState
): boolean {
  const goal = normalizeGoalInput(input)
  const existing = findWorkflowGoal(db, goal.id)
  if (existing) {
    assertGoalCompatibility(existing, goal)
    if (existing.revision > goal.revision) return false
    if (existing.revision === goal.revision && digest(existing) === digest(goal)) return false
    if (existing.revision === goal.revision) {
      throw new WorkflowLedgerCorruptionError(`goal ${goal.id} changed without revision increment`)
    }
  }
  if (goal.status === 'completed' && (!existing || existing.status !== 'completed')) {
    const gate = assertWorkflowAcceptanceGate(
      db,
      { kind: 'goal', record: goal },
      acceptanceGateOptions(options)
    )
    void gate.audit
  }
  insertGoal(db, goal)
  if (eventState) eventState.references.goals.set(goal.id, goal)
  appendWorkflowEventWithState(db, {
    eventId: `workflow:goal:${goal.id}:revision:${goal.revision}`,
    streamId: `goal:${goal.id}`,
    entityType: 'goal',
    entityId: goal.id,
    kind: existing ? 'goal.updated' : 'goal.created',
    payload: { ...goal },
    occurredAt: goal.updatedAt
  }, { projectId: goal.projectId, goalId: goal.id }, eventState)
  return true
}

export function projectWorkItem(
  db: WorkflowLedgerDatabase,
  input: WorkflowWorkItemProjectionInput,
  options: WorkflowProjectionWriteOptions = {}
): boolean {
  return projectWorkItemWithEventState(db, input, options)
}

function projectWorkItemWithEventState(
  db: WorkflowLedgerDatabase,
  input: WorkflowWorkItemProjectionInput,
  options: WorkflowProjectionWriteOptions,
  eventState?: WorkflowEventAppendState
): boolean {
  const workItem = normalizeWorkItemInput(input)
  assertWorkItemReferences(db, workItem)
  const existing = findWorkflowWorkItem(db, workItem.id)
  if (existing) {
    assertWorkItemCompatibility(existing, workItem)
    if (existing.revision > workItem.revision) return false
    if (existing.revision === workItem.revision && digest(existing) === digest(workItem)) return false
    if (existing.revision === workItem.revision) {
      throw new WorkflowLedgerCorruptionError(`work item ${workItem.id} changed without revision increment`)
    }
    if (
      options.enforceTransition !== false &&
      existing.status !== workItem.status &&
      !WORK_ITEM_TRANSITIONS[existing.status].has(workItem.status)
    ) {
      throw new WorkflowLedgerCorruptionError(
        `work item ${workItem.id} transition ${existing.status} -> ${workItem.status} is not allowed`
      )
    }
  }
  if (workItem.status === 'done' && (!existing || existing.status !== 'done')) {
    const gate = assertWorkflowAcceptanceGate(
      db,
      { kind: 'work_item', record: workItem },
      acceptanceGateOptions(options)
    )
    void gate.audit
  }
  insertWorkItem(db, workItem)
  if (eventState) eventState.references.workItems.set(workItem.id, workItem)
  appendWorkflowEventWithState(db, {
    eventId: `workflow:work-item:${workItem.id}:revision:${workItem.revision}`,
    streamId: `work-item:${workItem.id}`,
    entityType: 'work_item',
    entityId: workItem.id,
    kind: existing ? 'work_item.updated' : 'work_item.created',
    payload: { ...workItem },
    occurredAt: workItem.updatedAt
  }, { projectId: workItem.projectId, goalId: workItem.goalId, workItemId: workItem.id }, eventState)
  return true
}

export interface WorkflowProjectionBatchInput {
  goals: readonly WorkflowGoalProjectionInput[]
  workItems: readonly WorkflowWorkItemProjectionInput[]
}

/**
 * Project a prepared migration batch without re-reading the full event chain
 * for every row. The caller must still run verifyWorkflowLedger before bytes
 * can be persisted.
 */
export function projectWorkflowProjectionBatch(
  db: WorkflowLedgerDatabase,
  input: WorkflowProjectionBatchInput,
  options: WorkflowProjectionWriteOptions = {}
): { goals: number; workItems: number } {
  const eventState = readAndVerifyEventAppendState(db, {
    requireTaskEvidenceCoverage: false,
    requireProjectionBinding: false
  })
  let goals = 0
  let workItems = 0
  for (const goal of input.goals) {
    if (projectGoalWithEventState(db, goal, options, eventState)) goals += 1
  }
  for (const workItem of input.workItems) {
    if (projectWorkItemWithEventState(db, workItem, options, eventState)) workItems += 1
  }
  readAndVerifyEvents(db, {
    requireTaskEvidenceCoverage: false,
    requireProjectionBinding: false
  })
  return { goals, workItems }
}

export function projectTaskRun(
  db: WorkflowLedgerDatabase,
  run: TaskRunRecord,
  context: WorkflowProjectionContext = {}
): boolean {
  const currentRun = findWorkflowRun(db, run.id)
  assertFrozenRoutingWrite(currentRun?.taskRun, run)
  const plan = planTaskRunProjection(db, run, context)
  const workflowRun = buildWorkflowRun(
    db, run, plan.workItemId, plan.projectId, plan.goalId, currentRun
  )
  // Check immutable Run ownership before a recovery projection can mutate its
  // WorkItem. This keeps a conflicting backfill fail-closed and side-effect free.
  if (currentRun) assertRunCompatibility(currentRun, workflowRun)
  const workItemChanged = plan.workItemInput
    ? projectWorkItem(db, plan.workItemInput, { enforceTransition: false })
    : false
  if (currentRun) {
    if (currentRun.revision > workflowRun.revision) return workItemChanged
    if (currentRun.revision === workflowRun.revision && digest(currentRun) === digest(workflowRun)) {
      return workItemChanged
    }
  }
  insertRun(db, workflowRun)
  const event = context.event ?? defaultRunEvent(run, plan.workItemId, context)
  appendWorkflowEvent(db, event, {
    projectId: plan.projectId,
    goalId: plan.goalId,
    workItemId: plan.workItemId,
    runId: run.id,
    sessionId: run.sessionId
  })
  return true
}

export function registerWorkflowArtifact(
  db: WorkflowLedgerDatabase,
  input: WorkflowArtifactInput
): WorkflowArtifactRecord {
  const artifact = normalizeArtifactInput(input)
  assertArtifactReferences(db, artifact)
  const existing = findWorkflowArtifact(db, artifact.id)
  if (existing) {
    if (digest(existing) !== digest(artifact)) {
      throw new WorkflowLedgerCorruptionError(`artifact ${artifact.id} immutable content changed`)
    }
    return existing
  }
  insertArtifact(db, artifact)
  appendWorkflowEvent(db, {
    eventId: `workflow:artifact:${artifact.id}:version:${artifact.version}`,
    streamId: artifact.workItemId ? `work-item:${artifact.workItemId}` : `artifact:${artifact.id}`,
    entityType: 'artifact',
    entityId: artifact.id,
    kind: 'artifact.created',
    payload: { ...artifact },
    occurredAt: artifact.createdAt,
    correlationId: artifact.runId ?? artifact.workItemId ?? artifact.id
  }, {
    projectId: artifact.projectId,
    goalId: artifact.goalId,
    workItemId: artifact.workItemId,
    runId: artifact.runId
  })
  return artifact
}

export function projectWorkflowAcceptance(
  db: WorkflowLedgerDatabase,
  input: WorkflowAcceptanceInput,
  options: WorkflowAcceptanceGateOptions = {}
): WorkflowAcceptanceRecord {
  const acceptance = normalizeAcceptanceInput(input)
  assertAcceptanceReferences(db, acceptance)
  assertAcceptanceWriteAuthorization(acceptance, options)
  assertAcceptanceEvidenceRefs(db, acceptance)
  const existing = findWorkflowAcceptance(db, acceptance.id)
  if (!assertAcceptanceCanProject(db, acceptance, existing)) return existing ?? acceptance
  insertAcceptance(db, acceptance)
  appendWorkflowEvent(db, {
    eventId: `workflow:acceptance:${acceptance.id}:revision:${acceptance.revision}`,
    streamId: acceptance.workItemId ? `work-item:${acceptance.workItemId}` : `acceptance:${acceptance.id}`,
    entityType: 'acceptance',
    entityId: acceptance.id,
    kind: existing ? 'acceptance.updated' : 'acceptance.created',
    payload: { ...acceptance },
    occurredAt: acceptance.updatedAt,
    correlationId: acceptance.workItemId ?? acceptance.goalId ?? acceptance.id
  }, {
    projectId: acceptance.projectId,
    goalId: acceptance.goalId,
    workItemId: acceptance.workItemId
  })
  return acceptance
}

export function linkWorkflowEvidence(
  db: WorkflowLedgerDatabase,
  input: WorkflowEvidenceLinkInput
): WorkflowEvidenceLinkRecord {
  const existing = findWorkflowEvidenceLink(db, requiredId(input.id, 'evidence link id'))
  const link = normalizeEvidenceLinkInput(input, { createdAt: existing?.createdAt })
  assertEvidenceLinkProjectBoundary(db, link)
  assertEvidenceLinkReferences(db, link)
  if (existing) {
    if (digest(existing) !== digest(link)) {
      throw new WorkflowLedgerCorruptionError(`evidence link ${link.id} immutable content changed`)
    }
    return existing
  }
  insertEvidenceLink(db, link)
  appendWorkflowEvent(db, {
    eventId: `workflow:evidence-link:${link.id}`,
    streamId: link.acceptanceId
      ? `acceptance:${link.acceptanceId}`
      : link.artifactId
        ? `artifact:${link.artifactId}`
        : `run:${link.runId}`,
    entityType: link.acceptanceId ? 'acceptance' : link.artifactId ? 'artifact' : 'system',
    entityId: link.acceptanceId ?? link.artifactId ?? link.runId ?? link.id,
    kind: 'evidence.linked',
    payload: { ...link },
    occurredAt: link.createdAt,
    correlationId: link.acceptanceId ?? link.artifactId ?? link.runId
  }, { projectId: link.projectId, runId: link.runId })
  return link
}

export function appendWorkflowEvent(
  db: WorkflowLedgerDatabase,
  input: WorkflowEventInput,
  scope: {
    projectId?: string
    goalId?: string
    workItemId?: string
    runId?: string
    sessionId?: string
  } = {}
): WorkflowEventRecord {
  return appendWorkflowEventWithState(db, input, scope)
}

function appendWorkflowEventWithState(
  db: WorkflowLedgerDatabase,
  input: WorkflowEventInput,
  scope: {
    projectId?: string
    goalId?: string
    workItemId?: string
    runId?: string
    sessionId?: string
  },
  eventState?: WorkflowEventAppendState
): WorkflowEventRecord {
  const normalized = normalizeEventInput(input)
  const scoped = {
    ...normalized,
    ...normalizedScope(scope)
  }
  // Validate the existing chain and its historical references before handling
  // idempotency. Returning a dangling event would otherwise make corruption
  // reachable through an apparently harmless retry.
  const state = eventState ?? readAndVerifyEventAppendState(db, {
    requireTaskEvidenceCoverage: false,
    requireProjectionBinding: false
  })
  const events = state.events
  const existing = findEventById(db, normalized.eventId)
  if (existing) {
    if (input.seq !== undefined && input.seq !== existing.seq) {
      throw new WorkflowLedgerCorruptionError(`event ${normalized.eventId} sequence does not match existing record`, existing.seq)
    }
    if (digest(eventImmutable(existing)) !== digest(eventImmutable(scoped))) {
      throw new WorkflowLedgerCorruptionError(`event id ${normalized.eventId} maps to different immutable content`, existing.seq)
    }
    return existing
  }
  const previous = events.at(-1)
  const nextSeq = previous ? previous.seq + 1 : 1
  if (input.seq !== undefined && input.seq !== nextSeq) {
    throw new WorkflowLedgerCorruptionError(`event ${normalized.eventId} sequence ${input.seq} is not next sequence ${nextSeq}`)
  }
  assertWorkflowEventScope(db, scoped)
  const recordWithoutDigest = {
    ...scoped,
    schemaVersion: SCHEMA_VERSION as 1,
    seq: nextSeq,
    occurredAt: normalized.occurredAt ?? Date.now(),
    prevDigest: previous?.digest ?? '0'.repeat(64)
  }
  const record: WorkflowEventRecord = {
    ...recordWithoutDigest,
    digest: digest(recordWithoutDigest)
  }
  if (eventState) assertWorkflowEventReferencesWithIndex(db, record, state.references)
  else assertWorkflowEventReferences(db, record)
  insertEvent(db, record)
  events.push(record)
  return record
}

export interface WorkflowEventProjectPurgeScope {
  projectId: string
  goalIds?: ReadonlySet<string>
  workItemIds?: ReadonlySet<string>
  runIds?: ReadonlySet<string>
  sessionIds?: ReadonlySet<string>
}

export interface WorkflowEventProjectPurgeResult {
  removed: number
  remaining: number
  lastSeq: number
  lastDigest: string
}

/** Remove scoped events and rebuild the global chain before their projections are deleted. */
export function purgeWorkflowEventsProject(
  db: WorkflowLedgerDatabase,
  scope: WorkflowEventProjectPurgeScope
): WorkflowEventProjectPurgeResult {
  const projectId = requiredId(scope.projectId, 'project purge projectId')
  const events = readAndVerifyEvents(db, {
    requireTaskEvidenceCoverage: false,
    requireProjectionBinding: false
  })
  const removedByScope = (event: WorkflowEventRecord): boolean =>
    event.projectId === projectId ||
    Boolean(event.goalId && scope.goalIds?.has(event.goalId)) ||
    Boolean(event.workItemId && scope.workItemIds?.has(event.workItemId)) ||
    Boolean(event.runId && scope.runIds?.has(event.runId)) ||
    Boolean(event.sessionId && scope.sessionIds?.has(event.sessionId))
  const remaining = events.filter((event) => !removedByScope(event))
  if (remaining.length === events.length) {
    const last = events.at(-1)
    return {
      removed: 0,
      remaining: events.length,
      lastSeq: last?.seq ?? 0,
      lastDigest: last?.digest ?? '0'.repeat(64)
    }
  }
  db.run('DELETE FROM workflow_events')
  let previousDigest = '0'.repeat(64)
  for (let index = 0; index < remaining.length; index += 1) {
    const { digest: _digest, seq: _seq, prevDigest: _prevDigest, ...immutable } = remaining[index]
    const withoutDigest = {
      ...immutable,
      seq: index + 1,
      prevDigest: previousDigest
    }
    const rebuilt: WorkflowEventRecord = { ...withoutDigest, digest: digest(withoutDigest) }
    insertEvent(db, rebuilt)
    previousDigest = rebuilt.digest
  }
  const verified = readAndVerifyEvents(db, {
    requireTaskEvidenceCoverage: false,
    requireProjectionBinding: false
  })
  const last = verified.at(-1)
  return {
    removed: events.length - remaining.length,
    remaining: verified.length,
    lastSeq: last?.seq ?? 0,
    lastDigest: last?.digest ?? '0'.repeat(64)
  }
}

/** Rebind Evidence event payloads after their global chains have been compacted. */
export function refreshWorkflowEvidenceEventProjections(db: WorkflowLedgerDatabase): void {
  const taskEvidence = new Map(selectTaskEvidence(db).map((record) => [record.evidenceId, record]))
  const workflowEvidence = new Map(readAllWorkflowEvidenceForIntegrity(db).map((record) => [record.evidenceId, record]))
  const events = readWorkflowEventChain(db)
  const rebound = events.map((event) => {
    if (event.kind === 'workflow.effect.evidence') {
      const evidenceId = typeof event.payload.evidenceId === 'string' ? event.payload.evidenceId : ''
      const record = taskEvidence.get(evidenceId)
      if (!record) throw new WorkflowLedgerCorruptionError(`event ${event.eventId} references missing Task evidence`)
      return { ...event, payload: taskEvidenceEventPayload(record) }
    }
    if (event.kind === 'workflow.evidence.recorded') {
      const prefix = 'workflow:evidence-record:'
      const record = event.eventId.startsWith(prefix) ? workflowEvidence.get(event.eventId.slice(prefix.length)) : undefined
      if (!record) throw new WorkflowLedgerCorruptionError(`event ${event.eventId} references missing Workflow evidence`)
      return { ...event, payload: { ...record } }
    }
    return event
  })
  db.run('DELETE FROM workflow_events')
  let previousDigest = '0'.repeat(64)
  for (let index = 0; index < rebound.length; index += 1) {
    const { digest: _digest, seq: _seq, prevDigest: _prevDigest, ...immutable } = rebound[index]
    const withoutDigest = { ...immutable, seq: index + 1, prevDigest: previousDigest }
    const rebuilt: WorkflowEventRecord = { ...withoutDigest, digest: digest(withoutDigest) }
    insertEvent(db, rebuilt)
    previousDigest = rebuilt.digest
  }
  readAndVerifyEvents(db, { requireProjectionBinding: false })
}

function taskEvidenceEventPayload(record: TaskEvidenceRecord): Record<string, unknown> {
  return {
    evidenceId: record.evidenceId,
    evidenceSeq: record.seq,
    effectId: record.effectId,
    kind: record.kind,
    generation: record.generation,
    observedAt: record.observedAt,
    verifier: record.verifier,
    evidenceDigest: record.evidenceDigest,
    effectKey: record.effectKey,
    targetDigest: record.targetDigest,
    taskEvidenceRecordDigest: record.digest,
    taskEvidencePrevDigest: record.prevDigest,
    ...(record.operationId ? { operationId: record.operationId } : {}),
    ...(record.projectId ? { projectId: record.projectId } : {})
  }
}

export function verifyWorkflowLedger(db: WorkflowLedgerDatabase): WorkflowLedgerVerification {
  const goals = readGoals(db)
  const workItems = readWorkItems(db)
  const runs = readRuns(db)
  const artifacts = readArtifacts(db)
  const acceptances = readAcceptances(db)
  const evidenceLinks = readEvidenceLinks(db)
  const workflowEvidence = readAllWorkflowEvidenceForIntegrity(db)
  verifyWorkflowEvidence(db)
  const events = readAndVerifyEvents(db)
  assertWorkflowEvidenceEventCoverage(workflowEvidence, events)
  verifyProjectionReferences(db, goals, workItems, runs, artifacts, acceptances, evidenceLinks)
  const last = events.at(-1)
  return {
    valid: true,
    goals: goals.length,
    workItems: workItems.length,
    runs: runs.length,
    artifacts: artifacts.length,
    acceptances: acceptances.length,
    evidenceLinks: evidenceLinks.length,
    workflowEvidence: workflowEvidence.length,
    events: events.length,
    lastSeq: last?.seq ?? 0,
    lastDigest: last?.digest ?? '0'.repeat(64)
  }
}

function defaultRunEvent(
  run: TaskRunRecord,
  workItemId: string,
  context: WorkflowProjectionContext
): WorkflowEventInput {
  return {
    eventId: `workflow:run:${run.id}:revision:${run.revision}:updated:${run.updatedAt}`,
    streamId: `work-item:${workItemId}`,
    entityType: 'run',
    entityId: run.id,
    kind: run.status === 'recovering' ? 'run.recovered' : 'run.projected',
    payload: {
      runId: run.id,
      workItemId,
      taskId: run.taskId,
      status: run.status,
      revision: run.revision,
      attempt: run.attempt
    },
    occurredAt: run.updatedAt,
    ...(run.lastAppliedEventId ? { causationId: run.lastAppliedEventId } : {}),
    correlationId: run.sessionId,
    ...(context.event?.eventId ? { eventId: context.event.eventId } : {})
  }
}

function normalizedScope(scope: {
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  sessionId?: string
}): Record<string, string> {
  return {
    ...(normalizeOptionalId(scope.projectId) ? { projectId: normalizeOptionalId(scope.projectId) } : {}),
    ...(normalizeOptionalId(scope.goalId) ? { goalId: normalizeOptionalId(scope.goalId) } : {}),
    ...(normalizeOptionalId(scope.workItemId) ? { workItemId: normalizeOptionalId(scope.workItemId) } : {}),
    ...(normalizeOptionalId(scope.runId) ? { runId: normalizeOptionalId(scope.runId) } : {}),
    ...(normalizeOptionalId(scope.sessionId) ? { sessionId: normalizeOptionalId(scope.sessionId) } : {})
  }
}

function assertWorkflowEventScope(
  db: WorkflowLedgerDatabase,
  event: WorkflowEventInput & Partial<Pick<WorkflowEventRecord, 'projectId' | 'goalId' | 'workItemId' | 'runId' | 'sessionId'>>
): void {
  const refs = resolveEventReferences(db, event)
  assertEventReferencePresence(event, refs)
  assertEventProjectOwnership(event, refs)
  assertEventHierarchy(event, refs)
}

interface WorkflowEventReferences {
  goal: ReturnType<typeof findWorkflowGoal>
  workItem: ReturnType<typeof findWorkflowWorkItem>
  run: ReturnType<typeof findWorkflowRun>
}

function resolveEventReferences(
  db: WorkflowLedgerDatabase,
  event: WorkflowEventInput & Partial<Pick<WorkflowEventRecord, 'goalId' | 'workItemId' | 'runId'>>
): WorkflowEventReferences {
  return {
    goal: event.goalId ? findWorkflowGoal(db, event.goalId) : null,
    workItem: event.workItemId ? findWorkflowWorkItem(db, event.workItemId) : null,
    run: event.runId ? findWorkflowRun(db, event.runId) : null
  }
}

function assertEventReferencePresence(
  event: WorkflowEventInput & Partial<Pick<WorkflowEventRecord, 'goalId' | 'workItemId' | 'runId'>>,
  refs: WorkflowEventReferences
): void {
  if (event.goalId && !refs.goal) throw new WorkflowLedgerCorruptionError(`event references missing goal ${event.goalId}`)
  if (event.workItemId && !refs.workItem) throw new WorkflowLedgerCorruptionError(`event references missing work item ${event.workItemId}`)
  if (event.runId && !refs.run) throw new WorkflowLedgerCorruptionError(`event references missing run ${event.runId}`)
}

function assertEventProjectOwnership(
  event: WorkflowEventInput & Partial<Pick<WorkflowEventRecord, 'projectId'>>,
  refs: WorkflowEventReferences
): void {
  for (const owner of [refs.goal, refs.workItem, refs.run]) {
    if (owner && owner.projectId !== event.projectId) {
      throw new WorkflowLedgerCorruptionError(`event ${event.eventId} crosses project boundary`)
    }
  }
}

function assertEventHierarchy(
  event: WorkflowEventInput & Partial<Pick<WorkflowEventRecord, 'workItemId' | 'sessionId'>>,
  refs: WorkflowEventReferences
): void {
  if (refs.goal && refs.workItem?.goalId && refs.workItem.goalId !== refs.goal.id) {
    throw new WorkflowLedgerCorruptionError(`event ${event.eventId} goal/work item ownership differs`)
  }
  if (refs.run && refs.workItem && refs.run.workItemId !== refs.workItem.id) {
    throw new WorkflowLedgerCorruptionError(`event ${event.eventId} run/work item ownership differs`)
  }
  if (refs.run && event.sessionId && refs.run.sessionId !== event.sessionId) {
    throw new WorkflowLedgerCorruptionError(`event ${event.eventId} session ownership differs`)
  }
}

function verifyProjectionReferences(
  db: WorkflowLedgerDatabase,
  goals: readonly WorkflowGoalRecord[],
  workItems: readonly WorkflowWorkItemRecord[],
  runs: readonly WorkflowRunRecord[],
  artifacts: readonly WorkflowArtifactRecord[],
  acceptances: readonly WorkflowAcceptanceRecord[],
  evidenceLinks: readonly WorkflowEvidenceLinkRecord[]
): void {
  const goalIds = new Set(goals.map((goal) => goal.id))
  const workItemIds = new Set(workItems.map((item) => item.id))
  for (const item of workItems) {
    assertWorkItemReferences(db, item)
    if (item.goalId && !goalIds.has(item.goalId)) {
      throw new WorkflowLedgerCorruptionError(`work item ${item.id} references missing goal ${item.goalId}`)
    }
    for (const runId of item.runIds) {
      if (!runs.some((run) => run.id === runId && run.workItemId === item.id)) {
        throw new WorkflowLedgerCorruptionError(`work item ${item.id} references missing run ${runId}`)
      }
    }
    if (item.status === 'done' && !hasSatisfiedAcceptance(db, item.id)) {
      throw new WorkflowLedgerCorruptionError(
        `work item ${item.id} cannot be done without passed or waived Acceptance`
      )
    }
  }
  for (const run of runs) assertRunProjectionReferences(run, workItemIds, acceptances)
  for (const artifact of artifacts) assertArtifactReferences(db, artifact)
  for (const acceptance of acceptances) {
    assertAcceptanceReferences(db, acceptance)
    assertAcceptanceEvidenceRefs(db, acceptance)
    assertAcceptanceState(db, acceptance)
  }
  for (const link of evidenceLinks) assertEvidenceLinkReferences(db, link)
}

function assertRunProjectionReferences(
  run: WorkflowRunRecord,
  workItemIds: ReadonlySet<string>,
  acceptances: readonly WorkflowAcceptanceRecord[]
): void {
  if (!workItemIds.has(run.workItemId)) {
    throw new WorkflowLedgerCorruptionError(`run ${run.id} references missing work item ${run.workItemId}`)
  }
  if (!run.acceptanceId) return
  const acceptance = acceptances.find((candidate) => candidate.id === run.acceptanceId)
  if (!acceptance || acceptance.projectId !== run.projectId || acceptance.goalId !== run.goalId ||
      acceptance.workItemId !== run.workItemId || acceptance.revision < (run.acceptanceRevision ?? 0)) {
    throw new WorkflowLedgerCorruptionError(`run ${run.id} has an invalid Acceptance revision binding`)
  }
}
