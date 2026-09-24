import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ExternalBrowserPanel from '../src/renderer/src/components/workbench/ExternalBrowserPanel'
import { useStore } from '../src/renderer/src/store'
import type { ExternalBrowserConnection } from '../src/shared/external-browser-types'
import '../src/renderer/src/styles.css'
const host = window as typeof window & { IS_REACT_ACT_ENVIRONMENT: boolean; runExternalBrowserChecks(): Promise<string[]> }
host.IS_REACT_ACT_ENVIRONMENT = true
const root = createRoot(document.getElementById('root')!)
let connection: ExternalBrowserConnection | undefined, selectedCalls = 0, connectCalls = 0, tick: () => void = () => undefined
let failConnect = false
let pairingCalls = 0
window.setInterval = ((callback: () => void) => { tick = callback; return 3 }) as typeof window.setInterval
window.clearInterval = () => undefined
const tabs = ['one', 'two'].map(tabId => ({ tabId, title: `页面 ${tabId}`, url: `https://fixture.test/${tabId}`, active: false, vendor: 'chrome' as const, connectionId: 'fixture' }))
const newConnection = (): ExternalBrowserConnection => ({ id: 'fixture', sessionId: 'task-one', ownerWebContentsId: 1, vendor: 'chrome', transport: 'cdp', status: 'connected', selectionRevision: 0, endpointLabel: '127.0.0.1:9222', capabilities: ['read', 'click'] })
window.agentDesk = { ...window.agentDesk,
  openBrowserExtensionDirectory: async () => ({ path:'/fixture/extension',version:'0.1.0' }),
  beginBrowserExtensionPairing: async input => { pairingCalls++; connection = { ...newConnection(), transport:'extension',status:'pairing',endpointLabel:`extension:${input.extensionId}` };return {ok:true,value:{connection:{...connection},pairingCode:'CG1.12345.fixture',expiresAt:Date.now()+300000}} },
  listExternalBrowserConnections: async () => connection ? [{ ...connection }] : [],
  connectExternalBrowser: async input => { connectCalls++; if (input.sessionId !== 'task-one' || input.port !== 9222) throw new Error('wrong task or port')
    connection = newConnection()
    if (failConnect) { connection.status = 'error'; return { ok: false, error: 'fixture connection refused' } }
    return { ok: true, value: { connection: { ...connection }, tabs } }
  },
  reconnectExternalBrowser: async () => { connection = newConnection(); return { ok: true, value: { connection: { ...connection }, tabs } } },
  listExternalBrowserTabs: async () => ({ ok: true, value: tabs }),
  selectExternalBrowserTab: async (_id, tabId) => { selectedCalls++; connection!.selectedTabId = tabId; return { ok: true, value: { ...tabs.find(tab => tab.tabId === tabId)!, active: true } } },
  revokeExternalBrowser: async () => { connection = undefined; return { ok: true, value: { revoked: true } } }
}
function Harness() { const [external, setExternal] = useState(false); return <ExternalBrowserPanel sessionId="task-one" active externalMode={external} onModeChange={setExternal} /> }
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
const button = (text: string) => { const found = [...document.querySelectorAll('button')].find(item => item.textContent === text); if (!found) throw new Error(`Missing ${text}`); return found }
const click = async (text: string) => { await act(async () => button(text).click()) }
const transport = async (value:string) => { await act(async () => { const select=[...document.querySelectorAll('select')].find(item=>[...item.options].some(option=>option.value==='extension'))!;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(select,value);select.dispatchEvent(new Event('change',{bubbles:true})) }) }
host.runExternalBrowserChecks = async () => {
  const checks: string[] = []
  await act(async () => { useStore.setState({ settings: { ...useStore.getState().settings, language: 'zh' } }); root.render(<Harness />) })
  await click('Chrome / Edge')
  await transport('cdp')
  assert(document.querySelector('input[type="number"]') && connectCalls === 0, 'Must not connect before request')
  checks.push('External mode shows explicit vendor/port form without connecting automatically')
  await click('连接')
  assert(connectCalls === 1 && selectedCalls === 0 && !document.querySelector('.external-browser-tab.selected'), 'Connected without explicit selection')
  assert(document.querySelectorAll('.external-browser-tab').length === 2, 'Tabs missing')
  checks.push('Connect displays returned tabs and leaves all unselected')
  await act(async () => (document.querySelectorAll<HTMLButtonElement>('.external-browser-tab')[1]).click())
  assert(selectedCalls === 1 && connection?.selectedTabId === 'two', 'Explicit tab selection not sent')
  assert(document.querySelector('.external-browser-tab.selected')?.textContent?.includes('页面 two'), 'Selected tab not shown')
  checks.push('Explicit tab selection binds and highlights the selected tab')
  connection!.status = 'disconnected'
  await act(async () => tick())
  assert(document.body.textContent?.includes('连接已断开') && button('重新连接'), 'Disconnect missing')
  assert(document.body.textContent?.includes('任务不会自动改用其他浏览器'), 'Fail-closed status missing')
  checks.push('Disconnected status keeps external mode and offers reconnect')
  await click('重新连接')
  assert(!connection?.selectedTabId && !document.querySelector('.external-browser-tab.selected'), 'Reconnect reused selection')
  checks.push('Reconnect requires a new explicit tab selection')
  await click('撤销连接')
  assert(!connection && !document.querySelector('.external-browser-content'), 'Revoke did not return to embedded mode')
  checks.push('Revoke clears the task connection and returns to built-in mode')
  failConnect = true; await click('Chrome / Edge'); await click('连接')
  assert(document.querySelector('[role="alert"]')?.textContent?.includes('fixture connection refused'), 'Failure message missing')
  assert(button('重新连接') && button('撤销连接'), 'Recovery/revoke actions unavailable')
  checks.push('Connection failure shows the error, reconnect and revoke actions')
  await click('撤销连接');failConnect=false;await click('Chrome / Edge');await transport('extension')
  assert(document.querySelector<HTMLInputElement>('input[pattern="[a-p]{32}"]')?.value.length===32,'Local extension package ID missing')
  assert(pairingCalls===0,'Extension must not pair automatically')
  checks.push('Extension transport prefills the local public package ID without pairing automatically')
  await click('生成一次性配对码')
  assert(pairingCalls===1&&connection?.status==='pairing'&&document.querySelector('input[type="password"]'),'Pairing instructions missing')
  assert(!document.querySelector('.external-browser-tab'),'Pairing cannot expose unconsented tabs')
  checks.push('Pairing shows an explicit expiring code and waits for user tab authorization')
  connection!.status='connected';await act(async()=>tick())
  assert(document.querySelectorAll('.external-browser-tab').length===2&&!connection?.selectedTabId,'Explicit selection bypassed')
  await act(async()=>document.querySelector<HTMLButtonElement>('.external-browser-tab')!.click())
  assert(connection?.selectedTabId==='one','Extension tab was not bound explicitly')
  checks.push('Authorized extension tabs appear and still require CaoGen user selection')
  connection!.status='disconnected';await act(async()=>tick());await click('重新配对')
  assert(!connection&&button('生成一次性配对码'),'Extension must restart pairing instead of silently reconnecting')
  checks.push('Disconnected extension requires a new explicit pairing and tab consent')
  return checks
}
