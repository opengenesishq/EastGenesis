import { canonicalJson, digest } from './workflow-ledger-canonical'
export { canonicalJson, digest } from './workflow-ledger-canonical'
import { isBusinessLineId } from '../../shared/business-line-types'
import { storedBusinessLineId } from '../business-line-ownership'
import type { TaskRunRecord } from '../../shared/types'
import type {
  WorkflowAcceptanceInput,
  WorkflowAcceptanceRecord,
  WorkflowAcceptanceStatus,
  WorkflowArtifactInput,
  WorkflowArtifactKind,
  WorkflowArtifactRecord,
  WorkflowEvidenceLinkInput,
  WorkflowEvidenceLinkRecord,
  WorkflowEventInput,
  WorkflowEventRecord,
  WorkflowGoalProjectionInput,
  WorkflowGoalRecord,
  WorkflowGoalStatus,
  WorkflowProjectionSource,
  WorkflowRunRecord,
  WorkflowWorkItemProjectionInput,
  WorkflowWorkItemRecord,
  WorkflowWorkItemStatus,
  WorkflowWorkItemType
} from '../../shared/workflow-types'
import { isTaskRunRecord } from './task-run'
import {
  assertWorkflowArtifactMetadataSafe,
  assertWorkflowArtifactUriSafe
} from './workflow-ledger-artifact-security'
import {
  isNormalizedAcceptanceCriterionPolicies,
  normalizeAcceptanceCriterionPolicies
} from './workflow-acceptance-criterion-policy'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'

export const SCHEMA_VERSION = 1
export const GENESIS_DIGEST = '0'.repeat(64)
export const DEFAULT_PAGE_SIZE = 100
export const MAX_PAGE_SIZE = 500

const WORKFLOW_EVENT_KINDS = new Set([
  'goal.created',
  'goal.updated',
  'work_item.created',
  'work_item.updated',
  'run.projected',
  'run.recovered',
  'artifact.created',
  'acceptance.created',
  'acceptance.updated',
  'acceptance.invalidated_by_change',
  'evidence.linked'
])

const ARTIFACT_KINDS: readonly WorkflowArtifactKind[] = [
  'report', 'source', 'requirement', 'design', 'document', 'spreadsheet',
  'presentation', 'pdf', 'code', 'patch', 'diff', 'test_report', 'screenshot',
  'pull_request', 'issue', 'release_package', 'custom'
]

const GOAL_STATUSES: readonly WorkflowGoalStatus[] = [
  'draft', 'planned', 'running', 'waiting_approval', 'blocked', 'verifying',
  'completed', 'failed', 'cancelled', 'archived'
]

const WORK_ITEM_STATUSES: readonly WorkflowWorkItemStatus[] = [
  'backlog', 'ready', 'running', 'waiting_approval', 'blocked', 'verifying',
  'done', 'failed', 'cancelled'
]

const WORK_ITEM_TYPES: readonly WorkflowWorkItemType[] = [
  'research', 'analysis', 'planning', 'writing', 'design', 'coding', 'review',
  'testing', 'documentation', 'operations', 'delivery', 'custom'
]

const EVENT_ENTITY_TYPES: readonly WorkflowEventInput['entityType'][] = [
  'goal', 'work_item', 'run', 'artifact', 'acceptance', 'system'
]

const TASK_RUN_STATUSES = new Set([
  'queued',
  'planning',
  'executing',
  'waiting_approval',
  'waiting_reconciliation',
  'recovering',
  'verifying',
  'completed',
  'failed',
  'cancelled'
])

export function normalizeGoalInput(input: WorkflowGoalProjectionInput): WorkflowGoalRecord {
  const id = requiredId(input.id, 'goal id')
  const title = requiredText(input.title, 'goal title')
  const objective = requiredText(input.objective, 'goal objective')
  const now = finiteTimestamp(input.updatedAt ?? input.createdAt ?? Date.now(), 'goal updatedAt')
  const status = optionalGoalStatus(input.status)
  const source = optionalSource(input.source)
  return {
    schemaVersion: 1,
    id,
    projectId: normalizeOptionalId(input.projectId),
    title,
    objective,
    status,
    revision: positiveRevision(input.revision ?? 1),
    source,
    createdAt: finiteTimestamp(input.createdAt ?? now, 'goal createdAt'),
    updatedAt: now,
    dueAt: optionalTimestamp(input.dueAt, 'goal dueAt'),
    archivedAt: optionalTimestamp(input.archivedAt, 'goal archivedAt')
  }
}

