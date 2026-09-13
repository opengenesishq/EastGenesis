import { resolveWelcomeComputeSelection } from './welcome-session-projection'
import { freezePersonalTaskInput, type PersonalTaskDraftInput } from '../../lib/personal-task-submission-storage'
import { AUTO_PROVIDER_ID, type CreateSessionOptions } from '../../../../shared/types'
import type { PersonalTaskSubmissionView } from '../../../../shared/personal-task-types'
import { resolveSelectedBusinessLine } from '../../../../shared/business-line-types'
import { useStore } from '../../store'
import { createPersonalTaskSubmissionClient, PersonalTaskSubmissionError } from '../../lib/personal-task-submission'

export const WELCOME_PERSONAL_SUBMISSION_KEY = 'caogen.personal-task-submission.welcome.v1'

export function welcomePersonalTaskClient() {
  return createPersonalTaskSubmissionClient({ storageKey: WELCOME_PERSONAL_SUBMISSION_KEY })
}

/** Personal first text owns a canonical task before sending; explicit project/fork keeps its existing entry point. */
export async function startWelcomeTask(options: CreateSessionOptions, prompt: string): Promise<string> {
  const state = useStore.getState()
  const submittedDraft = JSON.stringify(state.welcomeDraft)
  if (!options.unassigned || options.forkFromSdkSessionId) return state.startSessionWithPrompt(options, prompt)
  const result = await welcomePersonalTaskClient().submit({
    text: prompt, businessLineId: resolveSelectedBusinessLine(state.settings).id,
    providerId: options.providerId, model: options.model, routingScope: options.routingScope,
    driveMode: options.driveMode, taskStrategy: options.taskStrategy, budgetUsd: options.budgetUsd
  })
  if (result.receipt.status !== 'submitted') {
    throw new PersonalTaskSubmissionError('receipt_pending', personalTaskReceiptMessage(result.receipt), result.receipt.clientRequestId)
  }
  // Submission is confirmed independently of whether navigation can hydrate the Session.
  if (JSON.stringify(useStore.getState().welcomeDraft) === submittedDraft) state.clearWelcomeDraft()
  const sessionId = await openPersonalTaskReceipt(result.receipt)
  // Personal-task submission intentionally owns the idempotency payload and
  // therefore does not include presentation-only title text. Preserve the
  // welcome preset label after the canonical Session binding is confirmed;
  // a rename failure must not turn a submitted task into a retry.
  if (options.title?.trim()) {
    try {
      await state.renameSession(sessionId, options.title.trim())
    } catch {
      // The canonical submission is already durable; presentation metadata is
      // best-effort and must not trigger a second send.
    }
  }
  return sessionId
}

export async function openPersonalTaskReceipt(receipt: PersonalTaskSubmissionView): Promise<string> {
  if (receipt.status !== 'submitted' || !receipt.binding) throw new Error('任务尚未确认提交，请查询原回执。')
  const id = receipt.binding.sessionId
  const state = useStore.getState()
  if (!await state.syncSession(id)) throw new Error('任务已提交，但当前会话尚未载入；请从任务历史继续，勿重复创建。')
  state.selectSession(id)
  void state.refreshProjects()
  return id
}

export function personalTaskReceiptMessage(receipt: PersonalTaskSubmissionView): string {
  const messages = {
    preparing: '任务正在准备。可以查询回执或重试原提交，不会创建第二个任务。',
    ready: '任务已准备，尚未确认发送。请重试原提交。',
    submitted: '任务已提交；完成状态请查看任务进度。',
    not_sent: '任务未发送。请重试原提交。',
    needs_reconciliation: '发送结果待核对。保留原提交，查询回执后继续，勿重复发送。'
  }
  return receipt.error?.message ?? messages[receipt.status]
}

/** Recovery may clear only the still-matching personal draft, never text edited for another target. */
export function clearRecoveredWelcomeInput(input: PersonalTaskDraftInput): void {
  const state = useStore.getState()
  const draft = state.welcomeDraft
  if (draft.forkFromSdkSessionId || (draft.projectChoice && draft.projectChoice !== '__unassigned__')) return
  const compute = resolveWelcomeComputeSelection(state.providers, state.settings.defaultProviderId,
    state.settings.defaultModel, draft, state.providersLoaded)
  const current = {
    text: draft.text.trim(), businessLineId: resolveSelectedBusinessLine(state.settings).id,
    providerId: compute.routingMode === 'global' ? AUTO_PROVIDER_ID : compute.providerId,
    model: compute.model, routingScope: compute.routingMode, driveMode: 'core' as const,
    taskStrategy: draft.taskStrategy ?? state.settings.defaultTaskStrategy
  }
  if (!current.text) return
  if (JSON.stringify(freezePersonalTaskInput(current)) === JSON.stringify(freezePersonalTaskInput(input))) state.clearWelcomeDraft()
}
