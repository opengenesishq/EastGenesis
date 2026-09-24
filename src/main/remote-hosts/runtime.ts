import type { RemoteHostService } from './service'

let current: RemoteHostService | undefined

/** Share the existing connection and protected credentials; no second store,
 * transport, pairing session or handoff outbox is created. */
export function installRemoteHostService(service: RemoteHostService): () => void {
  if (current && current !== service) throw new Error('远端连接服务已初始化。')
  current = service
  return () => { if (current === service) current = undefined }
}
export function getRemoteHostService(): RemoteHostService {
  if (!current) throw new Error('远端连接服务尚未启动。')
  return current
}
