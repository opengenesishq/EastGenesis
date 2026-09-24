import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { BrowserDebugController, type BrowserDebugBinding } from '../src/main/browser-debug/controller'
import { debugEvaluationResult, debugText, debugUrl } from '../src/main/browser-debug/output'
import { BROWSER_DEBUG_LIMITS, BROWSER_DEBUG_TTL_MS, normalizeBrowserDebugPreferences } from '../src/shared/browser-debug-types'
import { isReadOnlyToolCall, isSideEffectingToolCall } from '../src/main/task/tool-idempotency'
import { AGENT_TOOL_EFFECT_ENTRY_POLICIES } from '../src/main/task/effect-entry-inventory'
import { configureKnownCredentialRedactor } from '../src/main/security/secret-redaction'

class FakeDebugger extends EventEmitter {
  attached = false
  calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  pending?: () => Promise<any>
  isAttached() { return this.attached }
  attach() { this.attached = true }
  detach() { this.attached = false; this.emit('detach', {}, 'cancelled') }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<any> {
    this.calls.push({ method, params })
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } }
    if (method === 'Runtime.enable') this.event('Runtime.executionContextCreated', { context: { id: 42, uniqueId: 'fixed-document-context', auxData: { isDefault: true, frameId: 'main-frame' } } })
    if (method === 'Performance.getMetrics') return { metrics: [{ name: 'Nodes', value: 7 }, { name: 'UnexpectedPayload', value: 9 }, { name: 'ScriptDuration', value: NaN }] }
    if (method === 'Runtime.evaluate') return this.pending ? this.pending() : { result: { value: { title: 'hello', password: 'short-secret' } } }
    return {}
  }
  event(method: string, params: Record<string, unknown>) { this.emit('message', {}, method, params) }
}

