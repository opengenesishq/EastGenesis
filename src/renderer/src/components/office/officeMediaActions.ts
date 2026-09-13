import type { MediaJobRecord } from '../../../../shared/media-types'
import type { AgentDeskApi } from '../../../../shared/types'
import type { OfficeOperationalActor } from './operationalActors'

type MediaControlsApi = Pick<AgentDeskApi, 'cancelMediaJob' | 'reconcileMediaJob' | 'advanceMediaJob' | 'getMediaStudio'>
export type MediaActionReceipt = 'cancel-confirmed' | 'cancel-requested' | 'simulation-unresolved' | 'result-unresolved' | 'state-refreshed'

/** Only the canonical response establishes completion. Unknown submissions are never replayed. */
export async function operateOfficeMedia(api: MediaControlsApi, actor: OfficeOperationalActor, action: 'cancel' | 'observe'):
Promise<{ job: MediaJobRecord; receipt: MediaActionReceipt }> {
  if (action === 'cancel') {
    const job = await api.cancelMediaJob(actor.sourceId)
    return { job, receipt: job.status === 'cancelled' ? 'cancel-confirmed' : 'cancel-requested' }
  }
  if (actor.simulated && actor.status === 'waiting_reconciliation') {
    const job = (await api.getMediaStudio()).jobs.find((item) => item.id === actor.sourceId)
    if (!job) throw new Error('Media job no longer exists')
    return { job, receipt: 'simulation-unresolved' }
  }
  const job = actor.status === 'waiting_reconciliation'
    ? await api.reconcileMediaJob(actor.sourceId) : await api.advanceMediaJob(actor.sourceId)
  return { job, receipt: job.status === 'waiting_reconciliation' ? 'result-unresolved' : 'state-refreshed' }
}

export const MEDIA_ACTION_RECEIPTS: Record<MediaActionReceipt, [string, string]> = {
  'cancel-confirmed': ['任务已确认取消。', 'Cancellation confirmed.'],
  'cancel-requested': ['取消请求已受理，尚未确认取消；请继续检查原任务。', 'Cancellation requested, not yet confirmed. Check the original job for its outcome.'],
  'simulation-unresolved': ['已读取模拟任务；它没有可查询的远端结果，状态仍未确定。', 'Simulation refreshed. It has no remote result to query; its outcome remains unknown.'],
  'result-unresolved': ['已检查原任务，远端结果仍未确定。', 'Original job checked; the remote outcome remains unknown.'],
  'state-refreshed': ['已读取任务最新状态。', 'Latest job state received.']
}
