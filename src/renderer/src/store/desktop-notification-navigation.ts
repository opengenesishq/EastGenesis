import type { SessionMeta } from '../../../shared/types'

interface NotificationNavigationHost {
  hasSession(sessionId: string): boolean
  listSessions(): Promise<SessionMeta[]>
  adoptSessions(metas: SessionMeta[]): void
  navigationKey(): string
  openSession(sessionId: string): void
  openRecovery(): void
}

/** A notification click navigates the existing ledger; it never starts a run. */
export function createDesktopNotificationNavigation(host: NotificationNavigationHost): (sessionId: string) => Promise<void> {
  let latestClick = 0
  return async (sessionId) => {
    const click = ++latestClick
    if (sessionId === 'task-snapshot') return host.openRecovery()
    if (host.hasSession(sessionId)) return host.openSession(sessionId)
    const navigationKey = host.navigationKey()
    try {
      const metas = await host.listSessions()
      // A later click or manual navigation takes precedence over a slow lookup.
      if (click !== latestClick || navigationKey !== host.navigationKey()) return
      host.adoptSessions(metas)
      if (host.hasSession(sessionId)) host.openSession(sessionId)
      else host.openRecovery()
    } catch {
      if (click === latestClick && navigationKey === host.navigationKey()) host.openRecovery()
    }
  }
}
