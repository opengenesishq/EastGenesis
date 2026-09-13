import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link2, LockKeyhole, RefreshCw, ShieldCheck, Unplug } from 'lucide-react'
import type { RemoteContinuationSnapshot, RemoteDeviceCapability, RemoteResultProjection } from '../../../../shared/types'
import { useStore } from '../../store'

const DEFAULT_CAPABILITIES: RemoteDeviceCapability[] = ['view_results', 'resume_work_item', 'approve_effect']

export function RemoteContinuationPanel({ active, projectId }: { active: boolean; projectId?: string }): React.JSX.Element {
  const language = useStore((state) => state.settings.language)
  const [snapshot, setSnapshot] = useState<RemoteContinuationSnapshot | null>(null)
  const [projection, setProjection] = useState<RemoteResultProjection | null>(null)
  const [label, setLabel] = useRemoteDeviceLabel(language)
  const [userId, setUserId] = useState('local-user')
  const [publicKey, setPublicKey] = useState('')
  const [editingCapabilities, setEditingCapabilities] = useState<Record<string, RemoteDeviceCapability[]>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { pairing, createPairing } = useRemotePairing(projectId, setError)

  const refresh = useCallback(async (): Promise<void> => {
    setError('')
    try {
      const next = await window.agentDesk.getRemoteContinuation()
      setSnapshot(next)
      if (projectId) setProjection(await window.agentDesk.getRemoteResultProjection(projectId))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [projectId])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  const run = async (operation: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try { await operation(); await refresh() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

  const activeDevices = useMemo(() => snapshot?.devices.filter((device) => device.status === 'active') ?? [], [snapshot])
  const toggleCapability = (deviceId: string, capability: RemoteDeviceCapability): void => {
    setEditingCapabilities((current) => {
      const selected = current[deviceId] ?? snapshot?.devices.find((device) => device.id === deviceId)?.capabilities ?? []
      const next = selected.includes(capability) ? selected.filter((item) => item !== capability) : [...selected, capability]
      return { ...current, [deviceId]: next }
    })
  }
  return (
    <section className="remote-continuation-panel" aria-labelledby="remote-continuation-title">
      <header className="remote-continuation-header">
        <div>
          <h2 id="remote-continuation-title"><Link2 size={16} aria-hidden="true" />{localized('远程接续', 'Remote continuation')}</h2>
          <p>{localized('只同步任务状态、审批和交付摘要；本地凭据与原文不会离开桌面端。', 'Only task status, approvals, and delivery summaries are synchronized. Local credentials and source content stay on this device.')}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-icon-sm" aria-label={localized('刷新远程状态', 'Refresh remote status')} title={localized('刷新远程状态', 'Refresh remote status')} disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} className={busy ? 'remote-spin' : undefined} aria-hidden="true" /></button>
      </header>
      {error && <p className="remote-continuation-error" role="alert">{error}</p>}
      <div className="remote-continuation-toolbar">
        <span className={`remote-connectivity remote-connectivity-${snapshot?.connectivity ?? 'offline'}`}><span aria-hidden="true" />{snapshot?.connectivity === 'online' ? localized('控制通道在线', 'Control channel online') : localized('桌面离线，命令仅排队', 'Desktop offline; commands are queued')}</span>
        <span className="remote-webhook-status" title={localized('本机 Webhook 接收状态', 'Local webhook receiver status')}>{snapshot?.webhook?.running ? `Webhook ${snapshot.webhook.host}:${snapshot.webhook.port}` : localized('Webhook 未监听', 'Webhook not listening')}</span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !snapshot} onClick={() => void run(() => window.agentDesk.setRemoteConnectivity(snapshot?.connectivity === 'online' ? 'offline' : 'online'))}>{snapshot?.connectivity === 'online' ? localized('模拟离线', 'Simulate offline') : localized('恢复连接', 'Restore connection')}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || snapshot?.connectivity !== 'online'} onClick={() => void run(() => window.agentDesk.reconcileRemoteQueue())}>{localized('对账队列', 'Reconcile queue')}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !snapshot?.webhook?.running} onClick={() => void createPairing()}><Link2 size={13} aria-hidden="true" />{localized('生成移动配对链接', 'Create mobile pairing link')}</button>
      </div>
      {pairing && <div className="remote-pairing-card"><strong>{localized('配对链接已复制', 'Pairing link copied')}</strong><a href={pairing.url} target="_blank" rel="noreferrer">{pairing.url}</a><small>{localized('有效期至', 'Expires at')} {formatPairingExpiry(pairing.expiresAt, language)}</small></div>}
      <div className="remote-continuation-bind">
        <strong><ShieldCheck size={14} aria-hidden="true" />{localized('绑定设备公钥', 'Bind device public key')}</strong>
        <div className="remote-continuation-fields">
          <input className="input" value={label} onChange={(event) => setLabel(event.target.value)} placeholder={localized('设备名称', 'Device name')} aria-label={localized('设备名称', 'Device name')} />
          <input className="input" value={userId} onChange={(event) => setUserId(event.target.value)} placeholder={localized('用户标识', 'User ID')} aria-label={localized('用户标识', 'User ID')} />
          <input className="input remote-public-key" value={publicKey} onChange={(event) => setPublicKey(event.target.value)} placeholder="Ed25519 SPKI DER Base64" aria-label={localized('设备公钥', 'Device public key')} />
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !label.trim() || !userId.trim() || !publicKey.trim()} onClick={() => void run(async () => { await window.agentDesk.registerRemoteDevice({ label, userId, publicKey, capabilities: DEFAULT_CAPABILITIES }); setPublicKey('') })}>{localized('绑定', 'Bind')}</button>
        </div>
      </div>
      <div className="remote-device-list">
        {activeDevices.length === 0 ? <span className="remote-muted">{localized('暂无绑定设备', 'No bound devices')}</span> : activeDevices.map((device) => (
          <div key={device.id} className="remote-device-row">
            <span><LockKeyhole size={14} aria-hidden="true" /><strong>{device.label}</strong><small>{device.publicKeyFingerprint.slice(0, 24)}...</small></span>
            <div className="remote-device-actions">
              <details className="remote-capability-editor">
                <summary>{localized('权限', 'Permissions')}</summary>
                <div className="remote-capability-options">
                  {(['view_results', 'resume_work_item', 'approve_effect', 'trigger_routine', 'remote_runner'] as RemoteDeviceCapability[]).map((capability) => {
                    const selected = editingCapabilities[device.id] ?? device.capabilities
                    return <label key={capability}><input type="checkbox" checked={selected.includes(capability)} onChange={() => toggleCapability(device.id, capability)} />{capability}</label>
                  })}
                  <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => void run(() => window.agentDesk.updateRemoteDeviceCapabilities(device.id, editingCapabilities[device.id] ?? device.capabilities))}>{localized('保存权限', 'Save permissions')}</button>
                </div>
              </details>
              <button type="button" className="btn btn-ghost btn-icon-sm" aria-label={localized(`解绑 ${device.label}`, `Unbind ${device.label}`)} title={localized(`解绑 ${device.label}`, `Unbind ${device.label}`)} disabled={busy} onClick={() => void run(() => window.agentDesk.unbindRemoteDevice(device.id))}><Unplug size={14} aria-hidden="true" /></button>
            </div>
          </div>
        ))}
      </div>
      {snapshot && <div className="remote-queue-summary"><span>{localized('命令', 'Commands')} {snapshot.commands.length}</span><span>{localized('待审批', 'Pending approvals')} {snapshot.approvals.filter((item) => item.status === 'pending').length}</span><span>{localized('租约', 'Leases')} {snapshot.leases.filter((item) => item.status === 'active').length}</span><span>{localized('审计', 'Audit')} {snapshot.audit.length}</span></div>}
      {snapshot && snapshot.commands.length > 0 && <div className="remote-state-list" aria-label={localized('远程命令状态', 'Remote command status')}>
        <strong>{localized('最近命令', 'Recent commands')}</strong>
        {snapshot.commands.slice(-8).reverse().map((command) => (
          <div className="remote-state-row" key={command.envelope.commandId}>
            <span className="remote-state-kind">{command.envelope.kind}</span>
            <span>{command.status}</span>
            <span>{command.execution?.status ?? 'queued'}</span>
            <code>{command.envelope.commandId.slice(0, 8)}</code>
          </div>
        ))}
      </div>}
      {snapshot && snapshot.approvals.length > 0 && <div className="remote-state-list" aria-label={localized('远程审批状态', 'Remote approval status')}>
        <strong>{localized('最近审批', 'Recent approvals')}</strong>
        {snapshot.approvals.slice(-8).reverse().map((approval) => (
          <div className="remote-state-row" key={approval.id}>
            <span className="remote-state-kind">{approval.action}</span>
            <span>{approval.status}</span>
            <span>{approval.applicationStatus}</span>
            <code title={approval.targetDigest}>{localized('目标', 'Target')} {approval.targetDigest.slice(0, 10)}</code>
          </div>
        ))}
      </div>}
      {projection && <div className="remote-result-projection"><strong>{localized('结果摘要', 'Result summary')} · {projection.projectName}</strong><span>{localized(`${projection.activeWorkItemCount} 个未完成 WorkItem`, `${projection.activeWorkItemCount} incomplete work items`)}</span><span>{localized(`${projection.availableArtifactCount}/${projection.artifactCount} 个可用 Artifact`, `${projection.availableArtifactCount}/${projection.artifactCount} available artifacts`)}</span><span>{localized(`${projection.passedAcceptanceCount}/${projection.acceptanceCount} 个验收通过`, `${projection.passedAcceptanceCount}/${projection.acceptanceCount} acceptances passed`)}</span><code>{projection.projectionDigest.slice(0, 20)}...</code></div>}
    </section>
  )
}

