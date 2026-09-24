import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { DEFAULT_REMOTE_CONNECTION, type RemoteConnectionSettings as ConnectionSettings, type RemoteConnectionState } from '../../../../shared/remote-connection-types'
import '../studio/remote-continuation.css'

export function RemoteConnectionForm({ onApplied }: { onApplied?(): void }): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [state, setState] = useState<RemoteConnectionState>()
  const [draft, setDraft] = useState<ConnectionSettings>({ ...DEFAULT_REMOTE_CONNECTION })
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void window.agentDesk.getRemoteConnectionSettings().then(value => {
      if (alive) { setState(value); setDraft(value.settings) }
    }).catch(cause => { if (alive) setError(String(cause)) }).finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [])
  const update = (patch: Partial<ConnectionSettings>): void => setDraft(current => ({ ...current, ...patch }))
  const apply = async (next: ConnectionSettings): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const value = await window.agentDesk.saveRemoteConnectionSettings(next)
      setState(value); setDraft(value.settings); onApplied?.()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <section className="remote-connection-settings">
    <h3>{zh ? '连接这台电脑' : 'Connect to this computer'}</h3>
    <p>{zh ? '选择项目并生成配对链接，从手机查看进展和继续任务。电脑与 EastGenesis 需要保持运行。' : 'Pair a phone with a project to check progress and continue tasks. Keep this computer and EastGenesis running.'}</p>
    <p role="status">{state?.running ? `${zh ? '连接服务运行中' : 'Connection is running'} · ${state.address}` : zh ? '连接服务未启动' : 'Connection is stopped'}</p>
    {state?.keepingAwake && <p role="status" data-remote-keeping-awake>{zh ? '正在保持本机唤醒，屏幕仍可自动关闭。' : 'Keeping this computer awake; the display can still turn off.'}</p>}
    <fieldset disabled={busy} className="remote-connection-fields">
      <label><input type="checkbox" checked={draft.enabled} onChange={event => update({ enabled: event.target.checked })} />{zh ? '启用远程连接，启动应用时自动恢复' : 'Enable remote connection and restore on app startup'}</label>
      <label><input type="checkbox" data-remote-keep-awake checked={draft.keepAwake} onChange={event => update({ keepAwake: event.target.checked })} />{zh ? '连接服务运行时保持本机唤醒' : 'Keep this computer awake while the connection service runs'}</label>
      <p className="settings-hint">{zh ? '允许远端在没有任务运行时连接，不阻止屏幕自动关闭；停止服务或退出应用后恢复系统休眠。' : 'Allow remote connections while tasks are idle. The display can turn off; stopping the service or quitting restores normal system sleep.'}</p>
      <label>{zh ? '连接范围' : 'Connection scope'}<select className="select" value={['127.0.0.1', '0.0.0.0'].includes(draft.host) ? draft.host : 'custom'} onChange={event => update({ host: event.target.value === 'custom' ? '::' : event.target.value })}><option value="127.0.0.1">{zh ? '仅本机' : 'This computer only'}</option><option value="0.0.0.0">{zh ? '手机 / 其他设备（HTTPS）' : 'Phone / other devices (HTTPS)'}</option><option value="custom">{zh ? '指定本机 IP' : 'Specific local IP'}</option></select></label>
      {!['127.0.0.1', '0.0.0.0'].includes(draft.host) && <label>{zh ? '本机监听 IP' : 'Local listening IP'}<input className="input" value={draft.host} onChange={event => update({ host: event.target.value })} /></label>}
      <label>{zh ? '端口（0 自动选择）' : 'Port (0 for automatic)'}<input className="input" type="number" min={0} max={65535} value={draft.port} onChange={event => update({ port: Number(event.target.value) })} /></label>
      <label>{zh ? '手机访问主机名或 IP' : 'Hostname or IP reachable from phone'}<input className="input" placeholder="desktop.example.com" value={draft.advertisedHost} onChange={event => update({ advertisedHost: event.target.value })} /></label>
      <label>{zh ? 'TLS 证书文件' : 'TLS certificate file'}<input className="input" placeholder="/path/to/certificate.pem" value={draft.tlsCertPath} onChange={event => update({ tlsCertPath: event.target.value })} /></label>
      <label>{zh ? 'TLS 私钥文件' : 'TLS private key file'}<input className="input" placeholder="/path/to/private-key.pem" value={draft.tlsKeyPath} onChange={event => update({ tlsKeyPath: event.target.value })} /></label>
      <p className="settings-hint">{zh ? '手机浏览器需要信任与访问地址匹配的 HTTPS 证书。只保留证书路径，私钥内容留在这台电脑。' : 'The phone must trust an HTTPS certificate matching this address. Only file paths are saved; the private key stays on this computer.'}</p>
      <div className="remote-connection-buttons"><button className="btn btn-primary btn-sm" type="button" onClick={() => void apply(draft)}>{zh ? '保存并应用' : 'Save and apply'}</button>{state?.running && <button className="btn btn-ghost btn-sm" type="button" onClick={() => void apply({ ...state.settings, enabled: false })}>{zh ? '停止连接服务' : 'Stop connection'}</button>}</div>
    </fieldset>
    {(error || state?.error) && <p className="notice notice-error" role="alert">{error || state?.error}</p>}
  </section>
}
