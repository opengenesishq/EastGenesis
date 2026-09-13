import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseToml } from '@iarna/toml'
import type { MigrationAssetScope, MigrationScan } from '../shared/types'
import {
  assertNoSymlinkWithin,
  containsSensitiveText,
  readSafeFile,
  safeRulePreview
} from './migration-safety'
import { storeMigrationScan, type InternalMigrationAsset, type JsonObject } from './migration-scan-store'
import { applyMigration as applyMigrationSelection } from './migration-apply'
import {
  assetId,
  buildAsset,
  compareAssets,
  diagnostic,
  inspectRuleTarget,
  isObject,
  MAX_MIGRATION_SOURCE_FILE_BYTES as MAX_SOURCE_FILE_BYTES,
  migrationTargetRoot,
  ruleTarget,
  type MigrationDiagnostic
} from './migration-asset-helpers'
import {
  addContinueMcpDirectory,
  addContinueYamlMcpAssets,
  addGeminiMcpAssets,
  addJsonMcpAssets,
  addMcpEntry,
  addOpenCodeMcpAssets,
  addQwenMcpAssets,
  boundedMcpEntries
} from './migration-mcp-assets'
import { addSkillRoot } from './migration-skill-assets'

export { applyMigration, defaultMigrationBackupRoot, rollbackMigration } from './migration-apply'
export type { MigrationApplyOptions } from './migration-apply'

export function scanMigration(
  cwdInput?: string,
  homeDirectory = homedir(),
  targetRootDirectory?: string
): MigrationScan {
  const home = resolve(homeDirectory)
  const cwd = normalizeProjectDirectory(cwdInput)
  const diagnostics: MigrationDiagnostic[] = []
  const internalAssets: InternalMigrationAsset[] = []

  if (cwd) scanProjectSources(cwd, home, internalAssets, diagnostics)
  scanUserSources(cwd, home, internalAssets, diagnostics)
  blockAmbiguousDestinations(internalAssets)

  const scanId = randomUUID()
  const result: MigrationScan = {
    scanId,
    ...(cwd ? { cwd } : {}),
    mode: cwd ? 'project' : 'conversation',
    scannedAt: new Date().toISOString(),
    assets: internalAssets.map(({ asset }) => asset).sort(compareAssets),
    diagnostics
  }
  storeMigrationScan(result, internalAssets)
  return result
}

/** Compatibility bridge for the legacy path-selection UI; replacement still requires the new decision flow. */
export function importAssets(cwd: string, paths: string[]): string {
  const requested = new Set(paths)
  const scan = scanMigration(cwd)
  const decisions = scan.assets
    .filter((asset) => requested.has(asset.path))
    .map((asset) => ({
      assetId: asset.id,
      action: asset.importable && asset.supportedActions.includes('import')
        ? 'import' as const
        : 'skip' as const
    }))
  const result = applyMigrationSelection({ scanId: scan.scanId, decisions })
  if (!result.ok) throw new Error(result.errorCode ?? 'migration_operation_failed')
  return result.message
}

