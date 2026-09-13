import type { EffectRecord, TaskRunRecord } from '../../shared/types'
import { getMediaStore } from '../media/media-store'
import { effectTargetsConflict } from './effect-target-conflict'
import { isBoundMediaReconciliationRead } from './media-reconciliation-lease'

const UNRESOLVED = new Set<EffectRecord['status']>(['prepared', 'executing', 'waiting_reconciliation'])

export async function findConflictingEffectLease(persistedRuns: TaskRunRecord[], incomingRun: TaskRunRecord, rootDir: string): Promise<EffectRecord | undefined> {
  const incoming = (incomingRun.effects ?? []).filter((effect) => UNRESOLVED.has(effect.status))
  for (let left = 0; left < incoming.length; left++) {
    for (let right = left + 1; right < incoming.length; right++) {
      if (effectLeasesConflict(incoming[left], incoming[right])) return incoming[right]
    }
  }
  for (const run of persistedRuns) {
    for (const effect of run.effects ?? []) {
      if (!UNRESOLVED.has(effect.status)) continue
      for (const candidate of incoming) {
        if (!effectLeasesConflict(candidate, effect)) continue
        if (!await permitsMediaObservation(candidate, effect, rootDir)) return effect
      }
    }
  }
  return undefined
}

async function permitsMediaObservation(candidate: EffectRecord, existing: EffectRecord, rootDir: string): Promise<boolean> {
  if (candidate.target.kind !== 'media_job_operation' || candidate.target.operation !== 'poll') return false
  const job = await getMediaStore(rootDir).getMediaJob(candidate.target.mediaJobId)
  return isBoundMediaReconciliationRead(candidate, existing, job)
}

function effectLeasesConflict(left: EffectRecord, right: EffectRecord): boolean {
  if (left.id === right.id) return false
  if ((left.resourceKey || left.effectKey) === (right.resourceKey || right.effectKey)) return true
  return effectTargetsConflict(left.target, right.target)
}
