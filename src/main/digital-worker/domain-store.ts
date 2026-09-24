import { randomUUID } from 'node:crypto'
import {
  DIGITAL_WORKER_SCHEMA_VERSION,
  type AcquireLeaseInput,
  type AssignmentInput,
  type DigitalWorker,
  type DigitalWorkerAssignment,
  type DigitalWorkerAuditEvent,
  type DigitalWorkerInput,
  type DigitalWorkerLease,
  type DigitalWorkerPatch,
  type DigitalWorkerStatus,
  type DigitalWorkerStoreDocument,
  type LeaseTokenInput,
  type RoleTemplate,
  type RoleTemplateInput,
  type RoleTemplatePatch
} from '../../shared/digital-worker-types'
import type {
  AssignmentListFilter,
  AuditListFilter,
  DigitalWorkerMutation as Mutation,
  DigitalWorkerStoreOptions,
  LeaseHeartbeatInput,
  LeaseListFilter,
  ReassignResult,
  RevisionOptions,
  StoreVerification,
  WorkerLifecycleOptions
} from './contracts'
import {
  DigitalWorkerConflictError,
  DigitalWorkerStoreError,
  DigitalWorkerValidationError,
  notFound
} from './errors'
import {
  normalizeAssignmentInput,
  normalizeDigitalWorkerInput,
  normalizeDigitalWorkerPatch,
  normalizeRoleTemplateInput,
  normalizeRoleTemplatePatch
} from './codec'
import {
  appendAudit,
  assertDigitalWorkerAssignmentPolicy,
  assertAssignmentReferences,
  assertExpectedRecordRevision,
  assertExpectedStoreRevision,
  assertFence,
  assertNoActiveAssignment,
  expireLease,
  expireLeases,
  lifecycleTransitionAllowed,
  resolveLeaseAssignment,
  verifyDocument
} from './relations'
import {
  LOCK_FILE_SUFFIX,
  acquireFileLock,
  enqueueMutation,
  readDocument,
  releaseFileLock,
  resolveStorePath,
  writeDocument
} from './persistence'
import {
  WORKER_STATUSES,
  assertNoProviderModelFields,
  cloneDocument,
  cloneValue,
  normalizeAssignmentFilter,
  normalizeAuditFilter,
  normalizeLeaseFilter,
  normalizeOptionalText,
  normalizePositiveInteger,
  normalizeRevisionOptions,
  normalizeTimestamp,
  normalizeTtl,
  requiredId
} from './validation'
import {
  mergeDigitalWorkerProjectSlice,
  projectSliceAlreadyImported,
  purgeDigitalWorkerProjectSlice,
  type DigitalWorkerProjectSliceInput,
  type DigitalWorkerProjectPurgeResult
} from './project-slice'

/**
 * File-backed native worker domain store.
 *
 * Every mutation reloads the latest document while holding a process/file lock,
 * validates the complete candidate, then writes via fsync + rename.  The
 * in-process queue makes Promise.all races deterministic; the lock covers a
 * second EastGenesis process and fails closed when another live writer owns it.
 */
export class DigitalWorkerStore {
  readonly filePath: string
  private readonly lockPath: string

  constructor(rootOrOptions: string | DigitalWorkerStoreOptions) {
    const options = typeof rootOrOptions === 'string' ? { rootDir: rootOrOptions } : rootOrOptions
    this.filePath = resolveStorePath(options)
    this.lockPath = `${this.filePath}${LOCK_FILE_SUFFIX}`
  }

  static forRoot(rootDir: string): DigitalWorkerStore {
    return new DigitalWorkerStore(rootDir)
  }

  getPath(): string {
    return this.filePath
  }

  read(): DigitalWorkerStoreDocument {
    return cloneDocument(readDocument(this.filePath))
  }

  snapshot(): DigitalWorkerStoreDocument {
    return this.read()
  }

