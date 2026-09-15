import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  collectProjectSessionInventory, purgeProjectSessionData, purgeStandaloneSessionFiles,
  scanProjectSessionResiduals, scanStandaloneSessionResiduals
} from '../src/main/data-lifecycle/project-session-purge'
import { withDataLifecycleMutation } from '../src/main/data-lifecycle/data-lifecycle-mutation-lock'
import { SessionInputService } from '../src/main/task/session-input-service'
import type { SessionMeta } from '../src/shared/types'

const roots: string[] = []
let passed = 0
const root = (): string => { const value = mkdtempSync(join(tmpdir(), 'caogen-receipt-purge-')); roots.push(value); return value }
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
function write(path: string, record: unknown): string { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(record)); return path }
function fixture(rootDir: string, sessionId: string, projectId: string, id = 'request-a') {
  const input = write(join(rootDir, 'private', 'session-inputs', hash(sessionId), `${hash(id)}.json`), {
    schemaVersion: 1, sessionId, id, workspaceId: projectId, messageId: `session-input:${sessionId}:${id}`,
    payload: { text: 'private pending requirement' }, phase: 'queued', createdAt: 1, updatedAt: 1
  })
  const goal = write(join(rootDir, 'private', 'project-goal-submissions',
    `goal-${hash(`caogen.project-goal-task.v1\0${projectId}\0${id}`).slice(0, 24)}.json`), {
    schemaVersion: 1, sessionId, input: { projectId, requestId: id, objective: 'private task objective' }
  })
  return { input, goal }
}
async function check(name: string, run: () => void | Promise<void>) { await run(); passed++; console.log(`PASS ${name}`) }

async function main() {
  await check('receipt-only sessions enter Project deletion inventory', () => {
    const dir = root(); fixture(dir, 'session-a', 'project-a')
    assert.deepEqual(collectProjectSessionInventory(dir, 'project-a').sessionIds, ['session-a'])
  })
  await check('Project purge deletes both receipt types and reports zero residuals without touching another Project', () => {
    const dir = root(), a = fixture(dir, 'session-a', 'project-a'), b = fixture(dir, 'session-b', 'project-b')
    const before = scanProjectSessionResiduals(dir, 'project-a', [], [])
    assert.equal(before.sessionInputs, 1); assert.equal(before.projectGoalSubmissions, 1)
    const result = purgeProjectSessionData(dir, 'project-a', [], [])
    assert(result.removedPaths.includes(a.input)); assert(result.removedPaths.includes(a.goal))
    assert(!existsSync(a.input)); assert(!existsSync(a.goal)); assert(existsSync(b.input)); assert(existsSync(b.goal))
    const after = scanProjectSessionResiduals(dir, 'project-a', ['session-a'], [])
    assert.equal(after.sessionInputs, 0); assert.equal(after.projectGoalSubmissions, 0)
  })
  await check('Session deletion removes only that Session receipts and remains idempotent', () => {
    const dir = root(), a = fixture(dir, 'session-a', 'project-a'), b = fixture(dir, 'session-b', 'project-a', 'request-b')
    assert.equal(scanStandaloneSessionResiduals(dir, 'session-a', 'sdk-a').sessionInputs, 1)
    purgeStandaloneSessionFiles(dir, 'session-a', 'sdk-a')
    assert(!existsSync(a.input)); assert(!existsSync(a.goal)); assert(existsSync(b.input)); assert(existsSync(b.goal))
    assert.equal(scanStandaloneSessionResiduals(dir, 'session-a', 'sdk-a').projectGoalSubmissions, 0)
    assert.deepEqual(purgeStandaloneSessionFiles(dir, 'session-a', 'sdk-a'), [])
  })
  await check('crashed durable-file temporaries are also owned and removed', () => {
    const dir = root(), a = fixture(dir, 'session-a', 'project-a')
    const temporary = join(dirname(a.input), `.${hash('request-a')}.json.123.${randomUUID()}.tmp`)
    writeFileSync(temporary, readFileSync(a.input))
    assert.equal(scanStandaloneSessionResiduals(dir, 'session-a', 'sdk-a').sessionInputs, 2)
    purgeStandaloneSessionFiles(dir, 'session-a', 'sdk-a')
    assert(!existsSync(temporary))
  })
  await check('foreign Project ownership and corruption block false zero-residual proofs', () => {
    const dir = root(), a = fixture(dir, 'session-a', 'project-a')
    assert.throws(() => scanProjectSessionResiduals(dir, 'project-b', ['session-a'], []), /another Project/)
    writeFileSync(a.input, '{broken')
    assert.throws(() => scanStandaloneSessionResiduals(dir, 'session-a', 'sdk-a'))
    assert.throws(() => purgeStandaloneSessionFiles(dir, 'session-a', 'sdk-a'))
    assert(existsSync(a.goal))
  })
  await check('a symlink in the private receipt path never redirects deletion outside application data', () => {
    const dir = root(), outside = root(), a = fixture(outside, 'session-a', 'project-a')
    mkdirSync(join(dir, 'private'), { recursive: true })
    symlinkSync(join(outside, 'private', 'session-inputs'), join(dir, 'private', 'session-inputs'))
    assert.throws(() => purgeStandaloneSessionFiles(dir, 'session-a', 'sdk-a'), /not regular/)
    assert(existsSync(a.input)); assert(existsSync(a.goal))
  })
  await check('delayed reconciliation cannot recreate a receipt after lifecycle-locked deletion', async () => {
    const dir = root()
    const meta = { id: 'session-a', workspaceId: 'project-a', status: 'idle' } as SessionMeta
    let resolveEvidence!: (value: boolean) => void
    let started!: () => void
    const evidenceStarted = new Promise<void>((resolve) => { started = resolve })
    const service = new SessionInputService(dir, { meta: () => meta, send: async () => true,
      accepted: () => { started(); return new Promise((resolve) => { resolveEvidence = resolve }) } })
    await service.queue('session-a', 'request-a', { text: 'private addition' })
    const applying = service.apply('session-a', 'request-a')
    await evidenceStarted
    await withDataLifecycleMutation(dir, async () => { purgeStandaloneSessionFiles(dir, 'session-a', 'sdk-a') })
    resolveEvidence(true)
    await assert.rejects(applying, /找不到/)
    assert.equal(scanStandaloneSessionResiduals(dir, 'session-a', 'sdk-a').sessionInputs, 0)
  })
  console.log(`submission-receipt-purge: ${passed}/${passed} passed (temporary local data only)`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})
