import { lstat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, isAbsolute } from 'node:path'
import type { SessionMeta } from '../../shared/types'
import type { StudioResultRerunInput, StudioResultRerunPreview, StudioResultRerunFile, StudioResultRerunOutput } from '../../shared/studio-result-rerun-types'
import type { TaskExecutionAuthorityWriteTool } from '../../shared/task-execution-authority-types'
import { createProductionProjectAggregateService } from '../project-aggregate'
import { readTaskSnapshotDatabase } from '../task/task-snapshot'
import { findEventById } from '../task/workflow-ledger-query'
import { findArtifactLifecycle, findArtifactPurge } from '../task/artifact-lifecycle-store'
import { digest } from '../task/workflow-ledger-codec'
import type { WorkflowChangeImpactPlan } from '../task/workflow-change-impact'
import { currentArtifactLineageLeafIds } from '../task/artifact-lineage'
import { TaskExecutionAuthorityStore, taskExecutionAuthorityBindingDigest } from '../permission/task-execution-authority-store'
import { limitedFileExecutionError } from '../permission/limited-file-execution'
import { readCurrentPermissionSettings } from '../settings'
import { resolveWritableProjectPath } from '../utils/safe-project-path'
import { checkStudioResultFiles, observeLocalFile } from './studio-result-file-changes'
import { getProvider, providerIsReady } from '../providers'
import { openProjectWorkspaceCommandService } from '../project-workspace/command-service'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import type { StudioResultRerunConfirmInput, StudioResultRerunResult } from '../../shared/studio-result-rerun-types'

const OFFICE_TOOLS: Record<string, TaskExecutionAuthorityWriteTool> = {
  '.docx': 'create_document', '.xlsx': 'create_spreadsheet', '.pptx': 'create_presentation', '.pdf': 'create_pdf'
}
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.csv', '.json', '.html', '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.sql', '.yaml', '.yml', '.xml', '.svg'])

export function rerunIdentity(sessionId: string, input: StudioResultRerunInput): string {
  return digest({ schema: 'caogen.change-impact-repair.v1', sessionId, planDigest: input.planDigest, workItemId: input.workItemId }).replace(/^sha256:/, '')
}
export function assertRerunInput(input: StudioResultRerunInput): void {
  if (!input || typeof input !== 'object' || typeof input.planDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.planDigest) ||
    typeof input.workItemId !== 'string' || !input.workItemId.trim() || input.workItemId.length > 200) throw new Error('局部重跑需要有效的文件检查版本和工作项。')
}

