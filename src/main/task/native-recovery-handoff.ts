import type { SessionMeta, TaskRunRecord } from '../../shared/types'
import { projectAggregateCanonicalJson, projectAggregateDigest, assertNoCredentialMaterial } from '../project-aggregate/codec'
import { readTaskSnapshotDatabase } from './task-snapshot'
import { selectModelAttempts } from './model-attempt-store'
import { findWorkflowRun } from './workflow-ledger-store'
import { readAndVerifyEvents } from './workflow-ledger-query'
import { ModelContextHandoffError } from '../model/context-handoff-error'
import type { ModelAttemptRecord } from '../../shared/model-attempt-types'

/** Existing Attempt and Effect records are the failure handoff; this adds no execution/retry authority. */
export async function nativeRecoveryHandoffPrompt(meta: SessionMeta, run: TaskRunRecord | undefined, rootDir: string): Promise<string> {
  try {
    return await readNativeRecoveryHandoffPrompt(meta, run, rootDir)
  } catch (cause) {
    throw new ModelContextHandoffError('无法读取或验证模型恢复交接记录，已阻止发送。', cause)
  }
}

async function readNativeRecoveryHandoffPrompt(meta: SessionMeta, run: TaskRunRecord | undefined, rootDir: string): Promise<string> {
  if (!run) return ''
  if (run.sessionId !== meta.id) throw new Error('模型恢复交接的 Run 不属于当前任务')
  const context = await readTaskSnapshotDatabase(rootDir, db => {
    const persistedRun = findWorkflowRun(db, run.id)
    if (!persistedRun) return undefined
    readAndVerifyEvents(db)
    if (persistedRun.sessionId !== meta.id || (meta.workspaceId && persistedRun.projectId !== meta.workspaceId) ||
        (meta.goalId && persistedRun.goalId !== meta.goalId) ||
        (meta.workItemId && persistedRun.workItemId !== meta.workItemId) ||
        persistedRun.taskRun.id !== run.id || persistedRun.taskRun.sessionId !== meta.id) {
      throw new Error('模型恢复交接的持久 Run 归属不一致')
    }
    const attempts: ModelAttemptRecord[] = []
    let cursor: string | undefined
    do {
      const page = selectModelAttempts(db, { runId: run.id, limit: 500, ...(cursor ? { cursor } : {}) })
      attempts.push(...page.attempts); cursor = page.nextCursor
    } while (cursor)
    const failed = attempts.filter(attempt => attempt.status === 'failed' || attempt.status === 'cancelled')
      .sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt) || a.id.localeCompare(b.id))
    const effects = (persistedRun.taskRun.effects ?? []).filter(effect => ['executing', 'waiting_reconciliation', 'failed'].includes(effect.status))
    if (effects.some(effect => effect.runId !== run.id || effect.sessionId !== meta.id)) {
      throw new Error('模型恢复交接的 Effect 归属不一致')
    }
    if (!failed.length && !effects.length) return undefined
    return {
      runId: run.id,
      failures: failed.slice(0, 8).map(attempt => ({ id: attempt.id, requestId: attempt.requestId,
        providerId: attempt.providerId, model: attempt.model, protocol: attempt.protocol,
        outcome: attempt.outcome, errorClass: attempt.errorClass, recordDigest: attempt.recordDigest,
        ...(attempt.failoverFromAttemptId ? { failoverFromAttemptId: attempt.failoverFromAttemptId } : {}) })),
      effects: effects.map(effect => ({ id: effect.id, status: effect.status, targetDigest: effect.targetDigest,
        evidence: effect.evidence.map(evidence => ({ id: evidence.id, kind: evidence.kind, digest: evidence.digest })) })),
      omittedOlderAttempts: Math.max(0, failed.length - 8)
    }
  })
  if (!context) return ''
  assertNoCredentialMaterial(context)
  return [
    '# Recorded execution failures for this Run',
    'These are persisted observations, not permission to repeat an operation. An unknown result requires reconciliation; preserve confirmed effects and do not infer that a request or file write failed merely from a transport error.',
    `Source digest: sha256:${projectAggregateDigest(context)}`,
    projectAggregateCanonicalJson(context)
  ].join('\n')
}
