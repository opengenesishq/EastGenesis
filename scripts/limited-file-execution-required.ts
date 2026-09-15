import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings, EffectTarget, PermissionRuleConfig, SessionMeta } from '../src/shared/types'
import { normalizeSettingsDocument, readCurrentPermissionSettings } from '../src/main/settings'
import { compareAndWriteSettingsFile, readSettingsFileSnapshot } from '../src/main/settings-file-storage'
import { limitedFileExecutionPolicyError } from '../src/main/permission/limited-file-execution-policy'
import { formalFileWriteGuard } from '../src/main/permission/limited-file-execution'
import { PreparationPermissionStore } from '../src/main/permission/preparation-permission-store'
import { resolvePreparationToolScope } from '../src/main/permission/preparation-tool-scope'
import { writeTextFileLocally } from '../src/main/sandbox/local-execution'
import { executeCodingTool } from '../src/main/openaiTools'
import { buildOfficeArtifactEffectTarget, executeOfficeArtifactTool } from '../src/main/agent/tools/office-artifact'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-limited-file-'))), cwd = join(root, 'workspace')
mkdirSync(cwd); mkdirSync(join(cwd, 'reports'))
const settingsFile = join(root, 'settings.json')
const base = normalizeSettingsDocument({})
function rule(toolPattern = 'write_file', patch: Partial<PermissionRuleConfig> = {}): PermissionRuleConfig {
  return { id: 'file-scope', enabled: true, effect: 'allow', toolPattern, pathPattern: 'reports/**', commandPattern: '', networkHostPattern: '',
    guiApplicationPattern: '', guiWindowPattern: '', mcpToolPattern: '', mcpArgumentPointer: '', mcpArgumentPattern: '',
    capabilityScope: ['workspaceWrite'], requirePostcondition: false, riskOperator: 'exact', ...patch }
}
function settings(rules = [rule()]): AppSettings { return { ...base, limitedFileExecutionEnabled: true, permissionRules: rules } }
function save(value: AppSettings): void {
  const old = readSettingsFileSnapshot(settingsFile)
  assert.equal(compareAndWriteSettingsFile(settingsFile, { expectedToken: old.token, document: { ...value } }).status, 'committed')
}
function absentTarget(path: string, content: string): EffectTarget {
  const info = statSync(cwd, { bigint: true })
  return { kind: 'file_content', rootPath: cwd, rootIdentity: { device: String(info.dev), inode: String(info.ino) }, relativePath: path,
    preState: 'absent', expectedBytes: Buffer.byteLength(content), expectedSha256: createHash('sha256').update(content).digest('hex') }
}
let count = 0
async function check(name: string, action: () => unknown | Promise<unknown>) { await action(); count++; console.log(`PASS ${name}`) }

