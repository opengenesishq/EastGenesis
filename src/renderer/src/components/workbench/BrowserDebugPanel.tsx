import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserTabTarget } from '../../../../shared/browser-tab-types'
import type { BrowserDebugGrant, BrowserDebugSnapshot, BrowserDebugStatus } from '../../../../shared/browser-debug-types'
import { useStore } from '../../store'
import { canSendToSession } from './session-send-availability'
import './browser-debug-panel.css'

export default function BrowserDebugPanel({ target }: { target: BrowserTabTarget }): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const enabled = useStore(state => state.settings.browserDebug?.enabled === true)
  const status = useStore(state => state.sessions[target.contextId]?.meta.status)
  const [view, setView] = useState<BrowserDebugStatus>(), [snapshot, setSnapshot] = useState<BrowserDebugSnapshot>()
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [expression, setExpression] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const alive = useRef(false), request = useRef(0), currentGrant = useRef<BrowserDebugGrant>()
  const refresh = useCallback(async (): Promise<void> => {
    const token = ++request.current
    try {
      const next = await window.agentDesk.getBrowserDebugStatus(target)
      if (!alive.current || token !== request.current) return
      currentGrant.current = next.grant; setView(next)
      if (!next.grant) setSnapshot(undefined)
    } catch (failure) { if (alive.current && token === request.current) { setError(message(failure)); setSnapshot(undefined) } }
  }, [target.contextId, target.contextEpoch, target.tabId, target.selectionRevision, target.navigationRevision])
  useEffect(() => {
    alive.current = true
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5_000)
    return () => {
      alive.current = false; request.current++; clearInterval(timer)
      const grant = currentGrant.current; currentGrant.current = undefined
      if (grant) void window.agentDesk.revokeBrowserDebug({ sessionId: target.contextId, grantId: grant.id }).catch(() => undefined)
    }
  }, [refresh])
  useEffect(() => { void refresh() }, [enabled, refresh])
  const authorize = async (): Promise<void> => {
    setBusy(true); setError(''); setSnapshot(undefined)
    try {
      const grant = await window.agentDesk.grantBrowserDebug(target)
      if (!alive.current) { await window.agentDesk.revokeBrowserDebug({ sessionId: target.contextId, grantId: grant.id }); return }
      currentGrant.current = grant
      setView({ enabled: true, supported: true, grant })
    } catch (failure) { if (alive.current) setError(message(failure)) }
    finally { if (alive.current) { setBusy(false); void refresh() } }
  }
  const revoke = async (): Promise<void> => {
    const grant = currentGrant.current
    if (!grant) return
    setBusy(true); setSnapshot(undefined)
    try { await window.agentDesk.revokeBrowserDebug({ sessionId: target.contextId, grantId: grant.id }); currentGrant.current = undefined; await refresh() }
    catch (failure) { if (alive.current) setError(message(failure)) }
    finally { if (alive.current) setBusy(false) }
  }
  const capture = async (): Promise<void> => {
    const grant = currentGrant.current
    if (!grant) return
    setBusy(true); setError('')
    try {
      const next = await window.agentDesk.getBrowserDebugSnapshot({ target, grantId: grant.id })
      if (alive.current && currentGrant.current?.id === grant.id) setSnapshot(next)
    } catch (failure) { if (alive.current) { setError(message(failure)); setSnapshot(undefined); void refresh() } }
    finally { if (alive.current) setBusy(false) }
  }
  const submit = async (): Promise<void> => {
    const state = useStore.getState()
    if (state.activeId !== target.contextId || !currentGrant.current) return
    setBusy(true); setError(''); setSubmitted(false)
    try {
      await state.sendMessage(`请在当前任务已授权的内置浏览器标签中，用 browser_debug_evaluate 执行以下完整表达式；先展示并请求本次脚本审批。授权或页面变化时停止，不自动重新授权或重试。\n\n${expression}`)
      if (alive.current) setSubmitted(true)
    } catch (failure) { if (alive.current) setError(message(failure)) }
    finally { if (alive.current) setBusy(false) }
  }
  return <aside id="browser-debug-panel" className="browser-debug-panel">
    <h3>{zh ? '高级调试' : 'Advanced debugging'}</h3>
    <p className="settings-hint">{zh ? '授权当前任务读取本标签的调试摘要；主框架脚本可以影响页面，每次执行仍需审批。授权不会扩展到其他标签。' : 'Authorize this task to read this tab’s diagnostics. Main-frame scripts may affect the page and require approval each time. Other tabs remain outside this grant.'}</p>
    {!enabled && <p className="field-hint">{zh ? '请先在设置 → 浏览器开启高级调试。' : 'Enable advanced debugging in Settings → Browser first.'}</p>}
    {view?.reason && <p className="field-hint">{view.reason}</p>}
    {view?.grant ? <>
      <div className="field-hint">{view.grant.pageUrl}<br />{zh ? '到期时间：' : 'Expires: '}{new Date(view.grant.expiresAt).toLocaleTimeString()}</div>
      <div className="browser-debug-actions"><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void revoke()}>{zh ? '撤销授权' : 'Revoke grant'}</button>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void capture()}>{zh ? '读取快照' : 'Read snapshot'}</button></div>
    </> : <button className="btn btn-primary btn-sm" disabled={busy || !enabled || !view?.supported} onClick={() => void authorize()}>{zh ? '授权当前标签 5 分钟' : 'Authorize this tab for 5 minutes'}</button>}
    <p className="field-hint">{zh ? '最多保留 100 条控制台摘要与 100 条网络记录，每条文本最多 1,024 字符。省略网址查询参数、请求头、Cookie、请求体和响应正文；已识别的凭证会脱敏。仅采集主框架，撤销后清空。' : 'Up to 100 console summaries and 100 network records; text is capped at 1,024 characters. URL queries, headers, cookies, and request/response bodies are omitted. Recognized credentials are redacted. Main frame only; revoking clears the buffer.'}</p>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {snapshot && <>
      <details open><summary>{zh ? '控制台' : 'Console'} · {snapshot.console.length}</summary>{snapshot.console.length ? snapshot.console.map((item, i) => <pre key={i}>{item.kind}: {item.text}</pre>) : <p className="field-hint">{zh ? '授权后暂无记录。' : 'No records since authorization.'}</p>}</details>
      <details><summary>{zh ? '网络元数据' : 'Network metadata'} · {snapshot.network.length}</summary>{snapshot.network.map(item => <div className="browser-debug-record" key={item.id}>{item.method} · {item.status ?? (item.failed ? 'failed' : 'pending')} · {item.type}<br />{item.url}{item.bytes !== undefined && <small>{item.bytes} bytes</small>}</div>)}</details>
      <details><summary>{zh ? '性能' : 'Performance'}</summary>{Object.entries(snapshot.metrics).map(([key, value]) => <div className="browser-debug-record" key={key}>{key}: {value}</div>)}</details>
    </>}
    <label className="field-label">{zh ? '主框架脚本' : 'Main-frame expression'}<textarea className="input" rows={5} maxLength={16_384} value={expression} onChange={event => { setExpression(event.target.value); setSubmitted(false) }} placeholder="document.title" /></label>
    <button className="btn btn-ghost btn-sm" disabled={busy || !view?.grant || !expression.trim() || !canSendToSession(target.contextId, status, true)} onClick={() => void submit()}>{zh ? '交给任务审批执行' : 'Send to task for approval'}</button>
    {submitted && <p className="field-hint">{zh ? '已发给当前任务，执行审批与结果在对话中显示。' : 'Sent to the current task. Approval and results appear in the conversation.'}</p>}
  </aside>
}
function message(value: unknown): string { return value instanceof Error ? value.message : String(value) }
