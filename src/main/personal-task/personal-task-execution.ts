import type { PersonalTaskSubmitInput } from '../../shared/personal-task-types'
import { getBusinessLines, parseBusinessLine, type BusinessLineDefinition } from '../../shared/business-line-types'
import { businessLineTaskPlan, businessLineTaskPrompt } from '../../shared/business-line-task-context'
import type { TaskPlanVersion, TaskStrategy } from '../../shared/task-plan-types'
import { getSettings } from '../settings'
import { syncTaskPlanLedger } from '../task/task-plan-ledger'
import { applyBusinessLineCreationPolicy } from '../business-line-execution-policy'
import { PersonalTaskSubmissionError } from './personal-task-input'
import type { PersonalTaskSubmissionRecord } from './personal-task-submission-store'
import type { PersonalTaskRuntime } from './personal-task-runtime-types'

/** Frozen message/plan source for one submission; current policy gates still run before execution. */
export interface PersonalTaskExecutionContext {
  line: BusinessLineDefinition
  requestedStrategy: TaskStrategy
}

export function resolvePersonalTaskExecution(input: PersonalTaskSubmitInput): PersonalTaskExecutionContext {
  const settings = getSettings()
  const line = getBusinessLines(settings).find((candidate) => candidate.id === input.businessLineId && candidate.enabled)
  if (!line) throw new PersonalTaskSubmissionError('PERSONAL_TASK_BUSINESS_LINE_UNAVAILABLE', '业务线不存在或已停用')
  const requestedStrategy = input.taskStrategy ?? line.toolScope ?? settings.defaultTaskStrategy
  applyBusinessLineCreationPolicy({ cwd: '', taskStrategy: requestedStrategy, budgetUsd: input.budgetUsd }, line)
  return { line, requestedStrategy }
}

export function parsePersonalTaskExecution(value: unknown, input: PersonalTaskSubmitInput): PersonalTaskExecutionContext {
  if (!value || typeof value !== 'object') throw new Error('个人任务执行上下文无效')
  const raw = value as Record<string, unknown>
  const line = parseBusinessLine(raw.line)
  if (!line || !line.enabled || line.id !== input.businessLineId ||
      !['view', 'plan', 'execute'].includes(String(raw.requestedStrategy))) throw new Error('个人任务执行上下文归属无效')
  return { line, requestedStrategy: raw.requestedStrategy as TaskStrategy }
}

export function personalTaskStrategy(context: PersonalTaskExecutionContext): TaskStrategy {
  return requiresPlan(context) ? 'plan' : context.requestedStrategy
}

export function personalTaskRequestText(record: PersonalTaskSubmissionRecord): string {
  const prompt = businessLineTaskPrompt(record.execution.line, record.input.text)
  return requiresPlan(record.execution)
    ? `${prompt}\n\n此任务的验收计划已经保存。当前先审查和完善计划；执行须由用户通过现有计划审批。`
    : prompt
}

export async function ensurePersonalTaskPlan(record: PersonalTaskSubmissionRecord, runtime: PersonalTaskRuntime, rootDir: string): Promise<void> {
  if (!requiresPlan(record.execution)) return
  const id = record.binding.sessionId
  const existing = runtime.getTaskPlan(id)
  const draft = businessLineTaskPlan(record.execution.line, record.input.text)
  if (existing.currentVersion) {
    assertSameFirstPlan(record, existing.currentVersion)
    if (existing.approvalStatus !== 'pending') throw new Error('任务计划审批状态已变化，请从原任务继续')
    await syncTaskPlanLedger(rootDir, existing)
    return
  }
  const state = await runtime.createTaskPlanVersion(id, draft)
  if (!state.currentVersion || state.approvalStatus !== 'pending') throw new Error('验收计划未持久保存，任务尚未发送')
  assertSameFirstPlan(record, state.currentVersion)
}

function requiresPlan(context: PersonalTaskExecutionContext): boolean {
  return Boolean(context.line.acceptanceCriteria?.length) && context.requestedStrategy !== 'view'
}

function assertSameFirstPlan(record: PersonalTaskSubmissionRecord, version: TaskPlanVersion): void {
  const draft = businessLineTaskPlan(record.execution.line, record.input.text)
  const binding = version.binding
  const claims = [
    version.version === 1, version.source === 'manual', version.objective === draft.objective,
    binding.sessionId === record.binding.sessionId, binding.workspaceId === record.binding.workspaceId,
    binding.goalId === record.binding.goalId, binding.workItemId === record.binding.workItemId,
    JSON.stringify(version.acceptanceCriteria) === JSON.stringify(draft.acceptanceCriteria),
    JSON.stringify(version.expectedArtifacts) === JSON.stringify(draft.expectedArtifacts),
    JSON.stringify(version.steps.map(({ id, title, dependsOn }) => ({ id, title, dependsOn }))) === JSON.stringify(draft.steps)
  ]
  if (!claims.every(Boolean)) throw new Error('原会话计划与首条任务验收合同不一致，已停止自动提交')
}
