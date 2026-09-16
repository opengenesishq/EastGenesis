import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  SupervisorApprovalInput,
  SupervisorEvent,
  SupervisorEventKind,
  SupervisorLease,
  SupervisorLeaseOptions,
  SupervisorMutationOptions,
  SupervisorRecoveryResult,
  SupervisorRunAccountingBase,
  SupervisorRunInput,
  SupervisorRunObservationInput,
  SupervisorRunRecord,
  SupervisorRunUsage,
  SupervisorRunStatus,
  SupervisorWorkItemLeaseBinding,
  SupervisorStateDocument
} from '../../shared/supervisor-types'
import { SUPERVISOR_SCHEMA_VERSION } from '../../shared/supervisor-types'
import type { GoalBudget } from '../../shared/project-workspace-types'
import type { TaskRunStatus, UsageTotals } from '../../shared/types'

const STORE_FILE_NAME = 'supervisor-state.json'
const LOCK_SUFFIX = '.lock'
const LOCK_WAIT_MS = 15
const LOCK_TIMEOUT_MS = 15_000
const LOCK_STALE_MS = 120_000
const DEFAULT_TTL_MS = 30_000
const MAX_TTL_MS = 86_400_000
const TERMINAL = new Set<SupervisorRunStatus>(['failed', 'completed', 'cancelled'])
const UNCHANGED_MUTATION = Symbol('unchanged-supervisor-mutation')

export type SupervisorStateErrorCode =
  | 'invalid_input'
  | 'already_exists'
  | 'not_found'
  | 'corrupt_store'
  | 'unsupported_schema'
  | 'stale_revision'
  | 'stale_store_revision'
  | 'invalid_transition'
  | 'lease_conflict'
  | 'lease_required'
  | 'lease_expired'
  | 'stale_lease'
  | 'lease_owner'
  | 'approval_required'
  | 'retry_limit'
  | 'budget_exhausted'
  | 'concurrency_exhausted'
  | 'lock_timeout'

export class SupervisorStateError extends Error {
  constructor(
    readonly code: SupervisorStateErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(`${code}: ${message}`)
    this.name = 'SupervisorStateError'
  }
}

export interface SupervisorStateStoreOptions {
  now?: () => number
}

interface UnchangedMutation<T> {
  readonly kind: typeof UNCHANGED_MUTATION
  readonly value: T
}

type Mutation<T> = (document: SupervisorStateDocument, now: number) => T | UnchangedMutation<T>

/**
 * Durable local Supervisor state. The store deliberately owns only run
 * coordination metadata; TaskRun/Effect ledgers remain the source of truth
 * for model turns and external side effects.
 */
export class SupervisorStateStore {
  readonly filePath: string
  private readonly lockPath: string
  private readonly now: () => number
  private queue: Promise<unknown> = Promise.resolve()

  constructor(rootDir: string, options: SupervisorStateStoreOptions = {}) {
    if (!rootDir || typeof rootDir !== 'string') {
      throw new SupervisorStateError('invalid_input', 'rootDir is required')
    }
    this.filePath = join(rootDir, STORE_FILE_NAME)
    this.lockPath = `${this.filePath}${LOCK_SUFFIX}`
    this.now = options.now ?? (() => Date.now())
  }

  async read(): Promise<SupervisorStateDocument> {
    return cloneDocument(await readDocument(this.filePath))
  }

  async getRun(id: string): Promise<SupervisorRunRecord | undefined> {
    const normalized = requiredId(id, 'run id')
    const document = await readDocument(this.filePath)
    const run = document.runs.find((candidate) => candidate.id === normalized)
    return run ? clone(run) : undefined
  }

  async listRuns(options: { projectId?: string; status?: SupervisorRunStatus } = {}): Promise<SupervisorRunRecord[]> {
    if (options.projectId !== undefined) requiredId(options.projectId, 'projectId')
    if (options.status !== undefined && !isStatus(options.status)) {
      throw new SupervisorStateError('invalid_input', `unknown Supervisor status ${String(options.status)}`)
    }
    const document = await readDocument(this.filePath)
    return document.runs
      .filter((run) => options.projectId === undefined || run.projectId === options.projectId)
      .filter((run) => options.status === undefined || run.status === options.status)
      .map(clone)
  }

  async listEvents(runId?: string): Promise<SupervisorEvent[]> {
    const normalized = runId === undefined ? undefined : requiredId(runId, 'run id')
    const document = await readDocument(this.filePath)
    return document.events
      .filter((event) => normalized === undefined || event.runId === normalized)
      .map(clone)
  }

  async createRun(input: SupervisorRunInput, options: SupervisorMutationOptions = {}): Promise<SupervisorRunRecord> {
    const projectId = requiredId(input.projectId, 'projectId')
    const workItemId = requiredId(input.workItemId, 'workItemId')
    const goalId = input.goalId === undefined ? undefined : requiredId(input.goalId, 'goalId')
    const origin = input.origin ?? 'manual'
    if (origin !== 'manual' && origin !== 'task_run') {
      throw new SupervisorStateError('invalid_input', `unknown Supervisor Run origin ${String(origin)}`)
    }
    const id = input.id === undefined ? randomUUID() : requiredId(input.id, 'run id')
    const maxRetries = normalizeMaxRetries(input.maxRetries)
    const budget = normalizeGoalBudget(input.budget)
    const workItemLease = normalizeWorkItemLeaseBinding(input.workItemLease)
    const accountingBase = normalizeAccountingBase(input.accountingBase)
    return this.mutate(options, (document, now) => {
      assertStoreRevision(document, options)
      if (document.runs.some((run) => run.id === id)) {
        throw new SupervisorStateError('already_exists', `run ${id} already exists`)
      }
      assertGoalBudgetAllowsNewRun(document, goalId, budget)
      const createdAt = normalizeTimestamp(input.createdAt, now, 'createdAt')
      const run: SupervisorRunRecord = {
        schemaVersion: SUPERVISOR_SCHEMA_VERSION,
        id,
        projectId,
        ...(goalId === undefined ? {} : { goalId }),
        workItemId,
        origin,
        status: 'queued',
        revision: 1,
        fencingToken: 0,
        retryCount: 0,
        maxRetries,
        ...(budget ? { budget } : {}),
        ...(workItemLease ? { workItemLease } : {}),
        ...(accountingBase ? { accountingBase } : {}),
        usage: emptyRunUsage(),
        createdAt,
        updatedAt: createdAt
      }
      document.runs.push(run)
      appendEvent(document, run, 'run.created', options.actorId ?? 'system', createdAt, {
        projectId,
        workItemId,
        origin,
        maxRetries,
        budget
      })
      return clone(run)
    })
  }

