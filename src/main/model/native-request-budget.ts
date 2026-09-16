import { assertNativeRequestContext, estimateNativeRequestUpperCost } from './native-request-cost'
export { estimateNativeRequestUpperCost } from './native-request-cost'
import { app } from 'electron'
import type { AppSettings, HistoryEntry, SessionMeta } from '../../shared/types'
import { calculateMonthlyBudgetSnapshot } from '../../shared/budget'
import { getSettings } from '../settings'
import { listHistory } from '../history'
import { listProviders } from '../providers'
import { readRequestBudgetSnapshot } from '../budget/request-budget-store'
import type { RequestBudgetScope } from '../budget/request-budget-types'
import { settingsForCaoGenDrive } from './drive'
import { findConfiguredModelProfile } from './configured-model-profile'
import { councilBudgetConstraints } from '../council/council-request-guard'
import { canonicalRequestBudgets } from '../budget/canonical-request-budget'

export interface NativeRequestBudgetInput {
  rootDir: string
  scope: RequestBudgetScope
  estimatedUsd?: number
}
type BudgetMeta = Pick<SessionMeta, 'id' | 'sdkSessionId' | 'createdAt' | 'costUsd' | 'budgetUsd' | 'providerId' | 'driveMode' | 'goalId' | 'workspaceId' | 'workItemId'>

/** Call from the actual native request boundary, after the wire model/body is
 * fixed. All identity, budget and price inputs come from main-process state. */
export function nativeRequestBudgetInput(input: {
  meta: BudgetMeta; providerId: string; model: string; body: unknown; rootDir?: string
}): NativeRequestBudgetInput {
  const providers = listProviders()
  const provider = providers.find((item) => item.id === input.providerId)
  const profile = findConfiguredModelProfile(input.model, provider?.advancedConfig?.modelProfiles)
  assertNativeRequestContext(input.body, profile?.contextWindow)
  return {
    rootDir: input.rootDir ?? app.getPath('userData'),
    scope: nativeBudgetScope(input.meta, { providerBudgetUsd: provider?.budgetUsd, rootDir: input.rootDir }),
    estimatedUsd: estimateNativeRequestUpperCost(input.body, profile?.pricing)
  }
}

export function nativeBudgetScope(meta: BudgetMeta, input: {
  settings?: AppSettings; history?: HistoryEntry[]; providerBudgetUsd?: number; rootDir?: string
} = {}): RequestBudgetScope {
  const settings = settingsForCaoGenDrive(input.settings ?? getSettings(), meta.driveMode)
  const history = input.history ?? listHistory()
  const current = { ...meta, costUsd: nonnegative(meta.costUsd) }
  const monthly = calculateMonthlyBudgetSnapshot({ settings, history, currentSession: current })
  const council = councilBudgetConstraints(meta, history)
  const canonical = canonicalRequestBudgets(meta, history, input.rootDir ?? app.getPath('userData'))
  const aggregates = [...canonical.budgets, ...council.budgets]
  return {
    ...(canonical.ids.length ? { aggregateBudgetIds: canonical.ids } : {}),
    ...(aggregates.length ? { aggregateBudgets: aggregates } : {}),
    sessionId: meta.id || 'session-creation-preview', sdkSessionId: meta.sdkSessionId,
    sessionTextCostUsd: current.costUsd,
    sessionLimitUsd: positive(meta.budgetUsd) ?? positive(input.providerBudgetUsd) ?? positive(settings.budgetUsdPerSession),
    monthlyLimitUsd: positive(settings.budgetUsdPerMonth), monthlyTextSpentUsd: monthly.spentUsd,
    observedSessions: [...history.map((entry) => ({ id: entry.id, sdkSessionId: entry.sdkSessionId, costUsd: nonnegative(entry.costUsd) })), ...council.observed,
      { id: current.id, sdkSessionId: current.sdkSessionId, costUsd: current.costUsd }].filter((entry) => entry.id)
  }
}

export function nativeBudgetSnapshot(meta: BudgetMeta, input: Parameters<typeof nativeBudgetScope>[1] = {}, rootDir = app.getPath('userData')) {
  return readRequestBudgetSnapshot(rootDir, nativeBudgetScope(meta, { ...input, rootDir }))
}


function positive(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined }
function nonnegative(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0 }
