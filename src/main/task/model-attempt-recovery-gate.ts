import type {
  ModelAttemptReconciliationResolution,
  ModelAttemptReconciliationView
} from '../../shared/model-attempt-types'
import type { AgentEvent, TaskRunRecord, TaskSnapshotRecord } from '../../shared/types'
import { runHasUnresolvedEffects } from './effect-runtime'
import {
  getPersistedModelAttemptReconciliation,
  listPersistedModelAttemptReconciliations,
  listPersistedModelAttemptRetryAuthorizations
} from './model-attempt-api'
import {
  assertNoStartedModelAttemptReconciliation,
  hasPersistedModelAttemptRecoveryBarrier,
  reconcilePersistedModelAttemptRecoveryState,
  resolveTaskSnapshotModelAttemptReconciliation,
  type PersistedModelAttemptRecoveryState,
  type ResolvedModelAttemptRecoveryState
} from './task-snapshot-recovery-lifecycle'

export interface ModelAttemptSendDecision {
  allowed: boolean
  consumeReplay: boolean
  error?: string
}

export class ModelAttemptRecoveryGate {
  private readonly reconciliationCounts = new Map<string, number>()
  private readonly retryAuthorizationCounts = new Map<string, number>()
  private readonly replayAllowances = new Map<string, number>()
  private rootDir: string | undefined

  async refreshBeforeSend(_sessionId: string): Promise<void> {
    if (!this.rootDir) return
    const state = await this.readState({}, this.rootDir)
    this.replaceAll(state.reconciliations, state.retryAuthorizations)
  }

  async initialize(rootDir: string): Promise<PersistedModelAttemptRecoveryState> {
    this.rootDir = rootDir
    const state = await reconcilePersistedModelAttemptRecoveryState(rootDir)
    this.replaceAll(state.reconciliations, state.retryAuthorizations)
    return state
  }

  async list(): Promise<ModelAttemptReconciliationView[]> {
    const state = await this.readState({}, this.rootDir)
    this.replaceAll(state.reconciliations, state.retryAuthorizations)
    return state.reconciliations
  }

  async resolve(
    attemptId: string,
    expectedRevision: number,
    resolution: ModelAttemptReconciliationResolution,
    rootDir: string,
    isSessionActive: (sessionId: string) => boolean
  ): Promise<ResolvedModelAttemptRecoveryState> {
    this.rootDir = rootDir
    const pending = await getPersistedModelAttemptReconciliation(attemptId, rootDir)
    if (pending && isSessionActive(pending.sessionId)) {
      throw new Error('ModelAttempt 所属会话仍在运行，不能使用崩溃恢复处置；请先中断当前会话。')
    }
    const resolved = await resolveTaskSnapshotModelAttemptReconciliation(
      attemptId,
      expectedRevision,
      resolution,
      rootDir
    )
    this.replaceSession(
      resolved.view.sessionId,
      resolved.reconciliations,
      resolved.retryAuthorizations
    )
    return resolved
  }

  decideSend(
    sessionId: string,
    run: TaskRunRecord | undefined,
    recoveryReplay: boolean
  ): ModelAttemptSendDecision {
    const started = this.reconciliationCounts.get(sessionId) ?? 0
    const retryAuthorized = this.retryAuthorizationCounts.get(sessionId) ?? 0
    const replayAllowances = this.replayAllowances.get(sessionId) ?? 0
    const consumeReplay = recoveryReplay && started === 0 && retryAuthorized > 0 && replayAllowances > 0
    const waiting = started > 0 || retryAuthorized > 0 ||
      (run?.status === 'waiting_reconciliation' && !runHasUnresolvedEffects(run))
    return waiting && !consumeReplay
      ? {
          allowed: false,
          consumeReplay: false,
          error: '当前任务存在 Provider 结果未知或已授权待恢复的 ModelAttempt，已阻止普通发送；请从恢复入口继续。'
        }
      : { allowed: true, consumeReplay }
  }

  acceptedSend(sessionId: string, decision: ModelAttemptSendDecision): void {
    if (!decision.consumeReplay) return
    const remaining = (this.replayAllowances.get(sessionId) ?? 0) - 1
    if (remaining > 0) this.replayAllowances.set(sessionId, remaining)
    else this.replayAllowances.delete(sessionId)
  }

