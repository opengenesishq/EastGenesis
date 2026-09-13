import type { SessionMeta } from '../../shared/types'
import type { MediaAgentOrigin } from '../../shared/media-agent-types'
import { resolveBusinessLineId } from '../../shared/business-line-types'
import { assertSameBusinessLine } from '../business-line-ownership'
import { assertActiveBusinessLine } from '../business-line-registry-reader'
import { verifyProductionProjectMutation } from '../project-aggregate/project-mutation-ingress'

export interface MediaAgentExecutionContext {
  meta: SessionMeta
  toolUseId: string
  rootDir: string
}

export function mediaAgentOrigin(context: MediaAgentExecutionContext): MediaAgentOrigin {
  const { meta, toolUseId, rootDir } = context
  if (!rootDir || !meta.id || !toolUseId) throw new Error('媒体工具缺少可信会话上下文')
  if (!meta.workspaceId || meta.unassigned) {
    throw new Error('MEDIA_PROJECT_BINDING_REQUIRED：请在“项目”创建或打开工作区，再在该项目中创建任务后使用媒体工具。')
  }
  const businessLineId = resolveBusinessLineId(meta)
  assertActiveBusinessLine(businessLineId, rootDir)
  return { sessionId: meta.id, toolUseId, workspaceId: meta.workspaceId, businessLineId,
    goalId: meta.goalId, workItemId: meta.workItemId }
}

export async function validateMediaAgentMutation(context: MediaAgentExecutionContext): Promise<MediaAgentOrigin> {
  if (context.meta.taskStrategy !== 'execute') throw new Error('媒体创建、提交和对账需要切换到执行策略')
  const origin = mediaAgentOrigin(context)
  await verifyProductionProjectMutation(context.rootDir, origin.workspaceId)
  return origin
}

export function assertMediaAgentOwnership(origin: MediaAgentOrigin, value: { projectId: string; businessLineId?: string }): void {
  if (origin.workspaceId !== value.projectId) throw new Error('媒体目标不属于当前项目')
  assertSameBusinessLine(origin.businessLineId, value.businessLineId, 'video')
}
