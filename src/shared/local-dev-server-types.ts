export interface LocalDevServerConfig { command: string; cwd: string; url: string }
export interface LocalDevServerStart extends LocalDevServerConfig { sessionId: string; requestId: string }
export type LocalDevServerStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'exited' | 'failed' | 'interrupted'
export interface LocalDevServerRun {
  id: string
  sessionId: string
  config: LocalDevServerConfig
  status: LocalDevServerStatus
  startedAt: number
  endedAt?: number
  pid?: number
  exitCode?: number | null
  signal?: string | null
  /** Reachability is not proof that this process owns the HTTP listener. */
  reachable: boolean
  checkedAt?: number
  logs: string[]
  message?: string
  operationId?: string
  stopOperationId?: string
}
export interface LocalDevServerView {
  supported: boolean
  taskCwd: string
  current: LocalDevServerRun | null
  warning?: string
}
export interface LocalDevServerApi {
  getLocalDevServer(sessionId: string): Promise<LocalDevServerView>
  startLocalDevServer(input: LocalDevServerStart): Promise<LocalDevServerView>
  stopLocalDevServer(sessionId: string, requestId: string): Promise<LocalDevServerView>
}