export function normalizeWorkItemInput(input: WorkflowWorkItemProjectionInput): WorkflowWorkItemRecord {
  const id = requiredId(input.id, 'work item id')
  const title = requiredText(input.title, 'work item title')
  const now = finiteTimestamp(input.updatedAt ?? input.createdAt ?? Date.now(), 'work item updatedAt')
  const runIds = [...new Set((input.runIds ?? []).map((value) => requiredId(value, 'run id')))]
  const type = optionalWorkItemType(input.type)
  const status = optionalWorkItemStatus(input.status)
  const source = optionalSource(input.source)
  return {
    schemaVersion: 1,
    id,
    projectId: normalizeOptionalId(input.projectId),
    goalId: normalizeOptionalId(input.goalId),
    parentId: normalizeOptionalId(input.parentId),
    businessLineId: storedBusinessLineId(input.businessLineId),
    type,
    title,
    description: optionalText(input.description, 'work item description'),
    role: optionalText(input.role, 'work item role'),
    status,
    revision: positiveRevision(input.revision ?? 1),
    source,
    runIds,
    currentRunId: normalizeOptionalId(input.currentRunId),
    createdAt: finiteTimestamp(input.createdAt ?? now, 'work item createdAt'),
    updatedAt: now,
    dueAt: optionalTimestamp(input.dueAt, 'work item dueAt')
  }
}

export function normalizeArtifactInput(input: WorkflowArtifactInput): WorkflowArtifactRecord {
  const now = finiteTimestamp(input.updatedAt ?? input.createdAt ?? Date.now(), 'artifact updatedAt')
  if (!isArtifactKind(input.kind)) throw new WorkflowLedgerCorruptionError('artifact kind is invalid')
  if (!isOptionalObject(input.metadata)) {
    throw new WorkflowLedgerCorruptionError('artifact metadata must be an object')
  }
  assertWorkflowArtifactMetadataSafe(input.metadata, 'artifact metadata')
  assertWorkflowArtifactUriSafe(input.uri)
  const provenance = optionalSource(input.provenance)
  return {
    schemaVersion: 1,
    id: requiredId(input.id, 'artifact id'),
    projectId: normalizeOptionalId(input.projectId),
    goalId: normalizeOptionalId(input.goalId),
    workItemId: normalizeOptionalId(input.workItemId),
    runId: normalizeOptionalId(input.runId),
    kind: input.kind,
    title: requiredText(input.title, 'artifact title'),
    uri: optionalText(input.uri, 'artifact uri'),
    version: positiveRevision(input.version ?? 1),
    digest: requiredText(input.digest, 'artifact digest'),
    mediaType: optionalText(input.mediaType, 'artifact mediaType'),
    provenance,
    createdAt: finiteTimestamp(input.createdAt ?? now, 'artifact createdAt'),
    updatedAt: now,
    supersedesId: normalizeOptionalId(input.supersedesId),
    metadata: input.metadata
  }
}

