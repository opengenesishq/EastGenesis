import type {
  ProjectAggregateExportBundle,
  ProjectAggregateSnapshot
} from '../../shared/project-aggregate-types'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROJECT_AGGREGATE_EXPORT_FORMAT,
  PROJECT_AGGREGATE_SCHEMA_VERSION
} from '../../shared/project-aggregate-types'
import {
  assertNoCredentialMaterial,
  projectAggregateCanonicalJson,
  projectAggregateDigest
} from '../project-aggregate/codec'
import { verifyProjectAggregateSnapshot } from '../project-aggregate/project-ownership-verifier'
import { validateProjectRoutineSlice } from '../routines/routine-project-store'
import { projectLearningNamespaceDigest } from '../project-aggregate/project-memory-adapter'
import { isLocalProjectWorkspaceAuthorityEvent } from '../project-workspace/ledger-import-authority'
import { validateProjectPortableRuntime } from './project-portable-runtime'
import { MEDIA_SCHEMA_VERSION } from '../../shared/media-types'
import { normalizeMediaProjectSliceForImport } from '../media/media-store'

export function parseProjectAggregateImport(value: unknown): ProjectAggregateExportBundle {
  const parsed = typeof value === 'string' ? parseJson(value) : structuredClone(value)
  if (!isRecord(parsed) || parsed.schemaVersion !== PROJECT_AGGREGATE_SCHEMA_VERSION ||
      parsed.format !== PROJECT_AGGREGATE_EXPORT_FORMAT || !isRecord(parsed.aggregate) ||
      !isRecord(parsed.dependencies) || !Array.isArray(parsed.dependencies.roleTemplates) ||
      !isRecord(parsed.verification) || typeof parsed.exportDigest !== 'string') {
    throw new Error('Project import must be an EastGenesis Project Aggregate export')
  }
  const sourceBundle = parsed as unknown as ProjectAggregateExportBundle
  const { exportDigest, ...body } = sourceBundle
  if (projectAggregateDigest(body) !== exportDigest) throw new Error('Project import export digest mismatch')
  const normalizedBody = sourceBundle.media === undefined
    ? body
    : { ...body, media: normalizeMediaProjectSliceForImport(sourceBundle.media) }
  const bundle = { ...normalizedBody, exportDigest: projectAggregateDigest(normalizedBody) } as ProjectAggregateExportBundle
  verifyProjectAggregateSnapshot(bundle.aggregate)
  validateProjectRoutineSlice(bundle.projectId, bundle.automation)
  validateProjectPortfolioSlice(bundle)
  validateProjectPortableRuntime(bundle)
  validateProjectMediaSlice(bundle)
  assertDependencyClosure(bundle)
  assertVerificationBinding(bundle)
  assertNoCredentialMaterial(bundle)
  return structuredClone(bundle)
}

