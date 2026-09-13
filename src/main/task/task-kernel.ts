import {
  prepareCanonicalSystemOperation,
  assertCanonicalSystemOperationReady,
  planCanonicalSystemOperation,
  resumeCanonicalSystemOperation,
  settleCanonicalSystemOperation,
  stopCanonicalSystemOperation,
  type CanonicalSystemOperationContext,
  type CanonicalSystemOperationSettlementContext,
  type PrepareCanonicalSystemOperationInput
} from './system-operation-context'

/**
 * Retained for adapters that still advertise an unavailable lifecycle phase.
 * The built-in TaskKernel commands below now perform durable Goal/WorkItem
 * transitions; an adapter that has not been migrated can continue to use this
 * explicit error instead of returning an untracked success value.
 */
export type TaskKernelUnavailablePhase = 'plan' | 'approve' | 'stop' | 'reconcile'

export class TaskKernelCommandUnavailableError extends Error {
  readonly code = 'TASK_KERNEL_COMMAND_UNAVAILABLE' as const

  constructor(readonly phase: TaskKernelUnavailablePhase) {
    super(`TaskKernel ${phase} command is not wired to a durable transition`)
    this.name = 'TaskKernelCommandUnavailableError'
  }
}

export class TaskKernelExecutionOrderError extends Error {
  readonly code = 'TASK_KERNEL_EXECUTION_BEFORE_PLAN' as const

  constructor() {
    super('TaskKernel execute requires a planned canonical operation')
    this.name = 'TaskKernelExecutionOrderError'
  }
}

/**
 * The first command boundary for the execution OS.
 *
 * Domain adapters supply the actual Effect callback; identity creation,
 * lifecycle transitions and acceptance/delivery settlement all go through the
 * canonical Workspace/Goal/WorkItem services. Deferred operations must cross
 * the plan boundary before execution; approval, stop and reconciliation keep
 * the same identity while changing the durable lifecycle state.
 */
export class TaskKernel {
  constructor(private readonly rootDir?: string) {}

  async create(input: PrepareCanonicalSystemOperationInput): Promise<CanonicalSystemOperationContext> {
    return prepareCanonicalSystemOperation({ ...input, rootDir: input.rootDir ?? this.requireRootDir() })
  }

  async plan(context: CanonicalSystemOperationContext): Promise<CanonicalSystemOperationContext> {
    return planCanonicalSystemOperation(context)
  }

  async execute<T>(
    context: CanonicalSystemOperationContext,
    action: () => T | Promise<T>
  ): Promise<T> {
    if (context.executionDeferred) throw new TaskKernelExecutionOrderError()
    await assertCanonicalSystemOperationReady(context)
    return action()
  }

  async approve<T>(
    context: CanonicalSystemOperationContext,
    action: () => T | Promise<T>
  ): Promise<T> {
    await resumeCanonicalSystemOperation(context)
    return action()
  }

  async stop<T>(
    context: CanonicalSystemOperationContext,
    action: () => T | Promise<T>
  ): Promise<T> {
    try {
      return await action()
    } finally {
      await stopCanonicalSystemOperation(context)
    }
  }

  async reconcile<T>(
    context: CanonicalSystemOperationContext,
    action: () => T | Promise<T>
  ): Promise<T> {
    const value = await action()
    await resumeCanonicalSystemOperation(context)
    return value
  }

  async accept(
    context: CanonicalSystemOperationSettlementContext,
    input: { status?: 'passed' | 'failed'; evidenceRefs: string[]; verifiedBy: string }
  ): Promise<{ goal: import('../../shared/project-workspace-types').Goal; workItem: import('../../shared/project-workspace-types').WorkItem }> {
    return settleCanonicalSystemOperation(context, { ...input, status: input.status ?? 'passed' })
  }

  async deliver(
    context: CanonicalSystemOperationSettlementContext,
    input: { status?: 'passed' | 'failed'; evidenceRefs: string[]; verifiedBy: string }
  ): Promise<{ goal: import('../../shared/project-workspace-types').Goal; workItem: import('../../shared/project-workspace-types').WorkItem }> {
    return settleCanonicalSystemOperation(context, { ...input, status: input.status ?? 'passed' })
  }

  private requireRootDir(): string {
    if (!this.rootDir) throw new Error('TaskKernel requires a rootDir for canonical task creation')
    return this.rootDir
  }
}
