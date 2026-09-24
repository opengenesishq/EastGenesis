import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExternalBrowserConnection, ExternalBrowserTab, ExternalBrowserTransport, ExternalBrowserVendor } from '../../../../shared/external-browser-types'
import { useStore } from '../../store'
import { BROWSER_EXTENSION_PACKAGE_ID } from '../../../../shared/browser-extension-package'
import './external-browser-panel.css'

export default function ExternalBrowserPanel({ sessionId, active, externalMode, onModeChange }: {
  sessionId: string; active: boolean; externalMode: boolean; onModeChange(value: boolean): void
}): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const title = useStore(state => state.sessions[sessionId]?.meta.title ?? sessionId)
  const [vendor, setVendor] = useState<ExternalBrowserVendor>('chrome')
  const [port, setPort] = useState('9222')
  const [transport, setTransport] = useState<ExternalBrowserTransport>('extension')
  const [extensionId, setExtensionId] = useState(BROWSER_EXTENSION_PACKAGE_ID)
  const [pairing, setPairing] = useState<{ pairingCode: string; expiresAt: number }>()
  const [connection, setConnection] = useState<ExternalBrowserConnection>()
  const [tabs, setTabs] = useState<ExternalBrowserTab[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const currentSession = useRef(sessionId)
  currentSession.current = sessionId
  const refresh = useCallback(async () => {
    const entries = await window.agentDesk.listExternalBrowserConnections()
    if (currentSession.current !== sessionId) return
    const entry = entries.find(item => item.sessionId === sessionId)
    setConnection(entry)
    if (entry) {
      setVendor(entry.vendor); setTransport(entry.transport); onModeChange(true)
      if (entry.transport === 'extension') setExtensionId(entry.endpointLabel.slice('extension:'.length))
      if (entry.status !== 'pairing') setPairing(undefined)
      if (entry.status === 'connected') {
        const response = await window.agentDesk.listExternalBrowserTabs(entry.id)
        if (currentSession.current === sessionId && response.ok) setTabs(response.value)
      }
    } else { setPairing(undefined); setTabs([]) }
    return entry
  }, [sessionId, onModeChange])
  useEffect(() => {
    currentSession.current = sessionId
    setConnection(undefined); setTabs([]); setPairing(undefined); setError(''); setBusy(false); onModeChange(false)
    if (!active) return
    let disposed = false
    const update = () => { if (!disposed) void refresh().catch(reason => { if (!disposed) setError(String(reason)) }) }
    update()
    const timer = window.setInterval(update, 3000)
    return () => { disposed = true; currentSession.current = ''; window.clearInterval(timer) }
  }, [active, sessionId, refresh, onModeChange])
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await operation() } catch (reason) { if (currentSession.current === sessionId) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (currentSession.current === sessionId) { setBusy(false); await refresh().catch(() => undefined) } }
  }
  const connect = () => run(async () => {
    if (transport === 'extension') {
      const response = await window.agentDesk.beginBrowserExtensionPairing({ sessionId, vendor, extensionId: extensionId.trim() })
      if (currentSession.current !== sessionId) return
      if (!response.ok) throw new Error(response.error)
      setConnection(response.value.connection); setPairing(response.value); setTabs([]); onModeChange(true)
      return
    }
    const response = await window.agentDesk.connectExternalBrowser({ sessionId, vendor, transport: 'cdp', port: Number(port) })
    if (currentSession.current !== sessionId) return
    if (!response.ok) throw new Error(response.error)
    setConnection(response.value.connection); setTabs(response.value.tabs); onModeChange(true)
  })
  const reconnect = () => connection && run(async () => {
    if (connection.transport === 'extension') {
      const response = await window.agentDesk.revokeExternalBrowser(connection.id)
      if (!response.ok) throw new Error(response.error)
      if (currentSession.current !== sessionId) return
      setConnection(undefined); setPairing(undefined); setTabs([]); return
    }
    const response = await window.agentDesk.reconnectExternalBrowser(connection.id)
    if (currentSession.current !== sessionId) return
    if (!response.ok) throw new Error(response.error)
    setConnection(response.value.connection); setTabs(response.value.tabs)
  })
  const refreshTabs = () => connection && run(async () => {
    const response = await window.agentDesk.listExternalBrowserTabs(connection.id)
    if (currentSession.current !== sessionId) return
    if (!response.ok) throw new Error(response.error)
    setTabs(response.value)
  })
  const selectTab = (tabId: string) => connection && run(async () => {
    const response = await window.agentDesk.selectExternalBrowserTab(connection.id, tabId)
    if (currentSession.current !== sessionId) return
    if (!response.ok) throw new Error(response.error)
    setConnection({ ...connection, selectedTabId: tabId })
    setTabs(current => current.map(tab => ({ ...tab, active: tab.tabId === tabId })))
  })
  const revoke = () => run(async () => {
    if (connection) {
      const response = await window.agentDesk.revokeExternalBrowser(connection.id)
      if (!response.ok) throw new Error(response.error)
    }
    if (currentSession.current !== sessionId) return
    setConnection(undefined); setPairing(undefined); setTabs([]); onModeChange(false)
  })
  const selected = tabs.find(tab => tab.tabId === connection?.selectedTabId)
  const status = connection?.status
  const statusText = status === 'connected'
    ? connection?.selectedTabId ? (zh ? '已绑定标签页' : 'Tab bound') : (zh ? '已连接，请选择标签页' : 'Connected — select a tab')
    : status === 'pairing' ? (zh ? '等待配对及标签授权' : 'Waiting for pairing and tab consent')
      : status === 'disconnected' ? (zh ? '连接已断开' : 'Disconnected')
        : status === 'error' ? (zh ? '连接失败' : 'Connection failed') : (zh ? '尚未连接' : 'Not connected')
  return <section className="external-browser-section" aria-label={zh ? '浏览器连接' : 'Browser connection'}>
    <div className="external-browser-mode" role="group" aria-label={zh ? '选择浏览器' : 'Choose browser'}>
      <button className={`btn btn-ghost btn-sm ${!externalMode ? 'active' : ''}`} type="button" disabled={busy} onClick={() => void revoke()}>{zh ? '内置浏览器' : 'Built-in browser'}</button>
      <button className={`btn btn-ghost btn-sm ${externalMode ? 'active' : ''}`} type="button" disabled={busy} onClick={() => onModeChange(true)}>Chrome / Edge</button>
      {connection && <span className="external-browser-status" role="status">{statusText}</span>}
    </div>
    {externalMode && <div className="external-browser-content">
      <h3>{zh ? '连接当前任务的浏览器' : 'Connect a browser to this task'}</h3>
      <p className="external-browser-task">{zh ? '绑定任务：' : 'Task: '}{title}</p>
      {!connection && <form className="external-browser-form" onSubmit={event => { event.preventDefault(); void connect() }}>
        <label>{zh ? '浏览器' : 'Browser'}<select className="select" aria-label={zh ? '浏览器厂商' : 'Browser vendor'} value={vendor} disabled={busy} onChange={event => setVendor(event.target.value as ExternalBrowserVendor)}><option value="chrome">Google Chrome</option><option value="edge">Microsoft Edge</option></select></label>
        <label>{zh ? '连接方式' : 'Transport'}<select className="select" value={transport} disabled={busy} onChange={event => setTransport(event.target.value as ExternalBrowserTransport)}><option value="extension">{zh ? '浏览器扩展' : 'Browser extension'}</option><option value="cdp">{zh ? '本机 CDP 端口' : 'Local CDP port'}</option></select></label>
        {transport === 'extension' ? <details><summary>{zh ? '高级：自定义扩展 ID（已自动填写本机包）' : 'Advanced: custom extension ID (local package prefilled)'}</summary><label>{zh ? '扩展 ID' : 'Extension ID'}<input className="input" aria-label={zh ? '扩展 ID' : 'Extension ID'} value={extensionId} placeholder={zh ? '从扩展弹窗复制 32 位 ID' : 'Copy the 32-character ID from the popup'} pattern="[a-p]{32}" required disabled={busy} onChange={event => setExtensionId(event.target.value)} /></label></details> : <label>{zh ? '本机 CDP 端口' : 'Local CDP port'}<input className="input" aria-label={zh ? '本机 CDP 端口' : 'Local CDP port'} value={port} inputMode="numeric" type="number" min={1024} max={65535} required disabled={busy} onChange={event => setPort(event.target.value)} /></label>}
        <button className="btn btn-primary" disabled={busy} type="submit">{busy ? (zh ? '连接中…' : 'Connecting…') : transport === 'extension' ? (zh ? '生成一次性配对码' : 'Generate pairing code') : (zh ? '连接' : 'Connect')}</button>
      </form>}
      {pairing && status === 'pairing' && <div className="external-browser-pairing"><p>{zh ? '在目标网页打开扩展，粘贴配对码，再明确允许当前任务使用该标签。' : 'Open the extension on your chosen page, paste the code, then explicitly authorize that tab.'}</p><input className="input" readOnly type="password" aria-label={zh ? '一次性配对码' : 'One-time pairing code'} value={pairing.pairingCode} /><button type="button" className="btn btn-ghost btn-sm" onClick={() => void navigator.clipboard.writeText(pairing.pairingCode).catch(cause => setError(String(cause)))}>{zh ? '复制配对码' : 'Copy pairing code'}</button><small>{zh ? '到期时间：' : 'Expires: '}{new Date(pairing.expiresAt).toLocaleTimeString()}</small></div>}
      {connection && <div className="external-browser-connection">
        <span>{connection.vendor === 'chrome' ? 'Chrome' : 'Edge'} · {connection.endpointLabel}</span>
        <span role="status">{statusText}</span>
        <div className="external-browser-actions">
          {status === 'connected' ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void refreshTabs()}>{zh ? '刷新标签页' : 'Refresh tabs'}</button> : status !== 'pairing' && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void reconnect()}>{connection.transport === 'extension' ? (zh ? '重新配对' : 'Pair again') : (zh ? '重新连接' : 'Reconnect')}</button>}
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void revoke()}>{zh ? '撤销连接' : 'Revoke connection'}</button>
        </div>
      </div>}
      {connection && status === 'connected' && <>
        <p>{connection.selectedTabId
          ? (zh ? `当前任务使用：${selected?.title || selected?.url || connection.selectedTabId}` : `This task uses: ${selected?.title || selected?.url || connection.selectedTabId}`)
          : (zh ? '选择一个标签页后，当前任务才能读取和操作它。' : 'Choose one tab before this task can read or operate it.')}</p>
        <div className="external-browser-tabs" role="list" aria-label={zh ? '可连接的标签页' : 'Available tabs'}>
          {tabs.length === 0 && <p>{zh ? '未列出网页标签页。请在浏览器中打开 HTTP/HTTPS 网页，再刷新。' : 'No webpage tabs are listed. Open an HTTP/HTTPS page in the browser, then refresh.'}</p>}
          {tabs.map(tab => <button type="button" role="listitem" className={`external-browser-tab ${connection.selectedTabId === tab.tabId ? 'selected' : ''}`} key={tab.tabId} disabled={busy} aria-label={`${zh ? '选择标签页' : 'Select tab'} ${tab.title || tab.url}`} onClick={() => void selectTab(tab.tabId)}>
            <strong>{tab.title || (zh ? '未命名页面' : 'Untitled page')}</strong><span>{tab.url}</span><small>{connection.selectedTabId === tab.tabId ? (zh ? '当前任务已绑定' : 'Bound to this task') : (zh ? '点击绑定' : 'Select to bind')}</small>
          </button>)}
        </div>
      </>}
      {(status === 'disconnected' || status === 'error') && <p className="notice notice-info">{zh ? '任务不会自动改用其他浏览器。若断开前有操作正在执行，请先在浏览器中核对结果，再重新连接和选择标签页。' : 'The task will not switch browsers automatically. Check any action that was in progress before reconnecting and selecting a tab.'}</p>}
      <details className="external-browser-help"><summary>{zh ? '安装与连接说明' : 'Installation & connection help'}</summary>
        {transport === 'extension' ? <><button type="button" className="btn btn-ghost btn-sm" onClick={() => void window.agentDesk.openBrowserExtensionDirectory().catch(cause => setError(String(cause)))}>{zh ? '打开本机扩展目录' : 'Open local extension folder'}</button><p>{zh ? '在 Chrome/Edge 扩展管理中开启开发者模式，选择“加载已解压的扩展”并加载此目录。扩展声明 debugger 调试权限；安装后默认不控制任何标签。' : 'Enable Developer mode in Chrome/Edge extensions and load this folder as an unpacked extension. It declares debugger permission and controls no tab by default.'}</p><p>{zh ? '在目标网页中点击扩展图标，复制扩展 ID；生成配对码并粘贴到扩展，再明确授权该标签。每个扩展实例同时连接一个任务/标签。调试授权覆盖该标签后续 HTTP(S) 页面，activeTab 不限制 debugger 权限。' : 'Open the extension on the target page, copy its ID, pair, and explicitly authorize that tab. Each extension instance serves one task/tab. Debugger consent covers subsequent HTTP(S) pages in that tab; activeTab does not restrict debugger.'}</p></> : <p>{zh ? '先自行启动启用了远程调试端口的 Chrome 或 Edge，再填写该端口。EastGenesis 只连接 127.0.0.1，不启动浏览器或扫描端口。网页继续显示在原浏览器中。' : 'Start Chrome or Edge with a remote debugging port, then enter that port here. EastGenesis connects only to 127.0.0.1. Pages remain in their original browser window.'}</p>}
        <p>{zh ? '连接后仍需手动选择标签页。撤销连接立即阻止后续操作；操作回执丢失时先核对原页面，不自动重试。扩展支持固定读页、截图、导航、点击、输入与等待，不提供任意脚本或自动搜索流程。' : 'Select the authorized tab after connecting. Revoking stops further operations. Check the original page after a lost reply; writes are never retried automatically. The extension supports fixed read, screenshot, navigate, click, type and wait actions, without arbitrary scripts or automatic search.'}</p></details>
    </div>}
    {error && <p className="notice notice-error" role="alert">{error}</p>}
  </section>
}
