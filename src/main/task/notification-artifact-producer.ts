import { readFile } from 'node:fs/promises'
import type { EffectRecord, TaskRunRecord } from '../../shared/types'
import type { WorkflowProjectionSource, WorkflowRunRecord } from '../../shared/workflow-types'
import {
  getPersistedArtifactLifecycle,
  resolveLifecycleRoots
} from './artifact-lifecycle-api'
import { artifactBlobPath } from './artifact-lifecycle-content'
import { registerCanonicalProducedArtifact } from './artifact-production-boundary'
import type { ArtifactLifecycleRecord } from './artifact-lifecycle-types'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'

export type NotificationDeliveryEffect = EffectRecord & {
  target: Extract<EffectRecord['target'], { kind: 'webhook_message_send' }>
}

interface NotificationDeliveryManifest {
  schemaVersion: 1
  kind: 'notification_delivery'
  effectId: string
  channel: 'feishu' | 'dingtalk'
  connectorId: string
  connectorRevision: number
  endpointDigest: string
  payloadDigest: string
  titleDigest: string
  textDigest: string
  linkDigest?: string
  confirmationSource: 'runtime_receipt' | 'human_confirmation'
  confirmationVerifier: string
  confirmationEvidenceDigest: string
}

export function isConfirmedNotificationDeliveryEffect(
  effect: EffectRecord
): effect is NotificationDeliveryEffect {
  return effect.status === 'confirmed' && effect.reconcilability === 'opaque' &&
    effect.target.kind === 'webhook_message_send'
}

export async function registerNotificationDeliveryArtifact(
  run: TaskRunRecord,
  effect: NotificationDeliveryEffect,
  workflowRun: WorkflowRunRecord & { projectId: string },
  provenance: WorkflowProjectionSource,
  rootDir?: string
): Promise<ArtifactLifecycleRecord> {
  assertEffectOwnership(run, effect)
  const artifactId = `artifact:notification-delivery:${effect.id}`
  const existing = await getPersistedArtifactLifecycle(artifactId, rootDir)
  let manifest: NotificationDeliveryManifest
  let bytes: Buffer
  if (existing) {
    assertExistingNotificationArtifact(existing, run.id)
    const persisted = await readNotificationDeliveryManifest(existing, rootDir)
    manifest = persisted.manifest
    bytes = persisted.bytes
  } else {
    manifest = buildNotificationDeliveryManifest(effect)
    bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8')
  }
  assertManifestMatchesEffect(manifest, effect)
  const observedAt = existing?.createdAt ?? effect.terminalAt ?? effect.updatedAt
  const humanConfirmed = manifest.confirmationSource === 'human_confirmation'
  const registered = await registerCanonicalProducedArtifact({
    lifecycle: {
      id: artifactId,
      projectId: workflowRun.projectId,
      goalId: workflowRun.goalId,
      workItemId: workflowRun.workItemId,
      runId: workflowRun.id,
      lineageId: `lineage:notification-delivery:${effect.id}`,
      kind: 'custom',
      title: `${notificationChannelLabel(manifest.channel)} notification receipt`,
      version: existing?.version ?? 1,
      provenance,
      mediaType: 'application/vnd.caogen.notification-receipt+json',
      retention: { mode: 'retain' },
      content: { storageKind: 'blob', bytes },
      metadata: {
        producer: 'notification_delivery',
        effectId: effect.id,
        toolUseId: effect.toolUseId,
        channel: manifest.channel,
        connectorId: manifest.connectorId,
        connectorRevision: manifest.connectorRevision,
        destinationDigest: manifest.endpointDigest,
        confirmationSource: manifest.confirmationSource
      },
      createdAt: observedAt
    },
    evidence: {
      id: `evidence:notification-delivery:${effect.id}`,
      kind: 'delivery_check',
      title: `${notificationChannelLabel(manifest.channel)} notification confirmation`,
      summary: humanConfirmed
        ? 'The opaque notification Effect was explicitly confirmed by a user after automatic readback remained unavailable.'
        : 'The approved notification endpoint returned a channel-specific success receipt for the frozen payload.',
      verifier: manifest.confirmationVerifier,
      metadata: {
        channel: manifest.channel,
        connectorId: manifest.connectorId,
        connectorRevision: manifest.connectorRevision,
        confirmationSource: manifest.confirmationSource,
        effectEvidenceDigest: manifest.confirmationEvidenceDigest
      }
    },
    acceptance: {
      id: `acceptance:notification-delivery:${effect.id}`,
      criterionId: `criterion:notification-delivery:${effect.id}:confirmed`,
      criterion: 'The frozen notification delivery has either a platform success receipt or an explicit human confirmation.',
      status: 'passed',
      verifier: manifest.confirmationVerifier
    },
    attachToStage: true
  }, rootDir)
  return registered.lifecycle
}

