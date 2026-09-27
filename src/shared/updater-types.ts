/** Renderer-visible lifecycle events emitted by the optional desktop updater. */
export type UpdaterEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseNotes?: string }
  | { kind: 'not-available'; version: string }
  | { kind: 'download-progress'; percent: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }
  | { kind: 'disabled'; reason: string }

export interface UpdaterApi {
  checkForUpdates(): Promise<boolean>
  downloadUpdate(): Promise<boolean>
  quitAndInstall(): void
  onUpdaterEvent(listener: (event: UpdaterEvent) => void): () => void
}
