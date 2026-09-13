import type { MediaJobRecord, MediaRemoteJobObservation } from '../../shared/media-types'

export function mediaTransportFailure(job: MediaJobRecord, operation: string, partialBytes: number): MediaRemoteJobObservation {
  const download = operation === 'download'
  const hasProviderId = Boolean(job.providerExternalJobId && job.providerExternalJobId !== job.externalJobId)
  const queryReason = hasProviderId
    ? '远程请求未返回可信结果；保留原任务 ID，等待对账查询。'
    : '厂商未返回可查询的任务 ID；保留原提交并等待账单或厂商确认，不会自动重新提交。'
  return {
    status: download ? 'downloading' : 'waiting_reconciliation',
    externalJobId: job.providerExternalJobId ?? job.externalJobId,
    reason: download ? 'Remote media download paused and will resume from its durable offset' : queryReason,
    ...(download && partialBytes > 0 ? { downloadReceivedBytes: partialBytes } : {})
  }
}
