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
    ['electron', `export const ipcMain = { handle: (name, handler) => globalThis.__memoryHandlers.set(name, handler) };`],
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
      import { LearningChangePreview } from ${JSON.stringify(path.join(repo, 'src/renderer/src/components/LearningApprovalPanel.tsx'))};
      import { createElement } from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      async function main() {
        globalThis.__memoryHandlers = new Map();
        globalThis.__memoryVerifications = [];
        const profile = process.argv[2];
        const root = join(profile, 'memory');
        const cwd = join(profile, 'resources');
        const targets = { a: { projectRoot: cwd, projectId: 'a' }, b: { projectRoot: cwd, projectId: 'b' }, legacy: {projectRoot: cwd} };
        const targetForSession = id => targets[id] ?? null;
        registerProjectMemoryIpc({ memoryRoot: () => root, targetForSession });
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
        const before = globalThis.__memoryVerifications.length;
        await assert.rejects(async()=>globalThis.__memoryHandlers.get('memory:propose')({trusted:false},'a',input), /untrusted/);
        await assert.rejects(async()=>globalThis.__memoryHandlers.get('learning:delete')({trusted:false},'a',draft.id), /untrusted/);
        assert.equal(globalThis.__memoryVerifications.length,before);
        assert.ok(globalThis.__memoryVerifications.every(x=>x.root===profile && x.id==='a'));
        console.log('Memory bridge: real IPC lifecycle, canonical native prompt, deleted-memory readback and revision preview passed; Electron sender and aggregate verifier use isolated fixtures.');
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