async function main(): Promise<void> {
  let now = 100_000, enabled = false, valid = true, groups = 0
  const controller = new BrowserDebugController(() => enabled, () => now)
  const transport = new FakeDebugger()
  const binding: BrowserDebugBinding = { ownerId: 5, url: 'https://user:pass@example.test/app?token=short-secret#private',
    target: { contextId: 'task-a', contextEpoch: 'epoch-a', tabId: 'tab-a', selectionRevision: 3, navigationRevision: 9 },
    transport, assertCurrent: () => { if (!valid) throw new Error('stale task or tab') } }
  try {
    assert.deepEqual(normalizeBrowserDebugPreferences(undefined), { enabled: false })
    await assert.rejects(controller.grant(binding), /默认关闭/)
    assert.equal(transport.calls.length, 0)
    enabled = true
    transport.attached = true
    await assert.rejects(controller.grant(binding), /其他调试器/)
    transport.attached = false
    let grant = await controller.grant(binding)
    assert.equal(grant.pageUrl, 'https://example.test/app')
    assert.throws(() => controller.assertGrant('task-b'), /没有有效/)
    assert.throws(() => controller.assertGrant('task-a', 6), /当前窗口/)
    assert.throws(() => controller.assertGrant('task-a', 5, 'wrong'), /已被替换/)
    groups++

    transport.event('Runtime.consoleAPICalled', { executionContextId: 42, timestamp: now - 1, type: 'log', args: [{ type: 'string', value: 'pre-grant private content' }] })
    transport.event('Runtime.consoleAPICalled', { executionContextId: 99, timestamp: now, type: 'log', args: [{ type: 'string', value: 'iframe private content' }] })
    for (let i = 0; i < 105; i++) {
      transport.event('Runtime.consoleAPICalled', { executionContextId: 42, timestamp: now, type: 'log', args: [
        { type: 'string', value: `row ${i} password=short-secret https://example.test/path?secret=abc#hidden` },
        { type: 'object', objectId: 'secret-handle', description: 'private object preview' }
      ] })
      transport.event('Network.requestWillBeSent', { requestId: `r${i}`, frameId: 'main-frame', type: 'Fetch', request: { url: 'https://example.test/api?session=short-secret', method: 'GET', headers: { Cookie: 'private' }, postData: 'private' } })
    }
    transport.event('Network.requestWillBeSent', { requestId: 'iframe', frameId: 'iframe', request: { url: 'https://example.test/iframe-private', method: 'POST' } })
    transport.event('Network.responseReceived', { requestId: 'r104', response: { status: 201, headers: { 'Set-Cookie': 'private' } } })
    transport.event('Network.loadingFinished', { requestId: 'r104', encodedDataLength: 20 })
    const snapshot = await controller.snapshot('task-a', grant.id)
    assert.equal(snapshot.console.length, 100); assert.equal(snapshot.network.length, 100)
    assert.deepEqual(snapshot.metrics, { Nodes: 7 })
    assert.equal(snapshot.network.at(-1)?.status, 201); assert.equal(snapshot.network.at(-1)?.bytes, 20)
    const rendered = JSON.stringify(snapshot)
    for (const denied of ['short-secret', 'pre-grant', 'iframe-private', 'private object', 'secret-handle', 'postData', 'Set-Cookie', '?secret=', '#hidden']) assert(!rendered.includes(denied), denied)
    assert(rendered.includes('[REDACTED]') && rendered.includes('[object omitted]'))
    groups++

    const expression = 'document.title'
    const approved = controller.evaluationBinding('task-a', expression)
    await assert.rejects(controller.evaluate('task-a', 'document.body.remove()', approved, async () => undefined), /脚本、文档或授权已变化/)
    await assert.rejects(controller.evaluate('task-a', expression, approved, async () => { throw new Error('page approval stale') }), /page approval stale/)
    assert.equal(transport.calls.filter(call => call.method === 'Runtime.evaluate').length, 0)
    const result = await controller.evaluate('task-a', expression, approved, async () => undefined)
    assert.deepEqual(result, { title: 'hello', password: '[REDACTED]' })
    const evaluate = transport.calls.find(call => call.method === 'Runtime.evaluate')!
    assert.equal(evaluate.params?.uniqueContextId, 'fixed-document-context')
    assert.equal(evaluate.params?.expression, expression)
    assert.equal(evaluate.params?.includeCommandLineAPI, false)
    assert.equal(isReadOnlyToolCall('browser_debug_snapshot', {}), true)
    assert.equal(isSideEffectingToolCall('browser_debug_evaluate', { expression }), true)
    assert.equal(AGENT_TOOL_EFFECT_ENTRY_POLICIES.browser_debug_evaluate.effect, 'opaque')
    assert.equal(AGENT_TOOL_EFFECT_ENTRY_POLICIES.browser_debug_evaluate.replay, 'manual_reconciliation')
    groups++

    let release!: (value: any) => void
    transport.pending = () => new Promise(resolve => { release = resolve })
    const pending = controller.evaluate('task-a', expression, approved, async () => undefined)
    await new Promise(resolve => setImmediate(resolve))
    controller.revokeSession('task-a', grant.id)
    release({ result: { value: 'must not surface after revocation' } })
    await assert.rejects(pending, /结果未知/)
    assert.equal(transport.calls.filter(call => call.method === 'Runtime.evaluate').length, 2)
    assert.equal(transport.isAttached(), false)
    assert.equal(transport.listenerCount('message'), 0)
    await assert.rejects(controller.snapshot('task-a'), /没有有效/)
    transport.pending = undefined
    groups++

    grant = await controller.grant(binding)
    const prior = controller.evaluationBinding('task-a', expression)
    transport.pending = async () => { throw new Error('lost reply') }
    await assert.rejects(controller.evaluate('task-a', expression, prior, async () => undefined), /结果未知/)
    assert.equal(transport.calls.filter(call => call.method === 'Runtime.evaluate').length, 3)
    assert.equal(controller.status('task-a'), undefined)
    transport.pending = undefined
    grant = await controller.grant(binding)
    transport.event('Runtime.executionContextDestroyed', { executionContextId: 42 })
    assert.equal(controller.status('task-a'), undefined)
    await controller.grant(binding)
    valid = false
    await assert.rejects(controller.snapshot('task-a'), /stale/)
    valid = true
    await controller.grant(binding)
    now += BROWSER_DEBUG_TTL_MS
    assert.equal(controller.status('task-a'), undefined)
    await controller.grant(binding)
    enabled = false; controller.revokeAll()
    assert.equal(controller.status('task-a'), undefined)
    assert.equal(transport.listenerCount('message'), 0)
    groups++

    configureKnownCredentialRedactor(value => value.replaceAll('known-short-key', '[REDACTED]'))
    assert(!debugText('known-short-key').includes('known-short-key'))
    assert.equal(debugUrl('https://user:pass@example.test/a?private=yes#value'), 'https://example.test/a')
    assert.equal(debugText('x'.repeat(32_769)), '[oversized text omitted]')
    assert.equal(JSON.stringify(debugEvaluationResult({ token: 'abc', url: 'https://example.test/a?token=abc' })).includes('abc'), false)
    assert.equal(debugText('x'.repeat(3_000)).length, BROWSER_DEBUG_LIMITS.text)
    groups++
    console.log(`PASS ${groups} advanced browser debug boundary groups; injected CDP transport only; no browser, webpage, Provider, or external service`)
  } finally { controller.revokeAll(); configureKnownCredentialRedactor(value => value) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
