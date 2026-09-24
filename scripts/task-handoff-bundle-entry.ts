import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { openProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { ProjectAggregateService } from '../src/main/project-aggregate/project-aggregate-service'
import { buildTaskSnapshot, saveTaskSnapshot, listTaskRuns, getTaskSnapshot } from '../src/main/task/task-snapshot'
import type { SessionMeta, HistoryEntry, TaskRunRecord } from '../src/shared/types'
import { historyStoreDocument, historyEntriesFromDocument } from '../src/main/history-store-format'
import { captureTaskHandoffBundle, previewTaskHandoffImport, importTaskHandoffBundle, assertTaskHandoffSourceCurrent } from '../src/main/task-handoff/task-bundle'
import { TaskHostOwnershipStore } from '../src/main/task-handoff/ownership-store'
import { ProjectWorkspaceReadService } from '../src/main/project-workspace/canonical-read-service'
import { verifyPersistedArtifactLifecycle } from '../src/main/task/artifact-lifecycle-api'

import { seedTaskHandoffFixture } from './lib/task-handoff-bundle-fixture'

const root = process.argv[2], a = join(root, 'a'), b = join(root, 'b'), cwdA = join(root, 'workspace-a'), cwdB = join(root, 'workspace-b')
const sessionId = 'handoff-session', projectId = 'handoff-project', goalId = 'handoff-goal', workItemId = 'handoff-item', now = 1_800_000_000_000
const checks: string[] = []
const pass = (message: string): void => { checks.push(message); console.log(`PASS ${message}`) }
const write = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value))
const aggregate = (rootDir: string): ProjectAggregateService => new ProjectAggregateService({ workspaceRoot: rootDir, workflowRoot: rootDir, aggregateRoot: rootDir, digitalWorkerRoot: rootDir, routineRoot: join(rootDir, 'routines'), learningRoot: join(rootDir, 'learning') })
async function main(): Promise<void> {
  for (const directory of [a, b, cwdA, cwdB]) mkdirSync(directory, { recursive: true })
  const { meta, run, history, artifactPath } = await seedTaskHandoffFixture(a, cwdA)
  write(join(a, 'sessions.json'), historyStoreDocument([history, { ...history, id: 'unrelated-session', sdkSessionId: 'unrelated-sdk', workItemId: undefined, goalId: undefined, cwd: join(root, 'unrelated-cwd') }]))
  const source = await captureTaskHandoffBundle(a, sessionId)
  assert.equal(source.ledger.runs.length, 1); assert.equal(source.history.id, sessionId)
  assert(!JSON.stringify(source).includes('unrelated-session'))
  await assertTaskHandoffSourceCurrent(a, source)
  unlinkSync(artifactPath) // Simulate a genuinely unavailable source-host path.
  pass('single task capture retains identity and complete run without sweeping unrelated sessions; unchanged freeze is stable')
  const preview = await previewTaskHandoffImport(b, source, cwdB)
  assert.equal(preview.canImport, true, preview.conflicts.join('\n'))
  const ownerA = new TaskHostOwnershipStore(a), ownerB = new TaskHostOwnershipStore(b)
  ownerB.stageImported(source.identity, source.provenance.sourceHostId, 'handoff-a-b', 0)
  await importTaskHandoffBundle(b, source, cwdB)
  assert.deepEqual(await listTaskRuns(sessionId, b), [run])
  assert.equal((await getTaskSnapshot(sessionId, b))?.run, undefined)
  const imported = historyEntriesFromDocument<HistoryEntry>(JSON.parse(readFileSync(join(b, 'sessions.json'), 'utf8')))[0]
  assert.equal(imported.cwd, cwdB); assert.equal(imported.createdAt, now); assert.equal(imported.permissionMode, 'default')
  assert.equal(readFileSync(join(b, 'attachments', sessionId, 'source.txt'), 'utf8'), 'original source')
  assert.equal((await verifyPersistedArtifactLifecycle(b)).valid, true)
  pass('target history and bytes restore; original run is historical and snapshot has no executable old run')
  await importTaskHandoffBundle(b, source, cwdB)
  assert.equal((await listTaskRuns(sessionId, b)).length, 1)
  pass('same bundle re-import is idempotent')
  await aggregate(b).verifyLiveProject(projectId)
  assert.equal((await new ProjectWorkspaceReadService(b).getWorkItem(workItemId))?.id, workItemId)
  pass('imported task is readable through verified live aggregate and canonical Project workspace')
  const runB = { ...run, id: 'handoff-run-b', effects: undefined, toolExecutions: undefined, steps: undefined, createdAt: now + 10, updatedAt: now + 10 }
  await saveTaskSnapshot(buildTaskSnapshot({ meta: { ...meta, cwd: cwdB, taskExecutionAuthorityRequired: true }, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created', run: runB, now: now + 10 }), b)
  write(join(b, 'sessions.json'), historyStoreDocument([{ ...imported, updatedAt: now + 10, title: 'Continued on B' }]))
  writeFileSync(join(b, 'attachments', sessionId, 'source.txt'), 'updated source on B')
  const returned = await captureTaskHandoffBundle(b, sessionId)
  const returnPreview = await previewTaskHandoffImport(a, returned, cwdA)
  assert.equal(returnPreview.canImport, true, returnPreview.conflicts.join('\n'))
  // Fixture stages the target directly: service tests own signed release/activation ordering.
  ownerA.stageImported(returned.identity, returned.provenance.sourceHostId, 'handoff-b-a', 1)
  await importTaskHandoffBundle(a, returned, cwdA)
  assert.equal((await listTaskRuns(sessionId, a)).length, 2)
  assert.equal(readFileSync(join(a, 'attachments', sessionId, 'source.txt'), 'utf8'), 'updated source on B')
  await aggregate(a).verifyLiveProject(projectId)
  pass('return trip incrementally imports new run and changed attachment while retaining old identity and history')
  writeFileSync(join(a, 'attachments', sessionId, 'source.txt'), 'manual target drift')
  const drift = await previewTaskHandoffImport(a, returned, cwdA)
  assert.equal(drift.canImport, false); assert.match(drift.conflicts.join(' '), /冲突/)
  pass('manual target edits after baseline block replay without overwriting user data')
  const personalA = join(root, 'personal-a'), personalB = join(root, 'personal-b')
  const personal = await seedTaskHandoffFixture(personalA, join(root, 'personal-source'), 'personal', true)
  const otherPersonal = await seedTaskHandoffFixture(personalB, join(root, 'personal-existing'), 'other-personal', true)
  const personalBundle = await captureTaskHandoffBundle(personalA, personal.sessionId)
  const personalPreview = await previewTaskHandoffImport(personalB, personalBundle, join(root, 'personal-target'))
  assert.equal(personalPreview.canImport, true, personalPreview.conflicts.join('\n'))
  new TaskHostOwnershipStore(personalB).stageImported(personalBundle.identity, personalBundle.provenance.sourceHostId, 'personal-a-b', 0)
  await importTaskHandoffBundle(personalB, personalBundle, join(root, 'personal-target'))
  await aggregate(personalB).verifyLiveProject(personal.projectId)
  const personalReader = new ProjectWorkspaceReadService(personalB)
  assert.equal((await personalReader.getWorkItem(personal.workItemId))?.id, personal.workItemId)
  assert.equal((await personalReader.getWorkItem(otherPersonal.workItemId))?.id, otherPersonal.workItemId)
  pass('managed personal task imports into an existing personal workspace without sweeping or replacing unrelated tasks')
  console.log(JSON.stringify({ status: 'passed', checks, providerCalls: false, realRemoteHosts: false }))
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
