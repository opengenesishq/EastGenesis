import { createHash } from 'node:crypto'
import type { AcceptanceResult, Goal, WorkItem } from '../../shared/project-workspace-types'
import type { AcceptanceSpec } from '../../shared/project-workspace-types'
import type { WorkflowAcceptanceRecord } from '../../shared/workflow-types'
import type { RoutineRunRecord, RoutineRunReviewInput } from '../../shared/types'
import { openProjectWorkspaceCommandService } from '../project-workspace/command-service'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import {
  createWorkflowEvidenceLink,
  listPersistedWorkflowLedger,
  saveWorkflowAcceptance
} from '../task/workflow-ledger-api'
import { listRoutineRuns, reviewRoutineRunRecord } from './routine-runner'
import { attachProducedArtifactToStage } from '../task/workflow-stage-handoff'

const MAX_REVIEW_MUTATION_ATTEMPTS = 8

export async function reviewRoutineRun(
  routineRoot: string,
  workspaceRoot: string,
  runId: string,
  input: RoutineRunReviewInput
): Promise<RoutineRunRecord | null> {
  const id = requiredText(runId, 'runId', 240)
  const decision = input?.decision
  if (decision !== 'accept' && decision !== 'reject') throw new Error('Routine review decision is invalid')
  const note = optionalText(input.note, 'note', 20_000)
  const record = (await listRoutineRuns(routineRoot)).find((run) => run.id === id)
  if (!record) return null
  const expectedDecision = decision === 'accept' ? 'accepted' : 'rejected'
  if (record.reviewDecision) {
    if (record.reviewDecision !== expectedDecision) throw new Error(`Routine Run ${id} was already reviewed`)
    return record
  }
  if (record.status !== 'succeeded' || record.inboxStatus !== 'needs_review') {
    throw new Error(`Routine Run ${id} is not ready for review`)
  }
  if (record.projectId && record.workItemId && !record.heartbeat) {
    await applyCanonicalReview(workspaceRoot, record, decision, note)
  }
  return reviewRoutineRunRecord(routineRoot, id, expectedDecision, note)
}

async function applyCanonicalReview(
  workspaceRoot: string,
  record: RoutineRunRecord,
  decision: RoutineRunReviewInput['decision'],
  note: string | undefined
): Promise<void> {
  const store = await openProjectWorkspaceStore(workspaceRoot)
  const item = await store.getWorkItem(record.workItemId!)
  if (!item || item.projectId !== record.projectId || item.goalId !== record.goalId) {
    throw new Error(`Routine review WorkItem binding is invalid:${record.workItemId}`)
  }
  if (!record.evidenceId || !record.artifactId) {
    throw new Error(`Routine Run ${record.id} has no persisted Artifact/Evidence result`)
  }
  const goal = record.goalId ? await store.getGoal(record.goalId) : undefined
  if (record.goalId && (!goal || goal.projectId !== record.projectId)) {
    throw new Error(`Routine review Goal binding is invalid:${record.goalId}`)
  }
  const reviewedAt = Date.now()
  await persistWorkflowReview(workspaceRoot, record, item, goal, decision, note, reviewedAt)
  if (decision === 'accept') {
    await attachProducedArtifactToStage({
      artifactId: record.artifactId,
      projectId: record.projectId!,
      workItemId: record.workItemId!,
      runId: record.workflowRunId!,
      rootDir: workspaceRoot
    })
  }
  const evidenceRefs = [record.evidenceId]
  const acceptance: AcceptanceResult = {
    status: decision === 'accept' ? 'passed' : 'failed',
    evidenceRefs,
    verifiedBy: 'local-user',
    verifiedAt: reviewedAt
  }
  await reviewWorkItem(workspaceRoot, item.id, acceptance, decision)
  if (goal) {
    await reviewGoal(workspaceRoot, goal.id, acceptance, decision)
  }
}

async function persistWorkflowReview(
  workspaceRoot: string,
  record: RoutineRunRecord,
  item: WorkItem,
  goal: Goal | undefined,
  decision: RoutineRunReviewInput['decision'],
  note: string | undefined,
  reviewedAt: number
): Promise<void> {
  await persistTargetAcceptance(
    workspaceRoot,
    record,
    'work_item',
    item.id,
    item.acceptanceSpec,
    decision,
    note,
    reviewedAt
  )
  if (goal) {
    await persistTargetAcceptance(
      workspaceRoot,
      record,
      'goal',
      goal.id,
      goal.contract.acceptance,
      decision,
      note,
      reviewedAt
    )
  }
}

