import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComputerHistoryDeletionPreview, ComputerHistoryFilter, ComputerHistoryQueryResult, ComputerHistoryState } from '../../../../shared/computer-history-types'
import { useStore } from '../../store'
import ComputerHistorySettings from '../../components/settings/ComputerHistorySettings'
import HistoryQuestionPanel from './HistoryQuestionPanel'
import { historyApi, historyError, historyStatus } from './common'
import './computer-history.css'

export interface ComputerHistoryPageProps { onClose?: () => void }
const PAGE_SIZE = 50

export default function ComputerHistoryPage({ onClose }: ComputerHistoryPageProps): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [state, setState] = useState<ComputerHistoryState | null>(null), [result, setResult] = useState<ComputerHistoryQueryResult | null>(null)
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [source, setSource] = useState(''), [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ComputerHistoryFilter>({}), [offset, setOffset] = useState(0), [dirty, setDirty] = useState(false)
  const [preview, setPreview] = useState<ComputerHistoryDeletionPreview | null>(null), [deleteLabel, setDeleteLabel] = useState(''), [reviewed, setReviewed] = useState(false)
  const [showSettings, setShowSettings] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const mounted = useRef(true), request = useRef(0)
  const stamp = useCallback((value: number): string => new Date(value).toLocaleString(zh ? 'zh-CN' : 'en-US'), [zh])
  const load = useCallback(async (next: ComputerHistoryFilter, nextOffset = 0): Promise<void> => {
    const id = ++request.current; setBusy(true); setError(''); setPreview(null); setReviewed(false)
    try {
      const [nextState, nextResult] = await Promise.all([historyApi().getComputerHistoryState(), historyApi().queryComputerHistory({ ...next, offset: nextOffset, limit: PAGE_SIZE })])
      if (mounted.current && id === request.current) { setState(nextState); setResult(nextResult); setFilter(next); setOffset(nextOffset); setDirty(false) }
    } catch (failure) { if (mounted.current && id === request.current) setError(historyError(failure, zh)) }
    finally { if (mounted.current && id === request.current) setBusy(false) }
  }, [zh])
  useEffect(() => { mounted.current = true; void load({}); return () => { mounted.current = false; request.current++ } }, [load])
  const changeFilter = (): void => { setDirty(true); setPreview(null); setReviewed(false); setNotice(''); setError('') }
  const applyFilters = (): void => {
    const start = from ? new Date(from).getTime() : undefined, end = to ? new Date(to).getTime() : undefined
    if ((start !== undefined && !Number.isFinite(start)) || (end !== undefined && !Number.isFinite(end)) || (start !== undefined && end !== undefined && start > end)) {
      setError(zh ? '请选择有效的开始和结束时间。' : 'Choose a valid start and end time.'); return
    }
    void load({ ...(start !== undefined ? { from: start } : {}), ...(end !== undefined ? { to: end + 59_999 } : {}), ...(source ? { bundleId: source } : {}), ...(query.trim() ? { query: query.trim() } : {}) })
  }
  const previewDeletion = async (selection: ComputerHistoryFilter, label: string): Promise<void> => {
    setBusy(true); setError(''); setNotice(''); setPreview(null); setReviewed(false)
    try { const value = await historyApi().previewComputerHistoryDeletion(selection); if (mounted.current) { setPreview(value); setDeleteLabel(label) } }
    catch (failure) { if (mounted.current) setError(historyError(failure, zh)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const remove = async (): Promise<void> => {
    if (!preview || !reviewed) return
    setBusy(true); setError('')
    try {
      const value = await historyApi().deleteComputerHistory(preview.token, true)
      if (mounted.current) { setSelected([]); setPreview(null); setReviewed(false); setNotice(zh ? `已删除 ${value.deleted} 条记录。` : `Deleted ${value.deleted} records.`); await load(filter, 0) }
    } catch (failure) { if (mounted.current) setError(historyError(failure, zh)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const togglePause = async (): Promise<void> => {
    if (!state) return
    setBusy(true); setError('')
    try {
      const value = await historyApi().updateComputerHistoryPolicy({ expectedRevision: state.policy.revision, enabled: state.policy.enabled, paused: !state.policy.paused,
        allowedBundleIds: state.policy.allowedApps.map(item => item.bundleId), retentionDays: state.policy.retentionDays })
      if (mounted.current) setState(value)
    } catch (failure) { if (mounted.current) setError(historyError(failure, zh)) }
    finally { if (mounted.current) setBusy(false) }
  }
  if (showSettings) return <section className="computer-history-page"><div className="history-actions"><button className="btn btn-ghost" type="button" onClick={() => { setShowSettings(false); void load(filter, offset) }}>← {zh ? '返回历史' : 'Back to history'}</button></div>
    <ComputerHistorySettings onOpenHistory={() => { setShowSettings(false); void load(filter, 0) }} /></section>
  return <section className="computer-history-page" aria-label={zh ? '电脑历史时间线' : 'Computer history timeline'}>
    <header className="history-heading"><div><h2>{zh ? '电脑历史' : 'Computer history'}</h2><p>{zh ? '在这台电脑上，查看你允许记录的前台应用标题。' : 'Review foreground app titles you allowed this computer to record.'}</p></div>
      <div className="history-actions"><button className="btn btn-secondary" type="button" onClick={() => setShowSettings(true)}>{zh ? '来源与权限' : 'Sources & permissions'}</button>{onClose && <button className="btn btn-ghost" type="button" onClick={onClose}>{zh ? '关闭' : 'Close'}</button>}</div></header>
    <div className="history-state-bar"><span role="status">{state ? historyStatus(state.status, zh) : (zh ? '读取状态…' : 'Loading status…')}</span>
      {state?.policy.enabled && state.status !== 'unsupported' && state.status !== 'temporary' && <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => void togglePause()}>{state.policy.paused ? (zh ? '恢复记录' : 'Resume') : (zh ? '暂停记录' : 'Pause')}</button>}
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void load(filter, offset)}>{zh ? '刷新' : 'Refresh'}</button></div>
    <p className="settings-hint">{zh ? '标题可能包含文档名称。这里保存的是标题线索，没有截图、音频或网页正文。只有你选择记录、核对草稿并在任务中发送后，所选内容才会成为模型上下文。' : 'Titles may include document names. Saved history contains title clues, not screenshots, audio, or page content. Selected records become model context only after you review the draft and send it from a task.'}</p>
    <HistoryQuestionPanel computerIds={selected} clearComputer={() => setSelected([])} />
    {state?.error && <p className="notice notice-error">{state.error}</p>}
    <form className="history-filters" onSubmit={event => { event.preventDefault(); applyFilters() }}>
      <label>{zh ? '开始时间' : 'From'}<input className="input" type="datetime-local" value={from} disabled={busy} onChange={event => { setFrom(event.target.value); changeFilter() }} /></label>
      <label>{zh ? '结束时间' : 'To'}<input className="input" type="datetime-local" value={to} disabled={busy} onChange={event => { setTo(event.target.value); changeFilter() }} /></label>
      <label>{zh ? '应用来源' : 'Source'}<select className="input" value={source} disabled={busy} onChange={event => { setSource(event.target.value); changeFilter() }}><option value="">{zh ? '全部来源' : 'All sources'}</option>{result?.sources.map(item => <option key={item.bundleId} value={item.bundleId}>{item.name}</option>)}</select></label>
      <label className="history-search">{zh ? '搜索标题' : 'Search titles'}<input className="input" value={query} maxLength={240} disabled={busy} onChange={event => { setQuery(event.target.value); changeFilter() }} placeholder={zh ? '窗口标题或应用名称' : 'Window title or app name'} /></label>
      <div className="history-actions"><button type="submit" className="btn btn-secondary" disabled={busy}>{zh ? '应用筛选' : 'Apply filters'}</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setFrom(''); setTo(''); setSource(''); setQuery(''); void load({}) }}>{zh ? '清除筛选' : 'Clear filters'}</button></div>
    </form>
    <div className="history-results-heading"><span>{result?.total ?? 0} {zh ? '条匹配记录' : 'matching records'}{dirty ? (zh ? ' · 筛选尚未应用' : ' · Filters not applied') : ''}</span>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy || dirty || !result?.total} onClick={() => void previewDeletion(filter, zh ? '当前筛选范围' : 'Current filter')}>{zh ? '预览删除筛选记录' : 'Preview deletion of matching records'}</button></div>
    {preview && <section className="history-delete-preview" aria-label={zh ? '删除预览' : 'Deletion preview'}>
      <h3>{zh ? '确认删除范围' : 'Review deletion scope'}</h3><p>{deleteLabel}</p><p>{preview.count} {zh ? '条记录' : 'records'}{preview.from !== undefined && preview.to !== undefined ? ` · ${stamp(preview.from)} — ${stamp(preview.to)}` : ''}</p>
      <p className="settings-hint">{zh ? '只删除本次预览中的记录，无法撤销。预览有效期五分钟；之后新增的记录不会包含在内。若要停止新增记录，请先暂停。' : 'Deletes only records in this preview and cannot be undone. The preview expires in five minutes. Later records are excluded; pause collection to stop new records.'}</p>
      <label className="history-consent"><input type="checkbox" checked={reviewed} disabled={busy || !preview.count} onChange={event => setReviewed(event.target.checked)} />{zh ? '我已核对上述范围，确认永久删除。' : 'I reviewed this scope and confirm permanent deletion.'}</label>
      <div className="history-actions"><button type="button" className="btn btn-secondary" disabled={busy || !reviewed || !preview.count} onClick={() => void remove()}>{zh ? '永久删除这些记录' : 'Permanently delete these records'}</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setPreview(null); setReviewed(false) }}>{zh ? '取消' : 'Cancel'}</button></div>
    </section>}
    {busy && <p role="status">{zh ? '处理中…' : 'Working…'}</p>}{error && <p className="notice notice-error" role="alert">{error}</p>}{notice && <p className="history-notice" role="status">{notice}</p>}
    {result && !result.total && !busy && <div className="history-empty"><h3>{zh ? '没有匹配的历史' : 'No matching history'}</h3><p>{state?.status === 'disabled' ? (zh ? '电脑历史默认关闭。打开「来源与权限」，选择应用并明确开启后才会开始记录。' : 'Computer history is off by default. Open Sources & permissions, choose apps, and explicitly enable collection to begin.') : (zh ? '调整筛选范围，或切换到已允许应用等待下一次记录。' : 'Adjust the filters, or bring an allowed app to the foreground and wait for the next capture.')}</p></div>}
    <div className="history-timeline">{result?.records.map((row, index) => {
      const day = new Date(row.capturedAt).toLocaleDateString(zh ? 'zh-CN' : 'en-US'), prior = result.records[index - 1]
      return <div key={row.id}>{(!prior || day !== new Date(prior.capturedAt).toLocaleDateString(zh ? 'zh-CN' : 'en-US')) && <h3 className="history-day">{day}</h3>}
        <article className="history-record"><time dateTime={new Date(row.capturedAt).toISOString()}>{new Date(row.capturedAt).toLocaleTimeString(zh ? 'zh-CN' : 'en-US')}</time><div><label className="history-record-selection"><input type="checkbox" checked={selected.includes(row.id)} disabled={busy || (selected.length >= 30 && !selected.includes(row.id))} aria-label={`${zh ? '选择标题线索' : 'Select title clue'}: ${row.title}`} onChange={event => setSelected(ids => event.target.checked ? [...ids, row.id] : ids.filter(id => id !== row.id))} /><strong>{row.title}</strong></label><p>{row.appName} <span>{row.bundleId}</span></p></div>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} aria-label={`${zh ? '删除记录' : 'Delete record'}: ${row.title}`} onClick={() => void previewDeletion({ recordId: row.id }, row.title)}>{zh ? '删除' : 'Delete'}</button></article></div>
    })}</div>
    {Boolean(result?.total) && <div className="history-pagination"><button className="btn btn-ghost" type="button" disabled={busy || offset === 0} onClick={() => void load(filter, Math.max(0, offset - PAGE_SIZE))}>{zh ? '上一页' : 'Previous'}</button>
      <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, result?.total ?? 0)} / {result?.total}</span><button className="btn btn-ghost" type="button" disabled={busy || offset + PAGE_SIZE >= (result?.total ?? 0)} onClick={() => void load(filter, offset + PAGE_SIZE)}>{zh ? '下一页' : 'Next'}</button></div>}
  </section>
}