  async authorizeTurn(runId: string): Promise<SupervisorRunRecord> {
    const id = requiredId(runId, 'run id')
    const inspect = async (): Promise<SupervisorRunRecord> => withFileLock(
      this.filePath,
      this.lockPath,
      async () => {
        const document = await readDocument(this.filePath)
        const run = findRun(document, id)
        if (run.status !== 'queued' && run.status !== 'running') {
          throw new SupervisorStateError(
            'invalid_transition',
            `run ${run.id} cannot authorize a turn from ${run.status}`
          )
        }
        assertGoalBudgetAllowsTurn(document, run)
        return clone(run)
      }
    )
    const next = this.queue.then(inspect, inspect)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  async observeRun(
    runId: string,
    input: SupervisorRunObservationInput,
    options: SupervisorMutationOptions = {}
  ): Promise<SupervisorRunRecord> {
    const id = requiredId(runId, 'run id')
    const sourceEventId = requiredId(input.sourceEventId, 'sourceEventId')
    const observedAt = normalizeTimestamp(input.observedAt, options.now ?? this.now(), 'observedAt')
    const observedUsage = normalizeUsageTotals(input.usage, 'observed usage')
    const observedCostUsd = nonNegativeFinite(input.costUsd, 'observed costUsd')
    return this.mutate<SupervisorRunRecord>({ ...options, now: observedAt }, (document, now) => {
      const run = findRun(document, id)
      if (document.events.some((event) => event.runId === id &&
          event.payload.sourceEventId === sourceEventId)) return unchangedMutation(clone(run))

      const nextUsage = usageFromObservation(run, observedUsage, observedCostUsd, input.turnCompleted === true)
      const nextStatus = observedSupervisorStatus(run, input.taskRunStatus)
      const usageChanged = !sameRunUsage(run.usage, nextUsage)
      const statusChanged = run.status !== nextStatus
      const from = run.status
      if (usageChanged) run.usage = nextUsage
      if (statusChanged) {
        run.status = nextStatus
        if (TERMINAL.has(nextStatus)) run.lease = undefined
        if (nextStatus !== 'waiting_approval') run.approval = undefined
      }
      touch(run, now)
      if (usageChanged) {
        appendEvent(document, run, 'run.accounting', options.actorId ?? 'session-runtime', now, {
          sourceEventId,
          usage: nextUsage
        })
      }
      if (statusChanged) {
        appendEvent(document, run, 'run.observed', options.actorId ?? 'session-runtime', now, {
          sourceEventId,
          taskRunStatus: input.taskRunStatus
        }, undefined, from, nextStatus)
      }
      if (!usageChanged && !statusChanged) {
        appendEvent(document, run, 'run.observed', options.actorId ?? 'session-runtime', now, {
          sourceEventId,
          taskRunStatus: input.taskRunStatus,
          observationOnly: true
        })
      }
      return clone(run)
    })
  }

  async acquireLease(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    const id = requiredId(runId, 'run id')
    const ownerId = requiredId(options.ownerId, 'lease ownerId')
    const ttlMs = normalizeTtl(options.ttlMs)
    return this.mutate(options, (document, now) => {
      const run = findRun(document, id)
      assertExpectedRevision(run, options)
      assertNotTerminal(run)
      const current = run.lease
      if (current && current.expiresAt > now) {
        if (current.ownerId !== ownerId || (options.leaseId !== undefined && current.id !== options.leaseId)) {
          throw new SupervisorStateError('lease_conflict', `run ${id} has an active lease`)
        }
        throw new SupervisorStateError('lease_conflict', `run ${id} lease must be heartbeated, not reacquired`)
      }
      if (options.fencingToken !== undefined && options.fencingToken !== run.fencingToken) {
        throw new SupervisorStateError('stale_lease', `run ${id} fencing token is stale`)
      }
      run.fencingToken += 1
      const lease: SupervisorLease = {
        id: options.leaseId === undefined ? randomUUID() : requiredId(options.leaseId, 'lease id'),
        ownerId,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: now + ttlMs,
        fencingToken: run.fencingToken
      }
      run.lease = lease
      touch(run, now)
      appendEvent(document, run, 'lease.acquired', options.actorId ?? ownerId, now, {
        ownerId,
        takeover: Boolean(current),
        fencingToken: lease.fencingToken
      }, lease.fencingToken)
      return clone(run)
    })
  }

  async heartbeatLease(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    const id = requiredId(runId, 'run id')
    const ttlMs = normalizeTtl(options.ttlMs)
    return this.mutate(options, (document, now) => {
      const run = findRun(document, id)
      assertExpectedRevision(run, options)
      assertLease(run, options, now)
      run.lease!.heartbeatAt = now
      run.lease!.expiresAt = now + ttlMs
      touch(run, now)
      appendEvent(document, run, 'lease.heartbeat', options.actorId ?? options.ownerId, now, {
        expiresAt: run.lease!.expiresAt
      }, run.lease!.fencingToken)
      return clone(run)
    })
  }

  async releaseLease(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    const id = requiredId(runId, 'run id')
    return this.mutate(options, (document, now) => {
      const run = findRun(document, id)
      assertExpectedRevision(run, options)
      assertLease(run, options, now)
      const fencingToken = run.lease?.fencingToken
      const from = run.status
      if (run.status === 'running' || run.status === 'waiting_approval') {
        run.status = 'paused'
        run.approval = undefined
      }
      run.lease = undefined
      touch(run, now)
      appendEvent(document, run, 'lease.released', options.actorId ?? options.ownerId, now, {}, fencingToken, from, run.status)
      return clone(run)
    })
  }

  async startRun(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    return this.transitionWithLease(runId, 'running', options, 'run.started')
  }

  async pauseRun(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    return this.mutate(options, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, options)
      assertLease(run, options, now)
      if (run.status !== 'running' && run.status !== 'waiting_approval') {
        throw new SupervisorStateError('invalid_transition', `run ${run.id} cannot pause from ${run.status}`)
      }
      const from = run.status
      const fencingToken = run.lease?.fencingToken
      run.status = 'paused'
      run.approval = undefined
      run.lease = undefined
      touch(run, now)
      appendEvent(document, run, 'run.paused', options.actorId ?? options.ownerId, now, {}, fencingToken, from, 'paused')
      return clone(run)
    })
  }

  /** Freeze an executor before canonical WorkItem ownership moves to another assignee. */
  async pauseRunForWorkItemTransfer(
    runId: string,
    options: SupervisorMutationOptions = {}
  ): Promise<SupervisorRunRecord> {
    return this.mutate(options, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, options)
      assertNotTerminal(run)
      if (run.status === 'waiting_reconciliation') {
        throw new SupervisorStateError(
          'invalid_transition',
          `run ${run.id} requires reconciliation before WorkItem transfer`
        )
      }
      const from = run.status
      const fencingToken = run.lease?.fencingToken
      run.status = 'paused'
      run.approval = undefined
      run.lease = undefined
      touch(run, now)
      appendEvent(document, run, 'run.paused', options.actorId ?? 'work-item-transfer', now, {
        reason: 'work_item_transfer'
      }, fencingToken, from, 'paused')
      return clone(run)
    })
  }

  async resumeRun(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    return this.transitionWithLease(runId, 'running', options, 'run.resumed')
  }

  async requestApproval(
    runId: string,
    approval: { id: string; reason?: string },
    options: SupervisorLeaseOptions
  ): Promise<SupervisorRunRecord> {
    const approvalId = requiredId(approval.id, 'approval id')
    return this.mutate(options, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, options)
      assertLease(run, options, now)
      if (run.status !== 'running') {
        throw new SupervisorStateError('invalid_transition', `run ${run.id} cannot wait for approval from ${run.status}`)
      }
      run.status = 'waiting_approval'
      run.approval = {
        id: approvalId,
        requestedAt: now,
        requestedBy: options.actorId ?? options.ownerId,
        ...(approval.reason === undefined ? {} : { reason: requiredText(approval.reason, 'approval reason') })
      }
      touch(run, now)
      appendEvent(document, run, 'run.waiting_approval', options.actorId ?? options.ownerId, now, {
        approvalId,
        reason: approval.reason
      }, run.lease?.fencingToken)
      return clone(run)
    })
  }

  async resolveApproval(runId: string, input: SupervisorApprovalInput): Promise<SupervisorRunRecord> {
    const approvalId = requiredId(input.approvalId, 'approval id')
    return this.mutate(input, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, input)
      if (run.status !== 'waiting_approval' || run.approval?.id !== approvalId) {
        throw new SupervisorStateError('approval_required', `run ${run.id} has no matching pending approval`)
      }
      const from = run.status
      run.approval = undefined
      if (input.approved) {
        run.status = 'paused'
        run.lease = undefined
      } else {
        run.status = 'failed'
        run.error = input.reason?.trim() || 'approval denied'
        run.lease = undefined
      }
      touch(run, now)
      appendEvent(document, run, 'run.approval_resolved', input.actorId ?? 'user', now, {
        approvalId,
        approved: input.approved,
        reason: input.reason
      }, undefined, from, run.status)
      return clone(run)
    })
  }

  async markBlocked(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    return this.transitionWithLease(runId, 'blocked', options, 'run.blocked')
  }

  async markWaitingReconciliation(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    return this.transitionWithLease(runId, 'waiting_reconciliation', options, 'run.waiting_reconciliation')
  }

  async failRun(runId: string, error: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    const message = requiredText(error, 'run error')
    return this.mutate(options, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, options)
      assertLease(run, options, now)
      if (TERMINAL.has(run.status)) throw new SupervisorStateError('invalid_transition', `run ${run.id} is terminal`)
      const from = run.status
      run.status = 'failed'
      run.error = message
      run.lease = undefined
      touch(run, now)
      appendEvent(document, run, 'run.failed', options.actorId ?? options.ownerId, now, { error: message }, undefined, from, 'failed')
      return clone(run)
    })
  }

  async completeRun(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    return this.mutate(options, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, options)
      assertLease(run, options, now)
      if (run.status !== 'running') {
        throw new SupervisorStateError('invalid_transition', `run ${run.id} cannot complete from ${run.status}`)
      }
      const from = run.status
      run.status = 'completed'
      run.lease = undefined
      touch(run, now)
      appendEvent(document, run, 'run.completed', options.actorId ?? options.ownerId, now, {}, undefined, from, 'completed')
      return clone(run)
    })
  }

  async cancelRun(runId: string, options: SupervisorMutationOptions = {}): Promise<SupervisorRunRecord> {
    return this.mutate(options, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, options)
      assertNotTerminal(run)
      const from = run.status
      run.status = 'cancelled'
      run.lease = undefined
      run.approval = undefined
      touch(run, now)
      appendEvent(document, run, 'run.cancelled', options.actorId ?? 'user', now, {}, undefined, from, 'cancelled')
      return clone(run)
    })
  }

  async authorizeRetry(runId: string, options: SupervisorMutationOptions = {}): Promise<SupervisorRunRecord> {
    return this.mutate(options, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, options)
      if (!['failed', 'blocked', 'waiting_reconciliation'].includes(run.status)) {
        throw new SupervisorStateError('invalid_transition', `run ${run.id} cannot retry from ${run.status}`)
      }
      if (run.retryCount >= run.maxRetries) {
        throw new SupervisorStateError('retry_limit', `run ${run.id} exhausted ${run.maxRetries} retries`)
      }
      assertGoalBudgetAllowsRetry(document, run)
      const from = run.status
      run.status = 'queued'
      run.retryCount += 1
      run.error = undefined
      run.lease = undefined
      run.approval = undefined
      touch(run, now)
      appendEvent(document, run, 'run.retry_authorized', options.actorId ?? 'user', now, {
        retryCount: run.retryCount,
        maxRetries: run.maxRetries
      }, undefined, from, 'queued')
      return clone(run)
    })
  }

  async reassignLease(
    runId: string,
    newOwnerId: string,
    options: SupervisorLeaseOptions
  ): Promise<SupervisorRunRecord> {
    const ownerId = requiredId(newOwnerId, 'new ownerId')
    return this.mutate(options, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, options)
      assertLease(run, options, now)
      const old = run.lease!
      const lease: SupervisorLease = {
        ...old,
        id: randomUUID(),
        ownerId,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: now + normalizeTtl(options.ttlMs),
        fencingToken: run.fencingToken + 1
      }
      run.fencingToken = lease.fencingToken
      run.lease = lease
      touch(run, now)
      appendEvent(document, run, 'lease.reassigned', options.actorId ?? old.ownerId, now, {
        previousOwnerId: old.ownerId,
        ownerId
      }, lease.fencingToken)
      return clone(run)
    })
  }

  async recoverExpiredLeases(now = this.now()): Promise<SupervisorRecoveryResult> {
    return this.recoverExpiredLeasesWhere(now, () => true)
  }

  /** Renderer recovery is coordination-only; TaskRun recovery belongs to SessionManager startup. */
  async recoverExpiredManualLeases(now = this.now()): Promise<SupervisorRecoveryResult> {
    return this.recoverExpiredLeasesWhere(now, (run) => run.origin !== 'task_run')
  }

  private async recoverExpiredLeasesWhere(
    now: number,
    includes: (run: SupervisorRunRecord) => boolean
  ): Promise<SupervisorRecoveryResult> {
    return this.mutate<SupervisorRecoveryResult>({ actorId: 'supervisor', now }, (document) => {
      const expiredRunIds: string[] = []
      const blockedRunIds: string[] = []
      for (const run of document.runs) {
        if (!includes(run) || !run.lease || run.lease.expiresAt > now || TERMINAL.has(run.status)) continue
        const from = run.status
        const fencingToken = run.lease.fencingToken
        run.lease = undefined
        if (run.status === 'running' || run.status === 'waiting_approval') {
          run.status = 'blocked'
          run.approval = undefined
          blockedRunIds.push(run.id)
        }
        touch(run, now)
        expiredRunIds.push(run.id)
        appendEvent(document, run, 'lease.expired', 'supervisor', now, {
          previousStatus: from
        }, fencingToken, from, run.status)
      }
      const result = { expiredRunIds, blockedRunIds }
      return expiredRunIds.length > 0 ? result : unchangedMutation(result)
    })
  }

  async recoverOrphanedTaskRunReservations(
    durableTaskRunIds: ReadonlySet<string>,
    now = this.now()
  ): Promise<string[]> {
    return this.mutate<string[]>({ actorId: 'supervisor-startup', now }, (document) => {
      const blockedRunIds: string[] = []
      for (const run of document.runs) {
        if (run.origin !== 'task_run' || durableTaskRunIds.has(run.id) || TERMINAL.has(run.status)) continue
        const from = run.status
        run.status = 'blocked'
        run.lease = undefined
        run.approval = undefined
        run.error = 'TaskRun reservation has no durable TaskRun after process restart'
        touch(run, now)
        appendEvent(document, run, 'run.blocked', 'supervisor-startup', now, {
          reason: 'missing_durable_task_run'
        }, undefined, from, 'blocked')
        blockedRunIds.push(run.id)
      }
      return blockedRunIds.length > 0 ? blockedRunIds : unchangedMutation(blockedRunIds)
    })
  }

  private async transitionWithLease(
    runId: string,
    status: SupervisorRunStatus,
    options: SupervisorLeaseOptions,
    kind: Extract<SupervisorEventKind, 'run.started' | 'run.paused' | 'run.resumed' | 'run.blocked' | 'run.waiting_reconciliation'>
  ): Promise<SupervisorRunRecord> {
    return this.mutate(options, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, options)
      assertLease(run, options, now)
      if (!allowedTransition(run.status, status)) {
        throw new SupervisorStateError('invalid_transition', `run ${run.id} cannot transition ${run.status} -> ${status}`)
      }
      const from = run.status
      run.status = status
      if (status !== 'waiting_approval') run.approval = undefined
      touch(run, now)
      appendEvent(document, run, kind, options.actorId ?? options.ownerId, now, {}, run.lease?.fencingToken, from, status)
      return clone(run)
    })
  }

  async purgeProject(projectId: string): Promise<{ runs: number; events: number }> {
    const id = requiredId(projectId, 'projectId')
    return this.mutate({ actorId: 'project-deletion' }, (document) => {
      const runIds = new Set(document.runs
        .filter((run) => run.projectId === id)
        .map((run) => run.id))
      const beforeRuns = document.runs.length
      const beforeEvents = document.events.length
      document.runs = document.runs.filter((run) => run.projectId !== id)
      document.events = document.events
        .filter((event) => !runIds.has(event.runId))
        .map((event, index) => ({ ...event, seq: index + 1 }))
      return {
        runs: beforeRuns - document.runs.length,
        events: beforeEvents - document.events.length
      }
    })
  }

  private async mutate<T>(options: SupervisorMutationOptions, mutation: Mutation<T>): Promise<T> {
    const run = async (): Promise<T> => withFileLock(this.filePath, this.lockPath, async () => {
      const document = await readDocument(this.filePath)
      const now = options.now ?? this.now()
      const result = mutation(document, now)
      if (isUnchangedMutation(result)) return result.value
      document.revision += 1
      await writeDocument(this.filePath, document)
      return result
    })
    const next = this.queue.then(run, run)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }
}

