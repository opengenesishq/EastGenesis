import { currentGoalModeOccurrence, goalModeGeneration } from './goal-mode-generation'
import { dirname } from 'node:path'
import { getTaskHostExecutionGate, taskHostSubject } from '../task-handoff/execution-gate'
import type { SessionGoalModeClearResult } from '../../shared/session-goal-mode'
import { createHash, randomUUID } from 'node:crypto'
import type { SessionInputRecord } from '../../shared/session-input-types'
import type { SessionMeta, TaskRunRecord } from '../../shared/types'
import { listRoutines, updateRoutine, type Routine } from '../routineStore'
import { assertRoutineSessionTarget, sameRoutineSessionTarget } from './routine-heartbeat-target'
import { listRoutineRuns, patchRoutineHeartbeat, reserveRoutineHeartbeat, settleRoutineRun, type RoutineRunRecord } from './routine-runner'
import type { GoalContinuationDecision } from './goal-continuation-policy'

export interface RoutineHeartbeatRuntime {
  ownershipRoot?: string
  meta(id: string): SessionMeta | undefined
  inputs: {
    cancel?(id: string, requestId: string): Promise<SessionInputRecord>
    list(id: string): Promise<SessionInputRecord[]>
    queue(id: string, requestId: string, payload: { text: string }): Promise<SessionInputRecord>
    apply(id: string, requestId: string, beforeDispatch?: () => Promise<void>): Promise<SessionInputRecord>
  }
  runs(id: string): Promise<TaskRunRecord[]>
  result(sessionId: string, messageId: string): { text: string; isError: boolean; observedAt?: number } | undefined
  persistResult?(record: RoutineRunRecord, run: TaskRunRecord, text: string | undefined): Promise<{ artifactId: string; evidenceId: string }>
  notify?(routine: Routine, record: RoutineRunRecord): void
  goalCheck?(routine: Routine, record: RoutineRunRecord): Promise<GoalContinuationDecision>
  goalReserve?(record: RoutineRunRecord): Promise<void>
  goalSettle?(record: RoutineRunRecord): Promise<void>
}

/** Continues existing Sessions through the durable input outbox. Never creates or closes a Session. */
export class RoutineHeartbeatService {
  private readonly queues = new Map<string, Promise<unknown>>()
  constructor(private readonly root: string, private readonly runtime: RoutineHeartbeatRuntime) {}

  trigger(routine: Routine, nextRunAt: number | null, scheduledAt?: number): Promise<RoutineRunRecord> {
    const target = routine.executionTarget
    if (!target) return Promise.reject(new Error('定时继续缺少原任务。'))
    return this.serial(target.sessionId, async () => {
      const latest = (await listRoutines(this.root)).find((item) => item.id === routine.id)
      if (!latest?.enabled || !latest.executionTarget) throw new Error('该计划已暂停、删除或修改，请刷新后重试。')
      if (!sameRoutineSessionTarget(target, latest.executionTarget)) throw new Error('计划绑定已变化，旧触发已停止，请刷新后重试。')
      const occurrence = scheduledAt === undefined ? randomUUID() : String(scheduledAt)
      const id = `heartbeat-${createHash('sha256').update(`${routine.id}\0${occurrence}`).digest('hex').slice(0, 40)}`
      const record = await reserveRoutineHeartbeat(this.root, latest, id, scheduledAt ?? Date.now(), nextRunAt)
      return this.process(record)
    })
  }