export function normalizeAcceptanceInput(input: WorkflowAcceptanceInput): WorkflowAcceptanceRecord {
  const now = finiteTimestamp(input.updatedAt ?? input.createdAt ?? Date.now(), 'acceptance updatedAt')
  if (!Array.isArray(input.criteria) || input.criteria.length === 0) {
    throw new WorkflowLedgerCorruptionError('acceptance criteria must not be empty')
  }
  const criteria = input.criteria.map((criterion) => requiredText(criterion, 'acceptance criterion'))
  const criterionPolicies = normalizeAcceptanceCriterionPolicies(input.criterionPolicies, criteria.length)
  const criterionEvidence = normalizeCriterionEvidence(input.criterionEvidence, criteria.length)
  const status = input.status ?? 'pending'
  if (!isAcceptanceStatus(status)) throw new WorkflowLedgerCorruptionError('acceptance status is invalid')
  return {
    schemaVersion: 1,
    id: requiredId(input.id, 'acceptance id'),
    projectId: normalizeOptionalId(input.projectId),
    goalId: normalizeOptionalId(input.goalId),
    workItemId: normalizeOptionalId(input.workItemId),
    criteria,
    ...(criterionPolicies ? { criterionPolicies } : {}),
    status,
    evidenceRefs: [...new Set((input.evidenceRefs ?? []).map((id) => requiredId(id, 'evidence id')))],
    ...(criterionEvidence ? { criterionEvidence } : {}),
    verifier: optionalText(input.verifier, 'acceptance verifier'),
    verifiedAt: optionalTimestamp(input.verifiedAt, 'acceptance verifiedAt'),
    waiverReason: optionalText(input.waiverReason, 'acceptance waiverReason'),
    waivedBy: optionalText(input.waivedBy, 'acceptance waivedBy'),
    notes: optionalText(input.notes, 'acceptance notes'),
    revision: positiveRevision(input.revision ?? 1),
    createdAt: finiteTimestamp(input.createdAt ?? now, 'acceptance createdAt'),
    updatedAt: now
  }
}

export function normalizeEvidenceLinkInput(
  input: WorkflowEvidenceLinkInput,
  defaults: { createdAt?: number } = {}
): WorkflowEvidenceLinkRecord {
  if (!isEvidenceRelation(input.relation)) {
    throw new WorkflowLedgerCorruptionError('evidence link relation is invalid')
  }
  if (input.evidenceOrigin !== undefined && input.evidenceOrigin !== 'task_effect' && input.evidenceOrigin !== 'workflow') {
    throw new WorkflowLedgerCorruptionError('evidence link origin is invalid')
  }
  const artifactId = normalizeOptionalId(input.artifactId)
  const acceptanceId = normalizeOptionalId(input.acceptanceId)
  if (!artifactId && !acceptanceId) {
    throw new WorkflowLedgerCorruptionError('evidence link requires artifactId or acceptanceId')
  }
  return {
    schemaVersion: 1,
    id: requiredId(input.id, 'evidence link id'),
    evidenceId: requiredId(input.evidenceId, 'evidence id'),
    projectId: normalizeOptionalId(input.projectId),
    runId: normalizeOptionalId(input.runId),
    artifactId,
    acceptanceId,
    criterionId: normalizeOptionalId(input.criterionId),
    ...(input.evidenceOrigin ? { evidenceOrigin: input.evidenceOrigin } : {}),
    relation: input.relation,
    createdAt: finiteTimestamp(input.createdAt ?? defaults.createdAt ?? Date.now(), 'evidence link createdAt')
  }
}

export function normalizeEventInput(input: WorkflowEventInput): WorkflowEventInput & { schemaVersion: 1; occurredAt: number } {
  const eventId = requiredId(input.eventId, 'event id')
  const streamId = requiredId(input.streamId, 'event stream id')
  const entityId = requiredId(input.entityId, 'event entity id')
  const kind = requiredText(input.kind, 'event kind')
  if (!EVENT_ENTITY_TYPES.includes(input.entityType)) {
    throw new WorkflowLedgerCorruptionError(`unsupported event entity type ${String(input.entityType)}`)
  }
  if (!WORKFLOW_EVENT_KINDS.has(kind) && !kind.startsWith('workflow.')) {
    throw new WorkflowLedgerCorruptionError(`unsupported workflow event kind ${kind}`)
  }
  if (!isRecord(input.payload)) throw new WorkflowLedgerCorruptionError('event payload must be an object')
  const occurredAt = finiteTimestamp(input.occurredAt ?? Date.now(), 'event occurredAt')
  return {
    schemaVersion: 1,
    eventId,
    streamId,
    entityType: input.entityType,
    entityId,
    kind,
    payload: input.payload,
    occurredAt,
    ...(normalizeOptionalId(input.causationId) ? { causationId: normalizeOptionalId(input.causationId) } : {}),
    ...(normalizeOptionalId(input.correlationId) ? { correlationId: normalizeOptionalId(input.correlationId) } : {})
  }
}

