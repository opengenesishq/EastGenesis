import type { CreateSessionOptions, SessionMeta } from './types'
import type { SessionQueryInput, SessionQueryPage } from './session-query-types'
import type { PersonalTaskApi } from './personal-task-types'

/** Session creation and discovery are independent of renderer navigation. */
export interface SessionEntrypointApi extends PersonalTaskApi {
  listSessions(): Promise<SessionMeta[]>
  querySessions(input?: SessionQueryInput): Promise<SessionQueryPage>
  createSession(opts: CreateSessionOptions): Promise<SessionMeta>
}

export type SessionDiscoveryCommand =
  | { kind: 'list_active' }
  | { kind: 'query'; input?: SessionQueryInput }

export type SessionDiscoveryResult<Command extends SessionDiscoveryCommand> =
  Command extends { kind: 'list_active' } ? SessionMeta[] : SessionQueryPage
