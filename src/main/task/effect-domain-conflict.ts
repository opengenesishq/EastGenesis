import { resolve } from 'node:path'
import type { EffectTarget } from '../../shared/types'

/** Domain identities supplement filesystem overlap; Office versions share their lineage lock. */
export function domainEffectTargetsConflict(left: EffectTarget, right: EffectTarget): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'migration_operation' && right.kind === 'migration_operation') {
    if (left.backupRef && right.backupRef) return left.backupRef === right.backupRef
    return Boolean(left.backupRoot && right.backupRoot && resolve(left.backupRoot) === resolve(right.backupRoot))
  }
  if (left.kind === 'project_portable_export' && right.kind === 'project_portable_export') return left.projectId === right.projectId
  if (left.kind === 'provider_profile_operation') return true
  if (left.kind === 'media_job_operation' && right.kind === 'media_job_operation') return left.mediaJobId === right.mediaJobId
  return officeLineagesConflict(left, right)
}
function officeLineagesConflict(left: EffectTarget, right: EffectTarget): boolean {
  return left.kind === 'office_artifact_revision' && right.kind === 'office_artifact_revision' &&
    left.projectId === right.projectId && left.lineageId === right.lineageId
}
