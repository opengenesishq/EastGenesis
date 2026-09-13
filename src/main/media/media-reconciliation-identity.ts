import type { MediaJobRecord, MediaRemoteJobObservation } from '../../shared/media-types'

/** A client-side hash is not a provider job ID and cannot prove remote acceptance. */
export function missingMediaReconciliationIdentity(job: MediaJobRecord, operation: string): MediaRemoteJobObservation | undefined {
  if (!['poll', 'cancel'].includes(operation) || job.status !== 'waiting_reconciliation' || (job.providerExternalJobId && job.providerExternalJobId !== job.externalJobId)) return undefined
  return {
    status: 'waiting_reconciliation', externalJobId: job.externalJobId,
    reason: '厂商未返回可查询的任务 ID；保留原提交并等待账单或厂商确认，不会自动重新提交。'
  }
}

export function assertMediaSubmissionReconciled(jobs: MediaJobRecord[], contentDigest: string | undefined): void {
  if (contentDigest && jobs.some((job) => job.status === 'waiting_reconciliation' && job.executionBinding?.contentDigest === contentDigest)) {
    throw new Error('相同媒体请求仍待对账；请先确认原任务结果，再使用新的提交标识或厂商。')
  }
}

export function observedMediaProviderJobId(job: MediaJobRecord, observation: MediaRemoteJobObservation | undefined): string | undefined {
  const value = observation?.providerExternalJobId ?? observation?.externalJobId ?? job.providerExternalJobId
  return value && value !== job.externalJobId ? value : undefined
}
