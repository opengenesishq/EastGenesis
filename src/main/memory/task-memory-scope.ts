import type { SessionMeta } from '../../shared/types'
import { createProjectWorkspaceReadService } from '../project-workspace/canonical-read-service'
import type { MemoryScope } from './memory-manager'

/** Resolve ownership from the live Session; renderer/model arguments never choose it. */
export async function taskMemoryScope(meta: Pick<SessionMeta,
  'id' | 'taskMemorySessionId' | 'cwd' | 'sourceCwd' | 'workspaceId' | 'goalId' | 'workItemId'>,
userDataRoot: string): Promise<MemoryScope> {
  const scope = {
    projectRoot: meta.sourceCwd ?? meta.cwd,
    projectId: meta.workspaceId,
    sessionId: meta.taskMemorySessionId ?? meta.id,
    writerSessionId: meta.id,
    workItemId: meta.workItemId
  }
  if (scope.workItemId) {
    if (!scope.projectId) throw new Error('任务记忆缺少正式项目归属')
    const item = await createProjectWorkspaceReadService(userDataRoot, 'canonical').getWorkItem(scope.workItemId)
    if (!item || item.projectId !== scope.projectId || (meta.goalId && item.goalId !== meta.goalId)) {
      throw new Error('任务记忆工作项不属于当前项目或目标')
    }
  }
  if (meta.workspaceId !== scope.projectId || meta.workItemId !== scope.workItemId ||
      meta.id !== scope.writerSessionId ||
      (meta.sourceCwd ?? meta.cwd) !== scope.projectRoot || (meta.taskMemorySessionId ?? meta.id) !== scope.sessionId) {
    throw new Error('读取记忆期间任务归属已变化，请重试')
  }
  return scope
}