function validateProjectMediaSlice(bundle: ProjectAggregateExportBundle): void {
  const media = bundle.media
  if (media === undefined) return
  assertImport(isRecord(media), 'Project import Media slice is invalid')
  assertImport(media.schemaVersion === MEDIA_SCHEMA_VERSION, 'Project import Media slice is invalid')
  assertImport(media.projectId === bundle.projectId, 'Project import Media slice is invalid')
  assertImport(Array.isArray(media.productions), 'Project import Media slice is invalid')
  assertImport(Array.isArray(media.jobs), 'Project import Media slice is invalid')
  assertImport(typeof media.mediaDigest === 'string', 'Project import Media slice is invalid')
  const { mediaDigest, ...body } = media
  if (projectAggregateDigest(body) !== mediaDigest) throw new Error('Project import Media slice digest mismatch')
  const productionIds = new Set<string>()
  const shotIds = new Set<string>()
  for (const production of media.productions) {
    assertImport(isRecord(production), 'Project import Media Production ownership is invalid')
    assertImport(production.schemaVersion === MEDIA_SCHEMA_VERSION, 'Project import Media Production ownership is invalid')
    assertImport(production.projectId === bundle.projectId, 'Project import Media Production ownership is invalid')
    assertImport(typeof production.id === 'string', 'Project import Media Production ownership is invalid')
    assertImport(!productionIds.has(production.id), 'Project import Media Production ownership is invalid')
    assertImport(Array.isArray(production.shots), 'Project import Media Production ownership is invalid')
    assertImport(Array.isArray(production.scenes), 'Project import Media Production ownership is invalid')
    assertImport(Array.isArray(production.episodes), 'Project import Media Production ownership is invalid')
    assertImport(Array.isArray(production.assets), 'Project import Media Production ownership is invalid')
    productionIds.add(production.id)
    for (const shot of production.shots) {
      assertImport(isRecord(shot), 'Project import Media Shot identity is invalid')
      assertImport(shot.schemaVersion === MEDIA_SCHEMA_VERSION, 'Project import Media Shot identity is invalid')
      assertImport(typeof shot.id === 'string', 'Project import Media Shot identity is invalid')
      assertImport(!shotIds.has(shot.id), 'Project import Media Shot identity is invalid')
      shotIds.add(shot.id)
    }
  }
  const jobIds = new Set<string>()
  for (const job of media.jobs) {
    assertImport(isRecord(job), 'Project import MediaJob ownership is invalid')
    assertImport(job.schemaVersion === MEDIA_SCHEMA_VERSION, 'Project import MediaJob ownership is invalid')
    assertImport(job.projectId === bundle.projectId, 'Project import MediaJob ownership is invalid')
    assertImport(typeof job.id === 'string', 'Project import MediaJob ownership is invalid')
    assertImport(!jobIds.has(job.id), 'Project import MediaJob ownership is invalid')
    assertImport(typeof job.productionId === 'string', 'Project import MediaJob ownership is invalid')
    assertImport(productionIds.has(job.productionId), 'Project import MediaJob ownership is invalid')
    assertImport(job.shotId === undefined || shotIds.has(String(job.shotId)), 'Project import MediaJob ownership is invalid')
    jobIds.add(job.id)
  }
}

function validateProjectPortfolioSlice(bundle: ProjectAggregateExportBundle): void {
  const portfolio = bundle.portfolio
  if (portfolio === undefined) return
  assertImport(isRecord(portfolio), 'Project import Portfolio slice is invalid')
  assertImport(Array.isArray(portfolio.dependencies), 'Project import Portfolio slice is invalid')
  assertImport(Array.isArray(portfolio.milestones), 'Project import Portfolio slice is invalid')
  const projectId = bundle.projectId
  const projectIds = new Set([projectId])
  for (const dependency of portfolio.dependencies) {
    assertImport(isRecord(dependency), 'Project import Portfolio dependency ownership is invalid')
    assertImport(dependency.schemaVersion === 1, 'Project import Portfolio dependency ownership is invalid')
    assertImport(typeof dependency.id === 'string', 'Project import Portfolio dependency ownership is invalid')
    assertImport(typeof dependency.fromProjectId === 'string', 'Project import Portfolio dependency ownership is invalid')
    assertImport(typeof dependency.toProjectId === 'string', 'Project import Portfolio dependency ownership is invalid')
    assertImport(dependency.status === 'active', 'Project import Portfolio dependency ownership is invalid')
    assertImport(
      dependency.fromProjectId === projectId || dependency.toProjectId === projectId,
      'Project import Portfolio dependency ownership is invalid'
    )
    if (dependency.fromProjectId === dependency.toProjectId) throw new Error('Project import Portfolio contains a self dependency')
    projectIds.add(dependency.fromProjectId)
    projectIds.add(dependency.toProjectId)
  }
  const ids = new Set<string>()
  for (const milestone of portfolio.milestones) {
    assertImport(isRecord(milestone), 'Project import Portfolio milestone ownership is invalid')
    assertImport(milestone.schemaVersion === 1, 'Project import Portfolio milestone ownership is invalid')
    assertImport(typeof milestone.id === 'string', 'Project import Portfolio milestone ownership is invalid')
    assertImport(milestone.projectId === projectId, 'Project import Portfolio milestone ownership is invalid')
    assertImport(typeof milestone.title === 'string', 'Project import Portfolio milestone ownership is invalid')
    assertImport(Number.isFinite(milestone.dueAt), 'Project import Portfolio milestone ownership is invalid')
    assertImport(Number.isSafeInteger(milestone.revision), 'Project import Portfolio milestone ownership is invalid')
    assertImport(Number(milestone.revision) >= 1, 'Project import Portfolio milestone ownership is invalid')
    if (ids.has(milestone.id)) throw new Error(`Project import contains duplicate Portfolio milestone: ${milestone.id}`)
    ids.add(milestone.id)
  }
  assertProjectDependencyAcyclic(portfolio.dependencies)
}

