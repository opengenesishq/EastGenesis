import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  EffectRecord,
  MigrationApplyInput,
  MigrationApplyResult,
  MigrationAsset,
  MigrationAssetKind,
  MigrationImportOperationResult,
  MigrationRollbackResult
} from '../shared/types'
import { applyMigration, importAssets, rollbackMigration, scanMigration } from './migration'
import type { MigrationApplyOptions } from './migration'
import {
  executeInteractiveOperationEffect,
  type InteractiveOperationEffectOutcome
} from './task/operation-effect-gateway'
import { stableValueDigest } from './task/tool-idempotency'
import { readStoredMigrationScan } from './migration-scan-store'
import {
  prepareCanonicalSystemOperation,
  resolveCanonicalWorkspaceIdForPath
} from './task/system-operation-context'
import { TaskKernel } from './task/task-kernel'
import {
  configureMigrationOperationBackupRoot,
  MIGRATION_OPERATION_BACKUP_REF
} from './migration-operation-effect'

type OperationGateway = typeof executeInteractiveOperationEffect
type MigrationImporter = typeof importAssets
type MigrationApplier = typeof applyMigration
type MigrationRollback = typeof rollbackMigration

export interface MigrationOperationEffectOptions {
  rootDir: string
  backupRoot: string
}

export async function executeMigrationApplyEffect(
  input: MigrationApplyInput,
  options: MigrationOperationEffectOptions,
  runOperation: OperationGateway = executeInteractiveOperationEffect,
  runApply: MigrationApplier = applyMigration
): Promise<MigrationApplyResult> {
  const stored = readStoredMigrationScan(input?.scanId)
  const selection = stored ? selectedMigrationDecisionSummary(stored.result.assets, input?.decisions) : undefined
  if (!stored || !selection || selection.assetCount === 0) {
    return runApply(input, { backupRoot: options.backupRoot })
  }
  const operationId = randomUUID()
  const backupId = `migration-${operationId}`
  configureMigrationOperationBackupRoot(options.backupRoot)
  const workspaceId = stored.result.cwd
    ? await resolveCanonicalWorkspaceIdForPath(options.rootDir, stored.result.cwd)
    : undefined
  const kernel = new TaskKernel(options.rootDir)
  const context = await kernel.plan(await kernel.create({
    rootDir: options.rootDir,
    requestId: `migration-apply-${operationId}`,
    objective: `导入 ${selection.assetCount} 项外部 Agent 资产并生成可核验迁移报告`,
    workspaceId,
    cwd: stored.result.cwd,
    deferExecution: true
  }))
  const toolInput = {
    backupRef: MIGRATION_OPERATION_BACKUP_REF,
    backupId,
    assetCount: selection.assetCount,
    kindCounts: selection.kindCounts,
    selectionDigest: selection.selectionDigest
  }
  let outcome: InteractiveOperationEffectOutcome<MigrationApplyResult>
  try {
    outcome = await kernel.execute(context, () => runOperation({
      rootDir: options.rootDir,
      operationId,
      kind: 'migration_apply',
      title: '应用外部 Agent 迁移',
      sourceSessionId: `migration:${operationId}`,
      projectId: context.projectId,
      workspaceId: context.workspaceId,
      goalId: context.goalId,
      workItemId: context.workItemId,
      cwd: context.cwd,
      toolName: 'migration_apply',
      toolInput,
      execute: (effect) => executeMigrationApply(effect, input, options.backupRoot, backupId, runApply),
      isSuccess: (result) => result.ok,
      resultSummary: (result) => JSON.stringify({
        ok: result.ok,
        status: result.status,
        backupId: result.backupId,
        appliedCount: result.applied.length,
        skippedCount: result.skipped.length
      })
    }))
  } catch (error) {
    // If the Effect gateway fails before it can return an outcome, the
    // canonical operation must not remain runnable without an execution.
    await kernel.stop(context, async () => undefined)
    throw error
  }
  if (outcome.status === 'completed' && outcome.value) {
    if (!outcome.value.ok) {
      // A queryable Effect may be compensated after the migration callback
      // reports a deterministic failure. The public result stays the same;
      // the canonical operation is cancelled because no passed Evidence was
      // produced for this non-applied outcome.
      await kernel.stop(context, async () => undefined)
      return outcome.value
    }
    // The migration Artifact producer normally settles this same canonical
    // operation while the Effect is persisted. Calling deliver again keeps
    // the TaskKernel boundary explicit and is idempotent for that path.
    await kernel.deliver(context, {
      evidenceRefs: [outcome.effectId
        ? `evidence:migration-report:${outcome.effectId}`
        : `evidence:migration-operation:${operationId}`],
      verifiedBy: 'migration-operation'
    })
    return outcome.value
  }
  if (outcome.status === 'failed') {
    // A failed outcome means the gateway has a deterministic terminal failure
    // (as opposed to queryable migration uncertainty). Preserve the public
    // result while cancelling the canonical Goal/WorkItem without inventing
    // Evidence that does not exist.
    await kernel.stop(context, async () => undefined)
  }
  return failedMigrationApply(outcome.status === 'waiting_reconciliation'
    ? 'migration_reconciliation_required'
    : 'migration_operation_failed')
}

