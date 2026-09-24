import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { Module } from 'node:module'
import { dirname, resolve } from 'node:path'
import { webcrypto } from 'node:crypto'

const storage = new Map(), calls = [], records = new Map()
let state, failStorage = false, sendMode = 'success', sentResolve, sendEntered
globalThis.crypto ??= webcrypto
globalThis.__remoteIntakeRendererStore = { getState: () => state }
const localStorage = { getItem: key => storage.get(key) ?? null, setItem(key, value) { if (failStorage) throw Error('quota'); storage.set(key, value) }, removeItem: key => storage.delete(key) }
globalThis.window = { localStorage, agentDesk: { taskWindowSessionId: null } }
try {
  const bundled = await build({ stdin: { contents: `export * from './src/renderer/src/components/experience/welcome-remote-task';export * from './src/renderer/src/components/experience/welcome-remote-target';export * from './src/renderer/src/store/welcome-draft';export * from './src/renderer/src/store/welcome-draft-persistence';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{ name: 'renderer-intake-store', setup(b) { b.onResolve({ filter: /\/store$/ }, () => ({ path: 'store', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const useStore=globalThis.__remoteIntakeRendererStore', loader: 'js' })) } }] })
  const filename = resolve('scripts/.remote-intake-renderer-fixture.cjs'), mod = new Module(filename)
  mod.filename = filename; mod.paths = Module._nodeModulePaths(dirname(filename)); mod._compile(bundled.outputFiles[0].text, filename)
  const api = mod.exports
  state = api.createWelcomeDraftSlice(update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } })
  const host = { id: 'host-original', label: 'Remote fixture', storage: 'encrypted', status: 'paired', projectId: 'project-original', deviceId: 'device-original',
    identity: { origin: 'https://fixture.invalid', spkiFingerprint: `sha256:${'a'.repeat(64)}` }, capabilities: ['create_task'], expiresAt: Date.now() + 86400000, commands: [], createdAt: Date.now() }
  const target = api.remoteTarget(host)
  const setDraft = text => state.updateWelcomeDraft({ text, executionTarget: target, providerId: 'local-provider-must-not-leak', model: 'local-model', cwd: '/local/secret', permissionMode: 'bypassPermissions' })
  Object.assign(window.agentDesk, {
    listRemoteHosts: async () => ({ hosts: [host] }),
    readRemoteHostTasks: async () => ({ projectId: host.projectId, projectRevision: 7, capabilities: ['create_task'] }),
    findRemoteHostCommandByRequestId: async (_, requestId) => records.get(requestId) ?? null,
    reconcileRemoteHostCommand: async (_, commandId) => [...records.values()].find(item => item.commandId === commandId),
    sendRemoteHostCommand: async input => {
      calls.push(input)
      assert.deepEqual(Object.keys(input).sort(), ['expectedConnection', 'expectedRevision', 'hostId', 'kind', 'requestId', 'source', 'text'].sort())
      const persisted = JSON.parse(storage.get(api.WELCOME_DRAFT_STORAGE_KEY))
      assert.ok(persisted.draft.remoteIntakes.some(item => item.requestId === input.requestId))
      if (sendMode === 'before-record') throw Error('revision changed before ledger')
      const result = { commandId: `command-${calls.length}`, requestId: input.requestId, source: 'welcome', kind: 'create_task', state: 'received', status: 'accepted', createdAt: Date.now(),
        execution: { status: 'succeeded' }, createPhase: 'input_received', createdTask: { projectId: host.projectId, goalId: 'exact-goal', workItemId: 'exact-work-item', sessionId: 'exact-session' } }
      records.set(input.requestId, result)
      if (sendMode === 'lost') throw Error('reply lost')
      if (sendMode === 'delayed') { sendEntered(); await new Promise(resolve => { sentResolve = resolve }) }
      return result
    }
  })
  const legacy = { ...api.emptyWelcomeDraft(), text: 'legacy', executionTarget: target, unexpected: 'do not spread unknown fields' }
  storage.set(api.WELCOME_DRAFT_STORAGE_KEY, JSON.stringify({ schemaVersion: 4, draft: legacy }))
  assert.equal(api.loadWelcomeDraft(api.emptyWelcomeDraft()).executionTarget.kind, 'local')
  assert.equal(api.loadWelcomeDraft(api.emptyWelcomeDraft()).unexpected, undefined)
  setDraft('Create a remote report')
  await api.submitWelcomeRemote(state.welcomeDraft, state.welcomeDraft.text)
  assert.equal(state.welcomeDraft.text, '')
  assert.equal(state.welcomeDraft.providerId, 'local-provider-must-not-leak')
  assert.equal(calls[0].expectedConnection.deviceId, host.deviceId)
  const history = Array.from({ length: 201 }, (_, index) => ({ ...state.welcomeDraft.remoteIntakes[0], requestId: `history-${index}` }))
  assert.equal(api.parseRemoteIntakes(history).length, 201)
  assert.notEqual(api.remoteCreateLabel({ state: 'received', execution: { status: 'succeeded' } }, true), '任务已完成')
  console.log('PASS legacy local migration, strict persisted reference before IPC and remote-only payload whitelist')

  setDraft('Lost response original objective'); sendMode = 'lost'
  await assert.rejects(api.submitWelcomeRemote(state.welcomeDraft, state.welcomeDraft.text), /原请求已保留/)
  const reference = state.welcomeDraft.remoteIntakes.at(-1), count = calls.length
  const recovered = await api.recoverRemoteIntake(reference, true)
  assert.equal(recovered.createdTask.sessionId, 'exact-session'); assert.equal(calls.length, count)
  setDraft('Lost response original objective')
  await assert.rejects(api.submitWelcomeRemote(state.welcomeDraft, state.welcomeDraft.text), /已有原提交/)
  assert.equal(calls.length, count)
  await assert.rejects(api.releaseUnrecordedRemoteIntake(reference), /已有原命令/)
  setDraft('Slow response keeps edited text'); sendMode = 'delayed'
  const entered = new Promise(resolve => { sendEntered = resolve })
  const pending = api.submitWelcomeRemote(state.welcomeDraft, state.welcomeDraft.text)
  await entered; state.updateWelcomeDraft({ text: 'User edited while request was running' }); sentResolve(); await pending
  assert.equal(state.welcomeDraft.text, 'User edited while request was running')
  console.log('PASS lost IPC reply recovers exact task with no second send and late reply preserves newer draft')

  sendMode = 'before-record'; setDraft('Revision rejected before local ledger')
  await assert.rejects(api.submitWelcomeRemote(state.welcomeDraft, state.welcomeDraft.text), /待核对/)
  const unrecorded = state.welcomeDraft.remoteIntakes.at(-1)
  assert.equal(await api.recoverRemoteIntake(unrecorded, false), null)
  await api.releaseUnrecordedRemoteIntake(unrecorded)
  assert.ok(!state.welcomeDraft.remoteIntakes.some(item => item.requestId === unrecorded.requestId))
  sendMode = 'success'; setDraft('Storage failure must not send')
  const beforeStorage = calls.length; failStorage = true
  await assert.rejects(api.submitWelcomeRemote(state.welcomeDraft, state.welcomeDraft.text), /无法保存/)
  assert.equal(calls.length, beforeStorage); assert.equal(state.welcomeDraft.text, 'Storage failure must not send')
  failStorage = false
  state.updateWelcomeDraft({ forkFromSdkSessionId: 'original-fork' })
  await assert.rejects(api.submitWelcomeRemote(state.welcomeDraft, state.welcomeDraft.text), /分叉/)
  state.updateWelcomeDraft({ forkFromSdkSessionId: undefined })
  window.agentDesk.taskWindowSessionId = 'detached-task'
  await assert.rejects(api.submitWelcomeRemote(state.welcomeDraft, state.welcomeDraft.text), /主工作台/)
  assert.equal(calls.length, beforeStorage)
  console.log('PASS explicit unrecorded-reference release, storage fail-closed and fork/detached-window isolation')
} finally {
  delete globalThis.__remoteIntakeRendererStore
  delete globalThis.window
}