  verify(): StoreVerification {
    const document = readDocument(this.filePath)
    verifyDocument(document)
    return {
      valid: true,
      schemaVersion: document.schemaVersion,
      revision: document.revision,
      counts: {
        roleTemplates: document.roleTemplates.length,
        workers: document.workers.length,
        assignments: document.assignments.length,
        leases: document.leases.length,
        audit: document.audit.length
      }
    }
  }

  async createRoleTemplate(input: RoleTemplateInput): Promise<RoleTemplate> {
    return this.mutate((document) => {
      const roleTemplate = normalizeRoleTemplateInput(input)
      if (document.roleTemplates.some((entry) => entry.id === roleTemplate.id)) {
        throw new DigitalWorkerConflictError(`RoleTemplate already exists: ${roleTemplate.id}`)
      }
      document.roleTemplates.push(roleTemplate)
      appendAudit(document, 'role_template.created', roleTemplate.id, undefined, roleTemplate.createdAt, {
        roleTemplateVersion: roleTemplate.version
      })
      return roleTemplate
    })
  }

  async getRoleTemplate(id: string): Promise<RoleTemplate | null> {
    const normalizedId = requiredId(id, 'roleTemplate id')
    return cloneValue(this.read().roleTemplates.find((entry) => entry.id === normalizedId) ?? null)
  }

  async listRoleTemplates(options: { includeArchived?: boolean } = {}): Promise<RoleTemplate[]> {
    const entries = this.read().roleTemplates
    return entries
      .filter((entry) => options.includeArchived === true || entry.archivedAt === undefined)
      .map((entry) => cloneValue(entry))
  }

  async updateRoleTemplate(
    id: string,
    patch: RoleTemplatePatch,
    options: RevisionOptions | number = {}
  ): Promise<RoleTemplate> {
    const normalizedId = requiredId(id, 'roleTemplate id')
    const revisionOptions = normalizeRevisionOptions(options)
    return this.mutate((document) => {
      assertExpectedStoreRevision(document, revisionOptions)
      const index = document.roleTemplates.findIndex((entry) => entry.id === normalizedId)
      if (index < 0) throw notFound(`RoleTemplate not found: ${normalizedId}`)
      const current = document.roleTemplates[index]
      assertExpectedRecordRevision(current.revision, revisionOptions, `RoleTemplate ${normalizedId}`)
      const next = normalizeRoleTemplatePatch(current, patch)
      document.roleTemplates[index] = next
      appendAudit(document, 'role_template.updated', next.id, undefined, next.updatedAt, {
        roleTemplateVersion: next.version,
        recordRevision: next.revision
      })
      return next
    })
  }

  async deleteRoleTemplate(id: string, options: RevisionOptions | number = {}): Promise<boolean> {
    const normalizedId = requiredId(id, 'roleTemplate id')
    const revisionOptions = normalizeRevisionOptions(options)
    return this.mutate((document) => {
      assertExpectedStoreRevision(document, revisionOptions)
      const index = document.roleTemplates.findIndex((entry) => entry.id === normalizedId)
      if (index < 0) return false
      const current = document.roleTemplates[index]
      assertExpectedRecordRevision(current.revision, revisionOptions, `RoleTemplate ${normalizedId}`)
      if (document.workers.some((worker) => worker.roleTemplateId === normalizedId)) {
        throw new DigitalWorkerConflictError(
          `RoleTemplate ${normalizedId} is referenced by a DigitalWorker; archive or retain it instead`
        )
      }
      document.roleTemplates.splice(index, 1)
      appendAudit(document, 'role_template.deleted', normalizedId, undefined, Date.now(), {})
      return true
    })
  }

  async createDigitalWorker(input: DigitalWorkerInput): Promise<DigitalWorker> {
    return this.mutate((document) => {
      const worker = normalizeDigitalWorkerInput(input, document)
      if (document.workers.some((entry) => entry.id === worker.id)) {
        throw new DigitalWorkerConflictError(`DigitalWorker already exists: ${worker.id}`)
      }
      document.workers.push(worker)
      appendAudit(document, 'worker.created', worker.id, worker.projectId, worker.createdAt, {
        roleTemplateId: worker.roleTemplateId,
        roleTemplateVersion: worker.roleTemplateVersion
      })
      return worker
    })
  }

