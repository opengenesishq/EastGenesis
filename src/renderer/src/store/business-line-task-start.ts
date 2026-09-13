import { AUTO_MODEL, AUTO_PROVIDER_ID } from '../../../shared/types'
import type { BusinessLineDefinition } from '../../../shared/business-line-types'
import type { AppStore } from '../store'
import { createPersonalTaskSubmissionClient, PersonalTaskSubmissionError } from '../lib/personal-task-submission'

export function businessLineSubmissionKey(lineId: string): string { return `caogen.personal-task-submission.business-line.${lineId}.v1` }

/** The canonical backend freezes the line prompt and any required unapproved plan before its first send. */
export async function startConfiguredBusinessLineTask(state: AppStore, line: BusinessLineDefinition, prompt: string): Promise<string> {
  const client = createPersonalTaskSubmissionClient({ storageKey: businessLineSubmissionKey(line.id) })
  const { receipt } = await client.submit({
    text: prompt, businessLineId: line.id, taskStrategy: line.toolScope ?? state.settings.defaultTaskStrategy,
    budgetUsd: line.taskBudgetUsd, driveMode: 'core',
    providerId: AUTO_PROVIDER_ID, model: AUTO_MODEL, routingScope: 'global'
  })
  if (receipt.status !== 'submitted' || !receipt.binding) throw new PersonalTaskSubmissionError(
    'receipt_pending', receipt.error?.message ?? '任务尚未确认发送，请查询回执或重试原提交。', receipt.clientRequestId
  )
  const sessionId = receipt.binding.sessionId
  if (!await state.syncSession(sessionId)) throw new Error('任务已提交，当前会话尚未载入；请从任务历史继续，勿重复创建。')
  state.selectSession(sessionId)
  return sessionId
}

export { businessLineTaskPlan, businessLineTaskPrompt } from '../../../shared/business-line-task-context'
