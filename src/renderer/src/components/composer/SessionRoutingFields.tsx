import type { ProviderView, SessionMeta } from '../../../../shared/types'
import type { SessionRoutingControl } from '../../../../shared/session-routing-control-types'
import type { RoutingTargetRef } from '../../../../shared/routing-policy-types'
import { ROUTING_RULE_LIMITS } from '../../../../shared/routing-policy-parser'
import { changeRoutingFormKind } from './session-routing-form'

export default function SessionRoutingFields({ value, providers, engine, disabled, zh, onChange }: {
  value: SessionRoutingControl; providers: ProviderView[]; engine?: SessionMeta['engine']; disabled: boolean; zh: boolean
  onChange(value: SessionRoutingControl): void
}): React.JSX.Element {
  const providerScopeId = value.kind === 'auto' && value.scope?.kind === 'provider' ? value.scope.providerId : undefined
  return <fieldset className="session-routing-fields" disabled={disabled}>
    <legend>{zh ? '后续对话的模型选择' : 'Models for subsequent turns'}</legend>
    <label>{zh ? '选择方式' : 'Selection mode'}<select className="select" data-session-routing-mode value={value.kind}
      onChange={event => onChange(changeRoutingFormKind(value, event.target.value as SessionRoutingControl['kind']))}>
      <option value="auto">{zh ? '自动' : 'Automatic'}</option><option value="preferred">{zh ? '优先指定' : 'Preferred'}</option><option value="locked">{zh ? '锁定' : 'Locked'}</option>
    </select></label>
    {value.kind === 'auto' && <><label>{zh ? '选择范围' : 'Selection scope'}<select className="select" data-session-routing-scope
      value={providerScopeId ?? ''}
      onChange={event => onChange({ kind: 'auto', scope: event.target.value ? { kind: 'provider', providerId: event.target.value } : { kind: 'global' } })}>
      <option value="">{zh ? '所有已配置连接' : 'All configured connections'}</option>
      {providerScopeId && !providers.some(provider => provider.id === providerScopeId) &&
        <option value={providerScopeId} disabled>{zh ? '原连接已不可用' : 'Original connection unavailable'}</option>}
      {providers.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.ready || Boolean(engine && provider.engine !== engine)}>{provider.name}{!provider.ready ? (zh ? '（未就绪）' : ' (not ready)') : engine && provider.engine !== engine ? (zh ? '（执行器不兼容）' : ' (incompatible executor)') : ''}</option>)}
    </select></label><p>{zh ? '按任务要求、权限、预算和已保存的路由规则选择。' : 'Choose using task needs, permissions, budget and saved routing rules.'}</p></>}
    {value.kind === 'locked' && <><TargetField label={zh ? '锁定模型' : 'Locked model'} value={value.target} providers={providers} engine={engine} zh={zh}
      onChange={target => onChange({ ...value, target })} /><p>{zh ? '此模型不可用时暂停，等待你处理。' : 'Pause for your decision if this model is unavailable.'}</p></>}
    {value.kind === 'preferred' && <>
      <TargetField label={zh ? '首选模型' : 'Preferred model'} value={value.primary} providers={providers} zh={zh}
        onChange={primary => onChange({ ...value, primary })} />
      {value.alternatives.map((target, index) => <div className="session-routing-alternative" key={index}>
        <TargetField label={`${zh ? '备选' : 'Alternative'} ${index + 1}`} value={target} providers={providers} engine={providers.find(provider => provider.id === value.primary.providerId)?.engine} zh={zh}
          onChange={next => onChange({ ...value, alternatives: value.alternatives.map((entry, at) => at === index ? next : entry) })} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ ...value, alternatives: value.alternatives.filter((_, at) => at !== index) })}>{zh ? '移除' : 'Remove'}</button>
      </div>)}
      <button type="button" className="btn btn-ghost btn-sm" data-session-routing-add-alternative disabled={value.alternatives.length >= ROUTING_RULE_LIMITS.targets - 1}
        onClick={() => onChange({ ...value, alternatives: [...value.alternatives, { providerId: '', model: '' }] })}>{zh ? '添加明确备选' : 'Add an alternative'}</button>
      <label>{zh ? '首选请求失败时' : 'If the preferred request fails'}<select className="select" data-session-routing-failure value={value.failure.kind}
        onChange={event => onChange({ ...value, failure: event.target.value === 'pause' ? { kind: 'pause' } : {
          kind: event.target.value as 'retry_same_target' | 'retry_allowed_targets', maxAdditionalAttempts: 1, retryOn: ['rate_limited', 'auth_failed'] } })}>
        <option value="pause">{zh ? '暂停，等我处理' : 'Pause for my decision'}</option>
        <option value="retry_same_target">{zh ? '同一模型重试' : 'Retry the same model'}</option>
        <option value="retry_allowed_targets">{zh ? '允许使用列出的备选' : 'Allow listed alternatives'}</option>
      </select></label>
      {value.failure.kind !== 'pause' && <>
        <label>{zh ? '最多追加尝试' : 'Maximum additional attempts'}<select className="select" value={value.failure.maxAdditionalAttempts}
          onChange={event => onChange({ ...value, failure: { ...value.failure as Exclude<typeof value.failure, { kind: 'pause' }>, maxAdditionalAttempts: Number(event.target.value) } })}>
          {Array.from({ length: ROUTING_RULE_LIMITS.retries }, (_, at) => at + 1).map(count => <option key={count} value={count}>{count}</option>)}
        </select></label>
        <div>{(['rate_limited', 'auth_failed'] as const).map(reason => <label key={reason}><input type="checkbox"
          checked={value.failure.kind !== 'pause' && value.failure.retryOn.includes(reason)}
          onChange={event => {
            if (value.failure.kind === 'pause') return
            const retryOn = event.target.checked ? [...value.failure.retryOn, reason] : value.failure.retryOn.filter(entry => entry !== reason)
            onChange({ ...value, failure: { ...value.failure, retryOn } })
          }} />{reason === 'rate_limited' ? (zh ? '确认限流' : 'Confirmed rate limit') : (zh ? '确认鉴权失败' : 'Confirmed authentication failure')}</label>)}</div>
        <p>{zh ? '仅在勾选的失败情形追加尝试；费用或外部操作结果未知时，先核对结果。' : 'Retry only selected failure categories. Reconcile unknown costs or operation results first.'}</p>
        <p>{zh ? '重试还需连接或全局设置允许故障恢复，并遵守连接的重试次数限制。' : 'Retries also require recovery to be enabled for the connection or globally, and remain subject to the connection’s retry limit.'}</p>
      </>}
      <p>{zh ? '首选未满足权限、能力或预算要求时暂停。备选需使用兼容的调用协议，保存时会检查。' : 'Pause if the preferred model fails permission, capability or budget checks. Alternatives must use a compatible protocol, checked when saving.'}</p>
      <p>{zh ? '切换执行器会带上已完成的对话、工具结果和权限记录；有未决操作、附件或过大的历史时，先整理交接再继续。' : 'Executor changes carry completed conversation, tool results and permission records. Resolve pending operations, attachments or oversized history before continuing.'}</p>
    </>}
    {value.kind === 'locked' && <p>{zh ? '锁定可选择与当前执行器兼容的连接。' : 'Locked mode supports connections compatible with the current executor.'}</p>}
  </fieldset>
}