function assertProjectDependencyAcyclic(dependencies: readonly { fromProjectId: string; toProjectId: string }[]): void {
  const graph = new Map<string, string[]>()
  for (const dependency of dependencies) {
    const edges = graph.get(dependency.fromProjectId) ?? []
    edges.push(dependency.toProjectId)
    graph.set(dependency.fromProjectId, edges)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('Project import Portfolio dependency cycle detected')
    if (visited.has(id)) return
    visiting.add(id)
    for (const next of graph.get(id) ?? []) visit(next)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of graph.keys()) visit(id)
}

function assertDependencyClosure(bundle: ProjectAggregateExportBundle): void {
  const roles = bundle.dependencies.roleTemplates
  const roleIds = new Set<string>()
  for (const value of roles) {
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !value.id.trim() ||
        !Number.isSafeInteger(value.version) || Number(value.version) < 1) {
      throw new Error('Project import contains an invalid RoleTemplate dependency')
    }
    if (roleIds.has(value.id)) throw new Error(`Project import contains duplicate RoleTemplate dependency: ${value.id}`)
    roleIds.add(value.id)
  }
  const required = new Set(bundle.aggregate.digitalWorkers.map((worker) => worker.roleTemplateId))
  const missing = [...required].filter((id) => !roleIds.has(id)).sort()
  const unrelated = [...roleIds].filter((id) => !required.has(id)).sort()
  if (missing.length > 0) throw new Error(`Project import is missing RoleTemplate dependencies: ${missing.join(', ')}`)
  if (unrelated.length > 0) throw new Error(`Project import contains unrelated RoleTemplate dependencies: ${unrelated.join(', ')}`)
  for (const worker of bundle.aggregate.digitalWorkers) {
    const role = roles.find((entry) => entry.id === worker.roleTemplateId)
    if (!role || role.version < worker.roleTemplateVersion) {
      throw new Error(`Project import RoleTemplate version is older than DigitalWorker ${worker.id}`)
    }
  }
}

export function projectImportSemanticDigest(aggregate: ProjectAggregateSnapshot): string {
  return projectAggregateDigest(projectImportSemanticProjection(aggregate))
}

/**
 * Produces the portable projection used for source/live equivalence checks.
 * Keep this separate from the digest so recovery failures can report a field
 * path without serializing project content into logs.
 */
export function projectImportSemanticProjection(aggregate: ProjectAggregateSnapshot): unknown {
  return normalizeAggregate(aggregate)
}

/** Returns only the first divergent field path; project values remain private. */
export function projectImportSemanticMismatchPath(
  source: ProjectAggregateSnapshot,
  target: ProjectAggregateSnapshot
): string | undefined {
  const expected = JSON.parse(projectAggregateCanonicalJson(projectImportSemanticProjection(source))) as unknown
  const actual = JSON.parse(projectAggregateCanonicalJson(projectImportSemanticProjection(target))) as unknown
  return firstDifferencePath(expected, actual, '$')
}

