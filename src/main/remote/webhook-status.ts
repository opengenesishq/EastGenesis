import type { RemoteContinuationSnapshot } from '../../shared/remote-types'

let current: RemoteContinuationSnapshot['webhook'] = { host: '127.0.0.1', port: 0, running: false, protocol: 'http' }
const listeners = new Set<() => void>()

export function setRemoteWebhookStatus(status: RemoteContinuationSnapshot['webhook']): void {
  current = status ? { ...status } : undefined
  for (const listener of listeners) listener()
}

export function watchRemoteWebhookStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getRemoteWebhookStatus(): RemoteContinuationSnapshot['webhook'] {
  return current ? { ...current } : undefined
}
