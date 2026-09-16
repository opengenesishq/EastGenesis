import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'
import type { ProjectAggregatePortableFile, ProjectAggregateSnapshot, ProjectAggregatePortableTaskPlan } from '../../shared/project-aggregate-types'
import type { ProjectSubmissionReceiptSlice, PortableSessionInput, PortableProjectGoalSubmission } from '../../shared/submission-receipt-portability-types'
import type { SessionInputRecord } from '../../shared/session-input-types'
import type { SendMessagePayload } from '../../shared/types'
import { writeDurableFileSync } from '../durable-file'
import { messagePayloadDigest } from '../message-payload-digest'
import { normalizeStableMessagePayload } from '../stable-message-payload'
import { assertGoalStartDecision, goalPreparationDigest, normalizeGoalPreparation } from '../project-workspace/goal-submission-store'
import { goalTaskIds } from '../project-workspace/goal-task-service'
import { assertNoCredentialMaterial, projectAggregateCanonicalJson, projectAggregateDigest } from '../project-aggregate/codec'
import { listProjectSubmissionReceiptFiles } from './submission-receipt-files'
import { normalizeRequirementRevisionIntent } from '../../shared/session-requirement-revision'

type PortableContext = {
  sessionIds: readonly string[]; sessionFiles: readonly ProjectAggregatePortableFile[]
  sessionHistory?: readonly unknown[]; activeSessions?: readonly unknown[]; sessionCreationJournal?: readonly unknown[]
  taskSnapshots?: readonly unknown[]
  taskPlans?: readonly ProjectAggregatePortableTaskPlan[]
}

export function collectProjectSubmissionReceipts(rootDir: string, projectId: string, context: PortableContext): ProjectSubmissionReceiptSlice {
  const sessionInputs: PortableSessionInput[] = [], projectGoals: PortableProjectGoalSubmission[] = []
  for (const file of listProjectSubmissionReceiptFiles(rootDir, projectId, new Set(context.sessionIds))) {
    if (file.path.endsWith('.tmp')) throw new Error('Unpublished submission receipt must be recovered before Project export')
    const value: unknown = JSON.parse(readFileSync(file.path, 'utf8'))
    if (file.kind === 'sessionInputs') {
      const record = parseSessionInput(value)
      const evidencePayloadDigest = record.importedPayloadDigest ?? messagePayloadDigest(record.payload)
      const evidencePayloadPaths = record.importedPayloadPaths ?? {
        images: (record.payload.images ?? []).map((item) => item.path), documents: (record.payload.documents ?? []).map((item) => item.path)
      }
      sessionInputs.push({ record: { ...record, payload: portablePayload(rootDir, record) }, evidencePayloadDigest, evidencePayloadPaths })
    } else projectGoals.push(parseProjectGoal(value))
  }
  sessionInputs.sort((a, b) => a.record.sessionId.localeCompare(b.record.sessionId) || a.record.id.localeCompare(b.record.id))
  projectGoals.sort((a, b) => a.input.requestId.localeCompare(b.input.requestId))
  const body = { schemaVersion: 1 as const, projectId, sessionInputs, projectGoals }
  const slice = { ...body, sliceDigest: projectAggregateDigest(body) }
  validateProjectSubmissionReceipts(projectId, slice, context)
  return slice
}

export function validateProjectSubmissionReceipts(projectId: string, value: ProjectSubmissionReceiptSlice | undefined, context: PortableContext): void {
  if (value === undefined) return
  if (!isRecord(value) || value.schemaVersion !== 1 || value.projectId !== projectId ||
      !Array.isArray(value.sessionInputs) || !Array.isArray(value.projectGoals)) fail('invalid slice')
  const { sliceDigest, ...body } = value
  if (sliceDigest !== projectAggregateDigest(body)) fail('slice digest mismatch')
  // Source text must remain exact for idempotency. A secret-bearing request blocks this
  // portable export rather than silently changing the request or hiding it in base64.
  assertNoCredentialMaterial(value)
  const sessionIds = new Set(context.sessionIds), ids = new Set<string>()
  for (const item of value.sessionInputs) {
    if (!isRecord(item) || typeof item.evidencePayloadDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.evidencePayloadDigest)) fail('invalid payload evidence digest')
    const record = parseSessionInput(item.record)
    if (record.workspaceId !== projectId || !sessionIds.has(record.sessionId)) fail('Session input crosses Project ownership')
    assertSessionBinding(record, context)
    unique(ids, `input:${record.sessionId}:${record.id}`)
    for (const attachment of [...(record.payload.images ?? []), ...(record.payload.documents ?? [])]) {
      assertAttachment(record.sessionId, attachment, context.sessionFiles)
    }
    if (record.importedPayloadDigest && record.importedPayloadDigest !== item.evidencePayloadDigest) fail('imported evidence binding mismatch')
    assertEvidencePayload(item)
  }
  for (const valueRecord of value.projectGoals) {
    const record = parseProjectGoal(valueRecord)
    if (record.input.projectId !== projectId || !sessionIds.has(record.sessionId)) fail('Project submission crosses ownership')
    assertGoalSessionBinding(record, context)
    unique(ids, `goal:${goalTaskIds(projectId, record.input.requestId).goalId}`)
  }
}

