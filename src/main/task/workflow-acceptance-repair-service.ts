import type { WorkItem } from '../../shared/project-workspace-types'
import type {
  WorkflowAcceptanceCriterionPolicy,
  WorkflowAcceptanceRecord
} from '../../shared/workflow-types'
import { mutateTaskSnapshotDatabase, readTaskSnapshotDatabase } from './task-snapshot'
import {
  openWorkflowAcceptanceRepairCoordinator,
  workflowAcceptanceRepairAcceptanceId,
  type WorkflowAcceptanceRepairRecoveryResult,
  type WorkflowAcceptanceRepairResult
} from './workflow-acceptance-repair-coordinator'
import { findWorkflowAcceptance, readAcceptances } from './workflow-ledger-query'
import { projectWorkflowAcceptance, setupWorkflowLedgerSchema } from './workflow-ledger-store'
import { normalizeAcceptanceCriterionPolicies } from './workflow-acceptance-criterion-policy'
import {
  openProjectWorkspaceCommandService,
  type ProjectWorkspaceCommandService
} from '../project-workspace/command-service'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { isAcceptanceSatisfied, type AcceptanceResult } from '../../shared/project-workspace-types'
import {
  assertWorkflowAcceptanceRetestPlanCurrent,
  workflowAcceptanceRepairWorkItemId
} from './workflow-acceptance-repair-coordinator'
import { isWorkflowAcceptanceRepairWorkItemId } from '../../shared/workflow-repair'

  const SETTLEMENT_OWNER = { type: 'human' as const, id: 'local-user', displayName: 'EastGenesis Repair Settlement' }
const SETTLEMENT_LEASE_MS = 30_000

export interface WorkflowAcceptanceRepairMaterialization {
  repair: WorkflowAcceptanceRepairResult
  repairAcceptance: WorkflowAcceptanceRecord
}

export async function materializeWorkflowAcceptanceRepair(
  acceptance: WorkflowAcceptanceRecord,
  rootDir?: string
): Promise<WorkflowAcceptanceRepairMaterialization> {
  const coordinator = await openWorkflowAcceptanceRepairCoordinator(rootDir)
  const repair = await coordinator.createRepairForFailedAcceptance(acceptance)
  const repairAcceptance = await ensureWorkflowRepairAcceptance(
    repair.repairWorkItem,
    rootDir,
    acceptance.criterionPolicies
  )
  return { repair, repairAcceptance }
}

export async function ensureWorkflowRepairAcceptance(
  repairWorkItem: WorkItem,
  rootDir?: string,
  sourceCriterionPolicies?: readonly WorkflowAcceptanceCriterionPolicy[]
): Promise<WorkflowAcceptanceRecord> {
  return mutateTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    const acceptanceId = workflowAcceptanceRepairAcceptanceId(repairWorkItem.id)
    const existing = findWorkflowAcceptance(db, acceptanceId)
    const criteria = repairWorkItem.acceptanceSpec.map((criterion) => criterion.criterion)
    const criterionPolicies = deriveWorkflowRepairCriterionPolicies(sourceCriterionPolicies, repairWorkItem)
    if (existing) {
      const existingCriterionPolicies = normalizeAcceptanceCriterionPolicies(
        existing.criterionPolicies,
        criteria.length
      )
      const bindingMatches = existing.projectId === repairWorkItem.projectId &&
        existing.goalId === repairWorkItem.goalId &&
        existing.workItemId === repairWorkItem.id &&
        JSON.stringify(existing.criteria) === JSON.stringify(criteria) &&
        criterionPoliciesEqual(existingCriterionPolicies, criterionPolicies)
      if (!bindingMatches) throw repairConflict(acceptanceId, repairWorkItem.id)
      return existing
    }
    return projectWorkflowAcceptance(db, {
      id: acceptanceId,
      projectId: repairWorkItem.projectId,
      ...(repairWorkItem.goalId === undefined ? {} : { goalId: repairWorkItem.goalId }),
      workItemId: repairWorkItem.id,
      criteria,
      ...(criterionPolicies === undefined ? {} : { criterionPolicies }),
      status: 'pending'
    }, { caller: 'system', actorId: 'workflow-acceptance-repair' })
  })
}

