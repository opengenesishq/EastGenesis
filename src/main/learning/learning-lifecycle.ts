import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { withDataLifecycleMutation } from '../data-lifecycle/data-lifecycle-mutation-lock'
import { readMemoryRetentionPolicies } from '../memory/memory-retention-policy'
import { assertMemoryProjectWritable } from '../memory/memory-project-lifecycle'
import { projectLearningNamespace } from '../project-aggregate/project-memory-adapter'
import type {
  LearningActor,
  LearningAuditAction,
  LearningAuditEvent,
  LearningDraftInput,
  LearningPayload,
  LearningProjectSnapshot,
  LearningRecord,
  LearningStatus,
  SkillLearningPayload
} from '../../shared/learning-types'
import type { TrustedLearningDecision } from './learning-security'
import { requireTrustedUserLearningActor } from './learning-security'
import { redactSensitiveValue } from '../security/secret-redaction'
import {
  materializedContentDigest,
  normalizeSkillRelativePath,
  skillMaterializationPath,
  securelyRemoveMaterializedSkill,
  securelyWriteMaterializedSkill
} from './learning-materialization'
export { skillMaterializationPath }
import {
  learningStateExistsSync,
  learningStatePath,
  learningProjectHash,
  mutateLearningState,
  mutateLearningStateSync,
  readLearningState,
  readLearningStateSync,
  resolveDefaultLearningRoot,
  resolveDefaultLearningRootSync,
  type LearningPersistedState
} from './learning-store'
import { approveManagedLearningSkillRuntime } from '../plugin/plugin-runtime-authorization'
import { assertSharedMemoryContributionAllowed } from '../memory/memory-preferences'

export interface LearningProposalContext {
  actor?: LearningActor
  requestedId?: string
  requestedLogicalId?: string
  now?: () => number
}

const DEFAULT_PROPOSAL_ACTOR: LearningActor = {
  type: 'runtime',
  id: 'learning-runtime',
  source: 'main-process'
}

const reconciliationTails = new Map<string, Promise<void>>()

export async function createLearningDraft(
  projectRoot: string,
  learningRoot: string,
  input: LearningDraftInput,
  context: LearningProposalContext = {}
): Promise<LearningRecord> {
  return withDataLifecycleMutation(dirname(resolve(learningRoot)), async () => {
    if (input.kind === 'memory') await expireConfiguredProjectMemory(projectRoot, learningRoot)
    return createLearningDraftNow(projectRoot, learningRoot, input, context)
  })
}

async function createLearningDraftNow(
  projectRoot: string,
  learningRoot: string,
  input: LearningDraftInput,
  context: LearningProposalContext
): Promise<LearningRecord> {
  const safeInput = redactSensitiveValue(input)
  const safeContext = redactSensitiveValue(context)
  const project = learningProjectHash(projectRoot)
  const actor = normalizeActor(safeContext.actor ?? DEFAULT_PROPOSAL_ACTOR)
  const source = requiredText(safeInput.source, 'source', 256)
  const confidence = normalizeConfidence(safeInput.confidence)
  const payload = normalizePayload(safeInput.kind, safeInput.payload)
  const workerScope = normalizeWorkerScope(safeInput, payload)
  const digest = payloadDigest(payload)
  const expiresAt = normalizeOptionalTime(safeInput.expiresAt, 'expiresAt')

  return mutateLearningState(learningRoot, projectRoot, (state) => {
    if (safeInput.kind === 'memory') assertSharedMemoryContributionAllowed()
    const previous = safeInput.supersedes ? findRecord(state, safeInput.supersedes) : undefined
    if (previous?.kind === 'memory' && previous.status !== 'active') {
      throw new Error('Memory revision must start from the currently active version; refresh before revising')
    }
    if (previous && previous.kind !== safeInput.kind) throw new Error('A learning revision must keep the same kind')
    if (previous && previous.project !== project) throw new Error('Learning project mismatch')
    if (previous && !sameWorkerScope(previous, workerScope)) {
      throw new Error('A learning revision must keep the same scope and Worker namespace')
    }

    const duplicate = state.records.find((record) => matchesDraft(
      record, safeInput.kind, digest, workerScope, previous?.id, source
    ))
    if (duplicate) return cloneRecord(duplicate)

    const logicalId = previous?.logicalId ?? safeRequestedId(safeContext.requestedLogicalId, randomUUID())
    assertSkillPathOwnership(state, payload, logicalId)
    const now = timestamp(safeContext.now)
    const version = previous ? maxVersion(state, logicalId) + 1 : 1
    const id = safeRequestedId(safeContext.requestedId, randomUUID())
    if (state.records.some((record) => record.id === id)) throw new Error(`Learning record already exists: ${id}`)
    const record: LearningRecord = {
      schemaVersion: 1,
      id,
      logicalId,
      kind: safeInput.kind,
      project,
      ...workerScope,
      source,
      confidence,
      digest,
      diff: buildDiff(previous?.payload, payload, previous?.digest),
      status: 'draft',
      version,
      ...(previous ? { supersedes: previous.id } : {}),
      actor,
      createdAt: now,
      updatedAt: now,
      ...(expiresAt ? { expiresAt } : {}),
      payload
    }
    state.records.push(record)
    state.audit.push(auditEvent(record, 'proposed', actor, undefined, 'draft', now))
    return cloneRecord(record)
  })
}

