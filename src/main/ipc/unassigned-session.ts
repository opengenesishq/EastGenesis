import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import type { CreateSessionOptions } from '../../shared/types'
import { sessionManager } from '../sessionManager'
import { ensureManagedPersonalWorkspace } from '../project-workspace/managed-personal-workspace'
import { listHistory } from '../history'
import { getSettings } from '../settings'
import { resolveSelectedBusinessLine } from '../../shared/business-line-types'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import type { ManagedSessionCreationOptions } from '../session-manager-support'
import { parseSessionConversationSource } from '../session-conversation-source'
import { TaskKernel } from '../task/task-kernel'

export async function createUnassignedSession(
  options: CreateSessionOptions
): ReturnType<typeof sessionManager.createManaged> {
  parseSessionConversationSource(options)
  const managed = await ensureManagedPersonalWorkspace(app.getPath('userData'))
  const canonical = await canonicalOwnership(options, managed.workspace.id, managed.cwd)
  return sessionManager.createManaged({
    ...options,
    ...(canonical.businessLineId ? { businessLineId: canonical.businessLineId } : {}),
    cwd: managed.cwd,
    isolated: false,
    unassigned: true,
    // The no-project entrypoint owns the managed personal Workspace.  A
    // stale/forged legacy projectId must never survive the boundary and make
    // the Session appear project-owned while its canonical Goal/WorkItem live
    // in Personal Workspace.
    projectId: undefined,
    workspaceId: managed.workspace.id,
    goalId: canonical.goalId,
    workItemId: canonical.workItemId,
    personalWorkspaceId: managed.workspace.id
  }, canonical.lifecycle)
}

interface CanonicalOwnership {
  goalId: string
  workItemId: string
  businessLineId?: string
  lifecycle: ManagedSessionCreationOptions
}

/**
 * Give the legacy "unassigned" entrypoint a real personal Workspace task.
 * The unassigned bit remains a presentation/experience hint; canonical
 * ownership is still validated and bound to the managed personal Workspace.
 */
async function canonicalOwnership(options: CreateSessionOptions, workspaceId: string, cwd: string): Promise<CanonicalOwnership> {
  const resumeId = options.resumeSdkSessionId?.trim()
  const forkId = options.forkFromSdkSessionId?.trim()
  const history = resumeId || forkId
    ? listHistory().find((entry) => entry.sdkSessionId === (resumeId ?? forkId))
    : undefined
  // The legacy no-project entrypoint used to omit this field when creating the
  // canonical task. `createProjectGoalTask` then defaulted it to `studio`, while
  // Session routing resolved the selected line (or the source line on a fork).
  // Resolve one durable line before either record is created so Session and
  // WorkItem cannot diverge.
  const businessLineId = options.businessLineId ?? history?.businessLineId ?? resolveSelectedBusinessLine(getSettings()).id
  const persistedBusinessLineId = history?.workItemId
    ? await canonicalWorkItemBusinessLine(workspaceId, history.workItemId, history.businessLineId)
    : undefined
  assertHistoricalBusinessLine(options.businessLineId, history?.businessLineId, persistedBusinessLineId)

  if (resumeId) {
    if (!history) throw new Error(`未找到 sdkSessionId 对应的历史会话:${resumeId}`)
    // A legacy unassigned history has no safe objective/identity to migrate.
    // Refuse recovery rather than silently creating a second canonical task.
    if (history.workspaceId !== workspaceId || !history.goalId || !history.workItemId) {
      throw new Error('无法安全恢复无项目会话：历史记录缺少 managed personal Workspace Goal/WorkItem 归属')
    }
    return { goalId: history.goalId, workItemId: history.workItemId, businessLineId: persistedBusinessLineId ?? history.businessLineId, lifecycle: {} }
  }

  if (forkId && !history) {
    // Validate the source before publishing a new canonical Goal/WorkItem.
    // Otherwise a typo or stale fork id would leave an unreachable task in
    // the managed personal Workspace when the normal session validator later
    // rejects the fork request.
    throw new Error(`未找到 sdkSessionId 对应的分叉来源:${forkId}`)
  }
  if (forkId && history && !isPersonalWorkspaceHistory(history, workspaceId)) {
    // A personal/unassigned fork must never copy a source conversation from a
    // different canonical Workspace. Reject before creating any new task so
    // the failed request cannot orphan a Goal/WorkItem in Personal Workspace.
    throw new Error('无法分叉无项目会话：来源会话属于其他 Workspace')
  }

  // A fork of an already-canonical personal conversation remains in the same
  // Goal/WorkItem. The Session/Run is still new, while reusing the immutable
  // task boundary avoids conflicting with the source history ownership.
  if (forkId && history && isPersonalWorkspaceHistory(history, workspaceId) && history.goalId && history.workItemId) {
    return { goalId: history.goalId, workItemId: history.workItemId, businessLineId: persistedBusinessLineId ?? history.businessLineId, lifecycle: {} }
  }

  const reservedSessionId = randomUUID()
  const requestSeed = forkId
    ? `fork:${forkId}:${options.forkCheckpointId?.trim() ?? 'root'}`
    : `session:${reservedSessionId}`
  const requestId = `unassigned:${createHash('sha256').update(requestSeed).digest('hex')}`
  const rawObjective = options.initialPrompt?.trim() || options.title?.trim() || 'Assistant session'
  const objective = rawObjective.length >= 20 ? rawObjective : `Assistant conversation: ${rawObjective}`
  const kernel = new TaskKernel(app.getPath('userData'))
  const task = await kernel.create({
    rootDir: app.getPath('userData'),
    requestId,
    objective,
    businessLineId,
    workspaceId,
    cwd,
    deferExecution: true
  })
  const planned = await kernel.plan(task)
  return {
    goalId: planned.goalId,
    workItemId: planned.workItemId,
    businessLineId: planned.businessLineId,
    lifecycle: forkId ? {} : { reservedSessionId }
  }
}

