import { randomUUID } from 'node:crypto'
import type { EffectRecord } from '../shared/types'
import type { ProjectImportResult } from '../shared/data-lifecycle-types'
import {
  prepareProjectAggregateImport
} from './data-lifecycle/project-import-coordinator'
import { registerCanonicalProducedArtifact } from './task/artifact-production-boundary'
import {
  executeInteractiveOperationEffect,
  type InteractiveOperationEffectOutcome
} from './task/operation-effect-gateway'
import type { CanonicalSystemOperationContext } from './task/system-operation-context'
import { TaskKernel } from './task/task-kernel'
import { stableValueDigest } from './task/tool-idempotency'
import type { ProjectAggregateExportBundle } from '../shared/project-aggregate-types'
import type { ProjectPortableImportEffectTarget } from './project-import-effect-target'

type OperationGateway = typeof executeInteractiveOperationEffect

export async function executeProjectPortableImportEffect(
  rawBundle: unknown,
  rootDir: string,
  runOperation: OperationGateway = executeInteractiveOperationEffect
): Promise<ProjectImportResult> {
  const prepared = await prepareProjectAggregateImport(rawBundle, rootDir)
  const bundle = prepared.bundle
  const operationId = randomUUID()
  const kernel = new TaskKernel(rootDir)
  const context = await kernel.plan(await kernel.create({
    rootDir,
    requestId: `project-import-${operationId}`,
    objective: '导入完整、脱敏、可验证且可恢复的 Project 可移植包',
    deferExecution: true
  }))
  const target = importTarget(context, operationId, bundle)
  const outcome = await kernel.execute(context, () => runOperation({
    rootDir,
    operationId,
    kind: 'project_import',
    title: '导入 Project 可移植包',
    sourceSessionId: `project-import:${operationId}`,
    projectId: context.projectId,
    workspaceId: context.workspaceId,
    goalId: context.goalId,
    workItemId: context.workItemId,
    cwd: context.cwd,
    toolName: 'project_portable_import',
    toolInput: target,
    execute: async (effect) => {
      const result = await prepared.execute({ operationId })
      await registerProjectPortableImportReport(effect, result, rootDir)
      return result
    },
    isSuccess: () => true,
    resultSummary: (result) => JSON.stringify({
      importedProjectId: result.projectId,
      exportDigest: result.exportDigest,
      sourceAggregateDigest: result.sourceAggregateDigest,
      operationId: result.operationId
    })
  }))
  const result = requireCompletedImport(outcome)
  await kernel.deliver(context, {
    status: 'passed',
    evidenceRefs: [target.evidenceId],
    verifiedBy: 'project-portable-import'
  })
  return result
}

async function registerProjectPortableImportReport(
  effect: EffectRecord,
  result: ProjectImportResult,
  rootDir: string
): Promise<void> {
  if (effect.target.kind !== 'project_portable_import') {
    throw new Error('Project import requires a project_portable_import EffectTarget')
  }
  const target = effect.target
  if (result.operationId !== target.operationId || result.projectId !== target.importedProjectId ||
      result.exportDigest !== target.exportDigest || result.sourceAggregateDigest !== target.sourceAggregateDigest) {
    throw new Error('Project import result differs from its frozen EffectTarget')
  }
  const report = {
    schemaVersion: 1,
    format: 'caogen.project-portable-import-report.v1',
    operation: 'import',
    outcome: 'completed',
    importedProjectIdDigest: stableValueDigest(result.projectId),
    exportDigest: result.exportDigest,
    sourceAggregateDigest: result.sourceAggregateDigest,
    importedAggregateDigest: result.importedAggregateDigest,
    semanticDigest: result.semanticDigest,
    objectCounts: boundedCounts(result.objectCounts)
  }
  await registerCanonicalProducedArtifact({
    lifecycle: {
      id: target.artifactId,
      projectId: target.projectId,
      goalId: target.goalId,
      workItemId: target.workItemId,
      runId: target.runId,
      lineageId: `lineage:project-portable-import:${target.importedProjectId}`,
      kind: 'report',
      title: 'Project portable import report',
      version: 1,
      provenance: 'explicit',
      mediaType: 'application/json',
      retention: { mode: 'retain' },
      content: { storageKind: 'blob', bytes: Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8') },
      metadata: {
        producer: 'project-portable-import',
        importedProjectIdDigest: stableValueDigest(result.projectId),
        exportDigest: result.exportDigest,
        effectId: effect.id
      }
    },
    evidence: {
      id: target.evidenceId,
      kind: 'delivery_check',
      title: 'Project portable import integrity',
      summary: 'The verified Project package was imported and its bounded report was committed to the personal Workspace.',
      verifier: 'project-portable-import',
      metadata: {
        effectId: effect.id,
        importedProjectIdDigest: stableValueDigest(result.projectId),
        exportDigest: result.exportDigest,
        reportDigest: stableValueDigest(report)
      }
    },
    acceptance: {
      id: target.acceptanceId,
      criterionId: `${target.acceptanceId}:criterion:portable-import`,
      criterion: 'The Project package was imported with verified source and semantic digests, and the report contains no source path or credential material.',
      status: 'passed',
      verifier: 'project-portable-import',
      authorizesWorkflowStage: true
    },
    attachToStage: true
  }, rootDir)
}

function importTarget(
  context: CanonicalSystemOperationContext,
  operationId: string,
  bundle: ProjectAggregateExportBundle
): ProjectPortableImportEffectTarget {
  return {
    kind: 'project_portable_import',
    operationId,
    importedProjectId: bundle.projectId,
    exportDigest: bundle.exportDigest,
    sourceAggregateDigest: bundle.aggregate.aggregateDigest,
    projectId: context.projectId,
    goalId: context.goalId,
    workItemId: context.workItemId,
    runId: `operation:${operationId}`,
    artifactId: `artifact:project-portable-import:${operationId}`,
    evidenceId: `evidence:project-portable-import:${operationId}`,
    acceptanceId: `acceptance:project-portable-import:${operationId}`,
    format: 'caogen.project-aggregate.v1'
  }
}

function boundedCounts(value: ProjectImportResult['objectCounts']): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter(([, count]) =>
    Number.isSafeInteger(count) && Number(count) >= 0
  ).map(([key, count]) => [key, Number(count)]))
}

function requireCompletedImport(
  outcome: InteractiveOperationEffectOutcome<ProjectImportResult>
): ProjectImportResult {
  if (outcome.status === 'completed' && outcome.value) return outcome.value
  if (outcome.status === 'waiting_reconciliation') {
    throw new Error(`Project import is waiting for reconciliation:${outcome.snapshotId}; ${outcome.error}`)
  }
  throw new Error(outcome.status === 'failed' ? outcome.error : 'Project import result is missing')
}
