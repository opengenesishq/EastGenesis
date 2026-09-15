import type { AppSettings, EffectTarget, SessionMeta } from '../../shared/types'
import type { OfficeRevisionKind } from '../../shared/office-revision-types'
import { getPreparedOfficePlan } from '../office-revision/plans'
import { officeRevisionOutputRelativePath } from '../office-revision/output-path'
import { readCurrentPermissionSettings } from '../settings'
import { createLimitedFileWriteGuard, limitedFileExecutionPolicyError } from './limited-file-execution-policy'
import { TaskExecutionAuthorityStore } from './task-execution-authority-store'
import { evaluateToolPermission } from './tool-permission'

interface TrustedExecutionScope {
  preparation?: boolean; sessionId?: string; effectTarget?: EffectTarget; rootDir?: string
  sessionMeta?: SessionMeta; taskExecutionAuthorityRevision?: number
}

function permissionInput(name: string, input: Record<string, unknown>, scope: TrustedExecutionScope): Record<string, unknown> {
  if (name !== 'revise_office_artifact') return input
  if (scope.effectTarget?.kind === 'office_artifact_revision') return { path: scope.effectTarget.workspacePath }
  if (!scope.sessionId) throw new Error('Office 修订缺少可信会话和输出范围。')
  const prepared = getPreparedOfficePlan(scope.sessionId, input)
  const record = prepared.loaded.record
  return { path: officeRevisionOutputRelativePath(record.kind as OfficeRevisionKind, record.lineageId, record.version, prepared.view.planDigest) }
}

/** Preparation exemption is supplied only after the main-owned preparation grant was validated. */
export function limitedFileExecutionError(settings: AppSettings, name: string, input: Record<string, unknown>, cwd: string, scope: TrustedExecutionScope = {}): string | undefined {
  if (scope.preparation) return undefined
  try {
    const scopedInput = permissionInput(name, input, scope)
    if (scope.sessionMeta) {
      if (!scope.rootDir) throw new Error('任务执行授权缺少可信应用数据目录。')
      new TaskExecutionAuthorityStore(scope.rootDir).assertAllowed(scope.sessionMeta, name, scopedInput, cwd, scope.taskExecutionAuthorityRevision)
    }
    return limitedFileExecutionPolicyError(settings, name, scopedInput, cwd)
  }
  catch (error) { return error instanceof Error ? error.message : String(error) }
}

export function formalFileWriteGuard(name: string, input: Record<string, unknown>, cwd: string, scope: TrustedExecutionScope = {}): () => void {
  if (scope.preparation) return () => undefined
  const scopedInput = permissionInput(name, input, scope)
  const globalGuard = createLimitedFileWriteGuard(() => readCurrentPermissionSettings(scope.rootDir), name, scopedInput, cwd)
  if (!scope.sessionMeta) return globalGuard
  if (!scope.rootDir) throw new Error('任务执行授权缺少可信应用数据目录。')
  const store = new TaskExecutionAuthorityStore(scope.rootDir)
  const meta = scope.sessionMeta
  if (scope.sessionId && scope.sessionId !== meta.id) throw new Error('工具会话身份与任务执行授权不一致。')
  const revision = scope.taskExecutionAuthorityRevision ?? store.get(meta).revision
  return () => {
    globalGuard()
    // A new global deny also wins when global limited-file mode is disabled.
    const global = evaluateToolPermission(readCurrentPermissionSettings(scope.rootDir), { toolName: name, input: scopedInput, cwd })
    if (global.kind === 'deny') throw new Error(global.reason)
    store.assertAllowed(meta, name, scopedInput, cwd, revision)
  }
}