function sameWorkerScope(
  record: LearningRecord,
  scope: Pick<LearningRecord, 'scope' | 'workerId' | 'memoryNamespace'>
): boolean {
  return [record.scope === scope.scope, record.workerId === scope.workerId,
    record.memoryNamespace === scope.memoryNamespace].every(Boolean)
}

function matchesDraft(
  record: LearningRecord,
  kind: LearningRecord['kind'],
  digest: string,
  scope: Pick<LearningRecord, 'scope' | 'workerId' | 'memoryNamespace'>,
  supersedes: string | undefined,
  source: string
): boolean {
  return [
    record.status === 'draft',
    record.kind === kind,
    record.digest === digest,
    sameWorkerScope(record, scope),
    record.supersedes === supersedes,
    record.source === source
  ].every(Boolean)
}

export async function importSkillLearningBaseline(
  projectRoot: string,
  learningRoot: string,
  payloadInput: SkillLearningPayload,
  source = 'legacy-skill-import'
): Promise<LearningRecord> {
  const payload = normalizePayload('skill', payloadInput) as SkillLearningPayload
  const digest = payloadDigest(payload)
  const project = learningProjectHash(projectRoot)
  return mutateLearningState(learningRoot, projectRoot, (state) => {
    const existing = latestSkillRecordForPath(state, payload.relativePath)
    if (existing) return cloneRecord(existing)
    const now = timestamp()
    const actor: LearningActor = { type: 'system', id: 'learning-migration', source }
    const record: LearningRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      logicalId: randomUUID(),
      kind: 'skill',
      project,
      scope: 'project',
      source,
      confidence: 1,
      digest,
      diff: buildDiff(undefined, payload),
      status: 'superseded',
      version: 1,
      actor,
      createdAt: now,
      updatedAt: now,
      decidedAt: now,
      payload
    }
    state.records.push(record)
    state.audit.push(auditEvent(record, 'imported', actor, undefined, 'superseded', now))
    return cloneRecord(record)
  })
}

export async function approveLearningDraft(
  projectRoot: string,
  learningRoot: string,
  recordId: string,
  authority: TrustedLearningDecision
): Promise<LearningRecord> {
  return withDataLifecycleMutation(dirname(resolve(learningRoot)), async () => {
    requireTrustedUserLearningActor(authority)
    await expireConfiguredProjectMemory(projectRoot, learningRoot)
    return approveLearningDraftNow(projectRoot, learningRoot, recordId, authority)
  })
}