export function isWorkflowGoal(value: unknown): value is WorkflowGoalRecord {
  if (!isRecord(value)) return false
  const record = value
  return record.schemaVersion === 1 && isId(record.id) && optionalId(record.projectId) &&
    isText(record.title) && isText(record.objective) && isGoalStatus(record.status) &&
    isRevision(record.revision) && isSource(record.source) && isFiniteNumber(record.createdAt) &&
    isFiniteNumber(record.updatedAt) && optionalFinite(record.dueAt) && optionalFinite(record.archivedAt)
}

export function isWorkflowWorkItem(value: unknown): value is WorkflowWorkItemRecord {
  if (!isRecord(value)) return false
  const record = value
  return hasIdentity(record) && hasOptionalIds(record, ['projectId', 'goalId', 'parentId']) &&
    (record.businessLineId === undefined || isBusinessLineId(record.businessLineId)) &&
    hasWorkItemFields(record)
}

export function isWorkflowRun(value: unknown): value is WorkflowRunRecord {
  if (!isRecord(value)) return false
  const record = value
  return hasIdentity(record) && hasOptionalIds(record, ['projectId', 'goalId', 'acceptanceId']) &&
    hasRunAcceptanceBinding(record) && hasRunFields(record)
}

export function isWorkflowArtifact(value: unknown): value is WorkflowArtifactRecord {
  if (!isRecord(value)) return false
  const record = value
  return hasIdentity(record) && hasOptionalIds(record, ['projectId', 'goalId', 'workItemId', 'runId']) &&
    hasArtifactFields(record)
}

export function isWorkflowAcceptance(value: unknown): value is WorkflowAcceptanceRecord {
  if (!isRecord(value)) return false
  const record = value
  return hasIdentity(record) && hasOptionalIds(record, ['projectId', 'goalId', 'workItemId']) &&
    hasAcceptanceFields(record)
}

export function isWorkflowEvidenceLink(value: unknown): value is WorkflowEvidenceLinkRecord {
  if (!isRecord(value)) return false
  const record = value
  return record.schemaVersion === 1 && isId(record.id) && isId(record.evidenceId) &&
    optionalId(record.projectId) && optionalId(record.runId) && optionalId(record.artifactId) &&
    optionalId(record.acceptanceId) && optionalId(record.criterionId) &&
    (record.evidenceOrigin === undefined || record.evidenceOrigin === 'task_effect' || record.evidenceOrigin === 'workflow') &&
    isEvidenceRelation(record.relation) && isFiniteNumber(record.createdAt)
}

function hasIdentity(record: Record<string, unknown>): boolean {
  return record.schemaVersion === 1 && isId(record.id)
}

function hasOptionalIds(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => optionalId(record[key]))
}

function hasWorkItemFields(record: Record<string, unknown>): boolean {
  return isWorkItemType(record.type) && isText(record.title) && optionalTextValue(record.description) &&
    optionalTextValue(record.role) && isWorkItemStatus(record.status) && isRevision(record.revision) &&
    isSource(record.source) && Array.isArray(record.runIds) && record.runIds.every(isId) &&
    optionalId(record.currentRunId) && isFiniteNumber(record.createdAt) && isFiniteNumber(record.updatedAt) &&
    optionalFinite(record.dueAt)
}

function hasRunFields(record: Record<string, unknown>): boolean {
  return isId(record.workItemId) && isId(record.sessionId) && isId(record.taskId) &&
    isTaskRunStatusValue(record.status) && isRevision(record.revision) && isRevision(record.attempt) &&
    isFiniteNumber(record.createdAt) && isFiniteNumber(record.updatedAt) && optionalFinite(record.startedAt) &&
    optionalFinite(record.finishedAt) && optionalTextValue(record.error) && isTaskRunRecord(record.taskRun)
}

function hasRunAcceptanceBinding(record: Record<string, unknown>): boolean {
  const hasAcceptanceId = record.acceptanceId !== undefined
  const hasAcceptanceRevision = record.acceptanceRevision !== undefined
  return hasAcceptanceId === hasAcceptanceRevision &&
    (!hasAcceptanceRevision || isRevision(record.acceptanceRevision))
}

function isTaskRunStatusValue(value: unknown): boolean {
  return typeof value === 'string' && TASK_RUN_STATUSES.has(value)
}

