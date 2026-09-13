const fs = require('node:fs')
const path = require('node:path')

function createMigrationIntegrationCheck({ M, tmpRoot, assert }) {
  return async () => {
    const migration = M('main/migration.js')
    const migrationHome = path.join(tmpRoot, 'migration-home')
    const backupRoot = path.join(migrationHome, '.caogen-private', 'migration-backups')
    fs.mkdirSync(path.join(migrationHome, '.codex'), { recursive: true })
    writeCodexConfigFixture(migrationHome)
    verifyPrimaryMigration({ migration, tmpRoot, migrationHome, backupRoot, assert })
    verifyExtendedSources({ migration, tmpRoot, migrationHome, backupRoot, assert })
    verifySymlinkRejection({ migration, tmpRoot, migrationHome, assert })
    verifyTargetSymlinkRejection({ migration, tmpRoot, migrationHome, backupRoot, assert })
    verifySourceChangeRejection({ migration, tmpRoot, migrationHome, backupRoot, assert })
    verifyBatchRollback({ migration, tmpRoot, migrationHome, backupRoot, assert })
  }
}

function verifyPrimaryMigration({ migration, tmpRoot, migrationHome, backupRoot, assert }) {
  const project = path.join(tmpRoot, 'migproj')
  fs.mkdirSync(path.join(project, '.cursor', 'rules'), { recursive: true })
  fs.mkdirSync(path.join(project, '.codex', 'skills', 'reviewer'), { recursive: true })
  fs.writeFileSync(path.join(project, '.cursorrules'), 'use pnpm')
  fs.writeFileSync(path.join(project, '.cursor', 'rules', 'x.mdc'), 'rule x')
  fs.writeFileSync(path.join(project, '.codex', 'skills', 'reviewer', 'SKILL.md'), '# Reviewer\nReview changes.')
  writeSensitiveMcpFixture(project)

  const scan = migration.scanMigration(project, migrationHome)
  assert(scan.assets.length >= 6, `扫描数量:${scan.assets.length}`)
  assert(scan.assets.every((asset) => !asset.preview.includes(secretCanary())), '预览泄漏凭据')
  const hook = scan.assets.find((asset) => asset.kind === 'hook')
  assert(hook && !hook.importable && hook.risk === 'blocked', 'Hook 必须只提示不导入')
  const mcpAsset = scan.assets.find((asset) => asset.agent === 'Cursor' && asset.kind === 'mcp')
  assert(mcpAsset && mcpAsset.ignoredFields.length >= 3 && mcpAsset.risk === 'review', 'MCP 敏感字段必须标记')

  const applied = migration.applyMigration(projectDecisions(scan), { backupRoot })
  assert(applied.ok && applied.backupId, `导入失败:${applied.errorCode}`)
  verifyPrimaryTargets(project, assert)
  verifyConflicts(migration.scanMigration(project, migrationHome), assert)

  const rolledBack = migration.rollbackMigration(applied.backupId, backupRoot)
  assert(rolledBack.ok, `回滚失败:${rolledBack.errorCode}`)
  assert(!fs.existsSync(path.join(project, 'caogen.md')), '回滚未移除新建 caogen.md')
  assert(!fs.existsSync(path.join(project, '.caogen', 'mcp', 'mcp.json')), '回滚未移除新建 CaoGen MCP 配置')
  assert(!fs.existsSync(path.join(project, '.caogen', 'skills', 'reviewer')), '回滚未移除新建 CaoGen Skill')
}