async function approveLearningDraftNow(
  projectRoot: string,
  learningRoot: string,
  recordId: string,
  authority: TrustedLearningDecision
): Promise<LearningRecord> {
  const actor = requireTrustedUserLearningActor(authority)
  let expired = false
  const record = await mutateLearningState(learningRoot, projectRoot, (state) => {
    const target = findRecord(state, recordId)
    if (target.kind === 'memory') assertSharedMemoryContributionAllowed()
    if (target.status === 'active') return cloneRecord(target)
    if (target.status !== 'draft') throw invalidTransition(target, 'active')
    if (target.kind === 'memory' && target.supersedes) {
      const previous = findRecord(state, target.supersedes)
      if (previous.status !== 'active' || previous.logicalId !== target.logicalId) {
        throw new Error('Memory changed or was removed after this revision was proposed; refresh before approving')
      }
    }
    const now = timestamp()
    if (target.expiresAt && target.expiresAt <= now) {
      transition(state, target, 'expired', 'expired', actor, now, 'Draft expired before approval')
      expired = true
      return cloneRecord(target)
    }
    for (const current of state.records) {
      if (current.logicalId === target.logicalId && current.status === 'active') {
        transition(state, current, 'superseded', 'approved', actor, now, `Superseded by ${target.id}`)
      }
    }
    transition(state, target, 'active', 'approved', actor, now)
    if (target.kind === 'skill') markMaterializationPending(state, now)
    return cloneRecord(target)
  })
  await reconcileLearningMaterialization(projectRoot, learningRoot)
  if (expired) throw new Error(`Learning draft expired before approval: ${recordId}`)
  return record
}

export async function rejectLearningDraft(
  projectRoot: string,
  learningRoot: string,
  recordId: string,
  authority: TrustedLearningDecision
): Promise<LearningRecord> {
  const actor = requireTrustedUserLearningActor(authority)
  const record = await decideStatus(projectRoot, learningRoot, recordId, authority, 'draft', 'rejected', 'rejected', actor)
  await reconcileLearningMaterialization(projectRoot, learningRoot)
  return record
}

export async function rollbackLearningRecord(
  projectRoot: string,
  learningRoot: string,
  targetRecordId: string,
  authority: TrustedLearningDecision
): Promise<LearningRecord> {
  return withDataLifecycleMutation(dirname(resolve(learningRoot)), async () => {
    requireTrustedUserLearningActor(authority)
    await expireConfiguredProjectMemory(projectRoot, learningRoot)
    return rollbackLearningRecordNow(projectRoot, learningRoot, targetRecordId, authority)
  })
}

async function rollbackLearningRecordNow(
  projectRoot: string,
  learningRoot: string,
  targetRecordId: string,
  authority: TrustedLearningDecision
): Promise<LearningRecord> {
  const actor = requireTrustedUserLearningActor(authority)
  const record = await mutateLearningState(learningRoot, projectRoot, (state) => {
    const target = findRecord(state, targetRecordId)
    if (target.kind === 'memory') assertSharedMemoryContributionAllowed()
    if (target.status === 'deleted') throw new Error('Deleted learning records cannot be restored')
    if (target.kind === 'memory' && target.status === 'expired') throw new Error('Expired memory cannot be restored; propose a new reviewed memory instead')
    if (target.kind === 'memory' && state.records.some((item) => item.logicalId === target.logicalId
      && (item.status === 'deleted' || item.status === 'expired'))) {
      throw new Error('Deleted or expired memory history cannot be restored; propose a new reviewed memory instead')
    }
    const current = state.records.find((item) => item.logicalId === target.logicalId && item.status === 'active')
    const now = timestamp()
    if (current) transition(state, current, 'superseded', 'rolled_back', actor, now, `Rollback to ${target.id}`)
    const version = maxVersion(state, target.logicalId) + 1
    const restored: LearningRecord = {
      ...cloneRecord(target),
      id: randomUUID(),
      status: 'active',
      version,
      supersedes: current?.id ?? latestRecord(state, target.logicalId)?.id,
      source: `rollback:${target.id}`,
      actor,
      createdAt: now,
      updatedAt: now,
      decidedAt: now,
      diff: buildDiff(current?.payload, target.payload, current?.digest)
    }
    state.records.push(restored)
    state.audit.push(auditEvent(restored, 'rolled_back', actor, undefined, 'active', now, `Restored digest ${target.digest}`))
    if (restored.kind === 'skill') markMaterializationPending(state, now)
    return cloneRecord(restored)
  })
  await reconcileLearningMaterialization(projectRoot, learningRoot)
  return record
}

