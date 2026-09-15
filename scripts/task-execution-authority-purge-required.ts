import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { SessionMeta } from '../src/shared/types'
import { TaskExecutionAuthorityStore, taskExecutionAuthorityBindingDigest } from '../src/main/permission/task-execution-authority-store'
import { taskExecutionAuthorityFiles, taskExecutionAuthorityProjectSessionIds, purgeTaskExecutionAuthorityFiles } from '../src/main/data-lifecycle/task-execution-authority-data-files'
import { preparationSessionKey } from '../src/main/data-lifecycle/preparation-data-files'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-authority-purge-')))
try {
  const store = new TaskExecutionAuthorityStore(root)
  const make = (id: string, workspaceId: string) => ({ id, workspaceId, createdAt: 10, cwd: root,
    taskStrategy: 'execute', status: 'idle', taskExecutionAuthorityRequired: true } as SessionMeta)
  for (const [id, project] of [['purged-session', 'purged-project'], ['kept-session', 'kept-project']]) {
    const meta = make(id, project)
    store.grant(meta, { expectedRevision: 0, expectedBindingDigest: taskExecutionAuthorityBindingDigest(meta),
      allowedWriteTools: ['write_file'], pathPatterns: ['reports/**'] }, 'local-user:fixture')
  }
  const [file] = taskExecutionAuthorityFiles(root, ['purged-session'])
  const temporary = join(dirname(file), `.${basename(file)}.fixture.tmp`)
  writeFileSync(temporary, readFileSync(file))
  assert.deepEqual(taskExecutionAuthorityProjectSessionIds(root, 'purged-project'), ['purged-session'])
  assert.equal(taskExecutionAuthorityFiles(root, ['purged-session']).length, 2)
  assert.equal(purgeTaskExecutionAuthorityFiles(root, ['purged-session']).length, 2)
  assert.equal(taskExecutionAuthorityFiles(root, ['purged-session']).length, 0)
  assert.deepEqual(taskExecutionAuthorityProjectSessionIds(root, 'purged-project'), [])
  assert.equal(taskExecutionAuthorityFiles(root, ['kept-session']).length, 1)
  console.log('PASS orphan Project inventory, owned crash files, purge residuals, unrelated authority preserved')
  const external = join(root, 'external.json'); writeFileSync(external, 'must remain')
  const malicious = join(root, 'private', 'task-execution-authorities', `${preparationSessionKey('symlink-session')}.json`)
  symlinkSync(external, malicious)
  assert.throws(() => purgeTaskExecutionAuthorityFiles(root, ['symlink-session']), /not regular/)
  assert.equal(readFileSync(external, 'utf8'), 'must remain')
  assert(existsSync(malicious))
  console.log('PASS substituted authority paths refuse deletion without touching symlink target')
  console.log('Task execution authority purge: 2/2 passed; isolated owned files only.')
} finally { rmSync(root, { recursive: true, force: true }) }
