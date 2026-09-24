import { execFileInExecutionEnvironment as execFile, execFileSyncInExecutionEnvironment as execFileSync } from '../wsl/process'
import { realpathSync, statSync } from 'node:fs'
import { assertTaskExecutionEnvironment } from '../wsl/binding'
import type { SessionMeta } from '../../shared/types'
import type { PullRequestWorkspaceCapability, PullRequestWorkspaceRepository } from '../../shared/pull-request-workspace-types'
import { stableValueDigest } from '../task/tool-idempotency'
import { buildMinimalSubprocessEnv } from '../security/subprocess-environment'
import { gitCliAvailable, gitCliOverride } from './cli-override'
import { isolatedLocalGitEnv, withSafeLocalGitConfig } from './safe-git'
import { sanitizePrRemoteUrl } from './worktree-pr-preview'
import { PullRequestWorkspaceError, type PullRequestReadTransport } from './pull-request-workspace-adapters'

export function inspectLocalPullRequestRepository(meta: SessionMeta): PullRequestWorkspaceCapability {
  try {
    if (!meta || meta.status === 'closed' || meta.workspaceHandoffPending) throw new Error('请先打开任务并完成工作目录交接')
    assertTaskExecutionEnvironment(meta)
    const repoRoot = realpathSync(git(meta.cwd, ['rev-parse', '--show-toplevel']))
    const remotes = git(repoRoot, ['remote']).split(/\r?\n/).filter(Boolean)
    const remote = remotes.includes('origin') ? 'origin' : remotes[0]
    if (!remote) return { available: false, authentication: 'not_checked', message: '当前仓库未配置 Git remote。' }
    const urls = git(repoRoot, ['remote', 'get-url', '--all', remote]).split(/\r?\n/).filter(Boolean)
    if (urls.length !== 1) throw new Error('PR/MR 工作区需要唯一的 remote URL')
    const sanitized = sanitizePrRemoteUrl(urls[0]), parsed = parseRemote(sanitized)
    if (!parsed) return { available: false, authentication: 'not_checked', message: '此工作区支持 GitHub 和 GitLab remote。' }
    const stats = statSync(repoRoot, { bigint: true })
    const binding = { sessionId: meta.id, sessionCreatedAt: meta.createdAt, repoRoot, repoIdentity: { device: String(stats.dev), inode: String(stats.ino) },
      remote, remoteUrlDigest: stableValueDigest(sanitized), ...parsed,
      ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}), ...(meta.goalId ? { goalId: meta.goalId } : {}),
      ...(meta.workItemId ? { workItemId: meta.workItemId } : {}), ...(meta.projectId ? { projectId: meta.projectId } : {}) }
    const repository: PullRequestWorkspaceRepository = { ...binding, digest: stableValueDigest(binding),
      localHeadSha: git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']) }
    try { repository.branch = git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']) } catch { /* detached HEAD may still browse PRs */ }
    const tool = parsed.provider === 'github' ? 'gh' : 'glab', available = gitCliAvailable(tool, 10000, repoRoot)
    return { available, repository, tool, authentication: 'not_checked', ...(!available ? { message: `当前执行环境尚未安装 ${tool}。请安装并登录后刷新；此处不会自动登录。` } : {}) }
  } catch { return { available: false, authentication: 'not_checked', message: '无法核对当前任务的本地 Git 仓库，请检查目录或交接状态。' } }
}

export class PullRequestWorkspaceCli implements PullRequestReadTransport {
  async get(repository: PullRequestWorkspaceRepository, endpoint: string): Promise<unknown> {
    const prefix = repository.provider === 'github' ? `repos/${repository.projectPath.split('/').map(encodeURIComponent).join('/')}/`
      : `projects/${encodeURIComponent(repository.projectPath)}/`
    if (!endpoint.startsWith(prefix) || /[\0\r\n#]/.test(endpoint) || endpoint.includes('://')) throw new PullRequestWorkspaceError({ code: 'invalid_response', message: '只读请求超出当前仓库范围' })
    const tool = repository.provider === 'github' ? 'gh' : 'glab', override = gitCliOverride(tool, repository.repoRoot)
    // Explicit GET only: no shell, field flags, GraphQL mutations, comments, merge, or push.
    const args = [...override?.argsPrefix ?? [], 'api', '--hostname', repository.host, '--method', 'GET', endpoint]
    const env = buildMinimalSubprocessEnv({ GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GLAB_CHECK_UPDATE: 'false',
      ...(tool === 'gh' ? { GH_HOST: repository.host } : { GITLAB_HOST: repository.host }) })
    const result = await new Promise<{ ok: boolean; stdout: string; stderr: string; missing: boolean; timedOut: boolean }>(resolve => {
      execFile(override?.executable ?? tool, args, { cwd: repository.repoRoot, env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
        killSignal: 'SIGKILL', windowsHide: true }, (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
          missing: error?.code === 'ENOENT', timedOut: Boolean(error?.killed) }))
    })
    if (!result.ok) {
      const raw = `${result.stderr}\n${result.stdout}`
      if (/\b401\b|not logged|auth login|authentication|authenticate|登录/i.test(raw)) throw new PullRequestWorkspaceError({ code: 'auth_required', message: `${tool} 尚未登录或登录已失效，请在终端登录后重试。` })
      if (/\b403\b|forbidden|rate limit/i.test(raw)) throw new PullRequestWorkspaceError({ code: 'forbidden', message: '当前账号无权读取此内容，或服务已限制请求。' })
      if (/\b404\b|not found/i.test(raw)) throw new PullRequestWorkspaceError({ code: 'not_found', message: '远端记录不存在，或当前账号无法访问。' })
      throw new PullRequestWorkspaceError({ code: 'unavailable', message: result.missing ? `当前执行环境未找到 ${tool}` : result.timedOut ? '只读请求超时，可重试当前页。' : '只读请求失败，请检查 CLI 登录、网络或服务状态。' })
    }
    try { return JSON.parse(result.stdout) } catch { throw new PullRequestWorkspaceError({ code: 'invalid_response', message: 'CLI 返回了无法解析的内容。' }) }
  }
}
function git(cwd: string, args: string[]): string {
  return execFileSync('git', withSafeLocalGitConfig(['-c', 'protocol.allow=never', '-C', cwd, ...args]), { encoding: 'utf8', timeout: 10000,
    maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: isolatedLocalGitEnv(process.env) }).trim()
}
function parseRemote(value: string): Pick<PullRequestWorkspaceRepository, 'provider' | 'host' | 'projectPath'> | undefined {
  let host = '', projectPath = ''
  try { const url = new URL(value); if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return; host = url.hostname.toLowerCase(); projectPath = url.pathname }
  catch { const parts = /^([^:\s/]+):(.+)$/.exec(value); if (!parts) return; host = parts[1].toLowerCase(); projectPath = parts[2] }
  projectPath = projectPath.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  if (!/^[a-z0-9.-]+$/.test(host) || !projectPath.includes('/') || projectPath.split('/').some(segment => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..')) return
  const provider = host === 'github.com' || host.endsWith('.github.com') ? 'github' : host === 'gitlab.com' || host.includes('gitlab') ? 'gitlab' : undefined
  return provider ? { provider, host, projectPath } : undefined
}
