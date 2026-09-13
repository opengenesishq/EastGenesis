import { isBusinessLineId } from '../../../shared/business-line-types'
import type { RoutingDiagnostic } from '../../../shared/routing-policy-types'
import type { RoutingEvaluatorInput } from './evaluator-types'
import { issue } from './evaluator-rules'

/** Internal-shape checks supplement, never replace, the shared rules/IPC parser. */
export function validateEvaluationBoundary(input: RoutingEvaluatorInput): RoutingDiagnostic[] {
  const context = input.context
  if (context.executionDomain !== 'native_text') return [issue('INVALID_VALUE', '$.executionDomain', 'Only native_text is implemented; image/video/voice generation is not covered.')]
  if (!isBusinessLineId(context.businessLine.id) || !context.businessLine.enabled) {
    return [issue('BUSINESS_LINE_UNAVAILABLE', '$.context.businessLine', 'Main must bind an existing enabled business line.')]
  }
  if (!['balanced', 'quality', 'cost', 'speed'].includes(context.baseStrategy)) return invalid('$.context.baseStrategy')
  const sourceError = baseStrategySourceError(input)
  if (sourceError.length) return sourceError
  if (typeof context.originalPrompt !== 'string' || !context.originalPrompt.trim()) return invalid('$.context.originalPrompt')
  if (context.businessLine.requiredCapabilities.some((value) => value !== 'tools' && value !== 'vision')) return invalid('$.context.businessLine.requiredCapabilities')
  const taskError = taskInputError(input)
  if (taskError.length) return taskError
  return validateSnapshots(input)
}

function baseStrategySourceError(input: RoutingEvaluatorInput): RoutingDiagnostic[] {
  const { baseStrategySource, businessLine } = input.context
  if (baseStrategySource.kind === 'global') return []
  if (baseStrategySource.kind === 'business_line' && baseStrategySource.businessLineId === businessLine.id) return []
  return invalid('$.context.baseStrategySource')
}

function taskInputError(input: RoutingEvaluatorInput): RoutingDiagnostic[] {
  const task = input.context.task
  for (const field of ['contextTokens', 'expectedOutputTokens'] as const) {
    const value = task[field]
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) return invalid(`$.context.task.${field}`)
  }
  const intent = input.context.userIntent
  if (!['global', 'provider', 'fixed'].includes(intent.kind)) return invalid('$.context.userIntent')
  if (intent.kind === 'provider' && !intent.providerId.trim()) return invalid('$.context.userIntent.providerId')
  if (intent.kind === 'fixed' && (!intent.target.providerId.trim() || !intent.target.model.trim() || intent.target.model === 'auto')) return invalid('$.context.userIntent.target')
  return []
}

function validateSnapshots(input: RoutingEvaluatorInput): RoutingDiagnostic[] {
  const snapshots = input.snapshots
  const providers = snapshots.providers
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length) return invalid('$.snapshots.providers')
  if (providers.some((provider) => !['openai', 'anthropic', 'gemini'].includes(provider.engine))) return invalid('$.snapshots.providers.engine')
  if (!['any', 'local_only', 'prefer_local'].includes(snapshots.expertPolicy.locality)) return invalid('$.snapshots.expertPolicy.locality')
  const remaining = snapshots.budget?.remainingUsd
  if (remaining !== undefined && (!Number.isFinite(remaining) || remaining < 0)) return invalid('$.snapshots.budget.remainingUsd')
  if (snapshots.budget?.hardLimit && remaining === 0) return [issue('HARD_CONSTRAINT_EXCLUDED', '$.budget', 'Hard remaining budget is exhausted; settings zero=unlimited is not accepted as a remaining balance.')]
  return []
}

function invalid(path: string): RoutingDiagnostic[] { return [issue('INVALID_VALUE', path, 'Invalid trusted evaluation input; main must supply a validated snapshot.')] }
