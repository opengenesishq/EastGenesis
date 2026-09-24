import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFeedbackService } from '../src/main/feedback/local-feedback'
import { writeDurableFile } from '../src/main/durable-file'
import { configureKnownCredentialRedactor } from '../src/main/security/secret-redaction'
import type { FeedbackAppInfo } from '../src/shared/feedback-types'
import type { SessionMeta, TaskRunRecord } from '../src/shared/types'

const input = { description: 'Opening the preview leaves an empty panel.', includeTaskSummary: false, includeErrorSummary: false }
let checks = 0
async function check(name: string, run: () => void | Promise<void>): Promise<void> { await run(); checks++; console.log(`PASS ${name}`) }

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'caogen-feedback-'))
  let now = Date.now(), reads = 0
  const meta = { id: 'private-session-id', title: 'PRIVATE_CONVERSATION', cwd: '/private/workspace', model: 'PRIVATE_MODEL', providerId: 'PRIVATE_PROVIDER', status: 'error', taskStrategy: 'execute', engine: 'openai', routingScope: 'global', lastError: 'Bearer sk-sensitive-error-secret' } as SessionMeta
  const run = { status: 'failed', attempt: 2, recoveryCount: 1, error: 'PRIVATE_RUN_ERROR', steps: [{ status: 'failed', requestText: 'PRIVATE_REQUEST', error: 'PRIVATE_STEP_ERROR' }], toolExecutions: [{ status: 'failed', error: 'PRIVATE_TOOL_ERROR' }, { status: 'unknown_outcome' }] } as TaskRunRecord
  const service = new LocalFeedbackService({ now: () => now,
    appInfo: () => ({ name: 'CaoGen', version: '0.1.9', platform: 'darwin', architecture: 'arm64', build: 'development', electron: '38.0.0', chromium: '140.0.0', node: '22.0.0', env: 'PRIVATE_ENV', logs: 'PRIVATE_LOGS' } as FeedbackAppInfo),
    session: () => { reads++; return meta }, run: () => { reads++; return run } })
  try {
    await check('default report never reads task data and exports only allowlisted application fields', () => {
      const preview = service.preview(1, input), report = JSON.parse(preview.json)
      assert.equal(reads, 0)
      assert.deepEqual(Object.keys(report), ['schemaVersion', 'generatedAt', 'description', 'application'])
      assert.deepEqual(Object.keys(report.application), ['name', 'version', 'platform', 'architecture', 'build', 'electron', 'chromium', 'node'])
      assert.doesNotMatch(preview.json, /PRIVATE_|sessionId|cwd|env|logs/)
    })
    await check('opt-in summaries include states and counts without task identity, content, paths, or error text', () => {
      const preview = service.preview(1, { ...input, sessionId: meta.id, includeTaskSummary: true, includeErrorSummary: true })
      const report = JSON.parse(preview.json)
      assert.equal(report.taskSummary.status, 'error'); assert.equal(report.taskSummary.stepCount, 1)
      assert.equal(report.errorSummary.failedSteps, 1); assert.equal(report.errorSummary.failedToolExecutions, 1)
      assert.equal(report.errorSummary.unknownToolOutcomes, 1)
      assert.doesNotMatch(preview.json, /PRIVATE_|private-session-id|\/private\/|sk-sensitive|Bearer/)
      assert.equal('taskSummary' in JSON.parse(service.preview(1, { ...input, sessionId: meta.id, includeErrorSummary: true }).json), false)
    })
    await check('unknown fields and invalid options are rejected; typed and known credentials are redacted', () => {
      assert.throws(() => service.preview(1, { ...input, rawLogs: 'PRIVATE_LOGS' }), /参数|描述/)
      assert.throws(() => service.preview(1, { ...input, includeErrorSummary: 'true' }), /参数|描述/)
      assert.throws(() => service.preview(1, { ...input, description: 'x'.repeat(12001) }), /描述/)
      configureKnownCredentialRedactor(value => value.replaceAll('known-private-credential', '[REDACTED]'))
      const preview = service.preview(1, { ...input, description: 'api_key=unusualValue123 Bearer ABCDEFGHIJKL known-private-credential' })
      assert.doesNotMatch(preview.json, /unusualValue123|ABCDEFGHIJKL|known-private-credential/)
      configureKnownCredentialRedactor(value => value)
    })
    await check('save uses exactly the reviewed snapshot and private file permissions', async () => {
      const preview = service.preview(1, { ...input, sessionId: meta.id, includeTaskSummary: true })
      meta.status = 'idle'; run.attempt = 42
      const path = join(directory, 'feedback.json')
      const result = await service.export(1, preview.previewId, { choosePath: async filename => { assert.match(filename, /^caogen-feedback-\d{4}-\d{2}-\d{2}\.json$/); return path }, assertOwner: () => {}, write: (path, json) => writeDurableFile(path, json, { mode: 0o600, replace: true }) })
      assert.deepEqual(result, { canceled: false, filePath: path })
      assert.equal(await readFile(path, 'utf8'), preview.json)
      if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
    })
    await check('cancel, foreign windows, stale previews, expired previews, and window loss never write', async () => {
      const preview = service.preview(1, input)
      let writes = 0, dialogs = 0
      const ports = { choosePath: async () => { dialogs++; return '/unused.json' }, assertOwner: () => {}, write: async () => { writes++ } }
      assert.deepEqual(await service.export(1, preview.previewId, { ...ports, choosePath: async () => undefined }), { canceled: true })
      await assert.rejects(service.export(2, preview.previewId, ports), /预览/); assert.equal(dialogs, 0)
      await assert.rejects(service.export(1, preview.previewId, { ...ports, choosePath: async () => { service.preview(1, { ...input, description: 'Changed' }); return '/unused.json' } }), /预览/)
      const next = service.preview(1, input)
      await assert.rejects(service.export(1, next.previewId, { ...ports, assertOwner: () => { throw new Error('Window closed') } }), /Window closed/)
      now += 16 * 60_000
      await assert.rejects(service.export(1, next.previewId, ports), /过期/)
      const last = service.preview(1, input); service.clearOwner(1)
      await assert.rejects(service.export(1, last.previewId, ports), /预览/)
      assert.equal(writes, 0)
    })
    console.log(`RESULT ${checks}/${checks}; local diagnostic privacy/export checks; no providers, network, or raw logs.`)
  } finally { configureKnownCredentialRedactor(value => value); await rm(directory, { recursive: true, force: true }) }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