function TargetField({ value, providers, engine, label, zh, onChange }: {
  value: RoutingTargetRef; providers: ProviderView[]; engine?: SessionMeta['engine']; label: string; zh: boolean
  onChange(value: RoutingTargetRef): void
}): React.JSX.Element {
  const provider = providers.find(entry => entry.id === value.providerId)
  const models = [...new Set(provider?.models.map(model => model.trim()).filter(model => model && model !== 'auto') ?? [])]
  return <fieldset className="session-routing-target"><legend>{label}</legend>
    <label>{zh ? '连接' : 'Connection'}<select className="select" data-session-routing-provider value={value.providerId}
      onChange={event => onChange({ providerId: event.target.value, model: '' })}>
      <option value="">{zh ? '选择连接…' : 'Choose a connection…'}</option>
      {value.providerId && !provider && <option value={value.providerId} disabled>{zh ? '原连接已不可用' : 'Original connection unavailable'}</option>}
      {providers.map(entry => <option key={entry.id} value={entry.id} disabled={!entry.ready || Boolean(engine && entry.engine !== engine)}>
        {entry.name}{!entry.ready ? (zh ? '（未就绪）' : ' (not ready)') : engine && entry.engine !== engine ? (zh ? '（执行器不兼容）' : ' (incompatible executor)') : ''}
      </option>)}
    </select></label>
    <label>{zh ? '模型' : 'Model'}<select className="select" data-session-routing-model value={value.model} disabled={!provider?.ready || Boolean(engine && provider.engine !== engine)}
      onChange={event => onChange({ ...value, model: event.target.value })}>
      <option value="">{zh ? '选择模型…' : 'Choose a model…'}</option>
      {value.model && !models.includes(value.model) && <option value={value.model} disabled>{value.model}{zh ? '（不在当前目录）' : ' (not in catalog)'}</option>}
      {models.map(model => <option key={model} value={model}>{model}</option>)}
    </select></label>
  </fieldset>
}