/** Settle the canonical repair WorkItem only after its own Acceptance passed/waived. */
export async function settleWorkflowRepairWorkItem(
  acceptance: WorkflowAcceptanceRecord,
  rootDir?: string
): Promise<WorkItem | undefined> {
  if (!acceptance.workItemId || !acceptance.projectId) return undefined
  const repairId = acceptance.workItemId
  const store = await openProjectWorkspaceStore(rootDir)
  let item = await store.getWorkItem(repairId)
  if (!item) return undefined
  if (item.projectId !== acceptance.projectId || item.goalId !== acceptance.goalId) {
    throw new Error(`repair Acceptance crosses repair WorkItem boundary:${acceptance.id}`)
  }
  if (acceptance.status !== 'passed' && acceptance.status !== 'waived') return item
  const result: AcceptanceResult = {
    status: acceptance.status,
    evidenceRefs: [...acceptance.evidenceRefs],
    ...(acceptance.verifier ? { verifiedBy: acceptance.verifier } : {}),
    ...(acceptance.verifiedAt === undefined ? {} : { verifiedAt: acceptance.verifiedAt }),
    ...(acceptance.waiverReason ? { waiverReason: acceptance.waiverReason } : {})
  }
  if (!isAcceptanceSatisfied(result)) return item
  const commands = await openProjectWorkspaceCommandService(rootDir)
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (item.status === 'done') return item
    if (item.status === 'failed' || item.status === 'cancelled') return item
    try {
      const advanced = await advanceWorkflowRepairSettlement(item, result, commands)
      if (!advanced) return item
      item = advanced
    } catch (error) {
      if (!isStaleRevision(error)) throw error
      const refreshed = await store.getWorkItem(repairId)
      if (!refreshed) return undefined
      item = refreshed
    }
  }
  throw new Error(`repair WorkItem settlement exhausted:${item.id}`)
}

async function advanceWorkflowRepairSettlement(
  item: WorkItem,
  result: AcceptanceResult,
  commands: ProjectWorkspaceCommandService
): Promise<WorkItem | undefined> {
  const options = { expectedRevision: item.revision }
  if (!sameAcceptanceResult(item.acceptance, result)) {
    return commands.setWorkItemAcceptance(item.id, result, options)
  }
  if (!item.owner) return commands.updateWorkItem(item.id, { owner: SETTLEMENT_OWNER }, options)
  if (item.status === 'backlog' || item.status === 'blocked') {
    return commands.transitionWorkItem(item.id, 'ready', options)
  }
  if (item.status === 'waiting_approval') {
    return commands.transitionWorkItem(item.id, 'blocked', options)
  }
  if (item.status === 'ready') {
    if (!activeLease(item)) {
      return commands.acquireWorkItemLease(item.id, {
        ...options,
        leaseId: `workflow-repair-settlement:${item.id}`,
        ownerId: item.owner.id,
        durationMs: SETTLEMENT_LEASE_MS
      })
    }
    return commands.transitionWorkItem(item.id, 'running', options)
  }
  if (item.status === 'running') return commands.transitionWorkItem(item.id, 'verifying', options)
  if (item.status === 'verifying') return commands.transitionWorkItem(item.id, 'done', options)
  return undefined
}

function sameAcceptanceResult(left: AcceptanceResult | undefined, right: AcceptanceResult): boolean {
  return left?.status === right.status &&
    JSON.stringify(left.evidenceRefs) === JSON.stringify(right.evidenceRefs) &&
    left.verifiedBy === right.verifiedBy && left.verifiedAt === right.verifiedAt &&
    left.waiverReason === right.waiverReason
}

function activeLease(item: WorkItem): boolean {
  return Boolean(item.lease && item.lease.expiresAt > Date.now())
}

