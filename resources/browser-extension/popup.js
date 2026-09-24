const el = id => document.getElementById(id)
let tabId, busy = false
const call = async (type, args={}) => { const reply=await chrome.runtime.sendMessage({type,...args});if(!reply?.ok)throw new Error(reply?.error||'扩展服务无响应。');return reply.value }
function render(state){el('extension-id').value=state.extensionId;el('pair-section').hidden=state.connected;el('authorize-section').hidden=!state.connected||state.attached;el('attached-section').hidden=!state.attached;el('revoke').hidden=!state.connected;el('task-title').textContent=`绑定任务：${state.taskTitle||''}`;el('attached-label').textContent=`已授权标签：${state.url||''}`;el('authorize').disabled=busy||!tabId}
async function run(work){if(busy)return;busy=true;document.querySelectorAll('button').forEach(button=>button.disabled=true);el('message').textContent='';try{render(await work())}catch(error){el('message').textContent=error.message}finally{busy=false;document.querySelectorAll('button').forEach(button=>button.disabled=false);el('authorize').disabled=!tabId}}
el('pair').onclick=()=>run(()=>call('pair',{code:el('pair-code').value.trim()}).then(state=>{el('pair-code').value='';return state}))
el('authorize').onclick=()=>run(()=>call('authorize',{tabId}))
el('revoke').onclick=()=>run(()=>call('revoke'))
chrome.tabs.query({active:true,currentWindow:true}).then(tabs=>{const tab=tabs[0];if(tab&&/^https?:\/\//i.test(tab.url||'')){tabId=tab.id;el('tab-title').textContent=tab.title||new URL(tab.url).hostname}else{el('tab-title').textContent='请在 HTTP(S) 网页中打开此扩展';el('authorize').disabled=true}}).catch(error=>{el('message').textContent=error.message})
run(()=>call('status'))