function assertVerificationBinding(bundle: ProjectAggregateExportBundle): void {
  const verification = bundle.verification
  const aggregate = bundle.aggregate
  if (bundle.projectId !== aggregate.projectId || verification.projectId !== aggregate.projectId ||
      verification.valid !== true || verification.sanitized !== true || verification.sealed !== true ||
      verification.schemaVersion !== aggregate.schemaVersion ||
      verification.aggregateRevision !== bundle.aggregateRevision ||
      verification.identityDigest !== aggregate.identityDigest ||
      verification.aggregateDigest !== aggregate.aggregateDigest ||
      projectAggregateCanonicalJson(verification.objectCounts) !== projectAggregateCanonicalJson(aggregate.objectCounts)) {
    throw new Error('Project import verification does not bind the exported aggregate')
  }
}

function normalizeAggregate(aggregate: ProjectAggregateSnapshot): unknown {
  const namespaceDigest = projectLearningNamespaceDigest(aggregate.projectId)
  const sourceRefLocations = new Set(aggregate.workflow.artifactLocations
    .filter((location) => isRecord(location.metadata) && location.metadata.storageKind === 'source_ref')
    .map((location) => location.id))
  const sourceRefArtifactIds = new Set(aggregate.workflow.artifactLocations
    .filter((location) => sourceRefLocations.has(location.id))
    .map((location) => location.artifactId))
  return {
    projectId: aggregate.projectId,
    identityDigest: aggregate.identityDigest,
    projectRevision: aggregate.projectRevision,
    workspace: aggregate.workspace,
    resources: aggregate.resources,
    goals: aggregate.goals,
    workItems: aggregate.workItems,
    squads: aggregate.squads,
    members: aggregate.members,
    invitations: aggregate.invitations,
    comments: aggregate.comments,
    sharedApprovals: aggregate.sharedApprovals,
    inboxReceipts: aggregate.inboxReceipts ?? [],
    digitalWorkers: aggregate.digitalWorkers,
    assignments: aggregate.assignments,
    leases: aggregate.leases,
    workflow: {
      ...aggregate.workflow,
      artifactLocations: aggregate.workflow.artifactLocations.map((location) =>
        sourceRefLocations.has(location.id) ? portableLocation(location) : location),
      taskEvidence: aggregate.workflow.taskEvidence.map(stripChain),
      workflowEvidence: aggregate.workflow.workflowEvidence.map((record) => stripChain(
        sourceRefArtifactIds.has(record.artifactId ?? '') && isLocalReference(record.uri)
          ? { ...record, uri: portableSourceRef(record.artifactId as string) }
          : record
      ))
    },
    memory: aggregate.memory.map((entry) => ({
      ...entry,
      namespace: 'project_id',
      namespaceDigest,
      record: { ...entry.record, project: namespaceDigest }
    })),
    budgets: aggregate.budgets,
    policies: aggregate.policies,
    audit: aggregate.audit.filter((entry) =>
      !isLocalWorkspaceAuthorityAudit(entry) && !isPortableRuntimeProjectionAudit(entry)
    ).map((entry) => {
      if (entry.source === 'workflow_ledger') {
        return {
          ...entry,
          value: normalizeWorkflowEvent(entry.value, sourceRefLocations, sourceRefArtifactIds)
        }
      }
      if (entry.source !== 'learning' || !isRecord(entry.value) || !isRecord(entry.value.event)) return entry
      return {
        ...entry,
        id: `learning:${String(entry.value.event.id)}`,
        value: {
          ...entry.value,
          id: String(entry.value.event.id),
          namespace: 'project_id'
        }
      }
    })
  }
}

function isLocalWorkspaceAuthorityAudit(entry: ProjectAggregateSnapshot['audit'][number]): boolean {
  return entry.source === 'workflow_ledger' && isLocalProjectWorkspaceAuthorityEvent(entry.value)
}

/**
 * TaskPlan is exported and verified as a portable runtime slice. Replaying its
 * private contract deterministically restores these Ledger projections, so
 * they cannot also define Aggregate source equivalence.
 */
