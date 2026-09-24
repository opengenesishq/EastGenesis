import type { PullRequestWorkspaceCheck, PullRequestWorkspaceCollection, PullRequestWorkspaceCommit, PullRequestWorkspaceFeedback,
  PullRequestWorkspaceFile, PullRequestWorkspaceIssue, PullRequestWorkspaceRepository, PullRequestWorkspaceSection,
  PullRequestWorkspaceSnapshot, PullRequestWorkspaceSummary } from '../../shared/pull-request-workspace-types'

export const PR_WORKSPACE_PAGE_SIZE = 50
export class PullRequestWorkspaceError extends Error {
  constructor(readonly issue: PullRequestWorkspaceIssue) { super(issue.message) }
}
export interface PullRequestReadTransport { get(repository: PullRequestWorkspaceRepository, endpoint: string): Promise<unknown> }
type Sections = Pick<PullRequestWorkspaceSnapshot, PullRequestWorkspaceSection>
const fail = (message: string): never => { throw new PullRequestWorkspaceError({ code: 'invalid_response', message }) }
export function issueFrom(error: unknown): PullRequestWorkspaceIssue {
  return error instanceof PullRequestWorkspaceError ? error.issue : { code: 'unavailable', message: '读取 PR/MR 未完成，请重试或检查本机 CLI。' }
}
export function pageNumber(value: unknown = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10000) fail('页码无效')
  return value as number
}
export function prNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('PR/MR 编号无效')
  return value as number
}
export class PullRequestWorkspaceAdapter {
  constructor(private readonly transport: PullRequestReadTransport) {}
  async list(repository: PullRequestWorkspaceRepository, state: 'open' | 'closed' | 'all', page: number): Promise<{ items: PullRequestWorkspaceSummary[]; hasMore: boolean }> {
    const base = this.root(repository)
    const filter = repository.provider === 'gitlab' ? (state === 'open' ? 'opened' : state) : state
    const endpoint = repository.provider === 'github' ? `${base}/pulls` : `${base}/merge_requests`
    const order = repository.provider === 'github' ? 'sort=updated&direction=desc' : 'order_by=updated_at&sort=desc'
    const rows = array(await this.transport.get(repository, `${endpoint}?state=${filter}&${order}&per_page=${PR_WORKSPACE_PAGE_SIZE}&page=${page}`))
    return { items: rows.slice(0, PR_WORKSPACE_PAGE_SIZE).map(row => this.summary(repository, object(row))), hasMore: rows.length >= PR_WORKSPACE_PAGE_SIZE }
  }
  async overview(repository: PullRequestWorkspaceRepository, number: number): Promise<PullRequestWorkspaceSummary> {
    return this.summary(repository, object(await this.transport.get(repository, this.itemRoot(repository, number))))
  }
  async sections(repository: PullRequestWorkspaceRepository, number: number, headSha: string,
    pages: Partial<Record<PullRequestWorkspaceSection, number>>): Promise<Sections> {
    const result: Sections = {}
    await Promise.all(Object.entries(pages).map(async ([name, requestedPage]) => {
      const section = name as PullRequestWorkspaceSection, page = pageNumber(requestedPage)
      try {
        const collection = repository.provider === 'github'
          ? await this.githubSection(repository, number, headSha, section, page)
          : await this.gitlabSection(repository, number, section, page)
        Object.assign(result, { [section]: collection })
      } catch (error) { Object.assign(result, { [section]: { items: [], page, hasMore: false, truncated: false, issue: issueFrom(error) } }) }
    }))
    return result
  }
  private async githubSection(repo: PullRequestWorkspaceRepository, number: number, sha: string, section: PullRequestWorkspaceSection, page: number): Promise<PullRequestWorkspaceCollection<unknown>> {
    const base = this.root(repo), pr = this.itemRoot(repo, number), query = `?per_page=${PR_WORKSPACE_PAGE_SIZE}&page=${page}`
    if (section === 'files') return collection(await this.transport.get(repo, `${pr}/files${query}`), page, row => {
      const patch = clipped(row.patch, 20000)
      return { path: required(row.filename), previousPath: optional(row.previous_filename), status: text(row.status),
        additions: integer(row.additions), deletions: integer(row.deletions), patch: patch.text, patchTruncated: patch.truncated || typeof row.patch !== 'string' } satisfies PullRequestWorkspaceFile
    })
    if (section === 'commits') return collection(await this.transport.get(repo, `${pr}/commits${query}`), page, row => {
      const commit = object(row.commit), author = record(commit.author)
      return { sha: required(row.sha), title: text(commit.message, 2000).split('\n')[0], author: text(author.name), url: safeUrl(row.html_url) } satisfies PullRequestWorkspaceCommit
    })
    if (section === 'comments') {
      const sources = await Promise.allSettled([this.transport.get(repo, `${base}/issues/${number}/comments${query}`), this.transport.get(repo, `${pr}/comments${query}`)])
      const groups = sources.map((source, index) => source.status === 'fulfilled'
        ? collection(source.value, page, row => this.githubFeedback(row, index ? 'inline_comment' : 'comment'))
        : { items: [], page, hasMore: false, truncated: false, issue: issueFrom(source.reason) })
      return combine(groups, page)
    }
    if (section === 'reviews') return collection(await this.transport.get(repo, `${pr}/reviews${query}`), page, row => this.githubFeedback(row, 'review'))
    if (section === 'checks') {
      if (!/^[a-f0-9]{40,64}$/i.test(sha)) fail('PR HEAD 无法核对')
      const sources = await Promise.allSettled([this.transport.get(repo, `${base}/commits/${sha}/check-runs${query}`), this.transport.get(repo, `${base}/commits/${sha}/statuses${query}`)])
      const groups = sources.map((source, index) => source.status === 'fulfilled'
        ? collection(index ? source.value : object(source.value).check_runs, page, row => ({ id: `${index ? 'status' : 'check'}-${scalar(row.id)}`,
          name: text(index ? row.context : row.name), status: text(index ? row.state : row.status), conclusion: optional(row.conclusion),
          url: safeUrl(index ? row.target_url : row.details_url) } satisfies PullRequestWorkspaceCheck))
        : { items: [], page, hasMore: false, truncated: false, issue: issueFrom(source.reason) })
      return combine(groups, page)
    }
    return fail('未知 PR 内容分组')
  }
  private async gitlabSection(repo: PullRequestWorkspaceRepository, number: number, section: PullRequestWorkspaceSection, page: number): Promise<PullRequestWorkspaceCollection<unknown>> {
    const pr = this.itemRoot(repo, number), query = `?per_page=${PR_WORKSPACE_PAGE_SIZE}&page=${page}`
    if (section === 'files') return collection(await this.transport.get(repo, `${pr}/diffs${query}`), page, row => {
      const patch = clipped(row.diff, 20000)
      return { path: required(row.new_path), previousPath: optional(row.old_path), status: row.deleted_file ? 'removed' : row.new_file ? 'added' : row.renamed_file ? 'renamed' : 'modified',
        patch: patch.text, patchTruncated: patch.truncated || row.too_large === true || row.collapsed === true || typeof row.diff !== 'string' } satisfies PullRequestWorkspaceFile
    })
    if (section === 'commits') return collection(await this.transport.get(repo, `${pr}/commits${query}`), page, row => ({
      sha: required(row.id), title: text(row.title, 2000), author: text(row.author_name), url: safeUrl(row.web_url)
    } satisfies PullRequestWorkspaceCommit))
    if (section === 'comments') {
      const discussions = array(await this.transport.get(repo, `${pr}/discussions${query}`))
      const notes = discussions.flatMap(item => array(object(item).notes).filter(note => !object(note).system)).slice(0, 150)
      const result = collection(notes, page, row => {
        const body = clipped(row.body, 20000), position = record(row.position)
        return { id: `gl-note-${scalar(row.id)}`, kind: row.position ? 'inline_comment' : 'comment', author: text(record(row.author).username),
          body: body.text, bodyTruncated: body.truncated, url: `${webPrUrl(repo, number)}#note_${scalar(row.id)}`, createdAt: optional(row.created_at), updatedAt: optional(row.updated_at),
          path: optional(position.new_path) ?? optional(position.old_path), line: integer(position.new_line) ?? integer(position.old_line),
          side: integer(position.new_line) ? 'RIGHT' : integer(position.old_line) ? 'LEFT' : undefined, commitSha: optional(position.head_sha), resolved: row.resolved === true
        } satisfies PullRequestWorkspaceFeedback
      }, 150)
      result.hasMore = discussions.length >= PR_WORKSPACE_PAGE_SIZE
      result.truncated ||= notes.length >= 150
      return result
    }
    if (section === 'reviews') {
      const approvals = object(await this.transport.get(repo, `${pr}/approvals`))
      const result = collection(approvals.approved_by ?? [], 1, row => {
        const user = object(row.user)
        return { id: `gl-approval-${scalar(user.id)}`, kind: 'review', author: text(user.username), body: '', bodyTruncated: false, state: 'APPROVED' } satisfies PullRequestWorkspaceFeedback
      })
      // GitLab approvals is an unpaginated object; never offer a looping next page.
      result.hasMore = false
      return result
    }
    if (section === 'checks') return collection(await this.transport.get(repo, `${pr}/pipelines${query}`), page, row => ({
      id: `gl-pipeline-${scalar(row.id)}`, name: `Pipeline #${scalar(row.id)} · ${text(row.ref)}`, status: text(row.status), url: safeUrl(row.web_url)
    } satisfies PullRequestWorkspaceCheck))
    return fail('未知 MR 内容分组')
  }
  private githubFeedback(row: Record<string, unknown>, kind: PullRequestWorkspaceFeedback['kind']): PullRequestWorkspaceFeedback {
    const body = clipped(row.body, 20000)
    return { id: `gh-${kind}-${scalar(row.id)}`, kind, author: text(record(row.user).login), body: body.text, bodyTruncated: body.truncated,
      state: optional(row.state), url: safeUrl(row.html_url), createdAt: optional(row.created_at) ?? optional(row.submitted_at), updatedAt: optional(row.updated_at),
      commitSha: optional(row.commit_id), path: optional(row.path), line: integer(row.line) ?? integer(row.original_line), side: optional(row.side) }
  }
  private root(repo: PullRequestWorkspaceRepository): string {
    return repo.provider === 'github' ? `repos/${repo.projectPath.split('/').map(encodeURIComponent).join('/')}` : `projects/${encodeURIComponent(repo.projectPath)}`
  }
  private itemRoot(repo: PullRequestWorkspaceRepository, number: number): string { return `${this.root(repo)}/${repo.provider === 'github' ? 'pulls' : 'merge_requests'}/${prNumber(number)}` }
  private summary(repo: PullRequestWorkspaceRepository, row: Record<string, unknown>): PullRequestWorkspaceSummary {
    const github = repo.provider === 'github', number = prNumber(github ? row.number : row.iid), body = clipped(row.body ?? row.description, 30000)
    const headSha = text(github ? record(row.head).sha : row.sha ?? record(row.diff_refs).head_sha)
    if (headSha && !/^[a-f0-9]{40,64}$/i.test(headSha)) fail('PR/MR HEAD 格式无效')
    return { number, title: required(row.title).slice(0, 1000), body: body.text, bodyTruncated: body.truncated, url: webPrUrl(repo, number),
      state: row.merged_at ? 'merged' : text(row.state), draft: row.draft === true || row.work_in_progress === true,
      author: text(github ? record(row.user).login : record(row.author).username), sourceBranch: text(github ? record(row.head).ref : row.source_branch),
      baseBranch: text(github ? record(row.base).ref : row.target_branch), headSha, updatedAt: text(row.updated_at) }
  }
}
function collection<T>(raw: unknown, page: number, parse: (row: Record<string, unknown>) => T, limit = PR_WORKSPACE_PAGE_SIZE): PullRequestWorkspaceCollection<T> {
  const rows = array(raw), items = rows.slice(0, limit).map(row => parse(object(row)))
  return { items, page, hasMore: rows.length >= limit, truncated: rows.length > limit || items.some(item => {
    const value = item as Record<string, unknown>; return value.bodyTruncated === true || value.patchTruncated === true
  }) }
}
function combine<T>(groups: PullRequestWorkspaceCollection<T>[], page: number): PullRequestWorkspaceCollection<T> {
  return { items: groups.flatMap(group => group.items), page, hasMore: groups.some(group => group.hasMore), truncated: groups.some(group => group.truncated),
    ...(groups.some(group => group.issue) ? { issue: { code: groups.find(group => group.issue)!.issue!.code,
      message: groups.flatMap(group => group.issue ? [group.issue.message] : []).join('；') } } : {}) }
}
function webPrUrl(repo: PullRequestWorkspaceRepository, number: number): string { return `https://${repo.host}/${repo.projectPath}/${repo.provider === 'github' ? 'pull' : '-/merge_requests'}/${number}` }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('服务返回的记录格式无效'); return value as Record<string, unknown> }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) fail('服务返回的列表格式无效'); return value as unknown[] }
function text(value: unknown, limit = 2000): string { return typeof value === 'string' ? value.slice(0, limit) : '' }
function required(value: unknown): string { const result = text(value, 8000); if (!result) fail('服务记录缺少必要字段'); return result }
function optional(value: unknown): string | undefined { return text(value) || undefined }
function integer(value: unknown): number | undefined { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined }
function scalar(value: unknown): string { if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)) return value; if (Number.isSafeInteger(value)) return String(value); return fail('服务记录编号无效') }
function clipped(value: unknown, limit: number): { text: string; truncated: boolean } { return { text: text(value, limit), truncated: typeof value === 'string' && value.length > limit } }
export function safeUrl(value: unknown): string | undefined { try { const url = new URL(String(value)); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined } catch { return undefined } }
