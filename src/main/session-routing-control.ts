import type { SessionMeta, SendMessagePayload } from '../shared/types'
import type { SessionRoutingControl } from '../shared/session-routing-control-types'
import { sessionRoutingControl } from '../shared/session-routing-control-types'
export { normalizeSessionRoutingControl } from '../shared/session-routing-control'
import type { RoutingSelection, RoutingTargetRef } from '../shared/routing-policy-types'
import { captureSessionRouting } from './routing-service/session-routing-capture'
import { evaluateRoutingRuleSet } from './model/routing-policy/routing-policy-evaluator'
import { listProviders, resolveProviderEngine } from './providers'
import { resolveNativeExecutorProtocol } from './model/executor-compatibility'
import { canonicalTarget } from './model/routing-policy/evaluator-catalog'

export function routingControlProjection(meta: SessionMeta, control: SessionRoutingControl): SessionMeta {
  if (control.kind === 'locked') return { ...meta, ...control.target, routingScope: 'fixed', routingControl: control }
  // The control names a future target. Keep the current physical Provider
  // paired with its Engine until the frozen Run/continuation adopts it.
  if (control.kind === 'preferred') return { ...meta, model: 'auto', routingScope: 'global', routingControl: control }
  return { ...meta, model: 'auto', providerId: control.scope?.kind === 'provider' ? control.scope.providerId : meta.providerId,
    routingScope: control.scope?.kind === 'provider' ? 'provider' : 'global', routingControl: control }
}

export function evaluateSessionRoutingControl(meta: SessionMeta, payload: SendMessagePayload) {
  const control = sessionRoutingControl(meta)
  const capture = captureSessionRouting({ meta, prompt: payload.text, payload })
  // The receipt keeps the user's original spelling, while a frozen Run must
  // compare intent, selection and physical targets in the same catalog form.
  const canonical = (target: RoutingTargetRef): RoutingTargetRef => {
    const provider = capture.snapshots.providers.find(candidate => candidate.id === target.providerId)
    return provider ? canonicalTarget(provider, target.model) : target
  }
  if (capture.context.userIntent.kind === 'fixed') {
    capture.context = { ...capture.context, userIntent: { kind: 'fixed', target: canonical(capture.context.userIntent.target) } }
  }
  const selection: RoutingSelection = control.kind === 'locked' ? { kind: 'fixed', target: canonical(control.target) }
    : control.kind === 'preferred' ? { kind: 'preferred', primary: canonical(control.primary), alternatives: control.alternatives.map(canonical) }
    : control.scope?.kind === 'provider' ? { kind: 'provider_auto', providerId: control.scope.providerId } : { kind: 'global_auto' }
  const rules = { schemaVersion: 1, rules: [{ id: 'session-routing-control', expectedVersion: 1,
    name: '任务路由控制', enabled: true, priority: 0, scope: { kind: 'global' }, when: {}, selection,
    strategy: capture.context.baseStrategy, failure: control.kind === 'preferred' ? control.failure : { kind: 'pause' } }] }
  const result = evaluateRoutingRuleSet({ rules: { kind: 'draft', value: rules, sourcesById: { 'session-routing-control': { kind: 'user' } } },
    context: capture.context, snapshots: capture.snapshots })
  if (result.status !== 'ready') throw new Error(`当前任务路由不可执行：${result.diagnostics.map(item => item.message).join('；') || '目标不符合能力、权限、环境或预算约束。'}`)
  return { capture, result, rules }
}

/** No Provider calls. Cross-protocol retries cannot be executed inside one native Run. */
export function validateSessionRoutingControl(meta: SessionMeta, current: SessionMeta): void {
  const control = sessionRoutingControl(meta)
  if (control.kind === 'preferred' && !meta.workItemId) throw new Error('优先指定需要已绑定工作项的任务；请从任务工作区选择路由。')
  const providers = listProviders()
  const target = control.kind === 'locked' ? control.target : control.kind === 'preferred' ? control.primary : undefined
  if (target) {
    const provider = providers.find(item => item.id === target.providerId)
    if (!provider) throw new Error('已选择的 Provider 不存在。')
    if (control.kind === 'locked' && resolveProviderEngine(provider) !== current.engine) {
      throw new Error('锁定暂不支持跨执行器协议切换；请选择当前协议的连接，或通过自动／优先指定完成文本交接。')
    }
    if (control.kind === 'preferred') {
      const protocol = resolveNativeExecutorProtocol(provider, target.model)
      for (const alternative of control.alternatives) {
        const alternativeProvider = providers.find(item => item.id === alternative.providerId)
        if (!alternativeProvider || resolveNativeExecutorProtocol(alternativeProvider, alternative.model) !== protocol) {
          throw new Error('首选和备选必须使用相同的执行器协议；跨协议恢复需要新的文本交接。')
        }
      }
    }
  } else if (control.kind === 'auto' && control.scope?.kind === 'provider') {
    const providerId = control.scope.providerId
    const provider = providers.find(item => item.id === providerId)
    if (!provider || resolveProviderEngine(provider) !== current.engine) throw new Error('指定连接自动选择暂不支持跨执行器协议切换，请使用全局自动或优先指定。')
  }
  const { result } = evaluateSessionRoutingControl(meta, { text: meta.title?.trim() || '继续当前任务' })
  if (control.kind === 'preferred' && control.alternatives.some(target => {
    const provider = providers.find(candidate => candidate.id === target.providerId)
    if (!provider) return true
    const canonical = canonicalTarget(provider, target.model)
    return !result.qualifiedTargets.some(candidate => candidate.providerId === canonical.providerId && candidate.model === canonical.model)
  })) {
    throw new Error('部分备选模型不符合能力、权限、连接或预算约束，请移除不可用备选后保存。')
  }
}
