import type {
  WorkflowAcceptanceRecord,
  WorkflowAcceptanceRepairStartResult
} from '../../shared/workflow-types'
import type { WorkItem } from '../../shared/project-workspace-types'
import type { TaskSnapshotRecord } from '../../shared/types'
import { openProjectWorkspaceCommandService } from '../project-workspace/command-service'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { WORKFLOW_REPAIR_DEFAULT_OWNER } from './workflow-acceptance-repair-coordinator'

const LEASE_DURATION_MS = 30 * 60 * 1_000

function repairExecutionLeaseId(workItemId: string): string {
  return `workflow-repair-lease:${workItemId}`
}

export interface WorkflowAcceptanceRepairRuntimePort {
  rootDir: string
  activeSessionForWorkItem(workItemId: string): { id: string; status: string } | undefined
  snapshots(): Promise<TaskSnapshotRecord[]>
  createManaged(options: {
    cwd: string
    workspaceId: string
    goalId?: string
    workItemId: string
    isolated: boolean
    taskStrategy: 'execute'
    experienceModeOverride: 'studio'
    title: string
  }, lifecycle: { beforeStart(meta: { id: string }): Promise<void> }): Promise<{ id: string }>
  send(sessionId: string, prompt: string): Promise<boolean>
}

/** Make one deterministic repair WorkItem runnable without replacing its identity. */
export async function ensureRepairWorkItemRunnable(
  rootDir: string,
  initial: WorkItem
): Promise<WorkItem> {
  let item = initial
  const commands = await openProjectWorkspaceCommandService(rootDir)
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const now = Date.now()
    try {
      if (!item.owner) {
        item = await commands.updateWorkItem(item.id, { owner: WORKFLOW_REPAIR_DEFAULT_OWNER }, { expectedRevision: item.revision })
        continue
      }
      if (item.status === 'blocked') {
        item = await commands.transitionWorkItem(item.id, 'ready', { expectedRevision: item.revision })
        continue
      }
      if (item.status === 'ready') {
        if (!item.lease || item.lease.expiresAt <= now) {
          item = await commands.acquireWorkItemLease(item.id, {
            expectedRevision: item.revision,
            leaseId: repairExecutionLeaseId(item.id),
            ownerId: item.owner.id,
            durationMs: LEASE_DURATION_MS
          })
          continue
        }
        item = await commands.transitionWorkItem(item.id, 'running', { expectedRevision: item.revision })
        continue
      }
      if (item.status === 'running' && (!item.lease || item.lease.expiresAt <= now)) {
        item = await commands.acquireWorkItemLease(item.id, {
          expectedRevision: item.revision,
          leaseId: repairExecutionLeaseId(item.id),
          ownerId: item.owner?.id ?? WORKFLOW_REPAIR_DEFAULT_OWNER.id,
          durationMs: LEASE_DURATION_MS
        })
        continue
      }
      return item
    } catch (error) {
      if (isStaleRevision(error)) {
        const refreshed = await (await openProjectWorkspaceStore(rootDir)).getWorkItem(item.id)
        if (refreshed) { item = refreshed; continue }
      }
      throw error
    }
  }
  throw new Error(`workflow repair WorkItem runnable transition exhausted:${item.id}`)
}