  async prepareRecovery(snapshot: TaskSnapshotRecord, rootDir: string): Promise<void> {
    this.rootDir = rootDir
    await assertNoStartedModelAttemptReconciliation(snapshot, rootDir)
    const retryAuthorizations = await listPersistedModelAttemptRetryAuthorizations({
      sessionId: snapshot.sessionId,
      ...(snapshot.run?.id ? { runId: snapshot.run.id } : {})
    }, rootDir)
    this.replaceSession(snapshot.sessionId, [], retryAuthorizations)
    if (retryAuthorizations.length > 0) {
      this.replayAllowances.set(snapshot.sessionId, retryAuthorizations.length)
    } else {
      this.replayAllowances.delete(snapshot.sessionId)
    }
  }

  async assertSnapshotDeletable(snapshot: TaskSnapshotRecord, rootDir: string): Promise<void> {
    if (await hasPersistedModelAttemptRecoveryBarrier(snapshot, rootDir)) {
      throw new Error('ModelAttempt 对账或授权重试尚未收敛，不能删除恢复入口。')
    }
  }

  blockActiveSessions(target: Set<string>): void {
    for (const sessionId of this.blockedSessionIds()) target.add(sessionId)
  }

  recoverableSessionCount(snapshotSessionIds: Iterable<string>): number {
    const ids = new Set(snapshotSessionIds)
    for (const sessionId of this.blockedSessionIds()) ids.add(sessionId)
    return ids.size
  }

  refreshAfterEvent(sessionId: string, event: AgentEvent): Promise<boolean> {
    if (event.kind !== 'status' && event.kind !== 'routing' && event.kind !== 'failover' &&
        event.kind !== 'turn-result') return Promise.resolve(true)
    return this.refresh(sessionId).then(() => true).catch((error) => {
      console.error('[caogen] refresh ModelAttempt recovery gate failed:', error)
      return false
    })
  }

  async shouldPreserveAfterRefresh(sessionId: string, context: string): Promise<boolean> {
    try {
      await this.refresh(sessionId)
      return this.hasBarrier(sessionId)
    } catch (error) {
      console.error(`[caogen] ${context} ModelAttempt recovery probe failed:`, error)
      return true
    }
  }

  clearReplayAllowance(sessionId: string): void {
    this.replayAllowances.delete(sessionId)
  }

  clearSession(sessionId: string): void {
    this.reconciliationCounts.delete(sessionId)
    this.retryAuthorizationCounts.delete(sessionId)
    this.replayAllowances.delete(sessionId)
  }

  clear(): void {
    this.reconciliationCounts.clear()
    this.retryAuthorizationCounts.clear()
    this.replayAllowances.clear()
  }

  private async refresh(sessionId: string): Promise<void> {
    const state = await this.readState({ sessionId }, this.rootDir)
    this.replaceSession(sessionId, state.reconciliations, state.retryAuthorizations)
  }

  private async readState(
    query: { sessionId?: string } = {},
    rootDir?: string
  ): Promise<PersistedModelAttemptRecoveryState> {
    const [reconciliations, retryAuthorizations] = await Promise.all([
      listPersistedModelAttemptReconciliations(query, rootDir),
      listPersistedModelAttemptRetryAuthorizations(query, rootDir)
    ])
    return { reconciliations, retryAuthorizations }
  }

  private replaceAll(
    reconciliations: ModelAttemptReconciliationView[],
    retryAuthorizations: ModelAttemptReconciliationView[]
  ): void {
    this.reconciliationCounts.clear()
    this.retryAuthorizationCounts.clear()
    for (const view of reconciliations) increment(this.reconciliationCounts, view.sessionId)
    for (const view of retryAuthorizations) increment(this.retryAuthorizationCounts, view.sessionId)
  }

  private replaceSession(
    sessionId: string,
    reconciliations: ModelAttemptReconciliationView[],
    retryAuthorizations: ModelAttemptReconciliationView[]
  ): void {
    this.reconciliationCounts.delete(sessionId)
    this.retryAuthorizationCounts.delete(sessionId)
    for (const view of reconciliations) {
      if (view.sessionId === sessionId) increment(this.reconciliationCounts, sessionId)
    }
    for (const view of retryAuthorizations) {
      if (view.sessionId === sessionId) increment(this.retryAuthorizationCounts, sessionId)
    }
  }

  private blockedSessionIds(): Set<string> {
    return new Set([...this.reconciliationCounts.keys(), ...this.retryAuthorizationCounts.keys()])
  }

  private hasBarrier(sessionId: string): boolean {
    return (this.reconciliationCounts.get(sessionId) ?? 0) > 0 ||
      (this.retryAuthorizationCounts.get(sessionId) ?? 0) > 0
  }
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}