export async function findFailedAcceptanceForRepair(
  repairWorkItemId: string,
  rootDir?: string
): Promise<WorkflowAcceptanceRecord | undefined> {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    return readAcceptances(db).find((candidate) =>
      candidate.status === 'failed' &&
      workflowAcceptanceRepairWorkItemId(candidate.id, candidate.revision) === repairWorkItemId
    )
  })
}

/** Advance the original failed Acceptance only when the repair Acceptance is already durable and satisfied. */
export async function autoRetestFailedAcceptanceForRepair(
  repairAcceptance: WorkflowAcceptanceRecord,
  rootDir?: string
): Promise<WorkflowAcceptanceRecord | undefined> {
  if (!repairAcceptance.workItemId || !isWorkflowAcceptanceRepairWorkItemId(repairAcceptance.workItemId)) return undefined
  if (repairAcceptance.status !== 'passed' && repairAcceptance.status !== 'waived') return undefined
  const repairWorkItem = await settleWorkflowRepairWorkItem(repairAcceptance, rootDir)
  if (!repairWorkItem || repairWorkItem.status !== 'done') return undefined
  const failed = await findFailedAcceptanceForRepair(repairAcceptance.workItemId, rootDir)
  if (!failed) return undefined
  const coordinator = await openWorkflowAcceptanceRepairCoordinator(rootDir)
  const plan = await coordinator.prepareRetest(failed, { updatedAt: Date.now() })
  return mutateTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    const current = findWorkflowAcceptance(db, failed.id)
    assertWorkflowAcceptanceRetestPlanCurrent(current, plan)
    return projectWorkflowAcceptance(db, plan.acceptanceInput, {
      caller: 'system',
      actorId: 'workflow-acceptance-repair-runtime'
    })
  })
}

/** Project a completed repair Session into the WorkItem workflow gate. */
export async function markWorkflowAcceptanceRepairVerifying(
  workItemId: string,
  rootDir?: string
): Promise<WorkItem | undefined> {
  if (!isWorkflowAcceptanceRepairWorkItemId(workItemId)) return undefined
  const store = await openProjectWorkspaceStore(rootDir)
  let item = await store.getWorkItem(workItemId)
  if (!item) return undefined
  if (item.status !== 'running') return item
  const commands = await openProjectWorkspaceCommandService(rootDir)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await commands.transitionWorkItem(item.id, 'verifying', { expectedRevision: item.revision })
    } catch (error) {
      if (!isStaleRevision(error)) throw error
      item = await (await openProjectWorkspaceStore(rootDir)).getWorkItem(workItemId)
      if (!item || item.status !== 'running') return item
    }
  }
  throw new Error(`workflow repair verifying projection exhausted:${workItemId}`)
}

export async function markWorkflowAcceptanceRepairTerminalFailure(
  workItemId: string,
  status: 'failed' | 'cancelled',
  rootDir?: string
): Promise<WorkItem | undefined> {
  if (!isWorkflowAcceptanceRepairWorkItemId(workItemId)) return undefined
  let item = await (await openProjectWorkspaceStore(rootDir)).getWorkItem(workItemId)
  if (!item || item.status === 'done' || item.status === 'failed' || item.status === 'cancelled') return item
  const commands = await openProjectWorkspaceCommandService(rootDir)
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      if (status === 'cancelled') {
        return await commands.transitionWorkItem(item.id, 'cancelled', { expectedRevision: item.revision })
      }
      if (item.status === 'running' || item.status === 'waiting_approval') {
        item = await commands.transitionWorkItem(item.id, 'blocked', { expectedRevision: item.revision })
        continue
      }
      if (item.status === 'blocked' || item.status === 'verifying') {
        return await commands.transitionWorkItem(item.id, 'failed', { expectedRevision: item.revision })
      }
      return item
    } catch (error) {
      if (!isStaleRevision(error)) throw error
      item = await (await openProjectWorkspaceStore(rootDir)).getWorkItem(workItemId)
      if (!item || item.status === 'done' || item.status === 'failed' || item.status === 'cancelled') return item
    }
  }
  throw new Error(`workflow repair terminal failure projection exhausted:${workItemId}`)
}