function verifyExtendedSources({ migration, tmpRoot, migrationHome, backupRoot, assert }) {
  const project = path.join(tmpRoot, 'migproj2')
  fs.mkdirSync(path.join(project, '.roo', 'rules'), { recursive: true })
  fs.mkdirSync(path.join(project, '.continue', 'rules'), { recursive: true })
  fs.writeFileSync(path.join(project, '.roorules'), 'roo 单文件规则')
  fs.writeFileSync(path.join(project, '.roo', 'rules', 'a.md'), 'roo 目录规则')
  fs.writeFileSync(path.join(project, '.continue', 'rules', 'c.md'), 'continue 规则')
  fs.writeFileSync(path.join(project, 'CONVENTIONS.md'), 'aider 约定')

  const scan = migration.scanMigration(project, migrationHome)
  const agents = new Set(scan.assets.map((asset) => asset.agent))
  assert(agents.has('Roo Code'), 'Roo Code 未扫描到')
  assert(agents.has('Continue'), 'Continue 未扫描到')
  assert(agents.has('Aider'), 'Aider CONVENTIONS.md 未扫描到')
  const applied = migration.applyMigration(projectDecisions(scan), { backupRoot })
  assert(applied.ok, `扩展来源导入失败:${applied.errorCode}`)
  const rules = fs.readFileSync(path.join(project, 'caogen.md'), 'utf8')
  assert(rules.includes('roo 单文件规则') && rules.includes('continue 规则') && rules.includes('aider 约定'), '新来源注入失败')
}

function verifySymlinkRejection({ migration, tmpRoot, migrationHome, assert }) {
  const project = path.join(tmpRoot, 'mig-symlink')
  fs.mkdirSync(project, { recursive: true })
  fs.symlinkSync(path.join(tmpRoot, 'migproj2', 'CONVENTIONS.md'), path.join(project, '.cursorrules'))
  const scan = migration.scanMigration(project, migrationHome)
  assert(!scan.assets.some((asset) => asset.path.endsWith('.cursorrules')), '符号链接来源未拒绝')
  assert(scan.diagnostics.some((item) => item.path?.endsWith('.cursorrules')), '符号链接拒绝缺少诊断')
}

function verifySourceChangeRejection({ migration, tmpRoot, migrationHome, backupRoot, assert }) {
  const project = path.join(tmpRoot, 'mig-changed')
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, '.cursorrules'), 'before scan')
  const scan = migration.scanMigration(project, migrationHome)
  const asset = scan.assets.find((candidate) => candidate.path.endsWith('.cursorrules'))
  assert(asset, 'TOCTOU fixture 未扫描到')
  fs.writeFileSync(path.join(project, '.cursorrules'), 'after scan')
  const applied = migration.applyMigration({
    scanId: scan.scanId,
    decisions: [{ assetId: asset.id, action: 'import' }]
  }, { backupRoot })
  assert(!applied.ok && applied.errorCode === 'migration_source_changed', 'TOCTOU 未 fail-closed')
  assert(!fs.existsSync(path.join(project, 'caogen.md')), 'TOCTOU 失败后仍写入目标')
}

function verifyTargetSymlinkRejection({ migration, tmpRoot, migrationHome, backupRoot, assert }) {
  const project = path.join(tmpRoot, 'mig-target-symlink')
  const outside = path.join(tmpRoot, 'mig-target-outside')
  fs.mkdirSync(path.join(project, '.codex', 'skills', 'fixture'), { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(project, '.codex', 'skills', 'fixture', 'SKILL.md'), '# Fixture')
  fs.symlinkSync(outside, path.join(project, '.caogen'))
  const scan = migration.scanMigration(project, migrationHome)
  const asset = scan.assets.find((candidate) => candidate.kind === 'skill' && candidate.scope === 'project')
  assert(asset, '目标符号链接 fixture 未扫描到')
  const applied = migration.applyMigration({
    scanId: scan.scanId,
    decisions: [{ assetId: asset.id, action: 'import' }]
  }, { backupRoot })
  assert(!applied.ok && applied.errorCode === 'migration_symlink_rejected', '目标父目录符号链接未拒绝')
  assert(!fs.existsSync(path.join(outside, 'skills', 'fixture')), '目标符号链接逃逸写入')
}

function verifyBatchRollback({ migration, tmpRoot, migrationHome, backupRoot, assert }) {
  const project = path.join(tmpRoot, 'mig-fault')
  fs.mkdirSync(path.join(project, '.cursor'), { recursive: true })
  fs.writeFileSync(path.join(project, '.cursorrules'), 'fault rule')
  fs.writeFileSync(path.join(project, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { safe: { command: 'node' } } }))
  const scan = migration.scanMigration(project, migrationHome)
  const applied = migration.applyMigration(projectDecisions(scan), { backupRoot, faultAfterWrites: 1 })
  assert(!applied.ok, '故障注入应失败')
  assert(!fs.existsSync(path.join(project, 'caogen.md')), '批量失败未恢复 caogen.md')
  assert(!fs.existsSync(path.join(project, '.caogen', 'mcp', 'mcp.json')), '批量失败未恢复 CaoGen MCP 配置')
}

