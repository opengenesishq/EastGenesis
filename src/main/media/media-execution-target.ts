import type { MediaJobRecord, MediaProviderProfile } from '../../shared/media-types'
import type { Provider } from '../../shared/types'
import { resolveProviderRuntimeTarget } from '../provider/providerRuntimeTarget'
import { readProviderConnectionIdentity } from '../provider/providerConnectionIdentity'
import { assertFrozenMediaRouteBinding } from './media-frozen-route'

export function resolveMediaExecutionTarget(provider: Provider, profile: MediaProviderProfile, job: MediaJobRecord) {
  const current = resolveProviderRuntimeTarget(provider, { appId: 'caogen-media', model: profile.model ?? job.model })
  const bound = job.executionBinding?.target
  assertFrozenMediaRouteBinding(job, profile, provider.id)
  if (!bound) return current
  const fields = ['baseUrl', 'model', 'protocol', 'endpointId', 'appBindingId', 'accountId'] as const
  if (provider.id !== job.executionBinding?.profile.providerId || fields.some((field) => current[field] !== bound[field])) {
    throw new Error('媒体任务已绑定的连接发生变更；请恢复原连接后查询原任务，不能改用其他厂商重新提交。')
  }
  if (bound.connectionIdentity) {
    const identity = readProviderConnectionIdentity(provider)
    if (identity.generationId !== bound.connectionIdentity.generationId || identity.revision !== bound.connectionIdentity.revision) {
      throw new Error('媒体任务已绑定的 Provider 连接身份发生变更；请恢复原连接后查询原任务。')
    }
  }
  return bound
}

/** An asynchronous provider job remains scoped to the credential that submitted it. */
export function boundMediaCredentialKey(provider: Provider, job: MediaJobRecord): string | undefined {
  const bound = job.executionBinding?.credential
  if (!bound) return undefined
  if ((provider.authMode ?? 'api-key') !== bound.authMode || (bound.authMode === 'api-key' && !bound.keyId)) {
    throw new Error('媒体任务原凭据绑定已变更，请恢复原连接后对账。')
  }
  return bound.keyId
}
