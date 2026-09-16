import { randomUUID } from 'node:crypto'
import type { EffectRecord } from '../shared/types'
import type {
  ProjectAggregateDeliveryExportResult,
  ProjectAggregateExportResult
} from '../shared/project-aggregate-types'
import { createProductionProjectAggregateService } from './project-aggregate/project-aggregate-factory'
import { getLatestPersistedArtifactLifecycleByLineage } from './task/artifact-lifecycle-api'
import { registerCanonicalProducedArtifact } from './task/artifact-production-boundary'
import {
  executeInteractiveOperationEffect,
  type InteractiveOperationEffectOutcome
} from './task/operation-effect-gateway'
import type { CanonicalSystemOperationContext } from './task/system-operation-context'
import { TaskKernel } from './task/task-kernel'
import { stableValueDigest } from './task/tool-idempotency'
import type { ProjectPortableExportEffectTarget } from './project-export-effect-target'
import { prepareProjectMemoryRetentionExport } from './memory/memory-retention'

type OperationGateway = typeof executeInteractiveOperationEffect

export async function executeProjectPortableExportEffect(
  projectId: string,
  rootDir: string,
  runOperation: OperationGateway = executeInteractiveOperationEffect
): Promise<ProjectAggregateDeliveryExportResult> {
  const operationId = randomUUID()
  const kernel = new TaskKernel(rootDir)
  const context = await kernel.plan(await kernel.create({
    rootDir,
    requestId: `project-export-${operationId}`,
    objective: '生成完整、脱敏、可验证且可重新导入的 Project 可移植包',
    workspaceId: projectId,
    deferExecution: true
  }))
  const runId = `operation:${operationId}`
  const target = exportTarget(context, operationId, runId)
  const outcome = await kernel.execute(context, () => runOperation({
    rootDir,
    operationId,
    kind: 'project_export',
    title: '导出 Project 可移植包',
    sourceSessionId: `project-export:${operationId}`,
    projectId: context.projectId,
    workspaceId: context.workspaceId,
    goalId: context.goalId,
    workItemId: context.workItemId,
    cwd: context.cwd,
    toolName: 'project_portable_export',
    toolInput: target,
    execute: (effect) => produceProjectPortableExport(effect, rootDir),
    isSuccess: () => true,
    resultSummary: (result) => JSON.stringify({
      projectId: result.bundle.projectId,
      aggregateRevision: result.bundle.aggregateRevision,
      exportDigest: result.exportDigest,
      workflowArtifactId: result.workflowArtifactId
    })
  }))
  const result = requireCompletedExport(outcome)
  await kernel.deliver(context, {
    status: 'passed',
    evidenceRefs: [result.workflowEvidenceId],
    verifiedBy: 'project-portable-export'
  })
  return result
}

async function produceProjectPortableExport(
  effect: EffectRecord,
  rootDir: string
): Promise<ProjectAggregateDeliveryExportResult> {
  if (effect.target.kind !== 'project_portable_export') {
    throw new Error('Project export requires a project_portable_export EffectTarget')
  }
  const target = effect.target
  await prepareProjectMemoryRetentionExport(rootDir, target.projectId)
  const service = createProductionProjectAggregateService(rootDir)
  const currentSeal = service.seals.readProject(target.projectId)
  const seal = await service.sealProject(target.projectId, {
    expectedAggregateRevision: currentSeal?.aggregateRevision ?? 0
  })
  const exported = await service.exportProject(target.projectId, {
    expectedAggregateRevision: seal.aggregateRevision,
    expectedAggregateDigest: seal.aggregateDigest
  })
  const lineageId = `lineage:project-portable-export:${target.projectId}`
  const prior = await getLatestPersistedArtifactLifecycleByLineage({
    projectId: target.projectId,
    lineageId,
    kind: 'custom'
  }, rootDir)
  const registered = await registerCanonicalProducedArtifact({
    lifecycle: {
      id: target.artifactId,
      projectId: target.projectId,
      goalId: target.goalId,
      workItemId: target.workItemId,
      runId: target.runId,
      lineageId,
      kind: 'custom',
      title: 'Project portable export',
      version: (prior?.version ?? 0) + 1,
      provenance: 'explicit',
      mediaType: 'application/vnd.caogen.project+json',
      ...(prior ? { supersedesId: prior.artifactId } : {}),
      retention: { mode: 'retain' },
      content: { storageKind: 'blob', bytes: Buffer.from(exported.json, 'utf8') },
      metadata: {
        producer: 'project-portable-export',
        exportDigest: exported.exportDigest,
        aggregateRevision: exported.bundle.aggregateRevision,
        runtimeDigest: exported.bundle.runtime?.runtimeDigest,
        effectId: effect.id
      }
    },
    evidence: {
      id: target.evidenceId,
      kind: 'delivery_check',
      title: 'Project portable export integrity',
      summary: 'The complete sanitized Project bundle was sealed, serialized and committed as a versioned Artifact blob.',
      verifier: 'project-portable-export',
      metadata: {
        effectId: effect.id,
        exportDigest: exported.exportDigest,
        bundleDigest: stableValueDigest(exported.bundle)
      }
    },
    acceptance: {
      id: target.acceptanceId,
      criterionId: `${target.acceptanceId}:criterion:portable-bundle`,
      criterion: 'The Project bundle is complete, sanitized, digest-bound, versioned and available for verified import.',
      status: 'passed',
      verifier: 'project-portable-export',
      authorizesWorkflowStage: true
    },
    attachToStage: true
  }, rootDir)
  return deliveryResult(exported, target, registered.evidenceId, registered.acceptanceId)
}

function exportTarget(
  context: CanonicalSystemOperationContext,
  operationId: string,
  runId: string
): ProjectPortableExportEffectTarget {
  return {
    kind: 'project_portable_export',
    projectId: context.projectId,
    goalId: context.goalId,
    workItemId: context.workItemId,
    runId,
    artifactId: `artifact:project-portable-export:${operationId}`,
    evidenceId: `evidence:project-portable-export:${operationId}`,
    acceptanceId: `acceptance:project-portable-export:${operationId}`,
    format: 'caogen.project-aggregate.v1'
  }
}

function deliveryResult(
  exported: ProjectAggregateExportResult,
  target: ProjectPortableExportEffectTarget,
  evidenceId: string,
  acceptanceId: string | undefined
): ProjectAggregateDeliveryExportResult {
  if (evidenceId !== target.evidenceId || acceptanceId !== target.acceptanceId) {
    throw new Error('Project export Artifact registration returned different workflow identities')
  }
  return {
    ...exported,
    workflowArtifactId: target.artifactId,
    workflowEvidenceId: evidenceId,
    workflowAcceptanceId: acceptanceId,
    workflowGoalId: target.goalId,
    workflowWorkItemId: target.workItemId,
    workflowRunId: target.runId
  }
}

function requireCompletedExport(
  outcome: InteractiveOperationEffectOutcome<ProjectAggregateDeliveryExportResult>
): ProjectAggregateDeliveryExportResult {
  if (outcome.status === 'completed' && outcome.value) return outcome.value
  if (outcome.status === 'waiting_reconciliation') {
    throw new Error(`Project export is waiting for reconciliation:${outcome.snapshotId}:${outcome.error}`)
  }
  throw new Error(outcome.status === 'failed' ? outcome.error : 'Project export result is missing')
}
