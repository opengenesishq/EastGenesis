import type { SessionInputRecord } from '../../shared/session-input-types'
import { normalizeRequirementRevisionIntent, type SessionRequirementRevisionReceipt } from '../../shared/session-requirement-revision'
import { openProjectWorkspaceCommandService } from '../project-workspace/command-service'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { createProjectWorkspaceReadService } from '../project-workspace/canonical-read-service'
import { requirementRevisionEventId } from '../project-workspace/goal-requirement-revision'
import { messagePayloadDigest } from '../message-payload-digest'

export async function applySessionRequirementRevision(root: string, record: SessionInputRecord): Promise<SessionRequirementRevisionReceipt> {
  if (!record.workspaceId || !record.goalId || !record.workItemId) throw new Error('当前会话缺少正式目标和工作项，不能修改交付要求')
  const intent = normalizeRequirementRevisionIntent(record.payload.requirementRevisionIntent)
  const commands = await openProjectWorkspaceCommandService(root)
  await commands.reconcileShadowProjection()
  const input = { sessionId: record.sessionId, requestId: record.id, messageId: record.messageId,
    projectId: record.workspaceId, workItemId: record.workItemId, text: record.payload.text,
    payloadDigest: record.importedPayloadDigest ?? messagePayloadDigest(record.payload), intent }
  const sourceEventId = requirementRevisionEventId(input)
  const store = await openProjectWorkspaceStore(root)
  let event = (await store.getState()).events.find(event => event.id === sourceEventId)
  if (!event) {
    await commands.reviseGoalRequirements(record.goalId, input)
    event = (await store.getState()).events.find(event => event.id === sourceEventId)
  }
  if (!event || event.kind !== 'goal.requirements_revised' || event.projectId !== record.workspaceId ||
      event.entityId !== record.goalId || event.payload.workItemId !== record.workItemId ||
      event.payload.payloadDigest !== input.payloadDigest) throw new Error('目标修订缺少匹配的持久回执')
  const reads = createProjectWorkspaceReadService(root, 'canonical')
  const [goal, item] = await Promise.all([reads.getGoal(record.goalId), reads.getWorkItem(record.workItemId)])
  if (!goal || !item || goal.projectId !== record.workspaceId || item.goalId !== goal.id ||
      goal.revision < Number(event.payload.goalRevision) || item.revision < Number(event.payload.workItemRevision)) {
    throw new Error('目标修订尚未完成 canonical 读回验证')
  }
  return { schemaVersion: 1, sourceEventId, goalRevision: Number(event.payload.goalRevision),
    workItemRevision: Number(event.payload.workItemRevision), requirements: event.payload.requirements as SessionRequirementRevisionReceipt['requirements'] }
}
