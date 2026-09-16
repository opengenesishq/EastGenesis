import { createHash } from 'node:crypto'
import type {
  OutboundContextItemView,
  OutboundContextManifest,
  OutboundContextReceiverView,
  ProviderView,
  SendMessagePayload,
  SessionMeta
} from '../../shared/types'
import { listProviders } from '../providers'
import { getSettings } from '../settings'
import {
  buildProjectResourceContext,
  projectResourcePolicyDigest,
  type ProjectResourceContext
} from './resource-context'
import { openProjectWorkspaceStore } from './store'

export type OutboundContextPolicyErrorCode =
  | 'OUTBOUND_CONTEXT_DENIED'
  | 'OUTBOUND_CONTEXT_STALE'

export class OutboundContextPolicyError extends Error {
  readonly name = 'OutboundContextPolicyError'

  constructor(readonly code: OutboundContextPolicyErrorCode, message: string) {
    super(message)
  }
}

export interface PreparedOutboundContext {
  resourceContext: ProjectResourceContext
  manifest: OutboundContextManifest
}

interface PrepareOutboundContextInput {
  meta: Pick<SessionMeta, 'id' | 'projectId' | 'workspaceId' | 'providerId' | 'model' | 'engine' | 'routingScope'>
  rootDir: string
  payload: Pick<SendMessagePayload, 'text' | 'images' | 'documents'>
  providerId?: string
  model?: string
  additionalItems?: OutboundContextItemView[]
  now?: number
}

export async function prepareOutboundContext(
  input: PrepareOutboundContextInput
): Promise<PreparedOutboundContext> {
  const resourceContext = await buildProjectResourceContext(input.meta, input.rootDir)
  const receiver = resolveOutboundContextReceiver(
    input.providerId ?? input.meta.providerId,
    input.model ?? input.meta.model,
    input.meta.engine
  )
  const items = [
    ...messageContextItems(input.payload),
    ...resourceContext.items,
    ...(input.additionalItems ?? [])
  ]
  const evaluation = evaluateOutboundContextPolicy(items, receiver)
  const generatedAt = input.now ?? Date.now()
  const routingMayChangeReceiver =
    input.meta.routingScope === 'global' ||
    input.meta.routingScope === 'provider' ||
    getSettings().failoverEnabled
  const body = {
    schemaVersion: 1 as const,
    generatedAt,
    sessionId: input.meta.id,
    ...(resourceContext.projectId ? { projectId: resourceContext.projectId } : {}),
    ...(resourceContext.projectRevision !== undefined
      ? { projectRevision: resourceContext.projectRevision }
      : {}),
    ...(resourceContext.projectPolicyDigest
      ? { projectPolicyDigest: resourceContext.projectPolicyDigest }
      : {}),
    ...(resourceContext.promptDigest
      ? { resourceContextDigest: resourceContext.promptDigest }
      : {}),
    receiver,
    dataClasses: [...new Set(items.filter((item) => item.decision === 'included').map((item) => item.dataClass))]
      .sort(),
    items,
    scopeCompleteness: 'partial' as const,
    blocked: evaluation.blockReasons.length > 0,
    blockReasons: evaluation.blockReasons,
    failoverAllowed: evaluation.failoverAllowed,
    routingMayChangeReceiver
  }
  return {
    resourceContext,
    manifest: {
      ...body,
      manifestDigest: digestManifestBody(body)
    }
  }
}

export async function previewOutboundContext(
  meta: PrepareOutboundContextInput['meta'],
  rootDir: string,
  payload: Pick<SendMessagePayload, 'text' | 'images' | 'documents'>
): Promise<OutboundContextManifest> {
  return (await prepareOutboundContext({ meta, rootDir, payload })).manifest
}