  async getDigitalWorker(id: string): Promise<DigitalWorker | null> {
    const normalizedId = requiredId(id, 'DigitalWorker id')
    return cloneValue(this.read().workers.find((entry) => entry.id === normalizedId) ?? null)
  }

  async listDigitalWorkers(options: {
    projectId?: string
    status?: DigitalWorkerStatus
    includeRetired?: boolean
  } = {}): Promise<DigitalWorker[]> {
    const projectId = options.projectId === undefined ? undefined : requiredId(options.projectId, 'projectId')
    if (options.status !== undefined && !WORKER_STATUSES.has(options.status)) {
      throw new DigitalWorkerValidationError(`Invalid DigitalWorker status: ${String(options.status)}`)
    }
    return this.read().workers
      .filter((worker) => projectId === undefined || worker.projectId === projectId)
      .filter((worker) => options.status === undefined || worker.status === options.status)
      .filter((worker) => options.includeRetired !== false || worker.status !== 'retired')
      .map((worker) => cloneValue(worker))
  }

  async updateDigitalWorker(
    id: string,
    patch: DigitalWorkerPatch,
    options: RevisionOptions | number = {}
  ): Promise<DigitalWorker> {
    const normalizedId = requiredId(id, 'DigitalWorker id')
    const revisionOptions = normalizeRevisionOptions(options)
    return this.mutate((document) => {
      assertExpectedStoreRevision(document, revisionOptions)
      const index = document.workers.findIndex((entry) => entry.id === normalizedId)
      if (index < 0) throw notFound(`DigitalWorker not found: ${normalizedId}`)
      const current = document.workers[index]
      assertExpectedRecordRevision(current.revision, revisionOptions, `DigitalWorker ${normalizedId}`)
      if (current.status === 'retired') {
        throw new DigitalWorkerConflictError(`Retired DigitalWorker cannot be edited: ${normalizedId}`)
      }
      assertNoProviderModelFields(patch as unknown, `DigitalWorker ${normalizedId} patch`)
      const next = normalizeDigitalWorkerPatch(current, patch)
      for (const assignment of document.assignments) {
        if (
          assignment.status === 'active' &&
          assignment.assigneeKind === 'digital_worker' &&
          assignment.assigneeId === next.id
        ) {
          assertDigitalWorkerAssignmentPolicy(next, assignment)
        }
      }
      document.workers[index] = next
      appendAudit(document, 'worker.updated', next.id, next.projectId, next.updatedAt, {
        recordRevision: next.revision
      })
      return next
    })
  }

  async activateDigitalWorker(id: string, options: WorkerLifecycleOptions = {}): Promise<DigitalWorker> {
    return this.transitionWorker(id, 'active', options)
  }

  async pauseDigitalWorker(id: string, options: WorkerLifecycleOptions = {}): Promise<DigitalWorker> {
    return this.transitionWorker(id, 'paused', options)
  }

  async resumeDigitalWorker(id: string, options: WorkerLifecycleOptions = {}): Promise<DigitalWorker> {
    return this.transitionWorker(id, 'active', options)
  }

  async retireDigitalWorker(id: string, options: WorkerLifecycleOptions = {}): Promise<DigitalWorker> {
    return this.transitionWorker(id, 'retired', options)
  }

