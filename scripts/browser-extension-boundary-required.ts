import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { BrowserExtensionBridge } from '../src/main/browser-extension/bridge'
import { BROWSER_EXTENSION_PACKAGE_ID } from '../src/shared/browser-extension-package'

async function run(): Promise<void> {
  const bridge = new BrowserExtensionBridge(), sockets: WebSocket[] = []
  let checks=0
  const pass=(label:string):void=>{checks++;console.log(`PASS ${checks}: ${label}`)}
  const open=async(code:string,origin=`chrome-extension://${BROWSER_EXTENSION_PACKAGE_ID}`):Promise<WebSocket>=>{
    const [,port]=code.split('.'),socket=new WebSocket(`ws://127.0.0.1:${port}/bridge`,{origin});sockets.push(socket)
    await once(socket,'open');return socket
  }
  try {
    const first=await bridge.create('one',BROWSER_EXTENSION_PACKAGE_ID,'Fixture task')
    await assert.rejects(open(first.pairingCode,'https://untrusted.example'),/hang up|closed|ECONNRESET/)
    await assert.rejects(open(first.pairingCode,'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),/hang up|closed|ECONNRESET/)
    pass('loopback bridge refuses webpage Origins and other extension ids before authentication')
    const bad=await open(first.pairingCode),closed=once(bad,'close')
    bad.send(JSON.stringify({type:'hello',protocol:1,token:'a'.repeat(64)}));await closed
    pass('incorrect high-entropy pairing token cannot authenticate')
    const socket=await open(first.pairingCode),welcome=once(socket,'message')
    socket.send(JSON.stringify({type:'hello',protocol:1,token:first.pairingCode.split('.')[2]}))
    const paired=JSON.parse((await welcome)[0].toString()),identity={epoch:paired.epoch,capability:paired.capability}
    assert.equal(paired.type,'paired');assert.equal(paired.taskTitle,'Fixture task')
    assert.throws(()=>bridge.page('one'),/连接|断开/)
    await assert.rejects(open(first.pairingCode),/hang up|closed|ECONNRESET/)
    pass('pairing alone exposes no page and the consumed token cannot open a second connection')
    const waiting=bridge.wait('one',()=>undefined)
    const page={tabId:'extension-tab:7',url:'http://127.0.0.1:8123/local',title:'Local',revision:1,loading:false}
    socket.send(JSON.stringify({type:'ready',...identity,page}));await waiting
    assert.equal(bridge.page('one').tabId,page.tabId)
    assert.throws(()=>bridge.assert('one','extension-tab:8'),/变化/)
    await assert.rejects(bridge.request('one','read',{},0),/变化/)
    await assert.rejects(bridge.request('one','Runtime.evaluate' as never,{},1),/不支持/)
    pass('only the explicitly authorized tab and fixed operations at the current revision are accepted')
    const command=once(socket,'message'),reading=bridge.request('one','read',{},1)
    const request=JSON.parse((await command)[0].toString())
    assert.equal(request.tabId,page.tabId);assert.equal(request.operation,'read')
    socket.send(JSON.stringify({type:'result',...identity,requestId:request.requestId,tabId:page.tabId,revision:1,ok:true,value:{text:'Local source'}}))
    assert.deepEqual(await reading,{text:'Local source'})
    pass('request/response carries exact capability, request id, tab and page revision')
    const pendingCommand=once(socket,'message'),pending=bridge.request('one','click',{},1)
    void pending.catch(()=>undefined)
    const pendingRequest=JSON.parse((await pendingCommand)[0].toString())
    bridge.revoke('one')
    await assert.rejects(pending,/撤销|断开/);assert.throws(()=>bridge.page('one'),/断开|撤销/)
    assert.equal(pendingRequest.operation,'click')
    pass('revocation rejects an outstanding write result and removes the capability without retry')
    const expiring=await bridge.create('expires',BROWSER_EXTENSION_PACKAGE_ID,'Expiring task'),dateNow=Date.now
    try { Date.now=()=>expiring.expiresAt+1;await assert.rejects(open(expiring.pairingCode),/hang up|closed|ECONNRESET/) } finally { Date.now=dateNow }
    pass('expired pairing codes cannot connect')
    console.log(`Browser extension bridge boundaries: ${checks}/${checks} passed; controlled local WebSockets only.`)
  } finally { bridge.close();for(const socket of sockets)socket.terminate() }
}
void run().catch(error=>{console.error(error);process.exitCode=1})