/** Canonical references remain authority; the private receipt cannot invent another task. */
export function validateSubmissionReceiptBindings(slice: ProjectSubmissionReceiptSlice | undefined, aggregate: ProjectAggregateSnapshot): void {
  if (!slice) return
  const goals = new Map(aggregate.goals.map((goal) => [goal.id, goal]))
  const workItems = new Map(aggregate.workItems.map((item) => [item.id, item]))
  for (const { record } of slice.sessionInputs) {
    if (!record.goalId && !record.workItemId) continue
    if (!record.goalId || !record.workItemId) fail('Project input has incomplete canonical task binding')
    const goal = goals.get(record.goalId), item = workItems.get(record.workItemId)
    if (!goal || goal.projectId !== slice.projectId || !item || item.projectId !== slice.projectId || item.goalId !== goal.id) fail('input task binding mismatch')
    if (record.phase === 'requirements_applied') {
      const receipt = record.requirementRevision!
      const source = aggregate.audit.find(entry => entry.source === 'project_workspace' &&
        isRecord(entry.value) && entry.value.id === receipt.sourceEventId)?.value
      if (!isRecord(source) || !isRecord(source.payload) || source.kind !== 'goal.requirements_revised' || source.entityId !== goal.id ||
          source.payload.workItemId !== item.id || source.payload.sessionId !== record.sessionId || source.payload.requestId !== record.id ||
          source.payload.payloadDigest !== (record.importedPayloadDigest ?? messagePayloadDigest(record.payload)) ||
          source.payload.goalRevision !== receipt.goalRevision || source.payload.workItemRevision !== receipt.workItemRevision ||
          projectAggregateCanonicalJson(source.payload.requirements) !== projectAggregateCanonicalJson(receipt.requirements)) fail('requirement revision source binding mismatch')
    }
  }
  for (const record of slice.projectGoals) {
    const ids = goalTaskIds(slice.projectId, record.input.requestId)
    const goal = goals.get(ids.goalId), item = workItems.get(ids.workItemId)
    if (record.phase !== 'reserved' && (!goal || !item)) fail('prepared task is missing')
    if (goal && (goal.projectId !== slice.projectId || goal.objective !== record.input.objective)) fail('Goal request binding mismatch')
    if (item && (item.projectId !== slice.projectId || item.goalId !== ids.goalId ||
        (record.input.businessLineId && item.businessLineId !== record.input.businessLineId))) fail('WorkItem request binding mismatch')
  }
}

export function assertProjectSubmissionReceiptsImportable(rootDir: string, projectId: string,
  slice: ProjectSubmissionReceiptSlice | undefined, context: PortableContext): void {
  validateProjectSubmissionReceipts(projectId, slice, context)
  if (!slice) return
  for (const { record } of slice.sessionInputs) {
    for (const attachment of [...(record.payload.images ?? []), ...(record.payload.documents ?? [])]) {
      assertRegularTarget(rootDir, safeTarget(rootDir, attachment.path))
    }
  }
  for (const record of materializedReceipts(rootDir, slice)) assertExistingCompatible(rootDir, record.path, record.value)
}

/** Invoked by the existing resumable Project runtime-import phase; never calls an engine. */
export function importProjectSubmissionReceipts(rootDir: string, projectId: string,
  slice: ProjectSubmissionReceiptSlice | undefined, context: PortableContext): void {
  assertProjectSubmissionReceiptsImportable(rootDir, projectId, slice, context)
  if (!slice) return
  for (const record of materializedReceipts(rootDir, slice)) {
    if (assertExistingCompatible(rootDir, record.path, record.value)) continue
    writeDurableFileSync(record.path, projectAggregateCanonicalJson(record.value), { replace: false })
  }
}

