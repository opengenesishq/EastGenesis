import { createHash } from 'node:crypto'
import type { WorkflowAcceptanceRecord, WorkflowRunRecord } from '../../shared/workflow-types'
import type { ArtifactLifecycleRecord } from './artifact-lifecycle-types'
import { readTaskSnapshotDatabase, mutateTaskSnapshotDatabase } from './task-snapshot'
import { findWorkflowAcceptance, linkWorkflowEvidence, projectWorkflowAcceptance, setupWorkflowLedgerSchema } from './workflow-ledger-store'
import { readAndVerifyEvents } from './workflow-ledger-query'
import { recordWorkflowEvidence } from './workflow-ledger-api'
import { isWorkflowAcceptance } from './workflow-ledger-codec'
import { digest } from './workflow-ledger-codec'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import type { OfficeDeliveryRequirementReport } from './office-delivery-requirements'

/** The Run owns a precise Acceptance revision. A later goal edit cannot
 * silently change the criterion against which this artifact is checked. */
export async function readOfficeRunRequirements(run: WorkflowRunRecord, rootDir?: string): Promise<{
  criteria?: string[]; binding: OfficeDeliveryRequirementReport['binding']
}> {
  const binding = { acceptanceId: run.acceptanceId, acceptanceRevision: run.acceptanceRevision }
  return readTaskSnapshotDatabase(rootDir, (db) => {
    const captured = readAndVerifyEvents(db).find(event => event.eventId === `workflow:run:${run.id}:requirements`)
    if (captured) {
      const value = captured.payload
      if (captured.kind !== 'workflow.run.requirements.captured' || captured.runId !== run.id ||
          captured.projectId !== run.projectId || captured.workItemId !== run.workItemId || captured.goalId !== run.goalId ||
          value.projectId !== run.projectId || value.workItemId !== run.workItemId || value.goalId !== run.goalId ||
          !Array.isArray(value.criteria) || !value.criteria.every(entry => typeof entry === 'string') ||
          value.criteriaDigest !== digest(value.criteria)) throw new WorkflowLedgerCorruptionError('原 Run 的要求快照归属或摘要无效')
      return { criteria: value.criteria as string[], binding: { contractEventId: captured.eventId,
        workItemRevision: value.workItemRevision as number, goalRevision: value.goalRevision as number | undefined,
        criteriaDigest: `sha256:${value.criteriaDigest}` } }
    }
    if (!run.acceptanceId || !run.acceptanceRevision) return { binding: { ...binding, reason: '原 Run 未绑定明确的验收合同版本，交付要求未验证' } }
    const eventId = `workflow:acceptance:${run.acceptanceId}:revision:${run.acceptanceRevision}`
    const records = readAndVerifyEvents(db).filter((event) => event.eventId === eventId &&
      event.entityType === 'acceptance' && event.entityId === run.acceptanceId &&
      ['acceptance.created', 'acceptance.updated', 'acceptance.invalidated_by_change'].includes(event.kind) &&
      event.payload.revision === run.acceptanceRevision).map((event) => event.payload)
    if (records.length !== 1 || !isWorkflowAcceptance(records[0])) throw new WorkflowLedgerCorruptionError('原 Run 的验收合同版本缺失或重复')
    const acceptance = records[0] as unknown as WorkflowAcceptanceRecord
    if (acceptance.projectId !== run.projectId || acceptance.goalId !== run.goalId || acceptance.workItemId !== run.workItemId) {
      throw new WorkflowLedgerCorruptionError('Office 交付要求与原 Run 归属不同')
    }
    return { criteria: acceptance.criteria, binding: { ...binding,
      criteriaDigest: `sha256:${createHash('sha256').update(JSON.stringify(acceptance.criteria)).digest('hex')}` } }
  })
}

export async function recordOfficeDeliveryRequirements(lifecycle: ArtifactLifecycleRecord, report: OfficeDeliveryRequirementReport, rootDir?: string): Promise<void> {
  await mutateTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    if (lifecycle.digest !== report.artifactDigest) throw new WorkflowLedgerCorruptionError('Office 要求检查字节版本与成果不同')
    const evidenceId = `evidence:office-requirements:${lifecycle.artifactId}`
    const checked = report.checks.filter((check) => check.status !== 'not_applicable')
    recordWorkflowEvidence(db, { evidenceId, projectId: lifecycle.projectId, goalId: lifecycle.goalId,
      workItemId: lifecycle.workItemId, runId: lifecycle.runId, artifactId: lifecycle.artifactId,
      kind: 'delivery_check', title: '办公交付要求检查', summary: checked.length
        ? checked.map((check) => `${check.requirement.text}: ${check.status}; ${check.reason}`).join('\n')
        : report.binding.reason ?? '本版本没有可确定性核验的显式办公交付要求；用户最终验收未代行。',
      contentDigest: lifecycle.digest.replace(/^sha256:/, ''), metadata: { producer: 'office-request-requirements',
        artifactVersion: lifecycle.version, artifactDigest: lifecycle.digest, report } },
    { source: 'runtime', verifier: 'office-request-requirements', observedAt: lifecycle.createdAt })
    for (const check of checked) {
      const id = `acceptance:office-requirements:${lifecycle.artifactId}:${check.id}`, criterionId = `${id}:criterion`
      let acceptance = findWorkflowAcceptance(db, id)
      if (!acceptance) acceptance = projectWorkflowAcceptance(db, { id, projectId: lifecycle.projectId,
        criteria: [check.requirement.text], criterionPolicies: [{ criterionId, criterionIndex: 0,
          evidenceKind: 'delivery_check', allowedSources: ['runtime'] }], status: 'verifying', evidenceRefs: [],
        revision: 1, createdAt: lifecycle.createdAt, updatedAt: lifecycle.createdAt }, { caller: 'automatic', actorId: 'office-request-requirements' })
      linkWorkflowEvidence(db, { id: `${id}:link`, evidenceId, projectId: lifecycle.projectId, runId: lifecycle.runId,
        artifactId: lifecycle.artifactId, acceptanceId: id, criterionId, evidenceOrigin: 'workflow', relation: 'verifies', createdAt: lifecycle.createdAt })
      const status = check.status === 'passed' ? 'passed' : check.status === 'failed' ? 'failed' : 'verifying'
      if (acceptance.revision === 1) projectWorkflowAcceptance(db, { ...acceptance, status,
        evidenceRefs: [evidenceId], criterionEvidence: [{ criterionId, criterionIndex: 0, evidenceRefs: [evidenceId] }],
        notes: check.reason, ...(status === 'verifying' ? {} : { verifier: 'office-request-requirements', verifiedAt: lifecycle.createdAt }),
        revision: 2, updatedAt: lifecycle.createdAt }, { caller: 'automatic', actorId: 'office-request-requirements' })
      else if (acceptance.status !== status || acceptance.criteria[0] !== check.requirement.text || acceptance.notes !== check.reason ||
        acceptance.evidenceRefs.length !== 1 || acceptance.evidenceRefs[0] !== evidenceId) {
        throw new WorkflowLedgerCorruptionError('Office 要求检查重放结果与原证据不同')
      }
    }
  })
}
