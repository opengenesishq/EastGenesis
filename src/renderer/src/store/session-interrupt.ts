import type { StoreApi } from 'zustand'
import type { AppStore } from '../store'

/** Interrupt the requested identity and refresh durable recovery before removing its projection. */
export async function interruptSession(store: Pick<StoreApi<AppStore>, 'getState' | 'setState'>,
  requestedId: string | undefined, onRemoved: (id: string) => void): Promise<void> {
  const id = requestedId ?? store.getState().activeId
  if (!id) return
  await window.agentDesk.interrupt(id)
  const [metas, history, taskSnapshots, modelAttemptReconciliations] = await Promise.all([
    window.agentDesk.listSessions(), window.agentDesk.listHistory(),
    window.agentDesk.listTaskSnapshots(), window.agentDesk.listModelAttemptReconciliations()
  ])
  const interruptedMeta = metas.find((meta) => meta.id === id)
  if (!interruptedMeta) onRemoved(id)
  store.setState((state) => {
    const common = { history, taskSnapshots, modelAttemptReconciliations }
    if (interruptedMeta) {
      const session = state.sessions[id]
      return { ...common, sessions: session ? { ...state.sessions, [id]: { ...session, meta: interruptedMeta } } : state.sessions }
    }
    const sessions = { ...state.sessions }
    delete sessions[id]
    const order = state.order.filter((sessionId) => sessionId !== id)
    return { ...common, sessions, order, activeId: state.activeId === id ? (order.at(-1) ?? null) : state.activeId }
  })
}