export async function startWorkflowAcceptanceRepair(
  port: WorkflowAcceptanceRepairRuntimePort,
  acceptance: WorkflowAcceptanceRecord,
  repair: WorkItem,
  prompt: string
): Promise<WorkflowAcceptanceRepairStartResult> {
  const active = port.activeSessionForWorkItem(repair.id)
  if (active) return { workItemId: repair.id, disposition: 'existing', sessionId: active.id }

  const snapshots = await port.snapshots()
  const persisted = snapshots.find((snapshot) =>
    snapshot.meta.workItemId === repair.id && snapshot.run &&
    !['completed', 'failed', 'cancelled'].includes(snapshot.run.status))
  if (persisted) {
    return {
      workItemId: repair.id,
      disposition: 'existing',
      sessionId: persisted.sessionId,
      reason: 'existing recoverable repair Session'
    }
  }

  let sessionId: string | undefined
  try {
    const runnable = await ensureRepairWorkItemRunnable(port.rootDir, repair)
    if (runnable.status === 'verifying') {
      return {
        workItemId: repair.id,
        disposition: 'blocked',
        reason: 'repair WorkItem is awaiting its Acceptance review'
      }
    }
    if (runnable.status !== 'running') {
      return {
        workItemId: repair.id,
        disposition: 'blocked',
        reason: `repair WorkItem is not runnable:${runnable.status}`
      }
    }
    const cwd = await resolveRepairCwd(port.rootDir, runnable.projectId)
    const meta = await port.createManaged({
      cwd,
      workspaceId: runnable.projectId,
      ...(runnable.goalId ? { goalId: runnable.goalId } : {}),
      workItemId: runnable.id,
      isolated: false,
      taskStrategy: 'execute',
      experienceModeOverride: 'studio',
      title: `返工: ${acceptance.id}`
    }, {
      beforeStart: async (created) => { sessionId = created.id }
    })
    const accepted = await port.send(meta.id, prompt)
    if (!accepted) {
      return { workItemId: repair.id, disposition: 'blocked', sessionId: meta.id, reason: 'repair prompt was rejected' }
    }
    return { workItemId: repair.id, disposition: 'started', sessionId: sessionId ?? meta.id }
  } catch (error) {
    if (sessionId === undefined) {
      try {
        await compensateRepairStartFailure(port.rootDir, repair.id)
      } catch (compensationError) {
        throw new AggregateError(
          [error, compensationError],
          `workflow repair start and lease compensation failed:${repair.id}`
        )
      }
    }
    throw error
  }
}

async function compensateRepairStartFailure(rootDir: string, workItemId: string): Promise<void> {
  const store = await openProjectWorkspaceStore(rootDir)
  const commands = await openProjectWorkspaceCommandService(rootDir)
  let item = await store.getWorkItem(workItemId)
  for (let attempt = 0; item && attempt < 6; attempt += 1) {
    if (item.status === 'done' || item.status === 'failed' || item.status === 'cancelled' ||
        item.status === 'verifying' || item.status === 'waiting_approval') return
    if (item.lease?.id !== repairExecutionLeaseId(workItemId)) return
    try {
      if (item.status === 'running') {
        item = await commands.transitionWorkItem(item.id, 'blocked', { expectedRevision: item.revision })
        continue
      }
      item = await commands.releaseWorkItemLease(item.id, {
        expectedRevision: item.revision,
        leaseId: item.lease.id,
        ownerId: item.lease.ownerId,
        fencingToken: item.lease.fencingToken
      })
    } catch (error) {
      if (!isStaleRevision(error)) throw error
      item = await store.getWorkItem(workItemId)
    }
  }
  if (item?.lease?.id === repairExecutionLeaseId(workItemId)) {
    throw new Error(`workflow repair start lease compensation exhausted:${workItemId}`)
  }
}

export function buildWorkflowAcceptanceRepairPrompt(
  failed: WorkflowAcceptanceRecord,
  repair: WorkItem
): string {
  const criteria = repair.acceptanceSpec.map((criterion, index) => `${index + 1}. ${criterion.criterion}`).join('\n')
  return [
    '【EastGenesis 自动返工】',
    `失败 Acceptance: ${failed.id} revision ${failed.revision}`,
    `当前 repair WorkItem: ${repair.id}`,
    '请检查当前工作区并完成返工，不要重复已经完成的修改。',
    '完成后必须留下可核验的代码/文件产物和测试或审查证据；不要声称未验证的结果。',
    '返工验收标准:',
    criteria
  ].join('\n')
}

async function resolveRepairCwd(rootDir: string, projectId: string): Promise<string> {
  const { resolveWorkspaceSessionCwd } = await import('../project-workspace/workspace-session-cwd.js')
  return resolveWorkspaceSessionCwd(projectId, rootDir)
}

function isStaleRevision(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error &&
    (error as { code?: unknown }).code === 'stale_revision')
}
