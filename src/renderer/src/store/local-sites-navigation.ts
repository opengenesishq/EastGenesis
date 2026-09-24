import { create } from 'zustand'

interface LocalSitesNavigation {
  visible: boolean
  error: string
  setVisible(value: boolean): void
  setError(error: string): void
  taskSitesRequest?: { sessionId: string; nonce: number; view: 'files' }
  openTaskFiles(sessionId: string): void
}
let request = 0
export const useLocalSitesNavigation = create<LocalSitesNavigation>(set => ({
  visible: false,
  error: '',
  setVisible: visible => set({ visible }),
  setError: error => set({ error }),
  openTaskFiles: sessionId => set({ visible: false, taskSitesRequest: { sessionId, nonce: ++request, view: 'files' } })
}))
