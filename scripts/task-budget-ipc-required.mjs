import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire, Module } from 'node:module'
const require = createRequire(import.meta.url), ts = require('typescript'), cache = new Map(), stubs = new Map()
const channels = new Map(), calls = [], meta = { id: 'opened-task', goalId: 'server-goal', workspaceId: 'server-project', costUsd: .3 }
let trusted = true
stubs.set('electron', { app: { getPath: () => '/isolated-budget-fixture' }, ipcMain: { handle: (id, handler) => channels.set(id, handler) },
  ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ state: 'ready' }) } } })
stubs.set(resolve('src/main/sessionManager.ts'), { sessionManager: { list: () => [meta] } })
stubs.set(resolve('src/main/history.ts'), { listHistory: () => [{ id: 'historical-sibling', costUsd: .2 }] })
stubs.set(resolve('src/main/ipc/session-ready-handler.ts'), { sessionReadyHandler: handler => handler })
stubs.set(resolve('src/main/ipc/workflow-ledger-handlers.ts'), { assertTrustedWorkflowLedgerSender: () => { if (!trusted) throw new Error('untrusted') } })
stubs.set(resolve('src/main/budget/task-budget-projection.ts'), { readTaskBudget: (...args) => { calls.push(args); return { state: 'ready' } } })
function load(file) {
  if (stubs.has(file)) return stubs.get(file)
  if (cache.has(file)) return cache.get(file).exports
  const mod = new Module(file); cache.set(file, mod); mod.filename = file; mod.paths = Module._nodeModulePaths(dirname(file))
  mod.require = name => {
    if (stubs.has(name)) return stubs.get(name)
    if (!name.startsWith('.')) return require(name)
    const target = resolve(dirname(file), name)
    return load(existsSync(`${target}.ts`) ? `${target}.ts` : target)
  }
  mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, file)
  return mod.exports
}
load(resolve('src/main/ipc/task-budget-handlers.ts')).registerTaskBudgetIpc()
const get = channels.get('taskBudget:get')
assert.equal(channels.size, 1)
assert.deepEqual(get({}, meta.id), { state: 'ready' })
assert.equal(calls[0][0], meta)
assert.deepEqual(calls[0][1], [{ id: 'historical-sibling', costUsd: .2 }, meta])
assert.equal(calls[0][2], '/isolated-budget-fixture')
console.log('PASS only Session ID is accepted; canonical ownership and root come from main process')
const before = calls.length
for (const input of ['', {}, { id: meta.id, goalId: 'forged' }, 'missing', 'bad\0id']) assert.throws(() => get({}, input))
trusted = false
assert.throws(() => get({}, meta.id), /untrusted/)
assert.equal(calls.length, before)
console.log('PASS invalid sessions and untrusted senders never reach the ledger projection')
const api = load(resolve('src/preload/task-budget.ts')).taskBudgetApi
await api.getTaskBudget(meta.id)
assert.deepEqual(calls.at(-1), ['taskBudget:get', meta.id])
console.log('PASS preload exposes the single read-only budget channel')
console.log('Task budget IPC checks: 3/3 passed; no Provider calls.')
