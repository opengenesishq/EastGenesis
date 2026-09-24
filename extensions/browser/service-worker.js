import { clickSelectorScript, typeTextScript, mutationTargetCheckScript, mutationTargetRuntimeScript, waitForSelectorScript } from '../../src/shared/browser-dom-scripts'
import { pageSourceScript } from '../../src/shared/browser-source-script'

let link, queue = Promise.resolve()
const text = (value, max = 4000) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('参数无效。'); return value }
const http = value => { const url = new URL(text(value, 16384)); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持 HTTP(S) 网页。'); return url.href }
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
const current = owner => { if (link !== owner || owner.socket.readyState !== WebSocket.OPEN || !owner.epoch || !owner.capability) throw new Error('连接已断开，请重新配对。') }
const send = (owner, value) => { current(owner); owner.socket.send(JSON.stringify({ ...value, epoch: owner.epoch, capability: owner.capability })) }
const page = owner => ({ tabId: `extension-tab:${owner.tabId}`, title: owner.title.slice(0, 500), url: owner.url, revision: owner.revision, loading: owner.loading })
const assertPage = (owner, revision) => { current(owner); if (!owner.attached || owner.loading || owner.revision !== revision) throw new Error('原标签或文档已变化，请重新查看并审批。') }
const debug = async (owner, method, args = {}) => { current(owner); if (!owner.attached) throw new Error('请先明确授权本标签。'); return chrome.debugger.sendCommand({ tabId: owner.tabId }, method, args) }

async function revoke(owner = link) {
  if (!owner) return
  if (link === owner) link = undefined
  clearInterval(owner.heartbeat)
  if (owner.socket.readyState === WebSocket.OPEN && owner.epoch) owner.socket.send(JSON.stringify({ type: 'revoke', epoch: owner.epoch, capability: owner.capability }))
  owner.socket.close(); owner.rejectPair?.(new Error('配对已取消。'))
  if (owner.attached) { owner.attached = false; await chrome.debugger.detach({ tabId: owner.tabId }).catch(() => undefined) }
  chrome.action.setBadgeText({ text: '' }).catch(() => undefined)
}
async function pair(code) {
  if (link) throw new Error('请先撤销当前扩展连接。')
  const match = /^CG1\.(\d{4,5})\.([a-f0-9]{64})$/.exec(text(code, 100))
  if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) throw new Error('配对码格式无效。')
  const socket = new WebSocket(`ws://127.0.0.1:${Number(match[1])}/bridge`)
  const owner = { socket, epoch: '', capability: '', taskTitle: '', revision: 1, title: '', url: '', loading: false, attached: false, contextId: undefined, frameId: undefined, seen: new Set(), lastPong: Date.now() }
  link = owner
  const paired = new Promise((resolve, reject) => { owner.resolvePair = resolve; owner.rejectPair = reject })
  const timer = setTimeout(() => { void revoke(owner) }, 6000)
  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', protocol: 1, token: match[2] }))
  socket.onclose = () => { clearTimeout(timer); void revoke(owner) }
  socket.onerror = () => { clearTimeout(timer); void revoke(owner) }
  socket.onmessage = event => {
    try {
      if (typeof event.data !== 'string' || event.data.length > 200_000) throw new Error('无效消息。')
      const message = JSON.parse(event.data)
      if (link !== owner) return
      if (message.type === 'paired' && !owner.epoch) {
        if (message.protocol !== 1 || typeof message.epoch !== 'string' || typeof message.capability !== 'string' || !/^[a-f0-9]{64}$/.test(message.capability) || typeof message.taskTitle !== 'string') throw new Error('无效配对响应。')
        owner.epoch = message.epoch; owner.capability = message.capability; owner.taskTitle = message.taskTitle.slice(0, 200)
        clearTimeout(timer); owner.resolvePair(); owner.rejectPair = undefined
        owner.heartbeat = setInterval(() => { if (Date.now() - owner.lastPong > 60_000) void revoke(owner); else { try { send(owner, { type: 'ping' }) } catch { void revoke(owner) } } }, 20_000)
        return
      }
      if (message.type === 'revoked') { void revoke(owner); return }
      if (message.type === 'pong' && message.epoch === owner.epoch) { owner.lastPong = Date.now(); return }
      if (message.type !== 'command' || message.protocol !== 1 || message.epoch !== owner.epoch || message.capability !== owner.capability ||
        !owner.attached || message.tabId !== `extension-tab:${owner.tabId}` || typeof message.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(message.requestId) || owner.seen.has(message.requestId)) throw new Error('无效操作或重放。')
      if (owner.seen.size >= 10000) throw new Error('连接已达到操作上限，请重新配对。')
      owner.seen.add(message.requestId)
      queue = queue.catch(() => undefined).then(async () => {
        try {
          assertPage(owner, message.expectedRevision)
          const value = await execute(owner, message)
          current(owner)
          if (message.operation !== 'navigate') assertPage(owner, message.expectedRevision)
          send(owner, { type: 'result', requestId: message.requestId, tabId: message.tabId, revision: owner.revision, ok: true, value })
        } catch (cause) {
          if (link === owner && owner.socket.readyState === WebSocket.OPEN) send(owner, { type: 'result', requestId: message.requestId, tabId: message.tabId, revision: owner.revision, ok: false, error: cause instanceof Error ? cause.message.slice(0, 400) : '操作失败。' })
        }
      })
    } catch { void revoke(owner) }
  }
  await paired; return status()
}
async function authorize(tabId) {
  const owner = link; if (!owner) throw new Error('请先配对。'); current(owner)
  if (owner.attached || !Number.isSafeInteger(tabId)) throw new Error('标签授权无效。')
  const tab = await chrome.tabs.get(tabId); current(owner)
  if (!tab.active) throw new Error('请在要授权的标签上点击扩展图标。')
  if (tab.url) http(tab.url)
  owner.url = tab.url || ''; owner.title = tab.title || ''; owner.tabId = tabId
  await chrome.debugger.attach({ tabId }, '1.3')
  owner.attached = true
  try {
    current(owner)
    const info = await debug(owner, 'Page.getFrameTree'); owner.frameId = info.frameTree.frame.id; owner.url = http(info.frameTree.frame.url)
    await debug(owner, 'Page.enable'); await debug(owner, 'Runtime.enable')
    const actual = await chrome.tabs.get(tabId); current(owner)
    owner.url = http(actual.url || owner.url); owner.title = actual.title || ''; owner.loading = actual.status === 'loading'
    send(owner, { type: 'ready', page: page(owner) }); owner.ready = true
    await chrome.action.setBadgeText({ text: 'ON', tabId }); return status()
  } catch (cause) { await revoke(owner); throw cause }
}
async function isolated(owner, expression, revision) {
  assertPage(owner, revision)
  if (!owner.contextId) {
    const info = await debug(owner, 'Page.getFrameTree'); assertPage(owner, revision)
    owner.frameId = info.frameTree.frame.id
    const world = await debug(owner, 'Page.createIsolatedWorld', { frameId: owner.frameId, worldName: 'caogen-extension-fixed-v1', grantUniveralAccess: false })
    assertPage(owner, revision); owner.contextId = world.executionContextId
  }
  const result = await debug(owner, 'Runtime.evaluate', { expression, contextId: owner.contextId, returnByValue: true, awaitPromise: true, userGesture: true })
  current(owner)
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.slice(0, 350) || result.exceptionDetails.text || '网页操作失败。')
  return result.result?.value
}
async function guard(owner, approved, kind) {
  if (!approved || approved.external?.tabId !== `extension-tab:${owner.tabId}` || approved.navigationRevision !== owner.revision ||
    approved.external.pageRevision !== owner.revision || approved.actionTarget?.kind !== kind || typeof approved.documentToken !== 'string' ||
    approved.urlDigest !== await hash(owner.url)) throw new Error('当前扩展标签与审批不一致。')
  assertPage(owner, approved.navigationRevision)
  return `if(globalThis.__caogenExtensionDocumentV1 !== ${JSON.stringify(approved.documentToken)} || location.href !== ${JSON.stringify(owner.url)}) throw new Error('审批文档已变化。');`
}
async function execute(owner, message) {
  const { operation, args, expectedRevision: revision } = message
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('操作参数无效。')
  const fields = { read: [], capture: ['kind','selector'], navigate: ['url','approved'], click: ['selector','approved'], type: ['selector','text','approved'], screenshot: ['selector'], wait: ['selector','timeoutMs'] }[operation]
  if (!fields || Object.keys(args).some(key => !fields.includes(key))) throw new Error('扩展仅接受固定浏览器动作。')
  if (operation === 'read') return isolated(owner, pageSourceScript(), revision)
  if (operation === 'capture') {
    if (!['browser_click','browser_type','browser_evaluate'].includes(args.kind)) throw new Error('审批类型无效。')
    const selector = args.kind === 'browser_evaluate' ? null : text(args.selector)
    const value = await isolated(owner, `(() => { if(!Object.hasOwn(globalThis,'__caogenExtensionDocumentV1')) Object.defineProperty(globalThis,'__caogenExtensionDocumentV1',{value:${JSON.stringify(crypto.randomUUID())}}); ${mutationTargetRuntimeScript()}
      return {documentToken:globalThis.__caogenExtensionDocumentV1,...globalThis.__caogenApprovedActionTargetV1.capture(${JSON.stringify(args.kind)},${JSON.stringify(selector)})}; })()`, revision)
    if (!value || typeof value.snapshot !== 'string' || value.snapshot.length > 2_000_000) throw new Error('审批快照无效。')
    const stateDigest = await hash(value.snapshot); assertPage(owner, revision)
    return { documentToken: value.documentToken, nodeToken: value.nodeToken, version: value.version, stateDigest }
  }
  if (operation === 'click' || operation === 'type' || operation === 'navigate') {
    const kind = operation === 'click' ? 'browser_click' : operation === 'type' ? 'browser_type' : 'browser_evaluate'
    const selector = operation === 'navigate' ? undefined : text(args.selector)
    const preamble = await guard(owner, args.approved, kind)
    const check = preamble + mutationTargetCheckScript(kind, selector, args.approved.actionTarget)
    if (operation === 'click') return isolated(owner, clickSelectorScript(selector, check), revision)
    if (operation === 'type') return isolated(owner, typeTextScript(selector, text(args.text, 65536), check), revision)
    const url = http(args.url)
    await isolated(owner, `(() => { ${check} location.assign(${JSON.stringify(url)});return true; })()`, revision)
    const deadline = Date.now() + 25_000
    while (owner.revision === revision || owner.loading) { current(owner); if (Date.now() > deadline) throw new Error('导航结果尚未确认，请检查原标签。'); await new Promise(resolve => setTimeout(resolve, 50)) }
    current(owner); return page(owner)
  }
  if (operation === 'wait') {
    if (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs < 0 || args.timeoutMs > 25000) throw new Error('等待时间无效。')
    return isolated(owner, waitForSelectorScript(text(args.selector), args.timeoutMs), revision)
  }
  if (operation === 'screenshot') {
    let clip
    if (args.selector !== null && args.selector !== undefined) {
      const selector = text(args.selector)
      clip = await isolated(owner, `(() => { const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('截图元素不存在。');const box=node.getBoundingClientRect();return {x:box.x+scrollX,y:box.y+scrollY,width:box.width,height:box.height,scale:1}; })()`, revision)
      if (!clip || ![clip.x,clip.y,clip.width,clip.height].every(Number.isFinite) || clip.width <= 0 || clip.height <= 0 || clip.width > 10000 || clip.height > 10000 || clip.x < 0 || clip.y < 0) throw new Error('截图区域无效。')
    }
    assertPage(owner, revision)
    const result = await debug(owner, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: !!clip, ...(clip ? { clip } : {}) })
    assertPage(owner, revision)
    if (typeof result.data !== 'string' || result.data.length > 24000000) throw new Error('截图超过上限。')
    return result.data
  }
  throw new Error('不支持的扩展动作。')
}
function status() {
  if (!link) return { connected: false, extensionId: chrome.runtime.id }
  const url = link.url ? new URL(link.url) : null; if (url) { url.search='';url.hash='' }
  return { connected: !!link.epoch, attached: link.attached, taskTitle: link.taskTitle, tabId: link.tabId, url: url?.href, extensionId: chrome.runtime.id }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) return false
  Promise.resolve().then(() => {
    if (message?.type === 'status') return status()
    if (message?.type === 'pair') return pair(message.code)
    if (message?.type === 'authorize') return authorize(message.tabId)
    if (message?.type === 'revoke') return revoke().then(status)
    throw new Error('不支持的扩展入口。')
  }).then(value => respond({ ok:true,value }), cause => respond({ ok:false,error:cause instanceof Error ? cause.message : '操作失败。' }))
  return true
})
chrome.debugger.onDetach.addListener(source => { if (link?.attached && source.tabId === link.tabId) void revoke(link) })
chrome.debugger.onEvent.addListener((source, method, params) => {
  const owner = link
  if (!owner?.attached || source.tabId !== owner.tabId) return
  try {
    if (method === 'Page.frameStartedLoading' && params.frameId === owner.frameId) owner.loading = true
    else if (method === 'Page.frameStoppedLoading' && params.frameId === owner.frameId) owner.loading = false
    else if (method === 'Page.frameNavigated' && !params.frame.parentId) { owner.frameId = params.frame.id; owner.url = http(params.frame.url); owner.revision++; owner.contextId = undefined }
    else if (method === 'Page.navigatedWithinDocument' && params.frameId === owner.frameId) { owner.url = http(params.url); owner.revision++ }
    else if (method === 'Runtime.executionContextsCleared') { owner.revision++; owner.contextId = undefined }
    else return
    if (owner.ready) send(owner, { type:'page',page:page(owner) })
  } catch { void revoke(owner) }
})
chrome.tabs.onRemoved.addListener(tabId => { if (link?.tabId === tabId) void revoke(link) })
chrome.tabs.onUpdated.addListener((tabId, change) => {
  const owner = link
  if (owner?.ready && tabId === owner.tabId && typeof change.title === 'string') { owner.title=change.title; try { send(owner,{type:'page',page:page(owner)}) } catch { void revoke(owner) } }
})
