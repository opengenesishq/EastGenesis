import { createHash } from 'node:crypto'
import type {
  OutboundContextItemView,
  OutboundContextManifest,
  TranscriptEntry,
  WorkflowArtifactIntegrityReport
} from '../../shared/types'
import { buildPortableConversationReplay } from '../conversation-ledger-replay'
import { verifyWorkflowArtifactIntegrity } from './workflow-artifact-delivery'

export interface CanonicalArtifactContinuation {
  schemaVersion: 1
  projectId: string
  artifacts: CanonicalArtifactContinuationItem[]
  digest: string
}

export interface CanonicalArtifactContinuationItem {
  artifactId: string
  kind: string
  version: number
  digest: string
  evidence: Array<{
    evidenceId: string
    kind: string
    source: string
    contentDigest: string
  }>
  acceptances: Array<{
    acceptanceId: string
    status: 'passed' | 'waived'
    revision: number
    evidenceRefs: string[]
  }>
}

export interface ProviderNeutralContextInput {
  entries: TranscriptEntry[]
  outboundContext?: OutboundContextManifest
  artifactContinuationDigest?: string
}

/**
 * Hash the EastGenesis-owned semantic context rather than a Provider wire body. The
 * projection deliberately excludes endpoint, model, key, adapter and Session
 * runtime identity so a cross-protocol successor can prove equivalent input.
 */
export function buildProviderNeutralContextDigest(input: ProviderNeutralContextInput): string {
  const replay = buildPortableConversationReplay(input.entries, undefined, { providerNeutral: true })
  return sha256Canonical({
    schemaVersion: 1,
    conversation: replay
      ? {
          digest: sha256Text(replay.text),
          eventCount: replay.eventCount,
          attachmentCount: replay.attachmentCount,
          characters: replay.characters
        }
      : {
          digest: sha256Text(''),
          eventCount: 0,
          attachmentCount: 0,
          characters: 0
        },
    outbound: input.outboundContext
      ? providerNeutralOutboundContext(input.outboundContext)
      : undefined,
    artifactContinuationDigest: input.artifactContinuationDigest
  })
}

/** Read only byte-verified, accepted Artifacts owned by the requested Project. */
export async function readReadyCanonicalArtifactContinuation(input: {
  projectId: string
  artifactIds: readonly string[]
  rootDir?: string
}): Promise<CanonicalArtifactContinuation> {
  const projectId = requiredText(input.projectId, 'Project ID')
  const artifactIds = [...new Set(input.artifactIds.map((value) => requiredText(value, 'Artifact ID')))].sort()
  if (artifactIds.length === 0 || artifactIds.length > 24) {
    throw new Error('Canonical Artifact continuation requires 1-24 unique Artifacts')
  }
  const reports = await Promise.all(artifactIds.map((artifactId) =>
    verifyWorkflowArtifactIntegrity(artifactId, input.rootDir)))
  const artifacts = reports.map((report) => canonicalArtifactItem(projectId, report))
  const body = { schemaVersion: 1 as const, projectId, artifacts }
  return { ...body, digest: sha256Canonical(body) }
}

function canonicalArtifactItem(
  projectId: string,
  report: WorkflowArtifactIntegrityReport
): CanonicalArtifactContinuationItem {
  if (report.artifact.projectId !== projectId) {
    throw new Error(`Artifact ${report.artifact.id} crosses canonical Project continuation scope`)
  }
  if (report.verdict !== 'ready') {
    throw new Error(`Artifact ${report.artifact.id} is not ready for Provider continuation`)
  }
  const acceptances = report.acceptances.map((acceptance) => {
    if (acceptance.status !== 'passed' && acceptance.status !== 'waived') {
      throw new Error(`Artifact ${report.artifact.id} has an unfinished Acceptance`)
    }
    return {
      acceptanceId: acceptance.acceptanceId,
      status: acceptance.status,
      revision: acceptance.revision,
      evidenceRefs: [...acceptance.evidenceRefs].sort()
    }
  }).sort((left, right) => left.acceptanceId.localeCompare(right.acceptanceId))
  return {
    artifactId: report.artifact.id,
    kind: report.artifact.kind,
    version: report.artifact.version,
    digest: report.artifact.digest,
    evidence: report.evidence.map((evidence) => ({
      evidenceId: evidence.evidenceId,
      kind: evidence.kind,
      source: evidence.source,
      contentDigest: evidence.contentDigest
    })).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
    acceptances
  }
}

function providerNeutralOutboundContext(manifest: OutboundContextManifest) {
  return {
    projectId: manifest.projectId,
    projectRevision: manifest.projectRevision,
    projectPolicyDigest: manifest.projectPolicyDigest,
    resourceContextDigest: manifest.resourceContextDigest,
    dataClasses: [...manifest.dataClasses].sort(),
    items: manifest.items
      .map(providerNeutralOutboundItem)
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
    scopeCompleteness: manifest.scopeCompleteness,
    blocked: manifest.blocked,
    failoverAllowed: manifest.failoverAllowed
  }
}

function providerNeutralOutboundItem(item: OutboundContextItemView) {
  return {
    id: item.id,
    kind: item.kind,
    dataClass: item.dataClass,
    egressPolicy: item.egressPolicy,
    decision: item.decision,
    resourceId: item.resourceId,
    bytes: item.bytes,
    digest: item.digest
  }
}

function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalJson(value))
}

function sha256Text(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? 'undefined'
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)])
  )
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}
