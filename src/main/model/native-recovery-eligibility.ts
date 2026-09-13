import type { ProviderView, SessionMeta, SessionRoutingScope } from '../../shared/types'
import { AUTO_MODEL } from '../../shared/types'
import { buildModelProfiles } from './model-profile'
import { findConfiguredModelProfile } from './configured-model-profile'
import { ModelRouteError } from './model-route-error'

export type NativeRecoveryCapability = 'tools' | 'vision'
export interface NativeRecoveryTarget { providerId: string; model: string }
export interface NativeRecoveryRuleTarget { providerId?: string; model?: string }

/** Captured once after initial selection, before recovery may mutate SessionMeta.
 * No credentials, endpoint headers, mutable Provider records or prompt are retained. */
export interface NativeRecoveryAnchor {
  readonly schemaVersion: 1
  readonly scope: SessionRoutingScope
  readonly target: Readonly<NativeRecoveryTarget>
  readonly ruleTarget?: Readonly<NativeRecoveryRuleTarget>
  readonly requiredCapabilities: readonly NativeRecoveryCapability[]
  readonly minContextTokens?: number
  readonly catalogTargets: readonly Readonly<NativeRecoveryTarget>[]
  readonly declaredContextWindows: readonly Readonly<NativeRecoveryTarget & { contextWindow: number }>[]
  readonly initialTargetWasListed: boolean
}

export interface NativeRecoveryCheck {
  anchor: NativeRecoveryAnchor
  provider: ProviderView
  /** A declared model name, alias, or resolved wire model. */
  model: string
  currentRequiredCapabilities?: readonly NativeRecoveryCapability[]
  /** A changed rule can narrow this turn's frozen domain, never replace it. */
  currentRuleTarget?: NativeRecoveryRuleTarget
}

export function createNativeRecoveryAnchor(input: {
  meta: Pick<SessionMeta, 'providerId' | 'model' | 'routingScope'>
  target: NativeRecoveryTarget
  providers: ProviderView[]
  ruleTarget?: NativeRecoveryRuleTarget
  requiredCapabilities?: readonly NativeRecoveryCapability[]
  minContextTokens?: number
}): NativeRecoveryAnchor {
  const provider = input.providers.find((item) => item.id === input.target.providerId)
  if (!provider) throw new ModelRouteError('ROUTING_MANUAL_TARGET_UNAVAILABLE', '本轮初选连接不存在，不能建立故障恢复范围。')
  const scope = recoveryScope(input.meta)
  if (!input.target.model.trim() || input.target.model === AUTO_MODEL) {
    throw new ModelRouteError('ROUTING_MANUAL_TARGET_UNAVAILABLE', '故障恢复必须绑定已解析的实际模型。')
  }
  if (scope !== 'global' && input.meta.providerId !== provider.id) {
    throw new ModelRouteError('ROUTING_MANUAL_TARGET_UNAVAILABLE', '本轮初选连接与用户限定范围不一致。')
  }
  const target = Object.freeze({ providerId: provider.id, model: canonicalModel(provider, input.target.model) })
  const ruleTarget = normalizedRuleTarget(input.ruleTarget)
  const requiredCapabilities = [...new Set(input.requiredCapabilities ?? [])]
  const minContextTokens = validatedContextFloor(input.minContextTokens)
  const initialTargetWasListed = provider.models.some((model) => canonicalModel(provider, model) === target.model)
  const catalogTargets = snapshotCatalogTargets(input.providers, ruleTarget, requiredCapabilities, minContextTokens)
  // A manually entered fixed target may predate discovery. It permits only the
  // exact initial target; it is not permission to discover extra recovery models.
  if (!initialTargetWasListed) catalogTargets.push(target)
  return Object.freeze({
    schemaVersion: 1, scope, target,
    ...(ruleTarget ? { ruleTarget: Object.freeze(ruleTarget) } : {}),
    requiredCapabilities: Object.freeze(requiredCapabilities),
    ...(minContextTokens === undefined ? {} : { minContextTokens }),
    catalogTargets: Object.freeze(catalogTargets),
    declaredContextWindows: Object.freeze(snapshotContextWindows(input.providers, catalogTargets)), initialTargetWasListed
  })
}

export function evaluateNativeRecoveryTarget(input: NativeRecoveryCheck):
  { allowed: true } | { allowed: false; reason: string } {
  const { anchor, provider } = input
  const candidate = { providerId: provider.id, model: canonicalModel(provider, input.model) }
  if (anchor.scope === 'fixed' && !sameTarget(candidate, anchor.target)) return denied('固定模型不允许故障时更换厂商或模型。')
  if (anchor.scope === 'provider' && provider.id !== anchor.target.providerId) return denied('当前任务仅允许在指定厂商内选择模型。')
  if (!anchor.catalogTargets.some((target) => sameTarget(candidate, target))) return denied('目标不在本轮开始时允许的模型目录内。')
  if (!modelStillListed(input, candidate)) return denied('目标已从当前模型目录移除，请修复连接后继续。')
  if (!contextDeclarationPreserved(input, candidate)) return denied('本轮模型上下文声明已删除或提高，请在新回合应用配置；当前请求不能放宽原容量限制。')
  if (!matchesRuleTarget(provider, candidate.model, anchor.ruleTarget)
    || !matchesRuleTarget(provider, candidate.model, input.currentRuleTarget)) return denied('故障备选超出本轮规则指定的厂商或模型。')
  if (!hasRequiredCapabilities(input)) return denied('故障备选不满足文本执行、上下文或业务线必需能力；未知能力不能视为可用。')
  return { allowed: true }
}

