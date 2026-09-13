import type { AgentEvent } from '../../shared/types'

export interface TaskSnapshotReplaySendOptions {
  modelAttemptRecoveryReplay?: boolean
  supervisorControlReplay?: boolean
}

interface TaskSnapshotReplayPlan {
  sessionId: string
  prompts: string[]
  options: TaskSnapshotReplaySendOptions
  nextIndex: number
  activeStep: number
  inFlight: boolean
  turnSucceeded: boolean
  dispatching: boolean
  pendingFailure?: string
}

interface TaskSnapshotReplayDependencies {
  send: (
    sessionId: string,
    prompt: string,
    options: TaskSnapshotReplaySendOptions
  ) => Promise<boolean>
  emit: (sessionId: string, event: AgentEvent) => void
}

/** Runs recovered prompts one turn at a time and stops at the first uncertain outcome. */
export class TaskSnapshotReplayCoordinator {
  private readonly plans = new Map<string, TaskSnapshotReplayPlan>()

  constructor(private readonly dependencies: TaskSnapshotReplayDependencies) {}

  async start(
    sessionId: string,
    prompts: readonly string[],
    options: TaskSnapshotReplaySendOptions = {}
  ): Promise<boolean> {
    const replayPrompts = prompts.filter((prompt) => prompt.trim().length > 0)
    if (replayPrompts.length === 0) return false
    if (this.plans.has(sessionId)) return false
    const plan: TaskSnapshotReplayPlan = {
      sessionId,
      prompts: replayPrompts,
      options,
      nextIndex: 0,
      activeStep: 0,
      inFlight: false,
      turnSucceeded: false,
      dispatching: false
    }
    this.plans.set(sessionId, plan)
    return this.dispatchNext(plan)
  }

  handleEvent(sessionId: string, event: AgentEvent, recoveryReady: Promise<boolean>): void {
    const plan = this.plans.get(sessionId)
    if (!plan) return
    if (event.kind === 'turn-result') {
      if (!plan.inFlight) return
      if (event.isError) {
        this.fail(plan, 'task-snapshot-replay-failed', event.resultText ?? event.subtype)
      } else {
        plan.turnSucceeded = true
      }
      return
    }
    if (event.kind !== 'status') return
    if (event.status === 'closed') {
      this.plans.delete(sessionId)
      return
    }
    if (event.status === 'error') {
      if (plan.dispatching) {
        plan.pendingFailure = event.error ?? '执行引擎拒绝恢复步骤'
      } else {
        this.fail(plan, 'task-snapshot-replay-failed', event.error)
      }
      return
    }
    if (event.status !== 'idle' || !plan.inFlight || !plan.turnSucceeded) return
    plan.inFlight = false
    plan.turnSucceeded = false
    void recoveryReady.then(
      (ready) => {
        if (this.plans.get(sessionId) !== plan) return
        if (ready) void this.dispatchNext(plan)
        else this.fail(plan, 'task-snapshot-replay-gated', 'ModelAttempt 恢复门禁刷新失败')
      },
      (error) => {
        this.fail(plan, 'task-snapshot-replay-gated', errorText(error))
      }
    )
  }

  clearSession(sessionId: string): void {
    this.plans.delete(sessionId)
  }

  clear(): void {
    this.plans.clear()
  }

  hasPending(sessionId: string): boolean {
    return this.plans.has(sessionId)
  }

  blocksOrdinarySend(sessionId: string, options: TaskSnapshotReplaySendOptions): boolean {
    return this.hasPending(sessionId) &&
      !options.modelAttemptRecoveryReplay &&
      !options.supervisorControlReplay
  }

  private async dispatchNext(plan: TaskSnapshotReplayPlan): Promise<boolean> {
    if (this.plans.get(plan.sessionId) !== plan || plan.inFlight) return false
    if (plan.nextIndex >= plan.prompts.length) {
      this.plans.delete(plan.sessionId)
      return true
    }
    const prompt = plan.prompts[plan.nextIndex]
    plan.activeStep = plan.nextIndex + 1
    plan.nextIndex += 1
    plan.inFlight = true
    plan.dispatching = true
    plan.pendingFailure = undefined
    let accepted = false
    let sendError: unknown
    try {
      accepted = await this.dependencies.send(plan.sessionId, prompt, plan.options)
    } catch (error) {
      sendError = error
      plan.pendingFailure = errorText(error)
    } finally {
      plan.dispatching = false
    }
    if (!accepted || plan.pendingFailure) {
      this.fail(
        plan,
        'task-snapshot-replay-rejected',
        plan.pendingFailure ?? 'SessionManager rejected the recovered prompt'
      )
      return false
    }
    return true
  }

  private fail(plan: TaskSnapshotReplayPlan, event: string, reason?: string): void {
    if (this.plans.get(plan.sessionId) !== plan) return
    this.plans.delete(plan.sessionId)
    const suffix = reason?.trim() ? ` 原因:${cleanOneLine(reason)}` : ''
    this.dependencies.emit(plan.sessionId, {
      kind: 'hook-event',
      event,
      detail: `快照恢复步骤 ${plan.activeStep}/${plan.prompts.length} 未完成,已停止后续自动续跑。${suffix}`
    })
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cleanOneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240)
}
