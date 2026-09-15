import { createHash } from 'node:crypto'
import type { SessionMeta, HistoryEntry } from '../../shared/types'
import type { RequestBudgetScope } from '../budget/request-budget-types'
import type { CouncilRuntimeBinding } from '../../shared/council-types'
import { getProvider, getProviderConnectionIdentity } from '../providers'
import { resolveProviderRuntimeTarget } from '../provider/providerRuntimeTarget'
import { stableValueDigest } from '../task/tool-idempotency'

const bindings = new Map<string, { binding: CouncilRuntimeBinding; persist: () => Promise<void>; metas: () => SessionMeta[] }>()
export function councilConnectionDigest(providerId: string, model: string): string {
  const provider = getProvider(providerId)
  if (!provider) throw new Error('议事模型连接不存在')
  return createHash('sha256').update(stableValueDigest({
    connection: getProviderConnectionIdentity(providerId),
    target: resolveProviderRuntimeTarget(provider, { appId: provider.engine, model }),
    pricing: provider.advancedConfig?.modelProfiles, engine: provider.engine
  })).digest('hex')
}
export function registerCouncilRequestBinding(binding: CouncilRuntimeBinding, persist: () => Promise<void>, metas: () => SessionMeta[]): void {
  bindings.set(binding.record.councilId, { binding, persist, metas })
}
export function isCouncilSession(meta: Pick<SessionMeta, 'orchestrationId' | 'childRole'>): boolean {
  return meta.orchestrationId?.startsWith('council-') === true || meta.childRole?.startsWith('council:') === true
}
function required(meta: SessionMeta) {
  const bound = bindings.get(meta.orchestrationId ?? '')
  const record = bound?.binding.record
  const index = record?.opinions.findIndex((opinion) => opinion.sessionId === meta.id) ?? -1
  if (!bound || !record || index < 0 || record.sessionId !== meta.parentSessionId ||
      record.projectId !== meta.workspaceId || record.goalId !== meta.goalId ||
      meta.taskStrategy !== 'view' || meta.routingScope !== 'fixed' ||
      meta.workItemId !== `${meta.id}-review` || meta.permissionMode !== 'default') {
    throw new Error('议事执行绑定缺失或变化，已阻止请求；请核对原议事记录')
  }
  if (!['preparing', 'running'].includes(record.phase) || Date.now() >= record.deadlineAt) throw new Error('议事已停止或超过截止时间')
  const participant = record.participants[index]
  if (meta.budgetUsd !== participant.budgetUsd) throw new Error('议事预算绑定发生变化')
  return { ...bound, record, participant }
}
export function assertCouncilSend(meta: SessionMeta, messageId?: string): void {
  if (!isCouncilSession(meta)) return
  const { record, binding } = required(meta)
  if (messageId !== `session-input:${meta.id}:goal-start-${record.councilId}` || binding.requestClaims.includes(meta.id)) {
    throw new Error('议事只有一轮；不能继续对话、重试或递归分派')
  }
}
/** Called after Provider overrides, before cost reservation. */
export function boundedCouncilBody(meta: SessionMeta, body: unknown, providerId: string, model: string, protocol: string): unknown {
  if (!isCouncilSession(meta)) return body
  const { binding, participant, record } = required(meta)
  if (providerId !== participant.providerId || model !== participant.model ||
      councilConnectionDigest(providerId, model) !== binding.connectionDigests[participant.institutionId]) {
    throw new Error('议事锁定的模型、连接或价格已变化，请重新预览')
  }
  const parsed = typeof body === 'string' ? JSON.parse(body) : structuredClone(body)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('议事请求无法检查')
  const request = parsed as Record<string, unknown>
  if (request.model !== undefined && request.model !== model) throw new Error('议事实际请求模型与锁定模型不一致')
  delete request.tools
  delete request.tool_choice
  delete request.functions
  delete request.function_call
  delete request.mcp_servers
  delete request.parallel_tool_calls
  delete request.max_tokens
  delete request.max_output_tokens
  delete request.max_completion_tokens
  request[protocol === 'anthropic.messages' ? 'max_tokens' : protocol === 'openai.responses' ? 'max_output_tokens' : 'max_completion_tokens'] = record.limits.maxOutputTokens
  return typeof body === 'string' ? JSON.stringify(request) : request
}
/** Persist the physical dispatch claim first. Even an ambiguous response cannot trigger a retry. */
export async function claimCouncilPhysicalRequest(meta: SessionMeta, url?: string): Promise<void> {
  if (!isCouncilSession(meta)) return
  const { binding, persist, participant } = required(meta)
  if (url) {
    const provider = getProvider(participant.providerId)
    if (!provider) throw new Error('议事连接不存在')
    const target = resolveProviderRuntimeTarget(provider, { appId: provider.engine, model: participant.model })
    const expected = new URL(target.baseUrl)
    const actual = new URL(url)
    const prefix = expected.pathname.replace(/\/$/, '')
    if (expected.origin !== actual.origin || (actual.pathname !== prefix && !actual.pathname.startsWith(`${prefix}/`))) throw new Error('议事实际请求端点与预览不一致')
  }
  if (binding.requestClaims.includes(meta.id)) throw new Error('议事模型请求已经发出；禁止重试，请核对原始记录')
  binding.requestClaims.push(meta.id)
  await persist()
  required(meta)
}
export function councilAllocatedBudget(parentSessionId: string): number {
  return [...bindings.values()].filter(({ binding }) => binding.record.sessionId === parentSessionId)
    .reduce((sum, { binding }) => sum + binding.record.limits.totalBudgetUsd, 0)
}

