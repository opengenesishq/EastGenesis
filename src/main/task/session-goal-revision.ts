import type { SessionInputRecord } from '../../shared/session-input-types'
import { normalizeGoalRevisionIntent, type SessionGoalRevisionReceipt } from '../../shared/session-goal-revision'
import { openProjectWorkspaceCommandService } from '../project-workspace/command-service'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { createProjectWorkspaceReadService } from '../project-workspace/canonical-read-service'
import { goalRevisionEventId } from '../project-workspace/goal-objective-revision'
import { messagePayloadDigest } from '../message-payload-digest'
import { runHasUnresolvedEffects } from './effect-runtime'
import { listTaskRuns } from './task-snapshot'

export async function applySessionGoalRevision(root: string, record: SessionInputRecord): Promise<SessionGoalRevisionReceipt> {
  if (!record.workspaceId || !record.goalId || !record.workItemId) throw new Error('当前会话缺少正式目标和工作项')
  const intent = normalizeGoalRevisionIntent(record.payload.goalRevisionIntent)
  const commands = await openProjectWorkspaceCommandService(root)
  await commands.reconcileShadowProjection()
  const input = { sessionId: record.sessionId, requestId: record.id, messageId: record.messageId,
    projectId: record.workspaceId, workItemId: record.workItemId, text: record.payload.text,
    payloadDigest: record.importedPayloadDigest ?? messagePayloadDigest(record.payload), intent }
  const sourceEventId = goalRevisionEventId(input)
  const store = await openProjectWorkspaceStore(root)
  let event = (await store.getState()).events.find(event => event.id === sourceEventId)
  if (!event) {
    const runs = await listTaskRuns(record.sessionId, root)
    if (runs.some(run => runHasUnresolvedEffects(run) || !['completed', 'failed', 'cancelled'].includes(run.status))) throw new Error('原任务还有未结束或待核对的执行，请先处理后修订目标')
    await commands.reviseGoalObjective(record.goalId, input)
    event = (await store.getState()).events.find(event => event.id === sourceEventId)
  }
  if (!event || event.kind !== 'goal.objective_revised' || event.projectId !== record.workspaceId ||
      event.entityId !== record.goalId || event.payload.workItemId !== record.workItemId ||
      event.payload.payloadDigest !== input.payloadDigest || event.payload.objective !== record.payload.text.trim()) throw new Error('目标修订缺少匹配的持久回执')
  const reads = createProjectWorkspaceReadService(root, 'canonical')
  const [goal, item] = await Promise.all([reads.getGoal(record.goalId), reads.getWorkItem(record.workItemId)])
  if (!goal || !item || goal.projectId !== record.workspaceId || item.goalId !== goal.id ||
      goal.revision < Number(event.payload.goalRevision) || item.revision < Number(event.payload.workItemRevision)) throw new Error('目标修订尚未完成 canonical 读回验证')
  return { schemaVersion: 1, sourceEventId, goalRevision: Number(event.payload.goalRevision),
    workItemRevision: Number(event.payload.workItemRevision), objective: String(event.payload.objective) }
}
