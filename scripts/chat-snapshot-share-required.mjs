import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Module } from 'node:module'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(),'caogen-chat-share-')), cwd = join(root,'project'), data = join(root,'data')
mkdirSync(cwd); mkdirSync(data)
const script = join(root,'adapter.cjs'), modeFile = join(root,'mode'), requestsFile = join(root,'requests.jsonl')
const oldFetch = globalThis.fetch
globalThis.fetch = async () => { throw Error('Real network forbidden') }
let groups = 0
const pass = text => { groups++; console.log(`PASS ${text}`) }
try {
  writeFileSync(modeFile,'normal')
  writeFileSync(script, `const fs=require('node:fs'),crypto=require('node:crypto');let body='';process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>{const r=JSON.parse(body),mode=fs.readFileSync(${JSON.stringify(modeFile)},'utf8');fs.appendFileSync(${JSON.stringify(requestsFile)},JSON.stringify(r)+'\\n');const account={adapterNamespace:'fixture',accountScope:mode==='account'?'foreign-account':'account-a',targetId:'share-target',accountName:'Local fixture',capabilities:{publish:true,revoke:true,inspect:true,idempotent:true,conditionalRevoke:mode!=='capability'}};if(r.operation==='publish'){const entries=fs.readdirSync(r.directory);if(entries.length!==1||entries[0]!=='index.html')throw Error('unexpected bundle');const html=fs.readFileSync(r.directory+'/index.html');if(crypto.createHash('sha256').update(html).digest('hex')!==r.manifestDigest)throw Error('bundle digest');if(html.includes('fixture-secret')||html.includes('TOOL-PRIVATE')||html.includes('THINKING-PRIVATE'))throw Error('secret in bundle');}const output={protocol:r.protocol,requestId:r.requestId,operationId:r.operationId,operation:r.operation,account};for(const k of ['shareId','snapshotId','manifestDigest','expectedRevision','originalAction'])if(r[k]!==undefined)output[k]=r[k];if(mode==='wrong-share'&&r.operation!=='describe')output.shareId='foreign-share';if(r.operation!=='describe'){output.result=mode==='unknown'?'unknown':mode==='not-applied'?'not_applied':'applied';const action=r.originalAction||r.operation;output.publicState=mode==='unknown'?'unknown':action==='revoke'?(mode==='not-applied'?'active':'revoked'):(mode==='not-applied'?'absent':'active');output.revision=action==='revoke'&&mode==='not-applied'?r.expectedRevision:'revision-1';if(output.publicState==='active')output.url='https://shares.invalid/'+r.shareId;}if(mode==='credential-url')output.url='https://user:fixture-secret@shares.invalid/path';const send=()=>process.stdout.write('CAOGEN_CHAT_SHARE_RESULT '+JSON.stringify(output)+'\\n');if(mode==='delay'&&r.operation==='publish')setTimeout(send,150);else if(mode==='hang'&&r.operation==='publish')setTimeout(send,10000);else send();});`)
  const built = await build({ stdin:{ contents:"export * from './src/main/sharing/chat-snapshot-share-service'; export * from './src/main/sharing/chat-share-protocol'; export * from './src/main/sharing/chat-snapshot-projection';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',packages:'external',write:false })
  const filename = resolve('scripts/.chat-share-fixture.cjs'), loaded = new Module(filename)
  loaded.filename=filename;loaded.paths=Module._nodeModulePaths(dirname(filename));loaded._compile(built.outputFiles[0].text,filename)
  const api=loaded.exports
  let entries=[
    {seq:1,eventId:'event-1',event:{kind:'user-message',text:'Review /Users/fixture/private/report.txt and api_key=fixture-secret',attachments:[{id:'attachment-private',path:'/private/attachment'}]}},
    {seq:2,eventId:'event-2',event:{kind:'assistant-message',blocks:[{type:'thinking',thinking:'THINKING-PRIVATE'},{type:'text',text:'Visible answer'},{type:'tool_use',id:'tool',name:'bash',input:{command:'TOOL-PRIVATE'}}]}},
    {seq:3,eventId:'event-3',event:{kind:'tool-result',content:'TOOL-PRIVATE',toolUseId:'tool'}},
    {seq:4,eventId:'event-4',event:{kind:'turn-result',resultText:'Safe answer <script>alert(1)</script> <img src="https://external.invalid/track">',isError:false}},
    {seq:5,eventId:'event-5',event:{kind:'user-message',text:'Unfinished private request'}},
    {seq:6,eventId:'event-6',event:{kind:'assistant-message',blocks:[{type:'text',text:'Unfinished answer'}]}}
  ]
  let meta={id:'fixture-session',createdAt:1,cwd,workspaceId:'project',goalId:'goal',workItemId:'item',status:'idle',taskStrategy:'execute',title:'Private /Users/fixture/project title'}
  const target={id:'target',revision:1,name:'Fixture deployment',outputDirectory:'dist',executable:process.execPath,deployArgs:[],rollbackArgs:[],inspectArgs:[],environmentKeys:[],timeoutSeconds:5}
  let authorityKey='grant-1',effects=0,authorizations=0,scopeLive=true
  const host={root:data,home:'/Users/fixture',session:()=>meta,transcript:()=>entries,targets:async()=>[target],authority:()=>authorityKey,
    authorize:async()=>{authorizations++},effect:async(_source,r,execute,success)=>{effects++;const value=await execute();return{status:success(value)?'completed':'waiting_reconciliation',operationId:r.operationId,effectId:'effect-'+r.operationId,snapshotId:'operation:'+r.operationId,value}}}
  let service=new api.ChatSnapshotShareService(host)
  const scope={owner:1,assertCurrent(){if(!scopeLive)throw Error('window closed')}}, taskScope={owner:2,sessionId:'foreign',assertCurrent(){}}
  let source=service.capture(meta.id,scope)
  assert.equal(source.messages.length,2);assert.equal(source.omittedAttachments,1);assert.equal(source.incompleteTurns,1)
  assert(!JSON.stringify(source).includes('fixture-secret'));assert(!JSON.stringify(source).includes('TOOL-PRIVATE'));assert(!JSON.stringify(source).includes('THINKING-PRIVATE'));assert(!JSON.stringify(source).includes('/Users/fixture'))
  let content=await service.prepareSnapshot(meta.id,{sourcePreviewId:source.id,title:'Published title',selectedMessageIds:source.messages.map(message=>message.id),replacements:{[source.messages[0].id]:'User reviewed cookie=fixture-secret /Users/fixture/private'}},scope)
  assert(!content.html.includes('fixture-secret'));assert(!content.html.includes('session'));assert(!content.html.includes('event-1'));assert(!content.html.includes('<script>'));assert(!content.html.includes('<img '));assert(content.html.includes('&lt;script&gt;'));assert(content.html.includes("default-src 'none'"))
  assert.equal(effects,0);assert.equal(authorizations,0)
  assert.throws(()=>service.readSnapshot(content.snapshot.id,taskScope),/不属于当前任务窗口/)
  assert.throws(()=>service.list(taskScope,meta.id),/不属于当前任务窗口/)
  pass('completed visible messages only, credential/path redaction after edits, escaped inert HTML and no hidden transcript/tool/attachment payload')

  source=service.capture(meta.id,scope);entries=[...entries,{seq:7,event:{kind:'status',status:'idle'}}]
  await assert.rejects(service.prepareSnapshot(meta.id,{sourcePreviewId:source.id,title:'changed',selectedMessageIds:[source.messages[0].id]},scope),/原对话已变化/)
  const frozen=service.readSnapshot(content.snapshot.id,scope)
  assert.equal(frozen.html,content.html)
  source=service.capture(meta.id,scope)
  await assert.rejects(service.prepareSnapshot(meta.id,{sourcePreviewId:source.id,title:'wrong',selectedMessageIds:['foreign']},scope),/不属于原脱敏/)
  meta={...meta,createdAt:2}
  await assert.rejects(service.prepareSnapshot(meta.id,{sourcePreviewId:source.id,title:'wrong',selectedMessageIds:[source.messages[0].id]},scope),/归属已变化/)
  meta={...meta,createdAt:1}
  pass('source changes and foreign message IDs reject preparation; frozen snapshot survives later conversation changes')

  const adapter=await service.saveAdapter(meta.id,{name:'Fixture shares',deploymentTargetId:'target',deploymentTargetRevision:1,args:[script]},scope)
  let preview=await service.prepareOperation({action:'publish',snapshotId:content.snapshot.id,adapterId:adapter.id},scope)
  assert.equal(preview.account.accountScope,'account-a')
  writeFileSync(modeFile,'delay')
  const concurrent=await Promise.all([service.execute(preview.id,scope),service.execute(preview.id,scope)])
  const confirmed=concurrent.find(value=>value.status==='confirmed')
  assert(confirmed);assert.match(confirmed.url,/^https:\/\/shares.invalid\//)
  let requests=readFileSync(requestsFile,'utf8').trim().split('\n').map(line=>JSON.parse(line))
  assert.equal(requests.filter(value=>value.operation==='publish').length,1)
  assert(!requests.find(value=>value.operation==='describe').directory)
  await assert.rejects(service.prepareOperation({action:'publish',snapshotId:content.snapshot.id,adapterId:adapter.id},scope),/已经发布/)
  assert(authorizations>0)
  pass('configured user adapter sees only reviewed bundle; account-bound receipt, one publication under concurrent execute, no duplicate publish')

  writeFileSync(modeFile,'normal')
  meta=undefined
  preview=await service.prepareOperation({action:'revoke',snapshotId:content.snapshot.id,shareId:confirmed.shareId},scope)
  assert.equal(preview.expectedRevision,'revision-1')
  rmSync(service.store.bundle(content.snapshot.id),{recursive:true,force:true})
  const revoked=await service.execute(preview.id,scope)
  assert.equal(revoked.status,'confirmed');assert.equal(revoked.publicState,'revoked')
  requests=readFileSync(requestsFile,'utf8').trim().split('\n').map(line=>JSON.parse(line))
  const revokeRequest=requests.find(value=>value.operation==='revoke')
  assert.equal(revokeRequest.shareId,confirmed.shareId);assert.equal(revokeRequest.expectedRevision,'revision-1');assert.equal(revokeRequest.directory,undefined)
  await assert.rejects(service.prepareOperation({action:'revoke',snapshotId:content.snapshot.id,shareId:confirmed.shareId},scope),/已经撤销/)
  assert.equal(service.list(scope).receipts.length,2)
  pass('exact share and revision revoked after original task and public bundle are removed; no content upload or whole-site mutation')

  meta={id:'fixture-session',createdAt:1,cwd,status:'idle',taskStrategy:'execute',title:'Fixture'}
  source=service.capture(meta.id,scope)
  content=await service.prepareSnapshot(meta.id,{sourcePreviewId:source.id,title:'Unknown result',selectedMessageIds:source.messages.map(message=>message.id)},scope)
  preview=await service.prepareOperation({action:'publish',snapshotId:content.snapshot.id,adapterId:adapter.id},scope)
  writeFileSync(modeFile,'unknown')
  const unknown=await service.execute(preview.id,scope)
  assert.equal(unknown.status,'needs_reconciliation')
  await assert.rejects(service.prepareOperation({action:'publish',snapshotId:content.snapshot.id,adapterId:adapter.id},scope),/待核对/)
  service=new api.ChatSnapshotShareService(host)
  assert.equal(service.list(scope).receipts.find(value=>value.id===unknown.id).status,'needs_reconciliation')
  writeFileSync(modeFile,'wrong-share')
  await assert.rejects(service.inspect(unknown.id,scope),/适配器读取未完成/)
  assert.equal(service.list(scope).receipts.find(value=>value.id===unknown.id).status,'needs_reconciliation')
  writeFileSync(modeFile,'normal')
  await service.inspect(unknown.id,scope)
  assert.equal(service.receipt(unknown.id,scope).inspection.result,'applied')
  const reconciled=await service.acceptInspection(unknown.id,scope)
  assert.equal(reconciled.status,'confirmed')
  requests=readFileSync(requestsFile,'utf8').trim().split('\n').map(line=>JSON.parse(line))
  assert.equal(requests.filter(value=>value.operation==='publish'&&value.shareId===unknown.shareId).length,1)
  assert(requests.filter(value=>value.operation==='inspect').every(value=>value.operationId===unknown.operationId&&!value.directory))
  pass('unknown outcomes persist across restart; wrong share receipt rejected; inspect keeps original operation/share/digest and never republishes')

  source=service.capture(meta.id,scope)
  content=await service.prepareSnapshot(meta.id,{sourcePreviewId:source.id,title:'Drift checks',selectedMessageIds:source.messages.map(message=>message.id)},scope)
  writeFileSync(modeFile,'capability')
  await assert.rejects(service.prepareOperation({action:'publish',snapshotId:content.snapshot.id,adapterId:adapter.id},scope),/条件撤销/)
  writeFileSync(modeFile,'normal')
  preview=await service.prepareOperation({action:'publish',snapshotId:content.snapshot.id,adapterId:adapter.id},scope)
  authorityKey='grant-2'
  await assert.rejects(service.execute(preview.id,scope),/授权已变化/)
  authorityKey='grant-1'
  writeFileSync(join(service.store.bundle(content.snapshot.id),'extra-private.txt'),'PRIVATE')
  await assert.rejects(service.execute(preview.id,scope),/额外文件/)
  rmSync(join(service.store.bundle(content.snapshot.id),'extra-private.txt'))
  const scriptOriginal=readFileSync(script,'utf8');writeFileSync(script,scriptOriginal+'\n// changed entry script\n')
  await assert.rejects(service.execute(preview.id,scope),/程序或环境已变化/)
  writeFileSync(script,scriptOriginal)
  scopeLive=false;assert.throws(()=>service.preview(preview.id,scope),/window closed/);scopeLive=true
  writeFileSync(modeFile,'hang')
  const executing=service.execute(preview.id,scope)
  let stopped=false
  for(let attempt=0;attempt<60&&!stopped;attempt++){await new Promise(resolve=>setTimeout(resolve,50));stopped=service.cancel(preview.operationId,scope)}
  assert(stopped)
  const cancelled=await executing
  assert.equal(cancelled.status,'needs_reconciliation')
  pass('missing revoke capability, permission/program/content drift and closed window fail closed; cancellation preserves unknown outcome')
  service.dispose()
  console.log(`PASS ${groups} chat snapshot sharing groups`)
} finally {globalThis.fetch=oldFetch;rmSync(root,{recursive:true,force:true})}
