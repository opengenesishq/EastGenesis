import type { ProviderView, RoutingExpertPolicy } from '../../shared/types'
import type { ProviderRuntimeTarget } from '../provider/providerRuntimeTarget'
import { resolveProviderRuntimeTarget } from '../provider/providerRuntimeTarget'

export interface RoutingExpertPolicyResult {
  providers: ProviderView[]
  warnings: string[]
}

export function applyRoutingExpertPolicy(
  providers: ProviderView[],
  policy: RoutingExpertPolicy
): RoutingExpertPolicyResult {
  const allowed = new Set(policy.allowedProviderIds ?? [])
  const scoped = (allowed.size > 0 ? providers.filter((provider) => allowed.has(provider.id)) : providers)
    .filter((provider) => {
      try { return providerAllowedByRoutingExpertPolicy(provider, policy, resolveProviderRuntimeTarget(provider, { appId: provider.engine })) }
      catch { return false }
    })
  const local = scoped.filter((provider) => {
    try { return isLocalProviderUrl(resolveProviderRuntimeTarget(provider, { appId: provider.engine }).baseUrl) }
    catch { return isLocalProviderUrl(provider.baseUrl) }
  })
  const scopeWarning = allowed.size > 0
    ? [`专家策略已将候选限制为 ${allowed.size} 个 Provider。`]
    : []

  if (policy.locality === 'local_only') {
    return {
      providers: local,
      warnings: [...scopeWarning, '专家策略禁止模型数据外发，仅允许回环 Provider。']
    }
  }
  if (policy.locality === 'prefer_local' && local.length > 0) {
    return {
      providers: local,
      warnings: [...scopeWarning, '专家策略优先本地，本轮仅在可用回环 Provider 中选路。']
    }
  }
  return {
    providers: scoped,
    warnings: policy.locality === 'prefer_local'
      ? [...scopeWarning, '专家策略优先本地，但没有可用回环 Provider，已保留允许的远程候选。']
      : scopeWarning
  }
}

export function providerAllowedByRoutingExpertPolicy(
  provider: Pick<ProviderView, 'id' | 'baseUrl'>,
  policy: RoutingExpertPolicy,
  endpoint?: Pick<ProviderRuntimeTarget, 'baseUrl' | 'region' | 'domain' | 'permissionTags'>
): boolean {
  if ((policy.allowedProviderIds ?? []).length > 0 && !(policy.allowedProviderIds ?? []).includes(provider.id)) return false
  const effective: Pick<ProviderRuntimeTarget, 'baseUrl' | 'region' | 'domain' | 'permissionTags'> = endpoint ?? provider
  if (policy.locality === 'local_only' && !isLocalProviderUrl(effective.baseUrl)) return false
  const regions = policy.allowedRegions ?? []
  if (regions.length && (!effective.region || !regions.includes(effective.region.trim().toLowerCase()))) return false
  const domains = policy.allowedDomains ?? []
  if (domains.length) {
    const domain = (effective.domain ?? hostname(effective.baseUrl))?.trim().toLowerCase()
    if (!domain || !domains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`))) return false
  }
  const permissions = policy.requiredPermissions ?? []
  if (permissions.length) {
    const tags = new Set((effective.permissionTags ?? []).map((tag: string) => tag.trim().toLowerCase()))
    if (permissions.some((required) => !tags.has(required.trim().toLowerCase()))) return false
  }
  return true
}

export function assertRoutingExpertTargetAllowed(
  providerId: string,
  baseUrl: string,
  policy: RoutingExpertPolicy,
  endpoint?: Pick<ProviderRuntimeTarget, 'baseUrl' | 'region' | 'domain' | 'permissionTags'>
): void {
  if ((policy.allowedProviderIds ?? []).length > 0 && !(policy.allowedProviderIds ?? []).includes(providerId)) {
    throw new Error(`Provider ${providerId} is blocked by the routing expert allowlist`)
  }
  if (!providerAllowedByRoutingExpertPolicy({ id: providerId, baseUrl }, policy, endpoint)) {
    const reason = policy.locality === 'local_only' ? 'model data egress is disabled' : 'region, domain or permission policy excludes the endpoint'
    throw new Error(`Provider ${providerId} is blocked because ${reason}`)
  }
  if (policy.locality === 'local_only' && !isLocalProviderUrl(baseUrl) && !endpoint) {
    throw new Error(`Provider ${providerId} is blocked because model data egress is disabled`)
  }
}

function hostname(baseUrl: string): string | undefined {
  try { return new URL(baseUrl).hostname.toLowerCase() } catch { return undefined }
}

export function isLocalProviderUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || /^127(?:\.\d{1,3}){3}$/.test(host)
  } catch {
    return false
  }
}
