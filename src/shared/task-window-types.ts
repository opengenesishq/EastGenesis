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
  onTaskWindowState(callback: (state: TaskWindowState) => void): () => void
}
