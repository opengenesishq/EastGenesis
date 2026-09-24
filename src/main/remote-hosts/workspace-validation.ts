import type { RemoteWorkspaceRequest, RemoteWorkspaceView, RemoteWorkspaceBinding } from '../../shared/remote-workspace-types'
import type { StoredRemoteHost } from './store'
import { object, text, revision } from './validation'
import { digest } from '../project-workspace/codec'
import { createHash } from 'node:crypto'

export function validateWorkspaceResponse(value: unknown, host: StoredRemoteHost, request: RemoteWorkspaceRequest): RemoteWorkspaceView {
  const row = object(value), raw = object(row.binding)
  const binding: RemoteWorkspaceBinding = { projectId: text(raw.projectId), workItemId: text(raw.workItemId), sessionId: text(raw.sessionId),
    ...(raw.runId === undefined ? {} : { runId: text(raw.runId) }), canonicalPath: text(raw.canonicalPath, 4096), rootIdentity: text(raw.rootIdentity), authorityDigest: text(raw.authorityDigest), bindingDigest: text(raw.bindingDigest) }
  const { bindingDigest, ...identity } = binding
  if (row.protocolVersion !== 1 || row.deviceId !== host.deviceId || row.projectId !== host.projectId || binding.projectId !== host.projectId ||
    binding.workItemId !== request.workItemId || row.operation !== request.operation || bindingDigest !== digest(identity) || request.binding && digest(binding) !== digest(request.binding)) throw new Error('远端工作区身份或操作响应不匹配。')
  const result: RemoteWorkspaceView = { hostId: host.id, protocolVersion: 1, deviceId: host.deviceId!, projectId: host.projectId!, binding, operation: request.operation, title: text(row.title, 2000) }
  if (row.path !== undefined) {
    result.path = text(row.path, 2048)
    if (result.path !== (request.path || '.')) throw new Error('远端文件路径响应不匹配。')
  }
  if (row.content !== undefined) {
    if (typeof row.content !== 'string' || Buffer.byteLength(row.content) > 256 * 1024 || row.digest !== digest(row.content)) throw new Error('远端文件内容校验失败。')
    result.content = row.content; result.digest = String(row.digest)
  }
  if (row.gitHead !== undefined) result.gitHead = text(row.gitHead, 64)
  if (row.nextCursor !== undefined) result.nextCursor = revision(row.nextCursor)
  if (row.entries !== undefined) {
    if (!Array.isArray(row.entries) || row.entries.length > 200) throw new Error('远端文件列表无效。')
    result.entries = row.entries.map(value => {
      const entry = object(value), name = text(entry.name, 1024), path = text(entry.path, 2048)
      if (!['directory', 'file', 'unavailable'].includes(String(entry.kind)) || name.includes('/') || name === '.' || name === '..' || path !== (result.path === '.' ? name : `${result.path}/${name}`)) throw new Error('远端文件条目无效。')
      return { name, path, kind: entry.kind as 'directory' | 'file' | 'unavailable' }
    })
  }
  if (request.operation === 'file_info' || request.operation === 'file_chunk') {
    const file = object(row.file)
    if (file.path !== request.path || !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0 || Number(file.bytes) > 32 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(String(file.sha256)) || !/^[a-f0-9]{64}$/.test(String(file.identity))) throw new Error('远端另存文件版本无效。')
    result.file = { path: String(file.path), bytes: Number(file.bytes), sha256: String(file.sha256), identity: String(file.identity) }
    if (request.operation === 'file_chunk') {
      if (digest(result.file) !== digest(request.file) || row.chunkOffset !== request.offset || typeof row.chunkBase64 !== 'string' || row.chunkBase64.length > 350000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(row.chunkBase64)) throw new Error('远端文件分块身份无效。')
      const buffer = Buffer.from(row.chunkBase64, 'base64')
      if (buffer.toString('base64') !== row.chunkBase64 || buffer.length !== Math.min(256 * 1024, result.file.bytes - request.offset!) || createHash('sha256').update(buffer).digest('hex') !== row.chunkSha256) throw new Error('远端文件分块摘要不匹配。')
      result.chunkBase64 = row.chunkBase64; result.chunkOffset = request.offset; result.chunkSha256 = String(row.chunkSha256)
    }
  }
  if (request.operation === 'list' && !result.entries || ['read', 'git_status', 'git_diff'].includes(request.operation) && result.content === undefined) throw new Error('远端工作区响应不完整。')
  return result
}
