import { useState } from 'react'
import type { ProviderView } from '../../../../shared/types'
import { useStore } from '../../store'
import ProviderUsageDashboard from './ProviderUsageDashboard'
import ProviderBalancePanel from './ProviderBalancePanel'
import './usage-and-costs.css'

/** Modern settings and the palace treasury mount this same ledger view. */
export default function UsageAndCosts({ providers }: { providers: ProviderView[] }): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [surface, setSurface] = useState<'usage' | 'balance'>('usage')
  const [providerId, setProviderId] = useState('')
  const provider = providers.find(item => item.id === providerId)
  return <div className="usage-and-costs" data-usage-and-costs>
    <nav className="provider-settings-surfaces" aria-label={zh ? '用量与费用视图' : 'Usage and cost views'}>
      <button type="button" data-cost-surface="usage" className={surface === 'usage' ? 'active' : ''} aria-current={surface === 'usage' ? 'page' : undefined} onClick={() => setSurface('usage')}>{zh ? '用量与费用' : 'Usage and costs'}</button>
      <button type="button" data-cost-surface="balance" className={surface === 'balance' ? 'active' : ''} aria-current={surface === 'balance' ? 'page' : undefined} onClick={() => setSurface('balance')}>{zh ? '账户余额与额度' : 'Balance and quota'}</button>
    </nav>
    {surface === 'usage' ? <ProviderUsageDashboard providers={providers} /> : <section className="settings-section" data-cost-balances>
      <h3 className="settings-h3">{zh ? '账户余额与额度' : 'Balance and quota'}</h3>
      <p className="settings-hint">{zh ? '选择厂商连接后查询该账户。余额、套餐额度与本地调用费用分别展示，单位沿用厂商返回值。' : 'Select a connection to query its account. Balances, plan quotas and local request costs remain separate, using the units returned by the provider.'}</p>
      <label className="field-label">{zh ? '厂商连接' : 'Provider connection'}
        <select className="select select-block" data-cost-balance-provider value={providerId} onChange={event => setProviderId(event.target.value)}>
          <option value="">{zh ? '选择要查询的账户…' : 'Select an account…'}</option>
          {providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      {!providers.length && <p className="settings-hint">{zh ? '先在“厂商”设置中添加连接。' : 'Add a connection in provider settings first.'}</p>}
      {provider && <ProviderBalancePanel key={provider.id} provider={provider} />}
    </section>}
  </div>
}
