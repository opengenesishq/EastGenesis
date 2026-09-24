import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { browserExtensionBridge as bridge } from '../src/main/browser-extension/bridge'
import { ExternalBrowserRegistry } from '../src/main/external-browser-registry'
import { BROWSER_EXTENSION_PACKAGE_ID } from '../src/shared/browser-extension-package'

async function run(): Promise<void> {
const profile = mkdtempSync(join(tmpdir(), 'caogen-extension-native-'))
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><meta charset="utf-8"><title>Controlled ${req.url}</title><body style="background:${req.url === '/b' ? '#ff0000' : '#00ff00'}"><h1>Controlled page ${req.url}</h1><input id="name"><button id="increment" onclick="document.querySelector('#count').textContent=String(++window.count)">Increment</button><span id="count">0</span><script>window.count=0</script></body>`) })
server.listen(0,'127.0.0.1'); await once(server,'listening')
const origin=`http://127.0.0.1:${(server.address() as { port:number }).port}`
const owner = Object.assign(new EventEmitter(), { webContents: { id: 7001 }, isDestroyed: () => false })
const registry = new ExternalBrowserRegistry()
let browser: Browser | undefined, checks=0
const pass=(message:string):void=>{checks++;console.log(`PASS ${checks}: ${message}`)}
try {
  browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,userDataDir:profile,
    enableExtensions:[resolve('resources/browser-extension')],args:['--no-first-run','--no-default-browser-check'],timeout:20000})
  const workerTarget = await browser.waitForTarget(target => target.type()==='service_worker' && target.url().startsWith(`chrome-extension://${BROWSER_EXTENSION_PACKAGE_ID}/`))
  const worker = await workerTarget.worker(); assert.ok(worker)
  const a=await browser.newPage(); await a.goto(`${origin}/a`)
  const b=await browser.newPage(); await b.goto(`${origin}/b`); await a.bringToFront()
  const aId = await worker.evaluate(async () => { const tabs=await (globalThis as any).chrome.tabs.query({active:true,currentWindow:true});return tabs[0].id })
  const connection=registry.create({sessionId:'extension-fixture',vendor:'chrome',transport:'extension',extensionId:BROWSER_EXTENSION_PACKAGE_ID},owner as never)
  const pairing=await bridge.create(connection.id,BROWSER_EXTENSION_PACKAGE_ID,'Controlled extension fixture')
  const connecting=registry.connect(connection.id,owner as never)
  void connecting.catch(()=>undefined)
  await worker.evaluate(() => (globalThis as any).chrome.action.openPopup())
  const popupTarget=await browser.waitForTarget(target=>target.url()===`chrome-extension://${BROWSER_EXTENSION_PACKAGE_ID}/popup.html`)
  let popup=await popupTarget.asPage()
  const invoke = async (type:string,args:Record<string,unknown>={}) => {
    const result = await popup.evaluate((input) => (globalThis as any).chrome.runtime.sendMessage(input),{type,...args})
    if(!result.ok)throw new Error(result.error);return result.value
  }
  await invoke('pair',{code:pairing.pairingCode})
  assert.throws(()=>registry.forTask('extension-fixture'),/未连接|断开/)
  assert.equal((await invoke('status')).attached,false)
  pass('real MV3 extension loads in isolated Chrome and pairing alone grants no tab access')
  await a.bringToFront()
  await invoke('authorize',{tabId:aId})
  const connected=await connecting
  assert.equal(connected.tabs.length,1);assert.equal(connected.connection.selectedTabId,undefined)
  assert.throws(()=>registry.forTask('extension-fixture'),/选择/)
  await registry.selectTabLive(connection.id,owner as never,connected.tabs[0].tabId)
  let task=registry.forTask('extension-fixture')!
  pass('explicit extension authorization attaches exactly one tab; CaoGen selection is separately required')
  const source=await task.readPage();assert.match(source.text,/Controlled page \/a/);assert.equal(source.url,`${origin}/a`)
  pass('fixed isolated-world DOM reader returns the original selected page and source URL')
  let approved=await task.captureMutationPage('browser_type',{selector:'#name',text:'Local only'})
  await task.typeText('#name','Local only',approved)
  assert.equal(await a.$eval('#name',node=>(node as HTMLInputElement).value),'Local only')
  approved=await task.captureMutationPage('browser_click',{selector:'#increment'})
  await task.click('#increment',approved);assert.equal(await a.$eval('#count',node=>node.textContent),'1')
  pass('fixed type and click execute after node/form-bound approval on the real page')
  approved=await task.captureMutationPage('browser_click',{selector:'#increment'})
  await a.evaluate(()=>{const node=document.querySelector('#increment')!;node.outerHTML=node.outerHTML})
  await assert.rejects(task.click('#increment',approved),/目标|审批|变化/)
  assert.equal(await a.$eval('#count',node=>node.textContent),'1')
  pass('replacing the same-selector node invalidates the earlier action approval')
  await b.bringToFront()
  const screenshot=await task.screenshot(),png=readFileSync(screenshot)
  assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10])
  const screenshotData=await import('pngjs');const decoded=screenshotData.PNG.sync.read(png)
  const offset=(Math.floor(decoded.height/2)*decoded.width+Math.floor(decoded.width/2))*4
  assert.ok(decoded.data[offset+1]>200&&decoded.data[offset]<30,'Screenshot should show green page A, not red foreground B')
  rmSync(screenshot)
  approved=await task.captureMutationPage('browser_click',{selector:'#increment'});await task.click('#increment',approved)
  assert.equal(await a.$eval('#count',node=>node.textContent),'2');assert.equal(await b.$eval('#count',node=>node.textContent),'0')
  pass('foreground B stays untouched while screenshot and click remain bound to authorized page A')
  await assert.rejects(task.captureMutationPage('browser_evaluate',{script:'location.href'}),/不支持|固定/)
  await assert.rejects(task.evaluate('1',approved),/不一致|不接受/)
  await task.waitFor('#increment',1000)
  pass('wait uses a fixed action and arbitrary evaluate is explicitly rejected')
  const stale=await task.captureMutationPage('browser_click',{selector:'#increment'})
  await a.reload();await waitFor(()=>!bridge.page(connection.id).loading)
  await assert.rejects(task.click('#increment',stale),/版本|变化|审批/)
  approved=await task.captureMutationPage('browser_evaluate',{url:`${origin}/next`})
  await task.navigate(`${origin}/next`,approved)
  assert.equal(a.url(),`${origin}/next`);assert.match((await task.readPage()).text,/Controlled page \/next/)
  pass('same-URL reload invalidates old approval; explicit navigation uses the same authorized tab')
  const before=task
  await registry.selectTabLive(connection.id,owner as never,connected.tabs[0].tabId)
  await assert.rejects(before.readPage(),/绑定已变化/)
  task=registry.forTask('extension-fixture')!
  const pending=await task.captureMutationPage('browser_click',{selector:'#increment'})
  await worker.evaluate(() => (globalThis as any).chrome.action.openPopup())
  popup=await (await browser.waitForTarget(target=>target.url()===`chrome-extension://${BROWSER_EXTENSION_PACKAGE_ID}/popup.html`)).asPage()
  await invoke('revoke')
  await waitFor(()=>registry.taskStatus('extension-fixture')?.status==='disconnected')
  await assert.rejects(task.click('#increment',pending),/连接|断开|撤销/)
  const detached=await worker.evaluate(async id=>{try{await (globalThis as any).chrome.debugger.sendCommand({tabId:id},'Page.getFrameTree');return false}catch{return true}},aId)
  assert.equal(detached,true)
  pass('selection changes invalidate held bindings and extension revoke detaches the original tab immediately')
  console.log(`Browser extension real Chrome loopback: ${checks}/${checks} passed; temporary isolated profile, controlled local pages, no Provider or daily-profile access.`)
} finally {
  registry.revokeForSession('extension-fixture');bridge.close();await browser?.close();server.closeAllConnections();server.close()
  rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200})
}
}
async function waitFor(check:()=>boolean):Promise<void>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error('State timeout');await new Promise(resolve=>setTimeout(resolve,25))}}
void run().catch(error => { console.error(error); process.exitCode=1 })