  private async transitionWorker(
    id: string,
    status: DigitalWorkerStatus,
    options: WorkerLifecycleOptions = {}
  ): Promise<DigitalWorker> {
    const normalizedId = requiredId(id, 'DigitalWorker id')
    const revisionOptions = normalizeRevisionOptions(options)
    return this.mutate((document) => {
      assertExpectedStoreRevision(document, revisionOptions)
      const index = document.workers.findIndex((entry) => entry.id === normalizedId)
      if (index < 0) throw notFound(`DigitalWorker not found: ${normalizedId}`)
      const current = document.workers[index]
      assertExpectedRecordRevision(current.revision, revisionOptions, `DigitalWorker ${normalizedId}`)
      if (!lifecycleTransitionAllowed(current.status, status)) {
        throw new DigitalWorkerConflictError(`DigitalWorker lifecycle transition ${current.status} -> ${status} is not allowed`)
      }
      if (status === 'retired') {
        const activeAssignment = document.assignments.find((assignment) =>
          assignment.assigneeKind === 'digital_worker' &&
          assignment.assigneeId === current.id &&
          assignment.status === 'active')
        if (activeAssignment) {
          throw new DigitalWorkerConflictError(
            `DigitalWorker ${current.id} cannot retire with active Assignment ${activeAssignment.id}; release or reassign it first`
          )
        }
        const activeLease = document.leases.find((lease) =>
          lease.workerId === current.id && lease.status === 'active')
        if (activeLease) {
          throw new DigitalWorkerConflictError(
            `DigitalWorker ${current.id} cannot retire with active lease ${activeLease.id}; release it first`
          )
        }
      }
      const now = normalizeTimestamp(options.now ?? Date.now(), 'lifecycle now')
      const next: DigitalWorker = {
        ...current,
        status,
        updatedAt: now,
        ...(status === 'retired' ? { retiredAt: current.retiredAt ?? now } : {}),
        revision: current.revision + 1
      }
      document.workers[index] = next
      appendAudit(document, 'worker.lifecycle', next.id, next.projectId, now, {
        from: current.status,
        to: status,
        recordRevision: next.revision
      })
      return next
    }, revisionOptions)
  }

  async deleteDigitalWorker(id: string, options: RevisionOptions | number = {}): Promise<boolean> {
    const normalizedId = requiredId(id, 'DigitalWorker id')
    const revisionOptions = normalizeRevisionOptions(options)
    return this.mutate((document) => {
      assertExpectedStoreRevision(document, revisionOptions)
      const index = document.workers.findIndex((entry) => entry.id === normalizedId)
      if (index < 0) return false
      const worker = document.workers[index]
      assertExpectedRecordRevision(worker.revision, revisionOptions, `DigitalWorker ${normalizedId}`)
      if (document.assignments.some((assignment) => assignment.assigneeId === normalizedId)) {
        throw new DigitalWorkerStoreError(
          'IMMUTABLE_HISTORY',
          `DigitalWorker ${normalizedId} has Assignment history and cannot be deleted`
        )
      }
      if (document.leases.some((lease) => lease.workerId === normalizedId)) {
        throw new DigitalWorkerStoreError(
          'IMMUTABLE_HISTORY',
          `DigitalWorker ${normalizedId} has lease history and cannot be deleted`
        )
      }
      document.workers.splice(index, 1)
      appendAudit(document, 'worker.deleted', normalizedId, worker.projectId, Date.now(), {})
      return true
    })
  }

  async createAssignment(
    input: AssignmentInput,
    options: RevisionOptions | number = {}
  ): Promise<DigitalWorkerAssignment> {
    const revisionOptions = normalizeRevisionOptions(options)
    return this.mutate((document) => {
      const assignment = normalizeAssignmentInput(input)
      assertAssignmentReferences(document, assignment)
      assertNoActiveAssignment(document, assignment.projectId, assignment.workItemId)
      document.assignments.push(assignment)
      appendAudit(document, 'assignment.created', assignment.id, assignment.projectId, assignment.assignedAt, {
        workItemId: assignment.workItemId,
        assigneeKind: assignment.assigneeKind,
        assigneeId: assignment.assigneeId
      })
      return assignment
    }, revisionOptions)
  }

  async assign(input: AssignmentInput, options: RevisionOptions | number = {}): Promise<DigitalWorkerAssignment> {
    return this.createAssignment(input, options)
  }

  async getAssignment(id: string): Promise<DigitalWorkerAssignment | null> {
    const normalizedId = requiredId(id, 'Assignment id')
    return cloneValue(this.read().assignments.find((entry) => entry.id === normalizedId) ?? null)
  }

