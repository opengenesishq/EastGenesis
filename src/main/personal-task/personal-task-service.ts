import type { PersonalTaskSubmissionView, PersonalTaskSubmitInput } from '../../shared/personal-task-types'
import { ensureManagedPersonalWorkspace } from '../project-workspace/managed-personal-workspace'
import { assertActiveBusinessLine } from '../business-line-registry-reader'
import { withSessionOperationQueue } from '../session-operation-queue'
import { ensurePersonalTaskDirectory } from './personal-task-directory'
import { TaskKernel } from '../task/task-kernel'
import {
  normalizePersonalTaskInput, personalTaskCanonicalRequestId, personalTaskErrorView,
  personalTaskInputDigest, personalTaskRequestId, PersonalTaskSubmissionError
} from './personal-task-input'
import {
  assertMatchingPersonalTaskInput, PersonalTaskSubmissionStore,
  type PersonalTaskSubmissionRecord
} from './personal-task-submission-store'
import { assertPersonalSessionIdentity, readPersonalTaskEvidence, type PersonalTaskEvidence } from './personal-task-evidence'
import { personalTaskSendMustReconcile, personalTaskSubmissionView, personalTaskUnverifiedView } from './personal-task-recovery'
import type { PersonalTaskRuntime } from './personal-task-runtime-types'
import { ensurePersonalTaskPlan, personalTaskRequestText, personalTaskStrategy, resolvePersonalTaskExecution } from './personal-task-execution'

interface ActiveSubmission {
  digest: string
  promise: Promise<PersonalTaskSubmissionView>
}

export class PersonalTaskService {
  private readonly store: PersonalTaskSubmissionStore
  private readonly active = new Map<string, ActiveSubmission>()

  constructor(private readonly rootDir: string, private readonly runtime: PersonalTaskRuntime) {
    this.store = new PersonalTaskSubmissionStore(rootDir)
  }

  submit(rawInput: unknown): Promise<PersonalTaskSubmissionView> {
    const input = normalizePersonalTaskInput(rawInput)
    const digest = personalTaskInputDigest(input)
    const active = this.active.get(input.clientRequestId)
    if (active) {
      if (active.digest !== digest) throw new PersonalTaskSubmissionError('PERSONAL_TASK_REQUEST_CONFLICT', '相同提交标识不能用于不同任务')
      return active.promise.then((view) => ({ ...view, replayed: true }))
    }
    const promise = withSessionOperationQueue(`personal-task:${this.rootDir}:${input.clientRequestId}`,
      () => this.performSubmit(input)).finally(() => this.active.delete(input.clientRequestId))
    this.active.set(input.clientRequestId, { digest, promise })
    return promise
  }

  async get(clientRequestId: unknown): Promise<PersonalTaskSubmissionView | null> {
    const id = personalTaskRequestId(clientRequestId)
    await this.runtime.whenInitialized()
    const record = this.store.read(id)
    if (!record) return null
    try {
      return personalTaskSubmissionView(record, await this.evidence(record), { replayed: true, active: this.active.has(id) })
    } catch (error) {
      return personalTaskUnverifiedView(record, personalTaskErrorView(error), true)
    }
  }

  private async performSubmit(input: PersonalTaskSubmitInput): Promise<PersonalTaskSubmissionView> {
    await this.runtime.whenInitialized()
    const prior = this.store.read(input.clientRequestId)
    if (prior) assertMatchingPersonalTaskInput(prior, input)
    let record = prior ?? this.store.reserve(input, resolvePersonalTaskExecution(input))
    const replayed = Boolean(prior)
    try {
      let evidence = await this.evidence(record)
      if (evidence.firstMessageAccepted) return this.accepted(record, evidence, replayed)
      if (personalTaskSendMustReconcile(record, evidence)) return this.blocked(record, evidence, replayed)
      assertActiveBusinessLine(input.businessLineId!, this.rootDir)
      record = await this.ensureTask(record)
      record = await this.ensureSession(record)
      await ensurePersonalTaskPlan(record, this.runtime, this.rootDir)
      evidence = await this.evidence(record)
      if (evidence.firstMessageAccepted) return this.accepted(record, evidence, replayed)
      if (personalTaskSendMustReconcile(record, evidence)) return this.blocked(record, evidence, replayed)
      return await this.dispatch(record, replayed)
    } catch (error) {
      return this.failed(record, error, replayed)
    }
  }

  private async ensureTask(record: PersonalTaskSubmissionRecord): Promise<PersonalTaskSubmissionRecord> {
    const prior = await this.evidence(record)
    if (record.taskCreatedAt && (!prior.goal || !prior.workItem)) {
      throw new PersonalTaskSubmissionError('PERSONAL_TASK_CANONICAL_RECOVERY_REQUIRED', '已建立的任务记录不再可用，提交回执不能重新创建已删除的任务')
    }
    await ensureManagedPersonalWorkspace(this.rootDir)
    const cwd = ensurePersonalTaskDirectory(this.rootDir, record.binding)
    const kernel = new TaskKernel(this.rootDir)
    const created = await kernel.create({
      rootDir: this.rootDir,
      requestId: personalTaskCanonicalRequestId(record.clientRequestId),
      objective: record.input.text,
      businessLineId: record.input.businessLineId,
      workspaceId: record.binding.workspaceId,
      cwd,
      deferExecution: true
    })
    const planned = await kernel.plan(created)
    if (planned.goalId !== record.binding.goalId || planned.workItemId !== record.binding.workItemId) {
      throw new PersonalTaskSubmissionError('PERSONAL_TASK_IDENTITY_CONFLICT', 'canonical 任务身份与提交回执不一致')
    }
    return record.phase === 'reserved' || record.phase === 'not_sent'
      ? this.store.update(record, { phase: 'task_created', taskCreatedAt: record.taskCreatedAt ?? Date.now(), error: undefined }) : record
  }

