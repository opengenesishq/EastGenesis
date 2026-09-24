import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteHostView } from '../../../../shared/remote-host-types'
import type { RemoteSshTunnelView } from '../../../../shared/ssh-types'
import { sameRemoteTarget, type WelcomeRemoteTarget } from './welcome-remote-target'
import { useStore } from '../../store'
import { taskWindowSessionId } from '../../task-window-context'

export default function RemoteHostConnectionGate({ target, onReady }: { target: WelcomeRemoteTarget; onReady?(ready: boolean): void }): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [host, setHost] = useState<RemoteHostView>(), [tunnels, setTunnels] = useState<RemoteSshTunnelView[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [auth, setAuth] = useState('')
  const generation = useRef(0), detached = Boolean(taskWindowSessionId())
  const targetKey = JSON.stringify(target)
  const refresh = useCallback(async () => {
    const seq = ++generation.current
    try {
      const [result, connections] = await Promise.all([window.agentDesk.listRemoteHosts(), detached ? Promise.resolve([]) : window.agentDesk.listRemoteSshTunnels()])
      if (seq !== generation.current) return
      const current = result.hosts.find(item => sameRemoteTarget(target, item))
      setHost(current); setTunnels(connections)
      if (!current) setError(zh ? '原连接已移除或身份已变化，请在主工作台连接设置核对。' : 'Original connection missing or changed. Review it in main workspace settings.')
    } catch { if (seq === generation.current) setError(zh ? '无法读取连接状态。' : 'Cannot read connection status.') }
  }, [targetKey, detached, zh])
  useEffect(() => { setHost(undefined); setAuth(''); setError(''); void refresh(); const timer = setInterval(() => void refresh(), 3000); return () => { generation.current++; clearInterval(timer) } }, [refresh])
  const tunnel = target.ssh ? tunnels.find(item => item.binding.sshHostId === target.ssh!.sshHostId && item.binding.sshHostRevision === target.ssh!.sshHostRevision && item.binding.sshConfigDigest === target.ssh!.sshConfigDigest && item.binding.httpsOrigin === target.origin && ['ready', 'connecting'].includes(item.state)) : undefined
  const ready = !detached && !!host && host.status === 'paired' && !host.renewal && (host.expiresAt ?? 0) > Date.now() && (!target.ssh || tunnel?.state === 'ready')
  useEffect(() => { onReady?.(ready) }, [ready, onReady])
  const run = async (operation: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(''); try { await operation(); await refresh() } catch { setError(zh ? '连接操作未确认，请核对原连接或在设置查看原因。' : 'Connection operation unconfirmed. Inspect the original connection in settings.') } finally { setBusy(false) } }
  return <div className="welcome-remote-connection" data-remote-connection-state={ready ? 'ready' : 'unavailable'}>
    <span>{target.hostLabel} · {target.projectLabel} · {target.ssh ? 'SSH' : zh ? '直连' : 'Direct'}</span>
    <small>{zh ? '使用远端模型、路由与权限；文件留在远端。' : 'Uses host models, routing and permissions; files stay on the host.'}</small>
    {detached ? <small>{zh ? '独立任务窗口将草稿交给主工作台，主窗口确认后再发送。' : 'Pass this draft to the main workspace, then submit it there.'}</small> : <>
      <span role="status">{ready ? zh ? '连接可用' : 'Connection ready' : zh ? '等待连接确认' : 'Connection needs attention'}</span>
      {host?.storage === 'session' && <small>{zh ? '仅本次运行连接：退出应用后无法恢复连接和原命令。' : 'Session-only connection: connection and commands cannot be recovered after app exit.'}</small>}
      {host && (host.status === 'expired' || host.renewal) && <button type="button" disabled={busy || !!target.ssh && tunnel?.state !== 'ready'} onClick={() => void run(() => window.agentDesk.renewRemoteHost(host.id))}>{host.renewal ? zh ? '核对原续期' : 'Check original renewal' : zh ? '原身份续期 24 小时' : 'Renew original connection for 24 hours'}</button>}
      {target.ssh && tunnel?.state !== 'ready' && <button type="button" disabled={busy || tunnel?.state === 'connecting'} onClick={() => void run(() => window.agentDesk.startRemoteHostSshTunnel({ hostId: target.hostId, sshHostId: target.ssh!.sshHostId, sshHostRevision: target.ssh!.sshHostRevision }))}>{zh ? '连接原 SSH 主机' : 'Connect original SSH host'}</button>}
      {tunnel?.output && <pre>{tunnel.output}</pre>}
      {tunnel?.state === 'connecting' && <form onSubmit={event => { event.preventDefault(); const input = auth; setAuth(''); void run(() => window.agentDesk.writeRemoteSshTunnelInput(tunnel.id, input)) }}>
        <input type="password" autoComplete="off" aria-label={zh ? '原 SSH 进程认证输入' : 'Authentication for the original SSH process'} value={auth} onChange={event => setAuth(event.target.value)} />
        <button disabled={busy}>{zh ? '输入到 SSH' : 'Send to SSH'}</button><small>{zh ? '仅交给当前窗口的原 SSH 进程，不保存。' : 'Only sent to this window’s SSH process; never saved.'}</small>
      </form>}
      <button type="button" onClick={() => useStore.getState().setShowSettings(true, 'remote-hosts')}>{zh ? '管理远端主机' : 'Manage remote hosts'}</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </div>
}
