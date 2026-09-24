import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComputerHistoryStore } from '../src/main/computer-history/store'
import { ComputerHistoryService } from '../src/main/computer-history/service'
import { MACOS_HISTORY_HELPER_SOURCE, type HistoryCaptureResult, type HistoryCollector } from '../src/main/computer-history/collector'
import type { ComputerHistoryPolicyInput, ComputerHistorySource } from '../src/shared/computer-history-types'

const ROOT = mkdtempSync(join(tmpdir(), 'caogen-history-required-'))
const NOW = 1_789_689_600_000
const APP = { bundleId: 'example.fixture.editor', name: 'Fixture editor' }
const BROWSER = { bundleId: 'com.apple.Safari', name: 'Fixture browser', excludedReason: 'browser' as const }
let checks = 0, fixtureNumber = 0
async function check(label: string, fn: () => unknown | Promise<unknown>): Promise<void> { await fn(); checks++; console.log(`PASS ${label}`) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { resolve, promise } }
function fixture(options: { platform?: string; temporary?: boolean } = {}) {
  const directory = join(ROOT, `fixture-${fixtureNumber++}`), store = new ComputerHistoryStore(directory)
  let time = NOW, calls = 0, sourceCalls = 0, lastSignal: AbortSignal | undefined
  let capture: (ids: string[], signal: AbortSignal) => Promise<HistoryCaptureResult> = async ids => { assert.deepEqual(ids, [APP.bundleId]); return { status: 'captured', bundleId: APP.bundleId, title: 'Synthetic report' } }
  let sources: (signal: AbortSignal) => Promise<ComputerHistorySource[]> = async () => [APP, BROWSER]
  const collector: HistoryCollector = {
    sources: signal => { sourceCalls++; return sources(signal) },
    capture: (ids, signal) => { calls++; lastSignal = signal; return capture(ids, signal) }
  }
  const service = new ComputerHistoryService({ store, collector, platform: options.platform ?? 'darwin', temporary: options.temporary ?? false, now: () => time })
  const input = (overrides: Partial<ComputerHistoryPolicyInput> = {}): ComputerHistoryPolicyInput => ({ expectedRevision: service.state().policy.revision,
    enabled: true, paused: false, allowedBundleIds: [APP.bundleId], retentionDays: 30, consent: true, ...overrides })
  return { directory, store, service, input, setCapture: (value: typeof capture) => { capture = value }, setSources: (value: typeof sources) => { sources = value },
    advance: (delta: number) => { time += delta }, calls: () => calls, sourceCalls: () => sourceCalls, signal: () => lastSignal,
    enable: async () => { await service.sources(1); service.update(1, input()) } }
}

