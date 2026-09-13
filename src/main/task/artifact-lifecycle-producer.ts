import { isConfirmedOfficeArtifactEffect, registerOfficeArtifactLifecycle } from './office-artifact-producer'
export { deriveOfficeAcceptanceStatus, officeArtifactEffectHasOutputBinding } from './office-artifact-producer'
import { isConfirmedOfficeRevisionEffect, registerOfficeRevisionLifecycle } from '../office-revision/producer'
import { readFile } from 'node:fs/promises'
import { basename, extname, relative, resolve, sep } from 'node:path'
import type { EffectRecord, TaskRunRecord } from '../../shared/types'
import type {
  WorkflowArtifactKind,
  WorkflowProjectionSource,
  WorkflowRunRecord,
  WorkflowWorkItemRecord
} from '../../shared/workflow-types'
import {
  getLatestPersistedArtifactLifecycleByLineage,
  getPersistedArtifactLifecycle,
  resolveLifecycleRoots
} from './artifact-lifecycle-api'
import { artifactBlobPath, assertSha256Digest } from './artifact-lifecycle-content'
import type { ArtifactLifecycleRecord } from './artifact-lifecycle-types'
import { readTaskSnapshotDatabase } from './task-snapshot'
import {
  findWorkflowRun,
  findWorkflowWorkItem
} from './workflow-ledger-store'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import { effectRecordIntegrityMatches } from './effect-record-integrity'
import { stableValueDigest } from './tool-idempotency'
import { registerCanonicalProducedArtifact } from './artifact-production-boundary'
import { registerSessionProducedArtifacts } from './session-artifact-producer'
import {
  exactIssueMarkerRecords,
  exactMarkerRecords,
  queryIssueEffectTarget,
  queryPullRequestEffectTarget
} from '../git/pull-request-effect'
import { reconcileEffect } from './effect-reconciler'
import { confirmedReconciliationObservation } from './effect-reconciliation-result'
import {
  isConfirmedNotificationDeliveryEffect,
  registerNotificationDeliveryArtifact
} from './notification-artifact-producer'
import {
  isConfirmedMigrationOperationEffect,
  registerMigrationOperationArtifact
} from './migration-report-artifact'
import {
  isConfirmedProjectPortableExportEffect,
  recoverConfirmedProjectPortableExportArtifact
} from '../project-export-artifact'
import {
  isConfirmedProjectPortableImportEffect,
  recoverConfirmedProjectPortableImportArtifact
} from '../project-import-artifact'
import {
  isConfirmedProjectPermanentDeletionEffect,
  recoverConfirmedProjectPermanentDeletionArtifact
} from '../project-deletion-artifact'
import {
  isConfirmedProviderProfileOperationEffect,
  recoverConfirmedProviderProfileOperationArtifact
} from '../provider/provider-profile-operation-artifact'
import { resolveArtifactProjectionAuthority } from './artifact-projection-authority'

