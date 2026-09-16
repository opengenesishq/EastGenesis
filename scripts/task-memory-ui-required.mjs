import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const repo = process.cwd()
const fixture = mkdtempSync(path.join(tmpdir(), 'caogen-task-memory-ui-'))
const require = createRequire(path.join(repo, 'package.json'))
try {
  await build({ stdin: { resolveDir: repo, loader: 'tsx', contents: `
    import { act } from 'react';
    import { createRoot } from 'react-dom/client';
    import MemoryPanel from './src/renderer/src/components/MemoryPanel';
    window.IS_REACT_ACT_ENVIRONMENT = true;
    window.runTaskMemoryHarness = async () => {
      const container = document.getElementById('root');
      const root = createRoot(container);
      const checks = [];
      const calls = [];
      let entries = [];
      const assert = (value, message) => { if (!value) throw new Error(message) };
      const q = selector => { const node = container.querySelector(selector); assert(node, 'missing ' + selector); return node };
      const button = (label, scope = container) => { const node = [...scope.querySelectorAll('button')].find(x => x.textContent.trim() === label); assert(node, 'missing button ' + label); return node };
      const click = async node => { await act(async () => node.click()) };
      const fill = async (selector, value) => {
        const node = q(selector);
        await act(async () => {
          Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(node,value);
          node.dispatchEvent(new Event('input',{bubbles:true}));
        });
      };
      window.agentDesk = {
        readProjectMemory: async id => ({ projectHash:'fixture',markdown:'',entries:[],drafts:[] }),
        listLearning: async () => ({ records:[],drafts:[],active:[],audit:[] }),
        listLayeredMemories: async id => entries.filter(x => !x.sessionId || x.sessionId === id),
        addTaskMemory: async (id, input) => {
          calls.push({action:'add',id,input});
          const entry = {id:'task-memory',layer:'working',sessionId:id,...input,source:'user',tags:[],createdAt:'2026-09-16T00:00:00.000Z',updatedAt:'2026-09-16T00:00:00.000Z',lastUsedAt:'2026-09-16T00:00:00.000Z',vector:{}};
          entries.push(entry); return entry;
        },
        proposeMemoryDraft: async (id,input) => { calls.push({action:'project',id,input}); return {...input,id:'draft',status:'draft'} },
        updateLayeredMemory: async (entryId,input,id) => {
          calls.push({action:'edit',entryId,input,id});
          entries = entries.map(x => x.id === entryId ? {...x,...input,updatedAt:'2026-09-16T00:00:01.000Z'} : x);
          return entries.find(x => x.id === entryId);
        },
        deleteLayeredMemory: async (entryId,id) => { calls.push({action:'delete',entryId,id}); entries = entries.filter(x => x.id !== entryId); return true }
      };
      try {
        await act(async () => root.render(<MemoryPanel sessionId="task-a" />));
        await click(button('添加记忆'));
        assert(q('[data-memory-form-field="scope"]').value === 'task','new memory must default to current task');
        await fill('[data-memory-form-field="title"]','Task convention');
        await fill('[data-memory-form-field="body"]','Only this task uses six pages');
        await click(button('保存到当前任务'));
        assert(calls[0].action === 'add' && calls[0].id === 'task-a' && calls[0].input.body === 'Only this task uses six pages','task add payload lost identity or body');
        assert(q('[data-layered-memory-id="task-memory"]').textContent.includes('仅当前任务'),'task ownership missing');
        checks.push('task-add-keeps-session-and-displays-ownership');
        await click(button('编辑',q('[data-layered-memory-id="task-memory"]')));
        await fill('[aria-label="记忆内容"]','Use five pages now');
        await click(button('保存',q('[data-layered-memory-id="task-memory"]')));
        assert(calls.at(-1).id === 'task-a' && calls.at(-1).input.expectedUpdatedAt === '2026-09-16T00:00:00.000Z','edit must bind task and displayed version');
        assert(q('[data-layered-memory-id="task-memory"]').textContent.includes('Use five pages now'),'edited body missing');
        await click(button('删除',q('[data-layered-memory-id="task-memory"]')));
        assert(calls.at(-1).action === 'delete' && calls.at(-1).id === 'task-a','delete lost task identity');
        assert(!container.querySelector('[data-layered-memory-id="task-memory"]'),'deleted memory remains visible');
        checks.push('edit-and-delete-use-current-task-and-refresh-content');
        await click(button('添加记忆'));
        await act(async () => { const select=q('[data-memory-form-field="scope"]');select.value='project';select.dispatchEvent(new Event('change',{bubbles:true})) });
        await fill('[data-memory-form-field="title"]','Shared convention');
        await fill('[data-memory-form-field="body"]','Shared with this project');
        await click(button('提交草稿'));
        assert(calls.at(-1).action === 'project' && calls.at(-1).id === 'task-a','project memory no longer uses approval draft');
        checks.push('project-shared-choice-retains-draft-approval');
        entries = [{id:'legacy',layer:'working',title:'Legacy',body:'shared legacy',source:'legacy',updatedAt:'2026-09-16T00:00:00.000Z'}];
        await act(async () => root.render(<MemoryPanel sessionId="task-b" />));
        assert(q('[data-layered-memory-id="legacy"]').textContent.includes('历史工作记忆 · 项目共享'),'legacy working memory falsely labeled task-private');
        assert(!container.querySelector('[data-memory-form="true"]'),'task switch retained another task form');
        checks.push('task-switch-clears-form-and-legacy-shared-label-remains-explicit');
        return checks;
      } finally { await act(async () => root.unmount()) }
    };
  ` }, outfile: path.join(fixture,'harness.js'), bundle: true, platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'} })
  writeFileSync(path.join(fixture,'harness.html'),'<div id="root"></div><script src="harness.js"></script>')
  writeFileSync(path.join(fixture,'electron.cjs'),`
    const {app,BrowserWindow,session}=require('electron');
    const fs=require('node:fs'); const path=require('node:path');
    app.setPath('userData',path.join(__dirname,'user-data'));app.commandLine.appendSwitch('disable-gpu');
    const timeout=setTimeout(()=>app.exit(1),25000);
    app.whenReady().then(async()=>{
      session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,cb)=>cb({cancel:true}));
      const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
      await win.loadFile(path.join(__dirname,'harness.html'));
      const checks=await win.webContents.executeJavaScript('window.runTaskMemoryHarness()');
      fs.writeFileSync(path.join(__dirname,'checks.json'),JSON.stringify(checks));clearTimeout(timeout);app.exit(0);
    }).catch(error=>{console.error(error);clearTimeout(timeout);app.exit(1)});
  `)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  execFileSync(require('electron'), [path.join(fixture,'electron.cjs')], { cwd:repo,env,encoding:'utf8',timeout:30000 })
  const checks = JSON.parse(readFileSync(path.join(fixture,'checks.json'),'utf8'))
  assert.equal(checks.length,4)
  console.log(JSON.stringify({ status:'passed',checks,scope:'actual MemoryPanel with fixture IPC; temporary Electron profile; no network or Provider calls' },null,2))
} finally {
  rmSync(fixture,{recursive:true,force:true})
}
