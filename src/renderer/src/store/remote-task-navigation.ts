import { create } from 'zustand'
import type { WelcomeRemoteTarget } from '../components/experience/welcome-remote-target'

export interface RemoteTaskNavigationTarget {
  connection: WelcomeRemoteTarget
  hostId: string
  projectId: string
  workItemId: string
  sessionId: string
  sourceCommandId: string
  requestId: string
}
export const useRemoteTaskNavigation = create<{
  target: RemoteTaskNavigationTarget | null
  open(target: RemoteTaskNavigationTarget): void
  close(): void
}>(set => ({ target: null, open: target => set({ target }), close: () => set({ target: null }) }))

export const useRemoteHostSettingsNavigation = create<{ target: WelcomeRemoteTarget | null; open(target: WelcomeRemoteTarget): void; clear(): void }>(set => ({
  target: null, open: target => set({ target }), clear: () => set({ target: null })
}))
