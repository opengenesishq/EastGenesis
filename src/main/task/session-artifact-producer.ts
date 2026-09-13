import type {
  WorkflowArtifactKind,
  WorkflowEvidenceKind,
  WorkflowProjectionSource,
  WorkflowRunRecord
} from '../../shared/workflow-types'
import {
  getLatestPersistedArtifactLifecycleByLineage,
  getPersistedArtifactLifecycle,
  resolveLifecycleRoots
} from './artifact-lifecycle-api'
import type {
  ArtifactContentInput,
  ArtifactLifecycleRootInput,
  ArtifactRetentionPolicy
} from './artifact-lifecycle-types'
import {
  registerCanonicalProducedArtifact,
  type CanonicalProducedArtifactExternalLocation
} from './artifact-production-boundary'
import { readTaskSnapshotDatabase } from './task-snapshot'
import { findWorkflowRun, findWorkflowWorkItem } from './workflow-ledger-store'
import { stableValueDigest } from './tool-idempotency'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import {
  resolveArtifactProjectionAuthority,
  type ArtifactProjectionAuthority
} from './artifact-projection-authority'

export interface SessionProducedArtifactInput {
  kind: WorkflowArtifactKind
  title: string
  content: ArtifactContentInput
  lineageKey: string
  mediaType?: string
  provenance?: WorkflowProjectionSource
  retention?: ArtifactRetentionPolicy
  producer: string
  metadata?: Record<string, unknown>
  evidenceKind?: WorkflowEvidenceKind
  evidenceTitle?: string
  evidenceSummary: string
  evidenceVerifier: string
  acceptanceStatus?: 'passed' | 'failed'
  acceptanceCriterion?: string
  externalLocation?: Omit<CanonicalProducedArtifactExternalLocation, 'id'>
  attachToStage?: boolean
  createdAt?: number
}

export interface SessionProducedArtifactBinding {
  artifactId: string
  evidenceId: string
  acceptanceId: string
  lineageId: string
  version: number
}

export async function registerSessionProducedArtifacts(input: {
  sessionId: string
  projectId: string
  creatingRunId: string
  producerInvocationId: string
  artifacts: readonly SessionProducedArtifactInput[]
  rootInput?: ArtifactLifecycleRootInput
}): Promise<SessionProducedArtifactBinding[]> {
  const roots = resolveLifecycleRoots(input.rootInput)
  const { run, workItem } = await readTaskSnapshotDatabase(
    roots.workflowRoot,
    (db) => {
      const run = findWorkflowRun(db, input.creatingRunId)
      return { run, workItem: run ? findWorkflowWorkItem(db, run.workItemId) : null }
    }
  )
  assertCreatingRun(run, input.sessionId, input.projectId)
  if (!workItem) {
    throw new WorkflowLedgerCorruptionError(`session-produced Artifact lacks its Workflow WorkItem: ${run.id}`)
  }
  const authority = await resolveArtifactProjectionAuthority(run, workItem, roots)
  const bindings: SessionProducedArtifactBinding[] = []
  for (const [index, artifact] of input.artifacts.entries()) {
    bindings.push(await registerOne(run, input.producerInvocationId, index, artifact, authority, roots))
  }
  return bindings
}

