import { ipcRenderer } from 'electron'
import type { PersonalTaskApi, PersonalTaskCommand, PersonalTaskCommandResult } from '../shared/personal-task-types'

function invokePersonalTask<Command extends PersonalTaskCommand>(command: Command): Promise<PersonalTaskCommandResult<Command>> {
  return ipcRenderer.invoke('personalTasks:command', command)
}

export const personalTaskApi: PersonalTaskApi = {
  submitPersonalTask: (input) => invokePersonalTask({ kind: 'submit', input }),
  getPersonalTaskSubmission: (clientRequestId) => invokePersonalTask({ kind: 'get_submission', clientRequestId })
}
