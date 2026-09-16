import { readFileSync } from 'node:fs'
import type { GoalBudget } from '../../shared/project-workspace-types'
import type { HistoryEntry, SessionMeta } from '../../shared/types'
import { parseProjectWorkspaceState, projectWorkspaceFile } from '../project-workspace/persistence'
import { readSupervisorStateSync } from '../task/supervisor-state'
import { taskRuntimeRegistry } from '../task/task-runtime-registry'
import { ModelRouteError } from '../model/model-route-error'
import type { RequestBudgetScope } from './request-budget-types'
import { readBudgetDocument } from './request-budget-store'

type BudgetOwner = Pick<SessionMeta, 'id' | 'workspaceId' | 'goalId' | 'workItemId' | 'sdkSessionId' | 'costUsd'>

/** Ordinary DAG children, retries and media calls share the same Goal purse.
 * Resolve it at the physical request boundary, not from renderer arguments or
 * a plan-time balance that multiple parallel requests can spend independently. */
export function canonicalRequestBudgets(meta: BudgetOwner, history: HistoryEntry[], rootDir: string): {
  ids: string[]; budgets: NonNullable<RequestBudgetScope['aggregateBudgets']>
} {
  if (!meta.goalId) return { ids: [], budgets: [] }
  try {
    if (!meta.workspaceId) throw new Error('目标缺少项目归属')
    const state = parseProjectWorkspaceState(readFileSync(projectWorkspaceFile(rootDir), 'utf8'))
    const goal = state.goals.find((entry) => entry.id === meta.goalId && entry.projectId === meta.workspaceId)
    if (!goal || !state.workspaces.some((entry) => entry.id === meta.workspaceId && entry.status !== 'deleted')) {
      throw new Error('原目标或项目记录缺失，无法核对共享预算')
    }
    if (meta.workItemId && !state.workItems.some((entry) => entry.id === meta.workItemId &&
        entry.projectId === meta.workspaceId && entry.goalId === meta.goalId)) {
      throw new Error('任务与目标归属不一致，无法核对共享预算')
    }
    const id = `goal:${meta.workspaceId}:${meta.goalId}`
    const runs = readSupervisorStateSync(rootDir).runs.filter((run) => run.projectId === meta.workspaceId && run.goalId === meta.goalId)
    const activeRunId = taskRuntimeRegistry.get(meta.id)?.id
    const activeRun = activeRunId ? runs.find((run) => run.id === activeRunId) : undefined
    const ids = [id, ...(activeRun ? [`run:${activeRun.id}`] : [])]
    // A later Goal edit may tighten the purse, but cannot enlarge the budget
    // frozen on an already-running Run.
    const limits = [usdLimit(goal.budget), usdLimit(activeRun?.budget)].filter((value): value is number => value !== undefined)
    if (!limits.length) return { ids, budgets: [] }
    if (runs.some((run) => !run.usage)) throw new Error('目标已有运行缺少完整费用记录，请先核对预算')
    const entries = [...history, meta].filter((entry) => entry.workspaceId === meta.workspaceId && entry.goalId === meta.goalId)
    const ledger = readBudgetDocument(rootDir)
    // Match Supervisor totals to durable Session ownership before deduplicating.
    // A legacy Run with no recoverable Session association remains an additive
    // floor; guessing a same-WorkItem match could erase earlier session costs.
    const floors = new Map<string, { id: string; sessionIds: string[]; observedUsd: number; minimumUsd: number }>()
    for (const run of runs) {
      const member = `run:${run.id}`
      const ledgerSession = ledger.sessions.find((session) => session.aggregateBudgetIds?.includes(member) ||
        (run.id === activeRunId && (session.sessionIds.includes(meta.id) || Boolean(meta.sdkSessionId && session.sdkSessionId === meta.sdkSessionId))))
      const sessionIds = ledgerSession?.sessionIds ?? (run.id === activeRunId ? [meta.id] : [])
      const key = ledgerSession?.key ?? (run.id === activeRunId ? meta.id : member)
      const floor = floors.get(key) ?? { id: member, sessionIds, observedUsd: totalCost(entries.filter((entry) => sessionIds.includes(entry.id))), minimumUsd: 0 }
      floor.minimumUsd += run.usage?.costUsd ?? 0
      floors.set(key, floor)
    }
    const textCostFloors = [...floors.values()]
    return { ids, budgets: [{ id, sessionIds: [...new Set(entries.map((entry) => entry.id))],
      limitUsd: Math.min(...limits), textSpentUsd: totalCost(entries), textCostFloors }] }
  } catch (error) {
    throw new ModelRouteError('ROUTING_INVALID_BUDGET', `无法核对目标共享预算，未发送请求：${error instanceof Error ? error.message : String(error)}`)
  }
}

function totalCost(entries: BudgetOwner[]): number {
  const costs = new Map<string, number>()
  for (const entry of entries) {
    if (!Number.isFinite(entry.costUsd) || entry.costUsd < 0) throw new Error('目标的会话费用记录无效')
    const key = entry.sdkSessionId || entry.id
    costs.set(key, Math.max(costs.get(key) ?? 0, entry.costUsd))
  }
  return [...costs.values()].reduce((sum, cost) => sum + cost, 0)
}

function usdLimit(budget: GoalBudget | undefined): number | undefined {
  if (budget?.amount === undefined) return undefined
  if (!Number.isFinite(budget.amount) || budget.amount < 0) throw new Error('目标金额预算无效')
  // Goal's existing zero convention means unlimited, as in Supervisor.
  if (budget.amount === 0) return undefined
  if ((budget.currency?.trim().toUpperCase() || 'USD') !== 'USD') throw new Error('目标预算币种无法按 USD 费用账本核对')
  return budget.amount
}
