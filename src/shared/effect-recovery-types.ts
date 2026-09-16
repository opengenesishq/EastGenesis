import type { EffectRecord } from './effect-types'

export type EffectResolution = 'confirmed_applied' | 'confirmed_not_applied' | 'abandoned_by_user'

export interface EffectResolutionReceipt {
  resolution: EffectResolution
  expectedRevision: number
  targetDigest: string
  inputDigest: string
  note?: string
}

/** Read-only projection of one persisted Run's existing Effect ledger. */
export interface TaskEffectRecoveryView {
  sessionId: string
  runId?: string
  taskId?: string
  snapshots: Array<{
    snapshotId: string
    runId: string
    taskId: string
    effects: EffectRecord[]
    canResolve: boolean
    unavailableReason?: 'active_execution'
  }>
}

export interface TaskEffectRecoveryApi {
  getTaskEffectRecovery(sessionId: string, runId?: string, taskId?: string): Promise<TaskEffectRecoveryView>
  recheckTaskEffect(snapshotId: string, effectId: string, expectedRevision: number): Promise<import('./types').TaskSnapshotRecord>
}
