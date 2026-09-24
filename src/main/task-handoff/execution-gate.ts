import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'
import type { TaskHandoffIdentity, TaskHandoffReleaseProof, TaskHostExecutionClaim, TaskHostExecutionSubject } from '../../shared/task-handoff-types'
import { TaskHostOwnershipStore } from './ownership-store'

interface PermitContext { gate: TaskHostExecutionGate; claim: TaskHostExecutionClaim; active: boolean; control?: string }
const context = new AsyncLocalStorage<PermitContext>()
const gates = new Map<string, TaskHostExecutionGate>()
export interface TaskHostExecutionPermit { claim: TaskHostExecutionClaim; run<T>(action: () => T): T; release(): void }
export function taskHostSubject(meta: { id: string; createdAt: number }): TaskHandoffIdentity { return { sessionId: meta.id, sessionCreatedAt: meta.createdAt } }
export function getTaskHostExecutionGate(rootDir: string): TaskHostExecutionGate {
  const root = resolve(rootDir)
  let gate = gates.get(root)
  if (!gate) { gate = new TaskHostExecutionGate(root); gates.set(root, gate) }
  return gate
}
export function currentTaskHostExecutionContext(): { rootDir: string; claim: TaskHostExecutionClaim; control?: string } | undefined {
  const current = context.getStore()
  return current ? { rootDir: current.gate.rootDir, claim: { ...current.claim }, ...(current.control ? { control: current.control } : {}) } : undefined
}

