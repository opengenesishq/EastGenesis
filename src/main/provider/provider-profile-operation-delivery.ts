import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { EffectRecord } from '../../shared/types'
import { registerCanonicalProducedArtifact } from '../task/artifact-production-boundary'
import { executeInteractiveOperationEffect } from '../task/operation-effect-gateway'
import { TaskKernel } from '../task/task-kernel'
import type { CanonicalSystemOperationContext } from '../task/system-operation-context'
import { stableValueDigest } from '../task/tool-idempotency'
import { redactSensitiveText } from '../security/secret-redaction'
import type { ProviderProfileOperationTarget } from './provider-profile-operation-target'

export interface ProviderProfileOperationDeliverySpec<T> {
  operation: ProviderProfileOperationTarget['operation']
  transport: ProviderProfileOperationTarget['transport']
  title: string
  objective: string
  backupId?: string
  preflight?: () => void | Promise<void>
  execute: () => T | Promise<T>
}

export async function executeProviderProfileOperationDelivery<T>(
  spec: ProviderProfileOperationDeliverySpec<T>
): Promise<T> {
  await spec.preflight?.()
  const rootDir = app.getPath('userData')
  const kernel = new TaskKernel(rootDir)
  const operationId = randomUUID()
  const createdContext = await kernel.create({
    rootDir,
    requestId: `provider-profile-${spec.operation}-${operationId}`,
    objective: spec.objective,
    deferExecution: true
  })
  const context = await kernel.plan(createdContext)
  const target = operationTarget(context, spec, operationId)
  let providerMutationCompleted = false
  const outcome = await kernel.execute(context, () => executeInteractiveOperationEffect({
      rootDir,
      operationId,
      kind: 'provider_operation',
      title: spec.title,
      sourceSessionId: `provider-profile:${spec.transport}`,
      projectId: context.projectId,
      workspaceId: context.workspaceId,
      goalId: context.goalId,
      workItemId: context.workItemId,
      cwd: context.cwd,
      toolName: 'provider_profile_operation',
      toolInput: target,
      failureDisposition: () => providerMutationCompleted
        ? 'waiting_reconciliation'
        : providerProfileFailureDisposition(spec),
      execute: async (effect) => {
        const value = await spec.execute()
        providerMutationCompleted = true
        await registerProviderProfileOperationReport(effect, value, rootDir)
        return value
      },
      isSuccess: () => true,
      resultSummary: (value) => JSON.stringify(providerProfileOperationSummary(value))
    }))
  if (outcome.status === 'waiting_reconciliation') {
    const reason = redactSensitiveText(outcome.error).slice(0, 1_000)
    throw new Error(`Provider Profile operation is waiting for reconciliation:${outcome.snapshotId}:${reason}`)
  }
  if (outcome.status === 'failed') {
    // A confirmed failure has a real, sanitized report and failed Acceptance.
    // Unknown outcomes stay above in waiting_reconciliation: they must not be
    // converted into a false failure while an external side effect is still
    // ambiguous.
    await registerProviderProfileOperationReport(
      { id: outcome.effectId ?? `${operationId}:effect`, target },
      outcome.value,
      rootDir,
      'failed',
      outcome.error
    )
    await kernel.deliver(context, {
      status: 'failed',
      evidenceRefs: [target.evidenceId],
      verifiedBy: 'provider-profile-operation'
    })
    throw new Error(redactSensitiveText(outcome.error).slice(0, 1_000))
  }
  if (outcome.value === undefined) throw new Error('Provider Profile operation completed without a result')
  await kernel.deliver(context, {
    evidenceRefs: [target.evidenceId],
    verifiedBy: 'provider-profile-operation'
  })
  return outcome.value as T
}

function providerProfileFailureDisposition(
  spec: Pick<ProviderProfileOperationDeliverySpec<unknown>, 'operation' | 'transport'>
): 'failed' | 'waiting_reconciliation' {
  // These local store operations have an atomic local commit boundary. Remote
  // sync/publish/apply operations may have a partial external effect and must
  // remain queryable until reconciled.
  return spec.transport === 'local' &&
    (spec.operation === 'profile_import' || spec.operation === 'backup_restore' || spec.operation === 'backup_delete')
    ? 'failed'
    : 'waiting_reconciliation'
}

