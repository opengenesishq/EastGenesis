import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { writeDurableFileSync } from '../durable-file'
import { assertRequestBudget, requestBudgetSnapshot, sameBudgetSession } from './request-budget-accounting'
import type { RequestBudgetDocument, RequestBudgetReservation, RequestBudgetScope, ReserveRequestBudgetInput } from './request-budget-types'
export type { RequestBudgetScope, ReserveRequestBudgetInput } from './request-budget-types'

/** One synchronous durable transaction before a billable request. The application
 * has one main process per userData root; no await may split this barrier. */
export function reserveRequestBudget(input: ReserveRequestBudgetInput): RequestBudgetReservation & { reused: boolean } {
  validateScope(input.scope)
  if (!input.id || !input.providerId || !money(input.estimatedUsd)) throw new Error('Invalid request budget reservation')
  const document = readBudgetDocument(input.rootDir)
  const existing = document.reservations.find((entry) => entry.id === input.id)
  if (existing) {
    assertReservationReplay(document, existing, input)
    if (existing.status === 'released') {
      assertRequestBudget(requestBudgetSnapshot(document, input.scope, input.now), input.estimatedUsd)
      existing.status = 'reserved'
      delete existing.actualUsd
      existing.updatedAt = input.now ?? Date.now()
      bindAggregateBudgets(document.sessions.find((entry) => entry.key === existing.sessionKey)!, input.scope)
      writeBudgetDocument(input.rootDir, document)
      return { ...existing, reused: false }
    }
    return { ...existing, reused: true }
  }
  const now = input.now ?? Date.now()
  let session = document.sessions.find((entry) => sameBudgetSession(entry, input.scope))
  if (!session) {
    session = { key: input.scope.sessionId, sessionIds: [input.scope.sessionId], sdkSessionId: input.scope.sdkSessionId,
      baselineTextUsd: input.scope.sessionTextCostUsd, observedTextUsd: input.scope.sessionTextCostUsd, createdAt: now }
    document.sessions.push(session)
  }
  bindAggregateBudgets(session, input.scope)
  assertRequestBudget(requestBudgetSnapshot(document, input.scope, now), input.estimatedUsd)
  session.sessionIds = [...new Set([...session.sessionIds, input.scope.sessionId])]
  session.sdkSessionId ??= input.scope.sdkSessionId
  session.observedTextUsd = Math.max(session.observedTextUsd, input.scope.sessionTextCostUsd)
  const reservation: RequestBudgetReservation = { id: input.id, kind: input.kind, sessionKey: session.key,
    providerId: input.providerId, model: input.model, estimatedUsd: input.estimatedUsd,
    status: 'reserved', createdAt: now, updatedAt: now }
  document.reservations.push(reservation)
  writeBudgetDocument(input.rootDir, document)
  return { ...reservation, reused: false }
}

export function readRequestBudgetSnapshot(rootDir: string, scope: RequestBudgetScope, now = Date.now()) {
  validateScope(scope)
  return requestBudgetSnapshot(readBudgetDocument(rootDir), scope, now)
}

/** Unknown results retain the reservation. Only a receipt or a proven
 * pre-send failure may release funds; cancellation alone is not a refund. */
export function settleRequestBudget(input: {
  rootDir: string; id: string; status: 'reserved' | 'settled' | 'unknown' | 'released'; actualUsd?: number
}): void {
  if (!money(input.actualUsd)) throw new Error('Invalid request budget settlement')
  const document = readBudgetDocument(input.rootDir)
  const entry = document.reservations.find((item) => item.id === input.id)
  if (!entry) throw new Error('Request budget reservation is missing')
  if (entry.status === 'released') {
    if (input.status === 'released') return
    throw new Error('Released request budget cannot be reused')
  }
  if (entry.status === 'settled' && (input.status === 'unknown' || input.status === 'reserved')) return
  entry.status = input.status
  if (input.actualUsd !== undefined) entry.actualUsd = input.actualUsd
  entry.updatedAt = Date.now()
  writeBudgetDocument(input.rootDir, document)
}

export function readBudgetDocument(rootDir: string): RequestBudgetDocument {
  const file = budgetFile(rootDir)
  if (!existsSync(file)) return { schemaVersion: 1, sessions: [], reservations: [] }
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.sessions) || !Array.isArray(value.reservations)) {
    throw new Error('Request budget ledger is invalid; repair it before new requests')
  }
  for (const entry of value.sessions) validateStoredSession(entry)
  for (const entry of value.reservations) validateStoredReservation(entry)
  const document = value as unknown as RequestBudgetDocument // Validated persisted schema boundary.
  if (new Set(document.reservations.map((entry) => entry.id)).size !== document.reservations.length ||
      document.reservations.some((entry) => !document.sessions.some((session) => session.key === entry.sessionKey))) {
    throw new Error('Request budget ledger identity is invalid')
  }
  return document
}