function unchangedMutation<T>(value: T): UnchangedMutation<T> {
  return { kind: UNCHANGED_MUTATION, value }
}

function isUnchangedMutation<T>(value: T | UnchangedMutation<T>): value is UnchangedMutation<T> {
  return typeof value === 'object' && value !== null &&
    'kind' in value && value.kind === UNCHANGED_MUTATION
}

function allowedTransition(from: SupervisorRunStatus, to: SupervisorRunStatus): boolean {
  const table: Record<SupervisorRunStatus, ReadonlySet<SupervisorRunStatus>> = {
    queued: new Set(['running', 'cancelled']),
    running: new Set(['waiting_approval', 'waiting_reconciliation', 'paused', 'blocked', 'failed', 'completed', 'cancelled']),
    waiting_approval: new Set(['paused', 'failed', 'cancelled']),
    waiting_reconciliation: new Set(['blocked', 'failed', 'cancelled']),
    paused: new Set(['running', 'cancelled']),
    blocked: new Set(['running', 'cancelled', 'queued']),
    failed: new Set(['queued']),
    completed: new Set(),
    cancelled: new Set()
  }
  return from === to || table[from].has(to)
}

function assertNotTerminal(run: SupervisorRunRecord): void {
  if (TERMINAL.has(run.status)) throw new SupervisorStateError('invalid_transition', `run ${run.id} is terminal`)
}

