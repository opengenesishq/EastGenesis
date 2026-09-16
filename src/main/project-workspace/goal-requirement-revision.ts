import type { Goal, MutationOptions } from '../../shared/project-workspace-types'
import { normalizeRequirementRevisionIntent, previewSessionRequirementRevision, type SessionRequirementRevisionInput } from '../../shared/session-requirement-revision'
import { appendEvent, type ProjectWorkspacePersistence } from './persistence'
import { clone, digest, flattenContract, normalizeAcceptanceSpecs, normalizeContract, requiredId, requiredText } from './codec'
import { assertProject, goalFrom, workItemFrom } from './state-access'
import { assertProjectAuthorized, projectMutationActor } from './project-authorization'
import { ProjectWorkspaceError } from './errors'

export function requirementRevisionEventId(input: Pick<SessionRequirementRevisionInput, 'sessionId' | 'requestId'>): string {
  return `goal-requirement:${digest({ sessionId: input.sessionId, requestId: input.requestId })}`
}

/** One existing canonical mutation updates Goal, its exact WorkItem and their audit events. */
export function reviseGoalRequirements(persistence: ProjectWorkspacePersistence, goalId: string,
  rawInput: SessionRequirementRevisionInput, options?: MutationOptions | number): Promise<Goal> {
  const input = { ...rawInput, intent: normalizeRequirementRevisionIntent(rawInput.intent),
    text: requiredText(rawInput.text, 'requirement revision text'), sessionId: requiredId(rawInput.sessionId, 'sessionId'),
    requestId: requiredId(rawInput.requestId, 'requestId'), workItemId: requiredId(rawInput.workItemId, 'workItemId') }
  if (input.text.length > 20_000 || !/^[a-f0-9]{64}$/.test(input.payloadDigest) ||
      input.messageId !== `session-input:${input.sessionId}:${input.requestId}`) throw new Error('交付要求修订来源无效')
  return persistence.mutate(options, ({ state, now }) => {
    const goal = goalFrom(state, goalId), item = workItemFrom(state, input.workItemId)
    if (goal.projectId !== input.projectId || item.goalId !== goal.id || item.projectId !== goal.projectId) {
      throw new Error('交付要求修订与原任务归属不一致')
    }
    assertProjectAuthorized(state, assertProject(state, goal.projectId), projectMutationActor(options), 'edit')
    const sourceEventId = requirementRevisionEventId(input)
    const existing = state.events.find(event => event.id === sourceEventId)
    if (existing) {
      if (existing.entityId !== goalId || existing.kind !== 'goal.requirements_revised' ||
          existing.payload.payloadDigest !== input.payloadDigest || existing.payload.workItemId !== item.id) {
        throw new Error('相同提交标识不能用于不同交付要求修订')
      }
      return goal
    }
    persistence.assertEntityRevision(goal.revision, { expectedRevision: input.intent.expectedGoalRevision }, 'goal')
    persistence.assertEntityRevision(item.revision, { expectedRevision: input.intent.expectedWorkItemRevision }, 'work item')
    if (goal.status === 'archived' || goal.status === 'cancelled' || item.status === 'cancelled') {
      throw new ProjectWorkspaceError('terminal', '原目标或任务已取消/归档，请先恢复后修改要求')
    }
    const preview = previewSessionRequirementRevision(goal, item, input.text)
    if (!preview.changed) throw new Error('未识别到明确的新交付要求，请修改说明后重新确认')
    const before = { goalRevision: goal.revision, workItemRevision: item.revision, goalContract: clone(goal.contract),
      acceptanceSpec: clone(item.acceptanceSpec), goalAcceptance: clone(goal.acceptanceResult), workItemAcceptance: clone(item.acceptance),
      goalStatus: goal.status, workItemStatus: item.status }
    goal.contract = normalizeContract(preview.goalContract)
    flattenContract(goal, goal.contract)
    goal.acceptanceResult = undefined
    if (goal.status === 'completed' || goal.status === 'failed') { goal.status = 'running'; goal.completedAt = undefined }
    goal.revision++; goal.updatedAt = now
    item.acceptanceSpec = normalizeAcceptanceSpecs(preview.acceptanceSpec, 'work item revised acceptance')
    item.inheritedGoalContract = clone(goal.contract)
    item.acceptance = undefined
    if (item.status === 'done' || item.status === 'failed') item.status = 'ready'
    item.revision++; item.updatedAt = now
    // The canonical aggregate requires every child to inherit the current Goal
    // contract. Its step acceptance and old Run bindings remain unchanged.
    for (const child of state.workItems) {
      if (child.goalId !== goal.id || child.id === item.id) continue
      child.inheritedGoalContract = clone(goal.contract)
      child.revision++; child.updatedAt = now
      appendEvent(state, goal.projectId, 'work_item', child.id, 'work_item.contract_inherited', child.revision,
        { goalId: goal.id, contractRevision: goal.revision, sourceEventId }, now)
    }
    const payload = { schemaVersion: 1, source: 'confirmed_session_input', sessionId: input.sessionId, requestId: input.requestId,
      messageId: input.messageId, payloadDigest: input.payloadDigest, text: input.text, workItemId: item.id,
      before, goalRevision: goal.revision, workItemRevision: item.revision, requirements: preview.requirements,
      goalContract: clone(goal.contract), acceptanceSpec: clone(item.acceptanceSpec) }
    appendEvent(state, goal.projectId, 'goal', goal.id, 'goal.requirements_revised', goal.revision, payload, now)
    state.events[state.events.length - 1].id = sourceEventId
    appendEvent(state, goal.projectId, 'work_item', item.id, 'work_item.requirements_revised', item.revision,
      { sourceEventId, goalId: goal.id, contractRevision: goal.revision, acceptanceSpec: clone(item.acceptanceSpec) }, now)
    return goal
  })
}