/** Revalidates the frozen resource policy immediately before a Provider attempt. */
export async function assertOutboundContextAllowed(input: {
  manifest: OutboundContextManifest
  rootDir: string
  providerId: string
  model: string
  engine?: SessionMeta['engine']
}): Promise<void> {
  assertManifestDigest(input.manifest)
  await assertProjectPolicyIsCurrent(input.manifest, input.rootDir)
  const receiver = resolveOutboundContextReceiver(input.providerId, input.model, input.engine)
  if (!input.manifest.failoverAllowed && receiver.providerId !== input.manifest.receiver.providerId) {
    throw new OutboundContextPolicyError(
      'OUTBOUND_CONTEXT_DENIED',
      `外发策略已冻结接收方 ${input.manifest.receiver.providerName}，禁止自动切换到 ${receiver.providerName}`
    )
  }
  const evaluation = evaluateOutboundContextPolicy(input.manifest.items, receiver)
  if (evaluation.blockReasons.length > 0) {
    throw new OutboundContextPolicyError(
      'OUTBOUND_CONTEXT_DENIED',
      `外发策略拒绝向 ${receiver.providerName} 发送上下文: ${evaluation.blockReasons.join('；')}`
    )
  }
}

/** Main-only addition of a durable recovery observation; preserve every prior resource and egress constraint. */
export function appendOutboundContextItems(manifest: OutboundContextManifest, additional: OutboundContextItemView[]): OutboundContextManifest {
  assertManifestDigest(manifest)
  for (const item of additional) {
    const prior = manifest.items.find(candidate => candidate.id === item.id)
    if (prior && (prior.kind !== item.kind || prior.dataClass !== item.dataClass || prior.egressPolicy !== item.egressPolicy || prior.decision !== item.decision)) {
      throw new OutboundContextPolicyError('OUTBOUND_CONTEXT_DENIED', '恢复上下文不得覆盖已有资料的外发限制')
    }
  }
  const replacementIds = new Set(additional.map(item => item.id))
  const items = [...manifest.items.filter(item => !replacementIds.has(item.id)), ...additional]
  const evaluation = evaluateOutboundContextPolicy(items, manifest.receiver)
  const { manifestDigest: _previousDigest, ...prior } = manifest
  const body = { ...prior, items,
    dataClasses: [...new Set(items.filter(item => item.decision === 'included').map(item => item.dataClass))].sort(),
    blocked: evaluation.blockReasons.length > 0, blockReasons: evaluation.blockReasons,
    failoverAllowed: manifest.failoverAllowed && evaluation.failoverAllowed }
  return { ...body, manifestDigest: digestManifestBody(body) }
}

export function providerAllowedByOutboundContext(
  manifest: OutboundContextManifest | undefined,
  provider: ProviderView,
  model: string
): boolean {
  if (!manifest) return true
  if (!manifest.failoverAllowed && provider.id !== manifest.receiver.providerId) return false
  const receiver = receiverFromProvider(provider, model)
  return evaluateOutboundContextPolicy(manifest.items, receiver).blockReasons.length === 0
}

export function resolveOutboundContextReceiver(
  providerId: string | undefined,
  model: string | undefined,
  engine?: SessionMeta['engine']
): OutboundContextReceiverView {
  const normalizedProviderId = providerId?.trim() ?? ''
  const provider = listProviders().find((candidate) => candidate.id === normalizedProviderId)
  if (provider) return receiverFromProvider(provider, model ?? '')
  return {
    providerId: normalizedProviderId || 'unknown',
    providerName: normalizedProviderId || 'Unknown Provider',
    engine: engine ?? 'unknown',
    model: model?.trim() || 'unknown',
    endpointOrigin: defaultEndpointOrigin(engine),
    locality: 'unknown'
  }
}

function receiverFromProvider(provider: ProviderView, model: string): OutboundContextReceiverView {
  const endpointOrigin = endpointOriginForProvider(provider)
  return {
    providerId: provider.id,
    providerName: provider.name,
    engine: provider.engine,
    model: model.trim() || 'unknown',
    endpointOrigin,
    locality: endpointLocality(endpointOrigin)
  }
}