function assertExpectedRevision(run: SupervisorRunRecord, options: SupervisorMutationOptions): void {
  if (options.expectedRevision !== undefined && run.revision !== options.expectedRevision) {
    throw new SupervisorStateError('stale_revision', `run ${run.id} revision is ${run.revision}, expected ${options.expectedRevision}`)
  }
}

function assertStoreRevision(document: SupervisorStateDocument, options: SupervisorMutationOptions): void {
  if (options.expectedStoreRevision !== undefined && document.revision !== options.expectedStoreRevision) {
    throw new SupervisorStateError('stale_store_revision', `store revision is ${document.revision}, expected ${options.expectedStoreRevision}`)
  }
}

function assertLease(run: SupervisorRunRecord, options: SupervisorLeaseOptions, now: number): void {
  const lease = run.lease
  if (!lease || lease.expiresAt <= now) throw new SupervisorStateError('lease_expired', `run ${run.id} lease is expired`)
  if (lease.ownerId !== options.ownerId) throw new SupervisorStateError('lease_owner', `run ${run.id} lease owner does not match`)
  if (options.leaseId !== undefined && options.leaseId !== lease.id) throw new SupervisorStateError('stale_lease', 'lease id is stale')
  if (options.fencingToken !== undefined && options.fencingToken !== lease.fencingToken) {
    throw new SupervisorStateError('stale_lease', 'lease fencing token is stale')
  }
}

