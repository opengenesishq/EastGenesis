import { useEffect, useState } from 'react'
import type { RemoteHostView } from '../../../../shared/remote-host-types'
import { useStore } from '../../store'
import { remoteTarget } from './welcome-remote-target'
import RemoteHostConnectionGate from './RemoteHostConnectionGate'
import { taskWindowSessionId } from '../../task-window-context'
import './welcome-remote-task.css'

export default function WelcomeExecutionTargetPicker(): React.JSX.Element {
  const draft = useStore(state => state.welcomeDraft), update = useStore(state => state.updateWelcomeDraft)
  const zh = useStore(state => state.settings.language === 'zh'), [hosts, setHosts] = useState<RemoteHostView[]>([]), [error, setError] = useState('')
  useEffect(() => { let alive = true; const refresh = () => { void window.agentDesk.listRemoteHosts().then(result => { if (alive) setHosts(result.hosts) }).catch(() => { if (alive) setError(zh ? '无法读取已配对主机。' : 'Cannot read paired hosts.') }) }; refresh(); window.addEventListener('focus', refresh); return () => { alive = false; window.removeEventListener('focus', refresh) } }, [zh])
  const selected = draft.executionTarget?.kind === 'remote' ? draft.executionTarget : undefined
  return <div className="welcome-execution-target">
    <label>{zh ? '执行位置' : 'Run on'}<select data-welcome-execution-target value={selected?.hostId ?? '__local__'} disabled={!!draft.forkFromSdkSessionId} onChange={event => {
      if (event.target.value === '__local__') update({ executionTarget: { kind: 'local' } })
      else { const host = hosts.find(item => item.id === event.target.value); if (host) update({ executionTarget: remoteTarget(host) }) }
    }}><option value="__local__">{zh ? '本机' : 'This computer'}</option>
      {selected && !hosts.some(item => item.id === selected.hostId) && <option value={selected.hostId}>{selected.hostLabel} · {selected.projectLabel}（{zh ? '原连接不可用' : 'unavailable'}）</option>}
      {hosts.filter(host => host.deviceId && host.projectId).map(host => <option key={host.id} value={host.id} disabled={['revoked', 'pairing_unknown', 'revocation_unknown'].includes(host.status)}>{host.label} · {host.projectName ?? host.projectId} · {host.ssh ? 'SSH' : zh ? '直连' : 'Direct'}{host.status !== 'paired' ? ` · ${host.status === 'expired' ? zh ? '已过期' : 'Expired' : host.status}` : ''}</option>)}
    </select></label>
    {!taskWindowSessionId() && !selected && <button
      type="button"
      className="welcome-remote-settings"
      title={zh ? '配置远端执行主机' : 'Configure a remote execution host'}
      onClick={() => useStore.getState().setShowSettings(true, 'remote-hosts')}
    >{zh ? '远端设置' : 'Remote settings'}</button>}
    {draft.forkFromSdkSessionId && <small>{zh ? '分叉草稿保留原来源，需另起新草稿才能选择远端。' : 'Forks keep their source; start a separate draft for a remote task.'}</small>}
    {selected && <RemoteHostConnectionGate key={selected.hostId} target={selected} />}
    {error && <small role="alert">{error}</small>}
  </div>
}
