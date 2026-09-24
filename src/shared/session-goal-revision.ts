import type { Goal, GoalContract } from './project-workspace-types'
import { extractGoalRequestRequirements } from './goal-request-requirements'

export interface SessionGoalRevisionIntent {
  schemaVersion: 1
  kind: 'revise_goal_objective'
  expectedGoalRevision: number
  expectedWorkItemRevision: number
}
export interface SessionGoalRevisionReceipt {
  schemaVersion: 1
  sourceEventId: string
  goalRevision: number
  workItemRevision: number
  objective: string
}
export interface SessionGoalRevisionInput {
  sessionId: string; requestId: string; messageId: string; projectId: string; workItemId: string
  text: string; payloadDigest: string; intent: SessionGoalRevisionIntent
}
export function normalizeGoalRevisionIntent(value: unknown): SessionGoalRevisionIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('目标修订标识无效')
  const intent = value as SessionGoalRevisionIntent
  if (intent.schemaVersion !== 1 || intent.kind !== 'revise_goal_objective' ||
      !Number.isSafeInteger(intent.expectedGoalRevision) || intent.expectedGoalRevision < 1 ||
      !Number.isSafeInteger(intent.expectedWorkItemRevision) || intent.expectedWorkItemRevision < 1) throw new Error('目标修订版本无效')
  return { schemaVersion: 1, kind: intent.kind, expectedGoalRevision: intent.expectedGoalRevision, expectedWorkItemRevision: intent.expectedWorkItemRevision }
}
/** A replacement objective gets fresh acceptance. Existing prohibitions and
 * budget remain boundaries; this command never expands execution permission. */
export function previewSessionGoalRevision(goal: Goal, rawText: string): GoalContract {
  if (typeof rawText !== 'string' || !rawText.trim() || rawText.length > 20_000) throw new Error('目标须为 1–20000 字的明确要求')
  const objective = rawText.trim()
  const requirements = extractGoalRequestRequirements(objective)
  const previousDeliveryConstraints = new Set(extractGoalRequestRequirements(goal.objective)
    .filter(item => item.kind === 'page_count').map(item => item.text))
  return { ...goal.contract, objective,
    constraints: [...new Set([...goal.contract.constraints.filter(text => !previousDeliveryConstraints.has(text)),
      ...requirements.filter(item => item.kind === 'constraint' || item.kind === 'page_count').map(item => item.text)])],
    successCriteria: [objective, ...requirements.map(item => item.text)],
    acceptance: [{ id: `${goal.id}-result`, criterion: objective, required: true },
      ...requirements.map(item => ({ id: item.id, criterion: item.text, required: true }))] }
}
