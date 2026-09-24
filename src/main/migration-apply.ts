import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  MigrationApplyInput,
  MigrationApplyItemResult,
  MigrationApplyResult,
  MigrationAsset,
  MigrationDecisionAction,
  MigrationRollbackResult
} from '../shared/types'
import {
  assertNoSymlinkWithin,
  containsSensitiveText,
  directoryContainsSensitiveText,
  errorCode,
  readSafeDirectory,
  readSafeFile,
  removeExactTarget,
  sha256,
  targetFingerprint,
  writeDirectoryAtomic,
  writeFileAtomic,
  type SafeDirectorySnapshot
} from './migration-safety'
import {
  assertMigrationContractPreflight,
  createMigrationContract,
  readMigrationContract,
  reconcileMigrationContracts,
  transitionMigrationContract,
  type MigrationContractJournal
} from './migration-contract'
import {
  deleteStoredMigrationScan,
  readStoredMigrationScan,
  type InternalMigrationAsset,
  type JsonObject
} from './migration-scan-store'

interface MigrationBackupTarget {
  targetPath: string
  existed: boolean
  kind?: 'file' | 'directory'
  backupPath?: string
  beforeFingerprint: string
  afterFingerprint?: string
}

interface MigrationBackupManifest {
  version: 1
  backupId: string
  createdAt: string
  reason: 'apply' | 'rollback_safety'
  targets: MigrationBackupTarget[]
}

export interface MigrationApplyOptions {
  backupRoot?: string
  backupId?: string
  faultAfterWrites?: number
}

const MAX_SOURCE_FILE_BYTES = 512 * 1024
const MAX_TARGET_FILE_BYTES = 8 * 1024 * 1024
const MAX_SKILL_BYTES = 5 * 1024 * 1024
const MAX_SKILL_FILES = 200
const BACKUP_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/
const IMPORT_BEGIN = '<!-- caogen:migration-begin'
const IMPORT_END = '<!-- caogen:migration-end'

export function applyMigration(input: MigrationApplyInput, options: MigrationApplyOptions = {}): MigrationApplyResult {
  const stored = readStoredMigrationScan(input?.scanId)
  if (!stored) return failedApply('migration_scan_expired', '迁移预览已过期,请重新扫描。')
  const skipped: MigrationApplyItemResult[] = []
  try {
    reconcileBeforeApply(resolve(options.backupRoot ?? defaultMigrationBackupRoot()))
    const selected = selectDecisions(stored.assets, normalizeDecisions(input?.decisions), skipped)
    if (selected.length === 0) {
      return { ok: true, status: 'no_changes', applied: [], skipped, message: '没有需要导入的内容。' }
    }
    preflightSelectedAssets(selected)
    const changes = buildTargetChanges(selected)
    const backupRoot = resolve(options.backupRoot ?? defaultMigrationBackupRoot())
    const manifest = createBackup(
      [...changes.files.keys(), ...changes.directories.keys()],
      backupRoot,
      'apply',
      options.backupId
    )
    assertBackupMatchesSelection(manifest, selected)
    const contract = createMigrationContract(backupRoot, {
      migrationId: manifest.backupId,
      kind: 'external-agent-assets',
      fromVersion: 0,
      toVersion: 1,
      backupId: manifest.backupId,
      source: {
        path: `migration-scan:${input.scanId}`,
        sha256: sha256(Buffer.from(JSON.stringify(stored.result.assets.map((asset) => ({ id: asset.id, digest: asset.sourceDigest }))))),
        sizeBytes: stored.result.assets.length
      },
      targets: manifest.targets.map((target) => ({ path: target.targetPath, beforeFingerprint: target.beforeFingerprint }))
    })
    applyChanges(changes, manifest, backupRoot, options, contract)
    deleteStoredMigrationScan(input.scanId)
    const applied = selected.map(({ internal }) => itemResult(internal.asset, 'applied'))
    return {
      ok: true,
      status: 'applied',
      backupId: manifest.backupId,
      applied,
      skipped,
      message: `已安全导入 ${applied.length} 项;凭据字段未写入目标。`
    }
  } catch (error) {
    return failedApply(publicMigrationError(error), '导入失败,目标已恢复到导入前状态。', skipped)
  }
}

