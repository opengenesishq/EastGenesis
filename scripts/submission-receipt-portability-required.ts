import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ProjectSubmissionReceiptSlice } from '../src/shared/submission-receipt-portability-types'
import type { SessionInputRecord } from '../src/shared/session-input-types'
import type { SessionMeta } from '../src/shared/types'
import { collectProjectSubmissionReceipts, validateProjectSubmissionReceipts } from '../src/main/data-lifecycle/submission-receipt-portability'
import { importProjectSessionPortableSlice, verifyProjectSessionPortableSlice } from '../src/main/data-lifecycle/project-session-portability'
import { unresolvedImportedSessionInputReason } from '../src/main/data-lifecycle/submission-receipt-files'
import { purgeProjectSessionData, scanProjectSessionResiduals } from '../src/main/data-lifecycle/project-session-purge'
import { ProjectDeletionBackupStore } from '../src/main/data-lifecycle/project-deletion-backup-store'
import { importProjectPortableRuntime, verifyProjectPortableRuntime } from '../src/main/data-lifecycle/project-portable-runtime'
import { createProductionProjectAggregateService } from '../src/main/project-aggregate/project-aggregate-factory'
import { projectAggregateDigest } from '../src/main/project-aggregate/codec'
import { ProjectGoalSubmissionStore } from '../src/main/project-workspace/goal-submission-store'
import { createProjectGoalTask, goalTaskIds } from '../src/main/project-workspace/goal-task-service'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { SessionInputService } from '../src/main/task/session-input-service'
import { historyStoreDocument } from '../src/main/history-store-format'
import { messagePayloadDigest } from '../src/main/message-payload-digest'

const roots: string[] = []
const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), 'caogen-receipt-portability-')); roots.push(root); return root }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const projectId = 'portable-project', requestId = 'original-goal', sessionId = randomUUID()
const input = { projectId, requestId, objective: '把这些数据做成客户汇报，控制在六页。', template: 'auto' as const }
const ids = goalTaskIds(projectId, requestId)
const meta = { id: sessionId, workspaceId: projectId, ...ids, status: 'idle' } as SessionMeta
const receiptPath = (root: string) => join(root, 'private', 'session-inputs', hash(sessionId), `${hash('input-a')}.json`)
const goalPath = (root: string) => join(root, 'private', 'project-goal-submissions', `${ids.goalId}.json`)
function write(path: string, bytes: string | Buffer) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes) }
function reseal(slice: ProjectSubmissionReceiptSlice) { const { sliceDigest: _, ...body } = slice; slice.sliceDigest = projectAggregateDigest(body); return slice }
let passed = 0
async function check(name: string, run: () => void | Promise<void>) { await run(); passed++; console.log(`PASS ${name}`) }

