import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Module } from 'node:module'
import { build } from 'esbuild'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-import-history-'))), project = join(root, 'project'), home = join(root, 'home'), backups = join(root, 'backups')
let checks = 0
const pass = name => { checks++; console.log(`PASS ${name}`) }
try {
  mkdirSync(join(project, '.cursor'), { recursive: true }); mkdirSync(home)
  writeFileSync(join(project, '.cursorrules'), 'Use explicit sources and small patches.')
  writeFileSync(join(project, 'caogen.md'), 'Existing local guidance.')
  writeFileSync(join(project, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { url: 'https://fixture.invalid/mcp', headers: { Authorization: 'Bearer fixture-secret-not-imported' } } } }))
  const output = await build({ stdin: { contents: `export * from './src/main/migration'; export * from './src/main/migration-history'; export * from './src/renderer/src/components/settings/migration-service-links';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false })
  const filename = resolve('scripts/.migration-history-fixture.cjs'), module = new Module(filename)
  module.filename = filename; module.paths = Module._nodeModulePaths(dirname(filename)); module._compile(output.outputFiles[0].text, filename)
  const api = module.exports, scan = api.scanMigration(project, home)
  const applied = api.applyMigration({ scanId: scan.scanId, decisions: scan.assets.map(asset => ({ assetId: asset.id, action: asset.importable ? 'import' : 'skip' })) }, { backupRoot: backups })
  assert(applied.ok, applied.errorCode)
  const history = api.listMigrationHistory(backups)
  assert.equal(history.entries.length, 1); assert.equal(history.entries[0].backupId, applied.backupId); assert.equal(history.entries[0].state, 'committed')
  assert(!JSON.stringify(history).includes('fixture-secret')); assert(!readFileSync(join(project, '.caogen', 'mcp', 'mcp.json'), 'utf8').includes('fixture-secret'))
  const preview = api.previewMigrationRollback(backups, applied.backupId)
  assert(preview.canRollback, preview.message); api.assertMigrationRollbackReview(backups, applied.backupId, preview.reviewDigest)
  pass('durable import records survive a fresh history read; recovery previews bind both targets and backups without exposing or importing credentials')

  const target = join(project, 'caogen.md'), imported = readFileSync(target)
  writeFileSync(target, 'Changes made after import.')
  assert.throws(() => api.assertMigrationRollbackReview(backups, applied.backupId, preview.reviewDigest), /改变|变化/)
  assert.equal(api.previewMigrationRollback(backups, applied.backupId).canRollback, false)
  assert.equal(readFileSync(target, 'utf8'), 'Changes made after import.')
  writeFileSync(target, imported)
  const manifest = JSON.parse(readFileSync(join(backups, applied.backupId, 'manifest.json'), 'utf8'))
  const original = manifest.targets.find(item => item.existed), backupFile = join(backups, applied.backupId, original.backupPath), before = readFileSync(backupFile)
  writeFileSync(backupFile, 'Corrupted stored backup.')
  assert.equal(api.previewMigrationRollback(backups, applied.backupId).canRollback, false)
  writeFileSync(backupFile, before)
  pass('changed post-import files and altered stored backups refuse recovery while preserving local contents')

  const fresh = api.previewMigrationRollback(backups, applied.backupId)
  api.assertMigrationRollbackReview(backups, applied.backupId, fresh.reviewDigest)
  const restored = api.rollbackMigration(applied.backupId, backups)
  assert(restored.ok, restored.errorCode); assert.equal(readFileSync(target, 'utf8'), 'Existing local guidance.')
  assert(restored.safetyBackupId); assert.equal(api.listMigrationHistory(backups).entries[0].state, 'rolled_back')
  assert.equal(api.previewMigrationRollback(backups, applied.backupId).canRollback, false)
  assert(readdirSync(backups).includes(restored.safetyBackupId))
  pass('the original rollback restores pre-import contents, writes a safety backup and persists its restored status')

  mkdirSync(join(backups, 'invalid-record')); writeFileSync(join(backups, 'invalid-record', 'contract.json'), '{}')
  mkdirSync(join(backups, 'linked-record')); symlinkSync(join(backups, applied.backupId, 'contract.json'), join(backups, 'linked-record', 'contract.json'))
  const invalid = api.listMigrationHistory(backups).entries.filter(item => item.state === 'invalid')
  assert.equal(invalid.length, 2); assert(invalid.every(item => !item.canReviewRollback && !item.targetPaths.length))
  pass('invalid or symbolic-link history metadata stays visible as unavailable and cannot restore a target')

  const targetPath = `${project}/.caogen/mcp/mcp.json`, item = { id: 'original', name: 'fixture', kind: 'mcp', path: targetPath, sourceRoot: `${project}/.caogen`, sourceKind: 'project' }
  const namesake = { ...item, id: 'wrong-project', path: '/other/.caogen/mcp/mcp.json', sourceRoot: '/other/.caogen' }
  assert.deepEqual(api.migrationServiceCandidates([targetPath], [item, namesake], ['/other']), [])
  assert.deepEqual(api.migrationServiceCandidates([targetPath], [item, namesake], [project]).map(value => value.id), ['original'])
  assert.deepEqual(api.migrationServiceCandidates([targetPath], [{ ...item, sourceRoot: '/other/.caogen' }], [project]), [])
  const user = { ...item, id: 'user', path: `${home}/.caogen/mcp/mcp.json`, sourceRoot: `${home}/.caogen`, sourceKind: 'user' }
  assert.deepEqual(api.migrationServiceCandidates([user.path], [user], []).map(value => value.id), ['user'])
  pass('service links require the exact imported config and current project, reject namesakes, and retain genuine user-scoped services')
  console.log(`migration-history-required: ${checks}/${checks}; temporary local sources and backups only; no external authorization or Provider`)
} finally { rmSync(root, { recursive: true, force: true }) }