function evaluateOutboundContextPolicy(
  items: readonly OutboundContextItemView[],
  receiver: OutboundContextReceiverView
): { blockReasons: string[]; failoverAllowed: boolean } {
  const included = items.filter((item) => item.decision === 'included')
  const blockReasons: string[] = []
  if (receiver.locality === 'unknown') blockReasons.push('Provider 接收方未知')
  const s3 = included.find((item) => item.dataClass === 'S3')
  if (s3) blockReasons.push(`${s3.label} 属于 S3，禁止进入 Provider 请求`)
  const localOnly = included.find((item) => item.egressPolicy === 'local_only')
  if (localOnly && receiver.locality !== 'local') {
    blockReasons.push(`${localOnly.label} 仅允许发送到本机回环 Provider`)
  }
  return {
    blockReasons: [...new Set(blockReasons)],
    failoverAllowed: !included.some((item) => item.egressPolicy === 'local_only')
  }
}

async function assertProjectPolicyIsCurrent(
  manifest: OutboundContextManifest,
  rootDir: string
): Promise<void> {
  if (!manifest.projectId) return
  const workspace = await (await openProjectWorkspaceStore(rootDir)).getWorkspace(manifest.projectId)
  if (!workspace || workspace.status !== 'active') {
    throw new OutboundContextPolicyError(
      'OUTBOUND_CONTEXT_STALE',
      '项目已不存在或不再处于活动状态，已阻止使用旧外发上下文'
    )
  }
  const digest = projectResourcePolicyDigest(workspace)
  if (
    workspace.revision !== manifest.projectRevision ||
    digest !== manifest.projectPolicyDigest
  ) {
    throw new OutboundContextPolicyError(
      'OUTBOUND_CONTEXT_STALE',
      '项目资源或外发策略已变化，已阻止使用旧外发上下文；请重新发送'
    )
  }
}

function assertManifestDigest(manifest: OutboundContextManifest): void {
  const { manifestDigest, ...body } = manifest
  if (digestManifestBody(body) !== manifestDigest) {
    throw new OutboundContextPolicyError(
      'OUTBOUND_CONTEXT_STALE',
      '外发上下文清单摘要不匹配，已阻止发送'
    )
  }
}

function messageContextItems(
  payload: Pick<SendMessagePayload, 'text' | 'images' | 'documents'>
): OutboundContextItemView[] {
  const items: OutboundContextItemView[] = []
  if (payload.text.trim()) {
    items.push({
      id: 'message:user-prompt',
      kind: 'user_prompt',
      label: 'User prompt',
      dataClass: 'S2',
      egressPolicy: 'allow',
      decision: 'included',
      bytes: Buffer.byteLength(payload.text, 'utf8'),
      digest: `sha256:${createHash('sha256').update(payload.text).digest('hex')}`
    })
  }
  for (const [index, image] of (payload.images ?? []).entries()) {
    items.push({
      id: `message:image:${image.id}`,
      kind: 'image_attachment',
      label: `Image attachment ${index + 1}`,
      dataClass: 'S2',
      egressPolicy: 'allow',
      decision: 'included',
      bytes: image.bytes,
      digest: image.hash ? `sha256:${image.hash}` : undefined
    })
  }
  for (const [index, document] of (payload.documents ?? []).entries()) {
    items.push({
      id: `message:document:${document.id}`,
      kind: 'document_attachment',
      label: `Document attachment ${index + 1}`,
      dataClass: document.dataClass,
      egressPolicy: document.dataClass === 'S3' ? 'deny' : 'allow',
      decision: 'included',
      bytes: document.bytes,
      digest: document.hash ? `sha256:${document.hash}` : undefined
    })
  }
  return items
}

function endpointOriginForProvider(provider: ProviderView): string {
  const raw = provider.baseUrl.trim() || defaultEndpointOrigin(provider.engine)
  try {
    const parsed = new URL(raw)
    return parsed.origin
  } catch {
    return 'unknown'
  }
}

function defaultEndpointOrigin(engine: SessionMeta['engine'] | undefined): string {
  if (engine === 'anthropic') return 'https://api.anthropic.com'
  if (engine === 'gemini') return 'https://generativelanguage.googleapis.com'
  if (engine === 'openai') return 'https://api.openai.com'
  return 'unknown'
}

function endpointLocality(origin: string): OutboundContextReceiverView['locality'] {
  try {
    const hostname = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
      ? 'local'
      : 'remote'
  } catch {
    return 'unknown'
  }
}

function digestManifestBody(value: Omit<OutboundContextManifest, 'manifestDigest'>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}