export function verifyProjectSubmissionReceipts(rootDir: string, projectId: string,
  slice: ProjectSubmissionReceiptSlice | undefined, context: PortableContext): void {
  validateProjectSubmissionReceipts(projectId, slice, context)
  if (!slice) return
  for (const record of materializedReceipts(rootDir, slice)) {
    if (!assertExistingCompatible(rootDir, record.path, record.value)) fail('imported receipt is missing')
  }
}

function materializedReceipts(rootDir: string, slice: ProjectSubmissionReceiptSlice): Array<{ path: string; value: unknown }> {
  return [
    ...slice.sessionInputs.map(({ record, evidencePayloadDigest, evidencePayloadPaths }) => {
      const unknown = record.phase === 'dispatching'
      const phase = unknown ? 'needs_reconciliation' as const : record.phase
      const value: SessionInputRecord = {
        ...record,
        payload: { ...record.payload,
          ...(record.payload.images ? { images: record.payload.images.map((item) => ({ ...item, path: safeTarget(rootDir, item.path) })) } : {}),
          ...(record.payload.documents ? { documents: record.payload.documents.map((item) => ({ ...item, path: safeTarget(rootDir, item.path) })) } : {}) },
        phase,
        ...(phase === 'queued' ? {} : { importedPayloadDigest: evidencePayloadDigest, importedPayloadPaths: evidencePayloadPaths }),
        ...(unknown ? { error: '导入前提交结果尚未确认；请核对原始记录，不会自动重发。' } : {})
      }
      return { path: join(resolve(rootDir), 'private', 'session-inputs', hash(record.sessionId), `${hash(record.id)}.json`), value }
    }),
    ...slice.projectGoals.map((record) => ({
      path: join(resolve(rootDir), 'private', 'project-goal-submissions', `${goalTaskIds(slice.projectId, record.input.requestId).goalId}.json`),
      value: record
    }))
  ]
}

function portablePayload(rootDir: string, record: SessionInputRecord): SendMessagePayload {
  const convert = <T extends { path: string }>(value: T): T => ({ ...value, path: portablePath(relative(resolve(rootDir), resolve(value.path))) })
  return { ...record.payload,
    ...(record.payload.images ? { images: record.payload.images.map(convert) } : {}),
    ...(record.payload.documents ? { documents: record.payload.documents.map(convert) } : {}) }
}

function assertEvidencePayload(item: PortableSessionInput): void {
  const { record, evidencePayloadPaths: paths } = item
  if (!paths || !Array.isArray(paths.images) || !Array.isArray(paths.documents) ||
      paths.images.length !== (record.payload.images?.length ?? 0) || paths.documents.length !== (record.payload.documents?.length ?? 0) ||
      [...paths.images, ...paths.documents].some((path) => typeof path !== 'string' || !/^(?:\/|[A-Za-z]:[\\/])/.test(path) || /[\0-\x1f]/.test(path))) {
    fail('invalid source attachment path metadata')
  }
  const source: SendMessagePayload = { ...record.payload,
    ...(record.payload.images ? { images: record.payload.images.map((value, index) => ({ ...value, path: paths.images[index] })) } : {}),
    ...(record.payload.documents ? { documents: record.payload.documents.map((value, index) => ({ ...value, path: paths.documents[index] })) } : {}) }
  if (messagePayloadDigest(source) !== item.evidencePayloadDigest) fail('source payload evidence does not match the saved request')
  if (record.importedPayloadPaths && projectAggregateCanonicalJson(record.importedPayloadPaths) !== projectAggregateCanonicalJson(paths)) fail('imported source path binding mismatch')
}