function appendEvent(
  document: SupervisorStateDocument,
  run: SupervisorRunRecord,
  kind: SupervisorEventKind,
  actorId: string,
  occurredAt: number,
  payload: Record<string, unknown>,
  fencingToken?: number,
  fromStatus?: SupervisorRunStatus,
  toStatus?: SupervisorRunStatus
): void {
  const event: SupervisorEvent = {
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
    id: randomUUID(),
    seq: document.events.length + 1,
    runId: run.id,
    kind,
    ...(fromStatus === undefined ? {} : { fromStatus }),
    ...(toStatus === undefined ? {} : { toStatus }),
    actorId,
    ...(fencingToken === undefined ? {} : { fencingToken }),
    occurredAt,
    payload: clone(payload)
  }
  document.events.push(event)
}

function findRun(document: SupervisorStateDocument, id: string): SupervisorRunRecord {
  const run = document.runs.find((candidate) => candidate.id === id)
  if (!run) throw new SupervisorStateError('not_found', `run ${id} was not found`)
  return run
}

function touch(run: SupervisorRunRecord, now: number): void {
  run.revision += 1
  run.updatedAt = now
}

function isStatus(value: unknown): value is SupervisorRunStatus {
  return value === 'queued' || value === 'running' || value === 'waiting_approval' ||
    value === 'waiting_reconciliation' || value === 'paused' || value === 'blocked' ||
    value === 'failed' || value === 'completed' || value === 'cancelled'
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new SupervisorStateError('invalid_input', `${label} is required`)
  return value.trim()
}

function requiredText(value: unknown, label: string): string {
  return requiredId(value, label)
}

function normalizeTimestamp(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new SupervisorStateError('invalid_input', `${label} must be a finite non-negative number`)
  }
  return value
}

function normalizeMaxRetries(value: number | undefined): number {
  const retries = value ?? 3
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 100) {
    throw new SupervisorStateError('invalid_input', 'maxRetries must be an integer between 0 and 100')
  }
  return retries
}

function normalizeTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_TTL_MS
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_MS) {
    throw new SupervisorStateError('invalid_input', `ttlMs must be between 1 and ${MAX_TTL_MS}`)
  }
  return ttl
}

