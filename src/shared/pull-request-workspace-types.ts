export type PullRequestWorkspaceProvider = 'github' | 'gitlab'
export type PullRequestWorkspaceSection = 'files' | 'commits' | 'comments' | 'reviews' | 'checks'
export interface PullRequestWorkspaceRepository {
  digest: string
  sessionId: string
  sessionCreatedAt: number
  workspaceId?: string
  goalId?: string
  workItemId?: string
  projectId?: string
  repoRoot: string
  repoIdentity: { device: string; inode: string }
  remote: string
  remoteUrlDigest: string
  provider: PullRequestWorkspaceProvider
  host: string
  projectPath: string
  localHeadSha: string
  branch?: string
}
export interface PullRequestWorkspaceCapability {
  available: boolean
  repository?: PullRequestWorkspaceRepository
  tool?: 'gh' | 'glab'
  authentication: 'not_checked'
  message?: string
}
export interface PullRequestWorkspaceIssue {
  code: 'auth_required' | 'forbidden' | 'not_found' | 'unavailable' | 'invalid_response' | 'changed'
  message: string
}
export interface PullRequestWorkspaceSummary {
  number: number
  title: string
  body: string
  bodyTruncated: boolean
  url: string
  state: string
  draft: boolean
  author: string
  sourceBranch: string
  baseBranch: string
  headSha: string
  updatedAt: string
}
export interface PullRequestWorkspaceList {
  repository: PullRequestWorkspaceRepository
  items: PullRequestWorkspaceSummary[]
  page: number
  hasMore: boolean
  observedAt: number
}
export interface PullRequestWorkspaceCollection<T> {
  items: T[]
  page: number
  hasMore: boolean
  truncated: boolean
  issue?: PullRequestWorkspaceIssue
}
export interface PullRequestWorkspaceFile {
  path: string
  previousPath?: string
  status: string
  additions?: number
  deletions?: number
  patch: string
  patchTruncated: boolean
}
export interface PullRequestWorkspaceCommit { sha: string; title: string; author: string; url?: string }
export interface PullRequestWorkspaceFeedback {
  id: string
  kind: 'comment' | 'inline_comment' | 'review'
  author: string
  body: string
  bodyTruncated: boolean
  state?: string
  url?: string
  createdAt?: string
  updatedAt?: string
  commitSha?: string
  path?: string
  line?: number
  side?: string
  resolved?: boolean
}
export interface PullRequestWorkspaceCheck { id: string; name: string; status: string; conclusion?: string; url?: string }
export interface PullRequestWorkspaceSnapshot {
  schemaVersion: 1
  id: string
  digest: string
  repository: PullRequestWorkspaceRepository
  pullRequest: PullRequestWorkspaceSummary
  observedAt: number
  files?: PullRequestWorkspaceCollection<PullRequestWorkspaceFile>
  commits?: PullRequestWorkspaceCollection<PullRequestWorkspaceCommit>
  comments?: PullRequestWorkspaceCollection<PullRequestWorkspaceFeedback>
  reviews?: PullRequestWorkspaceCollection<PullRequestWorkspaceFeedback>
  checks?: PullRequestWorkspaceCollection<PullRequestWorkspaceCheck>
}
export type PullRequestWorkspaceResult<T> = { ok: true; value: T } | { ok: false; issue: PullRequestWorkspaceIssue }
export interface PullRequestWorkspaceListInput { state: 'open' | 'closed' | 'all'; page?: number; expectedRepositoryDigest: string }
export interface PullRequestWorkspaceReadInput {
  number: number
  expectedRepositoryDigest: string
  expectedHeadSha?: string
  /** Only explicitly requested sections are fetched. Each page is bounded to 50 items per endpoint. */
  pages?: Partial<Record<PullRequestWorkspaceSection, number>>
}
export interface PullRequestReviewDraftInput {
  snapshotId: string
  snapshotDigest: string
  selectedFeedbackIds: string[]
  requestId: string
}
export interface PullRequestReviewDraft {
  id: string
  sessionId: string
  text: string
  evidenceId: string
  evidencePath: string
  snapshotDigest: string
  selectedFeedbackIds: string[]
  createdAt: number
}
export interface PullRequestWorkspaceApi {
  inspectPullRequestWorkspace(sessionId: string): Promise<PullRequestWorkspaceCapability>
  listPullRequestWorkspaceItems(sessionId: string, input: PullRequestWorkspaceListInput): Promise<PullRequestWorkspaceResult<PullRequestWorkspaceList>>
  readPullRequestWorkspaceItem(sessionId: string, input: PullRequestWorkspaceReadInput): Promise<PullRequestWorkspaceResult<PullRequestWorkspaceSnapshot>>
  preparePullRequestReviewDraft(sessionId: string, input: PullRequestReviewDraftInput): Promise<PullRequestReviewDraft>
}
