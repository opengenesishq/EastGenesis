import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Module } from 'node:module'
import { build } from 'esbuild'

const repo = process.cwd(), root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-authority-ipc-')))
const report = join(repo, 'test-results/task-execution-authority-ipc/latest.json')
const key = '__caogenTaskAuthorityIpcFixture', checks = [], sessions = new Map(), handlers = new Map()
const originalFetch = globalThis.fetch, originalError = console.error
let markerCalls = 0, failSynchronization = false, networkCalls = 0, synchronizationFailures = 0
globalThis.fetch = async () => { networkCalls++; throw new Error('Network forbidden in IPC authority fixture') }
console.error = (...args) => {
  if (args[0] === '[Task authority] Revoked access; Session synchronization failed' && args[1]?.message === 'controlled workflow failure latch') {
    synchronizationFailures++; return
  }
  originalError(...args)
}
globalThis[key] = {
  electron: { app: { getPath: () => root }, ipcMain: { handle: (name, handler) => handlers.set(name, handler) } },
  sessionManager: {
    whenInitialized: async () => undefined,
    get: id => sessions.get(id),
    requireTaskExecutionAuthority: async id => {
      markerCalls++
      if (failSynchronization) throw new Error('controlled workflow failure latch')
      sessions.get(id).meta.taskExecutionAuthorityRequired = true
    }
  },
  assertTrustedWorkflowLedgerSender: event => assert.equal(event.sender.id, 7),
  assertPersistedSessionDomainOwnership: async meta => assert.equal(sessions.get(meta.id)?.meta.workspaceId, meta.workspaceId)
}

function fixture(id) {
  const cwd = join(root, id); mkdirSync(cwd); mkdirSync(join(cwd, 'reports'))
  const meta = { id, cwd, createdAt: Date.now(), status: 'idle', taskStrategy: 'execute', permissionMode: 'acceptEdits',
    workspaceId: 'project', goalId: 'goal', workItemId: `work-${id}`, businessLineId: 'studio' }
  sessions.set(id, { meta }); return meta
}
const event = { sender: { id: 7 } }
const invoke = (operation, meta, input) => handlers.get(`taskExecutionAuthority:${operation}`)(event, meta.id, input)
async function check(name, operation) {
  try { await operation(); checks.push({ name, status: 'passed' }) }
  catch (error) { checks.push({ name, status: 'failed', detail: String(error) }) }
}

