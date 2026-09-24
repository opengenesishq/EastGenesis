import type { TaskSnapshotRecord } from '../../shared/types'
import {
  reconcileExistingPersistedTaskSnapshot,
  reconcilePersistedTaskSnapshot
} from '../task/effect-runtime'
import {
  isInteractiveOperationActive,
  isInteractiveOperationSnapshot,
  settleStoppedInteractiveOperationSnapshot
} from '../task/operation-effect-gateway'

export function assertAgentRecoverySnapshot(snapshot: TaskSnapshotRecord): void {
  if (isInteractiveOperationSnapshot(snapshot)) {
    throw new Error('交互操作快照只能进行效果对账，不能启动 Agent 自动续跑')
  }
}

export async function reconcileInteractiveOperationSnapshot(
  snapshot: TaskSnapshotRecord,
  options: { requireStored?: boolean; rootDir?: string } = {}
): Promise<TaskSnapshotRecord | null> {
  if (isInteractiveOperationActive(snapshot)) return null
  const reconciled = options.requireStored
    ? await reconcileExistingPersistedTaskSnapshot(snapshot, options.rootDir)
    : await reconcilePersistedTaskSnapshot(snapshot, options.rootDir)
  return reconciled ? settleStoppedInteractiveOperationSnapshot(reconciled, options.rootDir) : null
}