export async function executeMigrationRollbackEffect(
  backupId: string,
  options: MigrationOperationEffectOptions,
  runOperation: OperationGateway = executeInteractiveOperationEffect,
  runRollback: MigrationRollback = rollbackMigration
): Promise<MigrationRollbackResult> {
  const operationId = randomUUID()
  configureMigrationOperationBackupRoot(options.backupRoot)
  const context = await prepareCanonicalSystemOperation({
    rootDir: options.rootDir,
    requestId: `migration-rollback-${operationId}`,
    objective: '回滚外部 Agent 迁移并生成可核验迁移报告'
  })
  const kindCounts = emptyMigrationKindCounts()
  const toolInput = {
    backupRef: MIGRATION_OPERATION_BACKUP_REF,
    backupId,
    assetCount: 0,
    kindCounts,
    selectionDigest: stableValueDigest({ operation: 'rollback', backupId })
  }
  const outcome = await runOperation({
    rootDir: options.rootDir,
    operationId,
    kind: 'migration_rollback',
    title: '回滚外部 Agent 迁移',
    sourceSessionId: `migration:${operationId}`,
    projectId: context.projectId,
    workspaceId: context.workspaceId,
    goalId: context.goalId,
    workItemId: context.workItemId,
    cwd: context.cwd,
    toolName: 'migration_rollback',
    toolInput,
    execute: (effect) => executeMigrationRollback(effect, backupId, options.backupRoot, runRollback),
    isSuccess: (result) => result.ok,
    resultSummary: (result) => JSON.stringify({
      ok: result.ok,
      status: result.status,
      backupId: result.backupId,
      restoredTargetCount: result.restoredTargets.length
    })
  })
  if (outcome.value) return outcome.value
  return {
    ok: false,
    status: 'failed',
    backupId,
    restoredTargets: [],
    errorCode: outcome.status === 'waiting_reconciliation'
      ? 'migration_reconciliation_required'
      : 'migration_operation_failed',
    message: '回滚结果未能确认，请从恢复中心完成对账。'
  }
}

export async function executeMigrationImportEffect(
  cwd: unknown,
  paths: unknown,
  runOperation: OperationGateway = executeInteractiveOperationEffect,
  runImport: MigrationImporter = importAssets
): Promise<MigrationImportOperationResult> {
  const root = migrationRoot(cwd)
  const selected = selectedMigrationAssets(root, paths)
  if (selected.length === 0) return { ok: true, summary: '未选择任何资产' }

  const kindCounts = migrationKindCounts(selected)
  const outcome = await runOperation({
    kind: 'migration_import',
    title: '导入外部 Agent 资产',
    sourceSessionId: migrationSourceId(root),
    cwd: root,
    toolName: 'migration_import',
    toolInput: {
      assetCount: selected.length,
      kindCounts,
      selectionDigest: stableValueDigest(selected.map(safeAssetIdentity))
    },
    execute: (effect) => executeOpaqueMigration(effect, root, selected, runImport),
    isSuccess: () => true,
    resultSummary: () => JSON.stringify({ assetCount: selected.length, kindCounts })
  })
  return migrationEffectOutcome(outcome)
}

function migrationRoot(cwd: unknown): string {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('必须指定项目目录')
  const root = resolve(cwd)
  if (!statSync(root).isDirectory()) throw new Error('迁移目标必须是项目目录')
  return root
}

function selectedMigrationAssets(root: string, paths: unknown): MigrationAsset[] {
  if (!Array.isArray(paths)) return []
  const requested = new Set(paths.filter((item): item is string => typeof item === 'string'))
  return scanMigration(root).assets.filter((asset) => requested.has(asset.path))
}

function safeAssetIdentity(asset: MigrationAsset): Record<string, string> {
  return {
    agent: asset.agent,
    kind: asset.kind,
    pathDigest: stableValueDigest(asset.path)
  }
}