function assertReservationReplay(document: RequestBudgetDocument, existing: RequestBudgetReservation, input: ReserveRequestBudgetInput) {
  const session = document.sessions.find((entry) => entry.key === existing.sessionKey)
  if (!session || !sameBudgetSession(session, input.scope) || existing.kind !== input.kind ||
      existing.providerId !== input.providerId || existing.model !== input.model || existing.estimatedUsd !== input.estimatedUsd) {
    throw new Error('Request budget reservation identity conflict')
  }
  // Budget replay itself is never permission to send again. The caller's durable
  // ModelAttempt/MediaJob identity owns that decision.
  return existing
}

function writeBudgetDocument(rootDir: string, document: RequestBudgetDocument): void {
  writeDurableFileSync(budgetFile(rootDir), JSON.stringify(document))
}
function budgetFile(rootDir: string): string {
  if (!rootDir || !rootDir.trim()) throw new Error('Request budget root is required')
  return join(resolve(rootDir), 'request-budget-reservations.json')
}
function validateScope(scope: RequestBudgetScope): void {
  if (!optionalIds(scope.aggregateBudgetIds)) throw new Error('Invalid aggregate request budget membership')
  if (scope.aggregateBudgets !== undefined && (!Array.isArray(scope.aggregateBudgets) || scope.aggregateBudgets.some((budget) =>
    !budget.id || !Array.isArray(budget.sessionIds) || budget.sessionIds.some((id) => typeof id !== 'string' || !id) ||
    typeof budget.limitUsd !== 'number' || !Number.isFinite(budget.limitUsd) || budget.limitUsd < 0 || !Number.isFinite(budget.textSpentUsd) || budget.textSpentUsd < 0 ||
    (budget.textCostFloors !== undefined && (!Array.isArray(budget.textCostFloors) || budget.textCostFloors.some((floor) =>
      !floor.id || !Array.isArray(floor.sessionIds) || !optionalIds(floor.sessionIds) ||
      !finiteMoney(floor.observedUsd) || !finiteMoney(floor.minimumUsd))))))) {
    throw new Error('Invalid aggregate request budget scope')
  }
  if (!scope.sessionId || !finiteMoney(scope.sessionTextCostUsd) || !finiteMoney(scope.monthlyTextSpentUsd) ||
      !money(scope.sessionLimitUsd) || !money(scope.monthlyLimitUsd) || !Array.isArray(scope.observedSessions)) {
    throw new Error('Invalid trusted request budget scope')
  }
  if (scope.observedSessions.some((entry) => !entry.id || !finiteMoney(entry.costUsd))) throw new Error('Invalid observed session cost')
}
function validateStoredSession(value: unknown): void {
  if (!isRecord(value) || typeof value.key !== 'string' || !Array.isArray(value.sessionIds) ||
    value.sessionIds.some((id) => typeof id !== 'string') || !finiteMoney(value.baselineTextUsd) ||
    !finiteMoney(value.observedTextUsd) || !finiteMoney(value.createdAt) || !optionalIds(value.aggregateBudgetIds)) throw new Error('Invalid budget session record')
}
function validateStoredReservation(value: unknown): void {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.sessionKey !== 'string' ||
      typeof value.providerId !== 'string' || !['model', 'media'].includes(String(value.kind)) ||
      !['reserved', 'settled', 'unknown', 'released'].includes(String(value.status)) ||
      !money(value.estimatedUsd) || !money(value.actualUsd) || !finiteMoney(value.createdAt) || !finiteMoney(value.updatedAt)) {
    throw new Error('Invalid budget reservation record')
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function finiteMoney(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function money(value: unknown): value is number | undefined { return value === undefined || finiteMoney(value) }
function optionalIds(value: unknown): boolean { return value === undefined || (Array.isArray(value) && value.every((id) => typeof id === 'string' && id.length > 0)) }
function bindAggregateBudgets(session: RequestBudgetDocument['sessions'][number], scope: RequestBudgetScope): void {
  const ids = [...new Set([...(session.aggregateBudgetIds ?? []), ...(scope.aggregateBudgetIds ?? []), ...(scope.aggregateBudgets ?? []).map((budget) => budget.id)])]
  if (ids.length) session.aggregateBudgetIds = ids
}
