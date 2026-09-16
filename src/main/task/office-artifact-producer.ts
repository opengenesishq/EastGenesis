import type { EffectRecord, TaskRunRecord } from '../../shared/types'
import type { WorkflowProjectionSource, WorkflowRunRecord } from '../../shared/workflow-types'
import { getPersistedArtifactLifecycle, resolveLifecycleRoots } from './artifact-lifecycle-api'
import type { ArtifactLifecycleRecord } from './artifact-lifecycle-types'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import { runOfficeSelfCheck, type OfficeSelfCheckResult } from '../agent/tools/office-self-check'
import { registerCanonicalProducedArtifact } from './artifact-production-boundary'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { assertSha256Digest } from './artifact-lifecycle-content'
import { checkOfficeDeliveryRequirements } from './office-delivery-requirements'
import { readOfficeRunRequirements, recordOfficeDeliveryRequirements } from './office-delivery-requirement-ledger'

type OfficeArtifactEffect = EffectRecord & {
  target: Extract<EffectRecord['target'], { kind: 'office_artifact' }>
}

export function isConfirmedOfficeArtifactEffect(effect: EffectRecord): effect is OfficeArtifactEffect {
  return effect.status === 'confirmed' && officeArtifactEffectHasOutputBinding(effect)
}

export function officeArtifactEffectHasOutputBinding(effect: EffectRecord): effect is OfficeArtifactEffect {
  return effect.target.kind === 'office_artifact' && effect.target.outputBindingVersion === 1 &&
    Array.isArray(effect.target.sourceSnapshots) &&
    typeof effect.target.expectedSha256 === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(effect.target.expectedSha256) &&
    Number.isSafeInteger(effect.target.expectedBytes) && (effect.target.expectedBytes as number) >= 0
}

/** 由 self-check 结果派生 Acceptance 状态：绿→passed，红→failed（默认采纳 B/C）。 */
export function deriveOfficeAcceptanceStatus(selfCheck: OfficeSelfCheckResult): 'passed' | 'failed' {
  return selfCheck.ok ? 'passed' : 'failed'
}