function normalizeGoalBudget(value: GoalBudget | undefined): GoalBudget | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SupervisorStateError('invalid_input', 'Goal budget must be an object')
  }
  const budget: GoalBudget = {}
  if (value.amount !== undefined) budget.amount = nonNegativeFinite(value.amount, 'Goal budget amount')
  if (value.currency !== undefined) budget.currency = requiredText(value.currency, 'Goal budget currency').toUpperCase()
  if (value.maxTokens !== undefined) budget.maxTokens = positiveLimit(value.maxTokens, 'Goal budget maxTokens')
  if (value.maxRuns !== undefined) budget.maxRuns = positiveLimit(value.maxRuns, 'Goal budget maxRuns')
  if (value.maxConcurrentRuns !== undefined) {
    budget.maxConcurrentRuns = positiveLimit(value.maxConcurrentRuns, 'Goal budget maxConcurrentRuns')
  }
  return Object.keys(budget).length > 0 ? budget : undefined
}

function normalizeWorkItemLeaseBinding(
  value: SupervisorWorkItemLeaseBinding | undefined
): SupervisorWorkItemLeaseBinding | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SupervisorStateError('invalid_input', 'WorkItem lease binding must be an object')
  }
  const id = requiredText(value.id, 'WorkItem lease id')
  const ownerId = requiredText(value.ownerId, 'WorkItem lease ownerId')
  if (!Number.isSafeInteger(value.fencingToken) || value.fencingToken < 1) {
    throw new SupervisorStateError('invalid_input', 'WorkItem lease fencingToken must be a positive integer')
  }
  return { id, ownerId, fencingToken: value.fencingToken }
}

function normalizeAccountingBase(
  value: SupervisorRunAccountingBase | undefined
): SupervisorRunAccountingBase | undefined {
  if (value === undefined) return undefined
  return {
    usage: normalizeUsageTotals(value.usage, 'accounting base usage'),
    costUsd: nonNegativeFinite(value.costUsd, 'accounting base costUsd')
  }
}

function normalizeUsageTotals(value: UsageTotals, label: string): UsageTotals {
  if (!value || typeof value !== 'object') {
    throw new SupervisorStateError('invalid_input', `${label} must be an object`)
  }
  return {
    input: nonNegativeFinite(value.input, `${label}.input`),
    output: nonNegativeFinite(value.output, `${label}.output`),
    cacheRead: nonNegativeFinite(value.cacheRead, `${label}.cacheRead`),
    cacheCreation: nonNegativeFinite(value.cacheCreation, `${label}.cacheCreation`)
  }
}

function nonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new SupervisorStateError('invalid_input', `${label} must be a finite non-negative number`)
  }
  return value
}

function positiveLimit(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new SupervisorStateError('invalid_input', `${label} must be a positive integer`)
  }
  return value as number
}

function emptyRunUsage(): SupervisorRunUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, turns: 0 }
}

function assertGoalBudgetAllowsNewRun(
  document: SupervisorStateDocument,
  goalId: string | undefined,
  budget: GoalBudget | undefined
): void {
  if (!goalId || !budget) return
  assertSupportedBudgetCurrency(budget)
  const goalRuns = document.runs.filter((run) => run.goalId === goalId)
  if (budget.maxRuns !== undefined && goalRuns.length >= budget.maxRuns) {
    throw new SupervisorStateError(
      'budget_exhausted',
      `Goal ${goalId} exhausted maxRuns ${budget.maxRuns}`,
      { goalId, maxRuns: budget.maxRuns, actualRuns: goalRuns.length }
    )
  }
  if (budget.maxConcurrentRuns !== undefined) {
    const activeRuns = goalRuns.filter((run) => !TERMINAL.has(run.status)).length
    if (activeRuns >= budget.maxConcurrentRuns) {
      throw new SupervisorStateError(
        'concurrency_exhausted',
        `Goal ${goalId} reached maxConcurrentRuns ${budget.maxConcurrentRuns}`,
        { goalId, maxConcurrentRuns: budget.maxConcurrentRuns, activeRuns }
      )
    }
  }
  assertAggregateUsageAvailable(goalId, budget, aggregateGoalUsage(goalRuns))
}

function assertGoalBudgetAllowsTurn(
  document: SupervisorStateDocument,
  run: SupervisorRunRecord
): void {
  const budget = run.budget
  if (!run.goalId || !budget) return
  assertSupportedBudgetCurrency(budget)
  const goalRuns = document.runs.filter((candidate) => candidate.goalId === run.goalId)
  if (budget.maxConcurrentRuns !== undefined) {
    const activeRuns = goalRuns.filter((candidate) => !TERMINAL.has(candidate.status)).length
    if (activeRuns > budget.maxConcurrentRuns) {
      throw new SupervisorStateError(
        'concurrency_exhausted',
        `Goal ${run.goalId} exceeds maxConcurrentRuns ${budget.maxConcurrentRuns}`,
        { goalId: run.goalId, maxConcurrentRuns: budget.maxConcurrentRuns, activeRuns }
      )
    }
  }
  assertAggregateUsageAvailable(run.goalId, budget, aggregateGoalUsage(goalRuns))
}

function assertGoalBudgetAllowsRetry(
  document: SupervisorStateDocument,
  run: SupervisorRunRecord
): void {
  const budget = run.budget
  if (!run.goalId || !budget) return
  assertSupportedBudgetCurrency(budget)
  const goalRuns = document.runs.filter((candidate) => candidate.goalId === run.goalId)
  if (budget.maxConcurrentRuns !== undefined) {
    const activeOtherRuns = goalRuns.filter((candidate) =>
      candidate.id !== run.id && !TERMINAL.has(candidate.status)).length
    if (activeOtherRuns >= budget.maxConcurrentRuns) {
      throw new SupervisorStateError(
        'concurrency_exhausted',
        `Goal ${run.goalId} reached maxConcurrentRuns ${budget.maxConcurrentRuns}`,
        { goalId: run.goalId, maxConcurrentRuns: budget.maxConcurrentRuns, activeRuns: activeOtherRuns }
      )
    }
  }
  assertAggregateUsageAvailable(run.goalId, budget, aggregateGoalUsage(goalRuns))
}