export async function revokeLearningRecord(
  projectRoot: string,
  learningRoot: string,
  recordId: string,
  authority: TrustedLearningDecision
): Promise<LearningRecord> {
  const actor = requireTrustedUserLearningActor(authority)
  const record = await decideStatus(projectRoot, learningRoot, recordId, authority, 'active', 'revoked', 'revoked', actor)
  await reconcileLearningMaterialization(projectRoot, learningRoot)
  return record
}

export async function deleteLearningRecord(
  projectRoot: string,
  learningRoot: string,
  recordId: string,
  authority: TrustedLearningDecision
): Promise<LearningRecord> {
  const actor = requireTrustedUserLearningActor(authority)
  const record = await mutateLearningState(learningRoot, projectRoot, (state) => {
    const target = findRecord(state, recordId)
    if (target.status === 'deleted') return cloneRecord(target)
    const affectedActiveSkill = target.kind === 'skill' && target.status === 'active'
    transition(state, target, 'deleted', 'deleted', actor, timestamp())
    if (affectedActiveSkill) markMaterializationPending(state, target.updatedAt)
    return cloneRecord(target)
  })
  await reconcileLearningMaterialization(projectRoot, learningRoot)
  return record
}

export async function expireDueLearningRecords(
  projectRoot: string,
  learningRoot: string,
  now = Date.now()
): Promise<LearningRecord[]> {
  const expired = await mutateLearningState(learningRoot, projectRoot, (state) => expireStateRecords(state, now))
  if (expired.length > 0) await reconcileLearningMaterialization(projectRoot, learningRoot)
  return expired
}

/** Explicitly configured age retention only; keeps payloads and the audit trail. */
export async function expireProjectMemoryByAge(
  projectRoot: string,
  learningRoot: string,
  days: number,
  now = Date.now()
): Promise<number> {
  if (!Number.isInteger(days) || days < 1 || days > 36_500 || !Number.isFinite(now)) throw new Error('Memory retention age is invalid')
  if (!learningStateExistsSync(learningRoot, projectRoot)) return 0
  return mutateLearningState(learningRoot, projectRoot, (state) => {
    const at = new Date(now).toISOString()
    const cutoff = now - days * 86_400_000
    let count = 0
    for (const record of state.records) {
      if (record.kind !== 'memory' || record.scope !== 'project' || (record.status !== 'active' && record.status !== 'draft')) continue
      if (Date.parse(record.updatedAt) > cutoff) continue
      transition(state, record, 'expired', 'expired',
        { type: 'system', id: 'memory-retention', source: 'user-configured-age-policy' }, at,
        `User configured memory retention: ${days} days since last revision`)
      count++
    }
    return count
  })
}

export async function listLearningProject(
  projectRoot: string,
  learningRoot: string
): Promise<LearningProjectSnapshot> {
  await expireConfiguredProjectMemory(projectRoot, learningRoot)
  await expireDueLearningRecords(projectRoot, learningRoot)
  await reconcileLearningMaterialization(projectRoot, learningRoot)
  return snapshot(await readLearningState(learningRoot, projectRoot))
}

async function expireConfiguredProjectMemory(projectRoot: string, learningRoot: string): Promise<void> {
  const userDataRoot = dirname(resolve(learningRoot))
  await withDataLifecycleMutation(userDataRoot, async () => {
    const { policies } = await readMemoryRetentionPolicies(join(userDataRoot, 'memory'))
    const policy = policies.find((candidate) => candidate.target.layer === 'project'
      && projectLearningNamespace(candidate.target.projectId) === resolve(projectRoot))
    if (!policy || policy.target.layer !== 'project') return
    assertMemoryProjectWritable(userDataRoot, policy.target.projectId)
    await expireProjectMemoryByAge(projectRoot, learningRoot, policy.days)
  })
}

