import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginGuiPreviewTool, finishGuiPreviewTool, guiPreviewTarget, invalidateGuiPreview, latestGuiPreviewCaptureEvent, latestGuiPreviewEvent, subscribeGuiPreviewEvents, type GuiPreviewBinding, type GuiPreviewCapture, type GuiPreviewEvent } from '../src/main/gui-preview/gui-preview-events'
import { GuiPreviewState, type GuiPreviewContext } from '../src/main/gui-preview/gui-preview-state'
import { readGuiPreviewFrame } from '../src/main/gui-preview/gui-preview-frame'
import type { GuiPreviewFrame } from '../src/shared/gui-preview-types'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-gui-preview-')))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD3sAAAAASUVORK5CYII=', 'base64')
const hash = createHash('sha256').update(png).digest('hex')
const binding: GuiPreviewBinding = { sessionId: 'task-1', ownership: 'canonical-owner', runId: 'run-1', authorityRevision: 1, permissionKey: 'approved-context' }
const baseContext = (): GuiPreviewContext => ({ binding: { ...binding }, title: 'Original task', language: 'zh', taskStatus: 'running', enabled: true, pendingApprovalCount: 0 })
const capture = (): GuiPreviewCapture => ({ cwd: root, path: join(root, 'capture.png'), sha256: hash, capturedAt: 10, sourceLabel: 'Approved window', width: 1, height: 1 })
const frame = (): GuiPreviewFrame => ({ ...capture(), dataUrl: `data:image/png;base64,${png.toString('base64')}` })
function finished(overrides: Partial<GuiPreviewBinding> = {}): Extract<GuiPreviewEvent, { kind: 'finished' }> {
  return { kind: 'finished', invocation: { binding: { ...binding, ...overrides }, cwd: root,
    action: { id: 'capture-1', toolName: 'gui_screenshot', label: '截取画面', target: 'Approved window', startedAt: 1, finishedAt: 11 } }, ok: true, capture: capture() }
}
let passed = 0
async function check(name: string, run: () => void | Promise<void>) {
  invalidateGuiPreview(); writeFileSync(capture().path, png)
  await run(); passed++; console.log(`PASS ${name}`)
}
async function main() {
  await check('only verified screenshot descriptors create frames; assistant JSON is ignored', () => {
    const invocation = beginGuiPreviewTool(binding, root, 'gui_screenshot', { sourceId: 'window:1' })!
    finishGuiPreviewTool(invocation, { ok: true, output: JSON.stringify({ path: capture().path, sha256: hash }) })
    assert.equal(latestGuiPreviewCaptureEvent('task-1'), undefined)
    const next = beginGuiPreviewTool(binding, root, 'gui_screenshot', {})!
    finishGuiPreviewTool(next, { ok: true, output: '', producedArtifacts: [{ kind: 'screenshot', title: 'screen', path: capture().path,
      producer: 'gui_screenshot', lineageKey: 'screen', mediaType: 'image/png', evidenceVerifier: 'gui-runtime', evidenceSummary: 'captured',
      metadata: { captureSha256: hash, capturedAt: 10, width: 1, height: 1, sourceName: 'Approved window' } }] })
    assert.equal(latestGuiPreviewCaptureEvent('task-1')?.capture?.sha256, hash)
    beginGuiPreviewTool(binding, root, 'gui_click', { x: 10, y: 20 })
    assert.equal(latestGuiPreviewCaptureEvent('task-1')?.capture?.sha256, hash)
  })
  await check('typed content, OCR, arbitrary output and secret arguments never enter action events', () => {
    const events: GuiPreviewEvent[] = [], off = subscribeGuiPreviewEvents(event => events.push(event))
    const invocation = beginGuiPreviewTool(binding, root, 'gui_type', { text: 'TOP_SECRET', ocr: 'SECRET_OCR', processName: 'Editor', apiKey: 'KEY_SECRET', title: 'Document' })!
    finishGuiPreviewTool(invocation, { ok: false, output: 'SECRET_RESULT' }); off()
    assert.doesNotMatch(JSON.stringify(events), /TOP_SECRET|SECRET_OCR|KEY_SECRET|SECRET_RESULT/)
    assert.equal(guiPreviewTarget({ processName: 'Editor', text: 'secret' }), 'Editor')
    assert.equal(beginGuiPreviewTool(binding, root, 'bash', {}), undefined)
    assert.equal(beginGuiPreviewTool({ ...binding, runId: undefined }, root, 'gui_click', {}), undefined)
  })
  await check('verified frame loads and stays bound to original task and Run', async () => {
    const context = baseContext(), state = new GuiPreviewState(context)
    await state.accept(finished(), async cap => { assert.deepEqual(await readGuiPreviewFrame(cap), png); return frame() }, () => context)
    assert.equal(state.snapshot().frame?.sha256, hash)
    assert.equal(state.snapshot().sessionId, 'task-1'); assert.equal(state.snapshot().runId, 'run-1')
  })
  await check('another task, canonical owner or Run cannot hydrate any frame', async () => {
    for (const change of [{ sessionId: 'task-2' }, { ownership: 'different-owner' }, { runId: 'run-2' }]) {
      const context = baseContext(), state = new GuiPreviewState(context)
      await state.accept(finished(change), async () => { throw new Error('foreign frame read') }, () => context)
      assert.equal(state.snapshot().frame, undefined); assert.equal(state.snapshot().action, undefined)
    }
  })
  await check('revocation while image decoding is pending discards delayed bytes', async () => {
    const context = baseContext(), state = new GuiPreviewState(context)
    let release!: (value: GuiPreviewFrame) => void
    const pending = state.accept(finished(), () => new Promise(resolve => { release = resolve }), () => context)
    await state.accept({ kind: 'invalidated', sessionId: 'task-1' }, async () => frame(), () => context)
    release(frame()); await pending
    assert.equal(state.snapshot().frame, undefined)
  })
  await check('new Run or permission revision during frame read invalidates old image', async () => {
    for (const change of [{ runId: 'run-2' }, { authorityRevision: 2 }, { permissionKey: 'revoked' }]) {
      const context = baseContext(), state = new GuiPreviewState(context)
      await state.accept(finished(), async () => { Object.assign(context.binding, change); return frame() }, () => context)
      assert.equal(state.snapshot().frame, undefined)
    }
  })
  await check('canonical rebinding permanently invalidates the window and does not disclose new title', async () => {
    const context = baseContext(), state = new GuiPreviewState(context)
    await state.accept(finished(), async () => frame(), () => context)
    state.update({ ...context, title: 'OTHER PRIVATE TASK', binding: { ...binding, ownership: 'other' } })
    state.update(baseContext())
    assert.equal(state.snapshot().available, false); assert.equal(state.snapshot().frame, undefined)
    assert.equal(state.snapshot().title, 'Original task')
  })
  await check('pause clears pixels immediately; delayed tool completion cannot restore them', async () => {
    const context = baseContext(), state = new GuiPreviewState(context)
    await state.accept(finished(), async () => frame(), () => context)
    state.startStopping(); assert.equal(state.snapshot().frame, undefined); assert.equal(state.snapshot().phase, 'stopping')
    await state.accept(finished(), async () => frame(), () => context)
    state.stoppedResult(); assert.equal(state.snapshot().phase, 'paused'); assert.equal(state.snapshot().frame, undefined)
    assert.equal(state.snapshot().canStop, false)
  })
  await check('failed interruption stays visibly failed and allows retry while executor is still running', () => {
    const state = new GuiPreviewState(baseContext())
    state.startStopping(); state.stoppedResult('executor unavailable')
    assert.equal(state.snapshot().phase, 'failed'); assert.equal(state.snapshot().canStop, true)
  })
  await check('revocation removes cached captures and suppresses in-flight bus completion', () => {
    const invocation = beginGuiPreviewTool(binding, root, 'gui_screenshot', {})!
    invalidateGuiPreview('task-1'); finishGuiPreviewTool(invocation, { ok: true, output: '' })
    assert.equal(latestGuiPreviewEvent('task-1'), undefined)
    assert.equal(latestGuiPreviewCaptureEvent('task-1'), undefined)
  })
  await check('older parallel tool completion cannot replace the currently shown action', () => {
    const first = beginGuiPreviewTool(binding, root, 'gui_click', { x: 1, y: 2 })!
    const second = beginGuiPreviewTool(binding, root, 'gui_scroll', { x: 3, y: 4 })!
    finishGuiPreviewTool(first, { ok: false, output: '' })
    assert.equal(latestGuiPreviewEvent('task-1')?.invocation.action.id, second.action.id)
  })
  await check('file tampering, dimension mismatch and path escape cannot expose bytes', async () => {
    const changed = Buffer.from(png); changed[changed.length - 1] ^= 1; writeFileSync(capture().path, changed)
    await assert.rejects(readGuiPreviewFrame(capture()), /变化/)
    writeFileSync(capture().path, png)
    await assert.rejects(readGuiPreviewFrame({ ...capture(), width: 200 }), /尺寸/)
    await assert.rejects(readGuiPreviewFrame({ ...capture(), path: join(root, '..', 'outside.png') }), /不属于/)
  })
  await check('symbolic-link screenshots are rejected even when digest matches', async () => {
    const link = join(root, 'linked.png'); symlinkSync(capture().path, link)
    await assert.rejects(readGuiPreviewFrame({ ...capture(), path: link }), /符号链接/)
  })
  await check('permission disabled or task closed immediately clears previously shown pixels', async () => {
    for (const change of [{ enabled: false }, { taskStatus: 'closed' }]) {
      const context = baseContext(), state = new GuiPreviewState(context)
      await state.accept(finished(), async () => frame(), () => context)
      state.update({ ...context, ...change }); assert.equal(state.snapshot().frame, undefined)
      assert.equal(state.snapshot().phase, 'unavailable')
    }
  })
  console.log(`gui-preview-boundary-required: ${passed}/${passed} passed (offline; no screen captures or provider calls)`)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { invalidateGuiPreview(); rmSync(root, { recursive: true, force: true }) })