function scanProjectSources(
  cwd: string,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  const ruleFiles: Array<[string, string]> = [
    ['Cursor', join(cwd, '.cursorrules')],
    ['Windsurf', join(cwd, '.windsurfrules')],
    ['Roo Code', join(cwd, '.roorules')],
    ['Codex', join(cwd, 'AGENTS.md')],
    ['Gemini CLI', join(cwd, 'GEMINI.md')],
    ['Qwen Code', join(cwd, 'QWEN.md')],
    ['GitHub Copilot', join(cwd, '.github', 'copilot-instructions.md')],
    ['Aider', join(cwd, 'CONVENTIONS.md')]
  ]
  for (const [agent, sourcePath] of ruleFiles) {
    addRuleAsset(agent, 'project', sourcePath, cwd, cwd, home, assets, diagnostics)
  }
  for (const [agent, directory] of [
    ['Cursor', join(cwd, '.cursor', 'rules')],
    ['Windsurf', join(cwd, '.windsurf', 'rules')],
    ['Roo Code', join(cwd, '.roo', 'rules')],
    ['GitHub Copilot', join(cwd, '.github', 'instructions')],
    ['Continue', join(cwd, '.continue', 'rules')]
  ] as Array<[string, string]>) {
    addRuleDirectory(agent, 'project', directory, cwd, cwd, home, assets, diagnostics)
  }

  for (const [agent, sourcePath] of [
    ['Cursor', join(cwd, '.cursor', 'mcp.json')],
    ['Windsurf', join(cwd, '.windsurf', 'mcp.json')],
    ['Roo Code', join(cwd, '.roo', 'mcp.json')]
  ] as Array<[string, string]>) {
    addJsonMcpAssets(agent, 'project', sourcePath, cwd, cwd, home, assets, diagnostics)
  }
  const continueProjectConfig = join(cwd, '.continuerc.json')
  addBlockedConfigAsset('Continue', 'project', continueProjectConfig, cwd, assets, diagnostics)
  addContinueMcpDirectory('project', join(cwd, '.continue', 'mcpServers'), cwd, cwd, home, assets, diagnostics)

  const geminiProjectConfig = join(cwd, '.gemini', 'settings.json')
  addBlockedConfigAsset('Gemini CLI', 'project', geminiProjectConfig, cwd, assets, diagnostics)
  addGeminiMcpAssets('project', geminiProjectConfig, cwd, cwd, home, assets, diagnostics)
  const qwenProjectConfig = join(cwd, '.qwen', 'settings.json')
  addBlockedConfigAsset('Qwen Code', 'project', qwenProjectConfig, cwd, assets, diagnostics)
  addQwenMcpAssets('project', qwenProjectConfig, cwd, cwd, home, assets, diagnostics)
  for (const openCodeConfig of [
    join(cwd, 'opencode.json'),
    join(cwd, 'opencode.jsonc'),
    join(cwd, '.opencode', 'opencode.json'),
    join(cwd, '.opencode', 'opencode.jsonc')
  ]) {
    addBlockedConfigAsset('OpenCode', 'project', openCodeConfig, cwd, assets, diagnostics)
    addOpenCodeMcpAssets('project', openCodeConfig, cwd, cwd, home, assets, diagnostics)
  }

  addBlockedConfigAsset('Aider', 'project', join(cwd, '.aider.conf.yml'), cwd, assets, diagnostics)
  addSkillRoot('Codex', 'project', join(cwd, '.codex', 'skills'), cwd, cwd, home, assets, diagnostics)
  addSkillRoot('Gemini CLI', 'project', join(cwd, '.gemini', 'skills'), cwd, cwd, home, assets, diagnostics, 'gemini')
  addSkillRoot('Qwen Code', 'project', join(cwd, '.qwen', 'skills'), cwd, cwd, home, assets, diagnostics, 'qwen')
  addSkillRoot('OpenCode', 'project', join(cwd, '.opencode', 'skills'), cwd, cwd, home, assets, diagnostics, 'opencode')
  addSkillRoot('OpenCode', 'project', join(cwd, '.opencode', 'skill'), cwd, cwd, home, assets, diagnostics, 'opencode-legacy')
}

function scanUserSources(
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  addRuleAsset('Codex', 'user', join(home, '.codex', 'AGENTS.md'), home, cwd, home, assets, diagnostics)
  addRuleAsset('Gemini CLI', 'user', join(home, '.gemini', 'GEMINI.md'), home, cwd, home, assets, diagnostics)
  addRuleAsset('Qwen Code', 'user', join(home, '.qwen', 'QWEN.md'), home, cwd, home, assets, diagnostics)
  const openCodeRoot = join(home, '.config', 'opencode')
  addRuleAsset('OpenCode', 'user', join(openCodeRoot, 'AGENTS.md'), openCodeRoot, cwd, home, assets, diagnostics)
  addBlockedConfigAsset('Aider', 'user', join(home, '.aider.conf.yml'), home, assets, diagnostics)
  const continueRoot = join(home, '.continue')
  const continueYamlConfig = join(continueRoot, 'config.yaml')
  addBlockedConfigAsset('Continue', 'user', continueYamlConfig, continueRoot, assets, diagnostics)
  addContinueYamlMcpAssets('user', continueYamlConfig, continueRoot, cwd, home, assets, diagnostics)
  addBlockedConfigAsset('Continue', 'user', join(continueRoot, 'config.json'), continueRoot, assets, diagnostics)

  addCodexConfigAssets(join(home, '.codex', 'config.toml'), home, cwd, home, assets, diagnostics)
  const geminiRoot = join(home, '.gemini')
  const geminiUserConfig = join(geminiRoot, 'settings.json')
  addBlockedConfigAsset('Gemini CLI', 'user', geminiUserConfig, geminiRoot, assets, diagnostics)
  addGeminiMcpAssets('user', geminiUserConfig, geminiRoot, cwd, home, assets, diagnostics)
  const qwenUserConfig = join(home, '.qwen', 'settings.json')
  addBlockedConfigAsset('Qwen Code', 'user', qwenUserConfig, join(home, '.qwen'), assets, diagnostics)
  addQwenMcpAssets('user', qwenUserConfig, join(home, '.qwen'), cwd, home, assets, diagnostics)
  for (const openCodeConfig of [join(openCodeRoot, 'opencode.json'), join(openCodeRoot, 'opencode.jsonc')]) {
    addBlockedConfigAsset('OpenCode', 'user', openCodeConfig, openCodeRoot, assets, diagnostics)
    addOpenCodeMcpAssets('user', openCodeConfig, openCodeRoot, cwd, home, assets, diagnostics)
  }
  addJsonMcpAssets('Cursor', 'user', join(home, '.cursor', 'mcp.json'), home, cwd, home, assets, diagnostics)
  addSkillRoot('Codex', 'user', join(home, '.codex', 'skills'), home, cwd, home, assets, diagnostics)
  addSkillRoot('Gemini CLI', 'user', join(geminiRoot, 'skills'), geminiRoot, cwd, home, assets, diagnostics, 'gemini')
  addSkillRoot('Qwen Code', 'user', join(home, '.qwen', 'skills'), join(home, '.qwen'), cwd, home, assets, diagnostics, 'qwen')
  addSkillRoot('OpenCode', 'user', join(openCodeRoot, 'skills'), openCodeRoot, cwd, home, assets, diagnostics, 'opencode')
  addSkillRoot('OpenCode', 'user', join(openCodeRoot, 'skill'), openCodeRoot, cwd, home, assets, diagnostics, 'opencode-legacy')
  addSkillRoot('OpenCode', 'user', join(home, '.agents', 'skills'), home, cwd, home, assets, diagnostics, 'opencode-agents')

}