/** Recompute from canonical change evidence and current bytes; the renderer provides no paths or authority. */
export async function buildStudioResultRerunPreview(root: string, meta: SessionMeta, input: StudioResultRerunInput): Promise<StudioResultRerunPreview> {
  assertRerunInput(input)
  if (!meta.workspaceId || !meta.goalId) throw new Error('局部重跑需要绑定原项目和目标。')
  const checked = await checkStudioResultFiles(meta, root)
  if (checked.planDigest !== input.planDigest) throw new Error('文件检查版本已变化，请重新检查文件并预览。')
  const aggregate = await createProductionProjectAggregateService(root).verifyLiveProject(meta.workspaceId)
  const goal = aggregate.goals.find(value => value.id === meta.goalId)
  const source = aggregate.workItems.find(value => value.id === input.workItemId)
  if (!source || !goal || source.goalId !== goal.id || source.projectId !== meta.workspaceId) throw new Error('受影响工作项不属于原目标。')
  const stored = await readTaskSnapshotDatabase(root, db => {
    const event = findEventById(db, `workflow:change-impact:${input.planDigest}`)
    if (event?.kind !== 'workflow.change-impact.plan.created' || event.projectId !== meta.workspaceId) throw new Error('找不到当前文件检查的影响计划。')
    const plan = event.payload as unknown as WorkflowChangeImpactPlan
    const { planDigest, ...unsigned } = plan
    if (digest(unsigned) !== planDigest) throw new Error('文件变化计划摘要不一致。')
    const artifacts = aggregate.workflow.artifacts
    const heads = currentArtifactLineageLeafIds(artifacts)
    const outputs = artifacts.filter(item => item.workItemId === source.id && heads.has(item.id))
    const selectedIds = [...new Set([...outputs.map(item => item.id), ...plan.changedArtifactIds])]
    return { plan, outputs, files: selectedIds.map(id => {
      const artifact = artifacts.find(item => item.id === id)
      const lifecycle = findArtifactLifecycle(db, id)
      const location = aggregate.workflow.artifactLocations.find(item => item.id === lifecycle?.locationId)
      if (!artifact || !lifecycle || findArtifactPurge(db, id) || lifecycle.storageKind !== 'source_ref' || !lifecycle.sourceRef ||
        lifecycle.projectId !== meta.workspaceId || lifecycle.digest !== artifact.digest || lifecycle.version !== artifact.version ||
        lifecycle.workItemId !== artifact.workItemId || lifecycle.runId !== artifact.runId || !location ||
        location.path !== lifecycle.sourceRef || location.checksum !== artifact.digest) return { id }
      return { id, artifact, path: lifecycle.sourceRef }
    }) }
  })
  const blocked: string[] = []
  if (!stored.plan.rerunWorkItemIds.includes(source.id) || stored.plan.reviewWorkItemIds.includes(source.id)) blocked.push('此项包含人工修改或关系待确认，不能直接重跑。')
  if (stored.plan.unresolvedReferences.length) blocked.push('成果依赖仍有未核验引用，请先处理。')
  if (['archived', 'cancelled', 'failed', 'completed'].includes(goal.status) || ['failed', 'cancelled'].includes(source.status)) blocked.push('原目标或工作项当前不可执行。')
  if (['running', 'starting', 'closed'].includes(meta.status) || meta.taskStrategy !== 'execute') blocked.push('请先暂停原任务并确认执行意图。')
  if (aggregate.workflow.runs.some(run => run.workItemId === source.id && !['completed', 'failed', 'cancelled'].includes(run.status))) blocked.push('受影响工作项仍有未结束运行，请先核对。')
  const identity = rerunIdentity(meta.id, input)
  const outputs: StudioResultRerunOutput[] = [], protectedFiles: StudioResultRerunFile[] = []
  const allowed = new Set<TaskExecutionAuthorityWriteTool>()
  for (const file of stored.files) {
    if (!file.path || !file.artifact) { blocked.push(`成果 ${file.id} 没有可核验的本地文件。`); continue }
    const observed = await observeLocalFile(file.path, 32 * 1024 * 1024)
    if (!('digest' in observed)) { blocked.push(`文件 ${file.artifact.title} 当前不可安全读取。`); continue }
    const value = { artifactId: file.id, title: file.artifact.title, path: file.path, digest: observed.digest }
    if (stored.plan.changedArtifactIds.includes(file.id)) protectedFiles.push(value)
    if (!stored.outputs.some(item => item.id === file.id)) continue
    if (observed.digest !== file.artifact.digest) { blocked.push(`下游文件 ${file.artifact.title} 也有人工作业，请先检查它的变化。`); continue }
    const ext = extname(file.path).toLowerCase(), tool = OFFICE_TOOLS[ext] ?? (TEXT_EXTENSIONS.has(ext) ? 'write_file' : undefined)
    if (!tool) { blocked.push(`当前局部重跑尚未支持 ${ext || '无扩展名'} 文件生成。`); continue }
    const outputPath = join(dirname(file.path), `${basename(file.path, extname(file.path))}.rerun-${identity.slice(0, 12)}${extname(file.path)}`)
    const target = await resolveWritableProjectPath(meta.cwd, outputPath)
    if (await lstat(target.fullPath).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })) blocked.push(`版本输出已存在，请核对原修复任务：${target.relativePath}`)
    const rel = relative(resolve(meta.cwd), file.path)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) { blocked.push('下游文件位于原任务目录之外。'); continue }
    outputs.push({ ...value, outputPath: target.fullPath, relativeOutputPath: target.relativePath })
    allowed.add(tool)
  }
  if (!outputs.length) blocked.push('没有可安全生成新版本的本地输出文件。')
  if (outputs.length > 16) blocked.push('请将此次局部重跑缩小到最多 16 个输出文件。')
  const authority = new TaskExecutionAuthorityStore(root).get(meta)
  if (authority.status !== 'legacy' && !authority.available) blocked.push('原任务文件授权已撤销或失效，请先重新授权。')
  const settings = readCurrentPermissionSettings(root)
  for (const output of outputs) {
    const tool = OFFICE_TOOLS[extname(output.path).toLowerCase()] ?? 'write_file'
    const error = limitedFileExecutionError(settings, tool, { path: output.outputPath }, meta.cwd, { rootDir: root, sessionMeta: meta, sessionId: meta.id })
    if (error) blocked.push(`${output.relativeOutputPath}：${error}`)
  }
  const provider = getProvider(meta.providerId)
  const model = meta.model === 'auto' ? meta.modelRoutingDecision?.model : meta.model
  if (!provider || !providerIsReady(provider) || (provider.engine !== 'openai' && provider.engine !== 'anthropic') || !model || model === 'auto') blocked.push('原任务缺少可继续使用的原生模型连接。')
  const acceptances = stored.plan.acceptanceRechecks.map(recheck => {
    const current = aggregate.workflow.acceptances.find(item => item.id === recheck.acceptanceId)
    if (!current || current.revision !== recheck.nextRevision || current.status !== recheck.nextStatus) blocked.push('文件变化后的验收状态已更新，请重新预览。')
    return { id: recheck.acceptanceId, revision: current?.revision ?? 0, status: current?.status ?? 'missing' }
  })
  const body = { schemaVersion: 1 as const, sessionId: meta.id, projectId: meta.workspaceId, goalId: goal.id,
    sourceWorkItemId: source.id, sourceWorkItemRevision: source.revision, planDigest: input.planDigest,
    repairWorkItemId: `workflow-repair:${identity}`, title: `局部重跑：${source.title}`, objective: source.description ?? source.title,
    constraints: [...goal.constraints, ...goal.forbiddenActions.map(value => `禁止：${value}`)],
    criteria: source.acceptanceSpec.map(value => value.criterion), cwd: meta.cwd, outputs, protectedFiles,
    allowedWriteTools: [...allowed].sort(), authority: { status: authority.status, revision: authority.revision,
      bindingDigest: taskExecutionAuthorityBindingDigest(meta) }, acceptances, providerId: meta.providerId ?? '', model: model ?? '',
    budgetUsd: Math.min(meta.budgetUsd && meta.budgetUsd > 0 ? meta.budgetUsd : 0.5, 0.5),
    state: blocked.length ? 'blocked' as const : 'ready' as const, blockedReasons: [...new Set(blocked)] }
  return { ...body, previewDigest: digest(body) }
}