  private async ensureSession(record: PersonalTaskSubmissionRecord): Promise<PersonalTaskSubmissionRecord> {
    const evidence = await this.evidence(record)
    let session = evidence.session
    if (!session) {
      if (evidence.hasSessionRecord || evidence.pendingCreation || record.sessionCreatedAt || record.phase === 'session_ready') {
        throw new PersonalTaskSubmissionError('PERSONAL_TASK_SESSION_RECOVERY_REQUIRED', '原会话已留有创建或恢复记录，请先恢复原会话')
      }
      const cwd = ensurePersonalTaskDirectory(this.rootDir, record.binding)
      const { clientRequestId: _requestId, text: _text, ...options } = record.input
      session = await this.runtime.createManaged({
        ...options, cwd, initialPrompt: personalTaskRequestText(record), taskStrategy: personalTaskStrategy(record.execution),
        workspaceId: record.binding.workspaceId, personalWorkspaceId: record.binding.workspaceId,
        goalId: record.binding.goalId, workItemId: record.binding.workItemId,
        unassigned: false, isolated: false, experienceModeOverride: 'assistant'
      }, { reservedSessionId: record.binding.sessionId, awaitStart: true })
    }
    assertPersonalSessionIdentity(record, session, this.rootDir)
    return this.store.update(record, { phase: 'session_ready', sessionCreatedAt: record.sessionCreatedAt ?? Date.now(),
      sdkSessionId: session.sdkSessionId, error: undefined })
  }

  private async dispatch(record: PersonalTaskSubmissionRecord, replayed: boolean): Promise<PersonalTaskSubmissionView> {
    // This write is the no-duplicate-send boundary. A crash after it must consult canonical
    // acceptance evidence; no startup handler or timeout retry may infer that nothing ran.
    record = this.store.update(record, { phase: 'dispatching', dispatchClaimedAt: Date.now(), error: undefined })
    const accepted = await this.runtime.send(record.binding.sessionId, { text: personalTaskRequestText(record), messageId: record.messageId })
    await this.runtime.persistTaskRunLifecycleBarrier(record.binding.sessionId)
    const evidence = await this.evidence(record)
    if (evidence.firstMessageAccepted) return this.accepted(record, evidence, replayed)
    if (accepted || evidence.attemptCount || evidence.hasExecutionEffects) return this.blocked(record, evidence, replayed)
    record = this.store.update(record, { phase: 'not_sent', error: {
      code: 'PERSONAL_TASK_NOT_SENT', message: evidence.session?.lastError ?? '任务尚未发送，请检查当前会话状态后重试'
    } })
    return personalTaskSubmissionView(record, evidence, { replayed })
  }

  private accepted(record: PersonalTaskSubmissionRecord, evidence: PersonalTaskEvidence, replayed: boolean): PersonalTaskSubmissionView {
    if (record.phase !== 'submitted') record = this.store.update(record, {
      phase: 'submitted', runId: evidence.acceptedRunId, sdkSessionId: evidence.sdkSessionId, error: undefined
    })
    return personalTaskSubmissionView(record, evidence, { replayed })
  }

  private blocked(record: PersonalTaskSubmissionRecord, evidence: PersonalTaskEvidence, replayed: boolean): PersonalTaskSubmissionView {
    if (record.phase !== 'needs_reconciliation') record = this.store.update(record, { phase: 'needs_reconciliation', error: {
      code: 'PERSONAL_TASK_RECONCILIATION_REQUIRED', message: '首条任务的发送结果尚未核实；请查看原任务恢复记录，已阻止重复发送'
    } })
    return personalTaskSubmissionView(record, evidence, { replayed })
  }

  private async failed(record: PersonalTaskSubmissionRecord, error: unknown, replayed: boolean): Promise<PersonalTaskSubmissionView> {
    const failure = personalTaskErrorView(error)
    try {
      record = this.store.read(record.clientRequestId) ?? record
      const evidence = await this.evidence(record)
      if (evidence.firstMessageAccepted) return this.accepted(record, evidence, replayed)
      const phase = personalTaskSendMustReconcile(record, evidence) ? 'needs_reconciliation' : 'not_sent'
      record = this.store.update(record, { phase, error: failure })
      return personalTaskSubmissionView(record, evidence, { replayed })
    } catch {
      return personalTaskUnverifiedView(record, failure, replayed)
    }
  }

  private evidence(record: PersonalTaskSubmissionRecord): Promise<PersonalTaskEvidence> {
    return readPersonalTaskEvidence(record, { rootDir: this.rootDir, runtime: this.runtime })
  }
}