function addRuleDirectory(
  agent: string,
  scope: MigrationAssetScope,
  directory: string,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  if (!existsSync(directory)) return
  try {
    assertNoSymlinkWithin(sourceRoot, directory)
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('migration_source_not_directory')
    for (const entry of readdirSync(directory, { withFileTypes: true, encoding: 'utf8' }).slice(0, 50)) {
      if (!entry.name.startsWith('.') && entry.isFile()) {
        addRuleAsset(agent, scope, join(directory, entry.name), sourceRoot, cwd, home, assets, diagnostics)
      }
    }
  } catch (error) {
    diagnostics.push(diagnostic(error, directory))
  }
}

function addRuleAsset(
  agent: string,
  scope: MigrationAssetScope,
  sourcePath: string,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  if (!existsSync(sourcePath)) return
  try {
    assertNoSymlinkWithin(sourceRoot, sourcePath)
    const source = readSafeFile(sourcePath, MAX_SOURCE_FILE_BYTES)
    const text = source.bytes.toString('utf8')
    const targetPath = ruleTarget(scope, cwd, home)
    const id = assetId(agent, 'rules', scope, sourcePath)
    const sensitive = containsSensitiveText(text)
    const target = inspectRuleTarget(targetPath, id, source.digest)
    const risk = sensitive ? 'blocked' : scope === 'user' ? 'review' : target.blocked ? 'blocked' : 'low'
    const conflict = target.blocked ? 'unsupported' : target.conflict
    const importable = !sensitive && !target.blocked && conflict !== 'duplicate'
    const asset = buildAsset({
      id,
      agent,
      kind: 'rules',
      scope,
      sourcePath,
      source,
      preview: safeRulePreview(text),
      targetPath,
      conflict,
      conflictDetail: target.detail,
      risk,
      riskReasons: [
        ...(sensitive ? ['检测到疑似凭据,禁止导入'] : []),
        ...(scope === 'user' ? ['用户级规则会影响所有对话'] : []),
        ...(target.blocked ? ['目标文件不可安全修改'] : [])
      ],
      importable,
      recommended: importable && risk === 'low' && (conflict === 'none' || conflict === 'merge')
    })
    assets.push({
      asset,
      sourceRoot,
      sourcePath,
      targetRoot: migrationTargetRoot(scope, cwd, home),
      targetPath,
      targetFingerprint: target.fingerprint
    })
  } catch (error) {
    diagnostics.push(diagnostic(error, sourcePath))
  }
}

