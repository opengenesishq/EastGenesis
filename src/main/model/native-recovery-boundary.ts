import { nativeTurnRejection } from './native-turn-rejection'
import { isModelAttemptPersistenceError, unwrapModelAttemptOperationError } from '../task/model-attempt-runtime'

type RecoveryFailure = { message: string; subtype: 'policy-denied' | 'outbound-policy-denied' | 'routing-blocked' | 'ledger-error' | 'error' }

/** Covers the whole asynchronous recovery ladder, including policy changes after an await. */
export async function withNativeRecoveryBoundary(operation: () => Promise<void>, finish: (failure: RecoveryFailure) => void): Promise<void> {
  try { await operation() }
  catch (error) { finish(recoveryFailure(error)) }
}

function recoveryFailure(error: unknown): RecoveryFailure {
  const rejection = nativeTurnRejection(error)
  if (rejection) return rejection
  if (isModelAttemptPersistenceError(error)) {
    const phase = error.phase === 'start' ? '启动' : '完成'
    return { message: `模型请求账本${phase}落盘失败，已阻止请求重放:${error.message}`, subtype: 'ledger-error' }
  }
  const original = unwrapModelAttemptOperationError(error)
  return { message: original instanceof Error ? original.message : String(original), subtype: 'error' }
}
