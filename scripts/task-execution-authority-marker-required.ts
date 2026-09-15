import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { SessionMeta } from '../src/shared/types'
import { activeSessionRegistryDocument } from '../src/main/active-session-registry-format'
import { historyStoreDocument } from '../src/main/history-store-format'
import { sessionHistoryEntry } from '../src/main/session-history-entry'
import { runtimeContinuationReceiptPath } from '../src/main/session-runtime-continuation-path'
import { mergeTaskExecutionAuthorityMarker, reconcileTaskExecutionAuthorityMarker } from '../src/main/permission/task-execution-authority-marker'
import { TaskExecutionAuthorityStore } from '../src/main/permission/task-execution-authority-store'

const child = process.argv[2] === '--recover-marker'
const root = child ? process.argv[3] : realpathSync(mkdtempSync(join(tmpdir(), 'caogen-authority-marker-')))
const snapshotPath = join(root, 'old-snapshot-meta.json')
function meta(): SessionMeta {
  return { id: 'marker-task', createdAt: 10, cwd: root, workspaceId: 'project', goalId: 'goal', workItemId: 'work',
    projectId: 'legacy-project', businessLineId: 'studio', title: 'Restricted task', sdkSessionId: 'marker-sdk',
    model: 'fixture', providerId: 'fixture', taskStrategy: 'execute', permissionMode: 'default', status: 'idle',
    costUsd: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextTokens: 0 } as SessionMeta
}
function save(path: string, value: unknown): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)) }
function recover(): void {
  const old = JSON.parse(readFileSync(snapshotPath, 'utf8')) as SessionMeta
  const recovered = reconcileTaskExecutionAuthorityMarker(old, root)
  assert.equal(old.taskExecutionAuthorityRequired, undefined, 'source snapshot remains old')
  assert.equal(recovered.taskExecutionAuthorityRequired, true)
  const authority = new TaskExecutionAuthorityStore(root)
  assert.equal(authority.get(recovered).status, 'revoked', 'missing private grant must not become legacy')
  assert.throws(() => authority.assertAllowed(recovered, 'write_file', { path: 'result.md' }, root), /授权已撤销或缺失/)
}
function runColdRecovery(): void {
  const result = spawnSync(join(process.cwd(), 'node_modules/.bin/tsx'), [process.argv[1], '--recover-marker', root], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}
if (child) recover()
else {
  try {
    const old = meta(), restricted = { ...old, taskExecutionAuthorityRequired: true as const }
    save(snapshotPath, old)
    save(join(root, 'active-sessions.json'), activeSessionRegistryDocument([restricted]))
    runColdRecovery()
    console.log('PASS cold recovery retains durable active marker when snapshot write and grant never happened')
    rmSync(join(root, 'active-sessions.json'))
    save(join(root, 'sessions.json'), historyStoreDocument([sessionHistoryEntry(restricted as SessionMeta & { sdkSessionId: string })]))
    runColdRecovery()
    console.log('PASS history-only restriction survives old snapshot recovery')
    rmSync(join(root, 'sessions.json'))
    save(runtimeContinuationReceiptPath(root, old.id), activeSessionRegistryDocument([restricted]))
    runColdRecovery()
    assert.equal(mergeTaskExecutionAuthorityMarker(old, [restricted]).taskExecutionAuthorityRequired, true)
    console.log('PASS continuation receipt and late live restriction remain monotone')
    save(runtimeContinuationReceiptPath(root, old.id), activeSessionRegistryDocument([{ ...restricted, workItemId: 'other-work' }]))
    assert.throws(() => reconcileTaskExecutionAuthorityMarker(old, root), /TASK_AUTHORITY_MARKER_IDENTITY/)
    save(runtimeContinuationReceiptPath(root, old.id), activeSessionRegistryDocument([{ ...restricted, createdAt: 11 }]))
    assert.throws(() => reconcileTaskExecutionAuthorityMarker(old, root), /TASK_AUTHORITY_MARKER_IDENTITY/)
    save(runtimeContinuationReceiptPath(root, old.id), activeSessionRegistryDocument([{ ...old, taskExecutionAuthorityRequired: false }]))
    assert.throws(() => reconcileTaskExecutionAuthorityMarker(old, root), /TASK_AUTHORITY_MARKER_INVALID/)
    console.log('PASS ownership conflicts and malformed false markers fail closed')
    rmSync(runtimeContinuationReceiptPath(root, old.id))
    assert.equal(reconcileTaskExecutionAuthorityMarker(old, root).taskExecutionAuthorityRequired, undefined)
    console.log('PASS old unrestricted tasks keep explicit legacy compatibility')
    console.log('Task execution marker: 5/5 passed; isolated metadata and new processes, no Provider calls.')
  } finally { rmSync(root, { recursive: true, force: true }) }
}