export function rollbackMigration(
  backupId: string,
  backupRoot = defaultMigrationBackupRoot()
): MigrationRollbackResult {
  if (!BACKUP_ID_PATTERN.test(backupId)) return failedRollback(backupId, 'migration_backup_id_invalid')
  const root = resolve(backupRoot)
  try {
    const manifest = readBackupManifest(root, backupId)
    const contract = readExistingContract(root, backupId)
    if (contract?.state === 'rolled_back') {
      return {
        ok: true,
        status: 'rolled_back',
        backupId,
        restoredTargets: manifest.targets.map((target) => target.targetPath),
        message: '迁移已回滚,重复请求保持幂等。'
      }
    }
    const targetChangedAfterCommit = manifest.targets.some((target) =>
      !target.afterFingerprint || targetFingerprint(target.targetPath) !== target.afterFingerprint)
    const pendingTargetChanged = contract?.state === 'rollback_pending' && contract.targets.some((target) => {
      const current = targetFingerprint(target.path)
      return current !== target.beforeFingerprint && current !== target.afterFingerprint
    })
    if (contract?.state === 'rollback_pending' ? pendingTargetChanged : targetChangedAfterCommit) {
      return failedRollback(backupId, 'migration_target_changed_after_import')
    }
    const safety = createBackup(manifest.targets.map((target) => target.targetPath), root, 'rollback_safety')
    const rollbackPending = contract && contract.state === 'committed'
      ? transitionMigrationContract(root, contract, 'rollback_pending')
      : contract
    try {
      restoreManifest(manifest, root, contract?.state === 'committed')
      finalizeBackup(safety, root)
      if (rollbackPending) transitionMigrationContract(root, rollbackPending, 'rolled_back')
    } catch (error) {
      restoreManifest(safety, root, false)
      if (rollbackPending && rollbackPending.state !== 'rollback_pending') {
        transitionMigrationContract(root, rollbackPending, 'rollback_pending')
      }
      throw error
    }
    return {
      ok: true,
      status: 'rolled_back',
      backupId,
      safetyBackupId: safety.backupId,
      restoredTargets: manifest.targets.map((target) => target.targetPath),
      message: `已恢复 ${manifest.targets.length} 个目标;回滚前状态另存为安全备份。`
    }
  } catch (error) {
    return failedRollback(backupId, publicMigrationError(error))
  }
}

export function defaultMigrationBackupRoot(homeDirectory = homedir()): string {
  return join(resolve(homeDirectory), '.caogen-private', 'migration-backups')
}

function selectDecisions(
  assets: Map<string, InternalMigrationAsset>,
  decisions: Array<{ assetId: string; action: MigrationDecisionAction }>,
  skipped: MigrationApplyItemResult[]
): Array<{ internal: InternalMigrationAsset; action: MigrationDecisionAction }> {
  const selected: Array<{ internal: InternalMigrationAsset; action: MigrationDecisionAction }> = []
  for (const decision of decisions) {
    const internal = assets.get(decision.assetId)
    if (!internal) throw new Error('migration_asset_unknown')
    if (decision.action === 'skip') {
      skipped.push(itemResult(internal.asset, 'skipped', '用户选择跳过'))
    } else if (!internal.asset.supportedActions.includes(decision.action)) {
      throw new Error('migration_action_not_allowed')
    } else {
      selected.push({ internal, action: decision.action })
    }
  }
  return selected
}

