import type { SessionEntrypointApi, SessionDiscoveryCommand, SessionDiscoveryResult } from '../shared/session-entrypoint-types'
import { invokeAppFeature } from './app-feature'

function discoverSessions<Command extends SessionDiscoveryCommand>(command: Command): Promise<SessionDiscoveryResult<Command>> {
  return invokeAppFeature('session-query', 'discover', command)
}

export const sessionQueryApi: Pick<SessionEntrypointApi, 'listSessions' | 'querySessions'> = {
  listSessions: () => discoverSessions({ kind: 'list_active' }),
  querySessions: (input) => discoverSessions({ kind: 'query', input })
}