function hasArtifactFields(record: Record<string, unknown>): boolean {
  return isArtifactKind(record.kind) && isText(record.title) && optionalTextValue(record.uri) &&
    isRevision(record.version) && isText(record.digest) && optionalTextValue(record.mediaType) &&
    isSource(record.provenance) && isFiniteNumber(record.createdAt) && isFiniteNumber(record.updatedAt) &&
    optionalId(record.supersedesId) && isOptionalObject(record.metadata)
}

function hasAcceptanceFields(record: Record<string, unknown>): boolean {
  return Array.isArray(record.criteria) && record.criteria.length > 0 && record.criteria.every(isText) &&
    hasAcceptancePolicyAndStatus(record) && Array.isArray(record.evidenceRefs) && record.evidenceRefs.every(isId) &&
    isOptionalCriterionEvidence(record.criterionEvidence, record.criteria.length) &&
    optionalTextValue(record.verifier) && optionalFinite(record.verifiedAt) &&
    optionalTextValue(record.waiverReason) && optionalTextValue(record.waivedBy) && optionalTextValue(record.notes) &&
    isRevision(record.revision) && isFiniteNumber(record.createdAt) && isFiniteNumber(record.updatedAt)
}

function hasAcceptancePolicyAndStatus(record: Record<string, unknown>): boolean {
  return isNormalizedAcceptanceCriterionPolicies(record.criterionPolicies, (record.criteria as unknown[]).length) &&
    isAcceptanceStatus(record.status)
}

function normalizeCriterionEvidence(
  value: WorkflowAcceptanceInput['criterionEvidence'],
  criteriaCount: number
): WorkflowAcceptanceRecord['criterionEvidence'] {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new WorkflowLedgerCorruptionError('acceptance criterionEvidence must be an array')
  }
  const criterionIds = new Set<string>()
  const criterionIndexes = new Set<number>()
  const normalized = value.map((coverage) => {
    if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
      throw new WorkflowLedgerCorruptionError('acceptance criterion evidence must be an object')
    }
    const criterionId = requiredId(coverage.criterionId, 'acceptance criterion id')
    const criterionIndex = coverage.criterionIndex
    if (!Number.isSafeInteger(criterionIndex) || criterionIndex < 0 || criterionIndex >= criteriaCount) {
      throw new WorkflowLedgerCorruptionError('acceptance criterion index is invalid')
    }
    if (!Array.isArray(coverage.evidenceRefs) || coverage.evidenceRefs.length === 0) {
      throw new WorkflowLedgerCorruptionError('acceptance criterion evidenceRefs must not be empty')
    }
    if (criterionIds.has(criterionId) || criterionIndexes.has(criterionIndex)) {
      throw new WorkflowLedgerCorruptionError('acceptance criterion coverage must be unique')
    }
    criterionIds.add(criterionId)
    criterionIndexes.add(criterionIndex)
    return {
      criterionId,
      criterionIndex,
      evidenceRefs: [...new Set(coverage.evidenceRefs.map((id) => requiredId(id, 'criterion evidence id')))]
    }
  })
  return normalized.sort((left, right) => left.criterionIndex - right.criterionIndex)
}

function isOptionalCriterionEvidence(value: unknown, criteriaCount: number): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  const ids = new Set<string>()
  const indexes = new Set<number>()
  return value.every((candidate) => {
    if (!isRecord(candidate)) return false
    if (!isId(candidate.criterionId) || !Number.isSafeInteger(candidate.criterionIndex)) return false
    const criterionIndex = candidate.criterionIndex as number
    if (criterionIndex < 0 || criterionIndex >= criteriaCount || ids.has(candidate.criterionId as string) || indexes.has(criterionIndex)) {
      return false
    }
    if (!Array.isArray(candidate.evidenceRefs) || candidate.evidenceRefs.length === 0 || !candidate.evidenceRefs.every(isId)) {
      return false
    }
    ids.add(candidate.criterionId as string)
    indexes.add(criterionIndex)
    return true
  })
}

export function isArtifactKind(value: unknown): value is WorkflowArtifactKind {
  return typeof value === 'string' && ARTIFACT_KINDS.includes(value as WorkflowArtifactKind)
}

