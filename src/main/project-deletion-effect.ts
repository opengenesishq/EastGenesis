import { randomUUID } from 'node:crypto'
import type { EffectRecord } from '../shared/types'
import type { MutationOptions, ProjectDeletionResult } from '../shared/project-workspace-types'
import { openProjectWorkspaceStore } from './project-workspace/store'
import {
  assertProjectDeletionResumeAllowed,
  purgeProjectPermanently
} from './data-lifecycle/project-deletion-coordinator'
import { isDataRetentionBlockedError } from './data-lifecycle/retention-authority'
import { ProjectDeletionJournal } from './data-lifecycle/project-deletion-journal'
import { registerCanonicalProducedArtifact } from './task/artifact-production-boundary'
import {
  executeInteractiveOperationEffect,
  type InteractiveOperationEffectOutcome
} from './task/operation-effect-gateway'
import { TaskKernel } from './task/task-kernel'
import type { CanonicalSystemOperationContext } from './task/system-operation-context'
import { stableValueDigest } from './task/tool-idempotency'
import type { ProjectPermanentDeletionEffectTarget } from './project-deletion-effect-target'

type OperationGateway = typeof executeInteractiveOperationEffect

export async function executeProjectPermanentDeletionEffect(
  deletedProjectId: string,
  rootDir: string,
  mutationOptions: MutationOptions = {},
  runOperation: OperationGateway = executeInteractiveOperationEffect
): Promise<ProjectDeletionResult> {
  const id = requiredId(deletedProjectId, 'Project ID')
  const pending = new ProjectDeletionJournal(rootDir).getPendingProject(id)
  const operationId = pending?.operationId ?? randomUUID()
  const expectedWorkspaceRevision = pending?.expectedWorkspaceRevision ?? await deletedWorkspaceRevision(
    id,
    rootDir,
    mutationOptions
  )
  const deletionOperationId = pending?.operationId ?? operationId
  const kernel = new TaskKernel(rootDir)
  const context = await kernel.plan(await kernel.create({
    rootDir,
    requestId: `project-delete-${operationId}`,
    objective: '永久删除 Project 并生成可核验、可恢复的删除证明',
    deferExecution: true
  }))
  const target = deletionTarget(context, operationId, deletionOperationId, id, expectedWorkspaceRevision)
  let outcome: InteractiveOperationEffectOutcome<ProjectDeletionResult>
  try {
    outcome = await kernel.execute(context, () => runOperation({
      rootDir,
      operationId,
      kind: 'project_delete',
      title: '永久删除 Project',
      sourceSessionId: `project-delete:${operationId}`,
      projectId: context.projectId,
      workspaceId: context.workspaceId,
      goalId: context.goalId,
      workItemId: context.workItemId,
      cwd: context.cwd,
      toolName: 'project_permanent_deletion',
      toolInput: target,
      execute: async (effect) => {
        const result = await purgeProjectPermanently(id, rootDir, mutationOptions, {
          operationId: deletionOperationId
        })
        await registerProjectPermanentDeletionReport(effect, result, rootDir)
        return result
      },
      isSuccess: () => true,
      resultSummary: (result) => JSON.stringify({
        deletedProjectIdDigest: stableValueDigest(result.projectId),
        exportDigest: result.exportDigest,
        proofDigest: result.proofDigest,
        operationId: result.operationId
      })
    }))
  } catch (error) {
    // If admission or the Effect gateway fails before returning an outcome,
    // leave no runnable canonical operation behind.
    await kernel.stop(context, async () => undefined)
    throw error
  }
  if (outcome.status === 'completed' && outcome.value) {
    await kernel.deliver(context, {
      evidenceRefs: [target.evidenceId],
      verifiedBy: 'project-permanent-deletion'
    })
    return outcome.value
  }
  if (outcome.status === 'failed') {
    // A deterministic terminal failure has no deletion proof to accept.
    await kernel.stop(context, async () => undefined)
  }
  if (outcome.status === 'waiting_reconciliation') {
    throw new Error(`Project deletion is waiting for reconciliation:${outcome.snapshotId}`)
  }
  if (outcome.status === 'failed') throw new Error(outcome.error)
  throw new Error('Project deletion result is missing')
}

export async function resumeProjectPermanentDeletionEffects(
  rootDir: string
): Promise<ProjectDeletionResult[]> {
  const results: ProjectDeletionResult[] = []
  for (const entry of new ProjectDeletionJournal(rootDir).listPending()) {
    try {
      assertProjectDeletionResumeAllowed(rootDir, entry)
      results.push(await executeProjectPermanentDeletionEffect(entry.projectId, rootDir, {
        expectedRevision: entry.expectedWorkspaceRevision
      }))
    } catch (error) {
      if (!isDataRetentionBlockedError(error)) throw error
      console.info(`[caogen] Project deletion remains pending under retention authority: ${entry.projectId}`)
    }
  }
  return results
}

