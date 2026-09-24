import type { FileSystemIdentity, WorktreePullRequestResult } from './types'

export interface WorktreePullRequestDraftBinding {
  sessionId: string
  sessionCreatedAt: number
  workspaceId?: string
  goalId?: string
  workItemId?: string
  projectId?: string
  repoRoot: string
  worktreePath: string
  commonDir: string
  repoIdentity: FileSystemIdentity
  worktreeIdentity: FileSystemIdentity
  commonDirIdentity: FileSystemIdentity
  registryDigest: string
  branch: string
}
export interface WorktreePullRequestSnapshot {
  schemaVersion: 1
  digest: string
  capturedAt: number
  binding: WorktreePullRequestDraftBinding
  headSha: string
  managedBaseSha: string
  baseBranch: string
  baseRef?: string
  baseSha?: string
  mergeBaseSha?: string
  baseUnavailable?: string
  branches: Array<{ name: string; ref: string; source: 'local' | 'cached_remote' }>
  remote?: { name: string; host?: string; projectPath?: string; urlDigest: string; pushUrlDigest: string }
  commits: Array<{ sha: string; subject: string }>
  commitCount: number
  commitsTruncated: boolean
  diff: string
  diffDigest: string
  diffBytes: number
  diffTruncated: boolean
  files: Array<{ path: string; added: number | null; removed: number | null }>
  filesTruncated: boolean
  dirty: { staged: number; unstaged: number; untracked: number; conflicted: number; digest: string }
}
export interface WorktreePullRequestDraftSubmission {
  draftRevision: number
  status: 'prepared' | 'pushing' | 'pushed' | 'creating' | 'completed' | 'needs_reconciliation' | 'failed'
  phase?: 'push' | 'pr'
  pushOperationId: string
  prOperationId: string
  effectId?: string
  error?: string
  result?: WorktreePullRequestResult
  updatedAt: number
}
export interface WorktreePullRequestDraft {
  schemaVersion: 1
  id: string
  revision: number
  stateRevision: number
  snapshot: WorktreePullRequestSnapshot
  title: string
  body: string
  titleDigest: string
  bodyDigest: string
  saveRequestId: string
  saveRequestDigest: string
  createdAt: number
  updatedAt: number
  submission?: WorktreePullRequestDraftSubmission
}
export interface WorktreePullRequestDraftPrepareInput { baseBranch?: string }
export interface WorktreePullRequestDraftSaveInput {
  requestId: string
  draftId?: string
  expectedRevision: number
  snapshotDigest: string
  title: string
  body: string
  baseBranch: string
}
export interface WorktreePullRequestDraftSubmitInput {
  draftId: string
  expectedRevision: number
  snapshotDigest: string
}
export interface WorktreePullRequestDraftPreparation {
  snapshot: WorktreePullRequestSnapshot
  draft?: WorktreePullRequestDraft
  defaults: { title: string; body: string }
  /** This local capability check never authenticates or queries the remote. */
  capability: { available: boolean; provider?: 'github' | 'gitlab'; tool?: 'gh' | 'glab'; message?: string; authentication: 'not_checked' }
  draftStale: boolean
}
export interface WorktreePullRequestDraftApi {
  prepareWorktreePullRequestDraft(sessionId: string, input?: WorktreePullRequestDraftPrepareInput): Promise<WorktreePullRequestDraftPreparation>
  saveWorktreePullRequestDraft(sessionId: string, input: WorktreePullRequestDraftSaveInput): Promise<WorktreePullRequestDraft>
}
