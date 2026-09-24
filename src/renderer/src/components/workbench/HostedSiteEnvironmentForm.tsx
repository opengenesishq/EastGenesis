import { useState } from 'react'
import type { HostedSiteDescriptor, HostedSiteEnvironmentInput } from '../../../../shared/hosted-site-types'

export default function HostedSiteEnvironmentForm({ site, disabled, zh, onPrepare, onRemove }: {
  site: HostedSiteDescriptor; disabled: boolean; zh: boolean
  onPrepare(input: HostedSiteEnvironmentInput): void; onRemove(name: string): void
}): React.JSX.Element {
  const [name, setName] = useState(''), [value, setValue] = useState(''), [secret, setSecret] = useState(true)
  const tr = (cn: string, en: string): string => zh ? cn : en
  const variables = site.environment ?? []
  return <details data-hosted-environment><summary>{tr('运行时环境变量', 'Runtime environment variables')}</summary>
    {!site.capabilities.environmentRead ? <p>{tr('当前站点连接未提供环境变量管理。', 'This site connection does not provide environment management.')}</p> : <>
      {variables.length ? <ul>{variables.map(item => <li key={item.name}><code>{item.name}</code> · {item.secret ? tr('秘密值', 'Secret') : tr('普通变量', 'Variable')}
        <small>{tr('更新于 ', 'Updated ')}{new Date(item.updatedAt).toLocaleString()}</small>
        <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || !site.capabilities.environmentSet} onClick={() => { setName(item.name); setSecret(item.secret); setValue('') }}>{tr('替换值', 'Replace value')}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || !site.capabilities.environmentRemove} onClick={() => onRemove(item.name)}>{tr('预览删除', 'Preview removal')}</button></li>)}</ul> : <p>{tr('没有已配置变量。', 'No variables configured.')}</p>}
      <div className="hosted-environment-form">
        <label>{tr('变量名', 'Name')}<input aria-label={tr('运行时变量名', 'Runtime variable name')} autoComplete="off" spellCheck={false} value={name} maxLength={128} disabled={disabled} onChange={event => setName(event.target.value)} placeholder="SERVICE_API_KEY" /></label>
        <label>{tr('新值', 'New value')}<input type={secret ? 'password' : 'text'} aria-label={tr('运行时变量新值', 'Runtime variable new value')} autoComplete="new-password" spellCheck={false} value={value} maxLength={8192} disabled={disabled} onChange={event => setValue(event.target.value)} /></label>
        <label><input type="checkbox" checked={secret} disabled={disabled} onChange={event => setSecret(event.target.checked)} />{tr('作为秘密值保存到站点', 'Store as a site secret')}</label>
        <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || !site.capabilities.environmentSet || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)} onClick={() => { const input = { name, value, secret }; setValue(''); onPrepare(input) }}>{tr('预览保存', 'Preview save')}</button>
      </div>
      <small>{tr('可保存空值。现有值不回显；新值仅在确认后发给当前站点。关闭或过期的预览需要重新输入。', 'Empty values are allowed. Existing values are hidden; the new value is sent only after confirmation. Closed or expired previews require re-entry.')}</small>
      <p>{site.environmentRequiresRedeploy === false ? tr('此站点报告变量更新后立即生效。', 'This site reports that updates take effect immediately.') : tr('保存后请重新部署，使运行时环境使用新值。', 'Redeploy after saving so the runtime uses the new values.')}</p>
    </>}
  </details>
}
