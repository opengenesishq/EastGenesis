import type { Goal, SessionMeta, TaskPlanVersion } from '../../../../shared/types'

export type RequirementBinding = Pick<SessionMeta, 'id' | 'workspaceId' | 'goalId' | 'workItemId'>
export interface TaskRequirementGroup { kind: 'success' | 'constraints' | 'goalAcceptance' | 'artifacts' | 'planAcceptance' | 'stepAcceptance'; title?: string; values: string[] }

/** Display only the contracts already owned by this task; no extraction from
 * task prose or generated completion text happens in the renderer. */
export function taskRequirementSummary(binding: RequirementBinding, goal?: Goal, plan?: TaskPlanVersion) {
  if (goal && (goal.id !== binding.goalId || goal.projectId !== binding.workspaceId)) throw new Error('交付要求与当前目标归属不一致。')
  if (plan && (plan.binding.sessionId !== binding.id || plan.binding.workspaceId !== binding.workspaceId ||
    plan.binding.goalId !== binding.goalId || plan.binding.workItemId !== binding.workItemId)) throw new Error('计划要求与当前任务归属不一致。')
  const unique = (values: readonly string[]): string[] => [...new Set(values.map(value => value.trim()).filter(Boolean))]
  const groups: TaskRequirementGroup[] = []
  const add = (kind: TaskRequirementGroup['kind'], values: readonly string[], title?: string): void => {
    const entries = unique(values)
    if (entries.length) groups.push({ kind, values: entries, ...(title ? { title } : {}) })
  }
  if (goal) {
    add('success', goal.contract.successCriteria)
    add('constraints', goal.contract.constraints)
    add('goalAcceptance', goal.contract.acceptance.map(entry => entry.criterion))
  }
  if (plan) {
    add('artifacts', plan.expectedArtifacts)
    add('planAcceptance', plan.acceptanceCriteria)
    for (const step of plan.steps) add('stepAcceptance', (step.acceptanceSpec ?? []).map(entry => entry.criterion), step.title)
  }
  return { groups, preview: unique(groups.flatMap(group => group.values)).slice(0, 3),
    goalRevision: goal?.revision, planVersion: plan?.version, planGoalRevision: plan?.missionSource?.goalRevision,
    outdatedPlan: Boolean(goal && plan?.missionSource && goal.revision !== plan.missionSource.goalRevision) }
}
