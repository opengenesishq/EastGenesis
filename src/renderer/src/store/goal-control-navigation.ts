import { create } from 'zustand'
export type GoalControlAction = 'details' | 'edit' | 'clear'
interface GoalControlNavigation {
  request?: { sessionId: string; action: GoalControlAction; nonce: string }
  open(sessionId: string, action: GoalControlAction): void
  consume(nonce: string): void
}
export const useGoalControlNavigation = create<GoalControlNavigation>((set) => ({
  open: (sessionId, action) => set({ request: { sessionId, action, nonce: crypto.randomUUID() } }),
  consume: nonce => set(state => state.request?.nonce === nonce ? { request: undefined } : {})
}))