  async listAssignments(filter: AssignmentListFilter = {}): Promise<DigitalWorkerAssignment[]> {
    const normalized = normalizeAssignmentFilter(filter)
    return this.read().assignments
      .filter((assignment) => normalized.projectId === undefined || assignment.projectId === normalized.projectId)
      .filter((assignment) => normalized.workItemId === undefined || assignment.workItemId === normalized.workItemId)
      .filter((assignment) => normalized.assigneeId === undefined || assignment.assigneeId === normalized.assigneeId)
      .filter((assignment) => normalized.assigneeKind === undefined || assignment.assigneeKind === normalized.assigneeKind)
      .filter((assignment) => normalized.status === undefined || assignment.status === normalized.status)
      .filter((assignment) => normalized.includeHistory !== false || assignment.status === 'active')
      .map((assignment) => cloneValue(assignment))
  }

  async listAssignmentHistory(filter: Omit<AssignmentListFilter, 'includeHistory'> = {}): Promise<DigitalWorkerAssignment[]> {
    return this.listAssignments({ ...filter, includeHistory: true })
  }

  async releaseAssignment(
    id: string,
    options: RevisionOptions | number = {},
    releaseOptions: { now?: number; reason?: string } = {}
  ): Promise<DigitalWorkerAssignment> {
    const normalizedId = requiredId(id, 'Assignment id')
    const revisionOptions = normalizeRevisionOptions(options)
    return this.mutate((document) => {
      assertExpectedStoreRevision(document, revisionOptions)
      const index = document.assignments.findIndex((entry) => entry.id === normalizedId)
      if (index < 0) throw notFound(`Assignment not found: ${normalizedId}`)
      const current = document.assignments[index]
      assertExpectedRecordRevision(current.revision, revisionOptions, `Assignment ${normalizedId}`)
      if (current.status === 'released') return current
      const now = normalizeTimestamp(releaseOptions.now ?? Date.now(), 'release now')
      const next: DigitalWorkerAssignment = {
        ...current,
        status: 'released',
        releasedAt: now,
        reason: releaseOptions.reason === undefined ? current.reason : normalizeOptionalText(releaseOptions.reason, 'reason'),
        revision: current.revision + 1
      }
      document.assignments[index] = next
      appendAudit(document, 'assignment.released', next.id, next.projectId, now, {
        workItemId: next.workItemId,
        assigneeId: next.assigneeId
      })
      return next
    })
  }

  async reassignAssignment(
    currentAssignmentId: string,
    nextInput: AssignmentInput,
    options: RevisionOptions | number = {},
    releaseOptions: { now?: number; reason?: string } = {}
  ): Promise<ReassignResult> {
    const normalizedId = requiredId(currentAssignmentId, 'Assignment id')
    const revisionOptions = normalizeRevisionOptions(options)
    return this.mutate((document) => {
      assertExpectedStoreRevision(document, revisionOptions)
      const index = document.assignments.findIndex((entry) => entry.id === normalizedId)
      if (index < 0) throw notFound(`Assignment not found: ${normalizedId}`)
      const current = document.assignments[index]
      assertExpectedRecordRevision(current.revision, revisionOptions, `Assignment ${normalizedId}`)
      if (current.status !== 'active') {
        throw new DigitalWorkerConflictError(`Assignment is already released: ${normalizedId}`)
      }
      const nextAssignment = normalizeAssignmentInput(nextInput)
      if (nextAssignment.projectId !== current.projectId || nextAssignment.workItemId !== current.workItemId) {
        throw new DigitalWorkerConflictError('Reassignment must stay within the same Project and WorkItem', undefined, 'PROJECT_SCOPE_CONFLICT')
      }
      assertAssignmentReferences(document, nextAssignment)
      const releasedAt = normalizeTimestamp(releaseOptions.now ?? Date.now(), 'release now')
      const released: DigitalWorkerAssignment = {
        ...current,
        status: 'released',
        releasedAt,
        reason: releaseOptions.reason === undefined ? current.reason : normalizeOptionalText(releaseOptions.reason, 'reason'),
        revision: current.revision + 1
      }
      document.assignments[index] = released
      assertNoActiveAssignment(document, nextAssignment.projectId, nextAssignment.workItemId)
      document.assignments.push(nextAssignment)
      appendAudit(document, 'assignment.released', released.id, released.projectId, releasedAt, {
        workItemId: released.workItemId,
        assigneeId: released.assigneeId
      })
      appendAudit(document, 'assignment.created', nextAssignment.id, nextAssignment.projectId, nextAssignment.assignedAt, {
        workItemId: nextAssignment.workItemId,
        assigneeKind: nextAssignment.assigneeKind,
        assigneeId: nextAssignment.assigneeId
      })
      return { released, assigned: nextAssignment }
    })
  }