export async function registerConfirmedRunArtifactLifecycles(run: TaskRunRecord, rootDir?: string): Promise<ArtifactLifecycleRecord[]> {
  const effects = (run.effects ?? []).filter((effect) =>
    isConfirmedCodeForgePatchEffect(effect) || isConfirmedOfficeArtifactEffect(effect) || isConfirmedOfficeRevisionEffect(effect) ||
    isConfirmedFileArtifactEffect(effect) || isConfirmedPullRequestEffect(effect) ||
    isConfirmedIssueEffect(effect) || isConfirmedGitDeliveryEffect(effect) ||
    isConfirmedNotificationDeliveryEffect(effect) || isConfirmedMigrationOperationEffect(effect) ||
    isConfirmedProjectPortableExportEffect(effect) || isConfirmedProjectPortableImportEffect(effect) ||
    isConfirmedProjectPermanentDeletionEffect(effect) ||
    isConfirmedProviderProfileOperationEffect(effect)
  )
  if (effects.length === 0) return []
  const { workflowRun, workItem } = await readTaskSnapshotDatabase(rootDir, (db) => {
    const workflowRun = findWorkflowRun(db, run.id)
    const workItem = workflowRun ? findWorkflowWorkItem(db, workflowRun.workItemId) : null
    return { workflowRun, workItem }
  })
  // Ordinary sessions still use durable Effects but have no Project-owned Run
  // to receive an Artifact. A legacy-derived WorkItem is a valid Project
  // projection and must retain its compatibility Artifact/Evidence trail.
  if (!workflowRun?.projectId) return []
  assertCanonicalProducerRun(run, workflowRun)
  if (!workItem) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Artifact producer lacks its canonical WorkItem projection: ${run.id}`
    )
  }
  const authority = await resolveArtifactProjectionAuthority(workflowRun, workItem, rootDir)
  const records: ArtifactLifecycleRecord[] = []
  for (const effect of effects) {
    assertCanonicalProducerEffect(effect, workflowRun)
    if (isConfirmedCodeForgePatchEffect(effect)) {
      records.push(await registerCodeForgePatchLifecycle(
        run, effect, workflowRun, authority.provenance, rootDir
      ))
      continue
    }
    const officeArtifact = await registerConfirmedOfficeOutput({ run, effect, workflowRun, provenance: authority.provenance, rootDir })
    if (officeArtifact) { records.push(officeArtifact); continue }
    if (isConfirmedFileArtifactEffect(effect)) {
      records.push(await registerFileArtifactLifecycle(
        run, effect, workflowRun, workItem, authority, rootDir
      ))
      continue
    }
    if (isConfirmedGitDeliveryEffect(effect)) {
      records.push(await registerGitDeliveryArtifactLifecycle(
        run, effect, workflowRun, authority.provenance, rootDir
      ))
      continue
    }
    if (isConfirmedNotificationDeliveryEffect(effect)) {
      records.push(await registerNotificationDeliveryArtifact(
        run, effect, workflowRun, authority.provenance, rootDir
      ))
      continue
    }
    if (isConfirmedMigrationOperationEffect(effect)) {
      records.push(await registerMigrationOperationArtifact(
        run, effect, workflowRun, authority.provenance, rootDir
      ))
      continue
    }
    if (isConfirmedProjectPortableExportEffect(effect)) {
      records.push(await recoverConfirmedProjectPortableExportArtifact(effect, rootDir))
      continue
    }
    if (isConfirmedProjectPortableImportEffect(effect)) {
      records.push(await recoverConfirmedProjectPortableImportArtifact(effect, rootDir))
      continue
    }
    if (isConfirmedProjectPermanentDeletionEffect(effect)) {
      records.push(await recoverConfirmedProjectPermanentDeletionArtifact(effect, rootDir))
      continue
    }
    if (isConfirmedProviderProfileOperationEffect(effect)) {
      records.push(await recoverConfirmedProviderProfileOperationArtifact(effect, rootDir))
      continue
    }
    if (isConfirmedPullRequestEffect(effect)) {
      records.push(await registerPullRequestArtifactLifecycle(
        run, effect, workflowRun, authority.provenance, rootDir
      ))
      continue
    }
    if (isConfirmedIssueEffect(effect)) {
      records.push(await registerIssueArtifactLifecycle(
        run, effect, workflowRun, authority.provenance, rootDir
      ))
    }
  }
  return records
}

function assertCanonicalProducerRun(run: TaskRunRecord, workflowRun: WorkflowRunRecord | null): asserts workflowRun is WorkflowRunRecord & { projectId: string } {
  if (!workflowRun?.projectId || workflowRun.id !== run.id || workflowRun.sessionId !== run.sessionId ||
      workflowRun.taskId !== run.taskId || workflowRun.taskRun.id !== run.id ||
      workflowRun.taskRun.sessionId !== run.sessionId) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Artifact producer lacks matching canonical Project-owned Run: ${run.id}`
    )
  }
}