export async function getLearningRecord(
  projectRoot: string,
  learningRoot: string,
  recordId: string
): Promise<LearningRecord | undefined> {
  const state = await readLearningState(learningRoot, projectRoot)
  const record = state.records.find((item) => item.id === safeId(recordId))
  return record ? cloneRecord(record) : undefined
}

export async function reconcileLearningMaterialization(
  projectRoot: string,
  learningRoot: string
): Promise<void> {
  const key = learningStatePath(learningRoot, projectRoot)
  const previous = reconciliationTails.get(key) ?? Promise.resolve()
  const current = previous
    .catch(() => undefined)
    .then(() => reconcileLearningMaterializationNow(projectRoot, learningRoot))
  reconciliationTails.set(key, current)
  try {
    await current
  } finally {
    if (reconciliationTails.get(key) === current) reconciliationTails.delete(key)
  }
}

export async function ensureProjectSkillReadiness(
  projectRoot: string,
  explicitLearningRoot?: string
): Promise<void> {
  const learningRoot = await resolveDefaultLearningRoot(projectRoot, explicitLearningRoot)
  if (!learningStateExistsSync(learningRoot, projectRoot)) return
  await expireDueLearningRecords(projectRoot, learningRoot)
  await reconcileLearningMaterialization(projectRoot, learningRoot)
}

export function ensureProjectSkillReadinessSync(
  projectRoot: string,
  explicitLearningRoot?: string
): void {
  const learningRoot = resolveDefaultLearningRootSync(projectRoot, explicitLearningRoot)
  if (!learningStateExistsSync(learningRoot, projectRoot)) return
  const key = learningStatePath(learningRoot, projectRoot)
  if (reconciliationTails.has(key)) {
    throw new Error(`Learning materialization is in progress: ${key}`)
  }

  let state = readLearningStateSync(learningRoot, projectRoot)
  if (hasDueLearningRecords(state, Date.now())) {
    mutateLearningStateSync(learningRoot, projectRoot, (current) => expireStateRecords(current, Date.now()))
    state = readLearningStateSync(learningRoot, projectRoot)
  }
  reconcileLearningMaterializationStateSync(projectRoot, learningRoot, state)
}

async function reconcileLearningMaterializationNow(
  projectRoot: string,
  learningRoot: string
): Promise<void> {
  const state = await readLearningState(learningRoot, projectRoot)
  const generation = state.materialization?.generation ?? 0
  let managedCount = 0
  try {
    managedCount = materializeSkillStateSync(projectRoot, state)
  } catch (error) {
    await recordMaterializationResult(projectRoot, learningRoot, generation, 'failed', message(error)).catch(() => undefined)
    throw error
  }
  if (managedCount > 0 && state.materialization?.status !== 'clean') {
    await recordMaterializationResult(projectRoot, learningRoot, generation, 'clean')
  }
}

function reconcileLearningMaterializationStateSync(
  projectRoot: string,
  learningRoot: string,
  state: LearningPersistedState
): void {
  const generation = state.materialization?.generation ?? 0
  let managedCount = 0
  try {
    managedCount = materializeSkillStateSync(projectRoot, state)
  } catch (error) {
    recordMaterializationResultSync(projectRoot, learningRoot, generation, 'failed', message(error))
    throw error
  }
  if (managedCount > 0 && state.materialization?.status !== 'clean') {
    recordMaterializationResultSync(projectRoot, learningRoot, generation, 'clean')
  }
}