  async acquireLease(input: AcquireLeaseInput): Promise<DigitalWorkerLease> {
    return this.mutate((document) => {
      const projectId = requiredId(input.projectId, 'projectId')
      const workItemId = requiredId(input.workItemId, 'workItemId')
      const workerId = requiredId(input.workerId, 'workerId')
      const now = normalizeTimestamp(input.now ?? Date.now(), 'lease now')
      const ttlMs = normalizeTtl(input.ttlMs)
      const worker = document.workers.find((entry) => entry.id === workerId)
      if (!worker) throw notFound(`DigitalWorker not found: ${workerId}`)
      if (worker.projectId !== projectId) {
        throw new DigitalWorkerConflictError(
          `DigitalWorker ${workerId} does not belong to Project ${projectId}`,
          undefined,
          'PROJECT_SCOPE_CONFLICT'
        )
      }
      if (worker.status !== 'active') {
        throw new DigitalWorkerConflictError(`DigitalWorker ${workerId} is ${worker.status}; it cannot acquire a lease`)
      }
      const assignment = resolveLeaseAssignment(document, input, projectId, workItemId, workerId)
      assertDigitalWorkerAssignmentPolicy(worker, assignment)
      expireLeases(document, now)
      const activeForWorkItem = document.leases.find(
        (lease) => lease.projectId === projectId && lease.workItemId === workItemId && lease.status === 'active'
      )
      if (activeForWorkItem) {
        throw new DigitalWorkerConflictError(
          `WorkItem ${workItemId} already has an active lease`,
          { leaseId: activeForWorkItem.id, fencingToken: activeForWorkItem.fencingToken },
          'LEASE_CONFLICT'
        )
      }
      const activeForWorker = document.leases.filter(
        (lease) => lease.projectId === projectId && lease.workerId === workerId && lease.status === 'active'
      )
      if (activeForWorker.length >= worker.concurrencyLimit) {
        throw new DigitalWorkerConflictError(
          `DigitalWorker ${workerId} reached concurrencyLimit ${worker.concurrencyLimit}`,
          { workerId, concurrencyLimit: worker.concurrencyLimit },
          'LEASE_CONFLICT'
        )
      }
      const fencingToken = document.nextFencingToken
      document.nextFencingToken += 1
      const lease: DigitalWorkerLease = {
        schemaVersion: DIGITAL_WORKER_SCHEMA_VERSION,
        id: randomUUID(),
        projectId,
        workItemId,
        assignmentId: assignment.id,
        workerId,
        fencingToken,
        acquiredAt: now,
        expiresAt: now + ttlMs,
        status: 'active',
        revision: 1
      }
      document.leases.push(lease)
      appendAudit(document, 'lease.acquired', lease.id, projectId, now, {
        workItemId,
        workerId,
        assignmentId: assignment.id,
        fencingToken
      })
      return lease
    })
  }

  async acquireWorkerLease(input: AcquireLeaseInput): Promise<DigitalWorkerLease> {
    return this.acquireLease(input)
  }