async function persistTargetAcceptance(
  workspaceRoot: string,
  record: RoutineRunRecord,
  targetType: 'work_item' | 'goal',
  targetId: string,
  specs: readonly AcceptanceSpec[],
  decision: RoutineRunReviewInput['decision'],
  note: string | undefined,
  reviewedAt: number
): Promise<void> {
  const acceptanceId = routineAcceptanceId(record.id, targetType, targetId)
  const desiredStatus = decision === 'accept' ? 'passed' : 'failed'
  const existing = (await listPersistedWorkflowLedger({ projectId: record.projectId }, workspaceRoot))
    .acceptances.items.find((candidate) => candidate.id === acceptanceId)
  if (existing?.status === desiredStatus) return
  if (existing && (existing.status === 'passed' || existing.status === 'failed' || existing.status === 'waived')) {
    throw new Error(`Routine Workflow Acceptance ${acceptanceId} was already reviewed as ${existing.status}`)
  }
  const normalizedSpecs = acceptanceSpecs(specs, targetType, targetId)
  let acceptance = existing ?? await saveWorkflowAcceptance({
    id: acceptanceId,
    projectId: record.projectId,
    ...(targetType === 'work_item' ? { workItemId: targetId, goalId: record.goalId } : { goalId: targetId }),
    criteria: normalizedSpecs.map((spec) => spec.criterion),
    criterionPolicies: normalizedSpecs.map((spec, criterionIndex) => ({
      criterionId: spec.id,
      criterionIndex,
      evidenceKind: 'observation',
      allowedSources: ['runtime']
    })),
    status: 'verifying',
    evidenceRefs: [],
    revision: 1,
    createdAt: reviewedAt,
    updatedAt: reviewedAt
  }, workspaceRoot, { caller: 'user', actorId: 'local-user' })
  if (acceptance.status === 'pending') {
    acceptance = await saveWorkflowAcceptance({
      ...acceptance,
      status: 'verifying',
      revision: acceptance.revision + 1,
      updatedAt: reviewedAt
    }, workspaceRoot, { caller: 'user', actorId: 'local-user' })
  }
  for (const spec of normalizedSpecs) {
    await createWorkflowEvidenceLink({
      id: routineAcceptanceLinkId(acceptanceId, spec.id),
      evidenceId: record.evidenceId!,
      projectId: record.projectId,
      runId: record.workflowRunId,
      artifactId: record.artifactId,
      acceptanceId,
      criterionId: spec.id,
      evidenceOrigin: 'workflow',
      relation: 'verifies',
      createdAt: reviewedAt
    }, workspaceRoot)
  }
  await saveWorkflowAcceptance({
    ...acceptance,
    status: desiredStatus,
    evidenceRefs: [record.evidenceId!],
    criterionEvidence: normalizedSpecs.map((spec, criterionIndex) => ({
      criterionId: spec.id,
      criterionIndex,
      evidenceRefs: [record.evidenceId!]
    })),
    verifier: 'local-user',
    verifiedAt: reviewedAt,
    notes: note,
    revision: acceptance.revision + 1,
    updatedAt: reviewedAt
  }, workspaceRoot, { caller: 'user', actorId: 'local-user' })
}

function acceptanceSpecs(
  specs: readonly AcceptanceSpec[],
  targetType: 'work_item' | 'goal',
  targetId: string
): AcceptanceSpec[] {
  if (specs.length > 0) return specs.map((spec) => ({ ...spec }))
  return [{
    id: `routine-${targetType}-result`,
    criterion: `Routine result is accepted for ${targetType} ${targetId}`,
    required: true
  }]
}

function routineAcceptanceId(runId: string, targetType: 'work_item' | 'goal', targetId: string): string {
  return `routine-acceptance-${bindingDigest(runId, targetType, targetId)}`
}

function routineAcceptanceLinkId(acceptanceId: string, criterionId: string): string {
  return `routine-acceptance-link-${bindingDigest(acceptanceId, criterionId)}`
}

function bindingDigest(...parts: string[]): string {
  return createHash('sha256')
    .update(['caogen.routine-acceptance.v1', ...parts].join('\0'))
    .digest('hex')
    .slice(0, 32)
}

