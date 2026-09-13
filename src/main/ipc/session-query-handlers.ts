import type { IpcMainInvokeEvent } from 'electron'
import { app } from 'electron'
import { join } from 'node:path'
import { listHistory } from '../history'
import { querySessionDirectory } from '../session-query'
import { sessionManager } from '../sessionManager'
import { parseSessionDiscoveryCommand } from './session-entrypoint-commands'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

export type SessionQueryAction = 'discover'

export async function handleSessionQueryIpc(
  event: IpcMainInvokeEvent,
  rawAction: unknown,
  ...args: unknown[]
) {
  assertTrustedWorkflowLedgerSender(event)
  if (rawAction !== 'discover' || args.length !== 1) throw new Error('Session discovery action is invalid')
  const command = parseSessionDiscoveryCommand(args[0])
  if (command.kind === 'list_active') return sessionManager.list()
  return querySessionDirectory({
    activeSessions: sessionManager.list(),
    history: listHistory(),
    snapshots: await sessionManager.listTaskSnapshots(),
    transcriptsDir: join(app.getPath('userData'), 'transcripts')
  }, command.input)
}
