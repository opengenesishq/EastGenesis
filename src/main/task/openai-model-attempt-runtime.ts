import type { ModelAttemptUsage } from '../../shared/model-attempt-types'
import type { NativeRequestBudgetInput } from '../model/native-request-budget'
import { createNativeModelExecutorReceipt } from './model-attempt-executor'
import { isModelRouteError } from '../model/model-route-error'
import { consumeWithNativeHttpRefusal } from '../model/native-http-refusal'
import type { TaskRunRecord, UsageTotals } from '../../shared/types'
import {
  classifyRuntimeModelFailure,
  executePersistedModelAttempt,
  isModelAttemptOperationError,
  isModelAttemptPersistenceError,
  modelAttemptUsage,
  ModelAttemptPersistenceError,
  type RuntimeModelAttemptDependencies,
  unwrapModelAttemptOperationError
} from './model-attempt-runtime'

export interface OpenAIModelAttemptAuth {
  /** Legacy test-only identity input; production request paths use keyId/keyLabel and a scoped lease. */
  token?: string
  keyId?: string
  keyLabel?: string
}

export interface OpenAIModelAttemptFetch<T> {
  budgetScope?: NativeRequestBudgetInput
  run?: TaskRunRecord
  providerId: string
  model: string
  protocol: 'openai.chat-completions' | 'openai.responses'
  url: string
  init: RequestInit
  signal: AbortSignal
  auth: OpenAIModelAttemptAuth
  canonicalContextDigest?: string
  readUsage: () => UsageTotals | undefined
  estimateCost?: (usage: ModelAttemptUsage | undefined) => number | undefined
  consume: (response: Response) => Promise<T>
  preflight?: () => void | Promise<void>
  fetch?: typeof fetch
  executeFetch?: (operationId: string) => Promise<Response>
}

interface LogicalRequest {
  requestId: string
  stepId?: string
  failoverFromAttemptId?: string
}

const MAX_INFLIGHT = Math.max(1, Number(process.env.CAOGEN_MAX_INFLIGHT) || 8)
let inflight = 0
const waitQueue: Array<() => void> = []

export class OpenAIModelAttemptTracker {
  private messageId = ''
  private sequence = 0
  private routeReason = 'Session uses the configured provider and model'
  private pending?: { requestId: string; attemptId: string }

  constructor(
    private readonly dependencies?: Partial<RuntimeModelAttemptDependencies>
  ) {}

  startTurn(messageId: string): void {
    this.messageId = messageId
    this.sequence = 0
    this.pending = undefined
    this.routeReason = 'Session uses the configured provider and model'
  }

  setRouteReason(reason: string): void {
    this.routeReason = reason.trim() || 'Session uses the configured provider and model'
  }

  discardPendingFailover(): void {
    this.pending = undefined
  }

  async fetch<T>(input: OpenAIModelAttemptFetch<T>): Promise<T> {
    await acquireSlot()
    try {
      const logical = this.logicalRequest(input.run)
      return await this.fetchWithRetries(input, logical)
    } finally {
      releaseSlot()
    }
  }

  private logicalRequest(run: TaskRunRecord | undefined): LogicalRequest {
    if (!run) {
      throw new ModelAttemptPersistenceError(
        'start', false, undefined, new Error('active TaskRun is missing for OpenAI request')
      )
    }
    const pending = this.pending
    this.pending = undefined
    const requestId = pending?.requestId ??
      `model-request:${run.id}:${this.messageId || 'system'}:${++this.sequence}`
    const stepId = [...(run.steps ?? [])].reverse().find((step) =>
      step.messageId === this.messageId || !step.finishedAt
    )?.id
    return { requestId, stepId, failoverFromAttemptId: pending?.attemptId }
  }

