import type { MediaJobRecord } from '../../shared/media-types'
import { getTaskSnapshot } from '../task/task-snapshot'
import { reconcilePersistedTaskSnapshot } from '../task/effect-runtime'
import type { CanonicalSystemOperationContext } from '../task/system-operation-context'
import { TaskKernel } from '../task/task-kernel'
import { isTerminal } from './media-job-transition'

/** A trustworthy query resolves the original effect before later mutations start. */
export async function reconcileMediaOperationEffects(job: MediaJobRecord, rootDir: string): Promise<void> {
  if (job.status === 'waiting_reconciliation') return
  const runs = new Set(job.statusHistory.map((event) => event.runId).filter((id): id is string => Boolean(id)))
  for (const runId of runs) {
    const snapshot = await getTaskSnapshot(runId, rootDir)
    if (snapshot?.run?.effects?.some((effect) => effect.status === 'waiting_reconciliation')) {
      await reconcilePersistedTaskSnapshot(snapshot, rootDir)
    }
  }
}

export async function settleTerminal(context: CanonicalSystemOperationContext, job: MediaJobRecord): Promise<void> {
  if (!isTerminal(job.status)) return
  await new TaskKernel(context.rootDir).deliver(context, {
    status: job.status === 'succeeded' ? 'passed' : 'failed',
    evidenceRefs: job.output?.evidenceId ? [job.output.evidenceId] : [],
    verifiedBy: 'media-runtime'
  })
}