function assertCanonicalProducerEffect(
  effect: EffectRecord,
  workflowRun: WorkflowRunRecord
): void {
  const persisted = workflowRun.taskRun.effects?.find((candidate) => candidate.id === effect.id)
  if (!persisted || !effectRecordIntegrityMatches(effect) || !effectRecordIntegrityMatches(persisted) ||
      persistedEffectDigest(persisted) !== persistedEffectDigest(effect)) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Artifact producer Effect differs from canonical persisted Run: ${effect.id}`
    )
  }
}

function persistedEffectDigest(effect: EffectRecord): string {
  // SQLite stores the Effect as JSON, where optional `undefined` fields are omitted.
  // Compare the exact durable representation so an in-memory object cannot forge
  // persisted values while harmless pre-serialization shape differences are ignored.
  return stableValueDigest(JSON.parse(JSON.stringify(effect)) as EffectRecord)
}

type CodeForgePatchEffect = EffectRecord & {
  target: Extract<EffectRecord['target'], { kind: 'code_forge_patch' }>
}

function isConfirmedCodeForgePatchEffect(effect: EffectRecord): effect is CodeForgePatchEffect {
  return effect.status === 'confirmed' && effect.target.kind === 'code_forge_patch'
}

async function registerCodeForgePatchLifecycle(
  run: TaskRunRecord,
  effect: CodeForgePatchEffect,
  workflowRun: WorkflowRunRecord & { projectId: string },
  provenance: WorkflowProjectionSource,
  rootDir?: string
): Promise<ArtifactLifecycleRecord> {
  assertEffectOwnership(run, effect)
  const artifactId = `artifact:code-forge-patch:${effect.id}`
  const digest = assertSha256Digest(`sha256:${effect.target.patchSha256}`)
  const existing = await getPersistedArtifactLifecycle(artifactId, rootDir)
  if (existing) {
    assertExistingProducerArtifact(existing, run.id, digest, effect.target.artifactPath)
  }
  const observedAt = existing?.createdAt ?? effect.terminalAt ?? effect.updatedAt
  const registered = await registerCanonicalProducedArtifact({
    lifecycle: {
      id: artifactId,
      projectId: workflowRun.projectId,
      goalId: workflowRun.goalId,
      workItemId: workflowRun.workItemId,
      runId: workflowRun.id,
      lineageId: `lineage:code-forge-patch:${effect.id}`,
      kind: 'patch',
      title: 'Code Forge patch',
      version: existing?.version ?? 1,
      provenance,
      mediaType: 'text/x-diff',
      retention: { mode: 'retain' },
      content: {
        storageKind: 'source_ref',
        sourceRef: effect.target.artifactPath,
        expectedDigest: digest
      },
      metadata: {
        producer: 'code_forge_delivery',
        effectId: effect.id,
        toolUseId: effect.toolUseId,
        targetKind: effect.target.targetKind,
        patchBytes: effect.target.patchBytes,
        changedPathCount: effect.target.changedPaths.length
      },
      createdAt: observedAt
    },
    evidence: {
      id: `evidence:code-forge-patch:${effect.id}`,
      kind: 'delivery_check',
      title: 'Code Forge patch integrity',
      summary: 'The confirmed Code Forge patch bytes match the frozen Effect digest and creating Run ownership.',
      verifier: 'code-forge-delivery',
      metadata: {
        effectId: effect.id,
        changedPathCount: effect.target.changedPaths.length
      }
    },
    acceptance: {
      id: `acceptance:code-forge-patch:${effect.id}`,
      criterionId: `criterion:code-forge-patch:${effect.id}:integrity`,
      criterion: 'The Code Forge patch is available and matches its frozen Effect digest and Project ownership.',
      status: 'passed',
      verifier: 'code-forge-delivery'
    },
    attachToStage: true
  }, rootDir)
  return registered.lifecycle
}

type FileArtifactEffect = EffectRecord & {
  target: Extract<EffectRecord['target'], { kind: 'file_content' }>
}

function isConfirmedFileArtifactEffect(effect: EffectRecord): effect is FileArtifactEffect {
  return effect.status === 'confirmed' && effect.target.kind === 'file_content' &&
    (effect.target.expectedState ?? 'file') === 'file'
}

async function registerFileArtifactLifecycle(
  run: TaskRunRecord,
  effect: FileArtifactEffect,
  workflowRun: WorkflowRunRecord & { projectId: string },
  workItem: WorkflowWorkItemRecord,
  authority: Awaited<ReturnType<typeof resolveArtifactProjectionAuthority>>,
  rootDir?: string
): Promise<ArtifactLifecycleRecord> {
  assertEffectOwnership(run, effect)
  const outputPath = resolvedFileArtifactPath(effect)
  const kind = inferFileArtifactKind(outputPath, workItem)
  const [binding] = await registerSessionProducedArtifacts({
    sessionId: run.sessionId,
    projectId: workflowRun.projectId,
    creatingRunId: workflowRun.id,
    producerInvocationId: effect.id,
    artifacts: [{
      kind,
      title: basename(outputPath),
      content: {
        storageKind: 'source_ref',
        sourceRef: outputPath,
        expectedDigest: `sha256:${effect.target.expectedSha256}`
      },
      lineageKey: `file:${effect.target.relativePath}`,
      mediaType: fileArtifactMediaType(outputPath),
      provenance: authority.provenance,
      producer: 'confirmed_file_effect',
      metadata: {
        effectId: effect.id,
        toolUseId: effect.toolUseId,
        relativePath: effect.target.relativePath,
        expectedBytes: effect.target.expectedBytes
      },
      evidenceKind: workItem.type === 'testing' ? 'test_result' : 'delivery_check',
      evidenceSummary:
        'The confirmed file output is available and matches the exact bytes frozen by its Effect.',
      evidenceVerifier: 'file-effect-runtime',
      acceptanceCriterion:
        'The produced file is available and matches its confirmed Effect digest, size and Project ownership.',
      attachToStage: authority.attachToStage,
      createdAt: effect.terminalAt ?? effect.updatedAt
    }],
    rootInput: rootDir
  })
  const lifecycle = await getPersistedArtifactLifecycle(binding.artifactId, rootDir)
  if (!lifecycle) {
    throw new WorkflowLedgerCorruptionError(`confirmed file Artifact lifecycle is missing: ${binding.artifactId}`)
  }
  return lifecycle
}

function resolvedFileArtifactPath(effect: FileArtifactEffect): string {
  const root = resolve(effect.target.rootPath)
  const output = resolve(root, effect.target.relativePath)
  const child = relative(root, output)
  if (!child || child === '..' || child.startsWith(`..${sep}`)) {
    throw new WorkflowLedgerCorruptionError(`confirmed file Artifact leaves its frozen root: ${effect.id}`)
  }
  return output
}

function inferFileArtifactKind(
  path: string,
  workItem: WorkflowWorkItemRecord
): WorkflowArtifactKind {
  const extension = extname(path).toLowerCase()
  const name = basename(path).toLowerCase()
  if (extension === '.patch') return 'patch'
  if (extension === '.diff') return 'diff'
  if (['.dmg', '.pkg', '.zip', '.msi', '.exe', '.appimage', '.deb', '.rpm'].includes(extension)) {
    return 'release_package'
  }
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) {
    return /(?:screen|screenshot|capture|snapshot)/.test(name) ? 'screenshot' : 'design'
  }
  if (extension === '.pdf') return 'pdf'
  if (extension === '.docx') return 'document'
  if (extension === '.xlsx') return 'spreadsheet'
  if (extension === '.pptx') return 'presentation'
  if (/(?:requirement|requirements|prd|specification|spec)\b/.test(name)) return 'requirement'
  if (workItem.type === 'research' || workItem.type === 'analysis') return 'report'
  if (workItem.type === 'planning') return 'requirement'
  if (workItem.type === 'design') return 'design'
  if (workItem.type === 'testing') return 'test_report'
  if (workItem.type === 'writing' || workItem.type === 'documentation') return 'document'
  if (workItem.type === 'coding' || CODE_EXTENSIONS.has(extension)) return 'code'
  if (workItem.type === 'delivery') return 'report'
  return 'source'
}

const CODE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js',
  '.jsx', '.kt', '.kts', '.m', '.mm', '.php', '.py', '.rb', '.rs', '.sh', '.sql',
  '.swift', '.ts', '.tsx', '.vue'
])

function fileArtifactMediaType(path: string): string | undefined {
  const mediaTypes: Record<string, string> = {
    '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.patch': 'text/x-diff', '.diff': 'text/x-diff',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip', '.dmg': 'application/x-apple-diskimage',
    '.pkg': 'application/vnd.apple.installer+xml'
  }
  return mediaTypes[extname(path).toLowerCase()]
}

type GitDeliveryEffect = EffectRecord & {
  target: Extract<EffectRecord['target'], { kind: 'git_commit' | 'git_merge' | 'git_push' }>
}

interface GitDeliveryManifest {
  schemaVersion: 1
  kind: 'git_commit' | 'git_merge' | 'git_push'
  repositoryDigest: string
  effectId: string
  ref: string
  sha: string
  previousSha?: string
  sourceSha?: string
  remoteDigest?: string
  reconciliationDigest: string
}

function isConfirmedGitDeliveryEffect(effect: EffectRecord): effect is GitDeliveryEffect {
  return effect.status === 'confirmed' &&
    (effect.target.kind === 'git_commit' || effect.target.kind === 'git_merge' ||
      effect.target.kind === 'git_push')
}

async function registerGitDeliveryArtifactLifecycle(
  run: TaskRunRecord,
  effect: GitDeliveryEffect,
  workflowRun: WorkflowRunRecord & { projectId: string },
  provenance: WorkflowProjectionSource,
  rootDir?: string
): Promise<ArtifactLifecycleRecord> {
  assertEffectOwnership(run, effect)
  const artifactId = `artifact:git-delivery:${effect.target.kind}:${effect.id}`
  const existing = await getPersistedArtifactLifecycle(artifactId, rootDir)
  let manifest: GitDeliveryManifest
  let bytes: Buffer
  if (existing) {
    assertExistingGitDeliveryArtifact(existing, run.id)
    const persisted = await readGitDeliveryManifest(existing, rootDir)
    manifest = persisted.manifest
    bytes = persisted.bytes
    assertGitDeliveryManifestMatchesEffect(manifest, effect)
  } else {
    const reconciliation = await reconcileEffect(effect)
    const observation = confirmedReconciliationObservation<Record<string, unknown>>(reconciliation)
    if (reconciliation.kind !== 'confirmed' || !observation ||
        stableValueDigest(observation) !== reconciliation.evidenceDigest) {
      throw new WorkflowLedgerCorruptionError(
        `confirmed Git Effect no longer has a unique verified postcondition: ${effect.id}`
      )
    }
    manifest = buildGitDeliveryManifest(effect, observation, reconciliation.evidenceDigest)
    bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8')
  }
  const lineageId = `lineage:git-delivery:${stableValueDigest({
    schema: 'caogen.git-delivery-lineage.v1',
    repositoryDigest: manifest.repositoryDigest,
    kind: manifest.kind,
    ref: manifest.ref
  })}`
  const previous = existing ? null : await getLatestPersistedArtifactLifecycleByLineage({
      projectId: workflowRun.projectId,
      workItemId: workflowRun.workItemId,
      lineageId,
      kind: 'custom'
    }, rootDir)
  const observedAt = existing?.createdAt ?? effect.terminalAt ?? effect.updatedAt
  const registered = await registerCanonicalProducedArtifact({
    lifecycle: {
      id: artifactId,
      projectId: workflowRun.projectId,
      goalId: workflowRun.goalId,
      workItemId: workflowRun.workItemId,
      runId: workflowRun.id,
      lineageId,
      kind: 'custom',
      title: gitDeliveryTitle(manifest),
      version: existing?.version ?? (previous?.version ?? 0) + 1,
      provenance,
      supersedesId: existing?.supersedesId ?? previous?.artifactId,
      mediaType: 'application/vnd.caogen.git-delivery+json',
      retention: { mode: 'retain' },
      content: { storageKind: 'blob', bytes },
      metadata: {
        producer: 'git_effect_delivery',
        gitDeliveryKind: manifest.kind,
        repositoryDigest: manifest.repositoryDigest,
        effectId: effect.id,
        toolUseId: effect.toolUseId,
        ref: manifest.ref,
        sha: manifest.sha
      },
      createdAt: observedAt
    },
    evidence: {
      id: `evidence:git-delivery:${effect.target.kind}:${effect.id}`,
      kind: 'delivery_check',
      title: `${gitDeliveryTitle(manifest)} postcondition`,
      summary: gitDeliveryEvidenceSummary(manifest),
      verifier: 'effect-reconciler-v1',
      metadata: {
        gitDeliveryKind: manifest.kind,
        repositoryDigest: manifest.repositoryDigest,
        reconciliationDigest: manifest.reconciliationDigest
      }
    },
    acceptance: {
      id: `acceptance:git-delivery:${effect.target.kind}:${effect.id}`,
      criterionId: `criterion:git-delivery:${effect.target.kind}:${effect.id}:postcondition`,
      criterion: gitDeliveryAcceptanceCriterion(manifest.kind),
      status: 'passed',
      verifier: 'effect-reconciler-v1'
    },
    attachToStage: true
  }, rootDir)
  return registered.lifecycle
}

function buildGitDeliveryManifest(
  effect: GitDeliveryEffect,
  observation: Record<string, unknown>,
  reconciliationDigest: string
): GitDeliveryManifest {
  const target = effect.target
  const repositoryDigest = stableValueDigest({
    schema: 'caogen.git-repository-identity.v1',
    repoRoot: target.repoRoot
  })
  if (target.kind === 'git_commit') {
    const candidates = shaArray(observation.candidates)
    if (observation.kind !== target.kind || observation.branch !== target.branch ||
        observation.preHead !== target.preHead || candidates.length !== 1) {
      throw invalidGitObservation(effect.id)
    }
    return {
      schemaVersion: 1,
      kind: target.kind,
      repositoryDigest,
      effectId: effect.id,
      ref: `refs/heads/${target.branch}`,
      sha: candidates[0],
      previousSha: target.preHead,
      reconciliationDigest
    }
  }
  if (target.kind === 'git_push') {
    const observedSha = gitSha(observation.observedSha)
    if (observation.kind !== target.kind || observation.remote !== target.remote ||
        observation.ref !== target.ref || observedSha !== target.intendedSha) {
      throw invalidGitObservation(effect.id)
    }
    return {
      schemaVersion: 1,
      kind: target.kind,
      repositoryDigest,
      effectId: effect.id,
      ref: target.ref,
      sha: observedSha,
      remoteDigest: stableValueDigest({ remote: target.remote, pushUrlDigest: target.pushUrlDigest }),
      reconciliationDigest
    }
  }
  const destinationSha = gitSha(observation.destinationSha)
  const candidates = observation.candidates === undefined ? [] : shaArray(observation.candidates)
  if (observation.kind !== target.kind || observation.destinationRef !== target.destinationRef ||
      observation.preHead !== target.preHead || observation.sourceSha !== target.sourceSha ||
      (!target.sourceWasAncestor && (candidates.length !== 1 || candidates[0] !== destinationSha))) {
    throw invalidGitObservation(effect.id)
  }
  return {
    schemaVersion: 1,
    kind: target.kind,
    repositoryDigest,
    effectId: effect.id,
    ref: target.destinationRef,
    sha: destinationSha,
    previousSha: target.preHead,
    sourceSha: target.sourceSha,
    reconciliationDigest
  }
}

function gitDeliveryTitle(manifest: GitDeliveryManifest): string {
  const label = manifest.kind === 'git_commit' ? 'Git commit'
    : manifest.kind === 'git_merge' ? 'Git merge' : 'Git push receipt'
  return `${label} ${manifest.sha.slice(0, 12)}`
}

function gitDeliveryEvidenceSummary(manifest: GitDeliveryManifest): string {
  if (manifest.kind === 'git_push') {
    return `The remote ref ${manifest.ref} was read back at the exact intended commit ${manifest.sha}.`
  }
  if (manifest.kind === 'git_merge') {
    return `The destination ref ${manifest.ref} contains the verified merge outcome ${manifest.sha}.`
  }
  return `A unique commit ${manifest.sha} matches the frozen parent, staged diff and message digests.`
}

function gitDeliveryAcceptanceCriterion(kind: GitDeliveryManifest['kind']): string {
  if (kind === 'git_push') return 'The frozen remote ref resolves to the exact intended commit SHA.'
  if (kind === 'git_merge') return 'The destination ref has the uniquely verified merge postcondition.'
  return 'The commit is unique, reachable from the frozen branch, and matches the frozen diff and message digests.'
}

function shaArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new WorkflowLedgerCorruptionError('Git reconciliation candidates are invalid')
  const values = value.map(gitSha)
  if (new Set(values).size !== values.length) {
    throw new WorkflowLedgerCorruptionError('Git reconciliation candidates are duplicated')
  }
  return values
}

function gitSha(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new WorkflowLedgerCorruptionError('Git reconciliation SHA is invalid')
  }
  return value
}

function invalidGitObservation(effectId: string): WorkflowLedgerCorruptionError {
  return new WorkflowLedgerCorruptionError(`Git reconciliation observation differs from Effect: ${effectId}`)
}

function assertExistingGitDeliveryArtifact(record: ArtifactLifecycleRecord, runId: string): void {
  if (record.runId !== runId || record.kind !== 'custom' || record.storageKind !== 'blob') {
    throw new WorkflowLedgerCorruptionError(
      `Git delivery Artifact lifecycle differs from creating Run: ${record.artifactId}`
    )
  }
}

async function readGitDeliveryManifest(
  existing: ArtifactLifecycleRecord,
  rootDir?: string
): Promise<{ manifest: GitDeliveryManifest; bytes: Buffer }> {
  const root = resolveLifecycleRoots(rootDir).workflowRoot
  let bytes: Buffer
  let value: unknown
  try {
    bytes = await readFile(artifactBlobPath(root, existing.digest))
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new WorkflowLedgerCorruptionError(
      `Git delivery Artifact manifest is unreadable: ${existing.artifactId}`
    )
  }
  if (!isGitDeliveryManifest(value)) {
    throw new WorkflowLedgerCorruptionError(
      `Git delivery Artifact manifest is invalid: ${existing.artifactId}`
    )
  }
  return { manifest: value, bytes }
}

function assertGitDeliveryManifestMatchesEffect(
  manifest: GitDeliveryManifest,
  effect: GitDeliveryEffect
): void {
  const target = effect.target
  const repositoryDigest = stableValueDigest({
    schema: 'caogen.git-repository-identity.v1',
    repoRoot: target.repoRoot
  })
  const commonMatches = manifest.kind === target.kind && manifest.effectId === effect.id &&
    manifest.repositoryDigest === repositoryDigest
  const targetMatches = target.kind === 'git_commit'
    ? manifest.ref === `refs/heads/${target.branch}` && manifest.previousSha === target.preHead &&
      manifest.sourceSha === undefined && manifest.remoteDigest === undefined
    : target.kind === 'git_push'
      ? manifest.ref === target.ref && manifest.sha === target.intendedSha &&
        manifest.previousSha === undefined && manifest.sourceSha === undefined &&
        manifest.remoteDigest === stableValueDigest({
          remote: target.remote,
          pushUrlDigest: target.pushUrlDigest
        })
      : manifest.ref === target.destinationRef && manifest.previousSha === target.preHead &&
        manifest.sourceSha === target.sourceSha && manifest.remoteDigest === undefined
  if (!commonMatches || !targetMatches) {
    throw new WorkflowLedgerCorruptionError(
      `Git delivery Artifact manifest differs from creating Effect: ${effect.id}`
    )
  }
}

function isGitDeliveryManifest(value: unknown): value is GitDeliveryManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const allowedKeys = new Set([
    'schemaVersion', 'kind', 'repositoryDigest', 'effectId', 'ref', 'sha',
    'previousSha', 'sourceSha', 'remoteDigest', 'reconciliationDigest'
  ])
  return Object.keys(record).every((key) => allowedKeys.has(key)) &&
    record.schemaVersion === 1 &&
    (record.kind === 'git_commit' || record.kind === 'git_merge' || record.kind === 'git_push') &&
    typeof record.repositoryDigest === 'string' && /^[a-f0-9]{64}$/.test(record.repositoryDigest) &&
    typeof record.effectId === 'string' && record.effectId.length > 0 &&
    typeof record.ref === 'string' && record.ref.length > 0 && isGitSha(record.sha) &&
    (record.previousSha === undefined || isGitSha(record.previousSha)) &&
    (record.sourceSha === undefined || isGitSha(record.sourceSha)) &&
    (record.remoteDigest === undefined ||
      (typeof record.remoteDigest === 'string' && /^[a-f0-9]{64}$/.test(record.remoteDigest))) &&
    typeof record.reconciliationDigest === 'string' && /^[a-f0-9]{64}$/.test(record.reconciliationDigest)
}

function isGitSha(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
}

type PullRequestArtifactEffect = EffectRecord & {
  target: Extract<EffectRecord['target'], { kind: 'pull_request_create' }>
}

type IssueArtifactEffect = EffectRecord & {
  target: Extract<EffectRecord['target'], { kind: 'issue_create' }>
}

function isConfirmedPullRequestEffect(effect: EffectRecord): effect is PullRequestArtifactEffect {
  return effect.status === 'confirmed' && effect.target.kind === 'pull_request_create'
}

function isConfirmedIssueEffect(effect: EffectRecord): effect is IssueArtifactEffect {
  return effect.status === 'confirmed' && effect.target.kind === 'issue_create'
}

interface RemoteArtifactManifest {
  schemaVersion: 1
  kind: 'pull_request' | 'issue'
  provider: 'github' | 'gitlab'
  repositoryDigest: string
  remoteId: string
  url: string
  markerDigest: string
  sourceBranch?: string
  sourceSha?: string
  baseBranch?: string
  titleDigest: string
  bodyDigest: string
  labelsDigest?: string
}

async function registerPullRequestArtifactLifecycle(
  run: TaskRunRecord,
  effect: PullRequestArtifactEffect,
  workflowRun: WorkflowRunRecord & { projectId: string },
  provenance: WorkflowProjectionSource,
  rootDir?: string
): Promise<ArtifactLifecycleRecord> {
  assertEffectOwnership(run, effect)
  const artifactId = `artifact:pull-request:${effect.id}`
  const existing = await getPersistedArtifactLifecycle(artifactId, rootDir)
  const manifest = existing
    ? await readRemoteArtifactManifest(existing, rootDir, 'pull_request')
    : await observePullRequestManifest(effect)
  return registerRemoteArtifact(
    effect,
    workflowRun,
    provenance,
    manifest,
    artifactId,
    existing,
    rootDir
  )
}

async function registerIssueArtifactLifecycle(
  run: TaskRunRecord,
  effect: IssueArtifactEffect,
  workflowRun: WorkflowRunRecord & { projectId: string },
  provenance: WorkflowProjectionSource,
  rootDir?: string
): Promise<ArtifactLifecycleRecord> {
  assertEffectOwnership(run, effect)
  const artifactId = `artifact:issue:${effect.id}`
  const existing = await getPersistedArtifactLifecycle(artifactId, rootDir)
  const manifest = existing
    ? await readRemoteArtifactManifest(existing, rootDir, 'issue')
    : await observeIssueManifest(effect)
  return registerRemoteArtifact(
    effect,
    workflowRun,
    provenance,
    manifest,
    artifactId,
    existing,
    rootDir
  )
}

async function observePullRequestManifest(
  effect: PullRequestArtifactEffect
): Promise<RemoteArtifactManifest> {
  const observation = await queryPullRequestEffectTarget(effect.target)
  if (!observation.complete) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed PR/MR Artifact cannot read its remote result: ${observation.error ?? effect.id}`
    )
  }
  const exact = exactMarkerRecords(effect.target, observation.records)
  if (exact.length !== 1) {
    throw new WorkflowLedgerCorruptionError(`confirmed PR/MR Artifact is not unique: ${effect.id}`)
  }
  const record = exact[0]
  return {
    schemaVersion: 1,
    kind: 'pull_request',
    provider: effect.target.provider,
    repositoryDigest: effect.target.repositoryDigest,
    remoteId: record.id,
    url: record.url,
    markerDigest: stableValueDigest(effect.target.marker),
    sourceBranch: effect.target.sourceBranch,
    sourceSha: effect.target.sourceSha,
    baseBranch: effect.target.baseBranch,
    titleDigest: effect.target.titleDigest,
    bodyDigest: effect.target.bodyDigest
  }
}

