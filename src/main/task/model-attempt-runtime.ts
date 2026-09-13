import { createHash, randomUUID } from 'node:crypto'
import type { NativeRequestBudgetInput } from '../model/native-request-budget'
import { releaseUnsentModelBudget, reserveModelAttemptBudget, settleModelAttemptBudget } from './model-attempt-budget'
import { isModelRouteError } from '../model/model-route-error'
import { nativeHttpRefusalEvidence } from '../model/native-http-refusal'
import type {
  ModelAttemptCompleteInput,
  ModelAttemptOutcome,
  ModelAttemptRecord,
  ModelAttemptUsage
} from '../../shared/model-attempt-types'
import {
  completePersistedModelAttempt,
  getPersistedModelAttemptRetryAuthorization,
  startPersistedModelAttempt
} from './model-attempt-api'

export interface RuntimeModelAttemptInput {
  budgetScope?: NativeRequestBudgetInput
  runId: string
  requestId: string
  stepId?: string
  providerId: string
  model: string
  protocol: string
  adapterVersion: string
  context: unknown
  /** Provider-neutral digest supplied by the CaoGen context boundary. */
  contextDigest?: string
  routeReason: string
  keyIdentity?: RuntimeModelKeyIdentity
  failoverFromAttemptId?: string
  rootDir?: string
  id?: string
  startedAt?: number
}

export interface RuntimeModelKeyIdentity {
  providerId: string
  keyId?: string
  keyLabel?: string
  token?: string
}

export interface RuntimeModelAttemptSuccess {
  usage?: ModelAttemptUsage
  costUsd?: number
}

export interface RuntimeModelAttemptFailure {
  status: 'failed' | 'cancelled'
  outcome: Exclude<ModelAttemptOutcome, 'success' | 'unknown'>
  errorClass?: string
  usage?: ModelAttemptUsage
  costUsd?: number
}

export interface RuntimeModelAttemptDependencies {
  start: typeof startPersistedModelAttempt
  complete: typeof completePersistedModelAttempt
  getRetryAuthorization: typeof getPersistedModelAttemptRetryAuthorization
  now: () => number
  randomId: () => string
}

export interface RuntimeModelAttemptOptions<T> {
  success?: (value: T) => RuntimeModelAttemptSuccess | undefined
  failure?: (error: unknown) => RuntimeModelAttemptFailure
  dependencies?: Partial<RuntimeModelAttemptDependencies>
}

export interface RuntimeModelAttemptBeginOptions {
  dependencies?: Partial<RuntimeModelAttemptDependencies>
}

export interface PersistedModelAttemptHandle {
  readonly attempt: ModelAttemptRecord
  succeed(success?: RuntimeModelAttemptSuccess): Promise<ModelAttemptRecord>
  fail(failure: RuntimeModelAttemptFailure, cause?: unknown): Promise<ModelAttemptRecord>
  cancel(cause?: unknown): Promise<ModelAttemptRecord>
}

export class ModelAttemptPersistenceError extends Error {
  readonly name = 'ModelAttemptPersistenceError'

  constructor(
    readonly phase: 'start' | 'complete',
    readonly operationStarted: boolean,
    readonly attemptId: string | undefined,
    cause: unknown
  ) {
    super(`ModelAttempt ${phase} persistence failed: ${errorMessage(cause)}`, { cause })
  }
}

export class ModelAttemptOperationError extends Error {
  readonly name = 'ModelAttemptOperationError'

  constructor(
    readonly attemptId: string,
    readonly requestId: string,
    readonly operationError: unknown
  ) {
    super(errorMessage(operationError), { cause: operationError })
  }
}

export class ModelAttemptSettlementError extends Error {
  readonly name = 'ModelAttemptSettlementError'

  constructor(readonly attemptId: string) {
    super(`ModelAttempt ${attemptId} settlement has already been attempted`)
  }
}

const DEFAULT_DEPENDENCIES: RuntimeModelAttemptDependencies = {
  start: startPersistedModelAttempt,
  complete: completePersistedModelAttempt,
  getRetryAuthorization: getPersistedModelAttemptRetryAuthorization,
  now: Date.now,
  randomId: randomUUID
}

