import type { EffectRecord, TaskRunRecord } from '../../shared/types'
import type { WorkflowProjectionSource, WorkflowRunRecord } from '../../shared/workflow-types'
import type { ArtifactLifecycleRecord } from './artifact-lifecycle-types'
import { registerCanonicalProducedArtifact } from './artifact-production-boundary'
import { stableValueDigest } from './tool-idempotency'
import { TaskKernel } from './task-kernel'

type ConfirmedMigrationOperationEffect = EffectRecord & {
  status: 'confirmed'
  target: Extract<EffectRecord['target'], { kind: 'migration_operation' }>
}

export function isConfirmedMigrationOperationEffect(
  effect: EffectRecord
): effect is ConfirmedMigrationOperationEffect {
  return effect.status === 'confirmed' && effect.target.kind === 'migration_operation'
}

export async function registerMigrationOperationArtifact(
  run: TaskRunRecord,
  effect: ConfirmedMigrationOperationEffect,
  workflowRun: WorkflowRunRecord & { projectId: string },
  provenance: WorkflowProjectionSource,
  rootDir?: string
): Promise<ArtifactLifecycleRecord> {
  const report = migrationReport(effect)
  const artifactId = `artifact:migration-report:${effect.id}`
  const evidenceId = `evidence:migration-report:${effect.id}`
  const registered = await registerCanonicalProducedArtifact({
    lifecycle: {
      id: artifactId,
      projectId: workflowRun.projectId,
      goalId: workflowRun.goalId,
      workItemId: workflowRun.workItemId,
      runId: workflowRun.id,
      lineageId: `lineage:migration:${effect.target.operation}:${effect.target.backupId}`,
      kind: 'report',
      title: effect.target.operation === 'apply' ? 'Migration apply report' : 'Migration rollback report',
      version: 1,
      provenance,
      mediaType: 'application/json',
      retention: { mode: 'retain' },
      content: {
        storageKind: 'blob',
        bytes: Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
      },
      metadata: {
        producer: 'migration-contract-reconciler',
        operation: effect.target.operation,
        backupId: effect.target.backupId,
        assetCount: effect.target.assetCount,
        selectionDigest: effect.target.selectionDigest,
        effectId: effect.id
      },
      createdAt: effect.terminalAt ?? effect.updatedAt
    },
    evidence: {
      id: evidenceId,
      kind: 'delivery_check',
      title: 'Migration contract terminal state',
      summary: `The migration ${effect.target.operation} contract reached ${effect.target.expectedState} and matches the frozen EffectTarget.`,
      verifier: 'migration-contract-reconciler',
      metadata: {
        effectId: effect.id,
        operation: effect.target.operation,
        expectedState: effect.target.expectedState,
        reportDigest: stableValueDigest(report)
      }
    },
    acceptance: {
      id: `acceptance:migration-report:${effect.id}`,
      criterionId: `criterion:migration-report:${effect.id}:terminal-contract`,
      criterion: 'The migration contract reached its intended terminal state and the report contains no source content or credentials.',
      status: 'passed',
      verifier: 'migration-contract-reconciler',
      authorizesWorkflowStage: true
    },
    attachToStage: true
  }, rootDir)
  if (workflowRun.goalId) {
    await new TaskKernel(rootDir).deliver({
      rootDir,
      goalId: workflowRun.goalId,
      workItemId: workflowRun.workItemId
    }, {
      status: 'passed',
      evidenceRefs: [registered.evidenceId],
      verifiedBy: 'migration-contract-reconciler'
    })
  }
  return registered.lifecycle
}

function migrationReport(effect: ConfirmedMigrationOperationEffect): Record<string, unknown> {
  return {
    schemaVersion: 1,
    format: 'caogen.migration-report.v1',
    operation: effect.target.operation,
    terminalState: effect.target.expectedState,
    backupId: effect.target.backupId,
    assetCount: effect.target.assetCount,
    kindCounts: effect.target.kindCounts,
    selectionDigest: effect.target.selectionDigest,
    effectId: effect.id,
    effectEvidenceDigest: stableValueDigest(effect.evidence),
    observedAt: effect.terminalAt ?? effect.updatedAt
  }
}
