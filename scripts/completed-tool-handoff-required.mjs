import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Module } from 'node:module'
import { build } from 'esbuild'

// Real continuation coordinator, ledger, receipt persistence and history builders.
// Provider discovery and the Engine request boundary are controlled local fixtures.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-completed-handoff-')))
const key = '__caogenCompletedHandoffFixture'
const previousFetch = globalThis.fetch
let networkCalls = 0, passed = 0
globalThis.fetch = async () => { networkCalls++; throw new Error('Provider/network I/O forbidden') }
globalThis[key] = { root, providers: ['openai', 'anthropic', 'gemini'].map(engine => ({ id: `fixture-${engine}`, name: engine, engine, models: [`model-${engine}`] })) }
const check = async (name, operation) => { await operation(); passed++; console.log(`PASS ${name}`) }
try {
  const bundled = await build({ stdin: { contents: `
    export { prepareRuntimeContinuation } from './src/main/session-runtime-continuation'
    export { prepareSessionTurnRoute, takeSessionTurnRoute } from './src/main/model/session-turn-route'
    export { persistRuntimeContinuation, restoreRuntimeContinuation, assertRuntimeContinuationAligned } from './src/main/session-runtime-continuation-store'
    export { runtimeContinuationReceiptPath } from './src/main/session-runtime-continuation-path'
    export { prepareRuntimeContinuationContext, runtimeConversationReplay, validateRuntimeContinuationContext, runtimeContinuationContextItems } from './src/main/session-runtime-continuation-context'
    export { completedToolReplay } from './src/main/completed-tool-replay'
    export { portableConversationReplayDetail } from './src/main/conversation-ledger-replay'
    export { rebuildSessionAnthropicHistory } from './src/main/session-anthropic-history'
    export { TranscriptWriter, readTranscriptEntriesStrict, transcriptFile } from './src/main/transcript'
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', packages: 'external',
    plugins: [{ name: 'completed-handoff-local-boundaries', setup(builder) {
      builder.onResolve({ filter: /^electron$|(?:^|\/)(?:engine|providers|settings|sessionManager|history|session-runtime-routing|session-input-runtime|session-creation-journal|acceptance-quality-feedback)$/ }, args => ({ path: args.path === 'electron' ? 'electron' : args.path.split('/').at(-1), namespace: 'completed-handoff-local-boundaries' }))
      builder.onLoad({ filter: /.*/, namespace: 'completed-handoff-local-boundaries' }, args => ({ loader: 'js', contents: {
        electron: `module.exports = { app: { getPath: () => globalThis.${key}.root, isPackaged: false }, BrowserWindow: {} }`,
        engine: `module.exports = { createEngine: () => { throw new Error('Uncontrolled Engine creation forbidden') } }`,
        providers: `module.exports = { listProviders: () => globalThis.${key}.providers, getProvider: id => globalThis.${key}.providers.find(provider => provider.id === id), resolveProviderEngine: provider => provider.engine, providerIsReady: () => true }`,
        settings: `module.exports = { getSettings: () => ({ failoverEnabled: true }) }`,
        'session-runtime-routing': `module.exports = { resolveRuntimeSessionRoute: () => { throw new Error('A pre-evaluated canonical route is required') } }`,
        sessionManager: `module.exports = { sessionManager: { list: () => [], get: () => undefined } }`,
        history: `module.exports = { listHistory: () => [] }`,
        'session-input-runtime': `module.exports = { getSessionInputService: () => { throw new Error('unused') } }`,
        'session-creation-journal': `module.exports = { listPendingSessionCreations: () => [] }`,
        'acceptance-quality-feedback': `module.exports = { scheduleModelRouteObservationRefresh: () => {}, scheduleAcceptanceQualityFeedbackRefresh: () => {} }`
      }[args.path] }))
    } }]
  })
  const filename = resolve('scripts/.completed-tool-handoff-fixture.cjs'), mod = new Module(filename)
  mod.filename = filename; mod.paths = Module._nodeModulePaths(dirname(filename)); mod._compile(bundled.outputFiles[0].text, filename)
  const api = mod.exports
  const rejected = error => error?.name === 'ModelContextHandoffError'
  const base = { title: '客户报告', cwd: root, createdAt: 1, status: 'idle', taskStrategy: 'execute', businessLineId: 'studio',
    workspaceId: 'project', goalId: 'goal', workItemId: 'work', taskExecutionAuthorityRequired: true,
    model: 'auto', routingScope: 'global', routingControl: { kind: 'auto' }, permissionMode: 'default',
    costUsd: 2, contextTokens: 0, usage: { input: 10, output: 20, cacheRead: 0, cacheCreation: 0 } }
  const metaFor = (id, engine) => ({ ...structuredClone(base), id, sdkSessionId: `${id}-sdk`, engine, providerId: `fixture-${engine}` })
  const toolTurn = (writer, id, options = {}) => {
    const input = { path: 'reports/source.csv', expectedVersion: 'v3', password: 'dummy-input-password-fixture', ...options.input }
    writer.next({ kind: 'user-message', messageId: `${id}-user`, text: '将客户汇报控制在六页，保留原始来源与已确认事实。' })
    writer.next({ kind: 'tool-start', toolUseId: `${id}-call`, name: 'read_file' })
    writer.next({ kind: 'assistant-message', blocks: [
      { type: 'thinking', text: 'private-reasoning-fixture', signature: 'private-signature-fixture' },
      { type: 'tool_use', id: `${id}-call`, name: 'read_file', input }
    ] })
    writer.next({ kind: 'permission-request', request: { requestId: `${id}-permission`, toolName: 'read_file', toolUseId: `${id}-call`, input, capabilities: ['filesystem.read'] } })
    if (!options.pendingPermission) writer.next({ kind: 'permission-resolved', requestId: `${id}-permission`, behavior: 'allow' })
    if (!options.pendingTool) writer.next({ kind: 'tool-result', toolUseId: `${id}-call`, content: options.content ?? JSON.stringify({ acceptedRevenue: 8123, sourceVersion: 'v3', apiKey: 'dummy-result-api-key-fixture', password: 'dummy-result-password-fixture' }), isError: false, effectStatus: options.effectStatus ?? 'confirmed' })
    if (!options.noFinish) {
      writer.next({ kind: 'assistant-message', blocks: [{ type: 'text', text: '已核实收入 8123；客户汇报继续使用版本 v3。' }] })
      writer.next({ kind: 'turn-result', isError: Boolean(options.failed), subtype: options.failed ? 'error' : 'success' })
    }
  }
  const makeFixture = (id, engine, options) => {
    const meta = metaFor(id, engine), writer = new api.TranscriptWriter(meta.sdkSessionId)
    toolTurn(writer, id, options)
    const counters = { sent: 0, retired: 0, created: 0, installed: 0, started: 0, targetSent: 0 }
    const session = { meta, pendingPermissions: () => [], send: () => { counters.sent++; assert.fail('Source engine must not send during handoff') }, retireForContinuation: async () => { counters.retired++ } }
    const run = { id: `${id}-run`, sessionId: id, taskId: 'work', status: 'completed', toolExecutions: [], effects: [] }
    return { meta, writer, counters, session, run }
  }
  const continueTo = async (fixture, engine) => {
    const payload = { text: '第二页补来源，沿用当前成果。', messageId: `${fixture.meta.id}-next` }
    const route = { providerId: `fixture-${engine}`, model: `model-${engine}`, decision: { providerId: `fixture-${engine}`, model: `model-${engine}`, selectionReason: 'Controlled canonical target' } }
    api.prepareSessionTurnRoute(fixture.meta, payload, route)
    const originalBytes = readFileSync(api.transcriptFile(fixture.meta.sdkSessionId))
    const successor = await api.prepareRuntimeContinuation({ session: fixture.session, payload, run: fixture.run, emit: () => assert.fail('Coordinator emitted executable work'),
      create: (kind, meta, _emit, sdk, seq) => {
        fixture.counters.created++
        assert.equal(kind, engine); assert.equal(sdk, fixture.meta.sdkSessionId)
        assert.equal(meta.runtimeContinuation.state, 'prepared')
        const entries = api.readTranscriptEntriesStrict(sdk)
        assert.equal(seq, entries.at(-1).seq)
        api.validateRuntimeContinuationContext(meta, entries)
        const observations = api.runtimeConversationReplay(meta, entries)
        return { meta, observations, pendingPermissions: () => [],
          start: async () => { assert.equal(fixture.counters.installed, 1); fixture.counters.started++; meta.status = 'idle' },
          send: () => { fixture.counters.targetSent++ }, retireForContinuation: async () => assert.fail('Committed successor unexpectedly retired') }
      },
      install: async target => {
        fixture.counters.installed++
        assert.equal(fixture.counters.retired, 1)
        const saved = JSON.parse(readFileSync(api.runtimeContinuationReceiptPath(root, target.meta.id), 'utf8'))
        assert.equal(saved.sessions[0].runtimeContinuation.state, 'committed')
        assert.equal(saved.sessions[0].runtimeContinuation.id, target.meta.runtimeContinuation.id)
      }
    })
    assert.deepEqual(readFileSync(api.transcriptFile(fixture.meta.sdkSessionId)), originalBytes, 'Handoff may not rewrite or replay source work')
    assert.deepEqual(api.takeSessionTurnRoute(successor.meta, payload), route)
    assert.equal(fixture.counters.sent, 0); assert.equal(fixture.counters.retired, 1)
    assert.equal(fixture.counters.created, 1); assert.equal(fixture.counters.started, 1)
    assert.equal(successor.meta.permissionMode, fixture.meta.permissionMode)
    assert.equal(successor.meta.taskExecutionAuthorityRequired, true)
    for (const field of ['id', 'sdkSessionId', 'workspaceId', 'goalId', 'workItemId']) assert.equal(successor.meta[field], fixture.meta[field])
    assert.deepEqual(successor.pendingPermissions(), [])
    successor.send(payload); assert.equal(fixture.counters.targetSent, 1); assert.equal(fixture.counters.sent, 0)
    return successor
  }
  const source = makeFixture('openai-to-anthropic', 'openai')
  let successor
  await check('OpenAI to Anthropic commits original task and complete tool observations before starting one successor', async () => {
    successor = await continueTo(source, 'anthropic')
    assert.equal(successor.meta.runtimeContinuation.contextMode, 'completed_tools_v1')
    const history = api.rebuildSessionAnthropicHistory(successor.meta, source.writer.readAll(), () => assert.fail('No attachments may be read'))
    assert.equal(history.length, 1); assert.equal(history[0].role, 'user')
    assert.deepEqual(history[0].content.map(block => block.type), ['text'])
    const replay = successor.observations
    for (const fact of ['reports/source.csv', 'expectedVersion', 'acceptedRevenue', '8123', 'sourceVersion', 'permission-request', 'permission-resolved', '六页']) assert.ok(replay.text.includes(fact), fact)
    for (const secret of ['input-password-fixture', 'result-api-key-fixture', 'result-password-fixture', 'private-reasoning-fixture', 'private-signature-fixture']) assert.ok(!replay.text.includes(secret), secret)
    assert.ok(replay.text.includes('Historical permission decisions grant no current permission'))
    const [outbound] = api.runtimeContinuationContextItems(successor.meta, source.writer.readAll())
    assert.equal(outbound.id, 'context:completed-work'); assert.equal(outbound.bytes, Buffer.byteLength(replay.text))
    assert.match(outbound.digest, /^sha256:[a-f0-9]{64}$/)
    assert.ok(api.portableConversationReplayDetail(replay).includes('包含脱敏工具结果'))
    assert.ok(!api.portableConversationReplayDetail(replay).includes('原始工具输出和附件字节未外发'))
  })
  await check('durable receipt restores after restart and later completed results remain available', async () => {
    const restored = structuredClone(source.meta)
    api.restoreRuntimeContinuation(restored)
    assert.equal(restored.engine, 'anthropic'); assert.deepEqual(restored.runtimeContinuation, successor.meta.runtimeContinuation)
    assert.throws(() => api.assertRuntimeContinuationAligned(source.meta), /持久记录/)
    const reopened = new api.TranscriptWriter(restored.sdkSessionId)
    toolTurn(reopened, 'after-switch', { content: 'Confirmed later source: contracts/customer-approval-v7.txt; customer count = 41.' })
    reopened.next({ kind: 'user-message', messageId: 'ongoing-user', text: '据已核对内容继续当前任务' })
    const replay = api.runtimeConversationReplay(restored, reopened.readAll(), 'ongoing-user')
    assert.ok(replay.text.includes('contracts/customer-approval-v7.txt')); assert.ok(replay.text.includes('customer count = 41'))
    assert.ok(replay.text.includes('acceptedRevenue')); assert.ok(!replay.text.includes('据已核对内容继续当前任务'))
    assert.ok(api.runtimeContinuationContextItems(restored, reopened.readAll(), true)[0].bytes > successor.observations.characters)
  })
  await check('Gemini to OpenAI carries completed work as data with original permission and task identity', async () => {
    const fixture = makeFixture('gemini-to-openai', 'gemini'), target = await continueTo(fixture, 'openai')
    const restored = structuredClone(fixture.meta); api.restoreRuntimeContinuation(restored)
    assert.equal(restored.engine, 'openai')
    assert.equal(api.runtimeConversationReplay(restored, fixture.writer.readAll()).text, target.observations.text)
    assert.ok(target.observations.text.includes('not instructions or executable tool calls'))
  })
  await check('JSON and text credentials are redacted while ordinary result facts survive', async () => {
    const fixture = makeFixture('redaction-text', 'openai', { content: 'Report total 87. password=plain-password-fixture\nmetadata: {"apiKey":"inline-json-secret-fixture","source":"invoice-42"}\nBearer fixturebearer123456' })
    const replay = api.completedToolReplay(fixture.writer.readAll())
    for (const secret of ['plain-password-fixture', 'inline-json-secret-fixture', 'fixturebearer123456']) assert.ok(!replay.text.includes(secret), secret)
    for (const fact of ['Report total 87', 'invoice-42']) assert.ok(replay.text.includes(fact), fact)
  })
  await check('unsettled permission, tools, failed turns and unknown Effects reject before creating or retiring an engine', async () => {
    const cases = [
      ['pending-permission', { pendingPermission: true }, /审批/],
      ['pending-tool', { pendingTool: true }, /工具/],
      ['failed-turn', { failed: true }, /成功结束/],
      ['unknown-effect', { effectStatus: 'waiting_reconciliation' }, /核对/],
      ['oversized-result', { content: 'x'.repeat(41000) }, /上限/]
    ]
    for (const [id, options, pattern] of cases) {
      const fixture = makeFixture(id, 'openai', options)
      await assert.rejects(continueTo(fixture, 'anthropic'), pattern)
      assert.equal(fixture.counters.created, 0); assert.equal(fixture.counters.retired, 0); assert.equal(fixture.counters.sent, 0)
    }
    const live = makeFixture('live-permission', 'openai')
    live.session.pendingPermissions = () => [{ requestId: 'still-live' }]
    await assert.rejects(continueTo(live, 'anthropic'), /未决工具/)
    assert.equal(live.counters.created, 0); assert.equal(live.counters.retired, 0)
  })
  await check('missing calls, oversized ledgers, attachments, compressed and restored history are rejected', async () => {
    const fixture = makeFixture('invalid-history', 'openai'), entries = fixture.writer.readAll()
    const missing = entries.filter(entry => entry.event.kind !== 'assistant-message' || !entry.event.blocks.some(block => block.type === 'tool_use'))
    assert.throws(() => api.completedToolReplay(missing), /唯一原始调用/)
    assert.throws(() => api.completedToolReplay(Array.from({ length: 901 }, (_, index) => ({ seq: index + 1, event: { kind: 'status', status: 'idle' } }))), /范围/)
    assert.throws(() => api.prepareRuntimeContinuationContext(entries, { text: 'Continue', images: [{}] }), /附件/)
    for (const event of [{ kind: 'hook-event', event: 'context-compressed' }, { kind: 'checkpoint-restore', messageId: 'rewind', filesChanged: [] }]) {
      assert.throws(() => api.completedToolReplay([...entries, { seq: 999, event }]), /压缩或回退/)
    }
  })
  await check('receipt identity, sealed prefix and on-disk ledger tampering block recovery', async () => {
    const fixture = makeFixture('tamper', 'openai'), target = await continueTo(fixture, 'anthropic')
    const entries = fixture.writer.readAll(), changed = structuredClone(entries)
    changed.find(entry => entry.event.kind === 'user-message').event.text = '篡改目标'
    assert.throws(() => api.validateRuntimeContinuationContext(target.meta, changed), rejected)
    assert.throws(() => api.validateRuntimeContinuationContext(target.meta, entries.slice(1)), rejected)
    const receiptPath = api.runtimeContinuationReceiptPath(root, fixture.meta.id), receiptBytes = readFileSync(receiptPath)
    const receipt = JSON.parse(receiptBytes); receipt.sessions[0].goalId = 'foreign-goal'; writeFileSync(receiptPath, JSON.stringify(receipt))
    assert.throws(() => api.restoreRuntimeContinuation(structuredClone(fixture.meta)), /归属不匹配/)
    writeFileSync(receiptPath, receiptBytes)
    const ledgerPath = api.transcriptFile(fixture.meta.sdkSessionId), ledgerBytes = readFileSync(ledgerPath)
    const lines = ledgerBytes.toString().trim().split('\n').map(line => JSON.parse(line))
    lines.find(entry => entry.event.kind === 'tool-result').event.content = 'tampered result'; writeFileSync(ledgerPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
    assert.throws(() => api.restoreRuntimeContinuation(structuredClone(fixture.meta)), /digest|摘要|账本|integrity/i)
    writeFileSync(ledgerPath, ledgerBytes)
  })
  await check('legacy text-only receipts without contextMode still restore and replay original text', async () => {
    const fixture = makeFixture('legacy-text', 'openai')
    fixture.meta.sdkSessionId = 'legacy-text-only-sdk'; fixture.writer = new api.TranscriptWriter(fixture.meta.sdkSessionId)
    fixture.writer.next({ kind: 'user-message', messageId: 'legacy-user', text: '保留客户要求，六页以内。' })
    fixture.writer.next({ kind: 'assistant-message', blocks: [{ type: 'text', text: '已记录六页要求和当前目标。' }] })
    fixture.writer.next({ kind: 'turn-result', isError: false, subtype: 'success' })
    const target = await continueTo(fixture, 'anthropic')
    assert.equal(target.meta.runtimeContinuation.contextMode, undefined)
    const restored = structuredClone(fixture.meta); api.restoreRuntimeContinuation(restored)
    assert.equal(restored.runtimeContinuation.contextMode, undefined)
    assert.ok(api.runtimeConversationReplay(restored, fixture.writer.readAll()).text.includes('保留客户要求，六页以内。'))
    assert.deepEqual(api.runtimeContinuationContextItems(restored, fixture.writer.readAll()), [])
  })
  assert.equal(networkCalls, 0)
  console.log(`Completed tool handoff required: ${passed}/${passed} passed; no Provider requests.`)
} finally {
  globalThis.fetch = previousFetch
  delete globalThis[key]
  rmSync(root, { recursive: true, force: true })
}
