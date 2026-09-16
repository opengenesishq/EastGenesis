import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const repo = process.cwd(), fixture = mkdtempSync(path.join(tmpdir(), 'caogen-memory-retention-ui-'))
const require = createRequire(path.join(repo, 'package.json'))
try {
  await build({ stdin: { resolveDir: repo, loader: 'tsx', contents: `
    import { act } from 'react';
    import { createRoot } from 'react-dom/client';
    import MemoryRetentionPanel from './src/renderer/src/components/MemoryRetentionPanel';
    window.IS_REACT_ACT_ENVIRONMENT = true;
    window.runHarness = async () => {
      const container=document.getElementById('root'), root=createRoot(container), calls=[], checks=[];
      const assert=(value,message)=>{if(!value)throw new Error(message)};
      const q=selector=>{const node=container.querySelector(selector);assert(node,'missing '+selector);return node};
      const button=label=>{const node=[...container.querySelectorAll('button')].find(x=>x.textContent.trim()===label);assert(node,'missing '+label);return node};
      const click=async node=>{await act(async()=>node.click())};
      const fill=async value=>{await act(async()=>{const input=q('[aria-label="记忆保留天数"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))})};
      let view={revision:3,settings:['working','project','user'].map(layer=>({layer,available:true,days:null}))};
      let rejectSave=false, delayedRead, refresh=0;
      window.agentDesk={
        readMemoryRetention: async id=>{calls.push({action:'read',id});if(id==='delayed')return new Promise(resolve=>{delayedRead=resolve});return view},
        previewMemoryRetention: async(id,input)=>{calls.push({action:'preview',id,input});return {...input,evaluatedAt:123,digest:'preview-digest',layeredCount:2,projectCount:1}},
        saveMemoryRetention: async(id,input)=>{calls.push({action:'save',id,input});if(rejectSave)throw new Error('记忆已变化，请重新预览');view={revision:view.revision+1,settings:view.settings.map(x=>x.layer===input.layer?{...x,days:input.days}:x)};return view}
      };
      const render=async id=>act(async()=>root.render(<MemoryRetentionPanel key={id} sessionId={id} onChanged={async()=>{refresh++}}/>));
      try {
        await render('task-a');
        assert(calls.length===0,'opening parent panel must not configure retention');
        await click(button('设置保留期限'));
        assert(q('[aria-label="记忆保留天数"]').value==='','default must retain forever');
        await fill('30'); await click(button('预览保留变更'));
        assert(calls.at(-1).id==='task-a'&&calls.at(-1).input.expectedRevision===3,'preview lost task or revision');
        assert(q('[data-memory-retention-preview]').textContent.includes('清理 2 条'),'preview omitted impact');
        await fill('60');assert(!container.querySelector('[data-memory-retention-preview]'),'editing days must invalidate preview');
        await click(button('预览保留变更'));await click(button('保存保留规则'));
        assert(calls.at(-1).input.days===60&&calls.at(-1).input.digest==='preview-digest'&&calls.at(-1).input.evaluatedAt===123,'save not bound to displayed preview');
        assert(refresh===1&&container.textContent.includes('已保存'),'save did not refresh memories');
        checks.push('default retain; preview impact; edited input invalidates preview; saved rule binds task and revision');
        await act(async()=>{const select=q('[aria-label="记忆保留范围"]');select.value='user';select.dispatchEvent(new Event('change',{bubbles:true}))});
        assert(q('[aria-label="记忆保留天数"]').value==='','switching layers must use separate setting');
        assert(container.textContent.includes('所有项目共用'),'global user scope missing');
        await fill('90');await click(button('预览保留变更'));rejectSave=true;await click(button('保存保留规则'));
        assert(calls.at(-1).input.layer==='user','wrong layer saved');
        assert(q('[role="alert"]').textContent.includes('重新预览')&&!container.querySelector('[data-memory-retention-preview]'),'failed save may be repeated against stale preview');
        checks.push('independent user layer and stale-save recovery');
        await render('delayed');await click(button('设置保留期限'));
        await render('task-b');await click(button('设置保留期限'));
        await act(async()=>delayedRead({revision:99,settings:[{layer:'working',available:true,days:999}]}));
        assert(q('[aria-label="记忆保留天数"]').value==='60','old task response leaked into new task');
        checks.push('late read cannot alter newly selected task');
        return checks;
      } finally {await act(async()=>root.unmount())}
    };
  ` }, outfile:path.join(fixture,'harness.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'} })
  writeFileSync(path.join(fixture,'harness.html'),'<div id="root"></div><script src="harness.js"></script>')
  writeFileSync(path.join(fixture,'electron.cjs'),`
    const {app,BrowserWindow,session}=require('electron');const fs=require('node:fs'),path=require('node:path');
    app.setPath('userData',path.join(__dirname,'profile'));app.commandLine.appendSwitch('disable-gpu');
    const timeout=setTimeout(()=>app.exit(1),25000);
    app.whenReady().then(async()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,cb)=>cb({cancel:true}));
      const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
      await win.loadFile(path.join(__dirname,'harness.html'));const checks=await win.webContents.executeJavaScript('window.runHarness()');
      fs.writeFileSync(path.join(__dirname,'checks.json'),JSON.stringify(checks));clearTimeout(timeout);app.exit(0);
    }).catch(error=>{console.error(error);clearTimeout(timeout);app.exit(1)});
  `)
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  execFileSync(require('electron'),[path.join(fixture,'electron.cjs')],{cwd:repo,env,encoding:'utf8',timeout:30000})
  const checks=JSON.parse(readFileSync(path.join(fixture,'checks.json'),'utf8'))
  assert.equal(checks.length,3)
  console.log(JSON.stringify({passed:checks.length,checks,scope:'actual React retention panel with fixture IPC in isolated Electron; no network'},null,2))
} finally {rmSync(fixture,{recursive:true,force:true})}
