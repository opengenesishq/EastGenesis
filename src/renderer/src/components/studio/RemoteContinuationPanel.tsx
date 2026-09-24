import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link2, LockKeyhole, RefreshCw, ShieldCheck, Unplug } from 'lucide-react'
import type { RemoteContinuationSnapshot, RemoteDeviceCapability, RemoteResultProjection } from '../../../../shared/types'
import { RemoteConnectionForm } from '../settings/RemoteConnectionForm'
import { useStore } from '../../store'

const DEFAULT_CAPABILITIES: RemoteDeviceCapability[] = ['view_results', 'resume_work_item', 'create_task', 'control_work_item', 'approve_effect']

export function RemoteContinuationPanel({ active, projectId, showConnectionSettings = true }: { active: boolean; projectId?: string; showConnectionSettings?: boolean }): React.JSX.Element {
  const language = useStore((state) => state.settings.language)
  const [snapshot, setSnapshot] = useState<RemoteContinuationSnapshot | null>(null)
  const [projection, setProjection] = useState<RemoteResultProjection | null>(null)
  const [label, setLabel] = useRemoteDeviceLabel(language)
  const [userId, setUserId] = useState('local-user')
  const [publicKey, setPublicKey] = useState('')
  const [editingCapabilities, setEditingCapabilities] = useState<Record<string, RemoteDeviceCapability[]>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [workspaceRead, setWorkspaceRead] = useState(false)
  const [taskHandoff, setTaskHandoff] = useState(false)
  const { pairing, pairingBusy, createPairing } = useRemotePairing(projectId, setError, workspaceRead, taskHandoff)
  const loopbackOnly = Boolean(snapshot?.webhook?.running && isLoopbackListener(snapshot.webhook.host))

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
          <p>{localized('任务状态和审批使用控制通道；文件读取与任务移交需要分别开启权限。', 'The control channel carries task status and approvals. File access and task handoff require separate permissions.')}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-icon-sm" aria-label={localized('刷新远程状态', 'Refresh remote status')} title={localized('刷新远程状态', 'Refresh remote status')} disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} className={busy ? 'remote-spin' : undefined} aria-hidden="true" /></button>
      </header>
      {error && <p className="remote-continuation-error" role="alert">{error}</p>}
      <div className="remote-continuation-toolbar">
        <span className={`remote-connectivity remote-connectivity-${snapshot?.connectivity ?? 'offline'}`}><span aria-hidden="true" />{snapshot?.connectivity === 'online' ? localized('控制通道在线', 'Control channel online') : localized('桌面离线，命令仅排队', 'Desktop offline; commands are queued')}</span>
        <span className="remote-webhook-status" title={localized('远程连接接收地址', 'Remote connection address')}>{snapshot?.webhook?.running ? `${snapshot.webhook.protocol ?? 'http'}://${snapshot.webhook.host}:${snapshot.webhook.port}` : localized('远程连接未启动', 'Remote connection is not running')}</span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !snapshot} onClick={() => void run(() => window.agentDesk.setRemoteConnectivity(snapshot?.connectivity === 'online' ? 'offline' : 'online'))}>{snapshot?.connectivity === 'online' ? localized('暂停接收操作', 'Pause incoming actions') : localized('恢复接收操作', 'Resume incoming actions')}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || snapshot?.connectivity !== 'online'} onClick={() => void run(() => window.agentDesk.reconcileRemoteQueue())}>{localized('对账队列', 'Reconcile queue')}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || pairingBusy || !projectId || !snapshot?.webhook?.running} onClick={() => void createPairing()}><Link2 size={13} aria-hidden="true" />{pairingBusy ? localized('正在生成…', 'Creating…') : localized('生成设备配对链接', 'Create device pairing link')}</button>
      </div>
      <label className="remote-muted"><input type="checkbox" checked={workspaceRead} disabled={pairingBusy} onChange={event => setWorkspaceRead(event.target.checked)} />{localized('本次配对允许读取任务文件与 Git 差异（默认关闭）', 'Allow task files and Git diffs for this pairing (off by default)')}</label>
      <label className="remote-muted"><input type="checkbox" data-remote-pairing-task-handoff checked={taskHandoff} disabled={pairingBusy} onChange={event => setTaskHandoff(event.target.checked)} />{localized('本次配对允许任务移交：接收原任务、上下文与关联项目文件，可来自其他项目；仅写入本机预授权目录（默认关闭）', 'Allow task handoff: receive original tasks, context and related project files, including other projects, into locally authorized directories only (off by default)')}</label>
      {showConnectionSettings && <details className="remote-continuation-bind"><summary>{localized('电脑连接设置', 'Connection settings')}</summary><RemoteConnectionForm onApplied={() => void refresh()} /></details>}
      {!projectId && <p className="remote-muted">{localized('先打开一个项目，再为该项目生成手机配对链接。', 'Open a project before creating its mobile pairing link.')}</p>}
      {loopbackOnly && <p className="notice notice-info">{localized('当前地址仅能在这台电脑访问。手机需要可达的 HTTPS 地址；复制本机链接不能直接连接手机。', 'This address is only reachable on this computer. A phone needs a reachable HTTPS address; copying a loopback link does not connect a phone.')}</p>}
        {pairing && <div className="remote-pairing-card"><strong>{pairing.copied ? localized('配对链接已复制', 'Pairing link copied') : localized('配对链接已生成，请复制下面的地址', 'Pairing link ready. Copy the address below.')}</strong><a href={pairing.url} target="_blank" rel="noreferrer">{pairing.url}</a><small>{localized('一次性链接，有效期至', 'Single-use link; expires at')} {formatPairingExpiry(pairing.expiresAt, language)}</small><small>{localized('电脑与 EastGenesis 需要保持运行；设备绑定可在下面撤销。', 'Keep the computer and EastGenesis running. Revoke paired devices below.')}</small></div>}
      <details className="remote-continuation-bind">
        <summary><ShieldCheck size={14} aria-hidden="true" />{localized('高级：手动绑定设备公钥', 'Advanced: bind a device public key manually')}</summary>
        <div className="remote-continuation-fields">
          <input className="input" value={label} onChange={(event) => setLabel(event.target.value)} placeholder={localized('设备名称', 'Device name')} aria-label={localized('设备名称', 'Device name')} />
          <input className="input" value={userId} onChange={(event) => setUserId(event.target.value)} placeholder={localized('用户标识', 'User ID')} aria-label={localized('用户标识', 'User ID')} />
          <input className="input remote-public-key" value={publicKey} onChange={(event) => setPublicKey(event.target.value)} placeholder="Ed25519 SPKI DER Base64" aria-label={localized('设备公钥', 'Device public key')} />
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !label.trim() || !userId.trim() || !publicKey.trim()} onClick={() => void run(async () => { await window.agentDesk.registerRemoteDevice({ label, userId, publicKey, capabilities: DEFAULT_CAPABILITIES }); setPublicKey('') })}>{localized('绑定', 'Bind')}</button>
        </div>
      </details>
      <div className="remote-device-list">
        {activeDevices.length === 0 ? <span className="remote-muted">{localized('暂无绑定设备', 'No bound devices')}</span> : activeDevices.map((device) => (
          <div key={device.id} className="remote-device-row">
            <span><LockKeyhole size={14} aria-hidden="true" /><strong>{device.label}</strong><small>{device.publicKeyFingerprint.slice(0, 24)}...</small></span>
            <div className="remote-device-actions">
              <details className="remote-capability-editor">
                <summary>{localized('权限', 'Permissions')}</summary>
                <div className="remote-capability-options">
                  {(['view_results', 'resume_work_item', 'create_task', 'control_work_item', 'approve_effect', 'trigger_routine', 'remote_runner', 'workspace_read', 'task_handoff'] as RemoteDeviceCapability[]).map((capability) => {
                    const selected = editingCapabilities[device.id] ?? device.capabilities
                    return <label key={capability}><input type="checkbox" checked={selected.includes(capability)} onChange={() => toggleCapability(device.id, capability)} />{capability === 'task_handoff' ? localized('任务移交（接收任务及项目文件）', 'Task handoff (receive tasks and project files)') : capability}</label>
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
  setError: React.Dispatch<React.SetStateAction<string>>,
  workspaceRead: boolean,
  taskHandoff: boolean
): { pairing: { url: string; expiresAt: number; copied: boolean } | null; pairingBusy: boolean; createPairing: () => Promise<void> } {
  const [pairing, setPairing] = useState<{ url: string; expiresAt: number; copied: boolean } | null>(null)
  const [pairingBusy, setPairingBusy] = useState(false)
  useEffect(() => { setPairing(null) }, [projectId, workspaceRead, taskHandoff])
  const createPairing = useCallback(async (): Promise<void> => {
    if (pairingBusy || !projectId) return
    setPairingBusy(true)
    setError('')
    try {
      const next = await window.agentDesk.createRemotePairingSession({ ttlMs: 5 * 60_000, projectId, workspaceRead, taskHandoff })
      let copied = false
      try { await navigator.clipboard.writeText(next.url); copied = true } catch { /* The link remains selectable when the clipboard is unavailable. */ }
      setPairing({ ...next, copied })
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setPairingBusy(false) }
  }, [pairingBusy, projectId, setError, workspaceRead, taskHandoff])
  return { pairing, pairingBusy, createPairing }
}

function isLoopbackListener(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.')
}

function formatPairingExpiry(expiresAt: number, language: 'zh' | 'en'): string {
  return new Date(expiresAt).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US')
}

function localized(chinese: string, english: string): string {
  return useStore.getState().settings.language === 'en' ? english : chinese
}