async function main() {
  const source = makeRoot()
  await (await openProjectWorkspaceStore(source)).createWorkspace({ id: projectId, name: 'Portable task fixture', kind: 'software' })
  const journal = new ProjectGoalSubmissionStore(source)
  const reserved = journal.reserve(input, sessionId)
  await createProjectGoalTask(input, source)
  journal.advance(reserved, 'task_created')
  write(join(source, 'sessions.json'), JSON.stringify(historyStoreDocument([meta])))
  const document = Buffer.from('客户数据来源：本地测试资料。'), documentHash = hash(document)
  const documentPath = join(source, 'attachments', sessionId, 'documents', 'S2', `${documentHash}.txt`)
  write(documentPath, document)
  const payload = { text: '  第二页补来源。\n', documents: [{ id: documentHash, hash: documentHash, path: documentPath,
    name: '客户数据.txt', mime: 'text/plain; charset=utf-8' as const, bytes: document.length,
    createdAt: '2026-09-15T00:00:00.000Z', dataClass: 'S2' as const }] }
  let sends = 0
  const service = (root: string) => new SessionInputService(root, { meta: () => meta,
    send: async () => { sends++; throw new Error('Provider calls forbidden') }, accepted: async () => false })
  const queued = await service(source).queue(sessionId, 'input-a', payload)
  write(receiptPath(source), JSON.stringify({ ...queued, phase: 'dispatching' }))
  const aggregateService = createProductionProjectAggregateService(source)
  await aggregateService.sealProject(projectId, { expectedAggregateRevision: 0 })
  const exported = await aggregateService.exportProject(projectId)
  const runtime = exported.bundle.runtime!, slice = runtime.submissionReceipts!

  await check('normal Project export includes both receipt types, original identities and attachment versions', () => {
    assert.equal(slice.projectGoals[0].sessionId, sessionId)
    assert.deepEqual(slice.projectGoals[0].input, input)
    assert.equal(slice.sessionInputs[0].record.payload.text, payload.text)
    assert.equal(slice.sessionInputs[0].evidencePayloadDigest, messagePayloadDigest(payload))
    assert.equal(slice.sessionInputs[0].record.payload.documents![0].path, `attachments/${sessionId}/documents/S2/${documentHash}.txt`)
  })
  const target = makeRoot()
  await check('ordinary runtime import restores receipts and files while uncertain sends require reconciliation', async () => {
    await importProjectPortableRuntime(exported.bundle, target)
    await verifyProjectPortableRuntime(exported.bundle, target)
    const restored = JSON.parse(readFileSync(receiptPath(target), 'utf8')) as SessionInputRecord
    assert.equal(restored.phase, 'needs_reconciliation')
    assert.equal(restored.importedPayloadDigest, messagePayloadDigest(payload))
    assert.equal(restored.payload.documents![0].path, documentPath.replace(source, target))
    assert.equal(hash(readFileSync(restored.payload.documents![0].path)), documentHash)
    assert.equal(new ProjectGoalSubmissionStore(target).read(input)!.sessionId, sessionId)
    assert.match(unresolvedImportedSessionInputReason(target, sessionId)!, /阻止自动续跑/)
    await assert.rejects(service(target).apply(sessionId, 'input-a'), /尚未确认/)
    assert.equal(sends, 0)
  })
  await check('repeated import resumes exact receipts without duplicates and re-export retains source evidence', () => {
    importProjectSessionPortableSlice(target, projectId, runtime)
    verifyProjectSessionPortableSlice(target, projectId, runtime)
    const again = collectProjectSubmissionReceipts(target, projectId, runtime)
    assert.equal(again.sessionInputs.length, 1)
    assert.equal(again.sessionInputs[0].evidencePayloadDigest, slice.sessionInputs[0].evidencePayloadDigest)
    assert.deepEqual(again.sessionInputs[0].evidencePayloadPaths, slice.sessionInputs[0].evidencePayloadPaths)
  })
  await check('receipt conflicts and attachment ancestor symlinks fail before importing Session history', () => {
    const conflict = makeRoot()
    write(receiptPath(conflict), JSON.stringify({ changed: true }))
    assert.throws(() => importProjectSessionPortableSlice(conflict, projectId, runtime), /conflict/)
    assert(!existsSync(join(conflict, 'sessions.json')))
    const unsafe = makeRoot(), outside = makeRoot()
    symlinkSync(outside, join(unsafe, 'attachments'))
    assert.throws(() => importProjectSessionPortableSlice(unsafe, projectId, runtime), /unsafe receipt target/)
    assert(!existsSync(join(unsafe, 'sessions.json')))
  })
  await check('Project, Session, payload, path and attachment digest tampering are rejected', () => {
    const mutations: Array<(value: ProjectSubmissionReceiptSlice) => void> = [
      value => { value.projectId = 'foreign' },
      value => { value.sessionInputs[0].record.workspaceId = 'foreign' },
      value => { value.sessionInputs[0].record.goalId = 'foreign' },
      value => { value.sessionInputs[0].record.payload.text = 'different request' },
      value => { value.sessionInputs[0].record.payload.documents![0].path = '../outside.txt' },
      value => { value.sessionInputs[0].record.payload.documents![0].hash = '0'.repeat(64) },
      value => { value.projectGoals[0].sessionId = randomUUID() }
    ]
    for (const mutate of mutations) {
      const value = structuredClone(slice); mutate(value); reseal(value)
      assert.throws(() => validateProjectSubmissionReceipts(projectId, value, runtime))
    }
    const brokenContext = structuredClone(runtime)
    brokenContext.sessionFiles.find(file => file.path.endsWith(`${documentHash}.txt`))!.data = Buffer.from('changed').toString('base64')
    assert.throws(() => validateProjectSubmissionReceipts(projectId, slice, brokenContext), /content digest mismatch/)
  })
  await check('credential-bearing original input blocks export without silently rewriting the request', () => {
    const unsafe = structuredClone(slice)
    unsafe.sessionInputs[0].record.payload.text = `Bearer ${'test'.repeat(10)}`
    reseal(unsafe)
    assert.throws(() => validateProjectSubmissionReceipts(projectId, unsafe, runtime), /credential material/)
  })
  await check('old bundles without the optional receipt slice still import and verify', () => {
    const old = structuredClone(runtime)
    delete old.submissionReceipts
    const destination = makeRoot()
    importProjectSessionPortableSlice(destination, projectId, old)
    verifyProjectSessionPortableSlice(destination, projectId, old)
    assert(!existsSync(goalPath(destination)))
  })
  await check('ProjectDeletionBackup round-trip restores both directories and purge removes their content', async () => {
    const backups = new ProjectDeletionBackupStore(source)
    const receipt = backups.write('delete-operation', projectId, exported)
    const backup = backups.read(receipt.path, 'delete-operation', projectId)
    assert.deepEqual(backup.aggregateExport.runtime!.submissionReceipts, slice)
    const restored = makeRoot()
    await importProjectPortableRuntime(backup.aggregateExport, restored)
    await verifyProjectPortableRuntime(backup.aggregateExport, restored)
    assert(existsSync(goalPath(restored))); assert(existsSync(receiptPath(restored)))
    purgeProjectSessionData(restored, projectId, [sessionId], [])
    const residual = scanProjectSessionResiduals(restored, projectId, [sessionId], [])
    assert.equal(residual.sessionInputs, 0); assert.equal(residual.projectGoalSubmissions, 0)
    assert.equal(sends, 0)
  })
  console.log(`submission-receipt-portability: ${passed}/${passed} passed (temporary local data only)`)
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
