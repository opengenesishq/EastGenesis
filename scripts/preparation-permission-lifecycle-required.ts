import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SessionMeta } from '../src/shared/types'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-preparation-lifecycle-')))
const report = join(process.cwd(), 'test-results', 'preparation-permission-lifecycle', 'latest.json')
const checks: { name: string; status: 'passed' | 'failed'; detail?: string }[] = []
let PreparationPermissionStore: typeof import('../src/main/permission/preparation-permission-store').PreparationPermissionStore
let withActivePreparationSession: typeof import('../src/main/permission/preparation-permission-lifecycle').withActivePreparationSession
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }
function fixture() {
  const dir = mkdtempSync(join(root, 'case-')), cwd = join(dir, 'formal')
  mkdirSync(cwd)
  let live: SessionMeta | undefined = { id: 'session', createdAt: 1, cwd, status: 'idle', taskStrategy: 'plan' } as SessionMeta
  const store = new PreparationPermissionStore(dir)
  let reads = 0
  const read = () => { reads++; if (!live) throw new Error('会话不存在'); return live }
  const mutate = (operation: 'grant' | 'revoke', expectedRevision: number, ownership: (meta: SessionMeta) => Promise<unknown> = async () => {}) =>
    withActivePreparationSession(dir, 'session', read, ownership, (meta) => store[operation](meta, { expectedRevision }, 'local-user:lifecycle-test'))
  return { dir, store, read, mutate, meta: read(), clear: () => { live = undefined }, reads: () => reads }
}
async function check(name: string, action: () => Promise<void>) {
  try { await action(); checks.push({ name, status: 'passed' }) }
  catch (error) { checks.push({ name, status: 'failed', detail: String(error) }) }
}
async function main() {
  // These production modules import Electron's app singleton at module load.
  // Keep this contract test runnable under plain Node with an isolated userData
  // root, just like the Electron runtime would provide.
  const require = createRequire(import.meta.url)
  const moduleLoader = require('node:module') as { _load: Function }
  const originalLoad = moduleLoader._load
  moduleLoader._load = function fixtureElectronLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') return { app: { getPath: () => root } }
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    const { withDataLifecycleMutation } = await import('../src/main/data-lifecycle/data-lifecycle-mutation-lock')
    const { preparationPaths, purgePreparationData } = await import('../src/main/data-lifecycle/preparation-data-files')
    const { PROJECT_DELETION_PHASES, ProjectDeletionJournal } = await import('../src/main/data-lifecycle/project-deletion-journal')
    const { SESSION_DELETION_PHASES, SessionDeletionJournal } = await import('../src/main/data-lifecycle/session-deletion-journal')
    const { executeCodingTool } = await import('../src/main/openaiTools')
    ;({ withActivePreparationSession } = await import('../src/main/permission/preparation-permission-lifecycle'))
    ;({ PreparationPermissionStore } = await import('../src/main/permission/preparation-permission-store'))
    await check('queued grant resolves live Session only after deletion lock releases', async () => {
      const f = fixture(), entered = deferred(), release = deferred(), before = f.reads()
      const deletion = withDataLifecycleMutation(f.dir, async () => { entered.resolve(); await release.promise; f.clear() })
      await entered.promise
      const grant = f.mutate('grant', 0), rejected = assert.rejects(grant, /会话不存在/)
      assert.equal(f.reads(), before)
      release.resolve(); await deletion; await rejected
      assert.equal(existsSync(preparationPaths(f.dir, 'session').permission), false)
    })
    await check('both queued grant and revoke reject completed Session purge despite stale runtime metadata', async () => {
      for (const operation of ['grant', 'revoke'] as const) {
        const f = fixture(), permission = await f.mutate('grant', 0), entered = deferred(), release = deferred()
        const journal = new SessionDeletionJournal(f.dir)
        const deletion = withDataLifecycleMutation(f.dir, async () => {
          entered.resolve(); await release.promise
          const entry = await journal.begin('session', 'sdk-session')
          purgePreparationData(f.dir, ['session'])
          for (const phase of SESSION_DELETION_PHASES.slice(1)) await journal.advance(entry.operationId, phase)
        })
        await entered.promise
        const rejected = assert.rejects(f.mutate(operation, permission.revision), /永久删除/)
        release.resolve(); await deletion; await rejected
        assert.equal(journal.getPendingSession('session'), undefined)
        assert.equal(existsSync(preparationPaths(f.dir, 'session').drafts), false)
        assert.equal(existsSync(preparationPaths(f.dir, 'session').permission), false)
      }
    })
    await check('pending and completed Project purge reject frozen Session scope and current Project ownership', async () => {
      for (const match of ['session', 'project'] as const) {
        const f = fixture(), journal = new ProjectDeletionJournal(f.dir)
        if (match === 'project') f.meta.workspaceId = 'project'
        const entry = await journal.begin({ projectId: 'project', expectedWorkspaceRevision: 1,
          sessionIds: match === 'session' ? ['session'] : [], sdkSessionIds: [], artifactBlobDigests: [] })
        await assert.rejects(f.mutate('grant', 0), /正在删除/)
        for (const phase of PROJECT_DELETION_PHASES.slice(1)) await journal.advance(entry.operationId, phase,
          phase === 'backup_written' ? { backupPath: join(f.dir, 'backup'), backupDigest: 'a'.repeat(64), exportDigest: 'b'.repeat(64) } : {})
        assert.equal(journal.listPending().length, 0)
        await assert.rejects(f.mutate('grant', 0), /永久删除/)
        assert.equal(existsSync(preparationPaths(f.dir, 'session').permission), false)
      }
    })
    await check('Session closure, rebound ownership and ownership failure during validation never grant', async () => {
      for (const change of ['closed', 'rebound', 'invalid'] as const) {
        const f = fixture()
        await assert.rejects(f.mutate('grant', 0, async () => {
          if (change === 'closed') f.clear()
          else if (change === 'rebound') f.meta.workItemId = 'other-task'
          else throw new Error('canonical Workspace is not active')
        }), /不存在|归属已变化|not active/)
        assert.equal(existsSync(preparationPaths(f.dir, 'session').permission), false)
      }
    })
    await check('queued physical writer cannot recreate preparation directories after purge', async () => {
      const f = fixture(), permission = await f.mutate('grant', 0), entered = deferred(), release = deferred()
      const directory = permission.directory!, path = join(directory, 'nested', 'resurrect.md'), content = 'forbidden old write'
      const stat = statSync(directory, { bigint: true })
      const deletion = withDataLifecycleMutation(f.dir, async () => { entered.resolve(); await release.promise; purgePreparationData(f.dir, ['session']) })
      await entered.promise
      const writing = executeCodingTool('write_file', { path, content }, directory, {
        sessionMeta: f.meta, userDataRoot: f.dir,
        preparationPermission: { directory, revision: permission.revision },
        effectTarget: { kind: 'file_content', rootPath: directory, relativePath: 'nested/resurrect.md',
          rootIdentity: { device: stat.dev.toString(), inode: stat.ino.toString() }, preState: 'absent',
          expectedBytes: Buffer.byteLength(content), expectedSha256: createHash('sha256').update(content).digest('hex') }
      })
      release.resolve(); await deletion
      const result = await writing
      assert.equal(result.ok, false, result.output)
      assert.equal(existsSync(preparationPaths(f.dir, 'session').drafts), false)
      assert.equal(existsSync(preparationPaths(f.dir, 'session').permission), false)
    })
    await check('purge waits for an in-flight preparation writer and removes its completed bytes', async () => {
      const f = fixture(), permission = await f.mutate('grant', 0)
      const directory = permission.directory!, path = join(directory, 'nested', 'completed.md'), content = 'complete before deletion'
      const stat = statSync(directory, { bigint: true })
      const writing = executeCodingTool('write_file', { path, content }, directory, {
        sessionMeta: f.meta, userDataRoot: f.dir,
        preparationPermission: { directory, revision: permission.revision },
        effectTarget: { kind: 'file_content', rootPath: directory, relativePath: 'nested/completed.md',
          rootIdentity: { device: stat.dev.toString(), inode: stat.ino.toString() }, preState: 'absent',
          expectedBytes: Buffer.byteLength(content), expectedSha256: createHash('sha256').update(content).digest('hex') }
      })
      const deletion = withDataLifecycleMutation(f.dir, async () => {
        assert.equal(readFileSync(path, 'utf8'), content)
        purgePreparationData(f.dir, ['session'])
      })
      const [result] = await Promise.all([writing, deletion])
      assert.equal(result.ok, true, result.output)
      assert.equal(existsSync(preparationPaths(f.dir, 'session').drafts), false)
      assert.equal(existsSync(preparationPaths(f.dir, 'session').permission), false)
    })
    await check('ordinary file writes remain independent of the preparation lifecycle lock', async () => {
      const f = fixture(), entered = deferred(), release = deferred()
      const held = withDataLifecycleMutation(f.dir, async () => { entered.resolve(); await release.promise })
      await entered.promise
      try {
        const result = await executeCodingTool('write_file', { path: 'normal.md', content: 'normal work' }, f.meta.cwd)
        assert.equal(result.ok, true, result.output)
        assert.equal(readFileSync(join(f.meta.cwd, 'normal.md'), 'utf8'), 'normal work')
      } finally { release.resolve(); await held }
    })
  } finally {
    const failed = checks.filter((entry) => entry.status === 'failed')
    mkdirSync(dirname(report), { recursive: true })
    writeFileSync(report, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(),
      status: failed.length ? 'failed' : 'passed', providerCalls: false, checks,
      limitations: ['Controlled Session lookup and ownership validation; production journals, permission store and physical writer.', 'No Electron IPC or Provider execution.'] }, null, 2) + '\n')
    rmSync(root, { recursive: true, force: true })
    moduleLoader._load = originalLoad
    console.log(`Preparation lifecycle: ${checks.length - failed.length}/${checks.length}; ${report}`)
    if (failed.length) { console.error(failed); process.exitCode = 1 }
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
