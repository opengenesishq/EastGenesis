import { ipcRenderer } from 'electron'
import type { WorktreePullRequestDraftApi } from '../shared/worktree-pr-draft-types'
export const worktreePullRequestDraftApi: WorktreePullRequestDraftApi = {
  prepareWorktreePullRequestDraft: (id, input) => ipcRenderer.invoke('worktree-pr-draft:prepare', id, input),
  saveWorktreePullRequestDraft: (id, input) => ipcRenderer.invoke('worktree-pr-draft:save', id, input)
}
