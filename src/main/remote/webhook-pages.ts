/** Standalone mobile pages. Keep browser scripts independently parseable without Electron imports. */
function scriptValue(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

export function pairingHtml(token: string, expiresAt: number, projectId?: string): string {
  return `<main><h1>EastGenesis 设备配对</h1>
<p>绑定后可在此浏览器查看项目进展、继续暂停的工作及处理审批。电脑和 EastGenesis 需要保持运行。</p>
<p>设备私钥仅保存在此浏览器。配对有效期至 <time id="expiry"></time>。</p>
<label>设备名称<input id="label" value="我的手机" maxlength="120" autocomplete="off"></label>
<button id="bind">绑定此设备</button><p id="status" role="status" aria-live="polite"></p></main>
<script>
const token=${scriptValue(token)},projectId=${scriptValue(projectId ?? '')},expiresAt=${expiresAt};
const status=document.querySelector('#status'),bind=document.querySelector('#bind');
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
document.querySelector('#expiry').textContent=new Date(expiresAt).toLocaleTimeString();
bind.onclick=async()=>{
  bind.disabled=true;status.textContent='正在绑定设备…';
  try{
    if(Date.now()>=expiresAt)throw Error('配对链接已过期，请在电脑上重新生成。');
    if(!window.crypto?.subtle)throw Error('请用支持安全密钥的浏览器通过 HTTPS 打开此页。');
    if(!projectId)throw Error('请在电脑上选择项目后重新生成配对链接。');
    const label=document.querySelector('#label').value.trim();
    if(!label)throw Error('请输入设备名称。');
    const probe='caogen.remote.storage-check';localStorage.setItem(probe,'1');localStorage.removeItem(probe);
    const pair=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
    const key=b64(await crypto.subtle.exportKey('spki',pair.publicKey));
    const secret=b64(await crypto.subtle.exportKey('pkcs8',pair.privateKey));
    const res=await fetch('/remote/pair/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,label,userId:'local-user',publicKey:key})});
    const data=await res.json();if(!res.ok)throw Error(data.error||'绑定失败，请重试。');
    localStorage.setItem('caogen.remote.device.'+data.deviceId,JSON.stringify({privateKey:secret,publicKey:key,deviceId:data.deviceId,projectId,expiresAt:data.expiresAt}));
    status.textContent='绑定成功，正在打开远程控制台…';location.replace(data.consoleUrl);
  }catch(error){status.textContent=error instanceof Error?error.message:String(error);bind.disabled=false;}
};
</script>`
}

export function consoleHtml(token: string, deviceId: string): string {
  return `<main><header><h1>EastGenesis 远程控制台</h1><p id="identity">正在连接电脑…</p></header>
<p>工作仍在电脑上执行。此页显示项目进展与审批结果。</p>
<div id="app" aria-busy="true"></div><button id="refresh">刷新进展</button>
<p id="status" role="status" aria-live="polite"></p></main>
<script>
const token=${scriptValue(token)},deviceId=${scriptValue(deviceId)},storeKey='caogen.remote.device.'+deviceId;
const status=document.querySelector('#status'),app=document.querySelector('#app'),refresh=document.querySelector('#refresh');
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,stable(x)])):v;
const canon=v=>JSON.stringify(stable(v));
const hex=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
let busy=false,loading=false,lastData;
function show(message,error=false){status.textContent=message;status.dataset.error=String(error);}
function device(){
  const data=JSON.parse(localStorage.getItem(storeKey)||localStorage.getItem('caogen.remote.device')||'null');
  if(!data?.privateKey||data.deviceId!==deviceId)throw Error('此浏览器没有当前设备密钥，请从电脑重新配对。');
  return data;
}
async function key(){
  if(!window.crypto?.subtle)throw Error('浏览器无法使用安全密钥，请通过 HTTPS 重新打开。');
  return crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(device().privateKey),c=>c.charCodeAt(0)),{name:'Ed25519'},false,['sign']);
}
async function signed(kind,scope,revision,payload){
  const createdAt=Date.now(),expiresAt=createdAt+5*60*1000;
  const base={schemaVersion:1,commandId:crypto.randomUUID(),issuerDeviceId:device().deviceId,kind,scope,revision,expiresAt,createdAt,payloadDigest:await hex(canon(payload||{kind,scope,revision})),...(payload?{payload}:{})};
  return {...base,signature:b64(await crypto.subtle.sign({name:'Ed25519'},await key(),new TextEncoder().encode(canon(base))))};
}
async function request(url,options){
  let response;
  try{response=await fetch(url,{cache:'no-store',...options});}catch{throw Error('连接中断。请确认电脑和 EastGenesis 仍在运行，再刷新进展。');}
  let data;try{data=await response.json();}catch{throw Error('电脑返回了无法读取的响应，请刷新后重试。');}
  if(!response.ok)throw Error(data.error||'操作未完成，请刷新后重试。');return data;
}
function post(body){return request('/remote/console-api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,...body})});}
function node(tag,text,parent=app){const element=document.createElement(tag);if(text!==undefined)element.textContent=String(text);parent.append(element);return element;}
function button(text,handler,parent){const element=node('button',text,parent);element.type='button';element.disabled=busy;element.onclick=handler;return element;}
const labels={pending:'等待开始',running:'执行中',paused:'已暂停',blocked:'需要处理',waiting_reconciliation:'等待核对',done:'已完成',completed:'已完成',failed:'失败',cancelled:'已取消',ready:'准备就绪',accepted:'已接收',offline:'已排队',rejected:'已拒绝',expired:'已过期',succeeded:'已完成'};
function render(data){
  app.replaceChildren();document.querySelector('#identity').textContent=data.projectName;
  node('h2','项目进展');const p=data.projection;
  node('p',p.activeWorkItemCount+' 项工作未完成 · '+p.availableArtifactCount+'/'+p.artifactCount+' 份成果可用 · '+p.passedAcceptanceCount+'/'+p.acceptanceCount+' 项验收通过');
  node('h2','当前工作');const items=data.workItems.filter(x=>!['done','cancelled'].includes(x.status));
  if(!items.length)node('p','当前没有未完成工作。');
  for(const item of items){const card=node('section');node('strong',item.title,card);node('p',labels[item.status]||item.status,card);
    if(item.canResume&&data.capabilities.includes('resume_work_item'))button('继续工作',()=>actCommand('resume_work_item',{projectId:data.projectId,workItemId:item.id,artifactIds:[],dataClass:'metadata_only'},item.revision),card);
    if(data.capabilities.includes('control_work_item')){
      if(item.canAppend)button('追加要求',()=>{const text=prompt('追加给当前任务的要求');if(text?.trim())return actCommand('append_task',{projectId:data.projectId,workItemId:item.id,artifactIds:[],dataClass:'metadata_only'},item.revision,{kind:'append_task',text:text.trim(),clientRequestId:'remote-'+crypto.randomUUID()})},card);
      if(item.canPause)button('暂停',()=>actCommand('pause_work_item',{projectId:data.projectId,workItemId:item.id,artifactIds:[],dataClass:'metadata_only'},item.revision,{kind:'pause_work_item'}),card);
      if(item.canCancel)button('取消',()=>actCommand('cancel_work_item',{projectId:data.projectId,workItemId:item.id,artifactIds:[],dataClass:'metadata_only'},item.revision,{kind:'cancel_work_item'}),card);
    }
    else if(item.resumeReason)node('small',item.resumeReason,card);
  }
  if(data.capabilities.includes('create_task')){node('h2','新建任务');const input=document.createElement('textarea');input.placeholder='输入一句话开始任务';input.maxLength=20000;app.append(input);button('提交任务',()=>{const text=input.value.trim();if(text)return actCommand('create_task',{projectId:data.projectId,artifactIds:[],dataClass:'metadata_only'},data.projectRevision,{kind:'create_task',objective:text})});}
  node('h2','自动化');if(!data.routines.length)node('p','此项目暂无已启用的自动化。');
  for(const item of data.routines){const card=node('section');node('strong',item.name,card);
    if(data.capabilities.includes('trigger_routine'))button('运行一次',()=>actCommand('trigger_routine',{projectId:data.projectId,routineId:item.id,artifactIds:[],dataClass:'metadata_only'},data.projectRevision),card);
  }
  node('h2','待审批');if(!data.approvals.length)node('p','当前没有远程待审批事项。');
  for(const approval of data.approvals){const card=node('section');node('strong',approval.action,card);node('p','目标版本 '+approval.targetDigest.slice(0,12)+' · 有效期至 '+new Date(approval.expiresAt).toLocaleTimeString(),card);
    if(data.capabilities.includes('approve_effect')){button('批准',()=>actApproval(approval,'approve'),card);button('拒绝',()=>actApproval(approval,'reject'),card);}
  }
  if(data.commands?.length){node('h2','最近操作');for(const command of data.commands){const card=node('section');node('strong',({resume_work_item:'继续工作',trigger_routine:'运行自动化',approve_effect:'审批',view_result:'查看结果'}[command.kind]||command.kind),card);node('p',labels[command.execution?.status||command.status]||command.status,card);if(command.error)node('small',command.error,card);}}
}
async function load(silent=false){
  if(loading)return;loading=true;refresh.disabled=true;app.setAttribute('aria-busy','true');
  try{
    const data=await request('/remote/console-api?token='+encodeURIComponent(token));lastData=data;render(data);
    if(!silent)show('已更新 · '+new Date().toLocaleTimeString());
  }catch(error){show(error instanceof Error?error.message:String(error),true);}
  finally{loading=false;refresh.disabled=busy;app.setAttribute('aria-busy','false');}
}
function resultMessage(data){
  const command=data.command,approval=data.approval;
  if(approval?.applicationStatus==='failed')throw Error(approval.applicationError||'审批未能应用，请在电脑端核对。');
  if(approval?.applicationStatus==='applied')return approval.status==='rejected'?'已拒绝，电脑端已处理。':'已批准，电脑端已处理。';
  if(command?.execution?.status==='failed')throw Error(command.execution.error||'电脑未能完成此操作。');
  if(command?.status==='rejected'||command?.status==='expired')throw Error(command.rejectionReason||'操作已被拒绝或过期，请刷新后重试。');
  if(command?.status==='offline')return '电脑控制通道离线，操作已排队，尚未执行。';
  if(command?.execution?.status==='succeeded')return '电脑已完成此操作。';
  if(command?.execution?.status==='running')return '电脑已开始执行，可刷新查看进展。';
  return '操作已接收，等待电脑执行。';
}
async function act(operation){
  if(busy)return;busy=true;refresh.disabled=true;app.querySelectorAll('button').forEach(b=>b.disabled=true);show('正在提交…');
  try{const data=await operation();const message=resultMessage(data);await load(true);show(message);}
  catch(error){show(error instanceof Error?error.message:String(error),true);}
  finally{busy=false;refresh.disabled=false;if(lastData)render(lastData);}
}
function actCommand(kind,scope,revision,payload){return act(async()=>post({envelope:await signed(kind,scope,revision,payload)}));}
function actApproval(approval,decision){return act(async()=>{
  const base={schemaVersion:1,approvalId:approval.id,issuerDeviceId:device().deviceId,decision,expectedRecordRevision:approval.recordRevision,approvalDigest:approval.approvalDigest,createdAt:Date.now(),expiresAt:approval.expiresAt};
  const signature=b64(await crypto.subtle.sign({name:'Ed25519'},await key(),new TextEncoder().encode(canon(base))));return post({decision:{...base,signature}});
});}
refresh.onclick=()=>load();document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!busy)void load();});
window.addEventListener('online',()=>{if(!busy)void load();});window.addEventListener('offline',()=>show('网络已断开，恢复连接后刷新进展。',true));
void load();
</script>`
}