function parseSessionInput(value: unknown): SessionInputRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.payload)) fail('invalid Session input')
  const record = value as unknown as SessionInputRecord
  if (record.payload.requirementRevisionIntent) normalizeRequirementRevisionIntent(record.payload.requirementRevisionIntent)
  if (record.phase === 'requirements_applied' && (!record.payload.requirementRevisionIntent ||
      record.requirementRevision?.schemaVersion !== 1 || !record.requirementRevision.sourceEventId ||
      !Number.isSafeInteger(record.requirementRevision.goalRevision) || !Number.isSafeInteger(record.requirementRevision.workItemRevision))) fail('invalid requirement revision receipt')
  if (typeof record.sessionId !== 'string' || typeof record.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(record.sessionId) || !/^[A-Za-z0-9_-]{1,160}$/.test(record.id) ||
      record.messageId !== `session-input:${record.sessionId}:${record.id}` ||
      !['queued', 'dispatching', 'applied', 'requirements_applied', 'needs_reconciliation', 'cancelled'].includes(record.phase) ||
      typeof record.payload.text !== 'string' || record.payload.text.length > 200_000 ||
      record.payload.messageId || !timestamp(record.createdAt) || !timestamp(record.updatedAt) ||
      (record.revision !== undefined && (!Number.isSafeInteger(record.revision) || record.revision < 1))) fail('invalid Session input record')
  if ((record.payload.images !== undefined && !Array.isArray(record.payload.images)) ||
      (record.payload.documents !== undefined && !Array.isArray(record.payload.documents))) fail('invalid attachment array')
  for (const field of ['workspaceId', 'goalId', 'workItemId'] as const) {
    if (record[field] !== undefined && (typeof record[field] !== 'string' || !record[field]?.trim())) fail('invalid task identity')
  }
  if (record.importedPayloadDigest !== undefined && (record.phase === 'queued' || !/^[a-f0-9]{64}$/.test(record.importedPayloadDigest))) fail('invalid imported payload binding')
  if (record.importedPayloadDigest !== undefined && record.importedPayloadPaths === undefined) fail('missing imported source evidence')
  if (record.importedPayloadPaths !== undefined) {
    const paths = record.importedPayloadPaths
    const valid = isRecord(paths) && Array.isArray(paths.images) && Array.isArray(paths.documents) &&
      paths.images.length === (record.payload.images?.length ?? 0) && paths.documents.length === (record.payload.documents?.length ?? 0) &&
      [...paths.images, ...paths.documents].every((path) => typeof path === 'string' && /^(?:\/|[A-Za-z]:[\\/])/.test(path) && !/[\0-\x1f]/.test(path))
    if (!valid || record.importedPayloadDigest === undefined || record.phase === 'queued') fail('invalid imported payload paths')
  }
  const payload = normalizeStableMessagePayload(record.payload)
  if ((record.payload.images?.length ?? 0) !== payload.images.length || (record.payload.documents?.length ?? 0) !== payload.documents.length ||
      (!payload.text && !payload.images.length && !payload.documents.length)) fail('invalid attachment payload')
  return structuredClone(record)
}

function parseProjectGoal(value: unknown): PortableProjectGoalSubmission {
  if (!isRecord(value) || !isRecord(value.input)) fail('invalid Project submission')
  const record = value as unknown as PortableProjectGoalSubmission
  assertGoalStartDecision(record.startDecision)
  const input = normalizeGoalPreparation(record.input)
  if (record.schemaVersion !== 1 || record.digest !== goalPreparationDigest(input) ||
      !/^[a-f0-9-]{36}$/.test(record.sessionId) || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
      !timestamp(record.createdAt) || !timestamp(record.updatedAt) ||
      !['reserved', 'task_created', 'creating_session', 'session_ready', 'ready'].includes(record.phase)) fail('invalid Project submission record')
  if (projectAggregateCanonicalJson(input) !== projectAggregateCanonicalJson(record.input)) fail('unexpected Project submission fields')
  return structuredClone(record)
}

function assertAttachment(sessionId: string, attachment: { path: string; hash: string; id: string; bytes: number; mime: string; dataClass?: string }, files: readonly ProjectAggregatePortableFile[]): void {
  const path = portablePath(attachment.path)
  if (!path.startsWith(`attachments/${sessionId}/`) || !/^[a-f0-9]{64}$/.test(attachment.hash) || attachment.id !== attachment.hash) fail('attachment crosses Session ownership')
  const file = files.find((file) => file.path === path)
  if (!file || file.digest !== `sha256:${attachment.hash}` || file.sizeBytes !== attachment.bytes) fail('attachment bytes are missing or changed')
  const bytes = Buffer.from(file.data, 'base64')
  if (bytes.toString('base64') !== file.data || bytes.byteLength !== attachment.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== attachment.hash) fail('attachment content digest mismatch')
  if (path.includes('/documents/')) {
    if (!['S2', 'S3'].includes(attachment.dataClass ?? '') || path !== `attachments/${sessionId}/documents/${attachment.dataClass}/${attachment.hash}.txt` ||
        attachment.mime !== 'text/plain; charset=utf-8') fail('invalid document path')
    assertNoCredentialMaterial(Buffer.from(file.data, 'base64').toString('utf8'))
  } else {
    const extension: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
    if (path !== `attachments/${sessionId}/${attachment.hash}.${extension[attachment.mime] ?? 'invalid'}`) fail('invalid image path')
  }
}

