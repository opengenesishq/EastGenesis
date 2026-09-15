import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { EffectTarget } from '../src/shared/effect-types'
import type { PreparationPermissionView } from '../src/shared/preparation-permission-types'
import type { SessionMeta } from '../src/shared/types'
import { executeCodingTool, type ToolExecutionOptions } from '../src/main/openaiTools'
import { PreparationPermissionStore } from '../src/main/permission/preparation-permission-store'
import { resolvePreparationToolScope } from '../src/main/permission/preparation-tool-scope'
import { decideTaskStrategyTool } from '../src/main/task/task-strategy'
import { writeTextFileLocally } from '../src/main/sandbox/local-execution'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-preparation-permission-')))
const cwd = join(root, 'formal')
const reportPath = join(process.cwd(), 'test-results', 'preparation-permission', 'latest.json')
const checks: { name: string; status: 'passed' | 'failed'; detail?: string }[] = []
mkdirSync(cwd)
writeFileSync(join(cwd, 'protected.md'), 'formal bytes')
const meta = {
  id: 'preparation-session', title: 'Preparation fixture', createdAt: 1, cwd,
  status: 'idle', taskStrategy: 'plan', permissionMode: 'default',
  workspaceId: 'workspace', goalId: 'goal', workItemId: 'work-item', businessLineId: 'studio'
} as SessionMeta
const store = new PreparationPermissionStore(root)
let permission: PreparationPermissionView

function absentEffect(directory: string, file: string, content: string): EffectTarget {
  const actual = statSync(directory, { bigint: true })
  return {
    kind: 'file_content', rootPath: directory, relativePath: file,
    rootIdentity: { device: actual.dev.toString(), inode: actual.ino.toString() },
    expectedBytes: Buffer.byteLength(content),
    expectedSha256: createHash('sha256').update(content).digest('hex'), preState: 'absent'
  }
}

function options(revision = permission.revision, currentMeta = meta): ToolExecutionOptions {
  assert(permission.directory)
  return { sessionMeta: currentMeta, userDataRoot: root, sandboxMode: 'restrictedLocal',
    preparationPermission: { revision, directory: permission.directory } }
}

async function check(name: string, action: () => Promise<void> | void): Promise<void> {
  try { await action(); checks.push({ name, status: 'passed' }) }
  catch (error) { checks.push({ name, status: 'failed', detail: String(error) }) }
}