function assertSupportedBudgetCurrency(budget: GoalBudget): void {
  if ((budget.amount ?? 0) <= 0) return
  const currency = budget.currency?.trim().toUpperCase() || 'USD'
  if (currency !== 'USD') {
    throw new SupervisorStateError(
      'budget_exhausted',
      `Goal cost budget currency ${currency} cannot be enforced from USD accounting`,
      { currency }
    )
  }
}

function aggregateGoalUsage(runs: readonly SupervisorRunRecord[]): SupervisorRunUsage {
  return runs.reduce<SupervisorRunUsage>((total, run) => {
    const usage = run.usage ?? emptyRunUsage()
    total.input += usage.input
    total.output += usage.output
    total.cacheRead += usage.cacheRead
    total.cacheCreation += usage.cacheCreation
    total.costUsd += usage.costUsd
    total.turns += usage.turns
    return total
  }, emptyRunUsage())
}

function assertAggregateUsageAvailable(
  goalId: string,
  budget: GoalBudget,
  usage: SupervisorRunUsage
): void {
  const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheCreation
  if (budget.maxTokens !== undefined && totalTokens >= budget.maxTokens) {
    throw new SupervisorStateError(
      'budget_exhausted',
      `Goal ${goalId} exhausted maxTokens ${budget.maxTokens}`,
      { goalId, maxTokens: budget.maxTokens, actualTokens: totalTokens }
    )
  }
  if ((budget.amount ?? 0) > 0 && usage.costUsd >= budget.amount!) {
    throw new SupervisorStateError(
      'budget_exhausted',
      `Goal ${goalId} exhausted cost budget USD ${budget.amount}`,
      { goalId, amountUsd: budget.amount, actualCostUsd: usage.costUsd }
    )
  }
}

function usageFromObservation(
  run: SupervisorRunRecord,
  observed: UsageTotals,
  observedCostUsd: number,
  turnCompleted: boolean
): SupervisorRunUsage {
  const base = run.accountingBase ?? { usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, costUsd: 0 }
  const current = run.usage ?? emptyRunUsage()
  const nextTurns = current.turns + (turnCompleted ? 1 : 0)
  if (!Number.isSafeInteger(nextTurns)) {
    throw new SupervisorStateError('invalid_input', 'run usage.turns exceeds the safe integer range')
  }
  return {
    input: accumulatedTurnUsage(current.input, observed.input, turnCompleted, 'input'),
    output: accumulatedTurnUsage(current.output, observed.output, turnCompleted, 'output'),
    cacheRead: accumulatedTurnUsage(current.cacheRead, observed.cacheRead, turnCompleted, 'cacheRead'),
    cacheCreation: accumulatedTurnUsage(current.cacheCreation, observed.cacheCreation, turnCompleted, 'cacheCreation'),
    costUsd: Math.max(current.costUsd, observedCostUsd - base.costUsd, 0),
    turns: nextTurns
  }
}

function accumulatedTurnUsage(
  current: number,
  observed: number,
  turnCompleted: boolean,
  field: keyof UsageTotals
): number {
  return nonNegativeFinite(
    current + (turnCompleted ? observed : 0),
    `run usage.${field}`
  )
}

function sameRunUsage(left: SupervisorRunUsage | undefined, right: SupervisorRunUsage): boolean {
  const current = left ?? emptyRunUsage()
  return current.input === right.input && current.output === right.output &&
    current.cacheRead === right.cacheRead && current.cacheCreation === right.cacheCreation &&
    current.costUsd === right.costUsd && current.turns === right.turns
}

function observedSupervisorStatus(run: SupervisorRunRecord, status: TaskRunStatus): SupervisorRunStatus {
  if (TERMINAL.has(run.status)) return run.status
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return status
  if (run.status === 'paused' || run.status === 'blocked') return run.status
  if (status === 'waiting_approval') return 'waiting_approval'
  if (status === 'waiting_reconciliation') return 'waiting_reconciliation'
  return status === 'queued' ? 'queued' : 'running'
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function cloneDocument(document: SupervisorStateDocument): SupervisorStateDocument {
  return clone(document)
}

async function readDocument(filePath: string): Promise<SupervisorStateDocument> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
    assertDocument(parsed)
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyDocument()
    if (error instanceof SupervisorStateError) throw error
    throw new SupervisorStateError('corrupt_store', `cannot read supervisor state: ${String(error)}`)
  }
}

/** Synchronous read for the final request-budget barrier. Uses the same
 * validated, atomically replaced document as Supervisor mutations. */
export function readSupervisorStateSync(rootDir: string): SupervisorStateDocument {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(rootDir, STORE_FILE_NAME), 'utf8'))
    assertDocument(parsed)
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyDocument()
    if (error instanceof SupervisorStateError) throw error
    throw new SupervisorStateError('corrupt_store', `cannot read supervisor state: ${String(error)}`)
  }
}

function emptyDocument(): SupervisorStateDocument {
  return { schemaVersion: SUPERVISOR_SCHEMA_VERSION, revision: 0, runs: [], events: [] }
}

function assertDocument(value: unknown): asserts value is SupervisorStateDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SupervisorStateError('corrupt_store', 'supervisor state must be an object')
  }
  const document = value as Partial<SupervisorStateDocument>
  if (document.schemaVersion !== SUPERVISOR_SCHEMA_VERSION) {
    throw new SupervisorStateError('unsupported_schema', `supervisor schema ${String(document.schemaVersion)} is unsupported`)
  }
  if (!Number.isSafeInteger(document.revision) || (document.revision as number) < 0 ||
      !Array.isArray(document.runs) || !Array.isArray(document.events)) {
    throw new SupervisorStateError('corrupt_store', 'supervisor state shape is invalid')
  }
  for (const run of document.runs) assertRun(run)
  for (const event of document.events) assertEvent(event)
}

