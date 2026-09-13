import type { RemoteContinuationSnapshot } from '../../shared/remote-types'

let current: RemoteContinuationSnapshot['webhook'] = { host: '127.0.0.1', port: 0, running: false, protocol: 'http' }

export function setRemoteWebhookStatus(status: RemoteContinuationSnapshot['webhook']): void {
  current = status ? { ...status } : undefined
}

export function getRemoteWebhookStatus(): RemoteContinuationSnapshot['webhook'] {
  return current ? { ...current } : undefined
}
