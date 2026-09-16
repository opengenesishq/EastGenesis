import type { EffectRecord, TaskRunRecord } from '../../shared/types'
import type { WorkflowProjectionSource, WorkflowRunRecord } from '../../shared/workflow-types'
import type { OfficeRevisionEffectTarget, OfficeRevisionResult } from '../../shared/office-revision-types'
import { registerCanonicalProducedArtifact } from '../task/artifact-production-boundary'
import { getPersistedArtifactLifecycle } from '../task/artifact-lifecycle-api'
import type { ToolExecResult } from '../agent/tools/tool-types'
import { officeError } from './errors'
import { regenerateFrozenOfficeRevision } from './effect'
import { frozenOfficeContext } from './reconciliation'
import { readBoundOfficeFile } from './scope'
import { checkOfficeDeliveryRequirements } from '../task/office-delivery-requirements'
import { readOfficeRunRequirements, recordOfficeDeliveryRequirements } from '../task/office-delivery-requirement-ledger'

type RevisionEffect = EffectRecord & { target: OfficeRevisionEffectTarget }
export function isConfirmedOfficeRevisionEffect(effect: EffectRecord): effect is RevisionEffect {
  return effect.status === 'confirmed' && effect.target.kind === 'office_artifact_revision'
}
export async function registerOfficeRevisionLifecycle(input: { run: TaskRunRecord; effect: RevisionEffect; workflowRun: WorkflowRunRecord; provenance: WorkflowProjectionSource; rootDir?: string }) {
  const { run, effect, workflowRun, provenance, rootDir } = input, target = effect.target
  if (effect.runId !== run.id || effect.sessionId !== run.sessionId || target.sessionId !== run.sessionId ||
      (target.revisionRunId !== undefined && target.revisionRunId !== run.id) ||
      workflowRun.projectId !== target.projectId || workflowRun.workItemId !== target.workItemId || workflowRun.goalId !== target.goalId) officeError('OFFICE_SCOPE_MISMATCH', 'Office修订Effect归属与canonical Run不同。')
  const artifactId = `artifact:office-revision:${effect.id}`
  const existing = await getPersistedArtifactLifecycle(artifactId, rootDir)
  const content = await readBoundOfficeFile(target.workspacePath, target.expectedSha256, target.expectedBytes)
  const result = await regenerateFrozenOfficeRevision(frozenOfficeContext(target, rootDir), target, false)
  const requirements = await checkOfficeDeliveryRequirements({ workspacePath: target.workspacePath,
    expectedDigest: target.expectedSha256, kind: target.artifactKind, sourceRefs: [], bytes: content,
    ...await readOfficeRunRequirements(workflowRun, rootDir) })
  const registered = await registerCanonicalProducedArtifact({
    lifecycle: { id: artifactId, projectId: target.projectId, goalId: target.goalId, workItemId: target.workItemId,
      runId: workflowRun.id, lineageId: target.lineageId, kind: target.artifactKind, title: target.title,
      version: target.baseVersion + 1, supersedesId: target.baseArtifactId, provenance, mediaType: target.mediaType,
      retention: { mode: 'retain' }, content: { storageKind: 'blob', bytes: content, expectedDigest: target.expectedSha256 },
      metadata: { producer: 'office_revision', effectId: effect.id, planDigest: target.planDigest,
        baseArtifactId: target.baseArtifactId, baseDigest: target.baseDigest, unchangedScopeDigest: target.unchangedScopeDigest, checks: result.checks },
      createdAt: existing?.createdAt ?? effect.terminalAt ?? effect.updatedAt },
    evidence: { id: `evidence:office-revision:${effect.id}`, kind: 'delivery_check', title: `局部修订完整性：${target.title}`,
      summary: '原稿摘要、明确修改范围、保留内容和文件部件已核验。公式重算、语义质量、来源支持和视觉排版未核验。',
      verifier: 'office-revision-preservation', metadata: { checks: result.checks, planDigest: target.planDigest } },
    acceptance: { id: `acceptance:office-revision:${effect.id}`, criterionId: `criterion:office-revision:${effect.id}`,
      criterion: '当前任务的同lineage下一版本只改变已审阅选区，保留原稿和未选内容。', status: 'passed', verifier: 'office-revision-preservation' },
    attachToStage: false
  }, rootDir)
  if (registered.lifecycle.digest !== target.expectedSha256 || registered.lifecycle.supersedesId !== target.baseArtifactId) officeError('OFFICE_OUTPUT_CONFLICT', 'canonical新版本登记结果不匹配。')
  await recordOfficeDeliveryRequirements(registered.lifecycle, requirements, rootDir)
  return registered.lifecycle
}
/** Only called after completeEffect has committed canonical lifecycle + evidence. */
export async function finalizeOfficeRevisionToolResult(exec: ToolExecResult, effect: EffectRecord | null | undefined, rootDir: string): Promise<ToolExecResult> {
  if (!effect || effect.target.kind !== 'office_artifact_revision' || !exec.ok) return exec
  const target = effect.target
  if (effect.status !== 'confirmed') return { ...exec, ok: false, output: `${exec.output}\n新版本尚待对账，不能标记为已应用。` }
  const record = await getPersistedArtifactLifecycle(`artifact:office-revision:${effect.id}`, rootDir)
  if (!record || record.digest !== target.expectedSha256 || record.supersedesId !== target.baseArtifactId) officeError('OFFICE_OUTPUT_CONFLICT', '新版本尚未完成canonical登记。')
  const regenerated = await regenerateFrozenOfficeRevision(frozenOfficeContext(target, rootDir), target, false)
  const result: OfficeRevisionResult = { schemaVersion: 1, artifactId: record.artifactId, digest: record.digest,
    lineageId: record.lineageId, version: record.version, supersedesId: target.baseArtifactId,
    planDigest: target.planDigest, checks: regenerated.checks, status: 'registered' }
  return { ...exec, output: JSON.stringify(result) }
}
