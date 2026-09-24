import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import type { SiteDeploymentPreview, SiteDeploymentReceipt, SiteDeploymentState, SiteDeploymentTarget } from '../../../../shared/site-deployment-types'
import './site-deployment.css'
import LocalSitePreviewControls from './LocalSitePreviewControls'
import HostedSitePanel from './HostedSitePanel'

const empty = (): SiteDeploymentTarget => ({ id: '', revision: 0, name: '', outputDirectory: 'dist', executable: '', deployArgs: ['deploy', '{{directory}}', '{{operationId}}'], rollbackArgs: [], inspectArgs: [], environmentKeys: [], timeoutSeconds: 600 })
export default function SiteDeploymentPanel(): React.JSX.Element {
  const id = useStore(s => s.activeId)
  return id ? <BoundSiteDeploymentPanel key={id} sessionId={id} /> : <p>选择一个任务后预览或部署网站。</p>
}
function BoundSiteDeploymentPanel({ sessionId }: { sessionId: string }): React.JSX.Element {
  const zh = useStore(s => s.settings.language === 'zh'), session = useStore(s => s.sessions[sessionId])
  const [state, setState] = useState<SiteDeploymentState>({ targets: [], receipts: [] })
  const [target, setTarget] = useState<SiteDeploymentTarget>(empty)
  const [preview, setPreview] = useState<SiteDeploymentPreview>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const alive = useRef(true)
  const refresh = async (): Promise<void> => { const value = await window.agentDesk.getSiteDeployments(sessionId); if (alive.current) setState(value) }
  useEffect(() => {
    alive.current = true
    void refresh().catch(cause => setError(String(cause)))
    const timer = window.setInterval(() => { void refresh().catch(cause => { if (alive.current) setError(String(cause)) }) }, 2000)
    return () => { alive.current = false; window.clearInterval(timer) }
  }, [sessionId])
  const operate = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try { await fn(); await refresh() } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  const update = (patch: Partial<SiteDeploymentTarget>): void => { setTarget(value => ({ ...value, ...patch })); setPreview(undefined) }
  const commandField = (label: string, key: 'deployArgs' | 'rollbackArgs' | 'inspectArgs' | 'environmentKeys'): React.JSX.Element => <label>{label}
    <textarea rows={3} value={target[key].join('\n')} onChange={event => update({ [key]: event.target.value.split('\n').filter(Boolean) })} spellCheck={false} />
  </label>
  const prepare = (id: string, rollbackOf?: string): Promise<void> => operate(async () => { const result = await window.agentDesk.prepareSiteDeployment(sessionId, id, rollbackOf); if (alive.current) setPreview(result) })
  const open = (url: string): void => { void useStore.getState().openBrowserPanel(url).catch(cause => setError(String(cause))) }
  return <section className="site-deployment-panel" data-site-deployments={sessionId}>
    <header><h3>{zh ? '网站' : 'Websites'}</h3><span>{session?.meta.title}</span><button type="button" className="btn btn-ghost btn-sm" onClick={() => void operate(refresh)} disabled={busy}>{zh ? '刷新' : 'Refresh'}</button></header>
    <p>{zh ? '在本地使用当前任务的网站，也可以发布到自己的部署服务。' : 'Use this task’s website locally, or publish with your own hosting service.'}</p>
    <LocalSitePreviewControls sessionId={sessionId} zh={zh} />
    {error && <p role="alert" className="notice notice-error">{error}</p>}
    <label>{zh ? '部署目标' : 'Deployment target'}<select value={target.id} onChange={event => { setTarget(state.targets.find(item => item.id === event.target.value) ?? empty()); setPreview(undefined) }}>
      <option value="">{zh ? '新增目标' : 'New target'}</option>{state.targets.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
    </select></label>
    <details open={!target.id}><summary>{zh ? '目标配置' : 'Target configuration'}</summary>
      <label>{zh ? '名称' : 'Name'}<input value={target.name} onChange={event => update({ name: event.target.value })} /></label>
      <label>{zh ? '构建输出目录（相对任务目录）' : 'Build output directory (relative to task)'}<input value={target.outputDirectory} onChange={event => update({ outputDirectory: event.target.value })} placeholder="dist" /></label>
      <label>{zh ? '部署程序 / 脚本绝对路径' : 'Deployment executable / script absolute path'}<input value={target.executable} onChange={event => update({ executable: event.target.value })} placeholder="/path/to/site-adapter" /></label>
      {commandField(zh ? '发布参数（每行一个）' : 'Deploy arguments (one per line)', 'deployArgs')}
      {commandField(zh ? '回滚参数（可选）' : 'Rollback arguments (optional)', 'rollbackArgs')}
      {commandField(zh ? '核对参数（可选）' : 'Inspect arguments (optional)', 'inspectArgs')}
      {commandField(zh ? '允许传入的环境变量名称（每行一个，勿填值）' : 'Allowed environment variable names (one per line; no values)', 'environmentKeys')}
      <label><span><input type="checkbox" checked={Boolean(target.management)} onChange={event => update({ management: event.target.checked ? { protocol: 'caogen-site-management/1', args: ['manage'], siteId: '' } : undefined })} />{zh ? '连接托管站点管理协议' : 'Connect hosted site management protocol'}</span></label>
      {target.management && <><label>{zh ? '稳定站点 ID（与部署编号不同）' : 'Stable site ID (different from deployment ID)'}<input value={target.management.siteId} onChange={event => update({ management: { ...target.management!, siteId: event.target.value } })} /></label>
        <label>{zh ? '管理参数（每行一个；程序从 stdin 读取协议 JSON）' : 'Management arguments (one per line; program reads protocol JSON from stdin)'}<textarea rows={2} value={target.management.args.join('\n')} onChange={event => update({ management: { ...target.management!, args: event.target.value.split('\n').filter(Boolean) } })} /></label><p>{zh ? '协议 caogen-site-management/1。连接后按适配器实际能力显示域名、访问、分析及删除入口；未实现的能力不可用。' : 'Protocol caogen-site-management/1. Domain, access, analytics and deletion controls depend on the adapter capabilities.'}</p></>}
      <div className="site-deployment-fields"><label>{zh ? '超时（秒）' : 'Timeout (seconds)'}<input type="number" min="5" max="1800" value={target.timeoutSeconds} onChange={event => update({ timeoutSeconds: Number(event.target.value) })} /></label>
        <label>{zh ? '费用估算 USD（可留空）' : 'Estimated USD cost (optional)'}<input type="number" min="0" step="0.01" value={target.estimatedCostUsd ?? ''} onChange={event => update({ estimatedCostUsd: event.target.value === '' ? undefined : Number(event.target.value) })} /></label></div>
      <div className="site-deployment-actions"><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void operate(async () => { const saved = await window.agentDesk.saveSiteDeploymentTarget(sessionId, target); if (alive.current) setTarget(saved) })}>{zh ? '保存目标' : 'Save target'}</button>
        {target.id && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void operate(async () => { await window.agentDesk.removeSiteDeploymentTarget(sessionId, target.id, target.revision); if (alive.current) { setTarget(empty()); setPreview(undefined) } })}>{zh ? '移除目标' : 'Remove target'}</button>}</div>
    </details>
    {target.id && state.targets.some(item => item.id === target.id) && <HostedSitePanel key={`${sessionId}:${target.id}:${state.targets.find(item => item.id === target.id)!.revision}`} sessionId={sessionId} target={state.targets.find(item => item.id === target.id)!} zh={zh} />}
    <details><summary>{zh ? '部署脚本接口' : 'Deployment adapter contract'}</summary>
      <p>{zh ? '程序直接执行，不自动安装 CLI；请先在本机完成服务登录。{{directory}} 是冻结的发布目录，{{operationId}} 是本次操作 ID。回滚必须使用 {{deploymentId}}；核对须使用原操作或部署 ID。' : 'The executable runs directly; install and sign into your CLI first. {{directory}} is the frozen output; {{operationId}} identifies this operation. Rollback requires {{deploymentId}}. Inspect uses the original operation or deployment ID.'}</p>
      <p>{zh ? '成功时退出码必须为 0，并输出一行服务返回的真实部署标识、链接和本次 operationId；核对时返回原 operationId：' : 'Success requires exit code 0 and exactly one receipt with the real deployment ID, URL and operationId. Inspection returns the original operationId:'}</p>
      <pre>{'CAOGEN_SITE_RECEIPT {"deploymentId":"service-deployment-id","url":"https://example.com","operationId":"original-operation-id"}'}</pre>
      <p>{zh ? '脚本应把 operationId 传给服务作为关联标识，并仅在服务确认发布或回滚后输出回执。普通退出成功或任意网址不构成发布回执。' : 'Use operationId as the service correlation ID and emit a receipt only after the service confirms deploy or rollback.'}</p>
    </details>
    <button type="button" className="btn btn-primary" disabled={busy || !target.id} onClick={() => void prepare(target.id)}>{zh ? '准备发布并预览' : 'Prepare deployment preview'}</button>
    {preview && <article className="site-deployment-preview" data-site-preview={preview.id}>
      <h4>{preview.action === 'deploy' ? (zh ? '发布预览' : 'Deployment preview') : (zh ? '回滚预览' : 'Rollback preview')} · {preview.target.name}</h4>
      <p>{preview.files.length} {zh ? '个文件' : 'files'} · {(preview.bytes / 1024).toFixed(1)} KB · {zh ? '有效至' : 'Expires'} {new Date(preview.expiresAt).toLocaleTimeString()}</p>
      <p>{zh ? '费用：' : 'Cost: '}{preview.target.estimatedCostUsd === undefined ? (zh ? '未知，以服务账单为准' : 'Unknown; billed by your host') : `$${preview.target.estimatedCostUsd} ${zh ? '用户估算，不是硬性上限' : 'user estimate, not a hard limit'}`}</p>
      <code>{preview.manifestDigest}</code><pre>{preview.command.map(arg => JSON.stringify(arg)).join(' ')}</pre>
      <details><summary>{zh ? '发布文件清单' : 'File manifest'}</summary><ul>{preview.files.map(file => <li key={file.path}>{file.path} · {file.bytes} B</li>)}</ul></details>
      <div className="site-deployment-actions">{preview.localUrl && <button type="button" className="btn btn-ghost btn-sm" onClick={() => open(preview.localUrl!)}>{zh ? '打开本地预览' : 'Open local preview'}</button>}
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || preview.expiresAt < Date.now()} onClick={() => void operate(async () => { const result = await window.agentDesk.executeSiteDeployment(sessionId, preview.id); if (result && alive.current) setPreview(undefined) })}>{preview.action === 'deploy' ? (zh ? '确认并发布…' : 'Confirm deployment…') : (zh ? '确认并回滚…' : 'Confirm rollback…')}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void operate(async () => { await window.agentDesk.stopSiteDeploymentPreview(sessionId, preview.id); if (alive.current) setPreview(undefined) })}>{zh ? '关闭预览' : 'Close preview'}</button></div>
    </article>}
    <h4>{zh ? '发布记录' : 'Deployment history'}</h4>
    {!state.receipts.length && <p>{zh ? '尚未执行部署。' : 'No deployments have run.'}</p>}
    {state.receipts.map(receipt => <article className="site-deployment-receipt" data-site-receipt={receipt.id} key={receipt.id}>
      <strong>{receipt.targetName} · {receipt.action === 'deploy' ? (zh ? '发布' : 'Deploy') : (zh ? '回滚' : 'Rollback')} · {receiptLabel(receipt, zh)}</strong>
      <p>{new Date(receipt.startedAt).toLocaleString()} · {receipt.deploymentId ?? receipt.id}</p>
      {receipt.error && <p role="status">{receipt.error}</p>}
      {receipt.url && <button type="button" className="btn btn-ghost btn-sm" onClick={() => open(receipt.url!)}>{receipt.url}</button>}
      <div className="site-deployment-actions">
        {receipt.status === 'executing' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void window.agentDesk.cancelSiteDeployment(sessionId, receipt.id).then(refresh).catch(cause => setError(String(cause)))}>{zh ? '停止部署程序' : 'Stop deployment process'}</button>}
        {receipt.status === 'needs_reconciliation' && <><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void operate(async () => { await window.agentDesk.inspectSiteDeployment(sessionId, receipt.id) })}>{zh ? '核对原部署…' : 'Inspect original deployment…'}</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => useStore.getState().setShowTaskRecovery(true)}>{zh ? '任务恢复中心' : 'Task Recovery'}</button></>}
        {receipt.status === 'confirmed' && receipt.action === 'deploy' && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void prepare(receipt.targetId, receipt.id)}>{zh ? '准备回滚此部署…' : 'Prepare rollback…'}</button>}
      </div><details><summary>{zh ? '执行回执与日志' : 'Execution receipt and logs'}</summary><p>{zh ? '退出码' : 'Exit code'}：{receipt.exitCode ?? '—'} · Effect：{receipt.effectId ?? '—'}</p>
        {receipt.outputTruncated && <p>{zh ? '输出已截断。' : 'Output truncated.'}</p>}<pre>{receipt.stdout || (zh ? '无标准输出' : 'No stdout')}</pre><pre>{receipt.stderr}</pre></details>
    </article>)}
  </section>
}
function receiptLabel(receipt: SiteDeploymentReceipt, zh: boolean): string {
  return ({ executing: ['执行中', 'Running'], confirmed: ['适配器已确认', 'Confirmed by adapter'], not_started: ['未执行', 'Not started'], needs_reconciliation: ['待核对', 'Needs reconciliation'] })[receipt.status][zh ? 0 : 1]
}