function applyChanges(
  changes: ReturnType<typeof buildTargetChanges>,
  manifest: MigrationBackupManifest,
  backupRoot: string,
  options: MigrationApplyOptions,
  initialContract: MigrationContractJournal
): void {
  let writes = 0
  let contract = initialContract
  try {
    assertMigrationContractPreflight(contract)
    contract = transitionMigrationContract(backupRoot, contract, 'backup_verified')
    contract = transitionMigrationContract(backupRoot, contract, 'applying')
    assertAllTargetsStillMatchBackup(manifest)
    for (const [targetPath, bytes] of changes.files) {
      assertNoSymlinkWithin(requiredTargetRoot(changes, targetPath), targetPath)
      writeFileAtomic(targetPath, bytes)
      maybeFault(options, ++writes)
      contract = updateContractProgress(backupRoot, contract, writes, targetPath)
    }
    for (const [targetPath, snapshot] of changes.directories) {
      assertNoSymlinkWithin(requiredTargetRoot(changes, targetPath), targetPath)
      writeDirectoryAtomic(targetPath, snapshot)
      maybeFault(options, ++writes)
      contract = updateContractProgress(backupRoot, contract, writes, targetPath)
    }
    finalizeBackup(manifest, backupRoot)
    contract = transitionMigrationContract(backupRoot, contract, 'committed', {
      writesCompleted: writes,
      targets: manifest.targets.map((target) => ({
        path: target.targetPath,
        beforeFingerprint: target.beforeFingerprint,
        afterFingerprint: target.afterFingerprint
      }))
    })
  } catch (error) {
    const rollbackPending = contract.state === 'applying' || contract.state === 'backup_verified' || contract.state === 'prepared'
      ? transitionMigrationContract(backupRoot, contract, 'rollback_pending', { writesCompleted: writes })
      : contract
    try {
      if (writes > 0) restoreManifest(manifest, backupRoot, false)
      if (rollbackPending.state === 'rollback_pending') transitionMigrationContract(backupRoot, rollbackPending, 'rolled_back')
    } catch {
      // Keep rollback_pending durable when recovery itself cannot be completed.
    }
    throw error
  }
}

function updateContractProgress(
  root: string,
  contract: MigrationContractJournal,
  writes: number,
  targetPath: string
): MigrationContractJournal {
  // Progress updates are durable without adding a new state transition.
  return transitionMigrationContract(root, contract, 'applying', {
    writesCompleted: writes,
    targets: contract.targets.map((target) => target.path === targetPath
      ? { ...target, afterFingerprint: targetFingerprint(target.path) }
      : target)
  })
}

function reconcileBeforeApply(root: string): void {
  const pending = reconcileMigrationContracts(root)
  for (const item of pending) {
    const contract = readMigrationContract(root, item.migrationId)
    if (!item.recoverable) {
      const recoverableAppliedTargets = contract.targets.every((target) => {
        const current = targetFingerprint(target.path)
        return current === target.beforeFingerprint || current === target.afterFingerprint
      })
      if (!recoverableAppliedTargets) throw new Error('migration_recovery_required')
      const manifest = readBackupManifest(root, contract.backupId)
      const rollbackPending = contract.state === 'rollback_pending'
        ? contract
        : transitionMigrationContract(root, contract, 'rollback_pending')
      restoreManifest(manifest, root, false)
      transitionMigrationContract(root, rollbackPending, 'rolled_back')
      continue
    }
    const rollbackPending = contract.state === 'prepared' || contract.state === 'backup_verified' || contract.state === 'applying'
      ? transitionMigrationContract(root, contract, 'rollback_pending')
      : contract
    if (rollbackPending.state === 'rollback_pending') transitionMigrationContract(root, rollbackPending, 'rolled_back')
  }
}

function readExistingContract(root: string, backupId: string): MigrationContractJournal | undefined {
  try {
    return readMigrationContract(root, backupId)
  } catch {
    return undefined
  }
}

function preflightSelectedAssets(selected: Array<{ internal: InternalMigrationAsset; action: MigrationDecisionAction }>): void {
  const targets = new Map<string, string>()
  for (const { internal, action } of selected) {
    if (!internal.readSourceDigest) assertNoSymlinkWithin(internal.sourceRoot, internal.sourcePath)
    const sourceDigest = readCurrentSourceDigest(internal)
    if (sourceDigest !== internal.asset.sourceDigest) throw new Error('migration_source_changed')
    if (!internal.targetRoot || !internal.targetPath || internal.targetFingerprint === undefined) {
      throw new Error('migration_target_missing')
    }
    assertNoSymlinkWithin(internal.targetRoot, internal.targetPath)
    validateAction(internal.asset, action)
    const expected = targets.get(internal.targetPath)
    if (expected !== undefined && expected !== internal.targetFingerprint) throw new Error('migration_target_precondition_conflict')
    targets.set(internal.targetPath, internal.targetFingerprint)
  }
  for (const [targetPath, expected] of targets) {
    if (targetFingerprint(targetPath) !== expected) throw new Error('migration_target_changed')
  }
}