export function isAcceptanceStatus(value: unknown): value is WorkflowAcceptanceStatus {
  return value === 'pending' || value === 'verifying' || value === 'passed' || value === 'failed' || value === 'waived'
}

export function isGoalStatus(value: unknown): value is WorkflowGoalStatus {
  return typeof value === 'string' && GOAL_STATUSES.includes(value as WorkflowGoalStatus)
}

export function isWorkItemStatus(value: unknown): value is WorkflowWorkItemStatus {
  return typeof value === 'string' && WORK_ITEM_STATUSES.includes(value as WorkflowWorkItemStatus)
}

export function isWorkItemType(value: unknown): value is WorkflowWorkItemType {
  return typeof value === 'string' && WORK_ITEM_TYPES.includes(value as WorkflowWorkItemType)
}

export function isSource(value: unknown): value is WorkflowProjectionSource {
  return value === 'explicit' || value === 'dag' || value === 'legacy-derived' || value === 'recovery'
}

function optionalGoalStatus(value: WorkflowGoalStatus | undefined): WorkflowGoalStatus {
  if (value === undefined) return 'draft'
  if (!isGoalStatus(value)) throw new WorkflowLedgerCorruptionError('goal status is invalid')
  return value
}

function optionalWorkItemStatus(value: WorkflowWorkItemStatus | undefined): WorkflowWorkItemStatus {
  if (value === undefined) return 'backlog'
  if (!isWorkItemStatus(value)) throw new WorkflowLedgerCorruptionError('work item status is invalid')
  return value
}

function optionalWorkItemType(value: WorkflowWorkItemType | undefined): WorkflowWorkItemType {
  if (value === undefined) return 'custom'
  if (!isWorkItemType(value)) throw new WorkflowLedgerCorruptionError('work item type is invalid')
  return value
}

function optionalSource(value: WorkflowProjectionSource | undefined): WorkflowProjectionSource {
  if (value === undefined) return 'explicit'
  if (!isSource(value)) throw new WorkflowLedgerCorruptionError('workflow projection source is invalid')
  return value
}

export function isEvidenceRelation(value: unknown): value is WorkflowEvidenceLinkRecord['relation'] {
  return value === 'supports' || value === 'verifies' || value === 'supersedes'
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function optionalId(value: unknown): boolean {
  return value === undefined || isId(value)
}

export function optionalTextValue(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

export function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function optionalFinite(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value)
}

export function requiredId(value: unknown, label: string): string {
  const normalized = normalizeOptionalId(value)
  if (!normalized) throw new WorkflowLedgerCorruptionError(`${label} is required`)
  return normalized
}

export function requiredText(value: unknown, label: string): string {
  if (!isText(value)) throw new WorkflowLedgerCorruptionError(`${label} is required`)
  return value.trim()
}

export function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (!isText(value)) throw new WorkflowLedgerCorruptionError(`${label} must be text`)
  return value.trim()
}

export function normalizeOptionalId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkflowLedgerCorruptionError('identifier must be non-empty text')
  }
  return value.trim()
}

export function positiveRevision(value: unknown): number {
  if (!isRevision(value)) throw new WorkflowLedgerCorruptionError('revision must be a positive integer')
  return value
}

export function finiteTimestamp(value: unknown, label: string, seq?: number): number {
  if (!isFiniteNumber(value)) throw new WorkflowLedgerCorruptionError(`${label} must be finite`, seq)
  return value
}

export function optionalTimestamp(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  return finiteTimestamp(value, label)
}

export function pageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE
  if (!Number.isInteger(value) || value <= 0) throw new WorkflowLedgerCorruptionError('limit must be a positive integer')
  return Math.min(MAX_PAGE_SIZE, value)
}

export function cursorOffset(value: string | undefined): number {
  if (value === undefined) return 0
  if (!/^\d+$/.test(value)) throw new WorkflowLedgerCorruptionError('cursor must be a decimal offset')
  const offset = Number(value)
  if (!Number.isSafeInteger(offset)) throw new WorkflowLedgerCorruptionError('cursor is out of range')
  return offset
}

export function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function stringField(value: unknown, seq: number): string {
  if (typeof value !== 'string' || !value) throw new WorkflowLedgerCorruptionError('event text field is invalid', seq)
  return value
}

