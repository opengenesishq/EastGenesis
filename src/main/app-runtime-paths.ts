import { app } from 'electron'
import { join } from 'node:path'
import { saveTemporaryProfile, temporaryRuntimeFromEnvironment } from './temporary-task/profile-store'

app.setName('EastGenesis')
app.setPath('userData', process.env.CAOGEN_USER_DATA_DIR || join(app.getPath('appData'), 'CaoGen'))
export const temporaryTaskRuntime = temporaryRuntimeFromEnvironment(process.env)
if (temporaryTaskRuntime) {
  app.setPath('sessionData', join(temporaryTaskRuntime.root, 'chromium'))
  app.setPath('logs', join(temporaryTaskRuntime.root, 'logs'))
  app.setPath('crashDumps', join(temporaryTaskRuntime.root, 'crash-dumps'))
  process.env.CAOGEN_MEMORY_DIR = join(temporaryTaskRuntime.root, 'memory')
  process.chdir(join(temporaryTaskRuntime.root, 'personal-workspace'))
  saveTemporaryProfile({ ...temporaryTaskRuntime, childPid: process.pid, state: 'running' })
}