  private async fetchWithRetries<T>(
    input: OpenAIModelAttemptFetch<T>,
    logical: LogicalRequest
  ): Promise<T> {
    const delays = [500, 1500]
    let failoverFromAttemptId = logical.failoverFromAttemptId
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      // Keep policy denial outside the Attempt transaction: no ledger start and no network.
      await input.preflight?.()
      let fetchResolved = false
      const usageBefore = input.readUsage()
      try {
        return await executePersistedModelAttempt({
          budgetScope: input.budgetScope,
          runId: input.run!.id,
          requestId: logical.requestId,
          stepId: logical.stepId,
          providerId: input.providerId,
          model: input.model,
          protocol: input.protocol,
          adapterVersion: 'openai-engine-v1',
          executorReceipt: createNativeModelExecutorReceipt('openai_engine', {
            providerId: input.providerId, model: input.model, protocol: input.protocol, adapterVersion: 'openai-engine-v1'
          }),
          context: { url: input.url, method: input.init.method ?? 'GET', body: input.init.body },
          contextDigest: input.canonicalContextDigest,
          routeReason: this.attemptRouteReason(failoverFromAttemptId),
          keyIdentity: { providerId: input.providerId, ...input.auth },
          failoverFromAttemptId
        }, async () => {
          const response = input.executeFetch
            ? await input.executeFetch(logical.requestId)
            : await (input.fetch ?? fetch)(input.url, input.init)
          fetchResolved = true
          return consumeWithNativeHttpRefusal(response, input.consume, input.signal)
        }, {
          dependencies: this.dependencies,
          success: () => {
            const usage = modelAttemptUsageDelta(usageBefore, input.readUsage())
            return { usage, costUsd: input.estimateCost?.(usage) }
          },
          failure: (error) => {
            const failure = classifyRuntimeModelFailure(error, { aborted: input.signal.aborted })
            const usage = modelAttemptUsageDelta(usageBefore, input.readUsage())
            return { ...failure, usage, costUsd: input.estimateCost?.(usage) }
          }
        })
      } catch (error) {
        if (isModelRouteError(error)) throw error
        if (isModelAttemptPersistenceError(error)) throw error
        if (isModelAttemptOperationError(error)) failoverFromAttemptId = error.attemptId
        if (requestWasAborted(error, input.signal)) throw error
        if (!fetchResolved && attempt < delays.length) {
          await delay(delays[attempt])
          continue
        }
        if (failoverFromAttemptId) {
          this.pending = { requestId: logical.requestId, attemptId: failoverFromAttemptId }
        }
        throw error
      }
    }
    throw new Error('OpenAI request retry loop exhausted')
  }

  private attemptRouteReason(failoverFromAttemptId: string | undefined): string {
    return failoverFromAttemptId
      ? `${this.routeReason}; retry/failover predecessor recorded`
      : this.routeReason
  }
}

export function modelAttemptUsageDelta(
  before: UsageTotals | undefined,
  after: UsageTotals | undefined
) {
  if (!after) return undefined
  return modelAttemptUsage({
    input: Math.max(0, after.input - (before?.input ?? 0)),
    output: Math.max(0, after.output - (before?.output ?? 0)),
    cacheRead: Math.max(0, after.cacheRead - (before?.cacheRead ?? 0)),
    cacheWrite: Math.max(0, after.cacheCreation - (before?.cacheCreation ?? 0))
  })
}

export function addUsageTotals(current: UsageTotals | undefined, next: UsageTotals): UsageTotals {
  return current ? {
    input: current.input + next.input,
    output: current.output + next.output,
    cacheRead: current.cacheRead + next.cacheRead,
    cacheCreation: current.cacheCreation + next.cacheCreation
  } : next
}

function requestWasAborted(error: unknown, signal: AbortSignal): boolean {
  const original = unwrapModelAttemptOperationError(error)
  return signal.aborted || (original instanceof Error && original.name === 'AbortError')
}

function acquireSlot(): Promise<void> {
  if (inflight < MAX_INFLIGHT) {
    inflight += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => waitQueue.push(resolve))
}

function releaseSlot(): void {
  const next = waitQueue.shift()
  if (next) next()
  else inflight = Math.max(0, inflight - 1)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
