import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../../store'
import type { RemoteHostApi, RemoteHostCommandKind, RemoteHostPairingPreview, RemoteHostTask, RemoteHostTasks, RemoteHostView } from '../../../../shared/remote-host-types'
import './remote-hosts.css'
import type { RemoteSshTunnelView } from '../../../../shared/ssh-types'
import RemoteSshTunnelPanel from './RemoteSshTunnelPanel'
import RemoteWorkspacePanel from './RemoteWorkspacePanel'
import TaskHandoffDestinations from './TaskHandoffDestinations'
import { useRemoteHostSettingsNavigation } from '../../store/remote-task-navigation'
import { sameRemoteTarget } from '../experience/welcome-remote-target'

const api = (): RemoteHostApi => window.agentDesk as typeof window.agentDesk & RemoteHostApi
export default function RemoteHostsSettings(): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [hosts, setHosts] = useState<RemoteHostView[]>([]), [secure, setSecure] = useState(false)
  const [selected, setSelected] = useState(''), [tasks, setTasks] = useState<RemoteHostTasks>()
  const [pairingUrl, setPairingUrl] = useState(''), [label, setLabel] = useState(''), [deviceLabel, setDeviceLabel] = useState('EastGenesis desktop')
  const [preview, setPreview] = useState<RemoteHostPairingPreview>(), [confirmed, setConfirmed] = useState(false)
  const [storage, setStorage] = useState<'encrypted' | 'session'>('encrypted')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [appendTask, setAppendTask] = useState(''), [appendText, setAppendText] = useState('')
  const [useSsh, setUseSsh] = useState(false), [tunnelId, setTunnelId] = useState(''), [tunnels, setTunnels] = useState<RemoteSshTunnelView[]>([])
  const [workspaceTask, setWorkspaceTask] = useState(''), [newObjective, setNewObjective] = useState('')
  const requestedHost = useRemoteHostSettingsNavigation(state => state.target)
  useEffect(() => {
    if (!requestedHost || !hosts.length) return
    const original = hosts.find(item => sameRemoteTarget(requestedHost, item))
    if (original) { setSelected(original.id); setTasks(undefined); setNotice(zh ? '已定位原配对项目。点击“读取远端任务”查看项目列表；不会按标题猜测原任务。' : 'Original paired project selected. Read its task list; no task is guessed by title.') }
    else setError(zh ? '原配对项目连接已移除或身份发生变化。' : 'Original project connection missing or changed.')
    useRemoteHostSettingsNavigation.getState().clear()
  }, [requestedHost, hosts, zh])
  const refresh = useCallback(async () => {
    const state = await api().listRemoteHosts(); setHosts(state.hosts); setSecure(state.secureStorageAvailable)
  }, [])
  useEffect(() => { void refresh().catch(cause => setError(String(cause))) }, [refresh])
  const act = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(''); setNotice('')
    try { await operation(); await refresh() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); await refresh().catch(() => {}) }
    finally { setBusy(false) }
  }
  const host = hosts.find(item => item.id === selected)
  const tunnelReady = tunnels.some(item => item.id === tunnelId && item.state === 'ready')
  const connectionReady = !host?.ssh || tunnels.some(item => item.state === 'ready' && item.binding.sshHostId === host.ssh!.sshHostId && item.binding.sshHostRevision === host.ssh!.sshHostRevision && item.binding.sshConfigDigest === host.ssh!.sshConfigDigest && item.binding.httpsOrigin === host.identity.origin)
  const status = (value: string): string => ({ paired: zh ? '已配对' : 'Paired', expired: zh ? '连接已过期' : 'Expired',
    pairing_unknown: zh ? '配对结果待核对' : 'Pairing unconfirmed', revocation_unknown: zh ? '撤销结果待核对' : 'Revocation unconfirmed', revoked: zh ? '已撤销' : 'Revoked',
    unknown: zh ? '结果未知，请核对' : 'Unknown: check receipt', not_received: zh ? '远端未找到此命令' : 'Command not found',
    received: zh ? '已接收' : 'Received', sending: zh ? '发送中' : 'Sending', succeeded: zh ? '已完成' : 'Succeeded', failed: zh ? '失败' : 'Failed',
    pending: zh ? '待执行' : 'Pending', offline: zh ? '等待远端上线' : 'Waiting for host', running: zh ? '运行中' : 'Running',
    paused: zh ? '已暂停' : 'Paused', cancelled: zh ? '已取消' : 'Cancelled', rejected: zh ? '已拒绝' : 'Rejected', approved: zh ? '已批准' : 'Approved', applied: zh ? '已应用' : 'Applied', accepted: zh ? '已受理' : 'Accepted' }[value] ?? value)
  const loadTasks = async (id: string): Promise<void> => { setSelected(id); setTasks(undefined); setAppendTask(''); setTasks(await api().readRemoteHostTasks(id)) }
  const command = (kind: RemoteHostCommandKind, task: RemoteHostTask, instruction?: string): void => {
    if (!host || !tasks) return
    const hostId = host.id
    void act(async () => {
      const result = await api().sendRemoteHostCommand({ hostId, kind, workItemId: task.id, expectedRevision: task.revision,
        requestId: crypto.randomUUID(), ...(kind === 'append_task' ? { text: instruction ?? appendText } : {}) })
      setNotice(status(result.execution?.status ?? result.status ?? result.state))
      if (kind === 'append_task') { setAppendTask(''); setAppendText('') }
      try { setTasks(await api().readRemoteHostTasks(hostId)) } catch { /* The receipt remains visible even when the refresh fails. */ }
    })
  }
  return <section className="remote-hosts-settings" aria-label={zh ? '控制其他主机' : 'Control other hosts'}>
    <h3>{zh ? '控制其他主机' : 'Control other hosts'}</h3>
    <p>{zh ? '连接另一台正在运行 EastGenesis 的电脑，查看配对项目的任务并继续工作。也可在当前任务的 Worktree 面板中，单独准备并确认跨电脑移交。' : 'Connect to another computer running EastGenesis to read and continue its paired project tasks. Prepare and confirm a separate task handoff from the current task’s Worktree panel.'}</p>
    <TaskHandoffDestinations />
    {!secure && <p className="notice notice-warning">{zh ? '系统凭据加密不可用。可主动选择“仅本次运行”连接；持久连接需要系统加密可用的受信任应用。' : 'System credential encryption is unavailable. You can explicitly choose session-only access; persistent connections need a trusted application with secure storage.'}</p>}
    <fieldset disabled={busy} className="remote-hosts-pairing">
      <legend>{zh ? '添加远端主机' : 'Add a remote host'}</legend>
      <p className="settings-hint">{zh ? '先在远端的“连接这台电脑”中选择项目并生成 HTTPS 配对链接。控制操作限定该项目；跨电脑移交另需开启任务移交权限及接收目录。连接到期后可沿用原设备身份续期。' : 'Generate an HTTPS pairing link for a project on the receiver. Control actions are limited to that project; task handoff needs separate permission and a receiving directory. Renew an expired connection using its original device identity.'}</p>
      <label>{zh ? '配对链接' : 'Pairing link'}<input className="input" type="password" autoComplete="off" value={pairingUrl} placeholder="https://host.example/remote/pair/…" onChange={event => { setPairingUrl(event.target.value); setPreview(undefined); setConfirmed(false) }} /></label>
      <label><input type="checkbox" checked={useSsh} onChange={event => { setUseSsh(event.target.checked); setPreview(undefined); setConfirmed(false); setTunnelId('') }} />{zh ? '通过已配置的 SSH 主机连接' : 'Connect through a configured SSH host'}</label>
      <label>{zh ? '主机名称' : 'Host name'}<input className="input" value={label} maxLength={120} onChange={event => setLabel(event.target.value)} /></label>
      <label>{zh ? '本机在远端的设备名称' : 'This device name on the host'}<input className="input" value={deviceLabel} maxLength={120} onChange={event => setDeviceLabel(event.target.value)} /></label>
      <label>{zh ? '凭据保存方式' : 'Credential storage'}<select className="select" value={storage} onChange={event => { setStorage(event.target.value as 'encrypted' | 'session'); setConfirmed(false) }}><option value="encrypted" disabled={!secure}>{zh ? '系统加密保存' : 'System-encrypted storage'}</option><option value="session">{zh ? '仅本次运行（内存）' : 'This app session only (memory)'}</option></select></label>
      {storage === 'session' && <p className="settings-hint">{zh ? '此连接的私钥、控制凭据及命令只保存在本次主进程内存，退出后无法恢复。远端授权不会随本机退出而自动撤销；结束前可点“撤销此配对”，或在远端设备列表撤销。' : 'Keys, control credentials and commands stay in memory and cannot be restored after app exit. Remote authorization is not automatically revoked on exit; revoke it here or on the host.'}</p>}
      <button className="btn btn-ghost btn-sm" disabled={useSsh && !tunnelReady || storage === 'encrypted' && !secure || !pairingUrl.trim() || !label.trim() || !deviceLabel.trim()} onClick={() => void act(async () => { setConfirmed(false); setPreview(await api().inspectRemoteHostPairing(pairingUrl, useSsh ? tunnelId : undefined)) })}>{zh ? '检查服务器身份' : 'Inspect server identity'}</button>
      {preview && <div className="remote-hosts-identity">
        <strong>{preview.identity.origin}</strong><span>{zh ? '证书名称' : 'Certificate'}：{preview.identity.commonName || '—'}</span>
        <span>{zh ? '签发者' : 'Issuer'}：{preview.identity.issuer || '—'}</span><span>{zh ? '证书到期' : 'Certificate expires'}：{preview.identity.validTo}</span>
        <code>{preview.identity.spkiFingerprint}</code>
        <p className="settings-hint">{zh ? '请核对主机地址与服务器证书指纹。确认后固定此身份；服务器密钥变化会停止连接，需要重新核验。' : 'Review the host address and server certificate fingerprint. This key will be pinned; a key change requires a new review.'}</p>
        <label className="remote-hosts-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{zh ? '我已核对服务器身份，确认配对此主机' : 'I reviewed this server identity and want to pair this host'}</label>
        <button className="btn btn-primary btn-sm" disabled={storage === 'encrypted' && !secure || !confirmed || !label.trim() || !deviceLabel.trim()} onClick={() => void act(async () => {
          const result = await api().pairRemoteHost({ previewId: preview.id, confirmedSpkiFingerprint: preview.identity.spkiFingerprint, label, deviceLabel, storage })
          setSelected(result.id); setPreview(undefined); setConfirmed(false); setPairingUrl(''); setNotice(status(result.status))
        })}>{zh ? '确认并配对' : 'Confirm and pair'}</button>
      </div>}
    </fieldset>
    <RemoteSshTunnelPanel pairingUrl={pairingUrl} enabled={useSsh} selectedId={tunnelId} onSelect={id => { setTunnelId(id); setPreview(undefined); setConfirmed(false) }} onTunnels={setTunnels} zh={zh} />
    <div className="remote-hosts-heading"><h4>{zh ? '已添加的主机' : 'Saved hosts'}</h4><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(refresh)}>{zh ? '刷新列表' : 'Refresh list'}</button></div>
    {!hosts.length && <p className="settings-hint">{zh ? '尚未添加远端主机。' : 'No remote hosts added.'}</p>}
    <div className="remote-hosts-list">{hosts.map(item => <button type="button" disabled={busy} aria-pressed={selected === item.id} key={item.id} onClick={() => { setSelected(item.id); setTasks(undefined); setAppendTask(''); setWorkspaceTask(''); setNewObjective('') }}><strong>{item.label}</strong><span>{item.identity.origin}</span><small>{status(item.status)}{item.projectName ? ` · ${item.projectName}` : ''}</small></button>)}</div>
    {host && <section className="remote-hosts-detail">
      <h4>{host.label}</h4><p>{host.identity.origin} · {status(host.status)} · {host.storage === 'session' ? zh ? '仅本次运行' : 'Session only' : zh ? '系统加密保存' : 'System encrypted'}</p>
      <code>{host.identity.spkiFingerprint}</code>
      {host.ssh && <p className="settings-hint">SSH · {connectionReady ? zh ? '隧道已连接' : 'Tunnel connected' : zh ? '隧道未连接，任务操作已禁用' : 'Tunnel disconnected; task actions are disabled'} {!connectionReady && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(async () => { await api().startRemoteHostSshTunnel({ hostId: host.id, sshHostId: host.ssh!.sshHostId, sshHostRevision: host.ssh!.sshHostRevision }); setTunnels(await api().listRemoteSshTunnels()) })}>{zh ? '重新连接原 SSH 主机' : 'Reconnect original SSH host'}</button>}</p>}
      {host.projectId && <p className="settings-hint">{zh ? '配对项目' : 'Paired project'}：{host.projectName ?? host.projectId}{host.expiresAt ? ` · ${zh ? '连接到期' : 'Expires'} ${new Date(host.expiresAt).toLocaleString()}` : ''}</p>}
      {host.error && <p className="notice notice-warning">{host.error}</p>}
      {(host.status === 'expired' || host.renewal) && <p className="settings-hint">{zh ? '续期连接保留原设备、项目与密钥，有效期为 24 小时；以远端当前授权为准。续期不会继续任务或恢复已撤销权限。' : 'Renewal keeps the same device, project and key for 24 hours, using current host permissions. It does not resume tasks or restore revoked permissions.'}</p>}
      <div className="remote-hosts-actions">
        {(host.status === 'expired' || host.renewal) && <button className="btn btn-primary btn-sm" disabled={busy || !connectionReady || host.storage !== 'session' && !secure || !host.deviceId || !['paired', 'expired'].includes(host.status)} onClick={() => void act(async () => {
          const result = await api().renewRemoteHost(host.id); setTasks(undefined); setNotice(result.error || (result.status === 'paired' ? zh ? '原连接已续期 24 小时。' : 'Original connection renewed for 24 hours.' : status(result.status)))
        })}>{host.renewal ? zh ? '核对原续期请求' : 'Check original renewal' : zh ? '续期连接' : 'Renew connection'}</button>}
        <button className="btn btn-primary btn-sm" disabled={busy || !connectionReady || host.storage !== 'session' && !secure || host.status !== 'paired' || Boolean(host.renewal)} onClick={() => void act(() => loadTasks(host.id))}>{zh ? '读取远端任务' : 'Read remote tasks'}</button>
        <button className="btn btn-ghost btn-sm" disabled={busy || !connectionReady || host.storage !== 'session' && !secure || !host.deviceId || Boolean(host.renewal) || ['pairing_unknown', 'revoked'].includes(host.status)} onClick={() => void act(async () => { const result = await api().revokeRemoteHost(host.id); setTasks(undefined); setNotice(status(result.status)) })}>{zh ? '撤销此配对' : 'Revoke pairing'}</button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(async () => { await api().forgetRemoteHost(host.id); setSelected(''); setTasks(undefined) })}>{zh ? '仅移除本地记录' : 'Remove local record only'}</button>
      </div><p className="settings-hint">{zh ? '移除本地记录不会撤销远端授权。若撤销结果未确认，请在远端“已连接设备”中处理。' : 'Removing the local record does not revoke remote authorization. Confirm unresolved revocations in the host device list.'}</p>
      {connectionReady && tasks?.hostId === host.id && <div className="remote-hosts-tasks"><h4>{tasks.projectName}</h4>
        {tasks.capabilities.includes('create_task') && <form className="remote-host-create" onSubmit={event => { event.preventDefault(); void act(async () => {
          const result = await api().sendRemoteHostCommand({ hostId: host.id, kind: 'create_task', expectedRevision: tasks.projectRevision, text: newObjective, requestId: crypto.randomUUID() })
          setNotice(status(result.execution?.status ?? result.state)); setNewObjective(''); setTasks(await api().readRemoteHostTasks(host.id))
        }) }}><textarea className="input" value={newObjective} maxLength={20000} disabled={busy} aria-label={zh ? '在远端新建任务' : 'Create a task on the host'} placeholder={zh ? '一句话在此远端项目开始工作…' : 'Start work in this remote project…'} onChange={event => setNewObjective(event.target.value)} /><small>{zh ? '使用远端已配置的模型、路由和权限。' : 'Uses models, routing and permissions configured on the host.'}</small><button disabled={busy || !newObjective.trim()}>{zh ? '在远端新建任务' : 'Create remote task'}</button></form>}
        {tasks.capabilities.includes('trigger_routine') && tasks.routines.length > 0 && <section><h4>{zh ? '远端计划任务' : 'Remote routines'}</h4>{tasks.routines.map(routine => <article key={routine.id}><strong>{routine.name}</strong><button disabled={busy} onClick={() => void act(async () => {
          const result = await api().sendRemoteHostCommand({ hostId: host.id, kind: 'trigger_routine', routineId: routine.id, expectedRevision: tasks.projectRevision, requestId: crypto.randomUUID() })
          setNotice(status(result.execution?.status ?? result.state)); setTasks(await api().readRemoteHostTasks(host.id))
        })}>{zh ? '按远端配置运行一次' : 'Run once with host configuration'}</button></article>)}</section>}
        {tasks.capabilities.includes('approve_effect') && <section><h4>{zh ? '远端待审批' : 'Remote approvals'}</h4>
          {tasks.approvalCandidates.map(candidate => <article key={`${candidate.sessionId}:${candidate.permissionRequestId}`} className="remote-host-approval"><pre>{candidate.summary}</pre><code>{candidate.targetDigest}</code><button disabled={busy || host.commands.some(item => item.kind === 'approve_effect' && item.workItemId === candidate.workItemId && item.execution?.status === 'running')} onClick={() => void act(async () => {
            await api().sendRemoteHostCommand({ hostId: host.id, kind: 'approve_effect', workItemId: candidate.workItemId, expectedRevision: candidate.revision, approvalCandidate: candidate, requestId: crypto.randomUUID() })
            setTasks(await api().readRemoteHostTasks(host.id))
          })}>{zh ? '审阅此操作' : 'Review this operation'}</button></article>)}
          {tasks.approvals.map(item => <article key={item.id} className="remote-host-approval"><strong>{item.action}</strong><pre>{item.summary || item.targetDigest}</pre><small>{zh ? '有效期至' : 'Expires'} {new Date(item.expiresAt).toLocaleString()}</small><code>{item.targetDigest}</code>{(['approve', 'reject'] as const).map(decision => <button key={decision} disabled={busy || item.expiresAt <= Date.now() || host.decisions?.some(receipt => receipt.approvalId === item.id && (receipt.state !== 'received' || receipt.approval?.status === 'pending'))} onClick={() => void act(async () => {
            const result = await api().decideRemoteHostApproval({ hostId: host.id, approvalId: item.id, expectedRevision: item.recordRevision, approvalDigest: item.approvalDigest, decision, requestId: crypto.randomUUID() })
            setNotice(result.error || status(result.approval?.status ?? result.state)); setTasks(await api().readRemoteHostTasks(host.id))
          })}>{decision === 'approve' ? zh ? '批准此版本' : 'Approve this version' : zh ? '拒绝' : 'Reject'}</button>)}</article>)}
          {!tasks.approvalCandidates.length && !tasks.approvals.length && <p>{zh ? '当前没有待审批操作。' : 'No operations awaiting approval.'}</p>}
        </section>}
        {!tasks.capabilities.includes('workspace_read') && <p>{zh ? '文件查看尚未授权。可在远端“已连接设备 → 权限”开启 workspace_read，或重新生成明确允许文件读取的配对链接。' : 'File access is not authorized. Enable workspace_read in the host device permissions or create a pairing link allowing file access.'}</p>}

        {!tasks.workItems.length && <p>{zh ? '此项目尚无工作任务。' : 'This project has no work items.'}</p>}
        {tasks.workItems.map(task => { const pending = host.commands.some(item => item.workItemId === task.id && (['unknown', 'sending'].includes(item.state) || item.state === 'received' && ['pending', 'offline'].includes(item.status ?? '') || item.execution?.status === 'running'))
          return <article key={task.id}><strong>{task.title}</strong><span>{status(task.status)}</span>
            {task.resumeReason && <small>{task.resumeReason}</small>}
            <div className="remote-hosts-actions">
              {tasks.capabilities.includes('workspace_read') && <button disabled={busy} onClick={() => setWorkspaceTask(task.id)}>{zh ? '打开原任务工作区' : 'Open original task workspace'}</button>}
              {task.canResume && tasks.capabilities.includes('resume_work_item') && <button disabled={busy || pending} onClick={() => command('resume_work_item', task)}>{zh ? '继续任务' : 'Resume'}</button>}
              {tasks.capabilities.includes('control_work_item') && <>
                {task.canAppend && <button disabled={busy || pending} onClick={() => { setAppendTask(task.id); setAppendText('') }}>{zh ? '追加要求' : 'Add instructions'}</button>}
                {task.canPause && <button disabled={busy || pending} onClick={() => command('pause_work_item', task)}>{zh ? '暂停' : 'Pause'}</button>}
                {task.canCancel && <button disabled={busy || pending} onClick={() => command('cancel_work_item', task)}>{zh ? '取消任务' : 'Cancel task'}</button>}
              </>}
            </div>
            {appendTask === task.id && <div><textarea className="input" aria-label={zh ? '给远端任务追加要求' : 'Instructions for remote task'} value={appendText} maxLength={200000} onChange={event => setAppendText(event.target.value)} /><button disabled={busy || pending || !appendText.trim()} onClick={() => command('append_task', task)}>{zh ? '发送要求' : 'Send instructions'}</button></div>}
          </article> })}
      </div>}
      {connectionReady && tasks?.hostId === host.id && tasks.capabilities.includes('workspace_read') && tasks.workItems.some(task => task.id === workspaceTask) && <RemoteWorkspacePanel key={`${host.id}:${workspaceTask}`} hostId={host.id} hostLabel={host.label} task={tasks.workItems.find(task => task.id === workspaceTask)!} zh={zh} busy={busy} onCommand={command} onClose={() => setWorkspaceTask('')} />}
      {!!host.decisions?.length && <section className="remote-host-decisions"><h4>{zh ? '审批决定回执' : 'Approval decision receipts'}</h4>{host.decisions.slice(-12).reverse().map(item => <article key={item.requestId}><span>{item.decision} · {status(item.approval?.status ?? item.state)}</span>{item.error && <small>{item.error}</small>}<button disabled={busy || !connectionReady || host.status !== 'paired'} onClick={() => void act(async () => {
        const result = await api().reconcileRemoteHostApproval(host.id, item.requestId); setNotice(result.error || status(result.approval?.status ?? result.state))
      })}>{zh ? '核对原审批决定' : 'Check original approval decision'}</button></article>)}</section>}
      {!!host.commands.length && <div className="remote-hosts-receipts"><h4>{zh ? '命令回执' : 'Command receipts'}</h4>{host.commands.slice(-12).reverse().map(item => <article key={item.commandId}><span>{status(item.execution?.status ?? item.status ?? item.state)}</span><code>{item.commandId}</code>{item.error && <small>{item.error}</small>}<button disabled={busy || !connectionReady || host.storage !== 'session' && !secure || host.status !== 'paired'} onClick={() => void act(async () => { const result = await api().reconcileRemoteHostCommand(host.id, item.commandId); setNotice(status(result.execution?.status ?? result.status ?? result.state)) })}>{zh ? '核对原命令结果' : 'Check original command'}</button></article>)}</div>}
    </section>}
    {error && <p className="notice notice-error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
  </section>
}
