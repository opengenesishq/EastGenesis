import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { browserViewManager as manager } from '../src/main/browserView'
import { browserManagement } from '../src/main/browser-management/service'

export async function run(root: string): Promise<void> {
  const outputs = join(root, 'outputs'); mkdirSync(outputs)
  app.setPath('downloads', outputs)
  let blockedHits = 0
  const blocked = createServer((_req, res) => { blockedHits++; res.writeHead(200); res.end('blocked destination') })
  blocked.listen(0, '127.0.0.1'); await once(blocked, 'listening')
  const blockedOrigin = `http://127.0.0.1:${(blocked.address() as { port: number }).port}`
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/redirect')) { res.writeHead(302, { location: `${blockedOrigin}/blocked` }); res.end(); return }
    if (req.url?.startsWith('/download')) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="fixture.txt"' }); res.end('trusted local fixture bytes'); return }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Local browser management fixture</title><h1>Local only</h1>')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const win = new BrowserWindow({ show: false, width: 600, height: 400, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } })
  let checks = 0
  const pass = (label: string): void => { checks++; console.log(`PASS ${checks}: ${label}`) }
  try {
    await win.loadURL('about:blank')
    const service = browserManagement(), store = service.store
    assert.equal(store.getPreferences().preferences.recordHistory, false)
    await manager.open(win, 'management-fixture', `${origin}/start?token=do-not-store#fragment`)
    assert.equal(store.listHistory().items.length, 0)
    pass('history is disabled by default even for actual native navigation')
    const initial = store.getPreferences()
    service.save(initial.revision, { ...initial.preferences, recordHistory: true, askDownloadLocation: false,
      siteRules: [{ origin: blockedOrigin, access: 'block', downloads: 'inherit' }] })
    await manager.navigate('management-fixture', `${origin}/tracked?api_key=private-fixture-value#fragment`)
    const history = store.listHistory().items
    assert.equal(history.length, 1); assert.equal(history[0].url, `${origin}/tracked`)
    const historyFile = readFileSync(join(root, 'browser-management', 'history.json'), 'utf8')
    assert.equal(historyFile.includes('private-fixture-value'), false); assert.equal(historyFile.includes('token='), false)
    pass('history records actual committed pages and strips URL query/fragment values')
    await assert.rejects(manager.navigate('management-fixture', `${blockedOrigin}/direct`), /站点已阻止/)
    await assert.rejects(manager.navigate('management-fixture', `${origin}/redirect`), /ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/)
    assert.equal(blockedHits, 0)
    pass('blocked direct navigation and redirect never reach destination server')
    await manager.navigate('management-fixture', `${origin}/host`)
    const wc = manager.assertTarget(manager.target('management-fixture')).view.webContents
    const fetched = await wc.executeJavaScript(`fetch(${JSON.stringify(`${blockedOrigin}/subresource`)}).then(() => 'unexpected').catch(() => 'blocked')`)
    assert.equal(fetched, 'blocked'); assert.equal(blockedHits, 0)
    pass('blocked subresource fetch is enforced inside the actual page')
    wc.downloadURL(`${origin}/download`)
    await waitFor(() => store.listDownloads().some(item => item.state === 'completed'))
    const first = store.listDownloads().find(item => item.state === 'completed')!
    assert.equal(readFileSync(first.savePath!, 'utf8'), 'trusted local fixture bytes')
    assert.equal(first.contextId, 'management-fixture'); assert.equal(first.tabId, manager.target('management-fixture').tabId)
    assert.equal(readdirSync(join(root, 'browser-management', 'download-staging')).length, 0)
    pass('real native download publishes exact bytes with original tab identity and clears staging')
    writeFileSync(first.savePath!, 'existing user content')
    wc.downloadURL(`${origin}/download`)
    await waitFor(() => store.listDownloads().filter(item => item.state === 'completed').length === 2)
    const second = store.listDownloads().find(item => item.state === 'completed' && item.id !== first.id)!
    assert.notEqual(second.savePath, first.savePath); assert.equal(readFileSync(first.savePath!, 'utf8'), 'existing user content')
    pass('a duplicate filename does not overwrite an existing output')
    const settings = store.getPreferences()
    service.save(settings.revision, { ...settings.preferences, siteRules: [...settings.preferences.siteRules, { origin, access: 'allow', downloads: 'block' }] })
    wc.downloadURL(`${origin}/download`)
    await waitFor(() => store.listDownloads().some(item => item.state === 'blocked'))
    assert.equal(readdirSync(outputs).length, 2)
    pass('download-specific site rule blocks actual DownloadItem without publishing files')
    const visible = store.listHistory().items.map(item => item.id)
    await manager.navigate('management-fixture', `${origin}/after-snapshot`)
    store.clearHistory(visible)
    assert.equal(store.listHistory().items.length, 1); assert.equal(store.listHistory().items[0].url, `${origin}/after-snapshot`)
    pass('clearing a history snapshot preserves later visits')
    assert.throws(() => service.save(settings.revision, settings.preferences), /其他窗口/)
    pass('stale preferences revision cannot overwrite a newer policy')
    const finalSettings = store.getPreferences(), oldTarget = manager.target('management-fixture')
    service.save(finalSettings.revision, { ...finalSettings.preferences, siteRules: [{ origin, access: 'block', downloads: 'inherit' }] })
    await waitFor(() => wc.getURL() === 'about:blank')
    assert.throws(() => manager.assertTarget(oldTarget, true, true), /原操作失效/)
    pass('blocking the current site unloads its document and invalidates earlier page approvals')
    console.log(`Browser management real Electron loopback: ${checks}/${checks} passed; all files under temporary fixture root.`)
  } finally {
    manager.close('management-fixture'); win.destroy(); server.closeAllConnections(); server.close(); blocked.closeAllConnections(); blocked.close()
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000
  while (!check()) { if (Date.now() > deadline) throw new Error('Fixture operation timed out'); await new Promise(resolve => setTimeout(resolve, 25)) }
}
