import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { RemoteHostApi } from '../../shared/remote-host-types'
import type { RemoteWorkspaceSaveResult } from '../../shared/remote-workspace-types'
import { digest } from '../project-workspace/codec'

type SaveInput = Parameters<RemoteHostApi['saveRemoteWorkspaceFile']>[0]
type Read = RemoteHostApi['readRemoteWorkspace']
function directoryIdentity(path: string): string {
  const info = statSync(path)
  if (!info.isDirectory()) throw new Error('另存目录不可用。')
  return digest({ dev: info.dev, ino: info.ino })
}
function targetIdentity(path: string): string {
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('另存目标必须是普通文件。')
    return digest({ dev: info.dev, ino: info.ino, size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs })
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'; throw error }
}
/** Only a native save-dialog callback can select the local destination. */
export async function saveRemoteWorkspaceDownload(input: SaveInput, read: Read, selectPath: (suggested: string) => Promise<string | undefined>, assertCurrent: () => void): Promise<RemoteWorkspaceSaveResult> {
  assertCurrent()
  const source = (await read({ ...input, operation: 'file_info' })).file
  if (!source || source.path !== input.path || source.bytes > 32 * 1024 * 1024) throw new Error('远端文件版本不可用。')
  const path = await selectPath(basename(source.path))
  assertCurrent()
  if (!path) return { status: 'cancelled' }
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error('另存目标路径无效。')
  const parent = realpathSync(dirname(path)), parentIdentity = directoryIdentity(parent), target = join(parent, basename(path)), previous = targetIdentity(target)
  const temporary = join(parent, `.caogen-remote-${randomUUID()}.part`)
  let fd: number | undefined, committed = false
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    const hash = createHash('sha256')
    for (let offset = 0; offset < source.bytes;) {
      assertCurrent()
      const part = await read({ ...input, operation: 'file_chunk', file: source, offset })
      assertCurrent()
      if (part.chunkBase64 === undefined || part.chunkOffset !== offset || digest(part.file) !== digest(source)) throw new Error('远端文件分块不匹配。')
      const bytes = Buffer.from(part.chunkBase64, 'base64')
      if (!bytes.length || bytes.length > source.bytes - offset) throw new Error('远端文件分块长度无效。')
      hash.update(bytes)
      let written = 0
      while (written < bytes.length) { const count = writeSync(fd, bytes, written, bytes.length - written); if (!count) throw new Error('本地另存写入不完整。'); written += count }
      offset += bytes.length
    }
    if (hash.digest('hex') !== source.sha256) throw new Error('完整文件摘要不匹配，另存已取消。')
    const fresh = (await read({ ...input, operation: 'file_info' })).file
    assertCurrent()
    if (digest(fresh) !== digest(source)) throw new Error('远端文件版本已变化，请重新另存。')
    if (realpathSync(dirname(path)) !== parent || directoryIdentity(parent) !== parentIdentity || targetIdentity(target) !== previous) throw new Error('另存目录或目标文件已变化，请重新选择。')
    const saved = fstatSync(fd), named = lstatSync(temporary)
    if (!named.isFile() || named.isSymbolicLink() || named.dev !== saved.dev || named.ino !== saved.ino || named.size !== source.bytes) throw new Error('本地临时文件已变化，另存已取消。')
    fsyncSync(fd); closeSync(fd); fd = undefined
    renameSync(temporary, target); committed = true
    return { status: 'saved', path: target, bytes: source.bytes, sha256: source.sha256 }
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (!committed) { try { unlinkSync(temporary) } catch { /* The original destination is preserved. */ } }
  }
}
