import { randomUUID } from 'node:crypto'
import type { CreateSessionOptions, SessionMeta } from '../../shared/types'
import type { WorkItem, WorkItemInput } from '../../shared/project-workspace-types'
import type { StudioResultRerunConfirmInput, StudioResultRerunPreview, StudioResultRerunResult } from '../../shared/studio-result-rerun-types'
import type { ManagedSessionCreationOptions } from '../session-manager-support'
import type { SessionInputService } from '../task/session-input-service'
import { withSessionOperationQueue } from '../session-operation-queue'
import { withDataLifecycleMutation } from '../data-lifecycle/data-lifecycle-mutation-lock'
import { openProjectWorkspaceCommandService } from '../project-workspace/command-service'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { readTaskSnapshotDatabase, mutateTaskSnapshotDatabase } from '../task/task-snapshot'
import { findEventById } from '../task/workflow-ledger-query'
import { appendWorkflowEvent } from '../task/workflow-ledger-store'
import { digest } from '../task/workflow-ledger-codec'
import { ensureRepairWorkItemRunnable } from '../task/workflow-acceptance-repair-runtime'
import { ensureWorkflowRepairAcceptance } from '../task/workflow-acceptance-repair-service'
import { WORKFLOW_REPAIR_DEFAULT_OWNER } from '../task/workflow-acceptance-repair-coordinator'
import { TaskExecutionAuthorityStore, taskExecutionAuthorityBindingDigest } from '../permission/task-execution-authority-store'
import { assertTaskExecutionAuthoritySessionActive } from '../permission/task-execution-authority-lifecycle'
import { normalizeTaskExecutionAuthorityScope } from '../permission/task-execution-authority-policy'
import { assertPersistedSessionDomainOwnership } from '../session-create-lifecycle'
import { buildStudioResultRerunPreview, assertRerunInput, rerunIdentity } from './studio-result-rerun-preview'

export interface StudioResultRerunRuntime {
  getSession(id: string): { meta: SessionMeta } | undefined
  /** Includes active Sessions, history, task snapshots and pending creation journals. */
  identities(): Promise<readonly Partial<SessionMeta>[]>
  requireAuthority(id: string): Promise<void>
  createManaged(options: CreateSessionOptions, lifecycle: ManagedSessionCreationOptions): Promise<SessionMeta>
  inputs: Pick<SessionInputService, 'queue' | 'apply' | 'list'>
}

interface RerunReservation {
  schemaVersion: 1
  sessionId: string
  inputId: string
  actorId: string
  preview: StudioResultRerunPreview
}

/** One confirmation owns one canonical repair and one reserved Session, including after restart. */
export function confirmStudioResultRerun(root: string, source: SessionMeta, input: StudioResultRerunConfirmInput,
  runtime: StudioResultRerunRuntime, actorId: string): Promise<StudioResultRerunResult> {
  assertRerunInput(input)
  if (!/^[a-f0-9]{64}$/.test(input.previewDigest) || !/^local-user:.+/.test(actorId)) throw new Error('局部重跑确认身份无效。')
  return withSessionOperationQueue(`studio-rerun:${root}:${rerunIdentity(source.id, input)}`, async () => {
    // Only preparation and local authority writes hold the lifecycle lock; send uses the existing input receipt path.
    const prepared = await withSessionOperationQueue(source.id, () => withDataLifecycleMutation(root,
      () => prepareRerun(root, source, input, runtime, actorId)))
    if ('state' in prepared) return prepared
    const { reservation } = prepared
    const { preview, sessionId, inputId } = reservation
    try {
      const payload = { text: buildStudioResultRerunPrompt(preview) }
      const queued = await runtime.inputs.queue(sessionId, inputId, payload)
      if (queued.phase !== 'queued') return receiptResult(reservation, queued.phase, queued.error)
      // The private grant is never reconstructed after revocation or restore.
      const child = runtime.getSession(sessionId)?.meta
      if (child) assertChildIdentity(child, reservation)
      if (!child || !new TaskExecutionAuthorityStore(root).get(child).available) {
        return { repairWorkItemId: preview.repairWorkItemId, sessionId, state: 'awaiting_authorization', reason: '子任务文件授权已失效，请在原子任务重新授权。' }
      }
      const receipt = await runtime.inputs.apply(sessionId, inputId)
      return receiptResult(reservation, receipt.phase, receipt.error, true)
    } catch (error) {
      return reconciliation(reservation, error instanceof Error ? error.message : String(error))
    }
  })
}

