import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, opendirSync, realpathSync, statSync } from 'node:fs'
import { execFileSyncInExecutionEnvironment as execFileSync } from '../wsl/process'
import { isAbsolute, join } from 'node:path'
import { TextDecoder } from 'node:util'
import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import type { RemoteWorkspaceBinding, RemoteWorkspaceRequest, RemoteWorkspaceResult } from '../../shared/remote-workspace-types'
import { digest } from '../project-workspace/codec'
import { resolveExistingProjectPathSync } from '../utils/safe-project-path'

export interface RemoteWorkspaceSource {
  projectId: string; workItemId: string; sessionId: string; runId?: string; cwd: string; title: string
  authorityDigest: string
}
const MAX_BYTES = 256 * 1024
const MAX_ENTRIES = 200
export const MAX_REMOTE_DOWNLOAD_BYTES = 32 * 1024 * 1024
function fileIdentity(info: Stats): string { return digest({ dev: info.dev, ino: info.ino, bytes: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }) }
function relativePath(value: unknown): string {
  if (value === undefined || value === '') return '.'
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f\\]/.test(value) || isAbsolute(value) || value.split('/').some(part => part === '..' || part === '.git')) throw new Error('只接受工作目录内的相对路径。')
  return value
}
export function workspaceBinding(source: RemoteWorkspaceSource): RemoteWorkspaceBinding {
  const canonicalPath = realpathSync(source.cwd), info = statSync(canonicalPath)
  if (!info.isDirectory()) throw new Error('远端任务目录不可用。')
  const binding = { projectId: source.projectId, workItemId: source.workItemId, sessionId: source.sessionId,
    ...(source.runId ? { runId: source.runId } : {}), canonicalPath,
    rootIdentity: digest({ path: canonicalPath, dev: info.dev, ino: info.ino }), authorityDigest: source.authorityDigest }
  return { ...binding, bindingDigest: digest(binding) }
}
function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'core.untrackedCache=false', '-c', 'core.pager=cat', '-c', 'submodule.recurse=false', ...args], {
      cwd, encoding: 'utf8', timeout: 5000, maxBuffer: MAX_BYTES, windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch { throw new Error('远端 Git 查看失败、超时或结果超过 256 KiB；请缩小文件范围。') }
}
/** Synchronous, bounded reads let the caller recheck device/task authority before returning bytes. */
export function readRemoteWorkspaceSource(source: RemoteWorkspaceSource, deviceId: string, request: RemoteWorkspaceRequest): RemoteWorkspaceResult {
  if (!['describe', 'list', 'read', 'git_status', 'git_diff', 'file_info', 'file_chunk'].includes(request.operation) || request.workItemId !== source.workItemId) throw new Error('远端工作区请求无效。')
  const binding = workspaceBinding(source)
  if (request.operation !== 'describe' && (!request.binding || digest(request.binding) !== digest(binding))) throw new Error('远端任务、目录或权限已变化，请重新打开工作区。')
  const result: RemoteWorkspaceResult = { protocolVersion: 1, projectId: source.projectId, deviceId, binding, operation: request.operation, title: source.title }
  const path = relativePath(request.path)
  if (request.operation === 'list') {
    const directory = resolveExistingProjectPathSync(binding.canonicalPath, path)
    if (!statSync(directory.fullPath).isDirectory()) throw new Error('目标不是目录。')
    const names: string[] = [], directoryHandle = opendirSync(directory.fullPath)
    try {
      for (let entry = directoryHandle.readSync(); entry; entry = directoryHandle.readSync()) {
        if (names.length >= 20_000) throw new Error('目录条目超过 20000，请选择更小的子目录。')
        if (entry.name !== '.git' && !/[\x00-\x1f\x7f\\]/.test(entry.name)) names.push(entry.name)
      }
    } finally { directoryHandle.closeSync() }
    names.sort()
    const cursor = request.cursor ?? 0
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > names.length) throw new Error('文件列表页码无效。')
    result.path = path
    result.entries = names.slice(cursor, cursor + MAX_ENTRIES).map(name => {
      const info = lstatSync(join(directory.fullPath, name))
      return { name, path: path === '.' ? name : `${path}/${name}`, kind: info.isSymbolicLink() ? 'unavailable' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'unavailable' }
    })
    if (cursor + MAX_ENTRIES < names.length) result.nextCursor = cursor + MAX_ENTRIES
    resolveExistingProjectPathSync(binding.canonicalPath, path)
  } else if (request.operation === 'file_info' || request.operation === 'file_chunk') {
    const target = resolveExistingProjectPathSync(binding.canonicalPath, path)
    const fd = openSync(target.fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const before = fstatSync(fd), identity = fileIdentity(before)
      if (!before.isFile() || before.size > MAX_REMOTE_DOWNLOAD_BYTES) throw new Error('另存只支持不超过 32 MiB 的普通文件。')
      result.path = path
      if (request.operation === 'file_info') {
        const hash = createHash('sha256'), buffer = Buffer.alloc(MAX_BYTES)
        let offset = 0
        while (offset < before.size) {
          const count = readSync(fd, buffer, 0, Math.min(MAX_BYTES, before.size - offset), offset)
          if (!count) throw new Error('远端文件读取期间已变化。')
          hash.update(buffer.subarray(0, count)); offset += count
        }
        result.file = { path, bytes: before.size, identity, sha256: hash.digest('hex') }
      } else {
        const expected = request.file, offset = request.offset
        if (!expected || expected.path !== path || expected.bytes !== before.size || expected.identity !== identity || !/^[a-f0-9]{64}$/.test(expected.sha256) ||
          !Number.isSafeInteger(offset) || offset! < 0 || offset! >= before.size) throw new Error('远端文件版本或分块位置已变化，请重新另存。')
        const buffer = Buffer.alloc(Math.min(MAX_BYTES, before.size - offset!))
        let received = 0
        while (received < buffer.length) { const count = readSync(fd, buffer, received, buffer.length - received, offset! + received); if (!count) throw new Error('远端文件分块不完整。'); received += count }
        result.file = { ...expected }; result.chunkOffset = offset; result.chunkBase64 = buffer.toString('base64'); result.chunkSha256 = createHash('sha256').update(buffer).digest('hex')
      }
      const after = fstatSync(fd), current = resolveExistingProjectPathSync(binding.canonicalPath, path)
      if (fileIdentity(after) !== identity || fileIdentity(statSync(current.fullPath)) !== identity) throw new Error('远端文件读取期间已变化，请重新另存。')
    } finally { closeSync(fd) }
  } else if (request.operation === 'read') {
    const file = resolveExistingProjectPathSync(binding.canonicalPath, path)
    const fd = openSync(file.fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const before = fstatSync(fd)
      if (!before.isFile() || before.size > MAX_BYTES) throw new Error('仅支持不超过 256 KiB 的文本文件。')
      const buffer = Buffer.alloc(MAX_BYTES + 1)
      let length = 0, count = 0
      do { count = readSync(fd, buffer, length, buffer.length - length, length); length += count } while (count && length < buffer.length)
      const bytes = buffer.subarray(0, length), after = fstatSync(fd)
      const current = resolveExistingProjectPathSync(binding.canonicalPath, path), info = statSync(current.fullPath)
      if (bytes.length > MAX_BYTES || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || info.dev !== after.dev || info.ino !== after.ino) throw new Error('远端文件读取期间发生变化，请重新读取。')
      if (bytes.includes(0)) throw new Error('此入口只预览 UTF-8 文本。')
      result.content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      result.path = path; result.digest = digest(result.content)
    } finally { closeSync(fd) }
  } else if (request.operation === 'git_status' || request.operation === 'git_diff') {
    if (realpathSync(git(binding.canonicalPath, ['rev-parse', '--show-toplevel']).trim()) !== binding.canonicalPath) throw new Error('任务目录必须是 Git 工作树根目录，不能读取父仓库。')
    const head = git(binding.canonicalPath, ['rev-parse', '--verify', 'HEAD']).trim()
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error('远端 Git 基线无效。')
    if (path !== '.') resolveExistingProjectPathSync(binding.canonicalPath, path)
    result.content = request.operation === 'git_status'
      ? git(binding.canonicalPath, ['status', '--short', '--branch', '--untracked-files=normal', '--ignore-submodules=all', '--', path])
      : `Unstaged\n${git(binding.canonicalPath, ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--', path])}\nStaged\n${git(binding.canonicalPath, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--', path])}`
    if (Buffer.byteLength(result.content) > MAX_BYTES || git(binding.canonicalPath, ['rev-parse', '--verify', 'HEAD']).trim() !== head) throw new Error('Git 结果过大或基线已变化，请重新读取。')
    result.path = path; result.gitHead = head; result.digest = digest(result.content)
  }
  if (workspaceBinding(source).bindingDigest !== binding.bindingDigest) throw new Error('远端目录身份已变化。')
  return result
}