function migrationKindCounts(assets: MigrationAsset[]): Record<MigrationAsset['kind'], number> {
  const counts: Record<MigrationAsset['kind'], number> = {
    rules: 0,
    mcp: 0,
    config: 0,
    skill: 0,
    prompt: 0,
    usage: 0,
    hook: 0,
    memory: 0,
    routine: 0,
    channel: 0
  }
  for (const asset of assets) counts[asset.kind] += 1
  return counts
}

function executeOpaqueMigration(
  effect: EffectRecord,
  root: string,
  selected: MigrationAsset[],
  runImport: MigrationImporter
): string {
  assertOpaqueMigrationEffect(effect)
  try {
    return runImport(root, selected.map((asset) => asset.path))
  } catch {
    throw new Error('迁移导入执行失败')
  }
}

function assertOpaqueMigrationEffect(effect: EffectRecord): void {
  if (effect.target.kind !== 'unsupported' || effect.target.toolName !== 'migration_import') {
    throw new Error('迁移导入必须保持 opaque 并与工具名绑定')
  }
}

function migrationEffectOutcome(
  outcome: InteractiveOperationEffectOutcome<string>
): MigrationImportOperationResult {
  if (outcome.status === 'completed' && outcome.value !== undefined) {
    return {
      ok: true,
      summary: outcome.value,
      effectStatus: outcome.effectStatus,
      operationId: outcome.operationId
    }
  }
  if (outcome.status === 'waiting_reconciliation') {
    return {
      ok: false,
      error: '迁移导入结果未知，请在恢复面板完成对账',
      effectStatus: outcome.effectStatus,
      operationId: outcome.operationId,
      snapshotId: outcome.snapshotId
    }
  }
  return {
    ok: false,
    error: outcome.status === 'failed' ? outcome.error : '迁移导入效果已确认，但执行结果缺失',
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function migrationSourceId(root: string): string {
  return `migration:${createHash('sha256').update(root).digest('hex').slice(0, 40)}`
}

function selectedMigrationDecisionSummary(
  assets: MigrationAsset[],
  decisions: MigrationApplyInput['decisions']
): { assetCount: number; kindCounts: Record<MigrationAssetKind, number>; selectionDigest: string } | undefined {
  if (!Array.isArray(decisions)) return undefined
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  const selected: Array<{ id: string; kind: MigrationAssetKind; action: 'import' | 'replace'; sourceDigest: string }> = []
  const seen = new Set<string>()
  for (const decision of decisions) {
    if (!decision || typeof decision.assetId !== 'string' || seen.has(decision.assetId) ||
        (decision.action !== 'import' && decision.action !== 'replace' && decision.action !== 'skip')) return undefined
    seen.add(decision.assetId)
    if (decision.action === 'skip') continue
    const asset = byId.get(decision.assetId)
    if (!asset) return undefined
    selected.push({ id: asset.id, kind: asset.kind, action: decision.action, sourceDigest: asset.sourceDigest })
  }
  const kindCounts = emptyMigrationKindCounts()
  for (const item of selected) kindCounts[item.kind] += 1
  return {
    assetCount: selected.length,
    kindCounts,
    selectionDigest: stableValueDigest(selected.sort((left, right) => left.id.localeCompare(right.id)))
  }
}

function emptyMigrationKindCounts(): Record<MigrationAssetKind, number> {
  return {
    rules: 0,
    mcp: 0,
    config: 0,
    skill: 0,
    prompt: 0,
    usage: 0,
    hook: 0,
    memory: 0,
    routine: 0,
    channel: 0
  }
}

function executeMigrationApply(
  effect: EffectRecord,
  input: MigrationApplyInput,
  backupRoot: string,
  backupId: string,
  runApply: MigrationApplier
): MigrationApplyResult {
  assertMigrationOperationEffect(effect, 'apply', backupId)
  const options: MigrationApplyOptions = { backupRoot, backupId }
  return runApply(input, options)
}

function executeMigrationRollback(
  effect: EffectRecord,
  backupId: string,
  backupRoot: string,
  runRollback: MigrationRollback
): MigrationRollbackResult {
  assertMigrationOperationEffect(effect, 'rollback', backupId)
  return runRollback(backupId, backupRoot)
}

function assertMigrationOperationEffect(
  effect: EffectRecord,
  operation: 'apply' | 'rollback',
  backupId: string
): void {
  if (effect.target.kind !== 'migration_operation' || effect.target.operation !== operation ||
      effect.target.backupId !== backupId) {
    throw new Error(`migration ${operation} EffectTarget identity mismatch`)
  }
}

function failedMigrationApply(errorCode: string): MigrationApplyResult {
  return {
    ok: false,
    status: 'failed',
    applied: [],
    skipped: [],
    errorCode,
    message: '迁移结果未能确认，请从恢复中心完成对账。'
  }
}