function materializeSkillStateSync(projectRoot: string, state: LearningPersistedState): number {
  const skillRecords = state.records.filter((record): record is LearningRecord & { payload: SkillLearningPayload } =>
    record.kind === 'skill' && record.payload.type === 'skill'
  )
  const activeByPath = new Map<string, LearningRecord & { payload: SkillLearningPayload }>()
  for (const record of skillRecords) {
    if (record.status !== 'active') continue
    const existing = activeByPath.get(record.payload.relativePath)
    if (existing && existing.logicalId !== record.logicalId) {
      throw new Error(`Multiple active Skills target ${record.payload.relativePath}`)
    }
    activeByPath.set(record.payload.relativePath, record)
  }

  const managedRecordIds = new Set(
    state.audit
      .filter((event) => event.action === 'approved' || event.action === 'rolled_back')
      .map((event) => event.recordId)
  )
  const managedPaths = new Set(
    skillRecords
      .filter((record) => record.status === 'active' || managedRecordIds.has(record.id))
      .map((record) => record.payload.relativePath)
  )
  const managedLogicalIds = new Set(
    skillRecords
      .filter((record) => managedRecordIds.has(record.id) || record.status === 'active')
      .map((record) => record.logicalId)
  )
  for (const relativePath of managedPaths) {
    const active = activeByPath.get(relativePath)
    const allowedExistingDigests = new Set(
      skillRecords
        .filter((record) => record.payload.relativePath === relativePath && managedLogicalIds.has(record.logicalId))
        .map((record) => materializedContentDigest(record.payload.markdown))
    )
    if (active) securelyWriteMaterializedSkill(projectRoot, relativePath, active.payload.markdown, allowedExistingDigests)
    else securelyRemoveMaterializedSkill(projectRoot, relativePath, allowedExistingDigests)
    if (active) {
      approveManagedLearningSkillRuntime(
        projectRoot,
        skillMaterializationPath(projectRoot, active.payload.relativePath)
      )
    }
  }
  return managedPaths.size
}

function snapshot(state: LearningPersistedState): LearningProjectSnapshot {
  const records = state.records.map(cloneRecord).sort(compareRecords)
  return {
    schemaVersion: 1,
    project: state.project,
    records,
    active: records.filter((record) => record.status === 'active'),
    drafts: records.filter((record) => record.status === 'draft'),
    history: records.filter((record) => record.status !== 'draft' && record.status !== 'active'),
    audit: state.audit.map((event) => ({ ...event, actor: { ...event.actor } }))
  }
}

async function decideStatus(
  projectRoot: string,
  learningRoot: string,
  recordId: string,
  authority: TrustedLearningDecision,
  expected: LearningStatus,
  next: LearningStatus,
  action: LearningAuditAction,
  actor: LearningActor
): Promise<LearningRecord> {
  requireTrustedUserLearningActor(authority)
  return mutateLearningState(learningRoot, projectRoot, (state) => {
    const target = findRecord(state, recordId)
    if (target.status === next) return cloneRecord(target)
    if (target.status !== expected) throw invalidTransition(target, next)
    const affectsActiveSkill = target.kind === 'skill' && (target.status === 'active' || next === 'active')
    const now = timestamp()
    transition(state, target, next, action, actor, now)
    if (affectsActiveSkill) markMaterializationPending(state, now)
    return cloneRecord(target)
  })
}

function transition(
  state: LearningPersistedState,
  record: LearningRecord,
  next: LearningStatus,
  action: LearningAuditAction,
  actor: LearningActor,
  at: string,
  detail?: string
): void {
  const previous = record.status
  record.status = next
  record.actor = { ...actor }
  record.updatedAt = at
  record.decidedAt = at
  state.audit.push(auditEvent(record, action, actor, previous, next, at, detail))
}

function hasDueLearningRecords(state: LearningPersistedState, now: number): boolean {
  const at = new Date(now).toISOString()
  return state.records.some((record) =>
    (record.status === 'draft' || record.status === 'active') && Boolean(record.expiresAt && record.expiresAt <= at)
  )
}

function expireStateRecords(state: LearningPersistedState, now: number): LearningRecord[] {
  const at = new Date(now).toISOString()
  const actor: LearningActor = { type: 'system', id: 'learning-expiry', source: 'clock' }
  const changed: LearningRecord[] = []
  let activeSkillExpired = false
  for (const record of state.records) {
    if ((record.status === 'draft' || record.status === 'active') && record.expiresAt && record.expiresAt <= at) {
      if (record.kind === 'skill' && record.status === 'active') activeSkillExpired = true
      transition(state, record, 'expired', 'expired', actor, at)
      changed.push(cloneRecord(record))
    }
  }
  if (activeSkillExpired) markMaterializationPending(state, at)
  return changed
}