  async getLease(id: string): Promise<DigitalWorkerLease | null> {
    const normalizedId = requiredId(id, 'lease id')
    return cloneValue(this.read().leases.find((entry) => entry.id === normalizedId) ?? null)
  }

  async listLeases(filter: LeaseListFilter = {}): Promise<DigitalWorkerLease[]> {
    const normalized = normalizeLeaseFilter(filter)
    return this.read().leases
      .filter((lease) => normalized.projectId === undefined || lease.projectId === normalized.projectId)
      .filter((lease) => normalized.workItemId === undefined || lease.workItemId === normalized.workItemId)
      .filter((lease) => normalized.workerId === undefined || lease.workerId === normalized.workerId)
      .filter((lease) => normalized.status === undefined || lease.status === normalized.status)
      .filter((lease) => normalized.includeExpired !== false || lease.status === 'active')
      .map((lease) => cloneValue(lease))
  }

  async heartbeatLease(input: LeaseHeartbeatInput): Promise<DigitalWorkerLease> {
    const leaseId = requiredId(input.leaseId, 'lease id')
    const fencingToken = normalizePositiveInteger(input.fencingToken, 'fencingToken')
    const now = normalizeTimestamp(input.now ?? Date.now(), 'lease heartbeat now')
    const ttlMs = normalizeTtl(input.ttlMs)
    return this.mutate((document) => {
      const index = document.leases.findIndex((entry) => entry.id === leaseId)
      if (index < 0) throw notFound(`Lease not found: ${leaseId}`)
      const current = document.leases[index]
      assertFence(current, fencingToken)
      if (current.status !== 'active' || current.expiresAt <= now) {
        if (current.status === 'active') {
          document.leases[index] = expireLease(current, now)
        }
        throw new DigitalWorkerConflictError(`Lease ${leaseId} is no longer active`, undefined, 'LEASE_CONFLICT')
      }
      const next: DigitalWorkerLease = {
        ...current,
        expiresAt: now + ttlMs,
        revision: current.revision + 1
      }
      document.leases[index] = next
      appendAudit(document, 'lease.heartbeat', next.id, next.projectId, now, {
        workerId: next.workerId,
        fencingToken
      })
      return next
    })
  }

  async releaseLease(input: LeaseTokenInput): Promise<DigitalWorkerLease> {
    const leaseId = requiredId(input.leaseId, 'lease id')
    const fencingToken = normalizePositiveInteger(input.fencingToken, 'fencingToken')
    const now = normalizeTimestamp(input.now ?? Date.now(), 'lease release now')
    return this.mutate((document) => {
      const index = document.leases.findIndex((entry) => entry.id === leaseId)
      if (index < 0) throw notFound(`Lease not found: ${leaseId}`)
      const current = document.leases[index]
      assertFence(current, fencingToken)
      if (current.status === 'released') return current
      if (current.status === 'expired') {
        throw new DigitalWorkerConflictError(`Expired lease ${leaseId} cannot be released`, undefined, 'LEASE_CONFLICT')
      }
      const next: DigitalWorkerLease = {
        ...current,
        status: 'released',
        releasedAt: now,
        revision: current.revision + 1
      }
      document.leases[index] = next
      appendAudit(document, 'lease.released', next.id, next.projectId, now, {
        workerId: next.workerId,
        fencingToken
      })
      return next
    })
  }

  async releaseWorkerLease(input: LeaseTokenInput): Promise<DigitalWorkerLease> {
    return this.releaseLease(input)
  }

  async listAuditEvents(filter: AuditListFilter = {}): Promise<DigitalWorkerAuditEvent[]> {
    const normalized = normalizeAuditFilter(filter)
    return this.read().audit
      .filter((event) => normalized.projectId === undefined || event.projectId === normalized.projectId)
      .filter((event) => normalized.entityId === undefined || event.entityId === normalized.entityId)
      .filter((event) => normalized.kind === undefined || event.kind === normalized.kind)
      .map((event) => cloneValue(event))
  }

