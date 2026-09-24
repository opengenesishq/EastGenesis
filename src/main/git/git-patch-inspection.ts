import { execFileSyncInExecutionEnvironment as execFileSync } from '../wsl/process'
import path from 'node:path'
import { isolatedLocalGitEnv, withSafeLocalGitConfig } from './safe-git'

const MAX_PATCH_INSPECTION_BYTES = 20 * 1024 * 1024

export type SingleFilePatchInspection =
  | { ok: true; repoRoot: string; relativePath: string }
  | { ok: false; error: string }

export function inspectSingleFilePatch(
  cwd: string,
  filePath: string,
  patch: string
): SingleFilePatchInspection {
  try {
    const env = isolatedLocalGitEnv(process.env)
    const repoRoot = execFileSync('git', withSafeLocalGitConfig(['rev-parse', '--show-toplevel']), {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    const declaredPath = normalizeRepoPath(repoRoot, filePath)
    const output = execFileSync(
      'git',
      withSafeLocalGitConfig(['apply', '--numstat', '-z', '--whitespace=nowarn']),
      {
        cwd,
        env,
        input: patch,
        encoding: null,
        timeout: 30_000,
        maxBuffer: MAX_PATCH_INSPECTION_BYTES,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    const patchPaths = parseNumstatPaths(output)
    if (patchPaths.length !== 1 || patchPaths[0] !== declaredPath) {
      return { ok: false, error: 'hunk patch 的实际文件与声明文件不一致，已阻止执行' }
    }
    return { ok: true, repoRoot, relativePath: declaredPath }
  } catch (error) {
    return { ok: false, error: `无法验证 hunk patch 路径:${errorMessage(error)}` }
  }
}

function normalizeRepoPath(repoRoot: string, filePath: string): string {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    throw new Error('filePath 不能为空或包含非法字符')
  }
  if (path.isAbsolute(filePath) || filePath.startsWith(':(') || filePath.startsWith(':/')) {
    throw new Error('filePath 必须是普通仓库相对路径')
  }
  const absolute = path.resolve(repoRoot, filePath)
  const relative = path.relative(repoRoot, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('filePath 必须位于当前 Git 仓库内')
  }
  return relative.split(path.sep).join('/')
}

function parseNumstatPaths(output: Buffer | string): string[] {
  return (typeof output === 'string' ? output : output.toString('utf8'))
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const separator = record.lastIndexOf('\t')
      if (separator < 0 || !record.slice(separator + 1)) throw new Error('不支持 rename/copy 或无路径 patch')
      return record.slice(separator + 1)
    })
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr
    const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr
    if (text?.trim()) return text.trim()
  }
  return error instanceof Error ? error.message : String(error)
}