function markMaterializationPending(state: LearningPersistedState, at: string): void {
  state.materialization = {
    generation: (state.materialization?.generation ?? 0) + 1,
    status: 'pending',
    updatedAt: at
  }
}

async function recordMaterializationResult(
  projectRoot: string,
  learningRoot: string,
  generation: number,
  status: 'failed' | 'clean',
  error?: string
): Promise<void> {
  await mutateLearningState(learningRoot, projectRoot, (state) => {
    updateMaterializationResult(state, generation, status, error)
  })
}

function recordMaterializationResultSync(
  projectRoot: string,
  learningRoot: string,
  generation: number,
  status: 'failed' | 'clean',
  error?: string
): void {
  mutateLearningStateSync(learningRoot, projectRoot, (state) => {
    updateMaterializationResult(state, generation, status, error)
  })
}

function updateMaterializationResult(
  state: LearningPersistedState,
  generation: number,
  status: 'failed' | 'clean',
  error?: string
): void {
  const currentGeneration = state.materialization?.generation ?? 0
  if (currentGeneration !== generation) return
  state.materialization = {
    generation,
    status,
    updatedAt: timestamp(),
    ...(status === 'failed' ? { lastError: requiredJournalError(error) } : {})
  }
}

function requiredJournalError(error: string | undefined): string {
  const normalized = (error ?? 'Unknown materialization failure').replace(/\s+/g, ' ').trim()
  return normalized.slice(0, 2_000) || 'Unknown materialization failure'
}

function auditEvent(
  record: LearningRecord,
  action: LearningAuditAction,
  actor: LearningActor,
  fromStatus: LearningStatus | undefined,
  toStatus: LearningStatus,
  at: string,
  detail?: string
): LearningAuditEvent {
  return {
    id: randomUUID(),
    recordId: record.id,
    logicalId: record.logicalId,
    action,
    actor: { ...actor },
    at,
    ...(fromStatus ? { fromStatus } : {}),
    toStatus,
    ...(detail ? { detail } : {})
  }
}

function findRecord(state: LearningPersistedState, recordId: string): LearningRecord {
  const id = safeId(recordId)
  const record = state.records.find((item) => item.id === id)
  if (!record) throw new Error(`Learning record not found in this project: ${id}`)
  return record
}

function latestRecord(state: LearningPersistedState, logicalId: string): LearningRecord | undefined {
  return state.records
    .filter((record) => record.logicalId === logicalId)
    .sort((a, b) => b.version - a.version)[0]
}

function latestSkillRecordForPath(state: LearningPersistedState, relativePath: string): LearningRecord | undefined {
  const normalized = normalizeSkillRelativePath(relativePath)
  return state.records
    .filter((record) => record.kind === 'skill' && record.payload.type === 'skill' && record.payload.relativePath === normalized)
    .sort((a, b) => b.version - a.version)[0]
}

function maxVersion(state: LearningPersistedState, logicalId: string): number {
  return state.records.reduce((max, record) => record.logicalId === logicalId ? Math.max(max, record.version) : max, 0)
}

function assertSkillPathOwnership(state: LearningPersistedState, payload: LearningPayload, logicalId: string): void {
  if (payload.type !== 'skill') return
  const conflict = state.records.find((record) =>
    record.kind === 'skill' && record.payload.type === 'skill' &&
    record.payload.relativePath === payload.relativePath && record.logicalId !== logicalId && record.status !== 'deleted'
  )
  if (conflict) throw new Error(`Skill path already belongs to another learning record: ${payload.relativePath}`)
}

