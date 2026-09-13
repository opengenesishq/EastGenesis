import { ipcMain } from 'electron'
import type {
  ProviderAuthorizationAccountPolicy,
  ProviderAuthorizationMutation,
  ProviderAuthorizationService
} from '../../shared/provider-authorization-types'
import type { ProviderView } from '../../shared/types'
import {
  applyProviderAuthorizationMutation,
  listProviderAuthorizationAccounts
} from '../provider/providerAuthorizationAccountService'
import {
  bindProviderAuthorizationAccount,
  pollQuickProviderAuthorization,
  pollProviderAuthorization,
  queryProviderAuthorizationQuota,
  refreshProviderAuthorization,
  revokeProviderAuthorization,
  startQuickProviderAuthorization,
  startProviderAuthorization
} from '../provider/providerAuthorizationService'
import { executeProviderOperationEffect } from '../provider/providerOperationEffect'

export function registerProviderAuthorizationIpc(): void {
  ipcMain.handle('providers:authorization:start', (_e, providerId: string, service?: string) => {
    const normalizedProviderId = stringValue(providerId)
    const normalizedService = normalizeAuthorizationService(service)
    return executeProviderOperationEffect(
      'provider_authorization_start',
      'Start Provider authorization',
      { providerId: normalizedProviderId, service: normalizedService },
      () => startProviderAuthorization(normalizedProviderId, normalizedService)
    )
  })
  ipcMain.handle('providers:authorization:quick-start', (_e, service?: string) => {
    const normalizedService = normalizeAuthorizationService(service)
    return executeProviderOperationEffect(
      'provider_authorization_quick_start',
      'Start quick Provider authorization',
      { service: normalizedService },
      () => startQuickProviderAuthorization(normalizedService)
    )
  })
  ipcMain.handle('providers:authorization:quick-poll', (_e, flowId: string) => {
    const normalizedFlowId = stringValue(flowId)
    return executeProviderOperationEffect(
      'provider_authorization_quick_poll',
      'Poll quick Provider authorization',
      { flowId: normalizedFlowId },
      () => pollQuickProviderAuthorization(normalizedFlowId)
    )
  })
  ipcMain.handle('providers:authorization:poll', (_e, providerId: string, flowId: string) => {
    const normalizedProviderId = stringValue(providerId)
    const normalizedFlowId = stringValue(flowId)
    return executeProviderOperationEffect(
      'provider_authorization_poll',
      'Poll Provider authorization',
      { providerId: normalizedProviderId, flowId: normalizedFlowId },
      () => pollProviderAuthorization(normalizedProviderId, normalizedFlowId)
    )
  })
  ipcMain.handle('providers:authorization:accounts', (_e, providerId: string) =>
    listProviderAuthorizationAccounts(stringValue(providerId)))
  ipcMain.handle('providers:authorization:bind', (
    _e,
    providerId: string,
    accountId: string,
    mutation?: ProviderAuthorizationMutation
  ) => bindOrMutate(providerId, accountId, mutation))
  ipcMain.handle('providers:authorization:refresh', (_e, providerId: string) => {
    const normalizedProviderId = stringValue(providerId)
    return executeProviderOperationEffect(
      'provider_authorization_refresh',
      'Refresh Provider authorization',
      { providerId: normalizedProviderId },
      () => refreshProviderAuthorization(normalizedProviderId)
    )
  })
  ipcMain.handle('providers:authorization:revoke', (_e, providerId: string, accountId?: string) =>
    revokeProviderAuthorization(stringValue(providerId), optionalStringValue(accountId)))
  ipcMain.handle('providers:authorization:quota', (_e, providerId: string, accountId?: string) => {
    const normalizedProviderId = stringValue(providerId)
    const normalizedAccountId = optionalStringValue(accountId)
    return executeProviderOperationEffect(
      'provider_authorization_quota',
      'Query Provider authorization quota',
      { providerId: normalizedProviderId, accountId: normalizedAccountId },
      () => queryProviderAuthorizationQuota(normalizedProviderId, normalizedAccountId)
    )
  })
}

export function bindOrMutate(
  providerId: string,
  accountId: string,
  mutation?: ProviderAuthorizationMutation
): Promise<ProviderView> {
  const normalizedProviderId = stringValue(providerId)
  const normalizedAccountId = stringValue(accountId)
  const normalizedMutation = normalizeProviderAuthorizationMutation(mutation)
  return executeProviderOperationEffect(
    'provider_authorization_bind',
    normalizedMutation ? 'Update Provider authorization routing' : 'Bind Provider authorization account',
    { providerId: normalizedProviderId, accountId: normalizedAccountId, mutation: normalizedMutation },
    () => normalizedMutation
      ? applyProviderAuthorizationMutation(normalizedProviderId, normalizedAccountId, normalizedMutation)
      : bindProviderAuthorizationAccount(normalizedProviderId, normalizedAccountId)
  )
}

function normalizeProviderAuthorizationMutation(value: unknown): ProviderAuthorizationMutation | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provider authorization mutation is invalid')
  }
  const mutation = value as Record<string, unknown>
  if (mutation.kind === 'routing-mode') return normalizeRoutingMutation(mutation.mode)
  if (mutation.kind === 'account-policy') {
    return { kind: 'account-policy', policy: normalizeAuthorizationAccountPolicy(mutation.policy) }
  }
  throw new Error('Provider authorization mutation kind is invalid')
}

function normalizeRoutingMutation(mode: unknown): ProviderAuthorizationMutation {
  if (mode !== 'manual' && mode !== 'preferred' && mode !== 'automatic') {
    throw new Error('Provider authorization routing mode is invalid')
  }
  return { kind: 'routing-mode', mode }
}

function normalizeAuthorizationAccountPolicy(value: unknown): Partial<ProviderAuthorizationAccountPolicy> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provider authorization account policy is invalid')
  }
  const input = value as Record<string, unknown>
  const policy: Partial<ProviderAuthorizationAccountPolicy> = {}
  if (typeof input.enabled === 'boolean') policy.enabled = input.enabled
  if (typeof input.priority === 'number') policy.priority = input.priority
  if (typeof input.minimumQuotaRemainingPercent === 'number') {
    policy.minimumQuotaRemainingPercent = input.minimumQuotaRemainingPercent
  }
  if (typeof input.requireKnownQuota === 'boolean') policy.requireKnownQuota = input.requireKnownQuota
  if (typeof input.failureCooldownMinutes === 'number') policy.failureCooldownMinutes = input.failureCooldownMinutes
  return policy
}

function normalizeAuthorizationService(value: unknown): ProviderAuthorizationService {
  if (value === undefined || value === 'xai-oauth') return 'xai-oauth'
  throw new Error('Provider authorization service is not supported')
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
