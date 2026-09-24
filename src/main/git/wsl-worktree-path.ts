import { win32 } from 'node:path'
import { parseWslHostPath } from '../wsl/binding'

/** Keep generated WSL worktrees inside the already bound Linux repository. */
export function wslManagedWorktreePath(repoRoot: string, gitCommonDir: string, sessionId: string): string | undefined {
  const source = parseWslHostPath(repoRoot)
  if (!source) return undefined
  const common = parseWslHostPath(gitCommonDir)
  if (!common || common.distribution !== source.distribution || !common.guestPath.startsWith(`${source.guestPath.replace(/\/$/, '')}/`)) {
    throw new Error('此 WSL 仓库的 Git 管理目录位于任务根目录之外，暂不能自动新建 Worktree；请选择本地任务，或打开已建立的同发行版 Worktree。')
  }
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === '.' || sessionId === '..') throw new Error('WSL Worktree 的任务标识无效。')
  return win32.join(gitCommonDir, 'caogen-workspaces', sessionId)
}

export function assertManagedWorktreeExecutionPath(repoRoot: string, gitCommonDir: string, worktreePath: string, sessionId: string): void {
  const expected = wslManagedWorktreePath(repoRoot, gitCommonDir, sessionId)
  const target = parseWslHostPath(worktreePath)
  if (!expected) {
    if (target) throw new Error('宿主机仓库不能自动创建或接管 WSL Worktree。')
    return
  }
  const canonical = parseWslHostPath(expected)!
  if (!target || target.distribution !== canonical.distribution || target.guestPath !== canonical.guestPath) {
    throw new Error('WSL Worktree 必须位于同一 Linux 仓库的受管目录，禁止落到宿主机或其他发行版。')
  }
}