async function registerProviderProfileOperationReport<T>(
  effect: Pick<EffectRecord, 'id' | 'target'>,
  value: T,
  rootDir: string,
  outcome: 'completed' | 'failed' = 'completed',
  error?: string
): Promise<void> {
  if (effect.target.kind !== 'provider_profile_operation') {
    throw new Error('Provider Profile delivery requires a provider_profile_operation EffectTarget')
  }
  const target = effect.target
  const report = {
    schemaVersion: 1,
    format: 'caogen.provider-profile-operation-report.v1',
    operation: target.operation,
    transport: target.transport,
    outcome,
    ...(outcome === 'completed'
      ? { result: providerProfileOperationSummary(value) }
      : { error: redactSensitiveText(error ?? 'Provider Profile operation failed').slice(0, 1_000) })
  }
  await registerCanonicalProducedArtifact({
    lifecycle: {
      id: target.artifactId,
      projectId: target.projectId,
      goalId: target.goalId,
      workItemId: target.workItemId,
      runId: target.runId,
      lineageId: `lineage:provider-profile-operation:${effect.id}`,
      kind: 'report',
      title: 'Provider Profile operation report',
      version: 1,
      provenance: 'explicit',
      mediaType: 'application/json',
      retention: { mode: 'retain' },
      content: { storageKind: 'blob', bytes: Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8') },
      metadata: {
        producer: 'provider-profile-operation',
        operation: target.operation,
        transport: target.transport,
        effectId: effect.id
      }
    },
    evidence: {
      id: target.evidenceId,
      kind: 'delivery_check',
      title: 'Provider Profile operation result',
      summary: outcome === 'completed'
        ? 'The sanitized Provider Profile operation report was committed to the personal Workspace.'
        : 'The Provider Profile operation failed and its bounded failure report was committed to the personal Workspace.',
      verifier: 'provider-profile-operation',
      metadata: {
        effectId: effect.id,
        operation: target.operation,
        transport: target.transport,
        reportDigest: stableValueDigest(report)
      }
    },
    acceptance: {
      id: target.acceptanceId,
      criterionId: `${target.acceptanceId}:criterion:sanitized-report`,
      criterion: outcome === 'completed'
        ? 'The Provider Profile operation completed and its report contains only bounded counts, statuses and digests.'
        : 'The Provider Profile operation failed and its report contains only a bounded redacted error summary.',
      status: outcome === 'completed' ? 'passed' : 'failed',
      verifier: 'provider-profile-operation',
      authorizesWorkflowStage: outcome === 'completed'
    },
    attachToStage: outcome === 'completed'
  }, rootDir)
}

function operationTarget<T>(
  context: CanonicalSystemOperationContext,
  spec: ProviderProfileOperationDeliverySpec<T>,
  operationId: string
): ProviderProfileOperationTarget {
  const backupId = spec.backupId?.trim()
  if (spec.operation === 'backup_delete' && !backupId) {
    throw new Error('Provider Profile backup delete requires a backup id')
  }
  return {
    kind: 'provider_profile_operation',
    operation: spec.operation,
    transport: spec.transport,
    projectId: context.projectId,
    goalId: context.goalId,
    workItemId: context.workItemId,
    runId: `operation:${operationId}`,
    artifactId: `artifact:provider-profile-operation:${operationId}`,
    evidenceId: `evidence:provider-profile-operation:${operationId}`,
    acceptanceId: `acceptance:provider-profile-operation:${operationId}`,
    ...(backupId ? { backupIdDigest: stableValueDigest(backupId) } : {})
  }
}

function providerProfileOperationSummary(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { resultKind: value === null ? 'null' : typeof value }
  const status = isRecord(value.status) ? value.status : undefined
  const backup = isRecord(value.backup) ? value.backup : undefined
  const providers = Array.isArray(value.providers) ? value.providers : undefined
  return compactRecord({
    providerCount: safeCount(value.providerCount) ?? providers?.length ?? safeCount(status?.localProviderCount),
    created: safeCount(value.created),
    updated: safeCount(value.updated),
    skipped: safeCount(value.skipped),
    restoredBackupDigest: safeDigest(value.restoredBackupId),
    deletedBackupDigest: safeDigest(value.deletedBackupId),
    operationDigest: safeDigest(value.operationId),
    revisionDigest: safeDigest(value.revisionId),
    backup: backup ? compactRecord({
      idDigest: safeDigest(backup.id),
      providerCount: safeCount(backup.providerCount),
      reason: safeBackupReason(backup.reason),
      nonPersistentCredentialCount: safeCount(backup.nonPersistentCredentialCount),
      excludedCredentialCount: safeCount(backup.excludedCredentialCount)
    }) : undefined,
    sync: status ? compactRecord({
      configured: typeof status.configured === 'boolean' ? status.configured : undefined,
      relation: safeRelation(status.relation),
      localProviderCount: safeCount(status.localProviderCount),
      remoteProviderCount: safeCount(status.remoteProviderCount)
    }) : undefined
  })
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function safeCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function safeDigest(value: unknown): string | undefined {
  return typeof value === 'string' && value ? stableValueDigest(value) : undefined
}

function safeBackupReason(value: unknown): string | undefined {
  return ['import', 'manual', 'provider-create', 'provider-update', 'provider-delete'].includes(String(value))
    ? String(value)
    : undefined
}

function safeRelation(value: unknown): string | undefined {
  return ['unconfigured', 'remote_missing', 'in_sync', 'local_ahead', 'remote_ahead', 'diverged'].includes(String(value))
    ? String(value)
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
