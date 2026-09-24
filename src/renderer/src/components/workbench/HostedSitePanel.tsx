import { useEffect, useRef, useState } from 'react'
import type { HostedSiteChange, HostedSitePreview, HostedSiteState } from '../../../../shared/hosted-site-types'
import type { SiteDeploymentTarget } from '../../../../shared/site-deployment-types'
import { useStore } from '../../store'
import HostedSiteEnvironmentForm from './HostedSiteEnvironmentForm'
import './hosted-site-panel.css'

export default function HostedSitePanel({ sessionId, target, zh }: { sessionId: string; target: SiteDeploymentTarget; zh: boolean }): React.JSX.Element {
  const [state, setState] = useState<HostedSiteState>({ configured: Boolean(target.management), connected: false, receipts: [] })
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [readError, setReadError] = useState('')
  const [hostname, setHostname] = useState(''), [preview, setPreview] = useState<HostedSitePreview>()
  useEffect(() => { const id = preview?.id; return () => { if (id) void window.agentDesk.discardHostedSitePreview(sessionId, id).catch(() => undefined) } }, [sessionId, preview?.id])
  const [from, setFrom] = useState(new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)), [to, setTo] = useState(new Date(Date.now() + 86400000).toISOString().slice(0, 10))
  const alive = useRef(true), performing = useRef(false), version = useRef(0)
  const tr = (cn: string, en: string): string => zh ? cn : en
  const refresh = async (): Promise<void> => {
    const request = ++version.current
    try { const next = await window.agentDesk.getHostedSite(sessionId, target.id); if (alive.current && version.current === request) { setState(next); setReadError('') } }
    catch (cause) { if (alive.current && version.current === request) setReadError(String(cause)) }
  }
  useEffect(() => {
    alive.current = true; void refresh(); const timer = setInterval(() => { void refresh() }, 3000)
    return () => { alive.current = false; version.current++; clearInterval(timer) }
  }, [sessionId, target.id, target.revision])
  const operate = async (fn: () => Promise<void>): Promise<void> => {
    if (performing.current) return
    performing.current = true; setBusy(true); setError('')
    try { await fn(); if (alive.current) await refresh() }
    catch (cause) { if (alive.current) setError(String(cause)) }
    finally { performing.current = false; if (alive.current) setBusy(false) }
  }
  const receivePreview = async (next: HostedSitePreview): Promise<void> => {
    if (alive.current) setPreview(next)
    else await window.agentDesk.discardHostedSitePreview(sessionId, next.id)
  }
  const prepare = (change: HostedSiteChange): void => { void operate(async () => { setPreview(undefined); await receivePreview(await window.agentDesk.prepareHostedSiteChange(sessionId, target.id, change)) }) }
  const site = state.descriptor, c = site?.capabilities
  const unresolved = state.receipts.some(row => ['executing', 'needs_reconciliation'].includes(row.status))
  const mutable = state.connected && !site?.deleted && !unresolved && c?.idempotentOperations && c.conditionalMutations && c.inspectOperation
  const open = async (): Promise<void> => { if (site?.url && useStore.getState().activeId === sessionId) await useStore.getState().openBrowserPanel(site.url) }
  return <section className="hosted-site-panel" data-hosted-site={target.id}>
    <header><h4>{tr('托管站点管理', 'Hosted site management')}</h4><button type="button" className="btn btn-ghost btn-sm" data-hosted-refresh disabled={busy || !target.management} onClick={() => void operate(async () => { const next = await window.agentDesk.refreshHostedSite(sessionId, target.id, target.revision); if (alive.current) { setState(next); setPreview(undefined) } })}>{state.connected ? tr('读取最新状态', 'Read latest state') : tr('读取并连接', 'Read and connect')}</button></header>
    {!target.management && <p>{tr('在目标配置中启用管理协议，并填写该服务的稳定站点 ID。旧部署编号不会自动作为站点编号。', 'Enable the management protocol in target settings and enter the stable site ID. Deployment IDs are not used as site IDs.')}</p>}
    {state.unavailableReason && <p className="notice">{state.unavailableReason}</p>}
    {site && <>
      <div className="hosted-site-overview"><strong>{site.name}{site.deleted ? tr(' · 已删除', ' · Deleted') : ''}</strong><span>{site.accountName} · {site.accountScope}</span><code>{tr('站点 ', 'Site ')}{site.siteId} · {tr('版本 ', 'Revision ')}{site.revision}</code><span>{tr('当前部署：', 'Current deployment: ')}{site.deploymentId ?? tr('未知', 'Unknown')}</span><small>{tr('适配器观察于 ', 'Observed by adapter at ')}{new Date(site.observedAt).toLocaleString()}</small></div>
      <div className="hosted-site-actions"><button type="button" className="btn btn-ghost btn-sm" disabled={!site.url || site.deleted} onClick={() => void open().catch(cause => setError(String(cause)))}>{tr('打开站点', 'Open site')}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!site.url || site.deleted || site.access.mode !== 'public'} onClick={() => void navigator.clipboard.writeText(site.url!).catch(cause => setError(String(cause)))}>{tr('复制公开链接', 'Copy public link')}</button><code>{site.url}</code></div>
      <details open><summary>{tr('域名', 'Domains')}</summary>
        {!c?.domainRead ? <p>{tr('适配器不支持域名状态读取。', 'This adapter does not provide domain status.')}</p> : site.domains.length ? <ul>{site.domains.map(domain => <li key={domain.hostname}><strong>{domain.hostname}</strong> · {({ pending: ['等待验证', 'Pending'], verified: ['已验证', 'Verified'], failed: ['验证失败', 'Failed'], unknown: ['状态未知', 'Unknown'] })[domain.status][zh ? 0 : 1]}
          {domain.dnsInstructions && <p>{domain.dnsInstructions}</p>}<button type="button" className="btn btn-ghost btn-sm" disabled={busy || !mutable || !c.domainUnbind} onClick={() => prepare({ kind: 'domain.unbind', hostname: domain.hostname })}>{tr('预览解绑', 'Preview unbinding')}</button></li>)}</ul> : <p>{tr('无已报告域名', 'No domains reported')}</p>}
        <div className="hosted-site-actions"><input aria-label={tr('要绑定的域名', 'Domain to bind')} value={hostname} onChange={event => { setHostname(event.target.value); setPreview(undefined) }} placeholder="www.example.com" disabled={busy} /><button type="button" className="btn btn-ghost btn-sm" disabled={busy || !mutable || !c?.domainBind || !hostname.trim()} onClick={() => prepare({ kind: 'domain.bind', hostname })}>{tr('预览绑定', 'Preview binding')}</button></div>
        <small>{tr('DNS 写入不可用；这里的域名绑定不会替你修改注册商记录。', 'DNS writes are unavailable. Domain binding does not modify registrar records.')}</small>
      </details>
      <details open><summary>{tr('公开访问与撤销', 'Public access and revocation')}</summary>
        <p>{c?.accessRead ? ({ public: ['公开访问', 'Public'], disabled: ['公开访问已关闭', 'Public access disabled'], unknown: ['访问状态未知', 'Unknown access'] })[site.access.mode][zh ? 0 : 1] : tr('适配器未提供访问状态读取。', 'Access status is unavailable.')} · {site.access.description}</p>
        <div className="hosted-site-actions"><button type="button" className="btn btn-ghost btn-sm" disabled={busy || !mutable || !c?.accessSetPublic || site.access.mode === 'public'} onClick={() => prepare({ kind: 'access.set', mode: 'public' })}>{tr('预览公开访问', 'Preview public access')}</button><button type="button" className="btn btn-ghost btn-sm" disabled={busy || !mutable || !c?.accessDisable || site.access.mode === 'disabled'} onClick={() => prepare({ kind: 'access.set', mode: 'disabled' })}>{tr('预览关闭访问', 'Preview disabling access')}</button></div>
        <small>{tr('成员邀请与访问密码由站点服务管理。', 'Manage member invitations and access passwords in the hosting service.')}</small>
      </details>
      <HostedSiteEnvironmentForm key={`${sessionId}:${target.id}:${target.revision}`} site={site} zh={zh} disabled={busy || !mutable}
        onRemove={name => prepare({ kind: 'environment.remove', name })}
        onPrepare={input => { void operate(async () => { setPreview(undefined); await receivePreview(await window.agentDesk.prepareHostedSiteEnvironment(sessionId, target.id, input)) }) }} />
      <details><summary>{tr('访问分析', 'Visitor analytics')}</summary>
        <div className="hosted-site-analytics-range"><label>{tr('开始日期 UTC', 'Start date UTC')}<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label>{tr('结束日期 UTC（不含）', 'End date UTC (exclusive)')}<input type="date" value={to} onChange={event => setTo(event.target.value)} /></label><button type="button" className="btn btn-ghost btn-sm" disabled={busy || !state.connected || !c?.analytics || !from || !to} onClick={() => void operate(async () => { await window.agentDesk.queryHostedSiteAnalytics(sessionId, target.id, { from: `${from}T00:00:00.000Z`, to: `${to}T00:00:00.000Z`, timeZone: 'UTC' }) })}>{tr('查询访问统计', 'Query analytics')}</button></div>
        {!c?.analytics && <p>{tr('适配器不支持访问分析。部署日志不是访客统计。', 'This adapter does not provide analytics. Deployment logs are not visitor counts.')}</p>}
        {state.analytics && <div className="hosted-site-analytics" data-hosted-analytics><strong>PV {state.analytics.pageViews ?? tr('未知', 'Unknown')} · UV {state.analytics.uniqueVisitors ?? tr('未知', 'Unknown')}</strong><span>{tr('来源：', 'Source: ')}{state.analytics.source} · {state.analytics.sampled ? tr('抽样', 'Sampled') : tr('未标为抽样', 'Not marked sampled')}</span><p>{state.analytics.methodology}</p><small>{state.analytics.from} → {state.analytics.to} · {state.analytics.timeZone}<br />{tr('生成于 ', 'Generated ')}{state.analytics.generatedAt}</small>
          {state.analytics.daily.length > 0 && <table><thead><tr><th>{tr('日期', 'Date')}</th><th>PV</th><th>UV</th></tr></thead><tbody>{state.analytics.daily.map(day => <tr key={day.date}><td>{day.date}</td><td>{day.pageViews ?? '—'}</td><td>{day.uniqueVisitors ?? '—'}</td></tr>)}</tbody></table>}</div>}
      </details>
      {!mutable && !site.deleted && <p className="notice">{unresolved ? tr('存在执行中或待核对的原操作，请先处理下方回执。', 'An operation is running or needs reconciliation. Resolve its receipt below.') : tr('变更需适配器提供幂等操作、版本条件和核对能力；不满足时仅展示读取结果。', 'Changes require idempotency, conditional revisions and operation inspection; otherwise this connection is read only.')}</p>}
      <details><summary>{tr('删除线上站点', 'Delete hosted site')}</summary><p>{tr('删除将影响此站点的线上服务。本机文件、任务与历史回执保留。', 'Deletion affects this hosted site. Local files, tasks and historical receipts are retained.')}</p><button type="button" className="btn btn-ghost btn-sm" data-hosted-delete disabled={busy || !mutable || !c?.deleteSite} onClick={() => prepare({ kind: 'site.delete' })}>{tr('预览删除影响', 'Preview deletion impact')}</button></details>
    </>}
    {preview && <article className="hosted-site-preview" data-hosted-preview={preview.id}><h5>{tr('待确认的线上变更', 'Hosted change to confirm')} · {preview.before.name}</h5><code>{preview.before.accountScope} / {preview.before.siteId}</code><p>{preview.change.kind === 'environment.set' ? `${tr('保存运行时变量：', 'Save runtime variable: ')}${preview.change.name} · ${preview.change.secret ? tr('秘密值', 'Secret') : tr('普通变量', 'Variable')}` : preview.change.kind === 'environment.remove' ? `${tr('删除运行时变量：', 'Remove runtime variable: ')}${preview.change.name}` : JSON.stringify(preview.change)}</p><ul>{preview.impact.map((impact, index) => <li key={index}>{impact}</li>)}</ul>
      <p>{tr('域名：', 'Domains: ')}{preview.before.domains.map(item => item.hostname).join(', ') || '—'} → {preview.after.domains.map(item => item.hostname).join(', ') || '—'}<br />{tr('访问：', 'Access: ')}{preview.before.access.mode} → {preview.after.access.mode}<br />{tr('删除状态：', 'Deleted: ')}{String(preview.before.deleted)} → {String(preview.after.deleted)}</p>
      <small>{tr('有效至 ', 'Expires ')}{new Date(preview.expiresAt).toLocaleTimeString()}</small><details><summary>{tr('执行范围', 'Execution scope')}</summary><pre>{preview.command.map(value => JSON.stringify(value)).join(' ')}</pre><p>{tr('环境变量名称：', 'Environment names: ')}{preview.environmentKeys.join(', ') || '—'}</p><code>{preview.operationId}</code></details>
      <div className="hosted-site-actions"><button type="button" className="btn btn-primary btn-sm" data-hosted-apply disabled={busy || preview.expiresAt <= Date.now()} onClick={() => void operate(async () => { const result = await window.agentDesk.executeHostedSiteChange(sessionId, preview.id); if (result && alive.current) setPreview(undefined) })}>{tr('确认此变更…', 'Confirm change…')}</button><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPreview(undefined)}>{tr('取消预览', 'Dismiss preview')}</button></div>
    </article>}
    {state.receipts.map(receipt => <article className="hosted-site-receipt" key={receipt.id} data-hosted-receipt={receipt.id}><strong>{receipt.change.kind} · {({ executing: ['执行中', 'Running'], confirmed: ['适配器已确认', 'Confirmed by adapter'], not_applied: ['已核对未执行', 'Confirmed not applied'], needs_reconciliation: ['待核对', 'Needs reconciliation'] })[receipt.status][zh ? 0 : 1]}</strong><code>{receipt.siteId} · {receipt.operationId}</code>
      {receipt.error && <p>{receipt.error}</p>}<div className="hosted-site-actions">{receipt.status === 'executing' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void window.agentDesk.cancelHostedSiteOperation(sessionId, receipt.operationId).then(refresh).catch(cause => setError(String(cause)))}>{tr('停止适配器进程', 'Stop adapter process')}</button>}
      {receipt.status === 'needs_reconciliation' && <><button type="button" className="btn btn-ghost btn-sm" data-hosted-inspect disabled={busy} onClick={() => void operate(async () => { await window.agentDesk.inspectHostedSiteChange(sessionId, receipt.id) })}>{tr('核对原操作', 'Inspect original operation')}</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => useStore.getState().setShowTaskRecovery(true)}>{tr('任务恢复中心', 'Task Recovery')}</button></>}</div><details><summary>{tr('适配器回执', 'Adapter receipt')}</summary><pre>{receipt.output || '—'}</pre></details></article>)}
    {error && <p className="notice notice-error" role="alert">{error}</p>}{readError && <p className="notice notice-error" role="alert">{readError}</p>}
  </section>
}