  /** Shares the dispatch queue, persists the exit before touching pending receipts,
   * and never classifies a submitted/unknown request as unsent. */
  retireSessionGoalMode(sessionId: string, originalMeta?: SessionMeta): Promise<Omit<SessionGoalModeClearResult, 'executionPaused'>> {
    return this.serial(sessionId, async () => {
      const result = { sessionId, routineIds: [] as string[], cancelledInputIds: [] as string[], pendingInputIds: [] as string[] }
      const routines = (await listRoutines(this.root)).filter(item => item.executionTarget?.sessionId === sessionId)
      for (const routine of routines) {
        assertRoutineSessionTarget(routine.executionTarget!, this.runtime.meta(sessionId) ?? originalMeta)
        await updateRoutine(this.root, routine.id, { enabled: false,
          ...(routine.goalContinuation ? { goalContinuationState: {
            ...(routine.goalContinuationState ?? { turns: 0, repeatedResults: 0 }), generation: goalModeGeneration(routine) + 1,
            status: 'exited', exitedAt: Date.now(), reason: '已清除持续目标模式；任务历史、费用和已用轮数保留。' } } : {}) })
        result.routineIds.push(routine.id)
      }
      const runs = await this.runtime.runs(sessionId)
      for (const record of (await listRoutineRuns(this.root)).filter(item => item.heartbeat?.target.sessionId === sessionId &&
        ['queued', 'running'].includes(item.status))) {
        const heartbeat = record.heartbeat!
        const input = (await this.runtime.inputs.list(sessionId)).find(item => item.id === heartbeat.inputRequestId)
        const sent = record.workflowRunId || heartbeat.phase !== 'queued' || runs.some(run =>
          run.messageId === heartbeat.messageId || run.steps?.some(step => step.messageId === heartbeat.messageId)) ||
          (input && !['queued', 'cancelled'].includes(input.phase))
        if (sent) { result.pendingInputIds.push(heartbeat.inputRequestId); continue }
        if (input?.phase === 'queued') {
          try {
            if (!this.runtime.inputs.cancel) throw new Error('无法撤回旧派发回执')
            await this.runtime.inputs.cancel(sessionId, input.id)
          } catch { result.pendingInputIds.push(heartbeat.inputRequestId); continue }
        }
        await settleRoutineRun(this.root, record.id, { status: 'failed', error: '持续目标模式已清除；本次旧排队未发送。' })
        result.cancelledInputIds.push(heartbeat.inputRequestId)
      }
      return result
    })
  }

  async sweep(sessionId?: string): Promise<void> {
    const pending = (await listRoutineRuns(this.root)).filter((run) => run.heartbeat &&
      (run.status === 'queued' || run.status === 'running') && (!sessionId || run.sessionId === sessionId))
    for (const record of pending.sort((left, right) => left.startedAt - right.startedAt)) {
      await this.serial(record.sessionId!, () => this.process(record)).catch((error) => {
        console.error('[caogen] routine continuation reconciliation failed:', record.id, error)
      })
    }
    // Missing/changed tasks pause plans even between occurrences.
    for (const routine of (await listRoutines(this.root)).filter((item) => item.enabled && item.executionTarget &&
      (!sessionId || item.executionTarget.sessionId === sessionId))) {
      try { assertRoutineSessionTarget(routine.executionTarget!, this.runtime.meta(routine.executionTarget!.sessionId)) }
      catch (error) { await updateRoutine(this.root, routine.id, { enabled: false, lastError: message(error) }) }
    }
  }

