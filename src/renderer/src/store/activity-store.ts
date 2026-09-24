import { useEffect } from 'react'
import { create } from 'zustand'
import type { TaskActivityItem, TaskActivitySnapshot } from '../../../shared/activity-types'

interface ActivityState {
  visible: boolean
  setVisible(visible: boolean): void
  snapshot: TaskActivitySnapshot | null
  loading: boolean
  error: string
  refresh(): Promise<void>
  mark(snapshotId: string, items: TaskActivityItem[], read: boolean): Promise<void>
}
let request = 0
export const useActivityStore = create<ActivityState>((set, get) => ({
  visible: false,
  setVisible: visible => set({ visible }),
  snapshot: null, loading: false, error: '',
  async refresh() {
    const ticket = ++request
    set({ loading: !get().snapshot })
    try {
      const snapshot = await window.agentDesk.listTaskActivity()
      if (ticket === request) set({ snapshot, loading: false, error: '' })
    } catch (error) {
      if (ticket === request) set({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  },
  async mark(snapshotId, items, read) {
    try {
      await window.agentDesk.markTaskActivity({ snapshotId, itemIds: items.map(item => item.id), read })
      await get().refresh()
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
}))
let consumers = 0, disconnect: (() => void) | undefined
export function useActivitySubscription(): void {
  useEffect(() => {
    consumers++
    if (!disconnect) {
      const refresh = () => { void useActivityStore.getState().refresh() }
      const stop = window.agentDesk.onTaskActivityChanged(refresh)
      const timer = window.setInterval(refresh, 30_000)
      window.addEventListener('focus', refresh)
      disconnect = () => { stop(); clearInterval(timer); window.removeEventListener('focus', refresh) }
      refresh()
    }
    return () => { if (--consumers === 0) { disconnect?.(); disconnect = undefined; request++ } }
  }, [])
}
export function activityForSession(snapshot: TaskActivitySnapshot | null, sessionId: string): TaskActivityItem | undefined {
  return snapshot?.items.find(item => item.sessionId === sessionId || item.sessionAliases.includes(sessionId))
}