async function deletedWorkspaceRevision(
  projectId: string,
  rootDir: string,
  options: MutationOptions
): Promise<number> {
  const workspace = await (await openProjectWorkspaceStore(rootDir)).getWorkspace(projectId)
  if (!workspace) throw new Error(`Project ${projectId} is unavailable for permanent deletion`)
  if (workspace.status !== 'deleted') throw new Error(`Project ${projectId} must be moved to deleted state before permanent deletion`)
  if (options.expectedRevision !== undefined && options.expectedRevision !== workspace.revision) {
    throw new Error(`stale_revision: Project ${projectId} is at ${workspace.revision}`)
  }
  return workspace.revision
}

async function registerProjectPermanentDeletionReport(
  effect: EffectRecord,
  result: ProjectDeletionResult,
  rootDir: string
): Promise<void> {
  if (effect.target.kind !== 'project_permanent_deletion') {
    throw new Error('Project deletion requires a project_permanent_deletion EffectTarget')
  }
  const target = effect.target
  if (result.operationId !== target.deletionOperationId || result.projectId !== target.deletedProjectId) {
    throw new Error('Project deletion result differs from its frozen EffectTarget')
  }
  const report = {
    schemaVersion: 1,
    format: 'caogen.project-permanent-deletion-report.v1',
    operation: 'permanent_delete',
    outcome: 'completed',
    deletedProjectIdDigest: stableValueDigest(result.projectId),
    exportDigest: result.exportDigest,
    backupDigest: result.backupDigest,
    proofDigest: result.proofDigest,
    sessionCount: boundedCount(result.sessionIds.length),
    sdkSessionCount: boundedCount(result.sdkSessionIds.length),
    residuals: boundedCounts(result.residuals)
  }
  await registerCanonicalProducedArtifact({
    lifecycle: {
      id: target.artifactId,
      projectId: target.projectId,
      goalId: target.goalId,
      workItemId: target.workItemId,
      runId: target.runId,
      lineageId: `lineage:project-permanent-deletion:${target.deletedProjectId}`,
      kind: 'report',
      title: 'Project permanent deletion report',
      version: 1,
      provenance: 'explicit',
      mediaType: 'application/json',
      retention: { mode: 'retain' },
      content: { storageKind: 'blob', bytes: Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8') },
      metadata: {
        producer: 'project-permanent-deletion',
        deletedProjectIdDigest: stableValueDigest(result.projectId),
        proofDigest: result.proofDigest,
        effectId: effect.id
      }
    },
    evidence: {
      id: target.evidenceId,
      kind: 'delivery_check',
      title: 'Project permanent deletion proof',
      summary: 'The Project deletion journal, proof and residual scan completed without retaining source paths or credential material.',
      verifier: 'project-permanent-deletion',
      metadata: {
        effectId: effect.id,
        deletedProjectIdDigest: stableValueDigest(result.projectId),
        exportDigest: result.exportDigest,
        proofDigest: result.proofDigest,
        reportDigest: stableValueDigest(report)
      }
    },
    acceptance: {
      id: target.acceptanceId,
      criterionId: `${target.acceptanceId}:criterion:permanent-deletion-proof`,
      criterion: 'The Project deletion completed with a verified proof and zero residual records, without disclosing backup or proof paths.',
      status: 'passed',
      verifier: 'project-permanent-deletion',
      authorizesWorkflowStage: true
    },
    attachToStage: true
  }, rootDir)
}

function deletionTarget(
  context: CanonicalSystemOperationContext,
  operationId: string,
  deletionOperationId: string,
  deletedProjectId: string,
  expectedWorkspaceRevision: number
): ProjectPermanentDeletionEffectTarget {
  return {
    kind: 'project_permanent_deletion',
    deletionOperationId,
    deletedProjectId,
    expectedWorkspaceRevision,
    projectId: context.projectId,
    goalId: context.goalId,
    workItemId: context.workItemId,
    runId: `operation:${operationId}`,
    artifactId: `artifact:project-permanent-deletion:${operationId}`,
    evidenceId: `evidence:project-permanent-deletion:${operationId}`,
    acceptanceId: `acceptance:project-permanent-deletion:${operationId}`
  }
}

function boundedCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Project deletion report count is invalid')
  return value
}

function boundedCounts(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).map(([key, count]) => [key, boundedCount(count)]))
}

function requireCompletedDeletion(
  outcome: InteractiveOperationEffectOutcome<ProjectDeletionResult>
): ProjectDeletionResult {
  if (outcome.status === 'completed' && outcome.value) return outcome.value
  if (outcome.status === 'waiting_reconciliation') {
    throw new Error(`Project deletion is waiting for reconciliation:${outcome.snapshotId}`)
  }
  throw new Error(outcome.status === 'failed' ? outcome.error : 'Project deletion result is missing')
}

function requiredId(value: string, label: string): string {
  if (!value.trim() || /[\0-\x1f\x7f]/.test(value)) throw new Error(`${label} is invalid`)
  return value.trim()
}
