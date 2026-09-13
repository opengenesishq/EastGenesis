import { resolve } from 'node:path'
import { AssignmentOwnerCoordinator } from './coordinator'
import { AssignmentOwnerCoordinatorError } from './errors'
import type { AssignmentOwnerRecoveryResult } from '../../shared/digital-worker-types'

interface AssignmentOwnerReadinessState {
  promise: Promise<AssignmentOwnerCoordinator>
}

type AssignmentOwnerAccessMode = 'read' | 'write'

interface AssignmentOwnerAccessWaiter {
  mode: AssignmentOwnerAccessMode
  resolve: (release: () => void) => void
}

interface AssignmentOwnerAccessState {
  activeReaders: number
  writerActive: boolean
  queue: AssignmentOwnerAccessWaiter[]
}

const readinessByRoot = new Map<string, AssignmentOwnerReadinessState>()
const accessByRoot = new Map<string, AssignmentOwnerAccessState>()

export function startAssignmentOwnerReadiness(rootDir: string): Promise<AssignmentOwnerCoordinator> {
  const root = resolve(rootDir)
  const existing = readinessByRoot.get(root)
  if (existing) return existing.promise
  const promise = recoverAssignmentOwners(root).then((result) => result.coordinator)
  readinessByRoot.set(root, { promise })
  void promise.catch(() => undefined)
  return promise
}

export async function retryAssignmentOwnerReadiness(rootDir: string): Promise<AssignmentOwnerRecoveryResult[]> {
  const root = resolve(rootDir)
  return withAssignmentOwnerAccess(root, 'write', async () => {
    const attempt = recoverAssignmentOwners(root)
    const promise = attempt.then((result) => result.coordinator)
    readinessByRoot.set(root, { promise })
    void promise.catch(() => undefined)
    return (await attempt).outcomes
  }, false)
}

export function awaitAssignmentOwnerReadiness(rootDir: string): Promise<AssignmentOwnerCoordinator> {
  return startAssignmentOwnerReadiness(rootDir)
}

export async function withAssignmentOwnerReadiness<T>(
  rootDir: string,
  operation: () => Promise<T> | T
): Promise<T> {
  return withAssignmentOwnerWriteAccess(rootDir, operation)
}

export function withAssignmentOwnerReadAccess<T>(
  rootDir: string,
  operation: () => Promise<T> | T
): Promise<T> {
  return withAssignmentOwnerAccess(rootDir, 'read', operation)
}

export function withAssignmentOwnerWriteAccess<T>(
  rootDir: string,
  operation: () => Promise<T> | T
): Promise<T> {
  return withAssignmentOwnerAccess(rootDir, 'write', operation)
}

async function withAssignmentOwnerAccess<T>(
  rootDir: string,
  mode: AssignmentOwnerAccessMode,
  operation: () => Promise<T> | T,
  requireReadiness = true
): Promise<T> {
  const root = resolve(rootDir)
  const release = await acquireAssignmentOwnerAccess(root, mode)
  try {
    if (requireReadiness) await awaitAssignmentOwnerReadiness(root)
    return await operation()
  } finally {
    release()
  }
}

function acquireAssignmentOwnerAccess(root: string, mode: AssignmentOwnerAccessMode): Promise<() => void> {
  const state = accessByRoot.get(root) ?? { activeReaders: 0, writerActive: false, queue: [] }
  accessByRoot.set(root, state)
  if (mode === 'read' && !state.writerActive && state.queue.length === 0) {
    state.activeReaders += 1
    return Promise.resolve(createAccessRelease(root, state, mode))
  }
  if (mode === 'write' && !state.writerActive && state.activeReaders === 0 && state.queue.length === 0) {
    state.writerActive = true
    return Promise.resolve(createAccessRelease(root, state, mode))
  }
  return new Promise((resolveWaiter) => {
    state.queue.push({ mode, resolve: resolveWaiter })
  })
}

function createAccessRelease(
  root: string,
  state: AssignmentOwnerAccessState,
  mode: AssignmentOwnerAccessMode
): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    if (mode === 'read') state.activeReaders -= 1
    else state.writerActive = false
    drainAssignmentOwnerAccess(root, state)
  }
}

function drainAssignmentOwnerAccess(root: string, state: AssignmentOwnerAccessState): void {
  if (state.writerActive || state.activeReaders > 0) return
  const first = state.queue.shift()
  if (!first) {
    if (accessByRoot.get(root) === state) accessByRoot.delete(root)
    return
  }
  if (first.mode === 'write') {
    state.writerActive = true
    first.resolve(createAccessRelease(root, state, 'write'))
    return
  }
  const readers = [first]
  while (state.queue[0]?.mode === 'read') readers.push(state.queue.shift()!)
  state.activeReaders += readers.length
  for (const reader of readers) reader.resolve(createAccessRelease(root, state, 'read'))
}

export function failAssignmentOwnerReadiness(rootDir: string, cause: unknown): void {
  const root = resolve(rootDir)
  const error = cause instanceof AssignmentOwnerCoordinatorError
    ? cause
    : new AssignmentOwnerCoordinatorError(
      'RECOVERY_PENDING',
      `Assignment owner coordination is unavailable: ${errorText(cause)}`
    )
  const promise = Promise.reject<AssignmentOwnerCoordinator>(error)
  readinessByRoot.set(root, { promise })
  void promise.catch(() => undefined)
}

async function recoverAssignmentOwners(rootDir: string): Promise<{
  coordinator: AssignmentOwnerCoordinator
  outcomes: AssignmentOwnerRecoveryResult[]
}> {
  const coordinator = await new AssignmentOwnerCoordinator({ rootDir }).initialize()
  const outcomes = await coordinator.recoverPending()
  const unresolved = outcomes.filter((outcome) => !outcome.recovered)
  if (unresolved.length > 0) {
    throw new AssignmentOwnerCoordinatorError(
      'RECOVERY_PENDING',
      `${unresolved.length} Assignment owner operation(s) remain unresolved`,
      { requestIds: unresolved.map((outcome) => outcome.requestId) }
    )
  }
  return { coordinator, outcomes }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
