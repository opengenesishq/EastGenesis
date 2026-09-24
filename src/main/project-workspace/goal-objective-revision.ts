import type { Goal, MutationOptions } from '../../shared/project-workspace-types'
import { normalizeGoalRevisionIntent, previewSessionGoalRevision, type SessionGoalRevisionInput } from '../../shared/session-goal-revision'
import { appendEvent, type ProjectWorkspacePersistence } from './persistence'
import { clone, digest, flattenContract, normalizeContract, requiredId, requiredText } from './codec'
import { assertProject, goalFrom, workItemFrom } from './state-access'
import { assertProjectAuthorized, projectMutationActor } from './project-authorization'

export function goalRevisionEventId(input: Pick<SessionGoalRevisionInput, 'sessionId' | 'requestId'>): string {
  return `goal-objective:${digest({ sessionId: input.sessionId, requestId: input.requestId })}`
}
export function reviseGoalObjective(persistence: ProjectWorkspacePersistence, goalId: string,
  rawInput: SessionGoalRevisionInput, options?: MutationOptions | number): Promise<Goal> {
  const input = { ...rawInput, intent: normalizeGoalRevisionIntent(rawInput.intent),
    text: requiredText(rawInput.text, 'goal revision text'), sessionId: requiredId(rawInput.sessionId, 'sessionId'),
    requestId: requiredId(rawInput.requestId, 'requestId'), workItemId: requiredId(rawInput.workItemId, 'workItemId') }
  if (input.text.length > 20_000 || !/^[a-f0-9]{64}$/.test(input.payloadDigest) ||
      input.messageId !== `session-input:${input.sessionId}:${input.requestId}`) throw new Error('目标修订来源无效')
  return persistence.mutate(options, ({ state, now }) => {
    const goal = goalFrom(state, goalId), item = workItemFrom(state, input.workItemId)
    if (goal.projectId !== input.projectId || item.goalId !== goal.id || item.projectId !== goal.projectId) throw new Error('目标修订与原任务归属不一致')
    assertProjectAuthorized(state, assertProject(state, goal.projectId), projectMutationActor(options), 'edit')
    const sourceEventId = goalRevisionEventId(input)
    const existing = state.events.find(event => event.id === sourceEventId)
    if (existing) {
      if (existing.entityId !== goalId || existing.kind !== 'goal.objective_revised' ||
          existing.payload.payloadDigest !== input.payloadDigest || existing.payload.workItemId !== item.id) throw new Error('相同提交标识不能用于不同目标修订')
      return goal
    }
    persistence.assertEntityRevision(goal.revision, { expectedRevision: input.intent.expectedGoalRevision }, 'goal')
    persistence.assertEntityRevision(item.revision, { expectedRevision: input.intent.expectedWorkItemRevision }, 'work item')
    if (['archived', 'cancelled'].includes(goal.status) || item.status === 'cancelled') throw new Error('原目标或任务已取消/归档，请先恢复后修改目标')
    if (goal.objective === input.text) throw new Error('目标内容未变化')
    const children = state.workItems.filter(child => child.goalId === goal.id)
    if (children.some(child => ['running', 'waiting_approval', 'verifying'].includes(child.status))) throw new Error('目标仍有执行或审批中的步骤，请先暂停并核对后修订')
    const before = { goalRevision: goal.revision, workItemRevision: item.revision, title: goal.title,
      goalContract: clone(goal.contract), goalAcceptance: clone(goal.acceptanceResult), goalStatus: goal.status,
      workItems: children.map(child => ({ id: child.id, revision: child.revision, status: child.status,
        title: child.title, description: child.description, acceptanceSpec: clone(child.acceptanceSpec), acceptance: clone(child.acceptance) })) }
    goal.contract = normalizeContract(previewSessionGoalRevision(goal, input.text))
    flattenContract(goal, goal.contract)
    goal.title = input.text.replace(/\s+/g, ' ').slice(0, 72)
    goal.acceptanceResult = undefined; goal.completedAt = undefined; goal.status = 'planned'
    goal.revision++; goal.updatedAt = now
    for (const child of children) {
      child.inheritedGoalContract = clone(goal.contract)
      child.acceptance = undefined
      if (child.id === item.id) {
        child.title = goal.title; child.description = goal.objective
        child.acceptanceSpec = clone(goal.contract.acceptance)
        child.status = 'ready'
      } else child.status = 'cancelled'
      child.revision++; child.updatedAt = now
      appendEvent(state, goal.projectId, 'work_item', child.id, 'work_item.objective_revised', child.revision,
        { goalId: goal.id, sourceEventId, contractRevision: goal.revision, requiresReplanning: true }, now)
    }
    appendEvent(state, goal.projectId, 'goal', goal.id, 'goal.objective_revised', goal.revision,
      { schemaVersion: 1, source: 'confirmed_session_input', sessionId: input.sessionId, requestId: input.requestId,
        messageId: input.messageId, payloadDigest: input.payloadDigest, text: input.text, workItemId: item.id,
        before, goalRevision: goal.revision, workItemRevision: item.revision, goalContract: clone(goal.contract),
        objective: goal.objective, requiresReplanning: true }, now)
    state.events[state.events.length - 1].id = sourceEventId
    return goal
  })
}