export function assertNativeRecoveryTargetAllowed(input: NativeRecoveryCheck): void {
  const result = evaluateNativeRecoveryTarget(input)
  if (result.allowed === false) throw new ModelRouteError('ROUTING_MANUAL_TARGET_UNAVAILABLE', result.reason)
}

export function filterNativeRecoveryModels(input: Omit<NativeRecoveryCheck, 'model'>): string[] {
  return input.provider.models.filter((model) => evaluateNativeRecoveryTarget({ ...input, model }).allowed)
}

function hasRequiredCapabilities(input: NativeRecoveryCheck): boolean {
  const required = new Set([...input.anchor.requiredCapabilities, ...(input.currentRequiredCapabilities ?? [])])
  return providerModelHasCapabilities(input.provider, input.model, [...required], input.anchor.minContextTokens)
}

function providerModelHasCapabilities(provider: ProviderView, model: string, required: readonly NativeRecoveryCapability[], minContextTokens = 0): boolean {
  const [profile] = buildModelProfiles({ providerId: provider.id, providerName: provider.name,
    engine: provider.engine, models: [profileModelName(provider, model)], modelProfiles: provider.advancedConfig?.modelProfiles })
  return profile.supportsText !== false
    && profile.contextWindowTokens >= minContextTokens
    && required.every((capability) => capability === 'tools' ? profile.supportsTools : profile.supportsVision)
}

function snapshotCatalogTargets(providers: ProviderView[], rule: NativeRecoveryRuleTarget | undefined,
  capabilities: readonly NativeRecoveryCapability[], minContextTokens?: number): Readonly<NativeRecoveryTarget>[] {
  return providers.flatMap((provider) => provider.models
    .filter((model) => matchesRuleTarget(provider, canonicalModel(provider, model), rule)
      && providerModelHasCapabilities(provider, model, capabilities, minContextTokens))
    .map((model) => Object.freeze({ providerId: provider.id, model: canonicalModel(provider, model) })))
}

function modelStillListed(input: NativeRecoveryCheck, candidate: NativeRecoveryTarget): boolean {
  if (!input.anchor.initialTargetWasListed && sameTarget(candidate, input.anchor.target)) return true
  return input.provider.models.some((model) => canonicalModel(input.provider, model) === candidate.model)
}

function snapshotContextWindows(providers: ProviderView[], targets: readonly NativeRecoveryTarget[]):
  Readonly<NativeRecoveryTarget & { contextWindow: number }>[] {
  return targets.flatMap((target) => {
    const provider = providers.find((item) => item.id === target.providerId)
    const contextWindow = provider && declaredContextWindow(provider, target.model)
    return contextWindow === undefined ? [] : [Object.freeze({ ...target, contextWindow })]
  })
}

/** The task minimum is not the provider's maximum. Removing a known maximum
 * must not make the actual wire-size gate silently fall back to "unknown". */
function contextDeclarationPreserved(input: NativeRecoveryCheck, target: NativeRecoveryTarget): boolean {
  const frozen = input.anchor.declaredContextWindows.find((entry) => sameTarget(entry, target))
  if (!frozen) return true
  const current = declaredContextWindow(input.provider, target.model)
  return current !== undefined && current <= frozen.contextWindow
}

function declaredContextWindow(provider: ProviderView, model: string): number | undefined {
  const value = findConfiguredModelProfile(profileModelName(provider, model), provider.advancedConfig?.modelProfiles)?.contextWindow
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}

function profileModelName(provider: ProviderView, model: string): string {
  const canonical = canonicalModel(provider, model)
  return provider.models.find((item) => canonicalModel(provider, item) === canonical)
    ?? provider.advancedConfig?.modelProfiles?.find((item) => canonicalModel(provider, item.model) === canonical)?.model
    ?? model
}

function matchesRuleTarget(provider: ProviderView, model: string, rule?: NativeRecoveryRuleTarget): boolean {
  return (!rule?.providerId?.trim() || provider.id === rule.providerId.trim())
    && (!rule?.model?.trim() || model === canonicalModel(provider, rule.model))
}

function normalizedRuleTarget(input?: NativeRecoveryRuleTarget): NativeRecoveryRuleTarget | undefined {
  const providerId = input?.providerId?.trim()
  const model = input?.model?.trim()
  return providerId || model ? { ...(providerId ? { providerId } : {}), ...(model ? { model } : {}) } : undefined
}

function canonicalModel(provider: ProviderView, model: string): string {
  const canonical = findConfiguredModelProfile(model.trim(), provider.advancedConfig?.modelProfiles)?.model ?? model.trim()
  return provider.engine === 'gemini' ? canonical.replace(/^models\//, '') : canonical
}

function sameTarget(left: NativeRecoveryTarget, right: NativeRecoveryTarget): boolean {
  return left.providerId === right.providerId && left.model === right.model
}

function denied(reason: string): { allowed: false; reason: string } { return { allowed: false, reason } }

function recoveryScope(meta: Pick<SessionMeta, 'model' | 'routingScope'>): SessionRoutingScope {
  if (meta.routingScope !== undefined && !['fixed', 'provider', 'global'].includes(meta.routingScope)) {
    throw new ModelRouteError('ROUTING_MANUAL_TARGET_UNAVAILABLE', '会话模型范围无效，已阻止故障恢复。')
  }
  if (meta.model !== AUTO_MODEL) return 'fixed'
  if (meta.routingScope === 'fixed') throw new ModelRouteError('ROUTING_MANUAL_TARGET_UNAVAILABLE', '固定模型模式缺少具体模型。')
  return meta.routingScope ?? 'provider'
}

function validatedContextFloor(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new ModelRouteError('ROUTING_CAPABILITY_UNAVAILABLE', '故障恢复上下文下限无效。')
  }
  return value
}
