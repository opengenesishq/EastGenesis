import { officeRevisionApi } from './office-revision'
import type { OfficeRevisionApi } from '../shared/office-revision-types'
import { ipcRenderer } from 'electron'
import type { CreateSessionOptions } from '../shared/types'
import type { SessionEntrypointApi } from '../shared/session-entrypoint-types'
import { personalTaskApi } from './personal-task'
import { sessionQueryApi } from './session-query'

export const sessionEntrypointApi: SessionEntrypointApi & OfficeRevisionApi = {
  createSession: (opts: CreateSessionOptions) => ipcRenderer.invoke('sessions:create', opts),
  ...sessionQueryApi,
  ...personalTaskApi, ...officeRevisionApi
}