function readCurrentSourceDigest(internal: InternalMigrationAsset): string {
  if (internal.readSourceDigest) return internal.readSourceDigest()
  return internal.asset.kind === 'skill'
    ? readSkillSnapshot(internal.sourcePath).digest
    : readSafeFile(internal.sourcePath, MAX_SOURCE_FILE_BYTES).digest
}

function validateAction(asset: MigrationAsset, action: MigrationDecisionAction): void {
  if (action === 'replace' && asset.conflict !== 'replace_required') throw new Error('migration_replace_not_required')
  if (action === 'import' && asset.conflict === 'replace_required') {
    throw new Error('migration_replace_confirmation_required')
  }
}

function buildTargetChanges(selected: Array<{ internal: InternalMigrationAsset; action: MigrationDecisionAction }>): {
  files: Map<string, Buffer>
  directories: Map<string, SafeDirectorySnapshot>
  targetRoots: Map<string, string>
} {
  const files = new Map<string, Buffer>()
  const directories = new Map<string, SafeDirectorySnapshot>()
  const targetRoots = new Map<string, string>()
  for (const { internal, action } of selected) {
    const { asset, targetPath, targetRoot } = internal
    if (!targetPath || !targetRoot) throw new Error('migration_target_missing')
    targetRoots.set(targetPath, targetRoot)
    if (asset.kind === 'rules') addRuleChange(files, internal, action)
    else if (asset.kind === 'mcp') addMcpChange(files, internal, action)
    else if (asset.kind === 'usage' || asset.kind === 'memory' || asset.kind === 'channel') addVirtualFileChange(files, internal)
    else if (asset.kind === 'routine') addRoutineChange(files, internal, action)
    else if (asset.kind === 'skill' || asset.kind === 'prompt') addSkillChange(directories, internal)
    else throw new Error('migration_asset_not_importable')
  }
  return { files, directories, targetRoots }
}

function addVirtualFileChange(files: Map<string, Buffer>, internal: InternalMigrationAsset): void {
  if (!internal.targetPath || !internal.targetBytes) throw new Error('migration_virtual_file_invalid')
  const text = internal.targetBytes.toString('utf8')
  if (containsSensitiveText(text)) throw new Error('migration_source_contains_secret')
  files.set(internal.targetPath, internal.targetBytes)
}

function addRoutineChange(
  files: Map<string, Buffer>,
  internal: InternalMigrationAsset,
  action: MigrationDecisionAction
): void {
  if (!internal.targetPath || !internal.routineEntryId || !internal.routineEntry) {
    throw new Error('migration_routine_invalid')
  }
  const currentBytes = files.get(internal.targetPath)
  const current = currentBytes
    ? parseTargetJson(currentBytes.toString('utf8'))
    : readRoutineTargetJson(internal.targetPath)
  const routines = Array.isArray(current.routines) ? [...current.routines] : []
  const index = routines.findIndex((candidate) => isObject(candidate) && candidate.id === internal.routineEntryId)
  if (index >= 0 && action !== 'replace') throw new Error('migration_replace_confirmation_required')
  if (index >= 0) routines[index] = internal.routineEntry
  else routines.push(internal.routineEntry)
  const next = { ...current, version: 1, routines }
  const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8')
  if (containsSensitiveText(bytes.toString('utf8'))) throw new Error('migration_source_contains_secret')
  files.set(internal.targetPath, bytes)
}

function readRoutineTargetJson(targetPath: string): JsonObject {
  if (targetFingerprint(targetPath) === 'missing') return { version: 1, routines: [] }
  const parsed = JSON.parse(readSafeFile(targetPath, MAX_TARGET_FILE_BYTES).bytes.toString('utf8')) as unknown
  if (Array.isArray(parsed)) return { version: 1, routines: parsed }
  if (!isObject(parsed) || (parsed.routines !== undefined && !Array.isArray(parsed.routines))) {
    throw new Error('migration_target_routine_invalid')
  }
  return parsed
}