async function main() {
  try {
    await check('legacy setting remains explicit compatibility; durable limited mode reloads and invalid mode rejects', () => {
      assert.equal(base.limitedFileExecutionEnabled, false)
      assert.throws(() => normalizeSettingsDocument({ limitedFileExecutionEnabled: 'true' }), /布尔/)
      save(settings())
      assert.equal(readCurrentPermissionSettings(root).limitedFileExecutionEnabled, true)
      assert.deepEqual(readCurrentPermissionSettings(root).permissionRules, normalizeSettingsDocument({ ...settings() }).permissionRules)
    })
    await check('tool AND path AND capabilities are required; disable/delete/expiry/deny revoke authority', () => {
      const input = { path: 'reports/allowed.md' }
      assert.equal(limitedFileExecutionPolicyError(settings(), 'write_file', input, cwd), undefined)
      for (const selected of [[], [rule('edit_file')], [rule('write_file', { pathPattern: '' })], [rule('write_file', { capabilityScope: [] })],
        [rule('write_file', { enabled: false })], [rule('write_file', { expiresAt: Date.now() - 1 })],
        [rule(), rule('write_file', { id: 'deny', effect: 'deny', pathPattern: 'reports/allowed.md' })]]) {
        assert(limitedFileExecutionPolicyError(settings(selected), 'write_file', input, cwd))
      }
      assert(limitedFileExecutionPolicyError(settings(), 'write_file', { path: 'other.md' }, cwd))
      assert(limitedFileExecutionPolicyError({ ...settings([]), permissionAllowlist: 'write_file' }, 'write_file', input, cwd))
    })
    await check('shell, MCP, GUI, delegation and skill execution cannot bypass an explicit file rule', () => {
      const broad = settings([rule('*', { pathPattern: '**', capabilityScope: ['workspaceRead', 'workspaceWrite', 'terminal', 'browser', 'network'] })])
      for (const name of ['bash', 'mcp_call_tool', 'mcp__fixture__write', 'gui_type', 'browser_evaluate', 'browser_screenshot', 'run_skill', 'genesis_orchestrate', 'task_dispatch_dag', 'send_notification']) {
        assert(limitedFileExecutionPolicyError(broad, name, { path: 'reports/allowed.md', command: 'touch reports/escape' }, cwd), name)
      }
      assert.equal(limitedFileExecutionPolicyError(settings([]), 'read_file', { path: 'source.md' }, cwd), undefined)
    })
    await check('actual coding gateway writes in scope and refuses another path before file creation', async () => {
      save(settings())
      const content = 'permitted bytes', path = 'reports/allowed.md'
      const okay = await executeCodingTool('write_file', { path, content }, cwd, { userDataRoot: root, effectTarget: absentTarget(path, content) })
      assert.equal(okay.ok, true, okay.output); assert.equal(readFileSync(join(cwd, path), 'utf8'), content)
      const refused = await executeCodingTool('write_file', { path: 'outside.md', content }, cwd, { userDataRoot: root, effectTarget: absentTarget('outside.md', content) })
      assert.equal(refused.ok, false); assert.equal(existsSync(join(cwd, 'outside.md')), false)
    })
    await check('deleting durable rule during queued overwrite preserves original bytes despite old approval', async () => {
      save(settings())
      const targetPath = join(cwd, 'reports', 'allowed.md'), original = readFileSync(targetPath), info = statSync(targetPath, { bigint: true })
      const guard = formalFileWriteGuard('edit_file', { path: targetPath }, cwd, { rootDir: root })
      save(settings([rule('edit_file')]))
      const result = await writeTextFileLocally({ cwd, targetPath, content: 'must not commit', mode: 'restrictedLocal', timeoutMs: 1000,
        expectedFile: { identity: { device: String(info.dev), inode: String(info.ino) }, bytes: original.length, sha256: createHash('sha256').update(original).digest('hex') },
        beforeGuardedCommit() { save({ ...settings([]), limitedFileExecutionEnabled: false }) }, assertWriteAuthorized: guard })
      assert.equal(result.ok, false); assert.deepEqual(readFileSync(targetPath), original)
    })
    await check('Office final commit rechecks durable rule after rendering and creates no revoked output', async () => {
      save(settings([rule('create_document')]))
      const input = { path: 'reports/blocked.docx', title: 'Local scope fixture', paragraphs: ['Source content'], source_refs: [] }
      const target = await buildOfficeArtifactEffectTarget('create_document', input, cwd)
      const guard = formalFileWriteGuard('create_document', input, cwd, { rootDir: root })
      let checks = 0
      await assert.rejects(executeOfficeArtifactTool('create_document', input, cwd, target, undefined, { assertWriteAuthorized() {
        if (++checks === 2) save(settings([]))
        guard()
      } }), /限定文件执行/)
      assert.equal(existsSync(join(cwd, input.path)), false)
    })
    await check('an independently validated preparation grant remains usable with no formal write rules', async () => {
      save(settings([]))
      const meta = { id: 'limited-preparation', createdAt: 1, cwd, status: 'idle', taskStrategy: 'plan' } as SessionMeta
      const permission = new PreparationPermissionStore(root).grant(meta, { expectedRevision: 0 }, 'local-user:fixture')
      const path = join(permission.directory!, 'draft.md'), content = 'draft only'
      const scope = resolvePreparationToolScope(meta, 'write_file', { path, content }, root)
      const info = statSync(scope.cwd, { bigint: true })
      const result = await executeCodingTool('write_file', { path, content }, scope.cwd, { sessionMeta: meta, userDataRoot: root, preparationPermission: scope.preparation,
        effectTarget: { kind: 'file_content', rootPath: scope.cwd, rootIdentity: { device: String(info.dev), inode: String(info.ino) }, relativePath: 'draft.md',
          preState: 'absent', expectedBytes: content.length, expectedSha256: createHash('sha256').update(content).digest('hex') } })
      assert.equal(result.ok, true, result.output); assert.equal(readFileSync(path, 'utf8'), content)
    })
    await check('unreadable durable authority fails closed at final write', () => {
      save(settings())
      const guard = formalFileWriteGuard('write_file', { path: 'reports/allowed.md' }, cwd, { rootDir: root })
      writeFileSync(settingsFile, '{broken')
      assert.throws(guard)
    })
    console.log(`Limited file execution: ${count}/${count} passed`)
  } finally { rmSync(root, { recursive: true, force: true }) }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
