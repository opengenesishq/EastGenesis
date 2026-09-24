import type { IpcMain } from 'electron'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { getSettings, updateSettings, getRoutingSettingsBoundary } from '../settings'
import { listProviders, getProviderConnectionIdentity } from '../providers'
import { configureProviderCircuitBreaker } from '../providerHealth'
import { revokeAllGuiAutomationGrants } from '../permission/permission-manager'
import { browserDebugController } from '../browser-debug/controller'
import { buildRoutingSettingsCatalog } from '../routing-service/routing-catalog'
import { createRoutingRuleService } from '../routing-service/routing-rule-service'
import { resolveRoutingPreviewContext } from '../routing-service/routing-preview-context'
import { captureNewTaskRouting, captureSessionRouting } from '../routing-service/session-routing-capture'
import type { RoutingPreviewCapture } from '../routing-service/routing-preview-types'
import type { RoutingSettingsSnapshot } from '../routing-settings/routing-settings-types'
import { sessionManager } from '../sessionManager'
import type { AppSettings } from '../../shared/types'
import type { RoutingRulePreviewInput, RoutingRuleSaveInput, RoutingRulePreviewResult } from '../../shared/routing-policy-types'
import { sessionRoutingControl, sessionRoutingIntent } from '../../shared/session-routing-control-types'
import { digest } from '../task/workflow-ledger-canonical'

let service: ReturnType<typeof createRoutingRuleService> | undefined

function routingService() {
  if (service) return service
  const boundary = getRoutingSettingsBoundary()
  const deps = {
    ...boundary,
    inheritedStrategy: getSettings().schedulerStrategy,
    validateCatalog: ({ document, rules }: { document: Record<string, any>; rules: readonly any[] }) =>
      buildRoutingSettingsCatalog({
        document,
        rules,
        providers: listProviders(),
        connectionIdentities: new Map(listProviders().map((provider) => {
          const identity = getProviderConnectionIdentity(provider.id)
          return [provider.id, JSON.stringify(identity)] as const
        }))
      }),
    capturePreview: async (input: { context: import('../../shared/routing-policy-types').RoutingPreviewContext; settings: RoutingSettingsSnapshot }): Promise<RoutingPreviewCapture> => {
      const request = input.context
      if (request.kind === 'session') {
        const engine = sessionManager.get(request.sessionId)
        if (!engine) throw new Error('任务不存在或无法确认其归属，不能预演。')
        const meta = engine.meta
        // Resolve the public request through the canonical Session binding. The
        // renderer cannot supply ownership, intent, provider, or budget fields.
        const resolved = resolveRoutingPreviewContext({
          request, document: input.settings.document,
          resolveSession: (sessionId) => sessionId === meta.id ? {
            sessionId: meta.id,
            businessLineId: meta.businessLineId ?? (() => { throw new Error('任务缺少业务线归属，不能预演。') })(),
            routingIntent: sessionRoutingIntent(meta),
            task: { requiresTools: true, contextTokens: meta.contextTokens },
            authority: { sessionId: meta.id, workspaceId: meta.workspaceId ?? null,
              goalId: meta.goalId ?? null, workItemId: meta.workItemId ?? null }
          } : undefined
        })
        const capture = captureSessionRouting({ meta, prompt: request.prompt })
        // Keep the resolver's canonical intent/business-line decision as the
        // evaluator input; capture supplies the trusted provider/budget view.
        const resolvedAuthority = resolved.authority && typeof resolved.authority === 'object' ? resolved.authority : {}
        return { ...capture, context: resolved.context, authority: { ...capture.authority, ...resolvedAuthority } }
      }
      const resolved = resolveRoutingPreviewContext({ request, document: input.settings.document, resolveSession: () => undefined })
      return captureNewTaskRouting({ context: resolved.context, authority: resolved.authority })
    },
    isPreviewCaptureCurrent: (capture: RoutingPreviewCapture) => {
      const authority = capture.authority as Record<string, unknown>
      const identities = authority.connectionIdentities
      if (!identities || typeof identities !== 'object') return false
      const current = new Map(listProviders().map((provider) => [provider.id, JSON.stringify(getProviderConnectionIdentity(provider.id))]))
      const expected = identities as Record<string, unknown>
      if (Object.keys(expected).length !== current.size || Object.entries(expected).some(([id, identity]) => current.get(id) !== identity)) return false
      if (authority.kind !== 'session') return true
      const sessionId = typeof authority.sessionId === 'string' ? authority.sessionId : ''
      const engine = sessionManager.get(sessionId)
      if (!engine) return false
      const meta = engine.meta
      return meta.businessLineId === authority.businessLineId
        && meta.providerId === authority.providerId
        && meta.model === authority.model
        && (meta.executorEngine ?? null) === (authority.executorEngine ?? null)
        && (meta.routingScope ?? 'global') === (authority.routingScope ?? 'global')
        && authority.routingControl !== undefined
        && digest(sessionRoutingControl(meta)) === digest(authority.routingControl)
        && (meta.workspaceId ?? null) === (authority.workspaceId ?? null)
        && (meta.goalId ?? null) === (authority.goalId ?? null)
        && (meta.workItemId ?? null) === (authority.workItemId ?? null)
    }
  }
  service = createRoutingRuleService(deps)
  return service
}

function previewUnavailable(error?: unknown): RoutingRulePreviewResult {
  const message = error instanceof Error ? error.message : '当前设置域未能建立真实预演上下文。'
  return {
    status: 'blocked',
    draftDigest: '', catalogDigest: '', contextDigest: '', previewDigest: '',
    matchedRules: [], allowedAlternatives: [], excludedTargets: [], conflicts: [],
    diagnostics: [{ code: 'PREVIEW_UNAVAILABLE', severity: 'error', path: '$.context',
      message: `${message} 未执行任何 Provider 请求。` }],
    limitations: { kind: 'local_configuration_only', providerRequestsMade: false, realTaskVerified: false }
  }
}

/** Five explicit settings-domain methods; no renderer-owned generic command channel. */
export function registerSettingsDomainIpc(ipcMain: IpcMain): void {
  ipcMain.handle('settings-domain:get', (event) => {
    assertTrustedWorkflowLedgerSender(event)
    return getSettings()
  })
  ipcMain.handle('settings-domain:update', async (event, patch: Partial<AppSettings>) => {
    assertTrustedWorkflowLedgerSender(event)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('settings-domain:update requires one object argument')
    const next = updateSettings(patch)
    if (!next.guiAutomationEnabled) revokeAllGuiAutomationGrants()
    if (next.browserDebug?.enabled !== true) browserDebugController.revokeAll()
    configureProviderCircuitBreaker(next.providerCircuitBreaker)
    return next
  })
  ipcMain.handle('settings-domain:routing:get', (event) => {
    assertTrustedWorkflowLedgerSender(event)
    return routingService().read()
  })
  ipcMain.handle('settings-domain:routing:preview', async (event, input: RoutingRulePreviewInput) => {
    assertTrustedWorkflowLedgerSender(event)
    if (!input || typeof input !== 'object') throw new Error('settings-domain:routing:preview requires one input argument')
    try { return await routingService().preview(input) } catch (error) { return previewUnavailable(error) }
  })
  ipcMain.handle('settings-domain:routing:save', async (event, input: RoutingRuleSaveInput) => {
    assertTrustedWorkflowLedgerSender(event)
    if (!input || typeof input !== 'object') throw new Error('settings-domain:routing:save requires one input argument')
    return routingService().save(input)
  })
}