function assertBackupMatchesSelection(
  manifest: MigrationBackupManifest,
  selected: Array<{ internal: InternalMigrationAsset; action: MigrationDecisionAction }>
): void {
  const expected = new Map<string, string>()
  for (const { internal } of selected) {
    if (internal.targetPath && internal.targetFingerprint !== undefined) {
      expected.set(internal.targetPath, internal.targetFingerprint)
    }
  }
  for (const target of manifest.targets) {
    if (target.beforeFingerprint !== expected.get(target.targetPath)) throw new Error('migration_target_changed')
  }
}

function assertAllTargetsStillMatchBackup(manifest: MigrationBackupManifest): void {
  if (manifest.targets.some((target) => targetFingerprint(target.targetPath) !== target.beforeFingerprint)) {
    throw new Error('migration_target_changed')
  }
}

function addRuleChange(
  files: Map<string, Buffer>,
  internal: InternalMigrationAsset,
  action: MigrationDecisionAction
): void {
  const targetPath = internal.targetPath as string
  const source = readSafeFile(internal.sourcePath, MAX_SOURCE_FILE_BYTES)
  if (source.digest !== internal.asset.sourceDigest) throw new Error('migration_source_changed')
  const text = source.bytes.toString('utf8').trim()
  if (containsSensitiveText(text)) throw new Error('migration_source_contains_secret')
  const existing = files.get(targetPath)?.toString('utf8') ?? readTargetText(targetPath)
  files.set(targetPath, Buffer.from(upsertRuleBlock(existing, internal.asset, text, action), 'utf8'))
}

function addMcpChange(
  files: Map<string, Buffer>,
  internal: InternalMigrationAsset,
  action: MigrationDecisionAction
): void {
  if (!internal.targetPath || !internal.mcpServerName || !internal.mcpConfig) throw new Error('migration_mcp_invalid')
  const currentBytes = files.get(internal.targetPath)
  const current = currentBytes ? parseTargetJson(currentBytes.toString('utf8')) : readTargetJson(internal.targetPath)
  const servers = isObject(current.mcpServers) ? { ...current.mcpServers } : {}
  if (Object.hasOwn(servers, internal.mcpServerName) && action !== 'replace') {
    throw new Error('migration_replace_confirmation_required')
  }
  servers[internal.mcpServerName] = internal.mcpConfig
  files.set(internal.targetPath, Buffer.from(`${JSON.stringify({ ...current, mcpServers: servers }, null, 2)}\n`, 'utf8'))
}

function addSkillChange(directories: Map<string, SafeDirectorySnapshot>, internal: InternalMigrationAsset): void {
  if (!internal.targetPath) throw new Error('migration_target_missing')
  const snapshot = internal.sourceDirectorySnapshot ?? readSkillSnapshot(internal.sourcePath)
  if (!internal.sourceDirectorySnapshot && snapshot.digest !== internal.asset.sourceDigest) {
    throw new Error('migration_source_changed')
  }
  if (directoryContainsSensitiveText(snapshot)) throw new Error('migration_source_contains_secret')
  directories.set(internal.targetPath, snapshot)
}

function readSkillSnapshot(sourcePath: string): SafeDirectorySnapshot {
  return readSafeDirectory(sourcePath, { maxFiles: MAX_SKILL_FILES, maxBytes: MAX_SKILL_BYTES, maxDepth: 8 })
}

function upsertRuleBlock(existing: string, asset: MigrationAsset, body: string, action: MigrationDecisionAction): string {
  const begin = `${IMPORT_BEGIN} id:${asset.id} digest:${asset.sourceDigest} agent:${safeMarkerText(asset.agent)} -->`
  const end = `${IMPORT_END} id:${asset.id} -->`
  const block = `${begin}\n## 迁移导入:${asset.agent} · ${asset.name}\n\n${body}\n${end}`
  const pattern = new RegExp(
    `<!-- caogen:migration-begin id:${escapeRegExp(asset.id)} [\\s\\S]*?<!-- caogen:migration-end id:${escapeRegExp(asset.id)} -->`,
    'g'
  )
  if (pattern.test(existing)) {
    if (action !== 'replace') throw new Error('migration_replace_confirmation_required')
    return ensureTrailingNewline(existing.replace(pattern, block))
  }
    const prefix = existing.trim() ? ensureTrailingNewline(existing.trimEnd()) : '# 项目指引(EastGenesis 迁移导入)\n'
  return `${prefix}\n${block}\n`
}

