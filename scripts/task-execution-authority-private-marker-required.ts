import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { SessionMeta } from '../src/shared/types'
import { TaskExecutionAuthorityStore, taskExecutionAuthorityBindingDigest } from '../src/main/permission/task-execution-authority-store'
import { reconcileTaskExecutionAuthorityMarker } from '../src/main/permission/task-execution-authority-marker'
import { activeSessionRegistryDocument } from '../src/main/active-session-registry-format'
import { historyStoreDocument } from '../src/main/history-store-format'
import { sessionHistoryEntry } from '../src/main/session-history-entry'
import { sessionCreationJournalDocument } from '../src/main/session-creation-journal-format'
import { collectProjectSessionPortableSlice } from '../src/main/data-lifecycle/project-session-portability'

const child = process.argv[2] === '--cold-private-marker'
const root = child ? process.argv[3] : realpathSync(mkdtempSync(join(tmpdir(), 'caogen-private-marker-')))
const file = join(root, 'old-snapshot-meta.json')
function save(path: string, value: unknown): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)) }
if (child) {
  const old = JSON.parse(readFileSync(file, 'utf8')) as SessionMeta
  const restored = reconcileTaskExecutionAuthorityMarker(old, root)
  assert.equal(restored.taskExecutionAuthorityRequired, true)
  assert.equal(old.taskExecutionAuthorityRequired, undefined)
  assert.equal(new TaskExecutionAuthorityStore(root).get(restored).status, 'revoked')
  assert.throws(() => new TaskExecutionAuthorityStore(root).assertAllowed(restored, 'write_file', { path: 'reports/a.md' }, root), /授权已撤销或缺失/)
} else {
  try {
    const old = { id: 'private-marker-task', createdAt: 10, cwd: root, workspaceId: 'private-project', goalId: 'goal', workItemId: 'work',
      businessLineId: 'studio', title: 'Private marker', sdkSessionId: 'private-marker-sdk', model: 'fixture', providerId: 'fixture',
      taskStrategy: 'execute', permissionMode: 'default', status: 'idle', costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextTokens: 0 } as SessionMeta & { sdkSessionId: string }
    save(file, old)
    const store = new TaskExecutionAuthorityStore(root)
    const grant = store.grant(old, { expectedRevision: 0, expectedBindingDigest: taskExecutionAuthorityBindingDigest(old),
      allowedWriteTools: ['write_file'], pathPatterns: ['reports/**'] }, 'local-user:fixture')
    store.revoke(old, { expectedRevision: grant.revision }, 'local-user:fixture')
    const childResult = spawnSync(join(process.cwd(), 'node_modules/.bin/tsx'), [process.argv[1], '--cold-private-marker', root], { encoding: 'utf8' })
    assert.equal(childResult.status, 0, `${childResult.stdout}\n${childResult.stderr}`)
    console.log('PASS private revocation survives cold recovery when every public marker write failed')

    save(join(root, 'active-sessions.json'), activeSessionRegistryDocument([old]))
    save(join(root, 'sessions.json'), historyStoreDocument([sessionHistoryEntry(old)]))
    const staleSnapshot = { sessionId: old.id, meta: old }
    assert.throws(() => collectProjectSessionPortableSlice(root, old.workspaceId!, [old.id], [staleSnapshot]), /TASK_AUTHORITY_EXPORT_RECONCILIATION/)
    console.log('PASS actual portable collector rejects an export that would lose the private restriction')

    const marked = { ...old, taskExecutionAuthorityRequired: true as const }
    save(join(root, 'active-sessions.json'), activeSessionRegistryDocument([marked]))
    save(join(root, 'sessions.json'), historyStoreDocument([sessionHistoryEntry(marked)]))
    const retainedCreation = { schemaVersion: 1, sessionId: old.id, createdAt: 10, updatedAt: 10,
      draft: { baseMeta: old, opts: { cwd: root, workspaceId: old.workspaceId } } }
    save(join(root, 'session-creation-journal.json'), sessionCreationJournalDocument([retainedCreation]))
    const beforeCreation = readFileSync(join(root, 'session-creation-journal.json'))
    store.grant(marked, { expectedRevision: 2, expectedBindingDigest: taskExecutionAuthorityBindingDigest(marked),
      allowedWriteTools: ['write_file'], pathPatterns: ['reports/**'] }, 'local-user:fixture')
    const exported = collectProjectSessionPortableSlice(root, old.workspaceId!, [old.id], [{ sessionId: old.id, meta: marked }])
    assert.equal((exported.sessionCreationJournal[0] as typeof retainedCreation).draft.baseMeta.taskExecutionAuthorityRequired, true)
    assert.deepEqual(readFileSync(join(root, 'session-creation-journal.json')), beforeCreation)
    assert(exported.sessionFiles.every(item => !item.path.includes('task-execution-authorities')))
    console.log('PASS normal granted task exports with retained creation marker carried only in the portable copy')
    console.log('Private authority marker: 3/3 passed; isolated metadata, cold process and actual collector; no Provider calls.')
  } finally { rmSync(root, { recursive: true, force: true }) }
}
