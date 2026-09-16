import type { SessionMeta } from '../../shared/types'
import { taskRuntimeRegistry } from './task-runtime-registry'
import { readTaskSnapshotDatabase } from './task-snapshot'
import { findWorkflowRun } from './workflow-ledger-store'
import { readOfficeRunRequirements } from './office-delivery-requirement-ledger'
import { currentTaskRequirementSource } from './task-plan-requirements'
import { createProductionProjectAggregateService } from '../project-aggregate/project-aggregate-factory'

/** Use the active Run's frozen acceptance, never replace an earlier Run's
 * contract with a later amendment. File references are revision inputs only. */
export async function buildSessionRequirementContext(meta: SessionMeta, root: string): Promise<string> {
  const changed = await currentTaskRequirementSource(meta, root)
  if (!changed) return ''
  const active = taskRuntimeRegistry.get(meta.id)
  if (!active) throw new Error('交付要求修订缺少当前 Run，已阻止使用未绑定的要求')
  const run = await readTaskSnapshotDatabase(root, db => findWorkflowRun(db, active.id))
  if (!run || run.sessionId !== meta.id || run.workItemId !== meta.workItemId || run.goalId !== meta.goalId || run.projectId !== meta.workspaceId) {
    throw new Error('修订要求与当前运行身份不一致')
  }
  const contract = await readOfficeRunRequirements(run, root)
  if (!contract.criteria || contract.binding.reason) throw new Error('当前 Run 的交付要求未绑定，不能继续修订')
  const aggregate = await createProductionProjectAggregateService(root).verifyLiveProject(meta.workspaceId!)
  const family = new Set(aggregate.workItems.filter(item => item.id === changed.item.id ||
    item.id === changed.item.parentId || item.parentId === (changed.item.parentId ?? changed.item.id)).map(item => item.id))
  const files = aggregate.workflow.artifacts.filter(file => file.goalId === meta.goalId &&
    file.workItemId && family.has(file.workItemId)).slice(-24)
  const prompt = ['# Confirmed delivery requirements for this Run',
    `Run: ${run.id}; requirement source: ${contract.binding.contractEventId ?? `${run.acceptanceId} v${run.acceptanceRevision}`}`,
    'Apply these versioned requirements to subsequent work. Earlier conversation may contain superseded requirements. This does not grant any tool or external-action permission.',
    ...contract.criteria.map(text => `- ${text}`),
    '# Existing task artifacts for revision',
    'These files may have failed checks or manual edits. Inspect their current bytes and evidence before changing anything. Preserve previous versions and unrelated human content.',
    ...files.map(file => JSON.stringify({ id: file.id, title: file.title, digest: file.digest,
      locations: aggregate.workflow.artifactLocations.filter(location => location.artifactId === file.id) }))].join('\n')
  if (prompt.length > 120_000) throw new Error('交付要求和成果上下文过大，请先收窄本次修订范围')
  return prompt
}