function sessionMetadata(sessionId: string, context: PortableContext): Record<string, unknown>[] {
  return [...(context.sessionHistory ?? []), ...(context.activeSessions ?? []),
    ...(context.sessionCreationJournal ?? []), ...(context.taskSnapshots ?? [])].flatMap((value) => {
    if (!isRecord(value)) return []
    const nested = isRecord(value.meta) ? value.meta : isRecord(value.draft) && isRecord(value.draft.baseMeta) ? value.draft.baseMeta : value
    return nested.id === sessionId || value.sessionId === sessionId ? [nested] : []
  })
}

function assertSessionBinding(record: SessionInputRecord, context: PortableContext): void {
  const candidates = sessionMetadata(record.sessionId, context)
  if (candidates.length === 0) fail('input Session metadata is missing')
  for (const meta of candidates) {
    if ((meta.workspaceId ?? meta.projectId) !== record.workspaceId || meta.goalId !== record.goalId || meta.workItemId !== record.workItemId) fail('input Session identity mismatch')
  }
}

function assertGoalSessionBinding(record: PortableProjectGoalSubmission, context: PortableContext): void {
  const candidates = sessionMetadata(record.sessionId, context)
  const ids = goalTaskIds(record.input.projectId, record.input.requestId)
  if (['session_ready', 'ready'].includes(record.phase) && candidates.length === 0) fail('prepared Session metadata is missing')
  for (const meta of candidates) {
    if ((meta.workspaceId ?? meta.projectId) !== record.input.projectId || meta.goalId !== ids.goalId ||
        meta.workItemId !== ids.workItemId || meta.parentSessionId || meta.personalWorkspaceId ||
        (record.input.businessLineId && meta.businessLineId !== record.input.businessLineId)) fail('prepared Session identity mismatch')
  }
  const plans = (context.taskPlans ?? []).filter((plan) => plan.sessionId === record.sessionId)
  if (record.phase === 'ready' && plans.length === 0) fail('prepared Task Plan is missing')
  for (const plan of plans) {
    const versions = isRecord(plan.value) && Array.isArray(plan.value.versions) ? plan.value.versions : []
    if (record.phase === 'ready' && versions.length === 0) fail('prepared Task Plan has no version')
    for (const version of versions) {
      const binding = isRecord(version) && isRecord(version.binding) ? version.binding : undefined
      if (!binding || binding.sessionId !== record.sessionId || binding.workspaceId !== record.input.projectId ||
          binding.goalId !== ids.goalId || binding.workItemId !== ids.workItemId) fail('prepared Task Plan identity mismatch')
    }
  }
}

function assertRegularTarget(rootDir: string, path: string): boolean {
  const root = resolve(rootDir), relativePath = portablePath(relative(root, path))
  let current = root
  const parts = relativePath.split('/')
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    let stat: ReturnType<typeof lstatSync>
    try { stat = lstatSync(current) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) fail('unsafe receipt target')
  }
  return true
}

function assertExistingCompatible(rootDir: string, path: string, expected: unknown): boolean {
  if (!assertRegularTarget(rootDir, path)) return false
  const actual: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (projectAggregateCanonicalJson(actual) !== projectAggregateCanonicalJson(expected)) fail('target receipt identity conflict')
  return true
}

function safeTarget(rootDir: string, path: string): string { return resolve(rootDir, ...portablePath(path).split('/')) }
function portablePath(value: string): string {
  if (!value || value.includes('\\') || value.includes('\0') || isAbsolute(value) || value !== posix.normalize(value) || value === '..' || value.startsWith('../')) fail('unsafe portable path')
  return value
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function timestamp(value: number): boolean { return Number.isFinite(value) && value >= 0 }
function unique(ids: Set<string>, value: string): void { if (ids.has(value)) fail('duplicate receipt identity'); ids.add(value) }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function fail(message: string): never { throw new Error(`Project submission portability: ${message}`) }