function addBlockedConfigAsset(
  agent: string,
  scope: MigrationAssetScope,
  sourcePath: string,
  sourceRoot: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  if (!existsSync(sourcePath)) return
  try {
    assertNoSymlinkWithin(sourceRoot, sourcePath)
    const source = readSafeFile(sourcePath, MAX_SOURCE_FILE_BYTES)
    assets.push({
      asset: buildAsset({
        id: assetId(agent, 'config', scope, sourcePath),
        agent,
        kind: 'config',
        scope,
        sourcePath,
        source,
        preview: '检测到配置文件;模型、Provider 和凭据字段不会自动复制。',
        conflict: 'unsupported',
        risk: 'blocked',
        riskReasons: ['通用配置语义不能安全映射'],
        ignoredFields: ['entire_config'],
        importable: false,
        recommended: false
      }),
      sourceRoot,
      sourcePath
    })
  } catch (error) {
    diagnostics.push(diagnostic(error, sourcePath))
  }
}

function addCodexConfigAssets(
  sourcePath: string,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  if (!existsSync(sourcePath)) return
  try {
    assertNoSymlinkWithin(sourceRoot, sourcePath)
    const source = readSafeFile(sourcePath, MAX_SOURCE_FILE_BYTES)
    const parsed = parseToml(source.bytes.toString('utf8')) as JsonObject
    const topLevelIgnored = Object.keys(parsed).filter((key) => key !== 'mcp_servers' && key !== 'notify')
    assets.push({
      asset: buildAsset({
        id: assetId('Codex', 'config', 'user', sourcePath),
        agent: 'Codex',
        kind: 'config',
        scope: 'user',
        sourcePath,
        source,
        preview: 'Codex 配置已结构化读取;Provider、模型、认证与运行策略保持不变。',
        conflict: 'unsupported',
        risk: 'blocked',
        riskReasons: ['只迁移可安全映射的 MCP 与 Skill'],
        ignoredFields: topLevelIgnored.length > 0 ? topLevelIgnored.map((key) => `config.${key}`) : ['non_mcp_config'],
        importable: false,
        recommended: false
      }),
      sourceRoot,
      sourcePath
    })

    if (Array.isArray(parsed.notify) || typeof parsed.notify === 'string') {
      assets.push({
        asset: buildAsset({
          id: assetId('Codex', 'hook', 'user', sourcePath, 'notify'),
          agent: 'Codex',
          kind: 'hook',
          scope: 'user',
          sourcePath,
          source,
          name: 'notify hook',
          preview: '检测到 Codex notify Hook;因执行语义和权限边界不同,不会自动启用。',
          conflict: 'unsupported',
          risk: 'blocked',
          riskReasons: ['Hook 可执行本地命令,必须重新授权'],
          ignoredFields: ['notify.command', 'notify.args', 'notify.env'],
          importable: false,
          recommended: false
        }),
        sourceRoot,
        sourcePath
      })
    }

    if (isObject(parsed.mcp_servers)) {
      for (const [name, config] of boundedMcpEntries(parsed.mcp_servers)) {
        addMcpEntry('Codex', 'user', sourcePath, sourceRoot, source, name, config, cwd, home, assets)
      }
    }
  } catch (error) {
    diagnostics.push(diagnostic(error, sourcePath))
  }
}

function blockAmbiguousDestinations(assets: InternalMigrationAsset[]): void {
  const destinations = new Map<string, InternalMigrationAsset[]>()
  for (const internal of assets) {
    const key = destinationKey(internal)
    if (!key || !internal.asset.importable) continue
    const group = destinations.get(key) ?? []
    group.push(internal)
    destinations.set(key, group)
  }
  for (const group of destinations.values()) {
    if (group.length < 2) continue
    for (const internal of group) {
      internal.asset = {
        ...internal.asset,
        conflict: 'unsupported',
        conflictDetail: '多个来源映射到同一目标,为避免静默覆盖已阻止导入',
        risk: 'blocked',
        riskReasons: [...internal.asset.riskReasons, '多个迁移来源存在目标冲突'],
        importable: false,
        recommended: false,
        supportedActions: ['skip']
      }
    }
  }
}

function destinationKey(internal: InternalMigrationAsset): string | undefined {
  if (!internal.targetPath) return undefined
  if (internal.asset.kind === 'mcp' && internal.mcpServerName) {
    return `mcp\0${resolve(internal.targetPath)}\0${internal.mcpServerName}`
  }
  if (internal.asset.kind === 'skill' || internal.asset.kind === 'prompt' || internal.asset.kind === 'usage') {
    return `${internal.asset.kind}\0${resolve(internal.targetPath)}`
  }
  return undefined
}

function normalizeProjectDirectory(cwdInput?: string): string | undefined {
  const trimmed = typeof cwdInput === 'string' ? cwdInput.trim() : ''
  if (!trimmed) return undefined
  const cwd = resolve(trimmed)
  const info = lstatSync(cwd)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('migration_project_not_directory')
  return cwd
}
