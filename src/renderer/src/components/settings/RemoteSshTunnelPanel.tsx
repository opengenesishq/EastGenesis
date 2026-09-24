import { useEffect, useState } from 'react'
import type { RemoteHostApi } from '../../../../shared/remote-host-types'
import type { RemoteSshTunnelView, SshHost } from '../../../../shared/ssh-types'

export default function RemoteSshTunnelPanel({ pairingUrl, enabled, selectedId, onSelect, onTunnels, zh }: {
  pairingUrl: string; enabled: boolean; selectedId: string
  onSelect(id: string): void; onTunnels(value: RemoteSshTunnelView[]): void; zh: boolean
}): React.JSX.Element {
  const api = window.agentDesk as typeof window.agentDesk & RemoteHostApi
  const [hosts, setHosts] = useState<SshHost[]>([]), [tunnels, setTunnels] = useState<RemoteSshTunnelView[]>([])
  const [hostId, setHostId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [auth, setAuth] = useState<Record<string, string>>({})
  useEffect(() => {
    let alive = true
    void window.agentDesk.listSshHosts().then(result => { if (alive) { setHosts(result.hosts); if (!result.supported) setError(result.reason ?? 'SSH unavailable') } }).catch(cause => { if (alive) setError(String(cause)) })
    const refresh = async () => {
      try { const items = await api.listRemoteSshTunnels(); if (alive) { setTunnels(items); onTunnels(items) } }
      catch (cause) { if (alive) setError(String(cause)) }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 1000)
    return () => { alive = false; clearInterval(timer) }
  }, [api, onTunnels])
  const run = async (operation: () => Promise<void>) => { setBusy(true); setError(''); try { await operation() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) } }
  const selected = hosts.find(host => host.id === hostId) ?? hosts.find(host => host.trustedKeys.length)
  const stateText = (value: RemoteSshTunnelView['state']) => ({ connecting: zh ? '等待 SSH 连接/认证' : 'Connecting / authenticating SSH', ready: zh ? 'SSH 隧道已连接' : 'SSH tunnel connected', closed: zh ? '已断开' : 'Disconnected', failed: zh ? '连接失败' : 'Connection failed' }[value])
  if (!enabled && !tunnels.length) return <></>
  return <section className="remote-ssh-tunnels">
    <h4>{zh ? 'SSH 远端项目连接' : 'Remote projects over SSH'}</h4>
    {enabled && <><p>{zh ? '选择已核对公钥的 SSH 主机。远端需已运行 EastGenesis HTTPS 服务，使用上面的原始配对链接。' : 'Select an SSH host with reviewed keys. EastGenesis HTTPS must already run on that host; use its original pairing link above.'}</p>
      <select className="select" value={selected?.id ?? ''} disabled={busy} onChange={event => setHostId(event.target.value)}><option value="">{zh ? '先在 SSH 设置添加并核对主机' : 'Add and review a host in SSH settings'}</option>{hosts.map(host => <option key={host.id} value={host.id} disabled={!host.trustedKeys.length}>{host.name} · {host.username}@{host.hostname}</option>)}</select>
      <button className="btn btn-ghost btn-sm" disabled={busy || !selected || !pairingUrl.trim()} onClick={() => void run(async () => {
        const item = await api.startRemoteHostSshTunnel({ sshHostId: selected!.id, sshHostRevision: selected!.revision, pairingUrl }); onSelect(item.id)
        const items = await api.listRemoteSshTunnels(); setTunnels(items); onTunnels(items)
      })}>{zh ? '连接此 SSH 主机' : 'Connect SSH host'}</button></>}
    {tunnels.map(tunnel => <article key={tunnel.id} className="remote-ssh-tunnel"><strong>{tunnel.hostLabel}</strong><small>{stateText(tunnel.state)} · HTTPS {tunnel.binding.httpsOrigin} → 127.0.0.1:{tunnel.remotePort}</small>
      {enabled && tunnel.state === 'ready' && <button className="btn btn-ghost btn-sm" aria-pressed={selectedId === tunnel.id} onClick={() => onSelect(tunnel.id)}>{selectedId === tunnel.id ? zh ? '已用于本次配对' : 'Selected for pairing' : zh ? '用于本次配对' : 'Use for this pairing'}</button>}
      {['connecting', 'ready'].includes(tunnel.state) && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(async () => { await api.closeRemoteSshTunnel(tunnel.id); const items = await api.listRemoteSshTunnels(); setTunnels(items); onTunnels(items) })}>{zh ? '断开隧道' : 'Disconnect tunnel'}</button>}
      {tunnel.output && <pre className="remote-ssh-prompt">{tunnel.output}</pre>}{tunnel.error && <p role="alert">{tunnel.error}</p>}
      {tunnel.state === 'connecting' && <div><input type="password" className="input" autoComplete="off" value={auth[tunnel.id] ?? ''} aria-label={zh ? 'SSH 密码或私钥口令' : 'SSH password or key passphrase'} placeholder={zh ? '根据上方 SSH 提示输入密码或私钥口令' : 'Enter password or passphrase only when prompted above'} onChange={event => setAuth(current => ({ ...current, [tunnel.id]: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); const value = auth[tunnel.id] ?? ''; setAuth(current => ({ ...current, [tunnel.id]: '' })); void run(() => api.writeRemoteSshTunnelInput(tunnel.id, value)) } }} /><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { const value = auth[tunnel.id] ?? ''; setAuth(current => ({ ...current, [tunnel.id]: '' })); void run(() => api.writeRemoteSshTunnelInput(tunnel.id, value)) }}>{zh ? '输入到 SSH' : 'Send to SSH'}</button><small>{zh ? '认证信息仅交给此 SSH 进程，不保存。' : 'Authentication input goes only to this SSH process and is not saved.'}</small></div>}
    </article>)}
    {error && <p className="notice notice-error" role="alert">{error}</p>}
  </section>
}
