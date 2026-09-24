import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { Module } from 'node:module'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
const BROWSER_EXTENSION_PACKAGE_ID = /'([a-p]{32})'/.exec(readFileSync('src/shared/browser-extension-package.ts','utf8'))[1]

const key='__caogenExtensionIpcFixture',handlers=new Map(),owners=new Map(),entries=new Map(),pairs=[]
for(const [id,role,taskId] of [[1,'main'],[2,'task','one'],[3,'task','other'],[4,'companion']]){
 const mainFrame={};owners.set(id,{role,taskId,webContents:{id,mainFrame},isDestroyed:()=>false})
}
const registry={create(input,owner){const prior=[...entries.values()].find(entry=>entry.sessionId===input.sessionId);if(prior&&prior.owner!==owner)throw new Error('owner mismatch');const entry={id:`connection-${input.sessionId}`,sessionId:input.sessionId,owner};entries.set(entry.id,entry);return entry},get(id,owner){const entry=entries.get(id);if(!entry||entry.owner!==owner)throw new Error('owner mismatch');return entry},async connect(){},revoke:id=>entries.delete(id)}
globalThis[key]={electron:{app:{once(){},isPackaged:false,getAppPath:()=>process.cwd()},BrowserWindow:{fromWebContents:sender=>owners.get(sender.id)},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},shell:{openPath:async()=>''}},registry,bridge:{async create(id,extensionId,title){pairs.push({id,extensionId,title});return{pairingCode:'CG1.12345.fixture',expiresAt:123}},revoke(){},close(){}}}
try{
 const result=await build({stdin:{contents:`export { registerBrowserExtensionIpc } from './src/main/ipc/browser-extension-handlers'`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',target:'node22',packages:'external',plugins:[{name:'fixture',setup(builder){
  builder.onResolve({filter:/^electron$|(?:^|\/)(?:workflow-ledger-handlers|desktop-window-registry|task-window|external-browser-registry)$|browser-extension\/bridge$/},args=>({path:args.path.split('/').at(-1),namespace:'fixture'}))
  builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:{electron:`module.exports=globalThis.${key}.electron`,'external-browser-registry':`module.exports={externalBrowserRegistry:globalThis.${key}.registry}`,bridge:`module.exports={browserExtensionBridge:globalThis.${key}.bridge}`,'workflow-ledger-handlers':'module.exports={assertTrustedWorkflowLedgerSender:event=>{if(![1,2,3,4].includes(event.sender?.id))throw new Error("untrusted")}}','desktop-window-registry':'module.exports={desktopWindowRole:win=>win.role}','task-window':'module.exports={taskSessionForWindow:win=>win.taskId}'}[args.path]}))
 }}]})
 const file=resolve('scripts/.extension-ipc.cjs'),mod=new Module(file);mod.filename=file;mod.paths=Module._nodeModulePaths(dirname(file));mod._compile(result.outputFiles[0].text,file)
 let closed=false
 mod.exports.registerBrowserExtensionIpc({getSessionMeta:id=>['one','other'].includes(id)?{id,title:`Task ${id}`,status:closed?'closed':'idle'}:undefined})
 const event=id=>({sender:owners.get(id)?.webContents??{id},senderFrame:owners.get(id)?.webContents.mainFrame})
 const pair=(id,sessionId='one',extensionId=BROWSER_EXTENSION_PACKAGE_ID)=>handlers.get('browser-extension:pair')(event(id),{sessionId,vendor:'chrome',extensionId})
 assert.equal((await pair(3)).ok,false);assert.equal((await pair(4)).ok,false);assert.equal((await pair(8)).ok,false);assert.equal(pairs.length,0)
 console.log('PASS 1: other-task windows, companions and untrusted senders cannot start pairing')
 closed=true;assert.equal((await pair(1)).ok,false);closed=false
 assert.equal((await pair(1,'missing')).ok,false);assert.equal((await pair(1,'one','not-an-extension-id')).ok,false);assert.equal(pairs.length,0)
 console.log('PASS 2: missing/closed tasks and invalid extension ids are rejected before issuing a code')
 const good=await pair(2);assert.equal(good.ok,true);assert.equal(pairs[0].title,'Task one');assert.equal(pairs[0].extensionId,BROWSER_EXTENSION_PACKAGE_ID)
 assert.equal((await pair(1)).ok,false)
 console.log('PASS 3: detached task pairing captures its actual task and cannot be taken by another window')
 const folder=await handlers.get('browser-extension:directory')(event(1));assert.equal(folder.path,resolve('resources/browser-extension'));assert.equal(folder.version,'0.1.0')
 await assert.rejects(handlers.get('browser-extension:directory')(event(4)))
 console.log('PASS 4: trusted window opens only the packaged extension directory')
 console.log('Browser extension IPC boundaries: 4/4 passed; local fixture only.')
}finally{delete globalThis[key]}