function buildNotificationDeliveryManifest(
  effect: NotificationDeliveryEffect
): NotificationDeliveryManifest {
  const confirmation = [...effect.evidence].reverse().find((candidate) =>
    candidate.kind === 'manual_confirmation' || candidate.kind === 'execution_result')
  if (!confirmation) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed notification Effect lacks terminal confirmation Evidence: ${effect.id}`
    )
  }
  const confirmationSource = confirmation.kind === 'manual_confirmation'
    ? 'human_confirmation' as const
    : 'runtime_receipt' as const
  return {
    schemaVersion: 1,
    kind: 'notification_delivery',
    effectId: effect.id,
    channel: effect.target.channel,
    connectorId: effect.target.connectorId,
    connectorRevision: effect.target.connectorRevision,
    endpointDigest: effect.target.webhookDigest,
    payloadDigest: effect.target.payloadDigest,
    titleDigest: effect.target.titleDigest,
    textDigest: effect.target.textDigest,
    ...(effect.target.linkUrlDigest ? { linkDigest: effect.target.linkUrlDigest } : {}),
    confirmationSource,
    confirmationVerifier: confirmation.verifier,
    confirmationEvidenceDigest: confirmation.digest
  }
}

async function readNotificationDeliveryManifest(
  existing: ArtifactLifecycleRecord,
  rootDir?: string
): Promise<{ manifest: NotificationDeliveryManifest; bytes: Buffer }> {
  const root = resolveLifecycleRoots(rootDir).workflowRoot
  let bytes: Buffer
  let value: unknown
  try {
    bytes = await readFile(artifactBlobPath(root, existing.digest))
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new WorkflowLedgerCorruptionError(
      `notification delivery manifest is unreadable: ${existing.artifactId}`
    )
  }
  if (!isNotificationDeliveryManifest(value)) {
    throw new WorkflowLedgerCorruptionError(
      `notification delivery manifest is invalid: ${existing.artifactId}`
    )
  }
  return { manifest: value, bytes }
}

function assertManifestMatchesEffect(
  manifest: NotificationDeliveryManifest,
  effect: NotificationDeliveryEffect
): void {
  const target = effect.target
  const confirmation = [...effect.evidence].reverse().find((candidate) =>
    candidate.kind === 'manual_confirmation' || candidate.kind === 'execution_result')
  const expectedSource = confirmation?.kind === 'manual_confirmation'
    ? 'human_confirmation'
    : 'runtime_receipt'
  if (!confirmation || manifest.effectId !== effect.id || manifest.channel !== target.channel ||
      manifest.connectorId !== target.connectorId || manifest.connectorRevision !== target.connectorRevision ||
      manifest.endpointDigest !== target.webhookDigest || manifest.payloadDigest !== target.payloadDigest ||
      manifest.titleDigest !== target.titleDigest || manifest.textDigest !== target.textDigest ||
      manifest.linkDigest !== target.linkUrlDigest || manifest.confirmationSource !== expectedSource ||
      manifest.confirmationVerifier !== confirmation.verifier ||
      manifest.confirmationEvidenceDigest !== confirmation.digest) {
    throw new WorkflowLedgerCorruptionError(
      `notification delivery manifest differs from creating Effect: ${effect.id}`
    )
  }
}

function assertExistingNotificationArtifact(record: ArtifactLifecycleRecord, runId: string): void {
  if (record.runId !== runId || record.kind !== 'custom' || record.storageKind !== 'blob') {
    throw new WorkflowLedgerCorruptionError(
      `notification Artifact lifecycle differs from creating Run: ${record.artifactId}`
    )
  }
}

function isNotificationDeliveryManifest(value: unknown): value is NotificationDeliveryManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const allowedKeys = new Set([
    'schemaVersion', 'kind', 'effectId', 'channel', 'connectorId', 'connectorRevision',
    'endpointDigest', 'payloadDigest', 'titleDigest', 'textDigest', 'linkDigest',
    'confirmationSource', 'confirmationVerifier', 'confirmationEvidenceDigest'
  ])
  return Object.keys(record).every((key) => allowedKeys.has(key)) && record.schemaVersion === 1 &&
    record.kind === 'notification_delivery' && typeof record.effectId === 'string' &&
    (record.channel === 'feishu' || record.channel === 'dingtalk') &&
    typeof record.connectorId === 'string' && record.connectorId.length > 0 &&
    Number.isSafeInteger(record.connectorRevision) && (record.connectorRevision as number) > 0 &&
    isDigest(record.endpointDigest) && isDigest(record.payloadDigest) && isDigest(record.titleDigest) &&
    isDigest(record.textDigest) && (record.linkDigest === undefined || isDigest(record.linkDigest)) &&
    (record.confirmationSource === 'runtime_receipt' || record.confirmationSource === 'human_confirmation') &&
    typeof record.confirmationVerifier === 'string' && record.confirmationVerifier.length > 0 &&
    isDigest(record.confirmationEvidenceDigest)
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function assertEffectOwnership(run: TaskRunRecord, effect: EffectRecord): void {
  if (effect.runId !== run.id || effect.sessionId !== run.sessionId) {
    throw new WorkflowLedgerCorruptionError(
      `notification Artifact Effect ownership differs from Run: ${effect.id}`
    )
  }
}

function notificationChannelLabel(channel: NotificationDeliveryManifest['channel']): string {
  if (channel === 'feishu') return 'Feishu'
  return 'DingTalk'
}