export async function executePersistedModelAttempt<T>(
  input: RuntimeModelAttemptInput,
  operation: () => Promise<T>,
  options: RuntimeModelAttemptOptions<T> = {}
): Promise<T> {
  const handle = await beginPersistedModelAttempt(input, { dependencies: options.dependencies })

  let value: T
  try {
    value = await operation()
  } catch (error) {
    const failure = options.failure?.(error) ?? classifyRuntimeModelFailure(error)
    await handle.fail(failure, error)
    throw new ModelAttemptOperationError(handle.attempt.id, handle.attempt.requestId, error)
  }

  await handle.succeed(options.success?.(value))
  return value
}

export async function beginPersistedModelAttempt(
  input: RuntimeModelAttemptInput,
  options: RuntimeModelAttemptBeginOptions = {}
): Promise<PersistedModelAttemptHandle> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies }
  const effectiveInput = await resolveRetryAuthorizedInput(input, dependencies)
  const attemptId = effectiveInput.id ?? dependencies.randomId()
  const startedAt = effectiveInput.startedAt ?? dependencies.now()
  try { reserveModelAttemptBudget({ ...effectiveInput, id: attemptId }) }
  catch (error) { if (isModelRouteError(error)) throw error; throw new ModelAttemptPersistenceError('start', false, attemptId, error) }
  let attempt: ModelAttemptRecord
  try { attempt = await persistRuntimeStart(effectiveInput, attemptId, startedAt, dependencies) }
  catch (error) { releaseUnsentModelBudget(attemptId, effectiveInput.budgetScope); throw error }
  let settlementStarted = false

  const settle = async (
    completion: Omit<ModelAttemptCompleteInput, 'commandId' | 'expectedRevision' | 'completedAt'>,
    cause?: unknown
  ): Promise<ModelAttemptRecord> => {
    if (settlementStarted) throw new ModelAttemptSettlementError(attempt.id)
    settlementStarted = true
    const completed = await persistRuntimeCompletion(
      attempt,
      completion,
      effectiveInput.rootDir,
      dependencies,
      cause
    )
    try { settleModelAttemptBudget(attemptId, effectiveInput.budgetScope, completion) }
    catch (error) { throw new ModelAttemptPersistenceError('complete', true, attemptId, error) }
    return completed
  }

  return {
    attempt,
    succeed: (success = {}) => settle({
      status: 'succeeded',
      outcome: 'success',
      usage: success.usage,
      costUsd: success.costUsd
    }),
    fail: (failure, cause) => settle(failureCompletion(failure), cause),
    cancel: (cause) => settle({ status: 'cancelled', outcome: 'cancelled' }, cause)
  }
}

async function resolveRetryAuthorizedInput(
  input: RuntimeModelAttemptInput,
  dependencies: RuntimeModelAttemptDependencies
): Promise<RuntimeModelAttemptInput> {
  if (input.failoverFromAttemptId !== undefined) return input
  try {
    const authorization = await dependencies.getRetryAuthorization(
      { runId: input.runId, stepId: input.stepId },
      input.rootDir
    )
    if (!authorization) return input
    return {
      ...input,
      requestId: authorization.attempt.requestId,
      stepId: authorization.attempt.stepId,
      failoverFromAttemptId: authorization.attempt.id
    }
  } catch (error) {
    throw new ModelAttemptPersistenceError(
      'start',
      false,
      undefined,
      new Error(`retry authorization lookup failed: ${errorMessage(error)}`, { cause: error })
    )
  }
}

