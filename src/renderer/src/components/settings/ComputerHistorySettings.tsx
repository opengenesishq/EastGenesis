import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComputerHistoryPolicyInput, ComputerHistorySource, ComputerHistoryState } from '../../../../shared/computer-history-types'
import { useStore } from '../../store'
import { historyApi, historyError, historyStatus } from '../../pages/ComputerHistory/common'
import '../../pages/ComputerHistory/computer-history.css'

export default function ComputerHistorySettings({ onOpenHistory }: { onOpenHistory?: () => void }): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [state, setState] = useState<ComputerHistoryState | null>(null)
  const [draft, setDraft] = useState<ComputerHistoryPolicyInput | null>(null)
  const [sources, setSources] = useState<ComputerHistorySource[]>([])
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(''), [error, setError] = useState('')
  const mounted = useRef(true), request = useRef(0)
  const apply = useCallback((value: ComputerHistoryState): void => {
    setState(value); setDraft({ expectedRevision: value.policy.revision, enabled: value.policy.enabled, paused: value.policy.paused,
      allowedBundleIds: value.policy.allowedApps.map(source => source.bundleId), retentionDays: value.policy.retentionDays }); setConsent(false)
  }, [])
  const refresh = useCallback(async (): Promise<void> => {
    const id = ++request.current; setBusy(true); setError('')
    try { const value = await historyApi().getComputerHistoryState(); if (mounted.current && id === request.current) apply(value) }
    catch (failure) { if (mounted.current && id === request.current) setError(historyError(failure, zh)) }
    finally { if (mounted.current && id === request.current) setBusy(false) }
  }, [apply, zh])
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; request.current++ } }, [refresh])
  useEffect(() => {
    const interval = setInterval(() => { void historyApi().getComputerHistoryState().then(value => { if (mounted.current) setState(value) }).catch(() => undefined) }, 15_000)
    return () => clearInterval(interval)
  }, [])
  const sourceList = [...new Map([...(state?.policy.allowedApps ?? []), ...sources].map(source => [source.bundleId, source as ComputerHistorySource])).values()]
  const unsupported = state?.status === 'unsupported' || state?.status === 'temporary'
  const changed = draft && state && (draft.enabled !== state.policy.enabled || draft.paused !== state.policy.paused || draft.retentionDays !== state.policy.retentionDays ||
    [...draft.allowedBundleIds].sort().join('|') !== state.policy.allowedApps.map(source => source.bundleId).sort().join('|'))
  const needsConsent = draft && state && ((draft.enabled && !state.policy.enabled) || draft.allowedBundleIds.some(id => !state.policy.allowedApps.some(source => source.bundleId === id)))
  const edit = (patch: Partial<ComputerHistoryPolicyInput>): void => { setDraft(value => value ? { ...value, ...patch } : value); setConsent(false); setNotice(''); setError('') }
  const listSources = async (): Promise<void> => {
    setBusy(true); setError(''); setNotice('')
    try { const value = await historyApi().listComputerHistorySources(); if (mounted.current) { setSources(value); setNotice(zh ? '已列出正在运行的应用。仅此操作不会读取窗口标题。' : 'Running apps listed. This action does not read window titles.') } }
    catch (failure) { if (mounted.current) setError(historyError(failure, zh)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const save = async (input: ComputerHistoryPolicyInput): Promise<void> => {
    setBusy(true); setError(''); setNotice('')
    try {
      const value = await historyApi().updateComputerHistoryPolicy(input)
      if (mounted.current) { apply(value); setNotice(zh ? '设置已保存。关闭或暂停不会删除已有记录。' : 'Settings saved. Turning off or pausing keeps existing records.') }
    } catch (failure) { if (mounted.current) setError(historyError(failure, zh)) }
    finally { if (mounted.current) setBusy(false) }
  }
  return <section className="computer-history-settings" aria-label={zh ? '电脑历史权限' : 'Computer history permissions'}>
    <header className="history-heading"><div><h3>{zh ? '电脑历史' : 'Computer history'}</h3><p className="settings-hint">{zh ? '默认关闭。开启后，每 15 秒检查前台应用，仅记录你允许的应用的窗口标题。' : 'Off by default. When enabled, checks the foreground app every 15 seconds and records window titles only for apps you allow.'}</p></div></header>
    {state && <p className="history-status" role="status">{historyStatus(state.status, zh)} · {state.recordCount} {zh ? '条记录' : 'records'}</p>}
    <p className="settings-hint">{zh ? '记录保存在本机，不会自动上传模型。不读取窗口正文、截图、麦克风或系统音频。浏览器记录在「浏览器」设置中单独开启；可在历史页选择标题线索加入任务草稿，核对后自行发送。' : 'Records stay on this computer and are never automatically sent to models. No window body text, screenshots, microphone or system audio is collected. Enable browser history separately in Browser settings. In History, select title clues to add to a task draft, then review and send it yourself.'}</p>
    {unsupported && <p className="history-boundary">{state?.status === 'temporary' ? (zh ? '临时工作空间不提供后台历史采集。' : 'Background history is unavailable in a temporary workspace.') : (zh ? 'Windows 和 Linux 暂不提供采集；可继续查看和删除本地已有记录。' : 'Collection is not available on Windows or Linux. Existing local records can still be viewed and deleted.')}</p>}
    {state?.status === 'permission-required' && <p className="history-boundary">{zh ? '前往 macOS「系统设置 → 隐私与安全性 → 辅助功能」允许 EastGenesis。随后切换到已允许应用，系统会自动重试。' : 'Allow EastGenesis in macOS System Settings → Privacy & Security → Accessibility, then bring an allowed app to the foreground. Collection retries automatically.'}</p>}
    {state?.error && <p className="notice notice-error" role="alert">{state.error}</p>}
    {draft && <>
      <label className="history-toggle"><input type="checkbox" checked={draft.enabled} disabled={busy || unsupported} onChange={event => edit({ enabled: event.target.checked, paused: false })} />{zh ? '启用电脑历史' : 'Enable computer history'}</label>
      <fieldset className="history-source-fieldset" disabled={busy || unsupported}>
        <legend>{zh ? '允许记录的应用' : 'Allowed apps'}</legend>
        <p className="settings-hint">{zh ? '先打开要添加的应用，再刷新来源。未选择的应用不会读取标题；取消来源后停止新记录，已有记录可在历史页删除。' : 'Open an app, then refresh sources to add it. Titles from unselected apps are not read. Removing a source stops new records; existing records can be deleted in History.'}</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void listSources()}>{zh ? '刷新正在运行的应用' : 'Refresh running apps'}</button>
        <div className="history-source-list">{sourceList.map(source => <label className="history-source" key={source.bundleId}>
          <input type="checkbox" disabled={Boolean(source.excludedReason)} checked={draft.allowedBundleIds.includes(source.bundleId)}
            onChange={event => edit({ allowedBundleIds: event.target.checked ? [...draft.allowedBundleIds, source.bundleId] : draft.allowedBundleIds.filter(id => id !== source.bundleId) })} />
          <span>{source.name}<small>{source.bundleId}{source.excludedReason ? ` · ${zh ? '此来源不采集' : 'Excluded'}` : ''}</small></span>
        </label>)}</div>
        {!sourceList.length && <p className="settings-hint">{zh ? '尚未选择来源。刷新应用列表后勾选允许记录的应用。' : 'No sources selected. Refresh the app list, then choose the apps you allow.'}</p>}
      </fieldset>
      <label className="history-retention">{zh ? '保留时长' : 'Keep records for'}<select className="input" value={draft.retentionDays} disabled={busy} onChange={event => edit({ retentionDays: Number(event.target.value) as 7 | 30 | 90 })}>
        {[7, 30, 90].map(days => <option key={days} value={days}>{days} {zh ? '天' : 'days'}</option>)}</select></label>
      <p className="settings-hint">{zh ? '最多保留 5,000 条。缩短保留时长并保存，会立即删除超期记录。相同标题在五分钟内合并记录。' : 'Up to 5,000 records. Saving a shorter retention period immediately removes expired records. Repeated identical titles are recorded at most once every five minutes.'}</p>
      {needsConsent && <label className="history-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />{zh ? '我允许 EastGenesis 仅记录上述所选应用的前台窗口标题。' : 'I allow EastGenesis to record foreground window titles only from the selected apps.'}</label>}
      <div className="history-actions"><button type="button" className="btn btn-primary" disabled={busy || !changed || Boolean(needsConsent && !consent) || Boolean(draft.enabled && !draft.allowedBundleIds.length)}
        onClick={() => void save({ ...draft, ...(consent ? { consent: true } : {}) })}>{zh ? '保存设置' : 'Save settings'}</button>
        {state?.policy.enabled && <button type="button" className="btn btn-secondary" disabled={busy || Boolean(changed)} onClick={() => void save({ expectedRevision: state.policy.revision, enabled: true, paused: !state.policy.paused,
          allowedBundleIds: state.policy.allowedApps.map(source => source.bundleId), retentionDays: state.policy.retentionDays })}>{state.policy.paused ? (zh ? '恢复记录' : 'Resume') : (zh ? '暂停记录' : 'Pause')}</button>}
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void refresh()}>{zh ? '重新读取设置' : 'Reload settings'}</button>
        {onOpenHistory && <button type="button" className="btn btn-ghost" onClick={onOpenHistory}>{zh ? '查看与删除历史' : 'View and delete history'}</button>}</div>
    </>}
    {!state && !busy && <button type="button" className="btn btn-secondary" onClick={() => void refresh()}>{zh ? '重试' : 'Retry'}</button>}
    {busy && <p role="status">{zh ? '处理中…首次读取应用列表可能需要准备系统辅助程序。' : 'Working… Preparing the system helper may take a moment on the first request.'}</p>}
    {notice && <p className="history-notice" role="status">{notice}</p>}{error && <p className="notice notice-error" role="alert">{error}</p>}
  </section>
}