function verifyPrimaryTargets(project, assert) {
  const rules = fs.readFileSync(path.join(project, 'caogen.md'), 'utf8')
  assert(rules.includes('use pnpm') && rules.includes('caogen:migration-begin'), 'caogen.md 注入失败')
  const mcp = JSON.parse(fs.readFileSync(path.join(project, '.caogen', 'mcp', 'mcp.json'), 'utf8'))
  assert(mcp.mcpServers.figma, 'CaoGen MCP 配置合并失败')
  assert(!mcp.mcpServers.figma.env && !mcp.mcpServers.figma.headers, 'MCP 凭据字段被写入目标')
  assert(!JSON.stringify(mcp).includes(secretCanary()), 'MCP 参数泄漏凭据')
  assert(!JSON.stringify(mcp).includes(separatedCredentialCanary()), 'MCP 分离参数泄漏凭据')
  assert(!mcp.mcpServers.figma.args.includes('--access-token'), 'MCP 凭据参数名被保留')
  assert(!mcp.mcpServers.figma.args.includes('-H'), 'MCP Header 参数名被保留')
  assert(mcp.mcpServers.remote.url === 'https://mcp.invalid/path', 'MCP URL userinfo/query/fragment 未剥离')
  assert(fs.existsSync(path.join(project, '.caogen', 'skills', 'reviewer', 'SKILL.md')), 'Skill 未导入 CaoGen 目录')
}

function verifyConflicts(scan, assert) {
  assert(scan.assets.some((asset) => asset.kind === 'rules' && asset.conflict === 'duplicate'), '规则幂等识别失败')
  assert(
    scan.assets.some((asset) => asset.kind === 'mcp' && asset.scope === 'project' && asset.conflict === 'replace_required'),
    'MCP 冲突未识别'
  )
}

function projectDecisions(scan) {
  return {
    scanId: scan.scanId,
    decisions: scan.assets.map((asset) => ({
      assetId: asset.id,
      action: asset.scope === 'project' && asset.importable
        ? asset.conflict === 'replace_required' ? 'replace' : 'import'
        : 'skip'
    }))
  }
}

function writeSensitiveMcpFixture(project) {
  fs.writeFileSync(path.join(project, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: {
      figma: {
        command: 'npx',
        args: [
          '-y',
          'fixture-package',
          '--token',
          secretCanary(),
          '--access-token',
          separatedCredentialCanary(),
          '-H',
          `Authorization: Bearer ${secretCanary()}`
        ],
        env: { FIGMA_TOKEN: secretCanary() },
        headers: { Authorization: `Bearer ${secretCanary()}` }
      },
      remote: {
        url: 'https://fixture-user:fixture-pass@mcp.invalid/path?mode=test#section'
      }
    }
  }))
}

function writeCodexConfigFixture(migrationHome) {
  fs.writeFileSync(path.join(migrationHome, '.codex', 'config.toml'), [
    'model = "fixture-model"',
    `notify = ["fixture-notifier", "${secretCanary()}"]`,
    '[mcp_servers.global_fixture]',
    'command = "node"',
    'args = ["server.js"]',
    '[mcp_servers.global_fixture.env]',
    `GLOBAL_TOKEN = "${secretCanary()}"`
  ].join('\n'))
}

function secretCanary() {
  return 'secret-for-smoke-migration-canary'
}

function separatedCredentialCanary() {
  return 'opaque-value-for-migration-smoke'
}

module.exports = { createMigrationIntegrationCheck }
