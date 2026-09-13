import type { RoutingLegacyJsonValue, RoutingPreviewContext, RoutingUserIntent } from '../../shared/routing-policy-types'
import type { SchedulerStrategy } from '../../shared/types'
import type { TrustedRoutingContext } from '../model/routing-policy/evaluator-types'
import { rejectSettings } from '../routing-settings/routing-settings-state'
import type { RoutingSettingsDocument } from '../routing-settings/routing-settings-types'
import { readRoutingBusinessLines } from './routing-catalog'

/** Supplied only by the main process after resolving canonical Session ownership. */
export interface VerifiedRoutingPreviewSession {
  sessionId: string
  businessLineId: string
  routingIntent: RoutingUserIntent
  task: TrustedRoutingContext['task']
  authority: RoutingLegacyJsonValue
}

export function resolveRoutingPreviewContext(input: {
  request: RoutingPreviewContext; document: RoutingSettingsDocument
  resolveSession(id: string): VerifiedRoutingPreviewSession | undefined
}): { context: TrustedRoutingContext; authority: RoutingLegacyJsonValue } {
  const request = input.request
  const session = request.kind === 'session' ? input.resolveSession(request.sessionId) : undefined
  if (request.kind === 'session' && (!session || session.sessionId !== request.sessionId)) {
    rejectSettings('PREVIEW_UNAVAILABLE', '$.context.sessionId', '任务不存在或无法确认其归属，不能预演。')
  }
  const businessLineId = session?.businessLineId ?? (request.kind === 'new_task' ? request.businessLineId : '')
  const line = readRoutingBusinessLines(input.document).find((item) => item.id === businessLineId)
  if (!line?.enabled) rejectSettings('BUSINESS_LINE_UNAVAILABLE', '$.context.businessLineId', '业务线不存在或已停用。')
  const globalStrategy = readGlobalStrategy(input.document)
  const userIntent = session?.routingIntent ?? (request.kind === 'new_task' ? request.routingIntent : { kind: 'global' as const })
  return { context: { executionDomain: 'native_text', originalPrompt: request.prompt,
    businessLine: { id: line.id, enabled: line.enabled, requiredCapabilities: line.requiredCapabilities ?? [] },
    userIntent, baseStrategy: line.routingPreference ?? globalStrategy,
    baseStrategySource: line.routingPreference ? { kind: 'business_line', businessLineId: line.id } : { kind: 'global' },
    task: session?.task ?? { requiresTools: true } },
    authority: session?.authority ?? { kind: 'new_task', businessLineId: line.id } }
}

function readGlobalStrategy(document: RoutingSettingsDocument): SchedulerStrategy {
  const value = document.schedulerStrategy ?? 'balanced'
  if (value === 'balanced' || value === 'quality' || value === 'cost' || value === 'speed') return value
  return rejectSettings('INVALID_VALUE', '$.schedulerStrategy', '全局路由偏好无效。')
}
