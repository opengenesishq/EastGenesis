export interface TemporaryTaskProfileView {
  id: string
  createdAt: number
  state: 'running' | 'starting' | 'cleanup_pending'
  canEnd?: boolean
}
export interface TemporaryTaskState {
  temporary: boolean
  profileId?: string
  profiles: TemporaryTaskProfileView[]
}
export interface TemporaryTaskApi {
  getTemporaryTaskState(): Promise<TemporaryTaskState>
  openTemporaryTask(): Promise<TemporaryTaskProfileView>
  cleanTemporaryTask(id: string): Promise<void>
  endTemporaryTask(id: string): Promise<void>
  finishTemporaryTask(): Promise<void>
  openTemporaryTaskFiles(): Promise<void>
  onTemporaryTaskEntry(callback: () => void): () => void
}
