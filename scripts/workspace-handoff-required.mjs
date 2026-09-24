import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Module, createRequire } from 'node:module'
import { build } from 'esbuild'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-workspace-handoff-')))
const data = join(root, 'data'), repo = join(root, 'repo')
mkdirSync(data); mkdirSync(repo)
globalThis.__handoffRoot = data
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trimEnd()
const baseMeta = { id: 'same-session', sdkSessionId: 'same-sdk', createdAt: 1, title: 'Handoff', cwd: repo, status: 'idle', isolated: false,
  engine: 'openai', providerId: 'fixture', model: 'fixture', taskStrategy: 'execute', permissionMode: 'acceptEdits', costUsd: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextTokens: 0 }
let checks = 0
const pass = name => { checks++; console.log(`PASS ${name}`) }
try {
  const result = await build({ stdin: { contents: `export * from './src/main/workspace-handoff'; export * from './src/main/git/workspace-handoff-files'; export * from './src/main/workspace-handoff-operation'; export { getTaskSnapshot } from './src/main/task/task-snapshot';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{ name: 'electron-only', setup(builder) {
      builder.onResolve({ filter: /^electron$|(?:^|\/)(?:providers|settings|sessionManager|history|session-input-runtime|session-creation-journal|acceptance-quality-feedback)$/ }, args => ({ path: args.path === 'electron' ? 'electron' : args.path.split('/').at(-1), namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: {
        electron: 'module.exports = { app: { getPath: () => globalThis.__handoffRoot, isPackaged: false }, BrowserWindow: {} }',
        providers: 'module.exports = { listProviders: () => [], getProvider: () => undefined }',
        settings: 'module.exports = { getSettings: () => ({}) }',
        sessionManager: 'module.exports = { sessionManager: { list: () => [], get: () => undefined } }',
        history: 'module.exports = { listHistory: () => [] }',
        'session-input-runtime': 'module.exports = { getSessionInputService: () => { throw new Error("unused") } }',
        'session-creation-journal': 'module.exports = { listPendingSessionCreations: () => [] }',
        'acceptance-quality-feedback': 'module.exports = { scheduleModelRouteObservationRefresh: () => {}, scheduleAcceptanceQualityFeedbackRefresh: () => {} }'
      }[args.path], loader: 'js' }))
    } }] })
  const filename = resolve('scripts/.workspace-handoff-fixture.cjs'), module = new Module(filename)
  module.filename = filename; module.paths = Module._nodeModulePaths(dirname(filename)); module._compile(result.outputFiles[0].text, filename)
  const api = module.exports
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@invalid.test')
  writeFileSync(join(repo, 'a.txt'), 'base\n'); writeFileSync(join(repo, '.gitignore'), 'ignored\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base')
  writeFileSync(join(repo, 'a.txt'), 'staged\n'); git(repo, 'add', 'a.txt'); writeFileSync(join(repo, 'a.txt'), 'unstaged\n')
  writeFileSync(join(repo, 'b.bin'), Buffer.from([0, 1, 2, 3, 255])); writeFileSync(join(repo, 'ignored'), 'private cache')
  symlinkSync('a.txt', join(repo, 'link'))
  const before = api.captureHandoffFiles(repo, join(data, 'check-blobs'))
  const target = api.prepareWorkspaceHandoff(baseMeta)
  assert.throws(() => api.assertWorkspaceHandoffReady(baseMeta), /尚未完成/)
  api.executeWorkspaceHandoffTarget(target)
  let meta = api.restoreWorkspaceHandoff(baseMeta)
  assert.equal(meta.id, baseMeta.id); assert.equal(meta.sdkSessionId, baseMeta.sdkSessionId); assert.equal(meta.createdAt, baseMeta.createdAt)
  assert.equal(meta.isolated, true)
  assert.equal(git(meta.cwd, 'diff', '--cached'), git(repo, 'diff', '--cached'))
  assert.equal(git(meta.cwd, 'diff'), git(repo, 'diff'))
  assert.deepEqual(readFileSync(join(meta.cwd, 'b.bin')), Buffer.from([0, 1, 2, 3, 255]))
  assert.equal(api.reconcileWorkspaceHandoffTarget(target).kind, 'confirmed')
  assert(api.sameHandoffContents(before, api.captureHandoffFiles(repo, join(data, 'check-blobs'))))
  pass('same Session and SDK keep staged, unstaged, binary, symlink and untracked files; original directory stays intact')
  writeFileSync(join(meta.cwd, 'a.txt'), 'finished in worktree\n')
  git(meta.cwd, 'add', 'a.txt'); git(meta.cwd, 'commit', '-m', 'worktree commit')
  writeFileSync(join(meta.cwd, 'a.txt'), 'continued after commit\n')
  writeFileSync(join(meta.cwd, 'new.txt'), 'from worktree\n')
  const back = api.prepareWorkspaceHandoff(meta)
  api.executeWorkspaceHandoffTarget(back)
  const local = api.restoreWorkspaceHandoff(meta)
  assert.equal(local.cwd, repo); assert.equal(local.isolated, false)
  assert.equal(git(repo, 'rev-parse', 'HEAD'), git(meta.cwd, 'rev-parse', 'HEAD'))
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'continued after commit\n')
  assert.equal(readFileSync(join(repo, 'ignored'), 'utf8'), 'private cache')
  assert.equal(readFileSync(join(repo, 'new.txt'), 'utf8'), 'from worktree\n')
  pass('return to local preserves new commits and pending changes with one task identity')
  writeFileSync(join(meta.cwd, 'new.txt'), 'independent change\n')
  assert.throws(() => api.prepareWorkspaceHandoff(local), /新改动/)
  assert.equal(readFileSync(join(meta.cwd, 'new.txt'), 'utf8'), 'independent change\n')
  pass('destination changes after leaving block overwrite')
  writeFileSync(join(meta.cwd, 'new.txt'), 'from worktree\n')
  writeFileSync(join(repo, 'new.txt'), 'next round\n')
  const resumedTarget = api.prepareWorkspaceHandoff(local)
  assert.equal(api.prepareWorkspaceHandoff(local).journalId, resumedTarget.journalId)
  const fs = createRequire(import.meta.url)('node:fs'), originalRename = fs.renameSync
  let injected = false
  fs.renameSync = (from, to) => {
    if (!injected && to === join(meta.cwd, 'new.txt')) { injected = true; throw new Error('injected mid-transfer failure') }
    return originalRename(from, to)
  }
  try { assert.throws(() => api.executeWorkspaceHandoffTarget(resumedTarget), /injected/); assert.equal(injected, true) }
  finally { fs.renameSync = originalRename }
  assert.equal(api.workspaceHandoffView(local).pending, true)
  assert.throws(() => api.assertWorkspaceHandoffReady(local), /尚未完成/)
  api.executeWorkspaceHandoffTarget(resumedTarget)
  api.executeWorkspaceHandoffTarget(resumedTarget)
  pass('interrupted file transfer blocks sending and resumes from frozen old/new byte states')
  const resumed = api.restoreWorkspaceHandoff(baseMeta)
  assert.equal(resumed.id, baseMeta.id); assert.equal(resumed.cwd, meta.cwd)
  assert.equal(readFileSync(join(resumed.cwd, 'new.txt'), 'utf8'), 'next round\n')
  pass('same pending decision is retried idempotently; durable placement restores stale metadata')
  const journal = readdirSync(join(data, 'workspace-handoffs')).filter(name => !name.startsWith('session-') && name.endsWith('.json')).map(name => join(data, 'workspace-handoffs', name))
    .find(file => JSON.parse(readFileSync(file, 'utf8')).id === resumedTarget.journalId)
  const saved = readFileSync(journal, 'utf8'), parsed = JSON.parse(saved); parsed.sourceMeta.id = 'foreign'; writeFileSync(journal, JSON.stringify(parsed))
  assert.throws(() => api.restoreWorkspaceHandoff(baseMeta), /损坏|身份|校验/)
  writeFileSync(journal, saved)
  pass('tampered journal cannot replace task identity')
  writeFileSync(join(resumed.cwd, 'gateway.txt'), 'through production gateway\n')
  await api.executeWorkspaceHandoffOperation(resumed)
  const gatewayLocal = api.restoreWorkspaceHandoff(resumed)
  assert.equal(gatewayLocal.cwd, repo)
  assert.equal(readFileSync(join(repo, 'gateway.txt'), 'utf8'), 'through production gateway\n')
  assert.equal(await api.getTaskSnapshot(`operation:${gatewayLocal.workspaceHandoff.id}`), null)
  pass('production Effect gateway commits and settles without replacing the source Session')
  writeFileSync(join(repo, 'gateway.txt'), 'retry gateway\n')
  writeFileSync(join(repo, 'a.txt'), 'first mutation before interruption\n')
  let gatewayInjected = false
  fs.renameSync = (from, to) => {
    if (!gatewayInjected && to === join(resumed.cwd, 'gateway.txt')) { gatewayInjected = true; throw new Error('injected gateway transfer failure') }
    return originalRename(from, to)
  }
  try { await assert.rejects(api.executeWorkspaceHandoffOperation(gatewayLocal), /injected gateway|交接/); assert.equal(gatewayInjected, true) }
  finally { fs.renameSync = originalRename }
  const pendingJournal = api.prepareWorkspaceHandoff(gatewayLocal)
  const pendingOperation = await api.getTaskSnapshot(`operation:${pendingJournal.journalId}`)
  assert.equal(pendingOperation.run.effects.at(-1).status, 'waiting_reconciliation')
  const effectId = pendingOperation.run.effects.at(-1).id
  await api.executeWorkspaceHandoffOperation(gatewayLocal)
  assert.equal(await api.getTaskSnapshot(`operation:${pendingJournal.journalId}`), null)
  assert.equal(readFileSync(join(resumed.cwd, 'gateway.txt'), 'utf8'), 'retry gateway\n')
  assert.equal(api.restoreWorkspaceHandoff(gatewayLocal).workspaceHandoff.id, pendingJournal.journalId)
  assert.ok(effectId)
  pass('production gateway failure resumes its original Effect and clears the pending operation')
  console.log(`workspace-handoff-required: ${checks}/${checks}; real temporary Git repositories; no Provider or network I/O`)
} finally { rmSync(root, { recursive: true, force: true }); delete globalThis.__handoffRoot }