/**
 * Materialize a confirmed repair WorkItem and start its child Session.  The
 * child receives an independent file authority limited to the preview's
 * generated output paths; the parent grant is never inherited implicitly.
 */
export async function confirmStudioResultRerun(
  root: string,
  meta: SessionMeta,
  input: StudioResultRerunConfirmInput,
  ports: {
    getSession(id: string): { meta: SessionMeta } | undefined
    requireAuthority(id: string): Promise<void>
    createManaged(options: {
      cwd: string
      workspaceId: string
      goalId?: string
      workItemId: string
      parentSessionId: string
      isolated: boolean
      taskStrategy: 'execute'
      experienceModeOverride: 'studio'
      title: string
      providerId?: string
      model?: string
      budgetUsd?: number
    }, lifecycle: { beforeStart(meta: { id: string }): Promise<void> }): Promise<SessionMeta>
    send(id: string, prompt: string): Promise<boolean>
  }
): Promise<StudioResultRerunResult> {
  const preview = await buildStudioResultRerunPreview(root, meta, input)
  if (preview.previewDigest !== input.previewDigest) throw new Error('局部重跑预览已变化，请重新预览后确认。')
  if (preview.state !== 'ready') return { repairWorkItemId: preview.repairWorkItemId, state: 'blocked', reason: preview.blockedReasons.join('；') }

  const commands = await openProjectWorkspaceCommandService(root)
  const existing = await (await openProjectWorkspaceStore(root)).getWorkItem(preview.repairWorkItemId)
  if (existing) {
    if (existing.projectId !== preview.projectId || existing.goalId !== preview.goalId || existing.description !== preview.objective) {
      throw new Error('局部重跑工作项身份冲突，已阻止复用。')
    }
    const active = ports.getSession(existing.id)
    if (active) return { repairWorkItemId: existing.id, sessionId: active.meta.id, state: 'existing' }
    return { repairWorkItemId: existing.id, state: 'existing', reason: '修复工作项已创建，请从任务列表继续。' }
  }
  const repair = await commands.createWorkItem({
    id: preview.repairWorkItemId,
    projectId: preview.projectId,
    goalId: preview.goalId,
    title: preview.title,
    description: preview.objective,
    type: 'delivery',
    status: 'ready',
    priority: 1,
    acceptanceSpec: preview.criteria.map((criterion, index) => ({ id: `${preview.repairWorkItemId}:criterion:${index + 1}`, criterion })),
    artifactRefs: preview.outputs.map(output => output.artifactId),
    dependencyIds: [preview.sourceWorkItemId]
  })
  let childId: string | undefined
  try {
    const child = await ports.createManaged({
      cwd: preview.cwd, workspaceId: preview.projectId, goalId: preview.goalId,
      workItemId: repair.id, parentSessionId: meta.id, isolated: false,
      taskStrategy: 'execute', experienceModeOverride: 'studio', title: preview.title,
      providerId: preview.providerId, model: preview.model, budgetUsd: preview.budgetUsd
    }, {
      beforeStart: async created => {
        childId = created.id
        await ports.requireAuthority(created.id)
        const live = ports.getSession(created.id)?.meta
        if (!live) throw new Error('局部重跑子任务未能建立实时身份。')
        const authority = new TaskExecutionAuthorityStore(root)
        const current = authority.get(live)
        if (!current.bindingDigest) throw new Error('局部重跑子任务缺少授权绑定。')
        const patterns = preview.outputs.map(output => relative(live.cwd, output.outputPath).replace(/\\/g, '/'))
        authority.grant(live, {
          expectedRevision: current.revision,
          expectedBindingDigest: current.bindingDigest,
          allowedWriteTools: preview.allowedWriteTools,
          pathPatterns: patterns
        }, 'local-user:studio-rerun')
      }
    })
    childId = child.id
    const accepted = await ports.send(child.id, [
      '【CaoGen 局部重跑】', `来源工作项：${preview.sourceWorkItemId}`,
      '请根据当前工作区和原任务事实，仅重新生成预览列出的输出文件。',
      `输出文件：${preview.outputs.map(output => output.relativeOutputPath).join('、')}`,
      `验收标准：${preview.criteria.join('；')}`
    ].join('\n'))
    if (!accepted) return { repairWorkItemId: repair.id, sessionId: child.id, state: 'blocked', reason: '局部重跑提示未被任务接受。' }
    return { repairWorkItemId: repair.id, sessionId: child.id, state: 'started' }
  } catch (error) {
    return { repairWorkItemId: repair.id, ...(childId ? { sessionId: childId } : {}), state: 'blocked', reason: error instanceof Error ? error.message : String(error) }
  }
}
