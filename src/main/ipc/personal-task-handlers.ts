import { app, ipcMain } from 'electron'
import { sessionManager } from '../sessionManager'
import { PersonalTaskService } from '../personal-task/personal-task-service'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { parsePersonalTaskCommand } from './session-entrypoint-commands'

export function registerPersonalTaskIpc(): void {
  const service = new PersonalTaskService(app.getPath('userData'), sessionManager)
  ipcMain.handle('personalTasks:command', (event, ...args: unknown[]) => {
    assertTrustedWorkflowLedgerSender(event)
    if (args.length !== 1) throw new Error('Personal task command requires exactly one input')
    const command = parsePersonalTaskCommand(args[0])
    return command.kind === 'submit' ? service.submit(command.input) : service.get(command.clientRequestId)
  })
}