function assertRun(value: unknown): asserts value is SupervisorRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SupervisorStateError('corrupt_store', 'run record is invalid')
  const run = value as Partial<SupervisorRunRecord>
  assertRunCoreShape(run)
  assertRunAccountingShape(run)
  if (run.lease !== undefined) assertLeaseShape(run.lease)
  if (run.approval !== undefined && (!run.approval || typeof run.approval.id !== 'string')) {
    throw new SupervisorStateError('corrupt_store', `run ${run.id} approval is invalid`)
  }
}

function assertRunCoreShape(run: Partial<SupervisorRunRecord>): void {
  if (run.schemaVersion !== SUPERVISOR_SCHEMA_VERSION || typeof run.id !== 'string' ||
      typeof run.projectId !== 'string' || typeof run.workItemId !== 'string' ||
      (run.goalId !== undefined && typeof run.goalId !== 'string') || !isStatus(run.status)) {
    invalidRunShape(run)
  }
  if (!isSafeIntegerAtLeast(run.revision, 1) || !isSafeIntegerAtLeast(run.fencingToken, 0) ||
      !isSafeIntegerAtLeast(run.retryCount, 0) || !isSafeIntegerAtLeast(run.maxRetries, 0)) {
    invalidRunShape(run)
  }
  if (!isNonNegativeFinite(run.createdAt) || !isNonNegativeFinite(run.updatedAt) ||
      (run.error !== undefined && typeof run.error !== 'string') ||
      (run.origin !== undefined && run.origin !== 'manual' && run.origin !== 'task_run')) invalidRunShape(run)
}

function assertRunAccountingShape(run: Partial<SupervisorRunRecord>): void {
  try {
    if (run.budget !== undefined && normalizeGoalBudget(run.budget) === undefined) invalidRunShape(run)
    if (run.workItemLease !== undefined) normalizeWorkItemLeaseBinding(run.workItemLease)
    if (run.accountingBase !== undefined) normalizeAccountingBase(run.accountingBase)
    if (run.usage !== undefined) {
      normalizeUsageTotals(run.usage, 'run usage')
      nonNegativeFinite(run.usage.costUsd, 'run usage.costUsd')
      if (!isSafeIntegerAtLeast(run.usage.turns, 0)) invalidRunShape(run)
    }
  } catch (error) {
    if (error instanceof SupervisorStateError && error.code === 'corrupt_store') throw error
    invalidRunShape(run)
  }
}

function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function invalidRunShape(run: Partial<SupervisorRunRecord>): never {
  throw new SupervisorStateError('corrupt_store', `run ${String(run.id)} is invalid`)
}

function assertLeaseShape(value: unknown): asserts value is SupervisorLease {
  if (!value || typeof value !== 'object') throw new SupervisorStateError('corrupt_store', 'lease is invalid')
  const lease = value as Partial<SupervisorLease>
  if (typeof lease.id !== 'string' || typeof lease.ownerId !== 'string' ||
      !Number.isFinite(lease.acquiredAt) || !Number.isFinite(lease.heartbeatAt) ||
      !Number.isFinite(lease.expiresAt) || !Number.isSafeInteger(lease.fencingToken) || (lease.fencingToken ?? 0) < 1) {
    throw new SupervisorStateError('corrupt_store', 'lease shape is invalid')
  }
}

function assertEvent(value: unknown): asserts value is SupervisorEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SupervisorStateError('corrupt_store', 'supervisor event is invalid')
  const event = value as Partial<SupervisorEvent>
  if (event.schemaVersion !== SUPERVISOR_SCHEMA_VERSION || typeof event.id !== 'string' ||
      !Number.isSafeInteger(event.seq) || (event.seq as number) < 1 || typeof event.runId !== 'string' ||
      typeof event.kind !== 'string' || typeof event.actorId !== 'string' ||
      typeof event.occurredAt !== 'number' || !event.payload || typeof event.payload !== 'object') {
    throw new SupervisorStateError('corrupt_store', 'supervisor event shape is invalid')
  }
}

async function withFileLock<T>(filePath: string, lockPath: string, callback: () => Promise<T>): Promise<T> {
  await mkdir(dirname(filePath), { recursive: true })
  const owner = `${process.pid}:${randomUUID()}`
  const started = Date.now()
  let handle: Awaited<ReturnType<typeof open>> | undefined
  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(owner, 'utf8')
      await handle.sync()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
      await removeStaleLock(lockPath)
      await sleep(LOCK_WAIT_MS)
    }
  }
  if (!handle) throw new SupervisorStateError('lock_timeout', 'timed out waiting for supervisor state lock')
  try {
    return await callback()
  } finally {
    await handle.close().catch(() => undefined)
    const current = await readFile(lockPath, 'utf8').catch(() => undefined)
    if (current === owner) await unlink(lockPath).catch(() => undefined)
  }
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const lockStat = await stat(lockPath)
    const owner = await readFile(lockPath, 'utf8').catch(() => undefined)
    const pid = owner ? Number.parseInt(owner.split(':', 1)[0], 10) : Number.NaN
    const abandoned = Number.isSafeInteger(pid) && pid > 0
      ? !processIsAlive(pid)
      : Date.now() - lockStat.mtimeMs > LOCK_STALE_MS
    if (abandoned) await unlink(lockPath).catch(() => undefined)
  } catch {
    // Another writer may have released the lock.
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function writeDocument(filePath: string, document: SupervisorStateDocument): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close().catch(() => undefined)
  }
  try {
    await rename(temporary, filePath)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