function createBackup(
  targets: string[],
  backupRoot: string,
  reason: MigrationBackupManifest['reason'],
  requestedBackupId?: string
): MigrationBackupManifest {
  ensurePrivateDirectory(dirname(backupRoot))
  ensurePrivateDirectory(backupRoot)
  const backupId = requestedBackupId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
  if (!BACKUP_ID_PATTERN.test(backupId)) throw new Error('migration_backup_id_invalid')
  const backupDirectory = join(backupRoot, backupId)
  if (existsSync(backupDirectory)) throw new Error('migration_backup_exists')
  ensurePrivateDirectory(backupDirectory)
  const records = [...new Set(targets)].map((targetPath, index) => backupTarget(backupDirectory, targetPath, index))
  const manifest: MigrationBackupManifest = {
    version: 1,
    backupId,
    createdAt: new Date().toISOString(),
    reason,
    targets: records
  }
  writeBackupManifest(backupRoot, manifest)
  return manifest
}

function backupTarget(backupDirectory: string, targetPath: string, index: number): MigrationBackupTarget {
  const fingerprint = targetFingerprint(targetPath)
  const record: MigrationBackupTarget = {
    targetPath,
    existed: fingerprint !== 'missing',
    beforeFingerprint: fingerprint
  }
  if (fingerprint.startsWith('file:')) {
    const backupPath = join(backupDirectory, 'targets', `${index}.file`)
    writeFileAtomic(backupPath, readSafeFile(targetPath, MAX_TARGET_FILE_BYTES).bytes)
    return { ...record, kind: 'file', backupPath: relative(backupDirectory, backupPath) }
  }
  if (fingerprint.startsWith('dir:')) {
    const backupPath = join(backupDirectory, 'targets', `${index}.directory`)
    const source = readSafeDirectory(targetPath, {
      maxFiles: 2000,
      maxBytes: 32 * 1024 * 1024,
      maxDepth: 12,
      allowEmpty: true
    })
    writeDirectoryAtomic(backupPath, source)
    return { ...record, kind: 'directory', backupPath: relative(backupDirectory, backupPath) }
  }
  if (fingerprint !== 'missing') throw new Error('migration_target_not_regular')
  return record
}

function finalizeBackup(manifest: MigrationBackupManifest, backupRoot: string): void {
  for (const target of manifest.targets) target.afterFingerprint = targetFingerprint(target.targetPath)
  writeBackupManifest(backupRoot, manifest)
}

function restoreManifest(manifest: MigrationBackupManifest, backupRoot: string, verifyAfterFingerprint: boolean): void {
  const backupDirectory = join(resolve(backupRoot), manifest.backupId)
  for (const target of [...manifest.targets].reverse()) {
    if (verifyAfterFingerprint && target.afterFingerprint && targetFingerprint(target.targetPath) !== target.afterFingerprint) {
      throw new Error('migration_target_changed_after_import')
    }
    if (!target.existed) {
      if (targetFingerprint(target.targetPath) !== 'missing') removeExactTarget(target.targetPath)
      continue
    }
    restoreBackupTarget(target, backupDirectory)
  }
}

function restoreBackupTarget(target: MigrationBackupTarget, backupDirectory: string): void {
  if (!target.backupPath || !target.kind) throw new Error('migration_backup_incomplete')
  const sourcePath = resolve(backupDirectory, target.backupPath)
  if (!isInside(backupDirectory, sourcePath)) throw new Error('migration_backup_path_escape')
  if (target.kind === 'file') {
    writeFileAtomic(target.targetPath, readSafeFile(sourcePath, MAX_TARGET_FILE_BYTES).bytes)
  } else {
    const snapshot = readSafeDirectory(sourcePath, {
      maxFiles: 2000,
      maxBytes: 32 * 1024 * 1024,
      maxDepth: 12,
      allowEmpty: true
    })
    writeDirectoryAtomic(target.targetPath, snapshot)
  }
}