async function main(): Promise<void> {
  try {
    await check('default off: no helper calls, no history files, explicit source-scoped consent required', async () => {
      const f = fixture(); assert.equal(f.service.state().status, 'disabled'); await f.service.collectOnce()
      assert.equal(f.calls(), 0); assert.equal(f.sourceCalls(), 0); assert.equal(existsSync(f.directory), false)
      assert.throws(() => f.service.update(1, f.input()), /来源/)
      await f.service.sources(1); assert.equal(f.calls(), 0)
      assert.throws(() => f.service.update(2, f.input()), /来源/)
      assert.throws(() => f.service.update(1, f.input({ consent: undefined })), /确认/)
      assert.throws(() => f.service.update(1, f.input({ allowedBundleIds: [BROWSER.bundleId] })), /不支持/)
      f.service.update(1, f.input()); await f.service.collectOnce(); assert.equal(f.calls(), 1); assert.equal(f.service.query({}).total, 1)
      assert.throws(() => f.service.update(1, f.input({ expectedRevision: 0 })), /其他窗口/); f.service.stop()
    })
    await check('allowed title only, exact source check, bounded deduplication and persistent private store', async () => {
      const f = fixture(); await f.enable(); await f.service.collectOnce(); await f.service.collectOnce()
      assert.equal(f.service.query({}).total, 1)
      f.advance(300_001); await f.service.collectOnce(); assert.equal(f.service.query({}).total, 2)
      const persisted = new ComputerHistoryStore(f.directory).records()
      assert.deepEqual(Object.keys(persisted[0]).sort(), ['appName', 'bundleId', 'capturedAt', 'id', 'title'])
      if (process.platform !== 'win32') assert.equal(statSync(join(f.directory, 'history.json')).mode & 0o777, 0o600)
      f.setCapture(async () => ({ status: 'captured', bundleId: 'example.not-authorized', title: 'MUST_NOT_PERSIST' }))
      await f.service.collectOnce(); assert.equal(f.service.state().status, 'error'); assert.equal(f.service.query({}).total, 2)
      assert.doesNotMatch(readFileSync(join(f.directory, 'history.json'), 'utf8'), /MUST_NOT_PERSIST/); f.service.stop()
    })
    await check('pause, revoke and off abort in-flight capture and discard late results', async () => {
      for (const action of ['pause', 'revoke', 'off'] as const) {
        const f = fixture(); await f.enable(); const gate = deferred<HistoryCaptureResult>()
        f.setCapture(() => gate.promise); const pending = f.service.collectOnce()
        const signal = f.signal()!
        f.service.update(1, f.input(action === 'pause' ? { paused: true } : action === 'off' ? { enabled: false } : { enabled: false, allowedBundleIds: [] }))
        assert.equal(signal.aborted, true)
        gate.resolve({ status: 'captured', bundleId: APP.bundleId, title: 'LATE_PRIVATE_TITLE' }); await pending
        assert.equal(f.service.query({}).total, 0); await f.service.collectOnce(); assert.equal(f.calls(), 1); f.service.stop()
      }
    })
    await check('unsupported and temporary workspaces never list or collect sources', async () => {
      for (const options of [{ platform: 'win32' }, { platform: 'linux' }, { temporary: true }]) {
        const f = fixture(options); assert.deepEqual(await f.service.sources(1), []); await f.service.collectOnce()
        assert.equal(f.calls(), 0); assert.equal(f.sourceCalls(), 0)
        assert.throws(() => f.service.update(1, f.input()), /不支持/); f.service.stop()
      }
    })
    await check('source picker window loss revokes pending metadata selection', async () => {
      const f = fixture(), gate = deferred<ComputerHistorySource[]>(); f.setSources(() => gate.promise)
      const pending = f.service.sources(1), rejected = assert.rejects(pending, /已关闭/)
      f.service.clearOwner(1); gate.resolve([APP]); await rejected
      assert.throws(() => f.service.update(1, f.input()), /来源/); f.service.stop()
    })
    await check('time, source, title filters and pagination return exact synthetic records', async () => {
      const f = fixture(); await f.enable()
      for (let index = 0; index < 4; index++) { f.advance(60_000); f.setCapture(async () => ({ status: 'captured', bundleId: APP.bundleId, title: `Fixture ${index}` })); await f.service.collectOnce() }
      assert.equal(f.service.query({ from: NOW + 120_000, to: NOW + 180_000, bundleId: APP.bundleId }).total, 2)
      assert.equal(f.service.query({ query: 'fixture 2' }).records[0].title, 'Fixture 2')
      assert.equal(f.service.query({ offset: 1, limit: 1 }).records[0].title, 'Fixture 2')
      assert.throws(() => f.service.query({ from: NOW, to: NOW - 1 }), /晚于/)
      assert.throws(() => f.service.query({ screenshot: true }), /参数/); f.service.stop()
    })
    await check('reviewed deletion is window-bound and deletes previewed IDs only, without later additions', async () => {
      const f = fixture(); await f.enable(); await f.service.collectOnce()
      const preview = f.service.previewDelete(1, {})
      assert.equal(preview.count, 1)
      assert.throws(() => f.service.delete(2, preview.token, true), /失效/)
      assert.throws(() => f.service.delete(1, preview.token, false), /失效/)
      f.advance(300_001); await f.service.collectOnce()
      // Re-preview after the first preview expires, then add one different record.
      const current = f.service.previewDelete(1, {})
      f.setCapture(async () => ({ status: 'captured', bundleId: APP.bundleId, title: 'AFTER_PREVIEW' })); await f.service.collectOnce()
      assert.equal(f.service.delete(1, current.token, true).deleted, 2)
      assert.equal(f.service.query({}).total, 1); assert.equal(f.service.query({}).records[0].title, 'AFTER_PREVIEW')
      assert.equal(new ComputerHistoryStore(f.directory).records().length, 1)
      assert.throws(() => f.service.delete(1, current.token, true), /失效/); f.service.stop()
    })
    await check('deletion expiration/window loss and retention pruning remove no unintended records', async () => {
      const f = fixture(); await f.enable(); await f.service.collectOnce()
      const preview = f.service.previewDelete(1, {}); f.advance(300_001)
      assert.throws(() => f.service.delete(1, preview.token, true), /失效/)
      const second = f.service.previewDelete(1, {}); f.service.clearOwner(1)
      assert.throws(() => f.service.delete(1, second.token, true), /失效/)
      f.advance(8 * 86_400_000); f.service.update(1, f.input({ retentionDays: 7 }))
      assert.equal(f.service.query({}).total, 0); assert.equal(new ComputerHistoryStore(f.directory).records().length, 0); f.service.stop()
    })
    await check('symlinks and corrupted policy fail closed without overwriting data', () => {
      const outside = join(ROOT, 'outside'); mkdirSync(outside)
      const link = join(ROOT, 'linked'); symlinkSync(outside, link)
      assert.throws(() => new ComputerHistoryStore(link), /真实目录/)
      const corrupt = join(ROOT, 'corrupt'); mkdirSync(corrupt); writeFileSync(join(corrupt, 'history.json'), '{broken')
      assert.throws(() => new ComputerHistoryStore(corrupt))
      assert.equal(readFileSync(join(corrupt, 'history.json'), 'utf8'), '{broken')
    })
    await check('macOS helper typechecks without running or reading user applications', () => {
      if (process.platform !== 'darwin') { console.log('SKIP native typecheck on non-macOS'); return }
      const source = join(ROOT, 'history-helper.swift'); writeFileSync(source, MACOS_HISTORY_HELPER_SOURCE)
      execFileSync('/usr/bin/swiftc', ['-typecheck', source], { timeout: 45_000, stdio: 'pipe' })
    })
    console.log(`Computer history required checks: ${checks}/${checks}`)
  } finally { rmSync(ROOT, { recursive: true, force: true }) }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