async function prepareRerun(root: string, source: SessionMeta, input: StudioResultRerunConfirmInput,
  runtime: StudioResultRerunRuntime, actorId: string): Promise<StudioResultRerunResult | { reservation: RerunReservation }> {
  const identity = rerunIdentity(source.id, input)
  const eventId = `studio-rerun:confirmed:${identity}`
  const prior = await readTaskSnapshotDatabase(root, db => {
    const event = findEventById(db, eventId)
    if (!event) return undefined
    const value = event.payload as unknown as RerunReservation
    const { previewDigest, ...body } = value.preview ?? {}
    if (value.schemaVersion !== 1 || event.kind !== 'workflow.studio.rerun.confirmed' ||
        value.preview?.sessionId !== source.id || value.preview.planDigest !== input.planDigest ||
        value.preview.sourceWorkItemId !== input.workItemId || value.preview.previewDigest !== input.previewDigest ||
        value.preview.repairWorkItemId !== `workflow-repair:${identity}` || digest(body) !== previewDigest ||
        event.projectId !== value.preview.projectId || event.goalId !== value.preview.goalId ||
        event.workItemId !== input.workItemId || !/^[a-f0-9-]{36}$/.test(value.sessionId) ||
        value.inputId !== `studio-rerun-${identity}` || !/^local-user:.+/.test(value.actorId)) throw new Error('局部重跑确认记录与原任务不一致。')
    return value
  })
  if (prior) {
    const receipts = await runtime.inputs.list(prior.sessionId)
    const receipt = receipts.find(record => record.id === prior.inputId)
    if (receipt) {
      if (receipt.sessionId !== prior.sessionId || receipt.workItemId !== prior.preview.repairWorkItemId ||
          receipt.workspaceId !== prior.preview.projectId || receipt.goalId !== prior.preview.goalId ||
          digest(receipt.payload) !== digest({ text: buildStudioResultRerunPrompt(prior.preview) })) throw new Error('修复任务接收记录与原确认不一致。')
      if (receipt.phase !== 'queued') return receiptResult(prior, receipt.phase, receipt.error)
    }
  }
  const meta = runtime.getSession(source.id)?.meta
  if (!meta || taskExecutionAuthorityBindingDigest(meta) !== taskExecutionAuthorityBindingDigest(source)) throw new Error('原任务身份已变化，请重新预览。')
  assertTaskExecutionAuthoritySessionActive(root, meta)
  await assertPersistedSessionDomainOwnership(meta, root)
  const preview = await buildStudioResultRerunPreview(root, meta, input)
  if (preview.previewDigest !== input.previewDigest) throw new Error('局部重跑预览已变化，请重新预览后确认。')
  if (preview.state !== 'ready') return { repairWorkItemId: preview.repairWorkItemId, state: 'blocked', reason: preview.blockedReasons.join('；') }
  const reservation = prior ?? { schemaVersion: 1 as const, sessionId: randomUUID(), inputId: `studio-rerun-${identity}`, actorId, preview }
  if (!prior) await mutateTaskSnapshotDatabase(root, db => appendWorkflowEvent(db, {
    eventId, streamId: preview.sourceWorkItemId, entityType: 'work_item', entityId: preview.sourceWorkItemId,
    kind: 'workflow.studio.rerun.confirmed', payload: JSON.parse(JSON.stringify(reservation))
  }, { projectId: preview.projectId, goalId: preview.goalId, workItemId: preview.sourceWorkItemId, sessionId: meta.id }))

  const store = await openProjectWorkspaceStore(root), commands = await openProjectWorkspaceCommandService(root)
  const sourceWork = await store.getWorkItem(preview.sourceWorkItemId)
  if (!sourceWork) throw new Error('原工作项已不存在。')
  const workInput = repairInput(preview, sourceWork)
  let work = await store.getWorkItem(preview.repairWorkItemId)
  if (work) assertRepairBinding(work, workInput)
  else if (prior) {
    const attempted = await readTaskSnapshotDatabase(root, db => findEventById(db, `studio-rerun:creating:${identity}`))
    if (attempted) return reconciliation(reservation, '原修复任务已移除，不能重新派发。')
    work = await commands.createWorkItem(workInput)
  } else work = await commands.createWorkItem(workInput)

  const known = await runtime.identities()
  const candidates = known.filter(item => item.id === reservation.sessionId || item.workItemId === work!.id)
  if (candidates.some(item => item.id !== reservation.sessionId)) return reconciliation(reservation, '此修复项存在其他子任务身份，请核对记录。')
  for (const candidate of candidates) assertChildIdentity(candidate, reservation)
  let child = runtime.getSession(reservation.sessionId)?.meta
  let createdHere = false
  if (!child) {
    const attempted = await readTaskSnapshotDatabase(root, db => findEventById(db, `studio-rerun:creating:${identity}`))
    if (attempted || candidates.length) return reconciliation(reservation, '原子任务已保存或创建结果未知，请恢复原任务；不会重复创建。')
    await ensureWorkflowRepairAcceptance(work, root)
    work = await ensureRepairWorkItemRunnable(root, work)
    if (work.status !== 'running') return { repairWorkItemId: work.id, state: 'blocked', reason: `修复工作项不可执行：${work.status}` }
    await mutateTaskSnapshotDatabase(root, db => appendWorkflowEvent(db, {
      eventId: `studio-rerun:creating:${identity}`, streamId: work!.id, entityType: 'work_item', entityId: work!.id,
      kind: 'workflow.studio.rerun.session.creating', payload: { sessionId: reservation.sessionId, previewDigest: preview.previewDigest }, causationId: eventId
    }, { projectId: preview.projectId, goalId: preview.goalId, workItemId: work!.id, sessionId: reservation.sessionId }))
    try {
      child = await runtime.createManaged({ cwd: preview.cwd, workspaceId: preview.projectId, goalId: preview.goalId,
        workItemId: work.id, businessLineId: work.businessLineId, parentSessionId: meta.id, isolated: false,
        taskStrategy: 'execute', experienceModeOverride: 'studio', title: preview.title, routingScope: 'fixed',
        providerId: preview.providerId, model: preview.model, budgetUsd: preview.budgetUsd
      }, { reservedSessionId: reservation.sessionId, awaitStart: true,
        beforeStart: created => runtime.requireAuthority(created.id) })
      createdHere = true
    } catch (error) { return reconciliation(reservation, error instanceof Error ? error.message : String(error)) }
  }
  assertChildIdentity(child, reservation)
  if (child.status !== 'idle') return reconciliation(reservation, '子任务当前不可接收重跑要求，请核对原任务运行记录。')
  const fresh = await buildStudioResultRerunPreview(root, runtime.getSession(source.id)!.meta, input)
  if (fresh.previewDigest !== preview.previewDigest) throw new Error('创建子任务期间原文件或授权已变化，请重新预览。')
  await runtime.requireAuthority(child.id)
  child = runtime.getSession(child.id)!.meta
  assertChildIdentity(child, reservation)
  await assertPersistedSessionDomainOwnership(child, root)
  child = runtime.getSession(child.id)!.meta
  assertChildIdentity(child, reservation)
  const authority = new TaskExecutionAuthorityStore(root), current = authority.get(child)
  const expectedScope = normalizeTaskExecutionAuthorityScope({ allowedWriteTools: preview.allowedWriteTools,
    pathPatterns: preview.outputs.map(output => output.relativeOutputPath), allowedCommandPatterns: [] })
  if (current.revision === 0 && createdHere) {
    authority.grant(child, { expectedRevision: 0, expectedBindingDigest: taskExecutionAuthorityBindingDigest(child), ...expectedScope }, actorId)
  } else if (!current.available || digest([current.allowedWriteTools, current.pathPatterns, current.allowedCommandPatterns]) !==
      digest([expectedScope.allowedWriteTools, expectedScope.pathPatterns, expectedScope.allowedCommandPatterns])) {
    return { repairWorkItemId: work.id, sessionId: child.id, state: 'awaiting_authorization', reason: '子任务授权已撤销或范围已变更，请在原子任务核对；不会自动重授。' }
  }
  return { reservation }
}