async function observeIssueManifest(effect: IssueArtifactEffect): Promise<RemoteArtifactManifest> {
  const observation = await queryIssueEffectTarget(effect.target)
  if (!observation.complete) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Issue Artifact cannot read its remote result: ${observation.error ?? effect.id}`
    )
  }
  const exact = exactIssueMarkerRecords(effect.target, observation.records)
  if (exact.length !== 1) {
    throw new WorkflowLedgerCorruptionError(`confirmed Issue Artifact is not unique: ${effect.id}`)
  }
  const record = exact[0]
  return {
    schemaVersion: 1,
    kind: 'issue',
    provider: effect.target.provider,
    repositoryDigest: effect.target.repositoryDigest,
    remoteId: record.id,
    url: record.url,
    markerDigest: stableValueDigest(effect.target.marker),
    titleDigest: effect.target.titleDigest,
    bodyDigest: effect.target.bodyDigest,
    labelsDigest: effect.target.labelsDigest
  }
}

async function readRemoteArtifactManifest(
  existing: ArtifactLifecycleRecord,
  rootDir: string | undefined,
  expectedKind: RemoteArtifactManifest['kind']
): Promise<RemoteArtifactManifest> {
  if (existing.storageKind !== 'blob' || existing.kind !== expectedKind) {
    throw new WorkflowLedgerCorruptionError(`remote Artifact lifecycle storage is invalid: ${existing.artifactId}`)
  }
  const root = resolveLifecycleRoots(rootDir).workflowRoot
  let value: unknown
  try {
    value = JSON.parse(await readFile(artifactBlobPath(root, existing.digest), 'utf8'))
  } catch {
    throw new WorkflowLedgerCorruptionError(`remote Artifact manifest is unreadable: ${existing.artifactId}`)
  }
  if (!isRemoteArtifactManifest(value) || value.kind !== expectedKind) {
    throw new WorkflowLedgerCorruptionError(`remote Artifact manifest is invalid: ${existing.artifactId}`)
  }
  return value
}

async function registerRemoteArtifact(
  effect: PullRequestArtifactEffect | IssueArtifactEffect,
  workflowRun: WorkflowRunRecord & { projectId: string },
  provenance: WorkflowProjectionSource,
  manifest: RemoteArtifactManifest,
  artifactId: string,
  existing: ArtifactLifecycleRecord | null,
  rootDir?: string
): Promise<ArtifactLifecycleRecord> {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const label = manifest.kind === 'pull_request' ? 'PR/MR' : 'Issue'
  const observedAt = existing?.createdAt ?? effect.terminalAt ?? effect.updatedAt
  const registered = await registerCanonicalProducedArtifact({
    lifecycle: {
      id: artifactId,
      projectId: workflowRun.projectId,
      goalId: workflowRun.goalId,
      workItemId: workflowRun.workItemId,
      runId: workflowRun.id,
      lineageId: `lineage:${manifest.kind}:${effect.id}`,
      kind: manifest.kind,
      title: manifest.kind === 'pull_request'
        ? `${manifest.provider} PR/MR: ${manifest.sourceBranch} -> ${manifest.baseBranch}`
        : `${manifest.provider} Issue ${manifest.remoteId}`,
      version: existing?.version ?? 1,
      provenance,
      mediaType: 'application/vnd.caogen.remote-artifact+json',
      retention: { mode: 'retain' },
      content: { storageKind: 'blob', bytes },
      metadata: {
        producer: 'remote_git_delivery',
        effectId: effect.id,
        toolUseId: effect.toolUseId,
        provider: manifest.provider,
        repositoryDigest: manifest.repositoryDigest,
        remoteId: manifest.remoteId,
        externalUrl: manifest.url
      },
      createdAt: observedAt
    },
    evidence: {
      id: `evidence:${manifest.kind}:${effect.id}`,
      kind: 'delivery_check',
      title: `${label} remote readback`,
      summary: `A unique exact-marker ${label} was read back from ${manifest.provider}: ${manifest.url}`,
      verifier: 'remote-git-reconciler',
      uri: manifest.url,
      metadata: {
        provider: manifest.provider,
        remoteId: manifest.remoteId,
        repositoryDigest: manifest.repositoryDigest
      }
    },
    acceptance: {
      id: `acceptance:${manifest.kind}:${effect.id}`,
      criterionId: `criterion:${manifest.kind}:${effect.id}:remote-readback`,
      criterion: `The ${label} exists as one exact-marker remote record and its canonical URL is available.`,
      status: 'passed',
      verifier: 'remote-git-reconciler'
    },
    externalLocation: {
      id: `artifact-location:${manifest.kind}:${effect.id}:remote`,
      kind: 'url',
      uri: manifest.url,
      metadata: { provider: manifest.provider, remoteId: manifest.remoteId }
    },
    attachToStage: true
  }, rootDir)
  return registered.lifecycle
}

function isRemoteArtifactManifest(value: unknown): value is RemoteArtifactManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.schemaVersion === 1 && (record.kind === 'pull_request' || record.kind === 'issue') &&
    (record.provider === 'github' || record.provider === 'gitlab') &&
    typeof record.repositoryDigest === 'string' && typeof record.remoteId === 'string' &&
    typeof record.url === 'string' && /^https?:\/\//.test(record.url) &&
    typeof record.markerDigest === 'string' && typeof record.titleDigest === 'string' &&
    typeof record.bodyDigest === 'string'
}

function assertEffectOwnership(run: TaskRunRecord, effect: EffectRecord): void {
  if (effect.runId !== run.id || effect.sessionId !== run.sessionId) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Artifact Effect ownership differs from Run: ${effect.id}`
    )
  }
  if (effect.target.kind === 'code_forge_patch' &&
      effect.target.sessionId && effect.target.sessionId !== run.sessionId) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Code Forge Artifact session differs from Run: ${effect.id}`
    )
  }
}

function assertExistingProducerArtifact(
  record: ArtifactLifecycleRecord,
  runId: string,
  digest: string,
  sourceRef: string
): void {
  if (record.runId !== runId || record.kind !== 'patch' || record.digest !== digest ||
      record.storageKind !== 'source_ref' || record.sourceRef !== sourceRef) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Code Forge Artifact lifecycle differs from producer output: ${record.artifactId}`
    )
  }
}

async function registerConfirmedOfficeOutput(input: { run: TaskRunRecord; effect: EffectRecord; workflowRun: WorkflowRunRecord & { projectId: string }; provenance: WorkflowProjectionSource; rootDir?: string }): Promise<ArtifactLifecycleRecord | undefined> {
  const { run, effect, workflowRun, provenance, rootDir } = input
  if (isConfirmedOfficeRevisionEffect(effect)) return registerOfficeRevisionLifecycle({ ...input, effect })
  if (isConfirmedOfficeArtifactEffect(effect)) return registerOfficeArtifactLifecycle(run, effect, workflowRun, provenance, rootDir)
  return undefined
}