/** Aggregate constraints share existing per-request reservations without double-charging monthly cost. */
export function councilBudgetConstraints(meta: Pick<SessionMeta, 'id' | 'goalId' | 'workspaceId' | 'sdkSessionId' | 'costUsd'>, history: HistoryEntry[]): {
  budgets: NonNullable<RequestBudgetScope['aggregateBudgets']>; observed: RequestBudgetScope['observedSessions']
} {
  const all = [...bindings.values()]
  const own = all.find(({ binding }) => binding.record.sessionId === meta.id || binding.record.opinions.some((opinion) => opinion.sessionId === meta.id))
  const goal = meta.goalId && meta.workspaceId ? all.filter(({ binding }) => binding.record.goalId === meta.goalId &&
    binding.record.projectId === meta.workspaceId && binding.budgetContext.goalLimitUsd !== undefined) : []
  const live = [...new Map(all.flatMap((bound) => bound.metas()).map((entry) => [entry.id, entry])).values()]
  const entries = [...history, ...live]
  // Use the same observed costs as monthly accounting. Unprojected costs are
  // already retained by the request ledger and must not be subtracted twice.
  const observed = [...new Map([...history, meta].map((entry) => [entry.id, { id: entry.id, sdkSessionId: entry.sdkSessionId, costUsd: Math.max(0, entry.costUsd ?? 0) }])).values()]
  const total = (ids: string[]) => {
    const grouped = new Map<string, number>()
    for (const entry of observed.filter((entry) => ids.includes(entry.id))) {
      const key = entry.sdkSessionId || entry.id
      grouped.set(key, Math.max(grouped.get(key) ?? 0, entry.costUsd))
    }
    return [...grouped.values()].reduce((sum, value) => sum + value, 0)
  }
  const budgets: NonNullable<RequestBudgetScope['aggregateBudgets']> = []
  if (own) {
    const siblings = all.filter(({ binding }) => binding.record.sessionId === own.binding.record.sessionId)
    const limits = siblings.flatMap(({ binding }) => binding.budgetContext.parentLimitUsd === undefined ? [] : [binding.budgetContext.parentLimitUsd])
    const currentParent = live.find((entry) => entry.id === own.binding.record.sessionId)
    if (currentParent?.budgetUsd && currentParent.budgetUsd > 0) limits.push(currentParent.budgetUsd)
    if (limits.length) {
      const ids = [...new Set([own.binding.record.sessionId, ...siblings.flatMap(({ binding }) => binding.record.opinions.map((opinion) => opinion.sessionId))])]
      budgets.push({ id: `council-parent:${own.binding.record.sessionId}`, sessionIds: ids, limitUsd: Math.min(...limits), textSpentUsd: total(ids) })
    }
  }
  if (goal.length) {
    const ids = [...new Set([...goal.flatMap(({ binding }) => [binding.record.sessionId, ...binding.budgetContext.goalSessionIds,
      ...binding.record.opinions.map((opinion) => opinion.sessionId)]), ...entries.filter((entry) => entry.goalId === meta.goalId && entry.workspaceId === meta.workspaceId).map((entry) => entry.id)])]
    budgets.push({ id: `council-goal:${meta.workspaceId}:${meta.goalId}`, sessionIds: ids,
      limitUsd: Math.min(...goal.map(({ binding }) => binding.budgetContext.goalLimitUsd!)),
      textSpentUsd: Math.max(total(ids), ...goal.map(({ binding }) => binding.budgetContext.goalSpentUsd)) })
  }
  return { budgets, observed }
}