function normalizePayload(kind: LearningDraftInput['kind'], payload: LearningPayload): LearningPayload {
  if (!payload || payload.type !== kind) throw new Error('Learning kind and payload type must match')
  if (payload.type === 'memory') {
    return {
      type: 'memory',
      memoryKind: requiredText(payload.memoryKind, 'memoryKind', 128),
      title: requiredText(payload.title, 'title', 512),
      body: requiredText(payload.body, 'body', 100_000),
      reason: requiredText(payload.reason, 'reason', 2_000)
    }
  }
  return {
    type: 'skill',
    name: requiredText(payload.name, 'name', 256),
    description: requiredText(payload.description, 'description', 2_000),
    markdown: requiredText(payload.markdown, 'markdown', 500_000),
    relativePath: normalizeSkillRelativePath(payload.relativePath)
  }
}

function normalizeWorkerScope(
  input: LearningDraftInput,
  payload: LearningPayload
): Pick<LearningRecord, 'scope' | 'workerId' | 'memoryNamespace'> {
  if (input.workerId === undefined && input.memoryNamespace === undefined) return { scope: 'project' }
  if (payload.type !== 'memory') throw new Error('Only Memory learning may use a Worker namespace')
  if (input.workerId === undefined || input.memoryNamespace === undefined) {
    throw new Error('Worker learning requires workerId and memoryNamespace')
  }
  return {
    scope: 'worker',
    workerId: requiredText(input.workerId, 'workerId', 256),
    memoryNamespace: requiredText(input.memoryNamespace, 'memoryNamespace', 512)
  }
}

function buildDiff(previous: LearningPayload | undefined, current: LearningPayload, previousDigest?: string): LearningRecord['diff'] {
  const changedFields = previous
    ? Object.keys(current).filter((key) => canonical((previous as unknown as Record<string, unknown>)[key]) !== canonical((current as unknown as Record<string, unknown>)[key]))
    : Object.keys(current)
  const currentDigest = payloadDigest(current)
  return {
    summary: previous ? `Changed ${changedFields.length} field(s)` : 'Initial learning proposal',
    ...(previousDigest ? { previousDigest } : {}),
    currentDigest,
    changedFields
  }
}

function payloadDigest(payload: LearningPayload): string {
  return createHash('sha256').update(canonical(payload)).digest('hex')
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function normalizeActor(actor: LearningActor): LearningActor {
  const allowed = new Set(['user', 'agent', 'model', 'runtime', 'system'])
  if (!allowed.has(actor.type)) throw new Error('Learning actor type is invalid')
  return {
    type: actor.type,
    id: requiredText(actor.id, 'actor.id', 128),
    source: requiredText(actor.source, 'actor.source', 256)
  }
}

function normalizeConfidence(value: number | undefined): number {
  if (value === undefined) return 0.75
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('confidence must be between 0 and 1')
  return value
}

function normalizeOptionalTime(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined
  const time = Date.parse(value)
  if (!Number.isFinite(time)) throw new Error(`${label} must be an ISO timestamp`)
  return new Date(time).toISOString()
}

function requiredText(value: string, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const normalized = value.trim()
  if (!normalized || normalized.length > max || normalized.includes('\0')) throw new Error(`${label} is invalid`)
  return normalized
}

function safeRequestedId(value: string | undefined, fallback: string): string {
  return value === undefined ? fallback : safeId(value)
}

function safeId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Learning record id is invalid')
  return value
}

function timestamp(now?: () => number): string {
  return new Date(now ? now() : Date.now()).toISOString()
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function invalidTransition(record: LearningRecord, next: LearningStatus): Error {
  return new Error(`Learning record ${record.id} cannot transition from ${record.status} to ${next}`)
}

function cloneRecord(record: LearningRecord): LearningRecord {
  return structuredClone(record)
}

function compareRecords(a: LearningRecord, b: LearningRecord): number {
  const byUpdated = b.updatedAt.localeCompare(a.updatedAt)
  if (byUpdated !== 0) return byUpdated
  const byLogical = a.logicalId.localeCompare(b.logicalId)
  if (byLogical !== 0) return byLogical
  return b.version - a.version
}