  async purgeProject(projectId: string): Promise<DigitalWorkerProjectPurgeResult> {
    const id = requiredId(projectId, 'projectId')
    return this.mutate((document) => purgeDigitalWorkerProjectSlice(document, id))
  }

  /** Merge a verified Project-owned workforce slice while preserving history. */
  async importProjectSlice(input: DigitalWorkerProjectSliceInput): Promise<{ revision: number; projectId: string }> {
    const projectId = requiredId(input.projectId, 'projectId')
    const current = this.read()
    if (projectSliceAlreadyImported(current, input, projectId)) return { revision: current.revision, projectId }
    return this.mutate((document) => {
      mergeDigitalWorkerProjectSlice(document, input, projectId)
      return { revision: document.revision + 1, projectId }
    })
  }

  async mutate<T>(operation: Mutation<T>, options: RevisionOptions = {}): Promise<T> {
    return enqueueMutation(this.filePath, async () => {
      const lock = acquireFileLock(this.lockPath)
      try {
        const current = readDocument(this.filePath)
        assertExpectedStoreRevision(current, options)
        const candidate = cloneDocument(current)
        const result = operation(candidate)
        candidate.revision = current.revision + 1
        verifyDocument(candidate)
        writeDocument(this.filePath, candidate)
        return cloneValue(result)
      } finally {
        releaseFileLock(this.lockPath, lock)
      }
    })
  }

  /** Alias used by callers that prefer explicit transactional naming. */
  async transaction<T>(operation: Mutation<T>, options: RevisionOptions = {}): Promise<T> {
    return this.mutate(operation, options)
  }
}

export function digitalWorkerStorePath(rootDir: string): string {
  return resolveStorePath({ rootDir })
}

export function createDigitalWorkerStore(rootDirOrOptions: string | DigitalWorkerStoreOptions): DigitalWorkerStore {
  return new DigitalWorkerStore(rootDirOrOptions)
}

export function verifyDigitalWorkerStore(rootDirOrOptions: string | DigitalWorkerStoreOptions): StoreVerification {
  return new DigitalWorkerStore(rootDirOrOptions).verify()
}

export function readDigitalWorkerStore(rootDirOrOptions: string | DigitalWorkerStoreOptions): DigitalWorkerStoreDocument {
  return new DigitalWorkerStore(rootDirOrOptions).read()
}

// Functional facades keep the domain usable from small IPC adapters without
// forcing those adapters to retain a long-lived store instance.
export async function createRoleTemplate(rootDir: string, input: RoleTemplateInput): Promise<RoleTemplate> {
  return new DigitalWorkerStore(rootDir).createRoleTemplate(input)
}

export async function listRoleTemplates(rootDir: string, options?: { includeArchived?: boolean }): Promise<RoleTemplate[]> {
  return new DigitalWorkerStore(rootDir).listRoleTemplates(options)
}

export async function createDigitalWorker(rootDir: string, input: DigitalWorkerInput): Promise<DigitalWorker> {
  return new DigitalWorkerStore(rootDir).createDigitalWorker(input)
}

export async function listDigitalWorkers(rootDir: string, options?: {
  projectId?: string
  status?: DigitalWorkerStatus
  includeRetired?: boolean
}): Promise<DigitalWorker[]> {
  return new DigitalWorkerStore(rootDir).listDigitalWorkers(options)
}

export async function createAssignment(
  rootDir: string,
  input: AssignmentInput,
  options: RevisionOptions | number = {}
): Promise<DigitalWorkerAssignment> {
  return new DigitalWorkerStore(rootDir).createAssignment(input, options)
}

export async function listAssignments(rootDir: string, filter?: AssignmentListFilter): Promise<DigitalWorkerAssignment[]> {
  return new DigitalWorkerStore(rootDir).listAssignments(filter)
}

export async function acquireWorkerLease(rootDir: string, input: AcquireLeaseInput): Promise<DigitalWorkerLease> {
  return new DigitalWorkerStore(rootDir).acquireLease(input)
}