  private async process(snapshot: RoutineRunRecord): Promise<RoutineRunRecord> {
    let record = (await listRoutineRuns(this.root, snapshot.routineId)).find((run) => run.id === snapshot.id) ?? snapshot
    if (!record.heartbeat || record.status === 'succeeded' || record.status === 'failed') return record
    const heartbeat = record.heartbeat
    const sessionId = heartbeat.target.sessionId
    const routine = (await listRoutines(this.root)).find((item) => item.id === record.routineId)
    try {
      const input = (await this.runtime.inputs.list(sessionId)).find((item) => item.id === heartbeat.inputRequestId)
      if (input && (input.messageId !== heartbeat.messageId || input.payload.text !== heartbeat.prompt)) {
        return this.uncertain(record, '定时补充的持久回执内容不一致，已暂停核对。')
      }
      const runs = await this.runtime.runs(sessionId)
      const matches = runs.filter((run) => run.sessionId === sessionId &&
        (run.messageId === heartbeat.messageId || run.steps?.some((step) => step.messageId === heartbeat.messageId)))
      if (matches.length > 1) return this.uncertain(record, '定时补充对应多个运行记录，请核对原任务。')
      const run = matches[0]
      if (run?.steps?.some((step) => step.messageId === heartbeat.messageId && step.requestText !== heartbeat.prompt)) {
        return this.uncertain(record, '定时补充对应运行的请求内容不一致，已暂停核对。')
      }
      if (run && (!record.workflowRunId || record.workflowRunId === run.id)) {
        if (run.status === 'completed' && !this.runtime.result(sessionId, heartbeat.messageId)) {
          record = await patchRoutineHeartbeat(this.root, record.id, { workflowRunId: run.id })
          return this.uncertain(record, '原运行已结束，但本次补充的结果记录尚未核对；不会自动重发。')
        }
        record = await patchRoutineHeartbeat(this.root, record.id, { phase: 'accepted', status: 'running', workflowRunId: run.id,
          inboxStatus: run.status === 'waiting_approval' ? 'waiting_approval' : 'running', error: null })
        if (routine && sameRoutineSessionTarget(routine.executionTarget, heartbeat.target) && routine.runState !== 'running') {
          await updateRoutine(this.root, routine.id, { runState: 'running', lastError: null })
        }
        if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
          const result = this.runtime.result(sessionId, heartbeat.messageId)
          const succeeded = run.status === 'completed' && !result?.isError
          const evidence = succeeded && record.projectId && record.workItemId && this.runtime.persistResult
            ? await this.runtime.persistResult(record, run, result?.text) : undefined
          const settled = await settleRoutineRun(this.root, record.id, { status: succeeded ? 'succeeded' : 'failed',
            workflowRunId: run.id, ...evidence, resultText: result?.text,
            resultObservedAt: result?.observedAt ?? run.finishedAt, error: succeeded ? undefined : run.error || result?.text || '本轮执行已停止。' })
          if (routine?.goalContinuation && settled) await this.runtime.goalSettle?.(settled)
          if (routine && settled) this.runtime.notify?.(routine, settled)
          return settled ?? record
        }
        assertRoutineSessionTarget(heartbeat.target, this.runtime.meta(sessionId))
        return record
      }
      if (record.workflowRunId && (!run || run.id !== record.workflowRunId)) {
        return this.uncertain(record, '本次定时执行的原始运行记录不可核对，已暂停计划。')
      }
      if (input?.phase === 'applied' || input?.phase === 'dispatching' || input?.phase === 'needs_reconciliation' ||
          heartbeat.phase !== 'queued') {
        return this.uncertain(record, '定时补充已提交，但接收或运行结果尚未核对；不会自动重发。')
      }
      if (input?.phase === 'cancelled') return this.pauseAndFail(record, '本次定时补充已撤回。')
      assertRoutineSessionTarget(heartbeat.target, this.runtime.meta(sessionId))
      if (!routine) return this.pauseAndFail(record, '计划已删除，尚未发送的定时补充已停止。')
      if (!currentGoalModeOccurrence(routine, record)) return this.retireOccurrence(record)
      if (!routine.enabled) return record
      if (!sameRoutineSessionTarget(routine.executionTarget, heartbeat.target)) return this.pauseAndFail(record, '计划绑定已变化，旧定时补充不会发送。')
      const meta = this.runtime.meta(sessionId)!
      const hostGate = getTaskHostExecutionGate(this.runtime.ownershipRoot ?? dirname(this.root)), hostClaim = hostGate.claim(taskHostSubject(meta))
      if (routine.goalContinuation) {
        if (!this.runtime.goalCheck || !this.runtime.goalReserve) throw new Error('持续推进的预算与目标检查不可用。')
        const decision = await this.runtime.goalCheck(routine, record)
        if (decision.action !== 'continue') return this.deferGoal(record, decision)
      }
      if (meta.status === 'running' || meta.status === 'starting' || runs.some((candidate) =>
        !['completed', 'failed', 'cancelled'].includes(candidate.status))) return record
      // These calls preserve the original permission, model, budget and canonical ownership gates.
      await this.runtime.inputs.queue(sessionId, heartbeat.inputRequestId, { text: heartbeat.prompt })
      // Recheck the live plan after outbox persistence; pausing must prevent an unsent occurrence.
      const current = (await listRoutines(this.root)).find((item) => item.id === routine.id)
      if (current && !currentGoalModeOccurrence(current, record)) return this.retireOccurrence(record)
      if (!current?.enabled) return record
      if (!sameRoutineSessionTarget(current.executionTarget, heartbeat.target)) return this.pauseAndFail(record, '计划绑定已变化，旧定时补充不会发送。')
      const receipt = await this.runtime.inputs.apply(sessionId, heartbeat.inputRequestId, async () => {
        const plan = (await listRoutines(this.root)).find((item) => item.id === routine.id)
        if (!plan?.enabled || !currentGoalModeOccurrence(plan, record)) throw new RoutinePausedBeforeDispatch()
        if (!sameRoutineSessionTarget(plan.executionTarget, heartbeat.target)) throw new Error('计划绑定已变化，旧定时补充不会发送。')
        assertRoutineSessionTarget(heartbeat.target, this.runtime.meta(sessionId))
        hostGate.assert(taskHostSubject(meta), hostClaim)
        if (plan.goalContinuation) {
          const decision = await this.runtime.goalCheck!(plan, record)
          if (decision.action !== 'continue') throw new GoalContinuationDeferred(decision)
          await this.runtime.goalReserve!(record)
        }
      })
      if (receipt.phase !== 'applied') return this.uncertain(record, receipt.error || '定时补充接收结果待核对。')
      record = await patchRoutineHeartbeat(this.root, record.id, { phase: 'accepted', status: 'running', error: null })
      return this.process(record)
    } catch (error) {
      // Re-read the outbox: even a thrown send may already have reached the model.
      const receipt = await this.runtime.inputs.list(sessionId).then((items) => items.find((item) => item.id === heartbeat.inputRequestId)).catch(() => undefined)
      if (receipt && receipt.phase !== 'queued' && receipt.phase !== 'cancelled') return this.uncertain(record, message(error))
      if (error instanceof RoutinePausedBeforeDispatch) return record
      if (error instanceof GoalContinuationDeferred) return this.deferGoal(record, error.decision)
      const meta = this.runtime.meta(sessionId)
      try { assertRoutineSessionTarget(heartbeat.target, meta) }
      catch (identityError) { return this.pauseAndFail(record, message(identityError)) }
      if (meta && (meta.status === 'running' || meta.status === 'starting')) return record
      return this.pauseAndFail(record, message(error))
    }
  }

  private async retireOccurrence(record: RoutineRunRecord): Promise<RoutineRunRecord> {
    const input = (await this.runtime.inputs.list(record.sessionId!)).find(item => item.id === record.heartbeat!.inputRequestId)
    if (input?.phase === 'queued') {
      if (!this.runtime.inputs.cancel) throw new Error('旧目标派发缺少撤回能力')
      await this.runtime.inputs.cancel(record.sessionId!, input.id)
    }
    return (await settleRoutineRun(this.root, record.id, { status: 'failed', error: '持续目标已退出，旧排队不会再次派发。' })) ?? record
  }

  private async uncertain(record: RoutineRunRecord, error: string): Promise<RoutineRunRecord> {
    const routine = await this.pauseOriginalPlan(record, error)
    const updated = await patchRoutineHeartbeat(this.root, record.id, { phase: 'needs_reconciliation', status: 'running', inboxStatus: 'failed', error })
    if (routine && record.heartbeat?.phase !== 'needs_reconciliation') this.runtime.notify?.(routine, updated)
    return updated
  }

  private async deferGoal(record: RoutineRunRecord, decision: GoalContinuationDecision): Promise<RoutineRunRecord> {
    const routine = (await listRoutines(this.root)).find(item => item.id === record.routineId)
    if (!routine?.goalContinuation || !sameRoutineSessionTarget(routine.executionTarget, record.heartbeat?.target)) return record
    const state = routine.goalContinuationState ?? { turns: 0, repeatedResults: 0, status: 'active' as const }
    await updateRoutine(this.root, routine.id, { ...(decision.action === 'stop' ? { enabled: false, lastError: decision.status === 'completed' ? null : decision.reason } : {}),
      goalContinuationState: { ...state, status: decision.status, reason: decision.reason } })
    if (decision.action === 'wait') return record
    return (await settleRoutineRun(this.root, record.id, { status: decision.status === 'completed' ? 'succeeded' : 'failed',
      resultText: decision.reason, ...(decision.status === 'completed' ? {} : { error: decision.reason }) })) ?? record
  }

  private async pauseAndFail(record: RoutineRunRecord, error: string): Promise<RoutineRunRecord> {
    const routine = await this.pauseOriginalPlan(record, error)
    const settled = await settleRoutineRun(this.root, record.id, { status: 'failed', error }) ?? record
    if (routine) this.runtime.notify?.(routine, settled)
    return settled
  }

  private async pauseOriginalPlan(record: RoutineRunRecord, error: string): Promise<Routine | null> {
    const routine = (await listRoutines(this.root)).find((item) => item.id === record.routineId)
    if (!routine || !sameRoutineSessionTarget(routine.executionTarget, record.heartbeat?.target)) return null
    return updateRoutine(this.root, record.routineId, { enabled: false, lastError: error, runState: 'failed',
      ...(routine.goalContinuation ? { goalContinuationState: { ...(routine.goalContinuationState ?? { turns: 0, repeatedResults: 0 }), status: routine.goalContinuationState?.status === 'exited' ? 'exited' : 'paused', reason: error } } : {}) })
  }

  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    this.queues.set(id, next)
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id) }).catch(() => undefined)
    return next
  }
}
class RoutinePausedBeforeDispatch extends Error { constructor() { super('计划已暂停，本次补充尚未发送。') } }
class GoalContinuationDeferred extends Error { constructor(readonly decision: GoalContinuationDecision) { super(decision.reason) } }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
