import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskHandoffDestinationView } from '../../../../shared/task-handoff-api'
import { useStore } from '../../store'
import '../workbench/task-handoff.css'

export default function TaskHandoffDestinations(): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [destinations, setDestinations] = useState<TaskHandoffDestinationView[]>([])
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState('')
  const alive = useRef(true), request = useRef(0), operating = useRef(false)
  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++request.current
    const rows = await window.agentDesk.listTaskHandoffDestinations()
    if (alive.current && generation === request.current) { setDestinations(rows); setLoaded(true) }
  }, [])
  useEffect(() => {
    alive.current = true
    void refresh().catch(cause => { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { alive.current = false; request.current++ }
  }, [refresh])
  const act = async (action: () => Promise<unknown>): Promise<void> => {
    if (operating.current) return
    operating.current = true; setBusy(true); setError('')
    try { await action(); if (alive.current) await refresh() }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { operating.current = false; if (alive.current) setBusy(false) }
  }
  return <section className="task-handoff-destinations" aria-label={zh ? '本机任务接收目录' : 'Local task receiving directories'}>
    <header><h4>{zh ? '本机接收目录' : 'Local receiving directories'}</h4><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(refresh)}>{zh ? '刷新' : 'Refresh'}</button></header>
    <p>{zh ? '只有你在这里选择的目录可以接收已授权设备移交的原任务、上下文和项目文件。默认没有接收目录；撤销目录后停止新的接收授权。' : 'Only directories selected here can receive original tasks, context and project files from devices with handoff permission. None are authorized by default; revoking a directory stops new receiving authorization.'}</p>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    <button type="button" className="btn btn-primary btn-sm" data-handoff-add-destination disabled={busy}
      onClick={() => void act(() => window.agentDesk.addTaskHandoffDestination())}>{zh ? '选择并授权接收目录…' : 'Choose and authorize receiving directory…'}</button>
    {loaded && !destinations.some(item => item.enabled && item.expiresAt > Date.now()) && <p>{zh ? '当前没有有效接收目录，其他电脑不能把任务导入本机。' : 'No active destination. Other computers cannot import tasks here.'}</p>}
    {destinations.map(item => <article key={item.id} className="task-handoff-destination-row" data-handoff-destination-id={item.id}>
      <strong>{item.label}</strong><code>{item.path}</code><p>{!item.enabled ? zh ? '已撤销' : 'Revoked' : item.expiresAt <= Date.now() ? zh ? '已过期' : 'Expired' : zh ? '已授权' : 'Authorized'} · {zh ? '到期' : 'Expires'} {new Date(item.expiresAt).toLocaleString()}</p>
      <p>{zh ? '续期会为上面的同一目录重新授权 24 小时，保留原授权 ID，使原移交可继续核对；不会更换接收路径。' : 'Renewal authorizes this same directory for 24 hours and preserves its grant ID so the original handoff can be reconciled. The receiving path stays the same.'}</p>
      <button type="button" className="btn btn-ghost btn-sm" data-handoff-renew-destination={item.id} disabled={busy}
        onClick={() => void act(() => window.agentDesk.renewTaskHandoffDestination(item.id))}>
        {!item.enabled || item.expiresAt <= Date.now() ? zh ? '重新授权并续期 24 小时' : 'Reauthorize and renew for 24 hours' : zh ? '续期 24 小时' : 'Renew for 24 hours'}</button>
      {item.enabled && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => window.agentDesk.revokeTaskHandoffDestination(item.id))}>{zh ? '撤销此目录授权' : 'Revoke directory authorization'}</button>}
    </article>)}
  </section>
}
