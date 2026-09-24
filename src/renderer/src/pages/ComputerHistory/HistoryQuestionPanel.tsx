import { useEffect, useMemo, useRef, useState } from 'react'
import type { BrowserHistoryRecord } from '../../../../shared/browser-preferences-types'
import type { HistoryQuestionIntent, HistoryQuestionPreview, HistoryQuestionTaskBinding } from '../../../../shared/history-question-types'
import { useStore } from '../../store'
import { appendPersistentComposerDraft } from '../../store/composer-draft-persistence'
import { historyError } from './common'

interface Props { computerIds: string[]; clearComputer(): void }
export default function HistoryQuestionPanel({ computerIds, clearComputer }: Props): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh'), activeId = useStore(state => state.activeId)
  const sessions = useStore(state => state.sessions), order = useStore(state => state.order)
  const history = useStore(state => state.history)
  const tasks = useMemo(() => order.flatMap(id => { const meta = sessions[id]?.meta; return meta && !history.some(entry => entry.id === id && entry.archived) && meta.status !== 'closed' && !meta.sideChat ? [meta] : [] }), [order, sessions, history])
  const [target, setTarget] = useState(activeId ?? ''), [intent, setIntent] = useState<HistoryQuestionIntent>('question'), [question, setQuestion] = useState('')
  const [browserRows, setBrowserRows] = useState<BrowserHistoryRecord[]>([]), [browserIds, setBrowserIds] = useState<string[]>([]), [browserOpen, setBrowserOpen] = useState(false), [browserEnabled, setBrowserEnabled] = useState<boolean>(), [before, setBefore] = useState<number>()
  const [preview, setPreview] = useState<HistoryQuestionPreview>(), [reviewed, setReviewed] = useState(false), [busy, setBusy] = useState(false), [browserBusy, setBrowserBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const version = useRef(0), browserVersion = useRef(0), alive = useRef(true)
  const computerKey = computerIds.join(','), browserKey = browserIds.join(','), total = computerIds.length + browserIds.length
  const selectionKey = `${target}:${intent}:${question}:${computerKey}:${browserKey}:${zh}`
  const latestSelection = useRef(selectionKey); latestSelection.current = selectionKey
  useEffect(() => { alive.current = true; return () => { alive.current = false; version.current++; browserVersion.current++ } }, [])
  useEffect(() => { version.current++; setPreview(undefined); setReviewed(false); setNotice(''); setBusy(false) }, [selectionKey])
  const invalidate = (): void => { version.current++; setPreview(undefined); setReviewed(false); setNotice(''); setError('') }
  const sourceSelection = () => [...computerIds.map(id => ({ kind: 'computer' as const, id })), ...browserIds.map(id => ({ kind: 'browser' as const, id }))]
  async function loadBrowser(more = false): Promise<void> {
    const current = ++browserVersion.current
    setBrowserOpen(true); setBrowserBusy(true); setError(''); invalidate()
    try {
      const preferences = await window.agentDesk.getBrowserPreferences()
      if (!alive.current || current !== browserVersion.current) return
      setBrowserEnabled(preferences.preferences.recordHistory)
      if (!preferences.preferences.recordHistory) { setBrowserRows([]); setBrowserIds([]); setBefore(undefined); return }
      const result = await window.agentDesk.listBrowserHistory({ limit: 50, ...(more && before ? { before } : {}) })
      if (!alive.current || current !== browserVersion.current) return
      setBrowserRows(prior => more ? [...prior, ...result.items.filter(item => !prior.some(row => row.id === item.id))] : result.items)
      setBefore(result.nextBefore)
    } catch (cause) { if (alive.current && current === browserVersion.current) setError(historyError(cause, zh)) }
    finally { if (alive.current && current === browserVersion.current) setBrowserBusy(false) }
  }
  async function prepare(): Promise<void> {
    const current = ++version.current, chosen = selectionKey
    setBusy(true); setError(''); setNotice(''); setPreview(undefined); setReviewed(false)
    try {
      const value = await window.agentDesk.previewHistoryQuestion({ sessionId: target, sources: sourceSelection(), intent, question, language: zh ? 'zh' : 'en' })
      if (alive.current && current === version.current && chosen === latestSelection.current) setPreview(value)
    } catch (cause) { if (alive.current && current === version.current) setError(historyError(cause, zh)) }
    finally { if (alive.current && current === version.current) setBusy(false) }
  }
  async function deliver(): Promise<void> {
    if (!preview || !reviewed) return
    const current = ++version.current, chosen = selectionKey, original = preview
    setBusy(true); setError(''); setNotice('')
    try {
      const exists = await useStore.getState().syncSession(original.sessionId)
      if (!alive.current || current !== version.current || chosen !== latestSelection.current) return
      const task = useStore.getState().sessions[original.sessionId]?.meta
      if (!exists || !task || task.status === 'closed' || !sameTask(task, original.binding)) throw new Error(zh ? '目标任务已变化，请重新预览。' : 'The target task changed. Preview again.')
      const delivery = await window.agentDesk.deliverHistoryQuestion({ previewId: original.id, sessionId: target })
      if (!alive.current || current !== version.current || chosen !== latestSelection.current) return
      const latest = useStore.getState().sessions[original.sessionId]?.meta
      if (delivery.sessionId !== original.sessionId || !latest || latest.status === 'closed' || !sameTask(latest, delivery.binding) || delivery.text !== original.text) throw new Error(zh ? '目标或预览内容已变化，未加入草稿。' : 'The target or preview changed. Nothing was added.')
      const receipt = appendPersistentComposerDraft(window.localStorage, delivery.sessionId, delivery.text, delivery.deliveryId)
      setNotice(receipt.duplicate ? (zh ? '这组来源和问题已加入过原任务草稿，未重复添加。' : 'These sources and this question were already added; no duplicate was created.') : (zh ? `已保存到「${original.taskTitle}」的草稿。进入原任务核对后点击发送。` : `Saved to the draft of “${original.taskTitle}”. Review and send it from that task.`))
    } catch (cause) { if (alive.current && current === version.current) setError(historyError(cause, zh)) }
    finally { if (alive.current && current === version.current) setBusy(false) }
  }
  return <section className="history-question-panel" data-history-question>
    <div className="history-results-heading"><h3>{zh ? '根据历史准备提问' : 'Prepare a question from history'}</h3><span>{total}/30 {zh ? '条已选来源' : 'selected sources'}</span></div>
    <p className="settings-hint">{zh ? '勾选下方应用记录，也可选择已开启记录的浏览器历史。只整理标题线索；预览后加入指定任务草稿，由你决定是否发送。' : 'Select app records below, or browser history with recording enabled. These are title clues only. Review the preview, then add it to a selected task draft for you to send.'}</p>
    <div className="history-question-fields">
      <label>{zh ? '目标任务' : 'Target task'}<select className="input" value={target} disabled={busy} onChange={event => { invalidate(); setTarget(event.target.value) }}><option value="">{zh ? '选择已有任务' : 'Select an existing task'}</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.title || task.id}</option>)}</select></label>
      <label>{zh ? '准备内容' : 'Prepare'}<select className="input" value={intent} disabled={busy} onChange={event => { invalidate(); setIntent(event.target.value as HistoryQuestionIntent) }}><option value="question">{zh ? '自定义问题' : 'Custom question'}</option><option value="summary">{zh ? '整理活动线索' : 'Summarize activity clues'}</option><option value="skill">{zh ? '建议可复用技能' : 'Suggest reusable skills'}</option><option value="plan">{zh ? '拟定后续计划' : 'Draft next steps'}</option></select></label>
    </div>
    <label className="history-question-input">{intent === 'question' ? (zh ? '你的问题' : 'Your question') : (zh ? '补充要求（可选）' : 'Additional instructions (optional)')}<textarea className="input" rows={3} maxLength={8000} value={question} disabled={busy} onChange={event => { invalidate(); setQuestion(event.target.value) }} placeholder={zh ? '例如：这些记录里有哪些需要我跟进的线索？' : 'For example: which clues might need a follow-up?'} /></label>
    <div className="history-actions">
      <button className="btn btn-ghost btn-sm" type="button" disabled={busy || browserBusy} onClick={() => void loadBrowser()}>{browserBusy ? (zh ? '读取中…' : 'Loading…') : (zh ? '读取已授权浏览器历史' : 'Load opted-in browser history')}</button>
      <button className="btn btn-ghost btn-sm" type="button" disabled={busy || !total} onClick={() => { invalidate(); clearComputer(); setBrowserIds([]) }}>{zh ? '清空选择' : 'Clear selection'}</button>
      <button className="btn btn-secondary" type="button" data-history-question-preview disabled={busy || total < 1 || total > 30 || !target || (intent === 'question' && !question.trim())} onClick={() => void prepare()}>{zh ? '预览问题与来源' : 'Preview question and sources'}</button>
    </div>
    {browserOpen && <div className="history-browser-selection">
      <div className="history-results-heading"><strong>{zh ? '已存浏览器标题 / URL' : 'Saved browser titles / URLs'}</strong><button className="btn btn-ghost btn-sm" type="button" onClick={() => setBrowserOpen(false)}>{zh ? '收起' : 'Collapse'}</button></div>
      {browserEnabled === false && <p>{zh ? '浏览器历史记录尚未开启。可在设置 → 浏览器中明确开启；这里不会替你开启采集。' : 'Browser history recording is off. Enable it explicitly in Settings → Browser; this page will not enable collection.'}</p>}
      {browserEnabled && !browserRows.length && <p>{zh ? '没有已存浏览器历史。' : 'No saved browser history.'}</p>}
      {browserRows.map(row => <label className="history-browser-record" key={row.id}><input type="checkbox" disabled={busy || (total >= 30 && !browserIds.includes(row.id))} checked={browserIds.includes(row.id)} onChange={event => { invalidate(); setBrowserIds(ids => event.target.checked ? [...ids, row.id] : ids.filter(id => id !== row.id)) }} /><span><strong>{row.title || (zh ? '无标题' : 'Untitled')}</strong><code>{row.url}</code><small>{new Date(row.visitedAt).toLocaleString(zh ? 'zh-CN' : 'en-US')}</small></span></label>)}
      {before && <button type="button" className="btn btn-ghost btn-sm" disabled={browserBusy || busy} onClick={() => void loadBrowser(true)}>{zh ? '更多已存记录' : 'More saved records'}</button>}
    </div>}
    {preview && <div className="history-question-preview"><h4>{zh ? `预览：${preview.taskTitle}` : `Preview: ${preview.taskTitle}`}</h4><pre>{preview.text}</pre>
      <p className="settings-hint">{zh ? '预览五分钟内有效。加入草稿时会再次检查记录和任务；后续在任务中发送才会调用模型。删除历史不会删除你已经主动保存的任务草稿。' : 'This preview lasts five minutes. Sources and the task are rechecked when adding the draft. Only sending from the task calls a model. Deleting history does not delete drafts you have already saved.'}</p>
      <label className="history-consent"><input type="checkbox" disabled={busy} checked={reviewed} onChange={event => setReviewed(event.target.checked)} />{zh ? '我已核对目标任务、标题线索和完整来源。' : 'I reviewed the target task, title clues, and complete sources.'}</label>
      <button type="button" className="btn btn-secondary" data-history-question-deliver disabled={busy || !reviewed} onClick={() => void deliver()}>{zh ? '加入该任务草稿' : 'Add to this task draft'}</button>
    </div>}
    {error && <p className="notice notice-error" role="alert">{error}</p>}{notice && <p className="history-notice" role="status">{notice}</p>}
  </section>
}
function sameTask(task: HistoryQuestionTaskBinding, binding: HistoryQuestionTaskBinding): boolean {
  return (['id', 'createdAt', 'cwd', 'projectId', 'workspaceId', 'goalId', 'workItemId'] as const).every(key => task[key] === binding[key])
}
