import { ipcRenderer } from 'electron'
import type { PullRequestWorkspaceApi } from '../shared/pull-request-workspace-types'
export const pullRequestWorkspaceApi: PullRequestWorkspaceApi = {
  inspectPullRequestWorkspace: id => ipcRenderer.invoke('pr-workspace:inspect', id),
  listPullRequestWorkspaceItems: (id, input) => ipcRenderer.invoke('pr-workspace:list', id, input),
  readPullRequestWorkspaceItem: (id, input) => ipcRenderer.invoke('pr-workspace:read', id, input),
  preparePullRequestReviewDraft: (id, input) => ipcRenderer.invoke('pr-workspace:prepare-review-draft', id, input)
}
