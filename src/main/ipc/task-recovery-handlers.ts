import { ipcMain } from 'electron'
import type { ModelAttemptReconciliationResolution } from '../../shared/model-attempt-types'
import type { TaskDagFinalizationResolution } from '../../shared/types'
import { sessionManager } from '../sessionManager'

const TASK_DAG_FINALIZATION_RESOLUTIONS = new Set<TaskDagFinalizationResolution>([
  'verification_passed',
  'verification_failed',
  'verification_not_started',
  'summary_not_delivered',
  'finalization_abandoned'
])
const MODEL_ATTEMPT_RECONCILIATION_RESOLUTIONS = new Set<ModelAttemptReconciliationResolution>([
  'retry_authorized',
  'cancelled_by_user'
])

export function registerTaskRecoveryIpc(): void {
  ipcMain.handle('modelAttempts:listReconciliations', () =>
    sessionManager.listModelAttemptReconciliations())
  ipcMain.handle(
    'modelAttempts:resolveReconciliation',
    (_event, attemptId: unknown, expectedRevision: unknown, resolution: unknown) => {
      if (typeof attemptId !== 'string' || !attemptId.trim()) throw new Error('必须指定 ModelAttempt ID')
      if (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 1) {
        throw new Error('ModelAttempt revision 无效')
      }
      if (!isModelAttemptReconciliationResolution(resolution)) {
        throw new Error('ModelAttempt 对账处置类型无效')
      }
      return sessionManager.resolveModelAttemptReconciliation(
        attemptId,
        expectedRevision as number,
        resolution
      )
    }
  )
  ipcMain.handle('taskSnapshots:list', () => sessionManager.listTaskSnapshots())
  ipcMain.handle('taskSnapshots:effectRecovery', (_event, sessionId: unknown, runId: unknown, taskId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('必须指定会话 ID')
    if (runId !== undefined && (typeof runId !== 'string' || !runId.trim())) throw new Error('运行 ID 无效')
    if (taskId !== undefined && (typeof taskId !== 'string' || !taskId.trim())) throw new Error('任务 ID 无效')
    return sessionManager.getTaskEffectRecovery(sessionId, runId, taskId)
  })
  ipcMain.handle('taskSnapshots:recheckEffect', (_event, snapshotId: unknown, effectId: unknown, expectedRevision: unknown) => {
    if (typeof snapshotId !== 'string' || !snapshotId.trim() || typeof effectId !== 'string' || !effectId.trim() ||
      !Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) throw new Error('核对必须绑定具体操作与版本')
    return sessionManager.recheckTaskEffect(snapshotId, effectId, expectedRevision as number)
  })
  ipcMain.handle('taskSnapshots:recover', (_event, snapshotId: unknown) => {
    if (typeof snapshotId !== 'string' || !snapshotId.trim()) throw new Error('必须指定任务快照 ID')
    return sessionManager.recoverTaskSnapshot(snapshotId)
  })
  ipcMain.handle(
    'taskSnapshots:resolveDagFinalization',
    (_event, executionId: unknown, expectedRevision: unknown, resolution: unknown) => {
      if (typeof executionId !== 'string' || !executionId.trim()) {
        throw new Error('必须指定 DAG execution ID')
      }
      if (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 1) {
        throw new Error('DAG finalizer revision 无效')
      }
      if (!isTaskDagFinalizationResolution(resolution)) {
        throw new Error('DAG finalizer 处置类型无效')
      }
      return sessionManager.resolveTaskDagFinalization(executionId, expectedRevision as number, resolution)
    }
  )
  ipcMain.handle('taskSnapshots:delete', (_event, snapshotId: unknown) => {
    if (typeof snapshotId !== 'string' || !snapshotId.trim()) return false
    return sessionManager.deleteTaskSnapshot(snapshotId)
  })
}

function isTaskDagFinalizationResolution(value: unknown): value is TaskDagFinalizationResolution {
  return typeof value === 'string' && TASK_DAG_FINALIZATION_RESOLUTIONS.has(value as TaskDagFinalizationResolution)
}

function isModelAttemptReconciliationResolution(
  value: unknown
): value is ModelAttemptReconciliationResolution {
  return typeof value === 'string' &&
    MODEL_ATTEMPT_RECONCILIATION_RESOLUTIONS.has(value as ModelAttemptReconciliationResolution)
}
