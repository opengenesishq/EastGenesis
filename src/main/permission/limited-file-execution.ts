import type { AppSettings, EffectTarget } from '../../shared/types'
import type { OfficeRevisionKind } from '../../shared/office-revision-types'
import { getPreparedOfficePlan } from '../office-revision/plans'
import { officeRevisionOutputRelativePath } from '../office-revision/output-path'
import { readCurrentPermissionSettings } from '../settings'
import { createLimitedFileWriteGuard, limitedFileExecutionPolicyError } from './limited-file-execution-policy'

interface TrustedExecutionScope { preparation?: boolean; sessionId?: string; effectTarget?: EffectTarget; rootDir?: string }

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
  if (scope.preparation || !settings.limitedFileExecutionEnabled) return undefined
  try { return limitedFileExecutionPolicyError(settings, name, permissionInput(name, input, scope), cwd) }
  catch (error) { return error instanceof Error ? error.message : String(error) }
}

export function formalFileWriteGuard(name: string, input: Record<string, unknown>, cwd: string, scope: TrustedExecutionScope = {}): () => void {
  if (scope.preparation) return () => undefined
  return createLimitedFileWriteGuard(() => readCurrentPermissionSettings(scope.rootDir), name, permissionInput(name, input, scope), cwd)
}