/**
 * A repair Acceptance is a new immutable record. Preserve the failed
 * Acceptance's evidence semantics while rebinding criterion identity to the
 * deterministic criteria carried by the repair WorkItem.
 */
export function deriveWorkflowRepairCriterionPolicies(
  sourceCriterionPolicies: readonly WorkflowAcceptanceCriterionPolicy[] | undefined,
  repairWorkItem: Pick<WorkItem, 'acceptanceSpec'>
): WorkflowAcceptanceCriterionPolicy[] | undefined {
  if (sourceCriterionPolicies === undefined) return undefined
  const normalized = normalizeAcceptanceCriterionPolicies(
    sourceCriterionPolicies,
    repairWorkItem.acceptanceSpec.length
  )
  if (!normalized) return undefined
  return normalized.map((policy) => {
    const criterion = repairWorkItem.acceptanceSpec[policy.criterionIndex]
    if (!criterion) {
      throw repairConflict('unknown', 'repair-work-item')
    }
    return {
      ...policy,
      criterionId: criterion.id,
      allowedSources: [...policy.allowedSources]
    }
  })
}

function criterionPoliciesEqual(
  left: WorkflowAcceptanceCriterionPolicy[] | undefined,
  right: WorkflowAcceptanceCriterionPolicy[] | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.length !== right.length) return false
  return left.every((policy, index) => {
    const expected = right[index]
    return policy.criterionId === expected.criterionId &&
      policy.criterionIndex === expected.criterionIndex &&
      policy.evidenceKind === expected.evidenceKind &&
      policy.allowedSources.length === expected.allowedSources.length &&
      policy.allowedSources.every((source, sourceIndex) => source === expected.allowedSources[sourceIndex])
  })
}

export async function recoverWorkflowAcceptanceRepairMaterializations(
  rootDir?: string
): Promise<WorkflowAcceptanceRepairRecoveryResult> {
  const failedAcceptances = await readTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    return readAcceptances(db).filter((acceptance) => acceptance.status === 'failed')
  })
  if (failedAcceptances.length === 0) return { recovered: [], failures: [] }

  const coordinator = await openWorkflowAcceptanceRepairCoordinator(rootDir)
  const result = await coordinator.recoverPending(failedAcceptances)
  for (const repair of result.recovered) {
    try {
      const failedAcceptance = failedAcceptances.find((candidate) =>
        candidate.id === repair.acceptanceId && candidate.revision === repair.failedAcceptanceRevision
      )
      if (!failedAcceptance) {
        throw new Error(
          `failed Acceptance ${repair.acceptanceId} revision ${repair.failedAcceptanceRevision} disappeared during repair recovery`
        )
      }
      const repairAcceptance = await ensureWorkflowRepairAcceptance(
        repair.repairWorkItem,
        rootDir,
        failedAcceptance.criterionPolicies
      )
      if (repairAcceptance.status === 'passed' || repairAcceptance.status === 'waived') {
        await autoRetestFailedAcceptanceForRepair(repairAcceptance, rootDir)
      }
    } catch (error) {
      result.failures.push({
        acceptanceId: repair.acceptanceId,
        failedAcceptanceRevision: repair.failedAcceptanceRevision,
        ...(readErrorCode(error) ? { code: readErrorCode(error) } : {}),
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return result
}

function repairConflict(acceptanceId: string, workItemId: string): Error & { code: string } {
  const error = new Error(`repair Acceptance ${acceptanceId} conflicts with WorkItem ${workItemId}`) as Error & { code: string }
  error.name = 'WorkflowAcceptanceRepairConflictError'
  error.code = 'WORKFLOW_REPAIR_CONFLICT'
  return error
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function isStaleRevision(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error &&
    (error as { code?: unknown }).code === 'stale_revision')
}
