import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AppSettings, EffectTarget, PermissionRuleConfig, SessionMeta } from '../src/shared/types'
import type { TaskExecutionAuthorityGrant } from '../src/shared/task-execution-authority-types'
import { TASK_EXECUTION_AUTHORITY_WRITE_TOOLS } from '../src/shared/task-execution-authority-types'
import { TaskExecutionAuthorityStore, taskExecutionAuthorityBindingDigest } from '../src/main/permission/task-execution-authority-store'
import { withActiveTaskExecutionAuthoritySession } from '../src/main/permission/task-execution-authority-lifecycle'
import { withDataLifecycleMutation } from '../src/main/data-lifecycle/data-lifecycle-mutation-lock'
import { SessionDeletionJournal } from '../src/main/data-lifecycle/session-deletion-journal'
import { formalFileWriteGuard } from '../src/main/permission/limited-file-execution'
import { normalizeSettingsDocument } from '../src/main/settings'
import { compareAndWriteSettingsFile, readSettingsFileSnapshot } from '../src/main/settings-file-storage'
import { executeCodingTool } from '../src/main/openaiTools'
import { writeTextFileLocally } from '../src/main/sandbox/local-execution'
import { buildOfficeArtifactEffectTarget, executeOfficeArtifactTool } from '../src/main/agent/tools/office-artifact'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-task-authority-')))
const report = join(process.cwd(), 'test-results', 'task-execution-authority', 'latest.json')
const checks: { name: string; status: 'passed' | 'failed'; detail?: string }[] = []
function fixture() {
  const data = mkdtempSync(join(root, 'case-')), cwd = join(data, 'workspace')
  mkdirSync(cwd); mkdirSync(join(cwd, 'reports'))
  const meta = { id: 'task-a', createdAt: 1, cwd, status: 'idle', taskStrategy: 'execute', permissionMode: 'acceptEdits',
    projectId: 'legacy-project', workspaceId: 'project-a', goalId: 'goal-a', workItemId: 'work-a', taskExecutionAuthorityRequired: true } as SessionMeta
  const store = new TaskExecutionAuthorityStore(data)
  const request = (patch: Partial<TaskExecutionAuthorityGrant> = {}): TaskExecutionAuthorityGrant => ({
    expectedRevision: store.get(meta).revision, expectedBindingDigest: taskExecutionAuthorityBindingDigest(meta),
    allowedWriteTools: TASK_EXECUTION_AUTHORITY_WRITE_TOOLS, pathPatterns: ['reports/**'], ...patch
  })
  const grant = (patch: Partial<TaskExecutionAuthorityGrant> = {}) => store.grant(meta, request(patch), 'local-user:fixture')
  return { data, cwd, meta, store, request, grant }
}
function digest(value: Buffer | string) { return createHash('sha256').update(value).digest('hex') }
function absentTarget(cwd: string, path: string, content: string): EffectTarget {
  const info = statSync(cwd, { bigint: true })
  return { kind: 'file_content', rootPath: cwd, relativePath: path,
    rootIdentity: { device: String(info.dev), inode: String(info.ino) }, preState: 'absent', expectedSha256: digest(content), expectedBytes: Buffer.byteLength(content) }
}
function saveSettings(data: string, value: AppSettings) {
  const file = join(data, 'settings.json'), old = readSettingsFileSnapshot(file)
  assert.equal(compareAndWriteSettingsFile(file, { expectedToken: old.token, document: { ...value } }).status, 'committed')
}
function rule(effect: 'allow' | 'deny', pathPattern: string): PermissionRuleConfig {
  return { id: effect, enabled: true, effect, toolPattern: 'write_file', pathPattern, commandPattern: '', networkHostPattern: '',
    guiApplicationPattern: '', guiWindowPattern: '', mcpToolPattern: '', mcpArgumentPointer: '', mcpArgumentPattern: '',
    capabilityScope: ['workspaceWrite'], requirePostcondition: false, riskOperator: 'exact' }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function check(name: string, action: () => Promise<void> | void) {
  try { await action(); checks.push({ name, status: 'passed' }) }
  catch (error) { checks.push({ name, status: 'failed', detail: String(error) }) }
}

async function main() {
  try {
    await check('legacy grants are never inferred; imported required markers fail closed; invalid requests have no side effects', () => {
      const f = fixture(), legacy = { ...f.meta, taskExecutionAuthorityRequired: undefined }
      assert.equal(f.store.get(legacy).status, 'legacy'); assert.equal(f.store.get(legacy).available, false)
      assert.equal(f.store.get(f.meta).status, 'revoked')
      assert.throws(() => f.store.assertAllowed(f.meta, 'write_file', { path: 'reports/import.md' }, f.cwd), /缺失/)
      for (const path of ['/tmp/**', '../**', 'reports/../**', 'C:/outside/**', 'reports\\**']) {
        assert.throws(() => f.store.assertMutation(legacy, f.request({ pathPatterns: [path] }), 'grant'), /相对路径/)
      }
      assert.throws(() => f.store.grant({ ...f.meta, taskStrategy: 'plan' }, f.request(), 'local-user:fixture'), /执行意图/)
      assert.throws(() => f.store.grant({ ...f.meta, status: 'running' }, f.request(), 'local-user:fixture'), /暂停/)
      assert.equal(f.store.get(legacy).revision, 0); assert.equal(f.store.get(legacy).status, 'legacy')
      const imported = JSON.parse(JSON.stringify(f.meta)) as SessionMeta
      const destination = mkdtempSync(join(root, 'import-'))
      assert.equal(new TaskExecutionAuthorityStore(destination).get(imported).status, 'revoked')
    })
    await check('actual writer commits scoped bytes; another task, formal path, opaque tool, and symlink cannot borrow the grant', async () => {
      const f = fixture(), permission = f.grant(), content = 'authorized task bytes'
      const options = { userDataRoot: f.data, sessionMeta: f.meta, sessionId: f.meta.id, taskExecutionAuthorityRevision: permission.revision }
      const okay = await executeCodingTool('write_file', { path: 'reports/allowed.md', content }, f.cwd,
        { ...options, effectTarget: absentTarget(f.cwd, 'reports/allowed.md', content) })
      assert.equal(okay.ok, true, okay.output); assert.equal(readFileSync(join(f.cwd, 'reports/allowed.md'), 'utf8'), content)
      for (const path of ['outside.md', '../escaped.md']) {
        const result = await executeCodingTool('write_file', { path, content }, f.cwd, options)
        assert.equal(result.ok, false); assert.equal(existsSync(join(f.cwd, path)), false)
      }
      const other = { ...f.meta, id: 'task-b' }
      const borrowed = await executeCodingTool('write_file', { path: 'reports/borrowed.md', content }, f.cwd,
        { ...options, sessionId: other.id, sessionMeta: other })
      assert.equal(borrowed.ok, false); assert.equal(existsSync(join(f.cwd, 'reports/borrowed.md')), false)
      for (const tool of ['bash', 'run_skill', 'task_dispatch_dag', 'mcp_call_tool', 'send_notification']) {
        assert.throws(() => f.store.assertAllowed(f.meta, tool, { path: 'reports/tool.md', command: 'touch reports/tool.md' }, f.cwd), /阻止此工具/)
      }
      symlinkSync(f.data, join(f.cwd, 'reports/link'))
      assert.throws(() => f.store.assertAllowed(f.meta, 'write_file', { path: 'reports/link/escape.md' }, f.cwd), /符号链接/)
      assert.equal(existsSync(join(f.data, 'escape.md')), false)
    })
    await check('relative globs include root files without matching cwd ancestry; previews bind the actual current root', () => {
      const f = fixture()
      f.grant({ pathPatterns: ['**/*'] })
      f.store.assertAllowed(f.meta, 'write_file', { path: 'root.md' }, f.cwd)
      f.grant({ pathPatterns: ['*'] })
      f.store.assertAllowed(f.meta, 'write_file', { path: 'root.md' }, f.cwd)
      assert.throws(() => f.store.assertAllowed(f.meta, 'write_file', { path: 'reports/nested.md' }, f.cwd), /未获得/)
      f.grant({ pathPatterns: ['**/workspace/**'] })
      assert.throws(() => f.store.assertAllowed(f.meta, 'write_file', { path: 'reports/file.md' }, f.cwd), /未获得/)
      f.grant({ pathPatterns: ['reports/**/drafts/**/note.md'] })
      f.store.assertAllowed(f.meta, 'write_file', { path: 'reports/sub/drafts/note.md' }, f.cwd)
      const preview = f.request()
      const moved = join(f.data, 'other-root'); mkdirSync(moved); f.meta.cwd = moved
      assert.equal(f.store.get(f.meta).directory, moved)
      assert.throws(() => f.store.grant(f.meta, preview, 'local-user:fixture'), /工作目录已变化/)
    })
    await check('Session/project/Goal/WorkItem and real-root replacement invalidate the durable grant', () => {
      const f = fixture(); f.grant()
      for (const field of ['createdAt', 'projectId', 'workspaceId', 'goalId', 'workItemId', 'businessLineId', 'personalWorkspaceId', 'parentSessionId'] as const) {
        const changed = { ...f.meta, [field]: field === 'createdAt' ? 2 : 'changed' }
        assert.throws(() => f.store.assertAllowed(changed, 'write_file', { path: 'reports/file.md' }, f.cwd), /身份已变化/)
      }
      renameSync(f.cwd, `${f.cwd}-original`); mkdirSync(f.cwd)
      assert.equal(f.store.get(f.meta).available, false)
      assert.throws(() => f.store.assertAllowed(f.meta, 'write_file', { path: 'reports/file.md' }, f.cwd), /身份已变化/)
    })
    await check('task grants cannot override global denies, missing global scopes, or live deny changes before commit', () => {
      const f = fixture(); f.grant()
      const base = normalizeSettingsDocument({}), input = { path: 'reports/global.md' }
      const scope = { rootDir: f.data, sessionMeta: f.meta, sessionId: f.meta.id }
      saveSettings(f.data, { ...base, permissionRules: [rule('deny', 'reports/**')] })
      assert.throws(formalFileWriteGuard('write_file', input, f.cwd, scope), /黑名单/)
      saveSettings(f.data, { ...base, limitedFileExecutionEnabled: true, permissionRules: [] })
      assert.throws(formalFileWriteGuard('write_file', input, f.cwd, scope), /限定文件执行/)
      saveSettings(f.data, base)
      const guard = formalFileWriteGuard('write_file', input, f.cwd, scope); guard()
      saveSettings(f.data, { ...base, permissionRules: [rule('deny', 'reports/**')] })
      assert.throws(guard, /黑名单/)
    })
    await check('revocation during overwrite verification preserves original bytes and old approval cannot use a regrant', async () => {
      const f = fixture(), grant = f.grant(), path = join(f.cwd, 'reports/saved.md'), original = Buffer.from('original')
      writeFileSync(path, original)
      const info = statSync(path, { bigint: true })
      const guard = formalFileWriteGuard('edit_file', { path }, f.cwd,
        { rootDir: f.data, sessionMeta: f.meta, taskExecutionAuthorityRevision: grant.revision })
      let revoked = false
      const result = await writeTextFileLocally({ cwd: f.cwd, targetPath: path, content: 'must not replace', mode: 'restrictedLocal', timeoutMs: 1000,
        expectedFile: { identity: { device: String(info.dev), inode: String(info.ino) }, sha256: digest(original), bytes: original.length },
        beforeGuardedPathVerificationRead() {
          if (!revoked) { f.store.revoke({ ...f.meta, status: 'running' }, { expectedRevision: grant.revision }, 'local-user:fixture'); revoked = true }
        }, assertWriteAuthorized: guard })
      assert(revoked); assert.equal(result.ok, false); assert.deepEqual(readFileSync(path), original)
      assert.equal(new TaskExecutionAuthorityStore(f.data).get(f.meta).status, 'revoked')
      f.grant(); assert.throws(guard, /撤销或变更/)
      assert.throws(() => f.store.revoke(f.meta, { expectedRevision: grant.revision }, 'local-user:fixture'), /版本已变化/)
      f.store.assertAllowed(f.meta, 'read_file', { path }, f.cwd)
    })
    await check('Office generation rechecks current grant at commit and produces no revoked file', async () => {
      const f = fixture(), grant = f.grant()
      const input = { path: 'reports/revoked.docx', title: 'Offline task authority', paragraphs: ['local evidence'], source_refs: [] }
      const target = await buildOfficeArtifactEffectTarget('create_document', input, f.cwd)
      const guard = formalFileWriteGuard('create_document', input, f.cwd,
        { rootDir: f.data, sessionMeta: f.meta, taskExecutionAuthorityRevision: grant.revision })
      let calls = 0
      await assert.rejects(executeOfficeArtifactTool('create_document', input, f.cwd, target, undefined, {
        assertWriteAuthorized() {
          if (++calls === 2) f.store.revoke({ ...f.meta, status: 'running' }, { expectedRevision: grant.revision }, 'local-user:fixture')
          guard()
        }, withWriteAccess: commit => withDataLifecycleMutation(f.data, commit)
      }), /撤销或变更/)
      assert.equal(existsSync(join(f.cwd, input.path)), false)
    })
    await check('queued writes recheck revocation after the shared lifecycle lock; ownership changes and deletion reject grants', async () => {
      const f = fixture(), grant = f.grant(), entered = deferred(), release = deferred()
      const mutation = withDataLifecycleMutation(f.data, async () => {
        entered.resolve(); await release.promise
        f.store.revoke({ ...f.meta, status: 'running' }, { expectedRevision: grant.revision }, 'local-user:fixture')
      })
      await entered.promise
      const content = 'must not write after revoke', path = 'reports/queued.md'
      const writing = executeCodingTool('write_file', { path, content }, f.cwd, { sessionMeta: f.meta, userDataRoot: f.data,
        taskExecutionAuthorityRevision: grant.revision, effectTarget: absentTarget(f.cwd, path, content) })
      release.resolve(); await mutation
      assert.equal((await writing).ok, false); assert.equal(existsSync(join(f.cwd, path)), false)
      const preview = f.request()
      await assert.rejects(withActiveTaskExecutionAuthoritySession(f.data, f.meta.id, () => f.meta,
        async () => { f.meta.projectId = 'changed-during-await' }, meta => f.store.grant(meta, preview, 'local-user:fixture')), /归属已变化/)
      await new SessionDeletionJournal(f.data).begin(f.meta.id, 'sdk-task-a')
      assert.throws(() => f.grant(), /正在删除/)
    })
  } finally {
    const failed = checks.filter(check => check.status === 'failed')
    mkdirSync(dirname(report), { recursive: true })
    writeFileSync(report, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), providerCalls: false,
      status: failed.length ? 'failed' : 'passed', checks,
      limitations: ['Focused local store, policy, physical writer and lifecycle checks; no Provider calls, Electron UI or end-user acceptance.'] }, null, 2) + '\n')
    rmSync(root, { recursive: true, force: true })
    console.log(`Task execution authority: ${checks.length - failed.length}/${checks.length} passed\n${report}`)
    if (failed.length) { console.error(failed); process.exitCode = 1 }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