try {
  const output = await build({
    stdin: { contents: `
      export { registerTaskExecutionAuthorityIpc } from './src/main/ipc/task-execution-authority-handlers'
      export { TaskExecutionAuthorityStore } from './src/main/permission/task-execution-authority-store'
      export { formalFileWriteGuard } from './src/main/permission/limited-file-execution'
      export { writeTextFileLocally } from './src/main/sandbox/local-execution'
      export { configurePermissionAuditUserDataRoot } from './src/main/permission/audit-log'
    `, resolveDir: repo, sourcefile: 'task-authority-ipc-entry.ts', loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', packages: 'external',
    plugins: [{ name: 'authority-ipc-boundaries', setup(builder) {
      builder.onResolve({ filter: /^electron$|(?:^|\/)(?:sessionManager(?:\.js)?|session-create-lifecycle|workflow-ledger-handlers)$/ }, args => {
        const name = args.path === 'electron' ? 'electron' : args.path.split('/').at(-1).replace(/\.js$/, '')
        return { path: name, namespace: 'authority-ipc-boundaries' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'authority-ipc-boundaries' }, args => ({ loader: 'js', contents:
        args.path === 'electron' ? `module.exports = globalThis.${key}.electron` :
          args.path === 'sessionManager' ? `module.exports = { sessionManager: globalThis.${key}.sessionManager }` :
            args.path === 'session-create-lifecycle' ? `module.exports = { assertPersistedSessionDomainOwnership: globalThis.${key}.assertPersistedSessionDomainOwnership }` :
              `module.exports = { assertTrustedWorkflowLedgerSender: globalThis.${key}.assertTrustedWorkflowLedgerSender }`
      }))
    } }]
  })
  const filename = resolve('scripts/.task-authority-ipc-bundle.cjs'), mod = new Module(filename)
  mod.filename = filename; mod.paths = Module._nodeModulePaths(dirname(filename))
  mod._compile(output.outputFiles[0].text, filename)
  const { registerTaskExecutionAuthorityIpc, TaskExecutionAuthorityStore, formalFileWriteGuard,
    writeTextFileLocally, configurePermissionAuditUserDataRoot } = mod.exports
  configurePermissionAuditUserDataRoot(root)
  registerTaskExecutionAuthorityIpc()
  const store = new TaskExecutionAuthorityStore(root)
  const grantRequest = async (meta, patch = {}) => {
    const view = await invoke('get', meta)
    return { expectedRevision: view.revision, expectedBindingDigest: view.bindingDigest,
      pathPatterns: ['reports/**'], allowedWriteTools: ['write_file', 'edit_file'], ...patch }
  }

  await check('real IPC validates complete grant before setting any portable marker', async () => {
    const meta = fixture('invalid-grant'), before = markerCalls
    for (const patch of [{ pathPatterns: ['../outside/**'] }, { allowedWriteTools: ['bash'] },
      { expectedBindingDigest: 'stale-preview' }, { expectedRevision: 99 }]) {
      await assert.rejects(invoke('grant', meta, await grantRequest(meta, patch)))
      assert.equal(markerCalls, before); assert.equal(meta.taskExecutionAuthorityRequired, undefined)
      assert.equal(store.get(meta).status, 'legacy'); assert.equal(store.get(meta).revision, 0)
    }
    meta.status = 'running'
    await assert.rejects(invoke('grant', meta, await grantRequest(meta)), /暂停/)
    assert.equal(markerCalls, before); assert.equal(meta.taskExecutionAuthorityRequired, undefined)
  })

  await check('real IPC revoke survives synchronization failure and the physical writer preserves existing bytes', async () => {
    const meta = fixture('granted-task'), granted = await invoke('grant', meta, await grantRequest(meta))
    assert.equal(granted.status, 'granted'); assert.equal(granted.available, true)
    assert.equal(meta.taskExecutionAuthorityRequired, true)
    const path = join(meta.cwd, 'reports/kept.md'), original = Buffer.from('original bytes')
    const guard = formalFileWriteGuard('write_file', { path }, meta.cwd,
      { sessionMeta: meta, sessionId: meta.id, rootDir: root, taskExecutionAuthorityRevision: granted.revision })
    guard()
    const initial = await writeTextFileLocally({ cwd: meta.cwd, targetPath: path, content: original.toString(), mode: 'restrictedLocal',
      timeoutMs: 1000, assertWriteAuthorized: guard })
    assert.equal(initial.ok, true, initial.output)
    const info = statSync(path, { bigint: true })
    meta.status = 'running'; failSynchronization = true
    const revoked = await invoke('revoke', meta, { expectedRevision: granted.revision })
    assert.equal(revoked.status, 'revoked'); assert.equal(revoked.available, false)
    assert.equal(new TaskExecutionAuthorityStore(root).get(meta).status, 'revoked')
    const result = await writeTextFileLocally({ cwd: meta.cwd, targetPath: path, content: 'must not overwrite', mode: 'restrictedLocal',
      timeoutMs: 1000, expectedFile: { identity: { device: String(info.dev), inode: String(info.ino) },
        sha256: createHash('sha256').update(original).digest('hex'), bytes: original.length }, assertWriteAuthorized: guard })
    assert.equal(result.ok, false); assert.match(result.output, /撤销或变更/)
    assert.deepEqual(readFileSync(path), original); assert.equal(synchronizationFailures, 1)
    failSynchronization = false
  })

  await check('legacy revoke is durable even when marker synchronization fails before changing SessionMeta', async () => {
    const meta = fixture('legacy-revoke')
    failSynchronization = true
    const revoked = await invoke('revoke', meta, { expectedRevision: 0 })
    assert.equal(revoked.status, 'revoked'); assert.equal(revoked.revision, 1)
    assert.equal(meta.taskExecutionAuthorityRequired, undefined)
    assert.equal(new TaskExecutionAuthorityStore(root).get(meta).status, 'revoked')
    const path = join(meta.cwd, 'reports/forbidden.md')
    const guard = formalFileWriteGuard('write_file', { path }, meta.cwd, { sessionMeta: meta, rootDir: root })
    const result = await writeTextFileLocally({ cwd: meta.cwd, targetPath: path, content: 'blocked', mode: 'restrictedLocal',
      timeoutMs: 1000, assertWriteAuthorized: guard })
    assert.equal(result.ok, false); assert.equal(existsSync(path), false); assert.equal(synchronizationFailures, 2)
    failSynchronization = false
  })
} catch (error) {
  checks.push({ name: 'IPC fixture setup', status: 'failed', detail: String(error) })
} finally {
  globalThis.fetch = originalFetch; console.error = originalError; delete globalThis[key]
  const failed = checks.filter(check => check.status === 'failed')
  mkdirSync(dirname(report), { recursive: true })
  writeFileSync(report, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), status: failed.length ? 'failed' : 'passed',
    providerCalls: networkCalls, checks, limitations: ['Actual IPC handlers, durable store and physical text writer; only Electron, session manager, trusted sender and ownership boundaries are mocked. No Electron UI or Provider calls.'] }, null, 2) + '\n')
  rmSync(root, { recursive: true, force: true })
  console.log(`Task execution authority IPC: ${checks.length - failed.length}/${checks.length} passed\n${report}`)
  if (failed.length || networkCalls) { console.error(failed); process.exitCode = 1 }
}