async function main(): Promise<void> {
  try {
    await check('legacy plan remains read-only without a preparation grant', () => {
      const none = store.get(meta)
      assert.equal(none.status, 'none'); assert.equal(none.available, false)
      assert.equal(none.directory, undefined); assert(none.unavailableReason)
      for (const path of ['new.md', join(cwd, 'new.md')]) {
        const input = { path, content: 'blocked' }
        assert.equal(resolvePreparationToolScope(meta, 'write_file', input, root).preparation, undefined)
        assert.equal(decideTaskStrategyTool(meta.taskStrategy, 'write_file', input).allow, false)
      }
      assert.equal(existsSync(join(cwd, 'new.md')), false)
    })
    await check('view cannot grant preparation writing', () => {
      assert.throws(() => store.grant({ ...meta, taskStrategy: 'view' }, { expectedRevision: 0 }, 'local-user:test'), /查看/)
      assert.equal(store.get(meta).status, 'none')
    })
    permission = store.grant(meta, { expectedRevision: 0 }, 'local-user:test')
    assert(permission.available && permission.directory)
    const directory = permission.directory
    const grantedRevision = permission.revision
    await check('authorized write_file creates actual bytes in the isolated directory', async () => {
      const path = join(directory, 'draft.md'), content = 'customer report draft'
      const scope = resolvePreparationToolScope(meta, 'write_file', { path, content }, root)
      assert.equal(scope.cwd, directory)
      const result = await executeCodingTool('write_file', { path, content }, scope.cwd,
        { ...options(), effectTarget: absentEffect(directory, 'draft.md', content) })
      assert.equal(result.ok, true, result.output)
      assert.equal(readFileSync(path, 'utf8'), content)
    })
    await check('another Session cannot borrow the current directory or permission token', async () => {
      const other = { ...meta, id: 'another-session' }, path = join(directory, 'other.md')
      assert.throws(() => resolvePreparationToolScope(other, 'write_file', { path }, root), /授权/)
      const result = await executeCodingTool('write_file', { path, content: 'blocked' }, directory,
        { ...options(grantedRevision, other), effectTarget: absentEffect(directory, 'other.md', 'blocked') })
      assert.equal(result.ok, false); assert.equal(existsSync(path), false)
    })
    await check('actual writer rejects directory escape and formal target while retaining formal bytes', async () => {
      for (const path of [join(directory, '..', 'escaped.md'), join(cwd, 'protected.md')]) {
        const result = await executeCodingTool('write_file', { path, content: 'blocked' }, directory,
          { ...options(), effectTarget: absentEffect(directory, 'unused.md', 'blocked') })
        assert.equal(result.ok, false, path)
      }
      assert.equal(existsSync(join(directory, '..', 'escaped.md')), false)
      assert.equal(readFileSync(join(cwd, 'protected.md'), 'utf8'), 'formal bytes')
    })
    await check('unadapted tools cannot use the preparation capability', async () => {
      for (const name of ['edit_file', 'search_replace', 'bash', 'create_document']) {
        const result = await executeCodingTool(name, { path: join(directory, 'draft.md'), command: 'false' }, directory, options())
        assert.equal(result.ok, false); assert.match(result.output, /未适配/)
      }
    })
    await check('running revocation persists across store restart and blocks the actual writer', async () => {
      permission = store.revoke({ ...meta, status: 'running' }, { expectedRevision: grantedRevision }, 'local-user:test')
      assert.equal(permission.status, 'revoked'); assert.equal(permission.available, false)
      assert.equal(new PreparationPermissionStore(root).get({ ...meta }).status, 'revoked')
      const path = join(directory, 'revoked.md')
      const result = await executeCodingTool('write_file', { path, content: 'blocked' }, directory,
        { ...options(grantedRevision), effectTarget: absentEffect(directory, 'revoked.md', 'blocked') })
      assert.equal(result.ok, false); assert.match(result.output, /撤销或变更/)
      assert.equal(existsSync(path), false)
    })
    await check('stale mutation revision and old write token remain invalid after a fresh grant', async () => {
      assert.throws(() => store.grant(meta, { expectedRevision: grantedRevision }, 'local-user:test'), /版本已变化/)
      permission = store.grant(meta, { expectedRevision: permission.revision }, 'local-user:test')
      assert(permission.revision > grantedRevision)
      const path = join(directory, 'stale.md')
      const result = await executeCodingTool('write_file', { path, content: 'blocked' }, directory,
        { ...options(grantedRevision), effectTarget: absentEffect(directory, 'stale.md', 'blocked') })
      assert.equal(result.ok, false); assert.equal(existsSync(path), false)
      assert.equal(readFileSync(join(cwd, 'protected.md'), 'utf8'), 'formal bytes')
    })
    await check('revocation during asynchronous path verification prevents truncating an existing draft', async () => {
      const path = join(directory, 'draft.md'), original = readFileSync(path)
      const info = statSync(path, { bigint: true }), revision = permission.revision
      let revoked = false
      const result = await writeTextFileLocally({
        cwd: directory, targetPath: path, content: 'must not replace the saved draft',
        mode: 'restrictedLocal', timeoutMs: 5000,
        expectedFile: { identity: { device: info.dev.toString(), inode: info.ino.toString() },
          sha256: createHash('sha256').update(original).digest('hex'), bytes: original.length },
        beforeGuardedCommit: () => store.assertWritable(meta, revision, directory),
        beforeGuardedPathVerificationRead: () => {
          if (!revoked) {
            permission = store.revoke({ ...meta, status: 'running' }, { expectedRevision: revision }, 'local-user:test')
            revoked = true
          }
        },
        assertWriteAuthorized: () => store.assertWritable(meta, revision, directory)
      })
      assert(revoked)
      assert.equal(result.ok, false)
      assert.match(result.output, /撤销或变更/)
      assert.deepEqual(readFileSync(path), original)
    })
  } finally {
    const failed = checks.filter((check) => check.status === 'failed')
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(),
      status: failed.length ? 'failed' : 'passed', providerCalls: false, checks,
      limitations: ['Local strategy gate, authority store, tool scope and physical writer checks; no Electron IPC, full NativeToolRuntime or human acceptance exercise.'] }, null, 2) + '\n')
    rmSync(root, { recursive: true, force: true })
    console.log(`Preparation permission: ${checks.length - failed.length}/${checks.length} passed\n${reportPath}`)
    if (failed.length) { console.error(failed); process.exitCode = 1 }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
