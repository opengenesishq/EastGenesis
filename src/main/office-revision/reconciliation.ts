import { reconcileOfficeArtifactEffectTarget } from '../agent/tools/office-artifact'
export type { OfficeArtifactReplayTarget } from '../agent/tools/office-artifact'
import { app } from 'electron'
import { lstat } from 'node:fs/promises'
import type { EffectTarget, SessionMeta } from '../../shared/types'
import type { OfficeRevisionEffectTarget } from '../../shared/office-revision-types'
import { confirmed, notApplied, unresolved, type EffectReconciliationResult } from '../task/effect-reconciliation-result'
import { assertOfficeOutputRoot, regenerateFrozenOfficeRevision } from './effect'
import { readBoundOfficeFile } from './scope'

export function frozenOfficeContext(target: OfficeRevisionEffectTarget, rootDir?: string) {
  // This identity is accepted only from an integrity-checked durable Effect, never IPC/tool arguments.
  const meta = { id: target.sessionId, cwd: target.rootPath, workspaceId: target.projectId, workItemId: target.workItemId,
    goalId: target.goalId, businessLineId: target.businessLineId, taskStrategy: 'execute' } as SessionMeta
  return { meta, rootDir: rootDir ?? app.getPath('userData'), historicalRevisionRunId: target.revisionRunId }
}
export async function reconcileOfficeRevisionTarget(target: OfficeRevisionEffectTarget, rootDir?: string): Promise<EffectReconciliationResult> {
  try {
    await assertOfficeOutputRoot(target)
    const stat = await lstat(target.workspacePath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (!stat) return notApplied({ kind: target.kind, state: 'absent' }, '新版本输出尚不存在。')
    await readBoundOfficeFile(target.workspacePath, target.expectedSha256, target.expectedBytes)
    await regenerateFrozenOfficeRevision(frozenOfficeContext(target, rootDir), target, false)
    return confirmed({ kind: target.kind, digest: target.expectedSha256, planDigest: target.planDigest,
      baseArtifactId: target.baseArtifactId, unchangedScopeDigest: target.unchangedScopeDigest }, '精确修订输出和未选内容摘要已核验。')
  } catch (error) {
    return unresolved({ kind: target.kind, reason: error instanceof Error ? error.message : String(error) })
  }
}

export function isOfficeOutputTarget(target: EffectTarget): target is Extract<EffectTarget, { kind: 'office_artifact' | 'office_artifact_revision' }> {
  return target.kind === 'office_artifact' || target.kind === 'office_artifact_revision'
}
export function reconcileOfficeOutputTarget(target: Extract<EffectTarget, { kind: 'office_artifact' | 'office_artifact_revision' }>, rootDir?: string) {
  return target.kind === 'office_artifact' ? reconcileOfficeArtifactEffectTarget(target) : reconcileOfficeRevisionTarget(target, rootDir)
}
