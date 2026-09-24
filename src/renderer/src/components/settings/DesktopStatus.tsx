import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, RefreshCw } from 'lucide-react'
import type { EngineInfo, ProviderHealthView, SessionMeta } from '../../../../shared/types'
import type { FeedbackAppInfo } from '../../../../shared/feedback-types'
import type { ProviderGatewayStatusView } from '../../../../shared/provider-gateway-types'
import type { SettingsTab } from '../../store/settings-navigation'
import { useStore } from '../../store'
import './desktop-status.css'

type Snapshot = { at: number; app?: FeedbackAppInfo; tasks?: SessionMeta[]; health?: ProviderHealthView[];
  engines?: EngineInfo[]; gateway?: ProviderGatewayStatusView; unavailable: string[] }

export default function DesktopStatus(): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const providers = useStore(state => state.providers)
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [busy, setBusy] = useState(false)
  const [openingId, setOpeningId] = useState('')
  const [navigationError, setNavigationError] = useState('')
  const revision = useRef(0)
  const tr = (cn: string, en: string): string => zh ? cn : en
  const refresh = useCallback(async (): Promise<void> => {
    const request = ++revision.current
    setBusy(true); setOpeningId('')
    const [app, tasks, health, engines, gateway] = await Promise.allSettled([
      window.agentDesk.getFeedbackAppInfo(), window.agentDesk.listSessions(), window.agentDesk.listProviderHealth(),
      window.agentDesk.listEngines(), window.agentDesk.getProviderGatewayStatus()
    ])
    if (request !== revision.current) return
    const unavailable = [app, tasks, health, engines, gateway].flatMap((value, index) => value.status === 'rejected'
      ? [(zh ? ['应用', '任务', '厂商记录', '执行资源', '本机网关'] : ['App', 'Tasks', 'Provider records', 'Runtimes', 'Local gateway'])[index]] : [])
    setSnapshot({ at: Date.now(), app: app.status === 'fulfilled' ? app.value : undefined,
      tasks: tasks.status === 'fulfilled' ? tasks.value : undefined,
      health: health.status === 'fulfilled' ? health.value : undefined,
      engines: engines.status === 'fulfilled' ? engines.value : undefined,
      gateway: gateway.status === 'fulfilled' ? gateway.value : undefined, unavailable })
    setBusy(false)
  }, [zh])
  useEffect(() => {
    void refresh()
    const focus = (): void => { void refresh() }
    window.addEventListener('focus', focus)
    return () => { revision.current++; window.removeEventListener('focus', focus) }
  }, [refresh])
  const open = (tab: SettingsTab): void => useStore.getState().setShowSettings(true, tab)
  const openTask = async (id: string): Promise<void> => {
    if (openingId) return
    const current = revision.current
    setOpeningId(id); setNavigationError('')
    try {
      await useStore.getState().syncSession(id)
      if (revision.current !== current) return
      const state = useStore.getState()
      if (!state.sessions[id] || state.sessions[id].meta.status === 'closed') throw new Error(tr('任务已关闭，请刷新状态。', 'The task has closed. Refresh status.'))
      state.selectSession(id); state.setShowNewSession(false); state.setShowSettings(false); state.setView('list')
    } catch (cause) { if (revision.current === current) setNavigationError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (revision.current === current) setOpeningId('') }
  }
  const tasks = snapshot?.tasks?.filter(task => task.status !== 'closed')
  const date = (value?: number): string => value ? new Date(value).toLocaleString(zh ? 'zh-CN' : 'en') : tr('暂无记录', 'No record')
  const labels: Record<SessionMeta['status'], string> = { starting: tr('启动中', 'Starting'), running: tr('运行中', 'Running'),
    idle: tr('空闲', 'Idle'), error: tr('错误', 'Error'), closed: tr('已关闭', 'Closed') }
  return <section className="desktop-status" data-desktop-status>
    <header><div><h3><Activity size={18} />{tr('状态', 'Status')}</h3><p className="settings-hint">{tr('本机任务、连接记录与运行环境。', 'Local tasks, connection records, and runtimes.')}</p></div>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} />{tr('刷新', 'Refresh')}</button></header>
    {busy && <p role="status">{tr('正在读取本机状态…', 'Reading local status…')}</p>}
    {snapshot && <p className="settings-hint">{tr('读取时间：', 'Read at: ')}{date(snapshot.at)}</p>}
    {snapshot?.unavailable.length ? <p role="alert" className="notice notice-error">{tr('以下信息未能读取：', 'Unavailable: ')}{snapshot.unavailable.join('、')}</p> : null}
    {navigationError && <p role="alert" className="notice notice-error">{navigationError}</p>}
    <div className="desktop-status-counts">
      <div><strong>{tasks?.filter(task => task.status === 'running' || task.status === 'starting').length ?? '—'}</strong><span>{tr('运行中任务', 'Active tasks')}</span></div>
      <div><strong>{tasks?.filter(task => task.status === 'error').length ?? '—'}</strong><span>{tr('出错任务', 'Task errors')}</span></div>
      <div><strong>{snapshot?.engines?.filter(engine => engine.available).length ?? '—'}</strong><span>{tr('可用执行资源', 'Available runtimes')}</span></div>
    </div>
    <article><h4>{tr('应用与环境', 'Application & environment')}</h4>
      {snapshot?.app && <p>EastGenesis {snapshot.app.version} · {snapshot.app.platform} {snapshot.app.architecture}<br />Electron {snapshot.app.electron} · Chromium {snapshot.app.chromium} · Node {snapshot.app.node}</p>}
      {snapshot?.engines?.map(engine => <p key={engine.kind}>{engine.label} · {engine.available ? tr('本机可用', 'Locally available') : tr('未就绪', 'Not ready')}</p>)}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => open('environment')}>{tr('管理运行环境', 'Manage runtimes')}</button></article>
    <article><h4>{tr('厂商与网关', 'Providers & gateway')}</h4><p className="settings-hint">{tr('下面是本机已有记录。刷新不会向厂商发送探测请求。', 'These are stored local observations. Refresh does not probe providers.')}</p>
      {snapshot?.health?.length === 0 && <p>{tr('暂无厂商调用记录。', 'No provider observations yet.')}</p>}
      {snapshot?.health?.map(item => <div className="desktop-status-provider" key={item.providerId}><strong>{providers.find(provider => provider.id === item.providerId)?.name ?? item.providerId}</strong>
        <span>{tr('成功 / 失败', 'Success / failure')} {item.successes} / {item.failures}</span>
        <span>{tr('最近成功：', 'Last success: ')}{date(item.lastSuccessAt)}</span>
        <span>{tr('最近失败：', 'Last failure: ')}{date(item.lastFailureAt)}</span></div>)}
      {snapshot?.gateway && <p>{tr('本机网关：', 'Local gateway: ')}{({ stopped: tr('未运行', 'Stopped'), starting: tr('启动中', 'Starting'), running: tr('运行中', 'Running'), blocked: tr('受阻', 'Blocked'), error: tr('错误', 'Error') })[snapshot.gateway.state]} · {snapshot.gateway.activeRequests} {tr('个请求', 'requests')}</p>}
      <div className="desktop-status-actions"><button className="btn btn-ghost btn-sm" onClick={() => open('providers')}>{tr('厂商与模型', 'Providers & models')}</button><button className="btn btn-ghost btn-sm" onClick={() => open('routing')}>{tr('路由', 'Routing')}</button><button className="btn btn-ghost btn-sm" onClick={() => open('usage')}>{tr('用量与费用', 'Usage & costs')}</button></div></article>
    <article><h4>{tr('当前任务', 'Current tasks')}</h4>{tasks?.length === 0 && <p>{tr('暂无任务。', 'No tasks.')}</p>}
      {tasks?.slice().sort((a, b) => Number(b.status === 'error') - Number(a.status === 'error') || b.createdAt - a.createdAt).slice(0, 20).map(task => <button type="button" className="desktop-status-task" key={task.id} disabled={Boolean(openingId)} onClick={() => void openTask(task.id)}><span>{task.title || task.id}</span><small>{labels[task.status]}</small></button>)}
      {(tasks?.length ?? 0) > 20 && <p className="settings-hint">{tr('显示最近 20 项，出错任务优先。全部任务可在侧栏查看。', 'Showing 20 tasks, with errors first. View all tasks in the sidebar.')}</p>}</article>
    <button className="btn btn-secondary" onClick={() => open('feedback')}>{tr('反馈与诊断', 'Feedback & diagnostics')}</button>
  </section>
}