export async function registerOfficeArtifactLifecycle(
  run: TaskRunRecord,
  effect: OfficeArtifactEffect,
  workflowRun: WorkflowRunRecord & { projectId: string },
  provenance: WorkflowProjectionSource,
  rootDir?: string
): Promise<ArtifactLifecycleRecord> {
  assertOfficeEffectOwnership(run, effect)
  const expectedOutput = requiredOfficeEffectOutput(effect)
  const artifactId = `artifact:office:${effect.id}`
  const existing = await getPersistedArtifactLifecycle(artifactId, rootDir)
  if (existing) {
    assertExistingOfficeArtifact(
      existing,
      run.id,
      effect.target.artifactKind,
      effect.target.workspacePath,
      expectedOutput
    )
  }
  const selfCheck = await runOfficeSelfCheck({
    workspacePath: effect.target.workspacePath,
    expectedSha256: effect.target.expectedSha256,
    artifactKind: effect.target.artifactKind,
    mediaType: effect.target.mediaType,
    sourceRefs: effect.target.sourceRefs,
    sourceSnapshots: effect.target.sourceSnapshots,
    runtimeTraceable: true
  })
  const status = deriveOfficeAcceptanceStatus(selfCheck)
  const requirements = await checkOfficeDeliveryRequirements({ workspacePath: effect.target.workspacePath,
    expectedDigest: expectedOutput.sha256, kind: effect.target.artifactKind, sourceRefs: effect.target.sourceRefs,
    ...await readOfficeRunRequirements(workflowRun, rootDir) })
  const observedAt = existing?.createdAt ?? effect.terminalAt ?? effect.updatedAt
  const workspaceRoot = resolveLifecycleRoots(rootDir).workspaceRoot
  const hasProjectWorkspace = Boolean(
    await (await openProjectWorkspaceStore(workspaceRoot)).getWorkspace(workflowRun.projectId)
  )
  const registered = await registerCanonicalProducedArtifact({
    lifecycle: {
      id: artifactId,
      projectId: workflowRun.projectId,
      goalId: workflowRun.goalId,
      workItemId: workflowRun.workItemId,
      runId: workflowRun.id,
      lineageId: `lineage:office:${effect.id}`,
      kind: effect.target.artifactKind,
      title: effect.target.title,
      version: existing?.version ?? 1,
      provenance,
      mediaType: effect.target.mediaType,
      retention: { mode: 'retain' },
      content: {
        storageKind: 'source_ref',
        sourceRef: effect.target.workspacePath,
        expectedDigest: expectedOutput.sha256
      },
      metadata: {
        producer: 'office_delivery',
        effectId: effect.id,
        toolUseId: effect.toolUseId,
        artifactKind: effect.target.artifactKind,
        sourceRefs: effect.target.sourceRefs,
        outputBindingVersion: 1,
        expectedSha256: expectedOutput.sha256,
        expectedBytes: expectedOutput.bytes
      },
      createdAt: observedAt
    },
    evidence: {
      id: `evidence:artifact:office:${effect.id}`,
      kind: 'delivery_check',
      title: `Office delivery integrity: ${effect.target.title}`,
      summary: selfCheck.ok
        ? `The Office output is parseable and matches its frozen type, digest, byte length and ${effect.target.sourceRefs.length} source reference(s).`
        : `The Office output failed its structural, byte or source-traceability check: ${selfCheck.reason}`,
      verifier: 'office-delivery',
      metadata: {
        artifactKind: effect.target.artifactKind,
        mediaType: effect.target.mediaType,
        selfCheck
      }
    },
    acceptance: {
      id: `acceptance:artifact:office:${effect.id}`,
      criterionId: `criterion:artifact:office:${effect.id}:deliverable`,
      criterion: 'The Office output is parseable and its type, bytes, Project ownership and source traceability match the frozen Effect.',
      status,
      verifier: 'office-delivery'
    },
    attachToStage: hasProjectWorkspace && !requirements.binding.reason && requirements.checks.every((check) =>
      check.status === 'passed' || check.status === 'not_applicable')
  }, rootDir)
  assertExistingOfficeArtifact(
    registered.lifecycle,
    run.id,
    effect.target.artifactKind,
    effect.target.workspacePath,
    expectedOutput
  )
  await recordOfficeDeliveryRequirements(registered.lifecycle, requirements, rootDir)
  return registered.lifecycle
}

function assertOfficeEffectOwnership(run: TaskRunRecord, effect: EffectRecord): void {
  if (effect.runId !== run.id || effect.sessionId !== run.sessionId) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Office Artifact Effect ownership differs from Run: ${effect.id}`
    )
  }
}

function assertExistingOfficeArtifact(
  record: ArtifactLifecycleRecord,
  runId: string,
  artifactKind: 'document' | 'spreadsheet' | 'presentation' | 'pdf',
  sourceRef: string,
  expectedOutput: { sha256: string; bytes: number }
): void {
  if (
    record.runId !== runId ||
    record.kind !== artifactKind ||
    record.storageKind !== 'source_ref' ||
    record.sourceRef !== sourceRef ||
    record.digest !== expectedOutput.sha256 ||
    record.sizeBytes !== expectedOutput.bytes
  ) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Office Artifact lifecycle differs from producer output: ${record.artifactId}`
    )
  }
}

function requiredOfficeEffectOutput(effect: OfficeArtifactEffect): { sha256: string; bytes: number } {
  const { expectedSha256, expectedBytes } = effect.target
  if (!officeArtifactEffectHasOutputBinding(effect) || !expectedSha256 || expectedBytes === undefined) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Office Artifact Effect lacks frozen output identity: ${effect.id}`
    )
  }
  return { sha256: assertSha256Digest(expectedSha256), bytes: expectedBytes }
}
