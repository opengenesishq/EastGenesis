import type { CouncilRuntimeBinding } from '../../shared/council-types'
import { isProjectInstitutionTemplateRef, projectInstitutionTemplate } from '../../shared/project-institution-template'
import { stableValueDigest } from '../task/tool-idempotency'

const string = (value: unknown): value is string => typeof value === 'string'
const id = (value: unknown): value is string => string(value) && /^[A-Za-z0-9_-]{1,160}$/.test(value)
const digest = (value: unknown): value is string => string(value) && /^[a-f0-9]{64}$/.test(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const optionalString = (value: unknown) => value === undefined || string(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Reject malformed, unbounded, cross-task, duplicate or changed recovery bindings. */
export function isCouncilRuntimeBinding(value: unknown): value is CouncilRuntimeBinding {
  if (!object(value) || value.schemaVersion !== 1 || !object(value.record) || !string(value.context) || value.context.length > 32_000 ||
      !object(value.connectionDigests) || !Array.isArray(value.requestClaims) || !object(value.budgetContext)) return false
  const budget = value.budgetContext
  if ((budget.parentLimitUsd !== undefined && (!finite(budget.parentLimitUsd) || budget.parentLimitUsd < 0)) ||
      (budget.goalLimitUsd !== undefined && (!finite(budget.goalLimitUsd) || budget.goalLimitUsd < 0)) ||
      !finite(budget.goalSpentUsd) || budget.goalSpentUsd < 0 || !Array.isArray(budget.goalSessionIds) || budget.goalSessionIds.some((entry) => !id(entry))) return false
  const r = value.record
  if (r.schemaVersion !== 1 || !id(r.sessionId) || !id(r.requestId) || !id(r.projectId) || !id(r.goalId) || !id(r.workItemId) ||
      !id(r.councilId) || !r.councilId.startsWith('council-') || !string(r.topic) || !r.topic.trim() || r.topic.length > 4000 ||
      !isProjectInstitutionTemplateRef(r.template) || !digest(r.previewDigest) || !object(r.limits) || !Array.isArray(r.participants) ||
      r.participants.length < 1 || r.participants.length > 2 || !Array.isArray(r.opinions) || r.opinions.length !== r.participants.length ||
      !Array.isArray(r.blockedReasons) || r.blockedReasons.length !== 0 || !finite(r.startedAt) || !finite(r.deadlineAt) ||
      !['preparing', 'running', 'completed', 'stopped', 'needs_reconciliation'].includes(String(r.phase)) ||
      (r.completedAt !== undefined && !finite(r.completedAt)) || !optionalString(r.report) || !optionalString(r.error)) return false
  const l = r.limits
  if (l.rounds !== 1 || l.maxParticipants !== 2 || l.retries !== 0 || !finite(l.timeoutMs) || l.timeoutMs <= 0 || l.timeoutMs > 300_000 ||
      !finite(l.totalBudgetUsd) || l.totalBudgetUsd <= 0 || l.totalBudgetUsd > 0.5 || !finite(l.maxOutputTokens) ||
      !Number.isSafeInteger(l.maxOutputTokens) || l.maxOutputTokens <= 0 || l.maxOutputTokens > 2048 || r.deadlineAt !== r.startedAt + l.timeoutMs) return false
  const institutionIds = new Set<string>(), childIds = new Set<string>()
  let allocation = 0
  const roles = projectInstitutionTemplate(r.template).roles
  for (let index = 0; index < r.participants.length; index++) {
    const p = r.participants[index], opinion = r.opinions[index]
    if (!object(p) || !id(p.institutionId) || institutionIds.has(p.institutionId) || !string(p.institutionName) || !string(p.duty) ||
        !id(p.providerId) || !string(p.providerName) || !string(p.model) || !p.model.trim() || !['openai', 'anthropic'].includes(String(p.engine)) ||
        !finite(p.budgetUsd) || p.budgetUsd <= 0 || !digest(value.connectionDigests[p.institutionId]) || !object(opinion) ||
        opinion.institutionId !== p.institutionId || opinion.sessionId !== `${r.councilId}-${index + 1}` ||
        !['pending', 'running', 'completed', 'failed', 'needs_reconciliation'].includes(String(opinion.status)) ||
        !optionalString(opinion.conclusion) || !optionalString(opinion.error)) return false
    const role = roles.find((entry) => entry.id === p.institutionId)
    if (!role || role.name !== p.institutionName || role.duty !== p.duty || !['on_demand', 'legacy'].includes(role.participation)) return false
    institutionIds.add(p.institutionId); childIds.add(opinion.sessionId as string); allocation += p.budgetUsd
  }
  if (Math.abs(allocation - l.totalBudgetUsd) > 0.0000001 || value.requestClaims.some((entry) => !string(entry) || !childIds.has(entry)) ||
      new Set(value.requestClaims).size !== value.requestClaims.length || Object.keys(value.connectionDigests).length !== institutionIds.size) return false
  const { councilId, phase, startedAt, deadlineAt, completedAt, opinions, report, error, previewDigest, ...preview } = r
  return councilId === `council-${stableValueDigest({ sessionId: r.sessionId, requestId: r.requestId }).slice(0, 32)}` &&
    previewDigest === stableValueDigest({ ...preview, context: value.context, connectionDigests: value.connectionDigests, budgetContext: value.budgetContext })
}