function useRemoteDeviceLabel(language: 'zh' | 'en'): [string, React.Dispatch<React.SetStateAction<string>>] {
  const [label, setLabel] = useState(() => localized('我的移动设备', 'My mobile device'))
  useEffect(() => {
    setLabel((current) => current === '我的移动设备' || current === 'My mobile device'
      ? localized('我的移动设备', 'My mobile device')
      : current)
  }, [language])
  return [label, setLabel]
}

function useRemotePairing(
  projectId: string | undefined,
  setError: React.Dispatch<React.SetStateAction<string>>
): { pairing: { url: string; expiresAt: number } | null; createPairing: () => Promise<void> } {
  const [pairing, setPairing] = useState<{ url: string; expiresAt: number } | null>(null)
  const createPairing = useCallback(async (): Promise<void> => {
    setError('')
    try {
      const next = await window.agentDesk.createRemotePairingSession({ ttlMs: 5 * 60_000, projectId })
      setPairing(next)
      try { await navigator.clipboard.writeText(next.url) } catch { /* clipboard permission is optional */ }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [projectId, setError])
  return { pairing, createPairing }
}

function formatPairingExpiry(expiresAt: number, language: 'zh' | 'en'): string {
  return new Date(expiresAt).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US')
}

function localized(chinese: string, english: string): string {
  return useStore.getState().settings.language === 'en' ? english : chinese
}
