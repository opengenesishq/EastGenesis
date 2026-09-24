import type { SessionMeta, TaskRunRecord, TaskSnapshotRecord } from '../../shared/types'
import type { WorkItem } from '../../shared/project-workspace-types'
import { createProjectWorkspaceCommandService } from '../project-workspace/command-service'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { app } from 'electron'
import { assertSideChatBinding } from '../side-chat/side-chat-policy'

type CanonicalRunSession = Pick<SessionMeta, 'id' | 'workspaceId' | 'goalId' | 'workItemId'> & Partial<SessionMeta>

export type WorkflowRunCanonicalBindingResult =
  | { disposition: 'unscoped' }
  | { disposition: 'existing' | 'attached'; workItem: WorkItem }

export type WorkflowRunCanonicalResolution =
  | { disposition: 'unscoped' }
  | { disposition: 'resolved'; workItem: WorkItem }

export interface WorkflowRunCanonicalBindingRecoveryResult {
  attached: string[]
  existing: string[]
  unscoped: number
  failures: Array<{ runId: string; error: string }>
}

interface CanonicalRunBindingScope {
  workspaceId: string
  workItemId: string
  goalId?: string
}

/**
 * Attach a persisted Workflow Run through the rich ProjectWorkspace command
 * boundary. The TaskRun projector deliberately cannot mutate a canonical
 * WorkItem row because that would invalidate the source revision/digest.
 */
export async function bindWorkflowRunToCanonicalWorkItem(
  meta: CanonicalRunSession,
  run: TaskRunRecord,
  rootDir?: string
): Promise<WorkflowRunCanonicalBindingResult> {
  const resolved = await resolveWorkflowRunCanonicalWorkItem(meta, run, rootDir)
  if (resolved.disposition === 'unscoped') return resolved
  const scope = resolveCanonicalRunBindingScope(meta)!
  const runId = requiredId(run.id, 'runId')

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const store = await openProjectWorkspaceStore(rootDir)
    const commands = createProjectWorkspaceCommandService(store, { rootDir })
    await commands.reconcileShadowProjection()
    const item = attempt === 0 ? resolved.workItem : await requireCanonicalWorkItem(scope, store)
    if (item.runRefs.includes(runId)) return { disposition: 'existing', workItem: item }
    try {
      const updated = await commands.updateWorkItem(
        item.id,
        { runRefs: [...item.runRefs, runId] },
        { expectedRevision: item.revision }
      )
      return { disposition: 'attached', workItem: updated }
    } catch (error) {
      if (attempt < 2 && isStaleRevision(error)) continue
      throw error
    }
  }
  throw new Error(`canonical Run binding retry exhausted:${runId}`)
}

/** Resolve and validate ownership without mutating the canonical WorkItem. */
export async function resolveWorkflowRunCanonicalWorkItem(
  meta: CanonicalRunSession,
  run: TaskRunRecord,
  rootDir?: string
): Promise<WorkflowRunCanonicalResolution> {
  if (meta.sideChat) {
    // A verified side conversation observes its source Workspace, but never
    // becomes an execution Run of that source Goal or WorkItem.
    assertSideChatBinding(meta as SessionMeta, rootDir ?? app.getPath('userData'), { checkSource: false, allowClosed: true })
    if (run.sessionId !== meta.id) throw new Error(`Run ${run.id} crosses session ownership`)
    requiredId(run.id, 'runId')
    return { disposition: 'unscoped' }
  }
  const scope = resolveCanonicalRunBindingScope(meta)
  if (!scope) return { disposition: 'unscoped' }
  if (run.sessionId !== meta.id) throw new Error(`Run ${run.id} crosses session ownership`)
  requiredId(run.id, 'runId')
  const store = await openProjectWorkspaceStore(rootDir)
  return { disposition: 'resolved', workItem: await requireCanonicalWorkItem(scope, store) }
}

async function requireCanonicalWorkItem(
  scope: CanonicalRunBindingScope,
  store: Awaited<ReturnType<typeof openProjectWorkspaceStore>>
): Promise<WorkItem> {
  const item = await store.getWorkItem(scope.workItemId)
  if (!item) throw new Error(`canonical WorkItem does not exist:${scope.workItemId}`)
  if (item.projectId !== scope.workspaceId) {
    throw new Error(`canonical WorkItem crosses Workspace boundary:${scope.workItemId}`)
  }
  if (scope.goalId !== undefined && item.goalId !== scope.goalId) {
    throw new Error(`canonical WorkItem crosses Goal boundary:${scope.workItemId}`)
  }
  return item
}

function resolveCanonicalRunBindingScope(
  meta: Pick<SessionMeta, 'workspaceId' | 'goalId' | 'workItemId'>
): CanonicalRunBindingScope | null {
  const workspaceId = optionalId(meta.workspaceId, 'workspaceId')
  const workItemId = optionalId(meta.workItemId, 'workItemId')
  const goalId = optionalId(meta.goalId, 'goalId')
  if (!workspaceId && !workItemId && !goalId) return null
  if (!workspaceId || !workItemId) throw new Error('canonical Run binding requires workspaceId and workItemId')
  return { workspaceId, workItemId, goalId }
}

export async function recoverWorkflowRunCanonicalBindings(
  snapshots: readonly TaskSnapshotRecord[],
  rootDir?: string
): Promise<WorkflowRunCanonicalBindingRecoveryResult> {
  const result: WorkflowRunCanonicalBindingRecoveryResult = {
    attached: [],
    existing: [],
    unscoped: 0,
    failures: []
  }
  for (const snapshot of snapshots) {
    if (!snapshot.run) continue
    try {
      const bound = await bindWorkflowRunToCanonicalWorkItem(snapshot.meta, snapshot.run, rootDir)
      if (bound.disposition === 'unscoped') result.unscoped += 1
      else result[bound.disposition].push(snapshot.run.id)
    } catch (error) {
      result.failures.push({
        runId: snapshot.run.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return result
}

function isStaleRevision(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'stale_revision')
}

function optionalId(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined
  return requiredId(value, label)
}

function requiredId(value: string, label: string): string {
  const clean = value.trim()
  if (!clean || clean.length > 256 || /[\0-\x1f\x7f]/.test(clean)) throw new Error(`${label} is invalid`)
  return clean
}