export function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : typeof value === 'string' && value ? value : undefined
}

export function entityTypeField(value: unknown, seq: number): WorkflowEventInput['entityType'] {
  if (EVENT_ENTITY_TYPES.includes(value as WorkflowEventInput['entityType'])) {
    return value as WorkflowEventInput['entityType']
  }
  throw new WorkflowLedgerCorruptionError('event entity type is invalid', seq)
}

export function eventImmutable(record: WorkflowEventInput | WorkflowEventRecord): Record<string, unknown> {
  return {
    eventId: record.eventId,
    streamId: record.streamId,
    entityType: record.entityType,
    entityId: record.entityId,
    kind: record.kind,
    payload: record.payload,
    occurredAt: record.occurredAt,
    causationId: record.causationId,
    correlationId: record.correlationId,
    ...('projectId' in record ? { projectId: record.projectId } : {}),
    ...('goalId' in record ? { goalId: record.goalId } : {}),
    ...('workItemId' in record ? { workItemId: record.workItemId } : {}),
    ...('runId' in record ? { runId: record.runId } : {}),
    ...('sessionId' in record ? { sessionId: record.sessionId } : {})
  }
}

export function decodePayload<T>(
  payload: unknown,
  predicate: (value: unknown) => value is T,
  label: string
): T {
  if (typeof payload !== 'string') throw new WorkflowLedgerCorruptionError(`${label} payload is not text`)
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw new WorkflowLedgerCorruptionError(`${label} payload is not valid JSON`)
  }
  if (!predicate(parsed)) throw new WorkflowLedgerCorruptionError(`${label} payload schema validation failed`)
  return parsed
}

export function decodeEventRow(row: Record<string, unknown>): WorkflowEventRecord {
  const seq = numeric(row.seq)
  if (!seq || !Number.isInteger(seq) || seq <= 0) {
    throw new WorkflowLedgerCorruptionError('event seq is invalid', seq)
  }
  const payload = parseEventPayload(row.payload, seq)
  const normalized = normalizeEventInput({
    eventId: stringField(row.event_id, seq),
    streamId: stringField(row.stream_id, seq),
    entityType: entityTypeField(row.entity_type, seq),
    entityId: stringField(row.entity_id, seq),
    kind: stringField(row.kind, seq),
    payload,
    occurredAt: finiteTimestamp(row.occurred_at, 'event occurredAt', seq),
    causationId: nullableString(row.causation_id),
    correlationId: nullableString(row.correlation_id)
  })
  const record: WorkflowEventRecord = {
    ...normalized,
    schemaVersion: 1,
    seq,
    prevDigest: stringField(row.prev_digest, seq),
    digest: stringField(row.record_digest, seq),
    ...optionalEventScopes(row)
  }
  const { digest: _recordDigest, ...recordWithoutDigest } = record
  if (record.digest !== digest(recordWithoutDigest)) {
    throw new WorkflowLedgerCorruptionError('event record digest mismatch', seq)
  }
  return record
}

function parseEventPayload(value: unknown, seq: number): Record<string, unknown> {
  if (typeof value !== 'string') throw new WorkflowLedgerCorruptionError('event payload is not text', seq)
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new WorkflowLedgerCorruptionError('event payload is not valid JSON', seq)
  }
}

function optionalEventScopes(row: Record<string, unknown>): Pick<WorkflowEventRecord, 'projectId' | 'goalId' | 'workItemId' | 'runId' | 'sessionId'> {
  return {
    ...(nullableString(row.project_id) ? { projectId: nullableString(row.project_id) } : {}),
    ...(nullableString(row.goal_id) ? { goalId: nullableString(row.goal_id) } : {}),
    ...(nullableString(row.work_item_id) ? { workItemId: nullableString(row.work_item_id) } : {}),
    ...(nullableString(row.run_id) ? { runId: nullableString(row.run_id) } : {}),
    ...(nullableString(row.session_id) ? { sessionId: nullableString(row.session_id) } : {})
  }
}

function isOptionalObject(value: unknown): value is Record<string, unknown> | undefined {
  return value === undefined || isRecord(value)
}
