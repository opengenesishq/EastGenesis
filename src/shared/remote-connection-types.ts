export interface RemoteConnectionSettings {
  enabled: boolean
  keepAwake: boolean
  host: string
  port: number
  advertisedHost: string
  tlsCertPath: string
  tlsKeyPath: string
}
export interface RemoteConnectionState {
  settings: RemoteConnectionSettings
  running: boolean
  keepingAwake: boolean
  address?: string
  error?: string
}
export interface RemoteConnectionApi {
  getRemoteConnectionSettings(): Promise<RemoteConnectionState>
  saveRemoteConnectionSettings(settings: RemoteConnectionSettings): Promise<RemoteConnectionState>
}
export const DEFAULT_REMOTE_CONNECTION: RemoteConnectionSettings = {
  enabled: false, keepAwake: false, host: '127.0.0.1', port: 0, advertisedHost: '', tlsCertPath: '', tlsKeyPath: ''
}