export function stableModelContextDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableSerialize(value)).digest('hex')}`
}

export function stableModelKeyLabel(identity: RuntimeModelKeyIdentity | undefined): string | undefined {
  if (!identity) return undefined
  const material = identity.keyId?.trim() || identity.keyLabel?.trim() || identity.token
  if (!material) return undefined
  return stableModelContextDigest({ providerId: identity.providerId, material })
}

export function modelAttemptUsage(input: {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
} | undefined): ModelAttemptUsage | undefined {
  if (!input) return undefined
  const cacheReadTokens = optionalTokenCount(input.cacheRead)
  const cacheWriteTokens = optionalTokenCount(input.cacheWrite)
  const usage = {
    inputTokens: tokenCount(input.input),
    outputTokens: tokenCount(input.output),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens })
  }
  if (Object.values(usage).every((value) => value === 0)) return undefined
  return usage
}

export function classifyRuntimeModelFailure(
  error: unknown,
  context: { aborted?: boolean; timedOut?: boolean } = {}
): RuntimeModelAttemptFailure {
  if (context.timedOut) return { status: 'failed', outcome: 'timeout', errorClass: 'provider_timeout' }
  if (context.aborted || errorName(error) === 'AbortError') {
    return { status: 'cancelled', outcome: 'cancelled' }
  }
  const refusal = nativeHttpRefusalEvidence(error)
  if (refusal) return { status: 'failed', outcome: refusal.outcome,
    errorClass: refusal.outcome === 'auth_failed' ? 'provider_auth' : 'provider_rate_limit' }
  const message = errorMessage(error)
  if (/\b(?:401|403)\b|auth(?:entication|orization)?|unauthori[sz]ed|forbidden/i.test(message)) {
    return { status: 'failed', outcome: 'auth_failed', errorClass: 'provider_auth' }
  }
  if (/\b429\b|rate.?limit|too many requests|quota/i.test(message)) {
    return { status: 'failed', outcome: 'rate_limited', errorClass: 'provider_rate_limit' }
  }
  if (/\b5\d\d\b|fetch failed|econn|socket|network|unavailable/i.test(message)) {
    return { status: 'failed', outcome: 'unavailable', errorClass: 'provider_unavailable' }
  }
  return { status: 'failed', outcome: 'error', errorClass: 'provider_error' }
}

export function isModelAttemptPersistenceError(error: unknown): error is ModelAttemptPersistenceError {
  return error instanceof ModelAttemptPersistenceError
}

export function isModelAttemptOperationError(error: unknown): error is ModelAttemptOperationError {
  return error instanceof ModelAttemptOperationError
}

export function unwrapModelAttemptOperationError(error: unknown): unknown {
  return isModelAttemptOperationError(error) ? error.operationError : error
}

async function persistRuntimeStart(
  input: RuntimeModelAttemptInput,
  attemptId: string,
  startedAt: number,
  dependencies: RuntimeModelAttemptDependencies
): Promise<ModelAttemptRecord> {
  try {
    return await dependencies.start({
      id: attemptId,
      commandId: `model-attempt:${attemptId}:start`,
      requestId: input.requestId,
      stepId: input.stepId,
      runId: input.runId,
      providerId: input.providerId,
      model: input.model,
      protocol: input.protocol,
      adapterVersion: input.adapterVersion,
      contextDigest: input.contextDigest ?? stableModelContextDigest(input.context),
      routeReason: input.routeReason,
      keyLabel: stableModelKeyLabel(input.keyIdentity),
      failoverFromAttemptId: input.failoverFromAttemptId,
      startedAt
    }, input.rootDir)
  } catch (error) {
    throw new ModelAttemptPersistenceError('start', false, attemptId, error)
  }
}

async function persistRuntimeCompletion(
  attempt: ModelAttemptRecord,
  input: Omit<ModelAttemptCompleteInput, 'commandId' | 'expectedRevision' | 'completedAt'>,
  rootDir: string | undefined,
  dependencies: RuntimeModelAttemptDependencies,
  operationError?: unknown
): Promise<ModelAttemptRecord> {
  try {
    return await dependencies.complete(attempt.id, {
      ...input,
      commandId: `model-attempt:${attempt.id}:complete`,
      expectedRevision: attempt.revision,
      completedAt: Math.max(dependencies.now(), attempt.startedAt)
    }, rootDir)
  } catch (error) {
    const detail = operationError !== undefined
      ? new Error(`provider operation failed (${errorMessage(operationError)}); ${errorMessage(error)}`)
      : error
    throw new ModelAttemptPersistenceError('complete', true, attempt.id, detail)
  }
}

function failureCompletion(failure: RuntimeModelAttemptFailure): Pick<
  ModelAttemptCompleteInput,
  'status' | 'outcome' | 'errorClass' | 'usage' | 'costUsd'
> {
  return failure.status === 'cancelled'
    ? {
        status: 'cancelled',
        outcome: 'cancelled',
        usage: failure.usage,
        costUsd: failure.costUsd
      }
    : {
        status: 'failed',
        outcome: failure.outcome,
        errorClass: failure.errorClass ?? 'provider_error',
        usage: failure.usage,
        costUsd: failure.costUsd
      }
}

function tokenCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function optionalTokenCount(value: number | undefined): number | undefined {
  return value === undefined ? undefined : tokenCount(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : ''
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? 'undefined'
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)])
  )
}
