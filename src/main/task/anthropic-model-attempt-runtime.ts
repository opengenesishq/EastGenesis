import type { ModelAttemptUsage } from '../../shared/model-attempt-types'
import type { NativeRequestBudgetInput } from '../model/native-request-budget'
import type { TaskRunRecord } from '../../shared/types'
import type { AnthropicMessagesResult } from '../anthropicMessagesAdapter'
import {
  beginPersistedModelAttempt,
  classifyRuntimeModelFailure,
  executePersistedModelAttempt,
  modelAttemptUsage,
  ModelAttemptPersistenceError,
  type PersistedModelAttemptHandle,
  type RuntimeModelAttemptDependencies
} from './model-attempt-runtime'

export const ANTHROPIC_MESSAGES_PROTOCOL = 'anthropic.messages'
export const ANTHROPIC_MESSAGES_ADAPTER_VERSION = 'anthropic-messages-v1'

interface ModelAttemptIdentity {
  protocol: string
  adapterVersion: string
  label: string
}

const ANTHROPIC_IDENTITY: ModelAttemptIdentity = {
  protocol: ANTHROPIC_MESSAGES_PROTOCOL,
  adapterVersion: ANTHROPIC_MESSAGES_ADAPTER_VERSION,
  label: 'Anthropic Messages'
}

export interface AnthropicModelAttemptAuth {
  /** Legacy test-only identity input; production request paths use key metadata and a scoped lease. */
  token?: string
  keyId?: string
  keyLabel?: string
}

export interface AnthropicModelAttemptInput {
  budgetScope?: NativeRequestBudgetInput
  run?: TaskRunRecord
  providerId: string
  model: string
  endpoint: string
  method?: string
  body: unknown
  signal: AbortSignal
  auth: AnthropicModelAttemptAuth
  canonicalContextDigest?: string
  requestId?: string
  failoverFromAttemptId?: string
  routeReason?: string
  estimateCost?: (usage: ModelAttemptUsage | undefined) => number | undefined
  preflight?: () => void | Promise<void>
  operation: (operationId: string) => Promise<AnthropicMessagesResult>
}

export class AnthropicModelAttemptTracker {
  private messageId = ''
  private sequence = 0

  constructor(
    private readonly dependencies?: Partial<RuntimeModelAttemptDependencies>,
    private readonly identity: ModelAttemptIdentity = ANTHROPIC_IDENTITY
  ) {}

  startTurn(messageId: string): void {
    this.messageId = messageId
    this.sequence = 0
  }

  async execute(input: AnthropicModelAttemptInput): Promise<AnthropicMessagesResult> {
    // Policy denial must happen before the durable Attempt is opened.
    await input.preflight?.()
    const attempt = this.attemptInput(input)
    return executePersistedModelAttempt(attempt, () => input.operation(attempt.requestId), {
      dependencies: this.dependencies,
      success: (result) => {
        const usage = modelAttemptUsage({
          input: result.usage.input,
          output: result.usage.output,
          cacheRead: result.usage.cacheRead,
          cacheWrite: result.usage.cacheCreation
        })
        return { usage, costUsd: input.estimateCost?.(usage) }
      },
      failure: (error) => classifyRuntimeModelFailure(error, { aborted: input.signal.aborted })
    })
  }

  async begin(input: Omit<AnthropicModelAttemptInput, 'operation'>): Promise<PersistedModelAttemptHandle> {
    await input.preflight?.()
    return beginPersistedModelAttempt(this.attemptInput(input), {
      dependencies: this.dependencies
    })
  }

  private attemptInput(input: Omit<AnthropicModelAttemptInput, 'operation'>) {
    const run = input.run
    if (!run) {
      throw new ModelAttemptPersistenceError(
        'start',
        false,
        undefined,
        new Error(`active TaskRun is missing for ${this.identity.label} request`)
      )
    }
    const steps = run.steps ?? []
    const stepId = [...steps].reverse().find((step) => step.messageId === this.messageId)?.id
      ?? steps.find((step) => !step.finishedAt)?.id
    const explicitRequestId = input.requestId?.trim()
    const predecessorAttemptId = input.failoverFromAttemptId?.trim()
    if (Boolean(explicitRequestId) !== Boolean(predecessorAttemptId)) {
      throw new ModelAttemptPersistenceError(
        'start',
        false,
        undefined,
        new Error(`${this.identity.label} failover successor requires both requestId and failoverFromAttemptId`)
      )
    }
    const requestId = explicitRequestId ??
      `model-request:${run.id}:${this.messageId || 'system'}:${++this.sequence}`
    return {
      budgetScope: input.budgetScope,
      runId: run.id,
      requestId,
      stepId,
      providerId: input.providerId,
      model: input.model,
      protocol: this.identity.protocol,
      adapterVersion: this.identity.adapterVersion,
      context: {
        endpoint: input.endpoint,
        method: input.method ?? 'POST',
        body: input.body
      },
      contextDigest: input.canonicalContextDigest,
      routeReason: input.routeReason?.trim() ||
        `Session uses the saved Provider target with the native ${this.identity.label} adapter`,
      keyIdentity: { providerId: input.providerId, ...input.auth },
      ...(predecessorAttemptId ? { failoverFromAttemptId: predecessorAttemptId } : {})
    }
  }
}
