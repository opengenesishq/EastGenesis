import type { ModelAttemptCompleteInput } from '../../shared/model-attempt-types'
import type { NativeRequestBudgetInput } from '../model/native-request-budget'
import { reserveRequestBudget, settleRequestBudget } from '../budget/request-budget-store'
import { ModelRouteError } from '../model/model-route-error'

export function reserveModelAttemptBudget(input: {
  id: string; providerId: string; model: string; budgetScope?: NativeRequestBudgetInput
}): void {
  if (!input.budgetScope) return
  const admission = reserveRequestBudget({ ...input.budgetScope, id: `model:${input.id}`, kind: 'model',
    providerId: input.providerId, model: input.model })
  if (admission.reused) throw new ModelRouteError('ROUTING_BUDGET_UNAFFORDABLE', '该模型请求已有预算预留；请恢复或对账原 ModelAttempt，不能重复发送。')
}

export function releaseUnsentModelBudget(id: string, budget?: NativeRequestBudgetInput): void {
  if (budget) settleRequestBudget({ rootDir: budget.rootDir, id: `model:${id}`, status: 'released', actualUsd: 0 })
}

export function settleModelAttemptBudget(id: string, budget: NativeRequestBudgetInput | undefined, completion: Pick<ModelAttemptCompleteInput, 'status' | 'costUsd' | 'outcome'>): void {
  if (!budget) return
  const knownRejection = ['auth_failed', 'rate_limited'].includes(completion.outcome ?? '')
  const success = completion.status === 'succeeded'
  settleRequestBudget({ rootDir: budget.rootDir, id: `model:${id}`,
    status: success || knownRejection ? 'settled' : 'unknown',
    actualUsd: knownRejection ? completion.costUsd ?? 0 : success ? completion.costUsd : undefined })
}
