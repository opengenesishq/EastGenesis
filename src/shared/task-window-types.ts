import type { RemoteHostExpectedConnection } from './remote-host-types'

export interface TaskWindowState {
  sessionId: string | null
  alwaysOnTop: boolean
  available: boolean
}

/** Window actions only project an existing task; they never create or start work. */
export interface TaskWindowApi {
  /** Set by Electron when this renderer is created; never contains credentials. */
  readonly taskWindowSessionId: string | null
  openTaskWindow(sessionId: string): Promise<TaskWindowState>
  getTaskWindowState(): Promise<TaskWindowState>
  setTaskWindowAlwaysOnTop(value: boolean): Promise<TaskWindowState>
  showTaskInMainWindow(sessionId: string): Promise<void>
  /** Copies an unsent draft only. Main window explicitly opens it before sending. */
  sendRemoteWelcomeDraftToMain(input: RemoteWelcomeDraftInput): Promise<RemoteWelcomeDraftReceipt>
  listRemoteWelcomeDrafts(): Promise<RemoteWelcomeDraft[]>
  acknowledgeRemoteWelcomeDraft(requestId: string): Promise<void>
  onRemoteWelcomeDraftsChanged(callback: () => void): () => void
  onTaskWindowState(callback: (state: TaskWindowState) => void): () => void
}
export interface RemoteWelcomeDraftInput {
  requestId: string
  text: string
  hostId: string
  expectedConnection: RemoteHostExpectedConnection
}
export interface RemoteWelcomeDraft extends RemoteWelcomeDraftInput {
  createdAt: number
  sourceSessionId: string
}
export interface RemoteWelcomeDraftReceipt { requestId: string; status: 'pending' | 'delivered' }