async function registerOne(
  run: WorkflowRunRecord & { projectId: string },
  producerInvocationId: string,
  index: number,
  input: SessionProducedArtifactInput,
  authority: ArtifactProjectionAuthority,
  roots: ReturnType<typeof resolveLifecycleRoots>
): Promise<SessionProducedArtifactBinding> {
  const identity = stableValueDigest({
    schema: 'caogen.session-produced-artifact.v1',
    projectId: run.projectId,
    runId: run.id,
    producerInvocationId,
    index,
    kind: input.kind
  })
  const artifactId = `artifact:producer:${identity}`
  const evidenceId = `evidence:producer:${identity}`
  const acceptanceId = `acceptance:producer:${identity}`
  const criterionId = `criterion:producer:${identity}:integrity`
  const lineageId = `lineage:producer:${stableValueDigest({
    schema: 'caogen.session-produced-lineage.v1',
    projectId: run.projectId,
    goalId: run.goalId,
    workItemId: run.workItemId,
    kind: input.kind,
    lineageKey: requiredText(input.lineageKey, 'Artifact lineageKey')
  })}`
  const existing = await getPersistedArtifactLifecycle(artifactId, roots)
  if (existing && (existing.projectId !== run.projectId || existing.goalId !== run.goalId ||
      existing.workItemId !== run.workItemId || existing.runId !== run.id ||
      existing.lineageId !== lineageId || existing.kind !== input.kind)) {
    throw new WorkflowLedgerCorruptionError(
      `session-produced Artifact replay differs from creating Run: ${artifactId}`
    )
  }
  const previous = existing ?? await getLatestPersistedArtifactLifecycleByLineage({
    projectId: run.projectId,
    workItemId: run.workItemId,
    lineageId,
    kind: input.kind
  }, roots)
  const version = existing?.version ?? (previous?.version ?? 0) + 1
  const supersedesId = existing ? existing.supersedesId : previous?.artifactId
  const observedAt = existing?.createdAt ?? input.createdAt ?? Date.now()
  const registered = await registerCanonicalProducedArtifact({
    lifecycle: {
      id: artifactId,
      projectId: run.projectId,
      goalId: run.goalId,
      workItemId: run.workItemId,
      runId: run.id,
      lineageId,
      kind: input.kind,
      title: input.title,
      version,
      provenance: resolvedProvenance(input.provenance, authority),
      mediaType: input.mediaType,
      supersedesId,
      retention: input.retention ?? { mode: 'retain' },
      content: input.content,
      metadata: {
        producer: input.producer,
        producerInvocationId,
        ...input.metadata
      },
      createdAt: observedAt
    },
    evidence: {
      id: evidenceId,
      kind: input.evidenceKind ?? 'delivery_check',
      title: input.evidenceTitle ?? `${input.title} delivery evidence`,
      summary: input.evidenceSummary,
      verifier: input.evidenceVerifier,
      uri: input.externalLocation?.uri,
      metadata: input.metadata
    },
    acceptance: {
      id: acceptanceId,
      criterionId,
      criterion: input.acceptanceCriterion ??
        'Produced Artifact bytes, ownership, version, digest and available location are internally consistent.',
      status: input.acceptanceStatus ?? 'passed',
      verifier: input.evidenceVerifier
    },
    ...(input.externalLocation ? {
      externalLocation: {
        id: `artifact-location:producer:${identity}:external`,
        ...input.externalLocation
      }
    } : {}),
    attachToStage: authority.attachToStage && (input.attachToStage ?? true)
  }, roots)
  return {
    artifactId: registered.lifecycle.artifactId,
    evidenceId: registered.evidenceId,
    acceptanceId: registered.acceptanceId!,
    lineageId,
    version
  }
}

function resolvedProvenance(
  requested: WorkflowProjectionSource | undefined,
  authority: ArtifactProjectionAuthority
): WorkflowProjectionSource {
  if (authority.provenance === 'legacy-derived') return 'legacy-derived'
  return requested ?? authority.provenance
}

function assertCreatingRun(
  run: WorkflowRunRecord | null,
  sessionId: string,
  projectId: string
): asserts run is WorkflowRunRecord & { projectId: string } {
  if (!run || !run.projectId || run.sessionId !== sessionId || run.projectId !== projectId ||
      run.taskRun.id !== run.id || run.taskRun.sessionId !== sessionId) {
    throw new WorkflowLedgerCorruptionError(
      `session-produced Artifact lacks matching canonical Project-owned Run: ${sessionId}:${projectId}`
    )
  }
}

function requiredText(value: string, label: string): string {
  const clean = value.trim()
  if (!clean || clean.length > 2_048 || /[\0-\x1f\x7f]/.test(clean)) {
    throw new WorkflowLedgerCorruptionError(`${label} is invalid`)
  }
  return clean
}
