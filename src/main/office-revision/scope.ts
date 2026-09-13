import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { SessionMeta } from '../../shared/types'
import type { OfficeRevisionScope } from '../../shared/office-revision-types'
import { resolveBusinessLineId } from '../../shared/business-line-types'
import { assertSameBusinessLine } from '../business-line-ownership'
import { assertActiveBusinessLine } from '../business-line-registry-reader'
import { readTaskSnapshotDatabase } from '../task/task-snapshot'
import { findWorkflowArtifact, findWorkflowWorkItem } from '../task/workflow-ledger-store'
import { getLatestPersistedArtifactLifecycleByLineage, getPersistedArtifactLifecycle, resolveLifecycleRoots } from '../task/artifact-lifecycle-api'
import { artifactBlobPath } from '../task/artifact-lifecycle-content'
import { findArtifactPurge } from '../task/artifact-lifecycle-store'
import type { ArtifactLifecycleRecord } from '../task/artifact-lifecycle-types'
import { resolveExistingProjectPath } from '../utils/safe-project-path'
import { officeError } from './errors'
import { officeBytesDigest } from './digest'
import { OFFICE_PACKAGE_LIMITS } from './package'

export interface OfficeContext { meta: SessionMeta; rootDir: string }
export interface ScopedOfficeArtifact { record: ArtifactLifecycleRecord; title: string; mediaType: string; bytes: Buffer; latest: boolean; scope: OfficeRevisionScope }
export async function officeSessionScope(context: OfficeContext): Promise<OfficeRevisionScope> {
  const { meta, rootDir } = context
  if (!meta.workspaceId || !meta.workItemId || meta.unassigned) officeError('OFFICE_SCOPE_MISMATCH', '请在当前任务创建或打开成果；Office修订需要已关联项目和任务。')
  const workItem = await readTaskSnapshotDatabase(rootDir, (db) => findWorkflowWorkItem(db, meta.workItemId!))
  if (!workItem || workItem.projectId !== meta.workspaceId || workItem.goalId !== meta.goalId) officeError('OFFICE_SCOPE_MISMATCH', '会话与canonical任务归属不一致。')
  const businessLineId = resolveBusinessLineId(meta)
  assertSameBusinessLine(businessLineId, workItem.businessLineId, 'studio')
  assertActiveBusinessLine(businessLineId, rootDir)
  return { projectId: workItem.projectId, goalId: workItem.goalId, workItemId: workItem.id, businessLineId }
}
export async function readScopedOfficeArtifact(context: OfficeContext, artifactId: string, expectedDigest?: string): Promise<ScopedOfficeArtifact> {
  const scope = await officeSessionScope(context)
  const record = await getPersistedArtifactLifecycle(artifactId, context.rootDir)
  if (!record || record.projectId !== scope.projectId || record.workItemId !== scope.workItemId || record.goalId !== scope.goalId) officeError('OFFICE_SCOPE_MISMATCH', '成果不属于当前任务。')
  if (!['document', 'spreadsheet'].includes(record.kind)) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '仅支持Word和Excel成果。')
  if (expectedDigest !== undefined && expectedDigest !== record.digest) officeError('OFFICE_BASE_CHANGED', '原稿摘要已变化，请重新检查。')
  const artifact = await readTaskSnapshotDatabase(context.rootDir, (db) => findArtifactPurge(db, artifactId) ? null : findWorkflowArtifact(db, artifactId))
  if (!artifact) officeError('OFFICE_SCOPE_MISMATCH', 'canonical成果缺失。')
  const path = await officeArtifactReadPath(context, record)
  const bytes = await readBoundOfficeFile(path, record.digest, record.sizeBytes)
  const latest = await getLatestPersistedArtifactLifecycleByLineage(record, context.rootDir)
  return { record, title: artifact.title, mediaType: artifact.mediaType ?? '', bytes,
    latest: latest?.artifactId === artifactId, scope }
}
async function officeArtifactReadPath(context: OfficeContext, record: ArtifactLifecycleRecord): Promise<string> {
  if (record.storageKind === 'blob') return artifactBlobPath(resolveLifecycleRoots(context.rootDir).workflowRoot, record.digest)
  if (!record.sourceRef) officeError('OFFICE_BASE_CHANGED', '原稿文件位置缺失。')
  // Legacy source_ref is mutable: verify bytes, never treat a lossy preview as the original.
  return (await resolveExistingProjectPath(context.meta.cwd, record.sourceRef)).fullPath
}
export async function readBoundOfficeFile(path: string, expectedDigest: string, expectedBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== expectedBytes || stat.size > OFFICE_PACKAGE_LIMITS.compressedBytes) officeError('OFFICE_BASE_CHANGED', '文件类型、大小或摘要不再匹配原稿。')
    const buffer = Buffer.alloc(expectedBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const bytes = buffer.subarray(0, offset)
    if (bytes.length !== expectedBytes || officeBytesDigest(bytes) !== expectedDigest) officeError('OFFICE_BASE_CHANGED', '文件内容已变化，请重新检查原稿。')
    return bytes
  } finally { await handle.close() }
}