async function reviewWorkItem(
  workspaceRoot: string,
  workItemId: string,
  acceptance: AcceptanceResult,
  decision: RoutineRunReviewInput['decision']
): Promise<void> {
  const terminalStatus = decision === 'accept' ? 'done' : 'failed'
  for (let attempt = 0; attempt < MAX_REVIEW_MUTATION_ATTEMPTS; attempt += 1) {
    const item = await (await openProjectWorkspaceStore(workspaceRoot)).getWorkItem(workItemId)
    if (!item) throw new Error(`Routine WorkItem is missing:${workItemId}`)
    if (item.status === 'done' || item.status === 'failed') {
      assertTerminalReview(item.status, terminalStatus, item.acceptance, acceptance, 'WorkItem', item.id)
      return
    }
    if (item.status !== 'verifying') throw new Error(`Routine WorkItem is not verifying:${item.id}:${item.status}`)
    const commands = await openProjectWorkspaceCommandService(workspaceRoot)
    try {
      if (!acceptanceIncludes(item.acceptance, acceptance)) {
        await commands.setWorkItemAcceptance(item.id, acceptance, { expectedRevision: item.revision })
        continue
      }
      await commands.transitionWorkItem(item.id, terminalStatus, { expectedRevision: item.revision })
      return
    } catch (error) {
      if (attempt < MAX_REVIEW_MUTATION_ATTEMPTS - 1 && isStaleRevision(error)) continue
      throw error
    }
  }
  throw new Error(`Routine WorkItem review retry exhausted:${workItemId}`)
}

async function reviewGoal(
  workspaceRoot: string,
  goalId: string,
  acceptance: AcceptanceResult,
  decision: RoutineRunReviewInput['decision']
): Promise<void> {
  const terminalStatus = decision === 'accept' ? 'completed' : 'failed'
  for (let attempt = 0; attempt < MAX_REVIEW_MUTATION_ATTEMPTS; attempt += 1) {
    const goal = await (await openProjectWorkspaceStore(workspaceRoot)).getGoal(goalId)
    if (!goal) throw new Error(`Routine Goal is missing:${goalId}`)
    if (goal.status === 'completed' || goal.status === 'failed') {
      assertTerminalReview(goal.status, terminalStatus, goal.acceptanceResult, acceptance, 'Goal', goal.id)
      return
    }
    if (goal.status !== 'verifying') throw new Error(`Routine Goal is not verifying:${goal.id}:${goal.status}`)
    const commands = await openProjectWorkspaceCommandService(workspaceRoot)
    try {
      if (!acceptanceIncludes(goal.acceptanceResult, acceptance)) {
        await commands.setGoalAcceptance(goal.id, acceptance, { expectedRevision: goal.revision })
        continue
      }
      await commands.transitionGoal(goal.id, terminalStatus, { expectedRevision: goal.revision })
      return
    } catch (error) {
      if (attempt < MAX_REVIEW_MUTATION_ATTEMPTS - 1 && isStaleRevision(error)) continue
      throw error
    }
  }
  throw new Error(`Routine Goal review retry exhausted:${goalId}`)
}

function acceptanceIncludes(
  current: AcceptanceResult | undefined,
  expected: AcceptanceResult
): boolean {
  return current?.status === expected.status &&
    expected.evidenceRefs.every((evidenceRef) => current.evidenceRefs.includes(evidenceRef))
}

function assertTerminalReview<T extends string>(
  currentStatus: T,
  expectedStatus: T,
  currentAcceptance: AcceptanceResult | undefined,
  expectedAcceptance: AcceptanceResult,
  targetType: 'WorkItem' | 'Goal',
  targetId: string
): void {
  if (currentStatus !== expectedStatus || !acceptanceIncludes(currentAcceptance, expectedAcceptance)) {
    throw new Error(`Routine ${targetType} review conflicts with terminal state:${targetId}:${currentStatus}`)
  }
}

function isStaleRevision(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error &&
    (error as { code?: unknown }).code === 'stale_revision')
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is required`)
  const clean = value.trim()
  if (!clean || clean.length > maxLength || /[\0\x08\x0b\x0c\x0e-\x1f\x7f]/.test(clean)) {
    throw new Error(`${label} is invalid`)
  }
  return clean
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredText(value, label, maxLength)
}
