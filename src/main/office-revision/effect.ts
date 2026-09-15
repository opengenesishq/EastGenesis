import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EffectTarget } from '../../shared/types'
import type { OfficeRevisionEffectTarget, OfficeRevisionKind } from '../../shared/office-revision-types'
import { verifyProductionProjectMutation } from '../project-aggregate/project-mutation-ingress'
import { resolveWritableProjectPath } from '../utils/safe-project-path'
import { officeBytesDigest, officeValueDigest } from './digest'
import { officeError } from './errors'
import { normalizeOfficeIntent } from './input'
import { generateOfficeRevision } from './inspection'
import { assertOfficeRevisionIntent } from './intent'
import { getPreparedOfficePlan } from './plans'
import { readScopedOfficeArtifact, type OfficeContext } from './scope'

export async function buildOfficeRevisionEffectTarget(input: { sessionId?: string; toolInput: Record<string, unknown>; cwd: string }): Promise<OfficeRevisionEffectTarget> {
  if (!input.sessionId) officeError('OFFICE_SCOPE_MISMATCH', 'Office修订缺少可信会话身份。')
  assertOfficeRevisionIntent(input.sessionId, input.toolInput)
  const prepared = getPreparedOfficePlan(input.sessionId, input.toolInput)
  const context = prepared.context
  if (context.meta.cwd !== input.cwd || context.meta.taskStrategy !== 'execute') officeError('OFFICE_SCOPE_MISMATCH', '工作目录或执行策略与预览不一致。')
  await verifyProductionProjectMutation(context.rootDir, prepared.loaded.scope.projectId)
  const loaded = await readScopedOfficeArtifact(context, prepared.draft.baseArtifactId, prepared.draft.expectedDigest)
  if (!loaded.latest) officeError('OFFICE_BASE_NOT_HEAD', '原稿已有新版本。')
  const extension = loaded.record.kind === 'document' ? 'docx' : loaded.record.kind === 'presentation' ? 'pptx' : 'xlsx'
  const filename = `artifacts/office-${officeValueDigest(loaded.record.lineageId).slice(-16)}-v${loaded.record.version + 1}-${prepared.view.planDigest.slice(-12)}.${extension}`
  const output = await resolveWritableProjectPath(input.cwd, filename)
  if (await lstat(output.fullPath).catch(absentOnly)) officeError('OFFICE_OUTPUT_CONFLICT', '该修订输出已存在，请先对账原操作。')
  const root = await lstat(output.root)
  return { kind: 'office_artifact_revision', schemaVersion: 1, artifactKind: loaded.record.kind as OfficeRevisionKind,
    sessionId: input.sessionId, ...loaded.scope, baseArtifactId: loaded.record.artifactId, baseDigest: loaded.record.digest,
    baseVersion: loaded.record.version, lineageId: loaded.record.lineageId, planId: prepared.view.planId,
    planDigest: prepared.view.planDigest, operations: structuredClone(prepared.draft.operations), unchangedScopeDigest: prepared.view.unchangedScopeDigest,
    rootPath: output.root, rootIdentity: { device: String(root.dev), inode: String(root.ino) }, relativePath: output.relativePath,
    workspacePath: output.fullPath, expectedSha256: prepared.outputDigest, expectedBytes: prepared.outputBytes,
    mediaType: loaded.mediaType, title: loaded.title }
}
export async function regenerateFrozenOfficeRevision(context: OfficeContext, target: OfficeRevisionEffectTarget, requireHead = true) {
  const loaded = await readScopedOfficeArtifact(context, target.baseArtifactId, target.baseDigest)
  if (loaded.record.kind !== target.artifactKind || loaded.record.version !== target.baseVersion || loaded.record.lineageId !== target.lineageId ||
      officeValueDigest(loaded.scope) !== officeValueDigest({ projectId: target.projectId, goalId: target.goalId, workItemId: target.workItemId, businessLineId: target.businessLineId })) officeError('OFFICE_SCOPE_MISMATCH', '冻结原稿或任务归属不一致。')
  if (requireHead && !loaded.latest) officeError('OFFICE_BASE_NOT_HEAD', '原稿已有后续修订，旧预览不能覆盖。')
  const result = await generateOfficeRevision(target.artifactKind, loaded.bytes, target.operations)
  if (officeBytesDigest(result.bytes) !== target.expectedSha256 || result.bytes.length !== target.expectedBytes || result.unchangedScopeDigest !== target.unchangedScopeDigest) officeError('OFFICE_OUTPUT_CONFLICT', '修订结果与审批时冻结的摘要不一致。')
  return result
}
export async function executeFrozenOfficeRevision(context: OfficeContext, args: Record<string, unknown>, value: EffectTarget | undefined, signal?: AbortSignal) {
  if (!value || value.kind !== 'office_artifact_revision') officeError('OFFICE_PLAN_MISMATCH', '缺少冻结的Office修订Effect。')
  const target = value, intent = normalizeOfficeIntent(args)
  assertOfficeRevisionIntent(context.meta.id, args)
  if (context.meta.id !== target.sessionId || ['planId', 'planDigest', 'baseArtifactId', 'baseDigest'].some((key) => intent[key as keyof typeof intent] !== target[key as keyof typeof intent])) officeError('OFFICE_PLAN_MISMATCH', '执行参数与冻结预览不一致。')
  if (context.meta.taskStrategy !== 'execute') officeError('OFFICE_SCOPE_MISMATCH', '修订需要执行策略。')
  await verifyProductionProjectMutation(context.rootDir, target.projectId)
  const result = await regenerateFrozenOfficeRevision(context, target)
  assertNotInterrupted(signal)
  await assertOfficeOutputRoot(target)
  await mkdir(dirname(target.workspacePath), { recursive: true, mode: 0o700 })
  await assertOfficeOutputRoot(target)
  assertNotInterrupted(signal)
  // New path only. A partial write remains for reconciliation; never erase or overwrite evidence.
  const handle = await open(target.workspacePath, 'wx', 0o600)
  try { await handle.writeFile(result.bytes); await handle.sync() } finally { await handle.close() }
  return { path: target.workspacePath, digest: target.expectedSha256, planDigest: target.planDigest,
    supersedesId: target.baseArtifactId, lineageId: target.lineageId, version: target.baseVersion + 1,
    status: 'awaiting_canonical_registration', checks: result.checks }
}
export async function assertOfficeOutputRoot(target: OfficeRevisionEffectTarget): Promise<void> {
  const resolved = await resolveWritableProjectPath(target.rootPath, target.workspacePath)
  const root = await lstat(resolved.root)
  if (resolved.root !== target.rootPath || resolved.relativePath !== target.relativePath || resolved.fullPath !== target.workspacePath ||
      String(root.dev) !== target.rootIdentity.device || String(root.ino) !== target.rootIdentity.inode) officeError('OFFICE_OUTPUT_CONFLICT', '审批后输出根目录或路径改变。')
}
function assertNotInterrupted(signal?: AbortSignal): void { if (signal?.aborted) officeError('OFFICE_OUTPUT_CONFLICT', '修订已中断，未写入新稿。') }
function absentOnly(error: NodeJS.ErrnoException): null { if (error.code === 'ENOENT') return null; throw error }