function readBackupManifest(backupRoot: string, backupId: string): MigrationBackupManifest {
  const backupDirectory = join(backupRoot, backupId)
  if (!isInside(backupRoot, backupDirectory)) throw new Error('migration_backup_path_escape')
  const parsed = JSON.parse(readSafeFile(join(backupDirectory, 'manifest.json'), MAX_TARGET_FILE_BYTES).bytes.toString('utf8')) as unknown
  if (!isObject(parsed) || parsed.version !== 1 || parsed.backupId !== backupId || !Array.isArray(parsed.targets)) {
    throw new Error('migration_backup_invalid')
  }
  return parsed as unknown as MigrationBackupManifest
}

function writeBackupManifest(backupRoot: string, manifest: MigrationBackupManifest): void {
  const backupDirectory = join(resolve(backupRoot), manifest.backupId)
  if (!isInside(backupRoot, backupDirectory)) throw new Error('migration_backup_path_escape')
  writeFileAtomic(join(backupDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function readTargetText(targetPath: string): string {
  return targetFingerprint(targetPath) === 'missing' ? '' : readSafeFile(targetPath, MAX_TARGET_FILE_BYTES).bytes.toString('utf8')
}

function readTargetJson(targetPath: string): JsonObject {
  return targetFingerprint(targetPath) === 'missing'
    ? {}
    : parseTargetJson(readSafeFile(targetPath, MAX_TARGET_FILE_BYTES).bytes.toString('utf8'))
}

function parseTargetJson(text: string): JsonObject {
  const parsed = JSON.parse(text) as unknown
  if (!isObject(parsed)) throw new Error('migration_target_json_invalid')
  return parsed
}

function normalizeDecisions(value: unknown): Array<{ assetId: string; action: MigrationDecisionAction }> {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.map((item) => {
    if (!isObject(item) || typeof item.assetId !== 'string') throw new Error('migration_decision_invalid')
    if (item.action !== 'import' && item.action !== 'replace' && item.action !== 'skip') throw new Error('migration_decision_invalid')
    if (seen.has(item.assetId)) throw new Error('migration_decision_duplicate')
    seen.add(item.assetId)
    return { assetId: item.assetId, action: item.action }
  })
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw new Error('migration_backup_directory_not_private')
  }
}

function requiredTargetRoot(changes: ReturnType<typeof buildTargetChanges>, targetPath: string): string {
  const root = changes.targetRoots.get(targetPath)
  if (!root) throw new Error('migration_target_missing')
  return root
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInside(rootPath: string, targetPath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(targetPath))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function itemResult(asset: MigrationAsset, status: MigrationApplyItemResult['status'], detail?: string): MigrationApplyItemResult {
  return { assetId: asset.id, name: asset.name, status, ...(asset.targetPath ? { targetPath: asset.targetPath } : {}), ...(detail ? { detail } : {}) }
}

function failedApply(code: string, message: string, skipped: MigrationApplyItemResult[] = []): MigrationApplyResult {
  return { ok: false, status: 'failed', applied: [], skipped, errorCode: code, message }
}

function failedRollback(backupId: string, code: string): MigrationRollbackResult {
  return { ok: false, status: 'failed', backupId, restoredTargets: [], errorCode: code, message: '回滚未执行;目标或备份状态已变化。' }
}

function publicMigrationError(error: unknown): string {
  if (error instanceof Error && /^migration_[a-z0-9_]+$/.test(error.message)) return error.message
  const code = errorCode(error)
  if (code === 'ENOENT') return 'migration_path_missing'
  if (code === 'EACCES' || code === 'EPERM') return 'migration_path_unreadable'
  return 'migration_operation_failed'
}

function safeMarkerText(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'external'
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function maybeFault(options: MigrationApplyOptions, writes: number): void {
  if (options.faultAfterWrites === writes) throw new Error('migration_test_fault')
}