/** The Electron single-instance owner is required; permits span the complete physical action promise. */
export class TaskHostExecutionGate {
  readonly store: TaskHostOwnershipStore
  private readonly active = new Map<string, number>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly drained = new Map<string, string>()
  constructor(readonly rootDir: string) { this.store = new TaskHostOwnershipStore(rootDir) }
  status(sessionId: string) { return this.store.status(sessionId) }
  claim(subject: TaskHostExecutionSubject): TaskHostExecutionClaim {
    const inherited = context.getStore()
    if (inherited?.gate === this && inherited.claim.sessionId === subject.sessionId) {
      if (subject.sessionCreatedAt !== undefined && inherited.claim.sessionCreatedAt !== undefined && inherited.claim.sessionCreatedAt !== subject.sessionCreatedAt) throw new Error('TASK_HANDOFF_SESSION_IDENTITY_CONFLICT')
      this.assert(subject, inherited.claim)
      return { ...inherited.claim }
    }
    const record = this.store.status(subject.sessionId)
    const claim = { ...subject, ...(record ? { sessionCreatedAt: record.identity.sessionCreatedAt } : {}), generation: record?.generation ?? 0 }
    this.assert(subject, claim)
    return claim
  }
  assert(subject: TaskHostExecutionSubject, expected?: TaskHostExecutionClaim): void {
    const current = context.getStore()
    if (current?.control) throw new Error('TASK_HANDOFF_CONTROL_CANNOT_EXECUTE_TASK')
    const record = this.store.status(subject.sessionId)
    if (record && subject.sessionCreatedAt !== undefined && record.identity.sessionCreatedAt !== subject.sessionCreatedAt) throw new Error('TASK_HANDOFF_SESSION_IDENTITY_CONFLICT')
    const claim = expected ?? (current?.gate === this && current.claim.sessionId === subject.sessionId ? current.claim : undefined)
    if (claim && (claim.sessionId !== subject.sessionId || (claim.sessionCreatedAt !== undefined && record && claim.sessionCreatedAt !== record.identity.sessionCreatedAt) || claim.generation !== (record?.generation ?? 0))) throw new Error('TASK_HOST_GENERATION_CHANGED: 旧执行许可已失效。')
    if (!record) return // Existing, never-migrated tasks retain normal local execution.
    const host = this.store.hostIdentity().hostId
    const continuing = current?.gate === this && current.active && current.claim.sessionId === subject.sessionId && current.claim.generation === record.generation
    if (record.ownerHostId !== host || (record.state !== 'owned' && !(record.state === 'preparing' && !record.incoming && continuing))) throw new Error('TASK_HOST_NOT_OWNER: 任务正在交接或已移交，当前主机不能执行。')
  }
  acquire(subject: TaskHostExecutionSubject, expected?: TaskHostExecutionClaim): TaskHostExecutionPermit {
    const claim = expected ?? this.claim(subject)
    this.assert(subject, claim)
    const permit: PermitContext = { gate: this, claim: { ...claim }, active: true }
    this.active.set(subject.sessionId, (this.active.get(subject.sessionId) ?? 0) + 1)
    return {
      claim: { ...claim },
      run: action => {
        if (!permit.active) throw new Error('TASK_HOST_PERMIT_EXPIRED')
        return context.run(permit, action)
      },
      release: () => {
        if (!permit.active) return
        permit.active = false
        const count = (this.active.get(subject.sessionId) ?? 1) - 1
        if (count) this.active.set(subject.sessionId, count)
        else { this.active.delete(subject.sessionId); for (const notify of this.waiters.get(subject.sessionId) ?? []) notify(); this.waiters.delete(subject.sessionId) }
      }
    }
  }
  async withPermit<T>(subject: TaskHostExecutionSubject, action: () => T | Promise<T>, expected?: TaskHostExecutionClaim): Promise<T> {
    const permit = this.acquire(subject, expected)
    try { return await permit.run(action) } finally { permit.release() }
  }
  withPermitSync<T>(subject: TaskHostExecutionSubject, action: () => T, expected?: TaskHostExecutionClaim): T {
    const permit = this.acquire(subject, expected)
    try { return permit.run(action) } finally { permit.release() }
  }
  async freeze(identity: TaskHandoffIdentity, handoffId: string, stopAndReconcile?: () => Promise<void>): Promise<void> {
    if (context.getStore()?.active && context.getStore()?.claim.sessionId === identity.sessionId) throw new Error('TASK_HANDOFF_FREEZE_INSIDE_EXECUTION')
    this.store.prepare(identity, handoffId)
    this.drained.delete(identity.sessionId)
    await stopAndReconcile?.()
    if (this.active.has(identity.sessionId)) await new Promise<void>(resolveWait => {
      const waits = this.waiters.get(identity.sessionId) ?? new Set<() => void>()
      waits.add(resolveWait); this.waiters.set(identity.sessionId, waits)
    })
    const current = this.store.status(identity.sessionId)
    if (current?.state !== 'preparing' || current.incoming || current.handoffId !== handoffId) throw new Error('TASK_HANDOFF_FREEZE_CHANGED')
    this.drained.set(identity.sessionId, handoffId)
  }
  cancelBeforeRelease(identity: TaskHandoffIdentity, handoffId: string) {
    if (this.active.has(identity.sessionId)) throw new Error('TASK_HANDOFF_EXECUTION_STILL_ACTIVE')
    const result = this.store.cancelBeforeRelease(identity, handoffId)
    this.drained.delete(identity.sessionId)
    return result
  }
  release(identity: TaskHandoffIdentity, input: { targetHostId: string; handoffId: string; bundleDigest: string }): TaskHandoffReleaseProof {
    const current = this.store.status(identity.sessionId)
    if (current?.state !== 'released' && (this.drained.get(identity.sessionId) !== input.handoffId || this.active.has(identity.sessionId))) throw new Error('TASK_HANDOFF_BARRIER_NOT_DRAINED')
    const proof = this.store.release(identity, input)
    this.drained.delete(identity.sessionId)
    return proof
  }
  stageImported(identity: TaskHandoffIdentity, sourceHostId: string, handoffId: string, fromGeneration: number) {
    if (this.active.has(identity.sessionId)) throw new Error('TASK_HANDOFF_EXECUTION_STILL_ACTIVE')
    return this.store.stageImported(identity, sourceHostId, handoffId, fromGeneration)
  }
  activateImported(proof: TaskHandoffReleaseProof, expectedSourcePublicKey: string) { return this.store.activateImported(proof, expectedSourcePublicKey) }
  assertHandoffControl(sessionId: string, handoffId: string): void {
    const current = context.getStore(), record = this.store.status(sessionId)
    if (current?.gate !== this || current.control !== handoffId || !current.active || current.claim.sessionId !== sessionId ||
        !record || record.handoffId !== handoffId || !['preparing', 'released'].includes(record.state)) throw new Error('TASK_HANDOFF_CONTROL_INVALID')
  }
  async withHandoffControl<T>(identity: TaskHandoffIdentity, handoffId: string, action: () => T | Promise<T>): Promise<T> {
    const record = this.store.status(identity.sessionId)
    if (!record || record.identity.sessionCreatedAt !== identity.sessionCreatedAt || record.handoffId !== handoffId || record.incoming ||
        !['preparing', 'released'].includes(record.state) || (record.state === 'preparing' && this.drained.get(identity.sessionId) !== handoffId) || this.active.has(identity.sessionId)) throw new Error('TASK_HANDOFF_CONTROL_INVALID')
    const permit: PermitContext = { gate: this, claim: { ...identity, generation: record.generation }, active: true, control: handoffId }
    try { return await context.run(permit, action) } finally { permit.active = false }
  }
}
