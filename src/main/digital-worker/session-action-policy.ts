import type { SessionMeta, TaskRunRecord } from '../../shared/types'
import { taskRuntimeRegistry } from '../task/task-runtime-registry'
import type { ModelAttemptCostIdentity } from '../provider/modelAttemptCost'
import { preflightDigitalWorkerBillableAction } from './billable-action-policy'
import { resolveDigitalWorkerExecutionContext } from './worker-execution-prompt'

interface SessionActionPolicyInput {
  rootDir: string
  meta: SessionMeta
  run?: TaskRunRecord
  activeSessions: readonly SessionMeta[]
}

export class DigitalWorkerProviderDispatchDeniedError extends Error {
  readonly name = 'DigitalWorkerProviderDispatchDeniedError'
}

/** Recheck the frozen worker/Assignment immediately before every Provider attempt. */
export async function assertDigitalWorkerProviderDispatchAllowed(
  meta: SessionMeta,
  rootDir: string,
  attempt: ModelAttemptCostIdentity = modelAttemptIdentityForSession(meta)
): Promise<void> {
  const run = taskRuntimeRegistry.get(meta.id)
  if (!run) {
    throw new DigitalWorkerProviderDispatchDeniedError(
      'Provider dispatch 缺少 canonical TaskRun，已阻止请求'
    )
  }
  const decision = await preflightDigitalWorkerBillableAction({
    rootDir,
    meta,
    action: 'provider_send',
    runId: run.id,
    runStatus: run.status,
    runBinding: run.digitalWorkerBinding,
    failureCount: failedRunCount(run)
  }, attempt)
  if ('message' in decision) {
    throw new DigitalWorkerProviderDispatchDeniedError(decision.message)
  }
  // Handoff/outbound preparation and budget checks can await after prompt
  // construction. Revalidate the role and frozen Assignment at actual dispatch.
  try {
    resolveDigitalWorkerExecutionContext(rootDir, meta)
  } catch (error) {
    throw new DigitalWorkerProviderDispatchDeniedError(error instanceof Error ? error.message : String(error))
  }
}

export function isDigitalWorkerProviderDispatchDeniedError(
  error: unknown
): error is DigitalWorkerProviderDispatchDeniedError {
  return error instanceof DigitalWorkerProviderDispatchDeniedError
}

export async function digitalWorkerSendPolicyError(
  input: SessionActionPolicyInput & { supervisorControlReplay?: boolean }
): Promise<string | null> {
  const decision = await preflightDigitalWorkerBillableAction({
    rootDir: input.rootDir,
    meta: input.meta,
    action: input.supervisorControlReplay ? 'supervisor_resume' : 'provider_send',
    runId: input.run?.id,
    runStatus: input.run?.status,
    runBinding: input.run?.digitalWorkerBinding,
    failureCount: failedRunCount(input.run),
    escalationApproved: input.supervisorControlReplay === true,
    activeSessions: input.activeSessions
  }, modelAttemptIdentityForSession(input.meta))
  return 'message' in decision ? decision.message : null
}

export async function digitalWorkerSupervisorPolicyError(
  input: SessionActionPolicyInput & { action: 'retry' | 'resume' }
): Promise<string | null> {
  const decision = await preflightDigitalWorkerBillableAction({
    rootDir: input.rootDir,
    meta: input.meta,
    action: input.action === 'retry' ? 'supervisor_retry' : 'supervisor_resume',
    runId: input.run?.id,
    runStatus: input.run?.status,
    runBinding: input.run?.digitalWorkerBinding,
    failureCount: failedRunCount(input.run),
    escalationApproved: true,
    activeSessions: input.activeSessions
  }, modelAttemptIdentityForSession(input.meta))
  return 'message' in decision ? decision.message : null
}

function modelAttemptIdentityForSession(meta: SessionMeta): ModelAttemptCostIdentity {
  return {
    providerId: meta.providerId || (meta.engine === 'anthropic' ? 'anthropic' : 'openai'),
    model: meta.model,
    protocol: meta.engine === 'anthropic' ? 'anthropic.messages' : 'openai.responses'
  }
}

function failedRunCount(run: TaskRunRecord | undefined): number | undefined {
  return run?.status === 'failed' || run?.status === 'waiting_reconciliation' ? run.attempt : undefined
}
