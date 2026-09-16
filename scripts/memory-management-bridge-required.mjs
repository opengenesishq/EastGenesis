import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const repo = process.cwd()
const fixture = mkdtempSync(path.join(tmpdir(), 'caogen-memory-bridge-'))
const modulePath = (name) => JSON.stringify(path.join(repo, 'src/main', name))
try {
  const bundle = path.join(fixture, 'memory-bridge.cjs')
  const peripheralStubs = new Map([
    ['electron', `export const ipcMain = { handle: (name, handler) => globalThis.__memoryHandlers.set(name, handler) }; export const app = {getPath:()=>process.argv[2]};`],
    ['workflow-ledger-handlers', `export const assertTrustedWorkflowLedgerSender = event => { if (!event.trusted) throw new Error('untrusted fixture sender') };`],
    ['project-mutation-ingress', `export const verifyProductionProjectMutation = async (root, id) => { globalThis.__memoryVerifications.push({root,id}) };`],
    ['settings', `export const getSettings = () => ({ autoSkillLearningEnabled: false });`],
    ['skill-invocation', `export const buildSkillInvocationPrompt = () => '';`],
    ['ide-document-context', `export const buildIdeDocumentContextPrompt = () => '';`],
    ['worker-memory', `export const buildDigitalWorkerMemoryPrompt = async () => '';`],
    ['worker-execution-prompt', `export const buildDigitalWorkerExecutionPrompt = () => '';`]
  ])
  await build({
    stdin: { contents: `
      import assert from 'node:assert/strict';
      import { join } from 'node:path';
      import { registerProjectMemoryIpc } from ${modulePath('ipc/memory-handlers.ts')};
      import { registerLearningIpc } from ${modulePath('ipc/learning-handlers.ts')};
      import { augmentNativePayloadWithLayeredMemory } from ${modulePath('native-layered-prompt.ts')};
      import { proposeMemoryDraft, acceptMemoryDraft } from ${modulePath('memoryStore.ts')};
      import { createTrustedUserLearningDecision } from ${modulePath('learning/learning-security.ts')};
      import { taskMemoryScope } from ${modulePath('memory/task-memory-scope.ts')};
      import { withDataLifecycleMutation } from ${modulePath('data-lifecycle/data-lifecycle-mutation-lock.ts')};
      import { openProjectWorkspaceStore } from ${modulePath('project-workspace/store.ts')};
      import { openProjectWorkspaceCommandService } from ${modulePath('project-workspace/command-service.ts')};
      import { LearningChangePreview } from ${JSON.stringify(path.join(repo, 'src/renderer/src/components/LearningApprovalPanel.tsx'))};
      import { createElement } from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      async function main() {
        globalThis.__memoryHandlers = new Map();
        globalThis.__memoryVerifications = [];
        const profile = process.argv[2];
        const root = join(profile, 'memory');
        const cwd = join(profile, 'resources');
        const targets = { a: { projectRoot: cwd, projectId: 'a' }, sibling: { projectRoot: cwd, projectId: 'a' }, b: { projectRoot: cwd, projectId: 'b' }, legacy: {projectRoot: cwd} };
        const targetForSession = id => targets[id] ?? null;
        const metas = Object.fromEntries(Object.entries(targets).map(([id,target]) => [id, { id,cwd:target.projectRoot,workspaceId:target.projectId }]));
        registerProjectMemoryIpc({ memoryRoot: () => root, targetForSession, taskScopeForSession: async id => {
          if (!metas[id]) throw new Error('会话不存在');
          return taskMemoryScope(metas[id],profile);
        } });
        registerLearningIpc({ projectRootFor: id => targets[id]?.projectRoot ?? null, targetForSession, userDataRoot: () => profile });
        const invoke = async (channel, ...args) => globalThis.__memoryHandlers.get(channel)({trusted: true}, ...args);
        const input = { kind: 'note', title: 'Current convention', body: 'canonical alpha memory', source: 'user-fixture', reason: '' };
        const draft = await invoke('memory:propose', 'a', input);
        await assert.rejects(invoke('learning:approve', 'b', draft.id), /不属于当前项目/);
        assert.equal((await invoke('learning:list','a')).drafts[0].id, draft.id);
        assert.equal((await invoke('learning:list','b')).records.length, 0);
        await invoke('learning:approve', 'a', draft.id);
        assert.equal((await invoke('memory:read','a')).entries[0].id, draft.id);
        const revision = await invoke('memory:propose', 'a', {...input, body:'revised alpha memory', supersedes: draft.id});
        const revisions = (await invoke('learning:list','a')).records;
        const markup = renderToStaticMarkup(createElement(LearningChangePreview, {
          record: revisions.find(x => x.id === revision.id), previous: revisions.find(x => x.id === draft.id)
        }));
        assert.ok(markup.includes('canonical alpha memory') && markup.includes('revised alpha memory'));
        assert.ok(markup.includes('user-fixture') && markup.includes('v2'));
        const legacyDraft = await proposeMemoryDraft(cwd,root,{...input,body:'legacy same directory memory'});
        await acceptMemoryDraft(cwd,root,legacyDraft.id,createTrustedUserLearningDecision('fixture'));
        assert.equal((await invoke('learning:list','a')).records.some(x=>x.id===legacyDraft.id),false);
        assert.ok((await invoke('learning:list','legacy')).records.some(x=>x.id===legacyDraft.id));
        const meta = { id:'a',cwd,workspaceId:'a' };
        const payload = { text:'Produce report', images:[],documents:[] };
        const native = await augmentNativePayloadWithLayeredMemory(payload,meta,profile);
        assert.ok(native.payload.text.includes('canonical alpha memory'));
        assert.equal(native.payload.text.includes('legacy same directory memory'),false);
        const other = await augmentNativePayloadWithLayeredMemory(payload,{...meta,id:'b',workspaceId:'b'},profile);
        assert.equal(other.payload.text.includes('canonical alpha memory'),false);
        await invoke('learning:delete','a',draft.id);
        assert.equal((await invoke('memory:read','a')).entries.length,0);
        assert.equal((await augmentNativePayloadWithLayeredMemory(payload,meta,profile)).payload.text.includes('canonical alpha memory'),false);
        await assert.rejects(invoke('learning:approve','a',revision.id), /changed or was removed/);
        const taskMemory = await invoke('memory:taskAdd', 'a', { title: 'Task-only convention', body: 'report taskprivate data', sessionId: 'sibling', projectId: 'b', layer: 'user' });
        assert.equal(taskMemory.sessionId, 'a');
        assert.equal(taskMemory.layer, 'working');
        assert.ok((await invoke('memory:layeredList', 'a')).some(x => x.id === taskMemory.id));
        assert.equal((await invoke('memory:layeredList', 'sibling')).some(x => x.id === taskMemory.id), false);
        assert.equal((await invoke('memory:layeredSearch', 'sibling', { query: 'report', sessionId: 'a', projectId: 'a' })).length, 0);
        assert.equal((await invoke('memory:layeredSearch', undefined, { query: 'report', sessionId: 'a', projectId: 'a', projectRoot: cwd })).length, 0);
        await assert.rejects(invoke('memory:layeredUpdate', taskMemory.id, {body:'cross-task'}, 'sibling'), /当前项目或任务/);
        await assert.rejects(invoke('memory:layeredDelete', taskMemory.id, 'sibling'), /当前项目或任务/);
        assert.ok((await augmentNativePayloadWithLayeredMemory(payload,meta,profile)).payload.text.includes('report taskprivate data'));
        assert.equal((await augmentNativePayloadWithLayeredMemory(payload,{...meta,id:'sibling'},profile)).payload.text.includes('report taskprivate data'),false);
        const updatedTask = await invoke('memory:layeredUpdate', taskMemory.id, { body:'report revisedprivate data', expectedUpdatedAt:taskMemory.updatedAt }, 'a');
        assert.equal(updatedTask.sessionId,'a');
        const refreshed = (await augmentNativePayloadWithLayeredMemory(payload,meta,profile)).payload.text;
        assert.ok(refreshed.includes('report revisedprivate data'));
        assert.equal(refreshed.includes('report taskprivate data'),false);
        assert.equal((await invoke('memory:layeredSearch','a',{query:'taskprivate'})).length,0);
        await invoke('memory:layeredDelete',taskMemory.id,'a');
        assert.equal((await augmentNativePayloadWithLayeredMemory(payload,meta,profile)).payload.text.includes('report revisedprivate data'),false);
        assert.equal((await invoke('memory:layeredSearch','a',{query:'revisedprivate'})).length,0);
        await assert.rejects(invoke('memory:taskAdd','missing',{title:'missing',body:'missing'}), /会话不存在/);
        await assert.rejects(invoke('memory:taskAdd',undefined,{title:'missing',body:'missing'}), /当前任务/);
        const store = await openProjectWorkspaceStore(profile);
        await store.createWorkspace({ id:'task-project', name:'Memory tasks', kind:'opc', ownerId:'fixture-user' });
        const commands = await openProjectWorkspaceCommandService(profile);
        await commands.createGoal({ id:'task-goal',projectId:'task-project',title:'Memory task',objective:'Report',status:'planned' });
        for (const id of ['task-one','task-two']) await commands.createWorkItem({id,projectId:'task-project',goalId:'task-goal',type:'planning',businessLineId:'studio',title:id,status:'ready',owner:{type:'human',id:'fixture-user'}});
        for (const [id,workItemId] of [['first','task-one'],['reopened','task-one'],['different','task-two']]) {
          targets[id] = {projectRoot:cwd,projectId:'task-project'};
          metas[id] = {id,cwd,workspaceId:'task-project',goalId:'task-goal',workItemId};
        }
        const owned = await invoke('memory:taskAdd','first',{title:'Report continuity',body:'report survives reopen'});
        assert.equal(owned.workItemId,'task-one');
        assert.ok((await invoke('memory:layeredList','reopened')).some(x=>x.id===owned.id));
        assert.equal((await invoke('memory:layeredList','different')).some(x=>x.id===owned.id),false);
        assert.ok((await augmentNativePayloadWithLayeredMemory(payload,metas.reopened,profile)).payload.text.includes('report survives reopen'));
        assert.equal((await augmentNativePayloadWithLayeredMemory(payload,metas.different,profile)).payload.text.includes('report survives reopen'),false);
        await invoke('memory:layeredUpdate',owned.id,{body:'report resumed revision',expectedUpdatedAt:owned.updatedAt},'reopened');
        await invoke('memory:layeredDelete',owned.id,'reopened');
        assert.equal((await invoke('memory:layeredList','first')).some(x=>x.id===owned.id),false);
        targets.foreign = {projectRoot:cwd,projectId:'b'};
        metas.foreign = {...metas.first,id:'foreign',workspaceId:'b'};
        await assert.rejects(invoke('memory:taskAdd','foreign',{title:'invalid',body:'invalid'}),/不属于当前项目或目标/);
        metas.reopenedUnbound = {...metas.a,id:'reopenedUnbound',taskMemorySessionId:'a'};
        targets.reopenedUnbound = targets.a;
        const unbound = await invoke('memory:taskAdd','a',{title:'Report session',body:'report legacy session resume'});
        assert.ok((await invoke('memory:layeredList','reopenedUnbound')).some(x=>x.id===unbound.id));
        assert.ok((await augmentNativePayloadWithLayeredMemory(payload,metas.reopenedUnbound,profile)).payload.text.includes('report legacy session resume'));
        assert.equal((await invoke('memory:layeredList','sibling')).some(x=>x.id===unbound.id),false);
        let unlock, markLocked;
        const locked = new Promise(resolve => { markLocked=resolve });
        const deletionLock = withDataLifecycleMutation(profile, async () => { markLocked(); await new Promise(resolve => { unlock=resolve }); });
        await locked;
        const queued = invoke('memory:taskAdd','a',{title:'late writer',body:'must not survive deletion'});
        const rejected = assert.rejects(queued,/会话不存在/);
        delete metas.a; delete targets.a;
        unlock(); await deletionLock; await rejected;
        assert.equal((await invoke('memory:layeredList','reopenedUnbound')).some(x=>x.body==='must not survive deletion'),false);
        const before = globalThis.__memoryVerifications.length;
        await assert.rejects(async()=>globalThis.__memoryHandlers.get('memory:propose')({trusted:false},'a',input), /untrusted/);
        await assert.rejects(async()=>globalThis.__memoryHandlers.get('learning:delete')({trusted:false},'a',draft.id), /untrusted/);
        await assert.rejects(async()=>globalThis.__memoryHandlers.get('memory:taskAdd')({trusted:false},'a',{title:'untrusted',body:'untrusted'}), /untrusted/);
        assert.equal(globalThis.__memoryVerifications.length,before);
        assert.ok(globalThis.__memoryVerifications.every(x=>x.root===profile && x.id==='a'));
        console.log('Memory bridge: real IPC lifecycle, task-owned add/edit/delete, task isolation, queued writer deletion barrier, canonical native prompt, deleted-memory readback and revision preview passed; Electron sender and aggregate verifier use isolated fixtures.');
      }
      main().catch(error => { console.error(error); process.exitCode=1 });
    `, resolveDir: repo, loader: 'tsx' },
    bundle: true, outfile: bundle, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', jsx: 'automatic',
    plugins: [{ name: 'memory-fixture-peripherals', setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        const name = args.path === 'electron' ? 'electron' : path.basename(args.path).replace(/\.ts$/, '')
        if (peripheralStubs.has(name)) return { path: name, namespace: 'memory-fixture' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'memory-fixture' }, (args) => ({ contents: peripheralStubs.get(args.path), loader: 'ts' }))
    } }]
  })
  const env = { ...process.env, CAOGEN_USER_DATA_DIR: path.join(fixture, 'wrong-profile'), CAOGEN_MEMORY_DIR: path.join(fixture, 'wrong-memory'), NODE_PATH: path.join(repo, 'node_modules') }
  console.log(execFileSync(process.execPath, [bundle, path.join(fixture, 'profile')], { cwd: repo, env, encoding: 'utf8', timeout: 30_000 }).trim())
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