function assertHistoricalBusinessLine(
  requestedBusinessLineId: string | undefined,
  historicalBusinessLineId: string | undefined,
  persistedBusinessLineId: string | undefined
): void {
  const requested = requestedBusinessLineId?.trim()
  const canonical = persistedBusinessLineId ?? historicalBusinessLineId
  if (requested && canonical && requested !== canonical) {
    throw new Error('无法恢复无项目会话：请求业务线与历史 canonical WorkItem 不一致')
  }
  if (historicalBusinessLineId && persistedBusinessLineId && historicalBusinessLineId !== persistedBusinessLineId) {
    throw new Error('无法恢复无项目会话：历史业务线与 canonical WorkItem 不一致')
  }
}

function isPersonalWorkspaceHistory(
  history: { workspaceId?: string; personalWorkspaceId?: string; projectId?: string },
  workspaceId: string
): boolean {
  const sourceWorkspaceId = history.workspaceId ?? history.personalWorkspaceId
  if (sourceWorkspaceId) return sourceWorkspaceId === workspaceId
  // A legacy entry without canonical workspace metadata is only safe to fork
  // when it has no separate project claim. Otherwise a no-project fork could
  // silently copy a project conversation into the managed personal Workspace.
  return !history.projectId || history.projectId === workspaceId
}

async function canonicalWorkItemBusinessLine(
  workspaceId: string,
  workItemId: string,
  historicalBusinessLineId?: string
): Promise<string | undefined> {
  const workItem = await (await openProjectWorkspaceStore(app.getPath('userData'))).getWorkItem(workItemId)
  if (!workItem) throw new Error(`无法安全恢复无项目会话：canonical WorkItem 不存在:${workItemId}`)
  if (workItem.projectId !== workspaceId) throw new Error('无法恢复无项目会话：WorkItem 属于其他 Workspace')
  if (historicalBusinessLineId && workItem.businessLineId && historicalBusinessLineId !== workItem.businessLineId) {
    throw new Error('无法恢复无项目会话：历史业务线与 canonical WorkItem 不一致')
  }
  return workItem.businessLineId
}