function repairInput(preview: StudioResultRerunPreview, source: WorkItem): WorkItemInput {
  return { id: preview.repairWorkItemId, projectId: preview.projectId, goalId: preview.goalId, parentId: source.id,
    businessLineId: source.businessLineId, title: preview.title, description: preview.objective, type: 'delivery', status: 'ready',
    owner: WORKFLOW_REPAIR_DEFAULT_OWNER, priority: source.priority, dependencyIds: [],
    acceptanceSpec: [...preview.criteria, '保留人工修改文件，输出到已确认的新版本路径，提交可核验成果。'].map((criterion, index) =>
      ({ id: `${preview.repairWorkItemId}:criterion:${index + 1}`, criterion, required: true })), artifactRefs: [] }
}
function assertRepairBinding(actual: WorkItem, expected: WorkItemInput): void {
  const fields = ['id', 'projectId', 'goalId', 'parentId', 'businessLineId', 'title', 'description', 'type', 'dependencyIds', 'acceptanceSpec'] as const
  if (fields.some(key => digest(actual[key] ?? null) !== digest(expected[key] ?? null))) throw new Error('局部重跑工作项身份冲突，已阻止复用。')
}
function assertChildIdentity(child: Partial<SessionMeta>, reservation: RerunReservation): void {
  const p = reservation.preview
  if (child.id !== reservation.sessionId || child.workspaceId !== p.projectId || child.goalId !== p.goalId ||
      child.workItemId !== p.repairWorkItemId || child.parentSessionId !== p.sessionId || child.cwd !== p.cwd ||
      child.taskStrategy !== 'execute' || child.providerId !== p.providerId || child.model !== p.model) throw new Error('局部重跑子任务身份与确认记录不一致。')
}
function reconciliation(r: RerunReservation, reason: string): StudioResultRerunResult {
  return { repairWorkItemId: r.preview.repairWorkItemId, sessionId: r.sessionId, state: 'needs_reconciliation', reason }
}
function receiptResult(r: RerunReservation, phase: string, reason?: string, started = false): StudioResultRerunResult {
  if (phase === 'applied') return { repairWorkItemId: r.preview.repairWorkItemId, sessionId: r.sessionId, state: started ? 'started' : 'existing' }
  return reconciliation(r, reason ?? '重跑要求已经提交或撤回，请核对原任务记录；不会自动重发。')
}
export function buildStudioResultRerunPrompt(p: StudioResultRerunPreview): string {
  return ['【CaoGen 局部重跑】', `原工作项：${p.sourceWorkItemId}`, `目标：${p.objective}`,
    '按当前资料更新受影响成果，只能写入下列已授权的新版本路径。不得覆盖原成果或人工修改文件。',
    `约束：\n${p.constraints.join('\n')}`, `验收标准：\n${p.criteria.join('\n')}`,
    `原成果与新输出：\n${p.outputs.map(file => `${file.path} (${file.digest}) -> ${file.outputPath}`).join('\n')}`,
    `保留并读取人工修改：\n${p.protectedFiles.map(file => `${file.path} (${file.digest})`).join('\n')}`,
    '完成后登记新成果与可核验依据。缺少资料或权限时停止并说明，不得编造完成。'].join('\n\n')
}