function isPortableRuntimeProjectionAudit(entry: ProjectAggregateSnapshot['audit'][number]): boolean {
  return entry.source === 'workflow_ledger' && isRecord(entry.value) &&
    typeof entry.value.kind === 'string' && entry.value.kind.startsWith('workflow.task_plan.')
}

function normalizeWorkflowEvent(
  value: unknown,
  sourceRefLocations: ReadonlySet<string>,
  sourceRefArtifactIds: ReadonlySet<string>
): unknown {
  if (!isRecord(value)) return value
  const { seq: _seq, prevDigest: _prevDigest, digest: _digest, payload, ...event } = value
  if (event.kind === 'workflow.artifact.location.created' && isRecord(payload) &&
      sourceRefLocations.has(String(payload.id))) {
    return { ...event, payload: portableLocation(payload) }
  }
  if (event.kind === 'workflow.artifact.lifecycle.registered' && isRecord(payload) &&
      sourceRefArtifactIds.has(String(payload.artifactId))) {
    return { ...event, payload: { ...payload, sourceRef: portableSourceRef(String(payload.artifactId)) } }
  }
  if (event.kind === 'workflow.effect.evidence' && isRecord(payload)) {
    const {
      evidenceSeq: _evidenceSeq,
      taskEvidenceRecordDigest: _recordDigest,
      taskEvidencePrevDigest: _recordPrevDigest,
      ...semanticPayload
    } = payload
    return { ...event, payload: semanticPayload }
  }
  if (event.kind === 'workflow.evidence.recorded') {
    const normalized = isRecord(payload) && sourceRefArtifactIds.has(String(payload.artifactId)) &&
      isLocalReference(typeof payload.uri === 'string' ? payload.uri : undefined)
      ? { ...payload, uri: portableSourceRef(String(payload.artifactId)) }
      : payload
    return { ...event, payload: stripChain(normalized) }
  }
  return { ...event, payload }
}

function portableLocation<T>(value: T): T {
  if (!isRecord(value)) return value
  return {
    ...value,
    path: portableSourceRef(String(value.artifactId)),
    uri: undefined
  } as T
}

function portableSourceRef(artifactId: string): string {
  return `caogen:artifact-source:${artifactId}`
}

function isLocalReference(value: string | undefined): boolean {
  if (!value) return false
  if (isAbsolute(value)) return true
  if (!value.toLowerCase().startsWith('file:')) return false
  try {
    return isAbsolute(fileURLToPath(value))
  } catch {
    return false
  }
}

function stripChain<T>(value: T): unknown {
  if (!isRecord(value)) return value
  const { seq: _seq, prevDigest: _prevDigest, digest: _digest, ...semantic } = value
  return semantic
}

function firstDifferencePath(expected: unknown, actual: unknown, path: string): string | undefined {
  if (Object.is(expected, actual)) return undefined
  if (Array.isArray(expected) || Array.isArray(actual)) return firstArrayDifferencePath(expected, actual, path)
  if (isRecord(expected) || isRecord(actual)) return firstRecordDifferencePath(expected, actual, path)
  return path
}

function firstArrayDifferencePath(expected: unknown, actual: unknown, path: string): string | undefined {
  if (!Array.isArray(expected) || !Array.isArray(actual)) return path
  if (expected.length !== actual.length) return `${path}.length`
  for (let index = 0; index < expected.length; index += 1) {
    const difference = firstDifferencePath(expected[index], actual[index], `${path}[${index}]`)
    if (difference) return difference
  }
  return undefined
}

function firstRecordDifferencePath(expected: unknown, actual: unknown, path: string): string | undefined {
  if (!isRecord(expected) || !isRecord(actual)) return path
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
  for (const key of keys) {
    if (!(key in expected) || !(key in actual)) return `${path}.${key}`
    const difference = firstDifferencePath(expected[key], actual[key], `${path}.${key}`)
    if (difference) return difference
  }
  return undefined
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error('Project import JSON is invalid')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function assertImport(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
