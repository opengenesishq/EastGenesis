import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, type WebContents } from 'electron'
import { browserViewManager as manager } from '../src/main/browserView'
import { browserStyleController as controller } from '../src/main/browser-style/controller'
import type { BrowserStylePort } from '../src/main/browser-style/controller'
import type { BrowserStylePreview } from '../src/shared/browser-style-types'
import { browserTabTarget } from '../src/shared/browser-tab-types'

export async function run(root: string): Promise<void> {
  const file = join(root, 'page.html')
  const html = '<!doctype html><meta charset="utf-8"><title>Style fixture</title><style>body{margin:0}#fixture{width:300px;height:120px;font-size:16px}</style><div id="fixture" style="margin:8px 9px !important;padding:6px 7px;color:rgb(1,2,3) !important" onclick="window.clicks++" onpointerdown="window.pointers++">Local fixture</div><script>window.clicks=0;window.pointers=0</script>'
  writeFileSync(file, html)
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(readFileSync(file)) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const win = new BrowserWindow({ show: true, title: 'EastGenesis local browser style fixture', width: 700, height: 500, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } })
  const task = 'style-fixture', notices: string[] = []
  let checks = 0
  const pass = (label: string): void => { checks++; console.log(`PASS ${checks}: ${label}`) }
  const native = (): WebContents => manager.assertTarget(manager.target(task), true, true).view.webContents
  const port = (): BrowserStylePort => {
    const target = manager.target(task), contents = native()
    return { target, contents, ownerId: win.webContents.id, assertCurrent: () => { manager.assertTarget(target, true, true) }, notice: message => notices.push(message) }
  }
  const ref = (preview: BrowserStylePreview) => ({ previewId: preview.id, target: preview.target, expectedRevision: preview.revision })
  const styles = (contents = native()): Promise<unknown> => contents.executeJavaScript(`(() => { const node = document.querySelector('#fixture'); return Object.fromEntries(['color','font-size','margin-top','padding-left'].map(name => [name,[node.style.getPropertyValue(name),node.style.getPropertyPriority(name),getComputedStyle(node).getPropertyValue(name)]])) })()`)
  const pick = async (): Promise<BrowserStylePreview> => {
    const captured = port(), selecting = controller.pick(captured)
    await waitFor(async () => captured.contents.executeJavaScript(`Array.from(document.documentElement.children).some(node => node.style?.cursor === 'crosshair')`))
    const point = await captured.contents.executeJavaScript(`(() => { const box = document.querySelector('#fixture').getBoundingClientRect();return {x:Math.round(box.x+20),y:Math.round(box.y+20)} })()`)
    win.focus(); captured.contents.focus()
    captured.contents.sendInputEvent({ type: 'mouseMove', ...point })
    captured.contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    captured.contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    const result = await Promise.race([selecting, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Native click did not finish selection')), 4000))])
    assert.equal(result.cancelled, false)
    if (result.cancelled) throw new Error('Unexpected cancellation')
    return result.preview
  }
  try {
    await win.loadURL('about:blank')
    await manager.open(win, task, `${origin}/page?private=never-include#secret`)
    manager.setBounds(task, { x: 0, y: 0, width: 650, height: 420 }, win)
    const a = native(), initial = await styles(a), aId = manager.target(task).tabId
    let preview = await pick()
    assert.equal(await a.executeJavaScript('window.clicks + window.pointers'), 0)
    assert.equal(preview.tagName, 'div'); assert.match(preview.selector, /^html > body > div$/)
    pass('native element picking suppresses the underlying element click and pointer handlers')
    const before = preview
    preview = await controller.preview(win.webContents.id, { ...ref(preview), changes: { fontSize: 32, color: '#112233', paddingLeft: 24, marginTop: 12 } })
    assert.equal(await a.executeJavaScript(`getComputedStyle(document.querySelector('#fixture')).fontSize`), '32px')
    assert.equal(await a.executeJavaScript(`getComputedStyle(document.querySelector('#fixture')).color`), 'rgb(17, 34, 51)')
    assert.equal(preview.changes.length, 4); assert.equal(readFileSync(file, 'utf8'), html)
    pass('temporary preview updates rendered styles while source bytes stay unchanged')
    await assert.rejects(controller.preview(win.webContents.id, { ...ref(before), changes: { fontSize: 48 } }), /过期|变化/)
    await assert.rejects(controller.preview(win.webContents.id + 99, { ...ref(preview), changes: { fontSize: 48 } }), /过期|变化/)
    await assert.rejects(controller.preview(win.webContents.id, { ...ref(preview), target: { ...preview.target, tabId: randomUUID() }, changes: { fontSize: 48 } }), /过期|变化/)
    for (const changes of [{ color: 'url(https://example.invalid)' }, { cssText: 'position:fixed' }, { fontFamily: 'evil()' }, { fontSize: 10000 }, JSON.parse('{"__proto__":{"x":1}}')]) {
      await assert.rejects(controller.preview(win.webContents.id, { ...ref(preview), changes } as never))
    }
    assert.equal(await a.executeJavaScript(`getComputedStyle(document.querySelector('#fixture')).fontSize`), '32px')
    pass('stale revisions, wrong owner/tab, arbitrary CSS and out-of-range values are rejected')
    const draft = await controller.draft(win.webContents.id, ref(preview)), again = await controller.draft(win.webContents.id, ref(preview))
    assert.equal(draft.sessionId, task); assert.equal(draft.deliveryId, again.deliveryId)
    assert.match(draft.text, /尚未保存源码/); assert.match(draft.text, /font-size/); assert.doesNotMatch(draft.text, /never-include|secret/)
    pass('draft contains source-edit instructions, versioned CSS and a redacted URL with stable delivery id')
    preview = await controller.revert(win.webContents.id, ref(preview)); assert.deepEqual(await styles(a), initial)
    pass('revert restores original inline values and important priorities including shorthand-derived fields')
    preview = await controller.preview(win.webContents.id, { ...ref(preview), changes: { color: '#112233', fontSize: 40 } })
    await a.executeJavaScript(`document.querySelector('#fixture').style.setProperty('color','purple','important')`)
    await assert.rejects(controller.draft(win.webContents.id, ref(preview)), /样式已变化/)
    preview = await controller.revert(win.webContents.id, ref(preview))
    assert.deepEqual(preview.conflicts, ['color']); assert.equal(await a.executeJavaScript(`getComputedStyle(document.querySelector('#fixture')).color`), 'rgb(128, 0, 128)')
    assert.equal(await a.executeJavaScript(`getComputedStyle(document.querySelector('#fixture')).fontSize`), '16px')
    pass('revert preserves page-authored changes and rejects a conflicting draft snapshot')
    preview = await pick()
    await a.executeJavaScript(`document.querySelector('#fixture').outerHTML = document.querySelector('#fixture').outerHTML`)
    await assert.rejects(controller.preview(win.webContents.id, { ...ref(preview), changes: { fontSize: 48 } }), /元素已变化/)
    assert.equal(await a.executeJavaScript(`getComputedStyle(document.querySelector('#fixture')).fontSize`), '16px')
    pass('replacement node at the same selector never receives the old preview')
    preview = await pick(); preview = await controller.preview(win.webContents.id, { ...ref(preview), changes: { fontSize: 44 } })
    await manager.createTab(task, { url: `${origin}/b` }); const b = native(), bId = manager.target(task).tabId
    manager.selectTab(browserTabTarget(manager.getTabs(task), aId)); await controller.invalidateTab(aId)
    await assert.rejects(controller.draft(win.webContents.id, ref(preview)), /过期|变化/)
    assert.equal(await a.executeJavaScript(`getComputedStyle(document.querySelector('#fixture')).fontSize`), '16px')
    assert.equal(await b.executeJavaScript(`getComputedStyle(document.querySelector('#fixture')).fontSize`), '16px')
    pass('A to B to A rolls back the original native page and invalidates its old preview')
    preview = await pick()
    const originalExecute = a.executeJavaScriptInIsolatedWorld.bind(a)
    let resumeApply!: () => void, applied!: () => void
    const reachedApply = new Promise<void>(resolve => { applied = resolve })
    a.executeJavaScriptInIsolatedWorld = async (...args: Parameters<WebContents['executeJavaScriptInIsolatedWorld']>) => {
      const result = await originalExecute(...args)
      if (args[1][0].code.includes('return globalThis[key]["apply"]')) { applied(); await new Promise<void>(resolve => { resumeApply = resolve }) }
      return result
    }
    const delayedApply = controller.preview(win.webContents.id, { ...ref(preview), changes: { fontSize: 60 } }).then(() => undefined, error => error)
    await reachedApply
    manager.selectTab(browserTabTarget(manager.getTabs(task), bId)); await controller.invalidateTab(aId)
    resumeApply(); assert.ok(await delayedApply instanceof Error)
    a.executeJavaScriptInIsolatedWorld = originalExecute
    assert.equal(await a.executeJavaScript(`getComputedStyle(document.querySelector('#fixture')).fontSize`), '16px')
    assert.equal(await b.executeJavaScript(`getComputedStyle(document.querySelector('#fixture')).fontSize`), '16px')
    manager.selectTab(browserTabTarget(manager.getTabs(task), aId))
    pass('an in-flight apply is reverted on its original page and its late result is rejected after tab switch')
    preview = await pick(); preview = await controller.preview(win.webContents.id, { ...ref(preview), changes: { fontSize: 45 } })
    manager.setVisible(task, false, win); await controller.invalidateTab(aId)
    assert.equal(await a.executeJavaScript(`getComputedStyle(document.querySelector('#fixture')).fontSize`), '16px')
    manager.setVisible(task, true, win)
    pass('hiding the browser cleans up its original preview')
    preview = await pick(); preview = await controller.preview(win.webContents.id, { ...ref(preview), changes: { fontSize: 46 } })
    const loaded = once(a, 'did-finish-load'); a.reload(); await loaded
    await assert.rejects(controller.draft(win.webContents.id, ref(preview)), /过期|变化/)
    assert.equal(await a.executeJavaScript(`getComputedStyle(document.querySelector('#fixture')).fontSize`), '16px')
    // A pick after reload must bootstrap the new document token correctly.
    preview = await pick(); await controller.release(win.webContents.id, { previewId: preview.id, target: preview.target })
    pass('same-URL reload invalidates the document and a fresh selection still works')
    const pendingPort = port(), pendingId = randomUUID(), pending = controller.pick(pendingPort, pendingId)
    await controller.release(win.webContents.id, { previewId: pendingId, target: pendingPort.target })
    assert.deepEqual(await pending, { cancelled: true })
    assert.equal(await a.executeJavaScript(`Array.from(document.documentElement.children).some(node => node.style?.cursor === 'crosshair')`), false)
    pass('panel close can cancel a picker before native injection has started')
    const visiblePort = port(), visibleId = randomUUID(), visiblePending = controller.pick(visiblePort, visibleId)
    await waitFor(async () => a.executeJavaScript(`Array.from(document.documentElement.children).some(node => node.style?.cursor === 'crosshair')`))
    await controller.release(win.webContents.id, { previewId: visibleId, target: visiblePort.target })
    assert.deepEqual(await visiblePending, { cancelled: true })
    assert.equal(await a.executeJavaScript(`Array.from(document.documentElement.children).some(node => node.style?.cursor === 'crosshair')`), false)
    pass('panel close cancels a visible picker and removes its native interception layer')
    preview = await pick(); preview = await controller.preview(win.webContents.id, { ...ref(preview), changes: { fontSize: 47 } })
    manager.closeTab(manager.target(task)); await waitFor(async () => a.isDestroyed())
    assert.equal(manager.target(task).tabId, bId); assert.equal(await b.executeJavaScript(`getComputedStyle(document.querySelector('#fixture')).fontSize`), '16px')
    await assert.rejects(controller.draft(win.webContents.id, ref(preview)), /过期|变化/)
    pass('closing a native tab cannot move its preview or draft to the replacement tab')
    console.log(`Browser style real Electron loopback: ${checks}/${checks} passed; no Provider calls; temporary profile and fixture files only.`)
  } finally { manager.close(task); win.destroy(); server.closeAllConnections(); server.close() }
}
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8_000
  while (!await check()) { if (Date.now() > deadline) throw new Error('Fixture operation timed out'); await new Promise(resolve => setTimeout(resolve, 25)) }
}
