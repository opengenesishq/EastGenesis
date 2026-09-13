import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, openAsBlob } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { MediaJobRecord, MediaProviderProfile, MediaRemoteJobObservation } from '../../shared/media-types'
import { getProvider, issueProviderCredentialLease } from '../providers'
import { fetchWithProviderCredentialLease } from '../providerRuntimeAuth'
import { resolveProviderRuntimeTarget } from '../provider/providerRuntimeTarget'
import { boundMediaCredentialKey, resolveMediaExecutionTarget } from './media-execution-target'
import { mediaEndpointUrl } from './media-endpoint-url'
import { missingMediaReconciliationIdentity } from './media-reconciliation-identity'
import { mediaTransportFailure } from './media-transport-failure'
import { parseProviderHeaders } from '../provider/openai-provider-utils'
import { assertRoutingExpertTargetAllowed } from '../model/routing-expert-policy'
import { getSettings } from '../settings'
import { mediaProjectRoot } from './media-ffmpeg'
import { getMediaStore } from './media-store'
import { getPersistedArtifactLifecycle } from '../task/artifact-lifecycle-api'
import { artifactBlobPath } from '../task/artifact-lifecycle-content'

export interface MediaProviderRuntimeDependencies {
  fetch?: typeof fetch
  now?: () => number
}

export async function executeRemoteMediaOperation(
  profile: MediaProviderProfile,
  job: MediaJobRecord,
  operation: 'submit' | 'poll' | 'download' | 'cancel',
  rootDir: string,
  dependencies: MediaProviderRuntimeDependencies = {}
): Promise<MediaRemoteJobObservation> {
  if (!profile.providerId) throw new Error('Remote media Provider is missing a CaoGen Provider binding')
  const provider = getProvider(profile.providerId)
  if (!provider) throw new Error('Bound CaoGen Provider was not found')
  const target = resolveMediaExecutionTarget(provider, profile, job)
  assertRoutingExpertTargetAllowed(provider.id, target.baseUrl, getSettings().routingExpertPolicy)
  const scope = {
    providerId: provider.id,
    projectId: job.projectId,
    sessionId: `media:${job.id}`,
    operationId: `${job.id}:${operation}:${job.attempt}`
  }
  const unresolved = missingMediaReconciliationIdentity(job, operation)
  if (unresolved) return unresolved
  const selection = issueProviderCredentialLease(provider, scope, { ttlMs: Math.min(profile.requestTimeoutMs ?? 30_000, 60_000) }, boundMediaCredentialKey(provider, job))
  if (provider.authMode !== 'none' && (!selection.available || !selection.lease)) throw new Error('Media Provider credential is unavailable')
  const base = target.baseUrl.replace(/\/+$/, '')
  if (operation === 'download' && job.preparedOutputPath && job.preparedOutputDigest && job.preparedOutputSizeBytes) {
    return {
      status: 'succeeded', externalJobId: job.providerExternalJobId ?? job.externalJobId,
      outputFilePath: job.preparedOutputPath, outputDigest: job.preparedOutputDigest,
      outputSizeBytes: job.preparedOutputSizeBytes, mediaType: job.remoteOutputMediaType
    }
  }
  const request = await mediaRequest(profile, target, job, operation, base, rootDir)
  const partialBytes = operation === 'download' ? await partialDownloadBytes(rootDir, job) : 0
  if (partialBytes > 0) request.headers = { ...request.headers, Range: `bytes=${partialBytes}-` }
  let response: Response
  try {
    response = await fetchWithProviderCredentialLease({
      provider,
      lease: selection.lease,
      scope,
      url: request.url,
      init: {
        method: request.method,
        headers: { accept: mediaAccept(job, operation), ...parseProviderHeaders(provider.customHeaders), ...request.headers },
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: 'error',
        signal: AbortSignal.timeout(profile.requestTimeoutMs ?? 30_000)
      },
      fetch: dependencies.fetch
    })
  } catch {
    return mediaTransportFailure(job, operation, partialBytes)
  }
  if (operation === 'download') {
    if (!response.ok) return failedHttpObservation(response, job)
    return streamRemoteOutput(response, rootDir, job, partialBytes)
  }
  if (!response.ok) return failedHttpObservation(response, job)
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (isDirectMediaResponse(contentType, profile, job)) {
    const output = await streamRemoteOutput(response, rootDir, job, 0)
    return { ...output, status: output.status === 'succeeded' ? 'downloading' : output.status }
  }
  const bodyBytes = await readBoundedResponse(response, 64 * 1024 * 1024)
  const body = parseJson(bodyBytes)
  if (operation === 'cancel') return mediaCancellationObservation(body, bodyBytes, job)
  return parseObservation(profile, job, operation, body, bodyBytes, rootDir, base)
}

async function mediaRequest(
  profile: MediaProviderProfile,
  target: ReturnType<typeof resolveProviderRuntimeTarget>,
  job: MediaJobRecord,
  operation: string,
  base: string,
  rootDir: string
): Promise<{ url: string; method: string; headers?: Record<string, string>; body?: RequestInit['body'] }> {
  const externalId = job.providerExternalJobId ?? job.externalJobId
  if (operation === 'cancel') return { url: mediaEndpointUrl(base, renderMediaPath(profile.cancelPathTemplate ?? '/v1/videos/{id}', externalId)), method: 'DELETE' }
  if (operation === 'poll') return { url: mediaEndpointUrl(base, renderMediaPath(profile.statusPathTemplate ?? '/v1/videos/{id}', externalId)), method: 'GET' }
  if (operation === 'download') {
    return { url: safeDownloadUrl(job.remoteOutputRef, base) ?? mediaEndpointUrl(base, renderMediaPath(profile.downloadPathTemplate ?? '/v1/videos/{id}/content', externalId)), method: 'GET' }
  }
  if (profile.endpointClass === 'openai-image') {
    if (job.operation === 'image.edit') {
      const inputs = await resolveInputFiles(job, rootDir)
      if (inputs.length === 0) throw new Error('Image edit requires a canonical input image')
      const form = new FormData()
      form.set('model', target.model)
      form.set('prompt', job.requestPrompt ?? '')
      form.set('image', await openAsBlob(inputs[0].path, { type: inputs[0].mediaType }), inputs[0].fileName)
      return { url: mediaEndpointUrl(base, profile.submitPath ?? '/v1/images/edits'), method: 'POST', body: form }
    }
    return jsonRequest(mediaEndpointUrl(base, profile.submitPath ?? '/v1/images/generations'), {
      model: target.model, prompt: job.requestPrompt ?? '', response_format: 'b64_json',
      ...(job.parameters.width && job.parameters.height ? { size: `${job.parameters.width}x${job.parameters.height}` } : {}),
      ...(job.parameters.quality ? { quality: job.parameters.quality } : {}),
      ...(job.parameters.negativePrompt ? { negative_prompt: job.parameters.negativePrompt } : {}),
      ...(job.parameters.seed !== undefined ? { seed: job.parameters.seed } : {})
    })
  }
  if (profile.endpointClass === 'openai-speech') {
    return jsonRequest(mediaEndpointUrl(base, profile.submitPath ?? '/v1/audio/speech'), {
      model: target.model, input: job.requestPrompt ?? '', voice: job.voice ?? 'alloy', response_format: 'mp3',
      ...(job.parameters.speechSpeed ? { speed: job.parameters.speechSpeed } : {})
    })
  }
  if (profile.endpointClass === 'openai-video') {
    const form = new FormData()
    form.set('model', target.model)
    form.set('prompt', job.requestPrompt ?? '')
    form.set('seconds', String(job.parameters.durationSeconds ?? 5))
    if (job.parameters.quality) form.set('quality', job.parameters.quality)
    if (job.parameters.width && job.parameters.height) form.set('size', `${job.parameters.width}x${job.parameters.height}`)
    if (job.parameters.seed !== undefined) form.set('seed', String(job.parameters.seed))
    if (job.parameters.negativePrompt) form.set('negative_prompt', job.parameters.negativePrompt)
    if (job.parameters.guidanceScale !== undefined) form.set('guidance_scale', String(job.parameters.guidanceScale))
    if (job.operation !== 'video.text-to-video') {
      const inputs = await resolveInputFiles(job, rootDir)
      if (inputs.length === 0) throw new Error(`${job.operation} requires a canonical reference asset`)
      form.set('input_reference', await openAsBlob(inputs[0].path, { type: inputs[0].mediaType }), inputs[0].fileName)
    }
    return { url: mediaEndpointUrl(base, profile.submitPath ?? '/v1/videos'), method: 'POST', headers: { 'Idempotency-Key': job.idempotencyKey }, body: form }
  }
  if (profile.endpointClass === 'generic-async' && job.inputAssetIds?.length) {
    const form = new FormData()
    form.set('model', target.model)
    form.set('operation', job.operation)
    form.set('prompt', job.requestPrompt ?? '')
    form.set('idempotency_key', job.idempotencyKey)
    form.set('parameters', JSON.stringify(job.parameters))
    for (const [index, input] of (await resolveInputFiles(job, rootDir)).entries()) {
      form.append('input', await openAsBlob(input.path, { type: input.mediaType }), `${index}-${input.fileName}`)
    }
    return { url: mediaEndpointUrl(base, profile.submitPath ?? '/v1/media/jobs'), method: 'POST', body: form }
  }
  if (profile.endpointClass === 'anthropic-compatible') {
    return jsonRequest(mediaEndpointUrl(base, '/v1/messages'), { model: target.model, max_tokens: 256, messages: [{ role: 'user', content: job.requestPrompt ?? `${job.operation}: ${job.shotId ?? job.id}` }] }, { 'anthropic-version': '2023-06-01' })
  }
  return jsonRequest(mediaEndpointUrl(base, profile.submitPath ?? '/v1/videos'), {
    model: target.model, operation: job.operation,
    prompt: job.requestPrompt ?? `${job.operation} for ${job.shotId ?? job.id}`,
    seconds: job.parameters.durationSeconds ?? 5, idempotency_key: job.idempotencyKey, voice: job.voice, parameters: job.parameters
  })
}

async function parseObservation(
  profile: MediaProviderProfile,
  job: MediaJobRecord,
  operation: string,
  body: Record<string, unknown>,
  bytes: Buffer,
  rootDir: string,
  base: string
): Promise<MediaRemoteJobObservation> {
  const externalJobId = typeof body.id === 'string' && body.id.trim() ? body.id : job.providerExternalJobId ?? job.externalJobId
  const billing = providerBilling(body, bytes)
  const status = typeof body.status === 'string' ? body.status.toLowerCase() : ''
  if (status === 'cancelled' || status === 'canceled') return { status: 'cancelled', externalJobId, ...billing }
  if (status === 'failed' || status === 'error') return { status: 'failed', externalJobId, reason: providerError(body), ...billing }
  const output = extractJsonOutput(body)
  if (output.base64) {
    const decoded = Buffer.from(output.base64, 'base64')
    if (decoded.byteLength === 0 || decoded.byteLength > 256 * 1024 * 1024) {
      return { status: 'failed', externalJobId, reason: 'Remote inline media output is empty or exceeds 256 MiB', ...billing }
    }
    const persisted = await persistRemoteBytes(decoded, rootDir, job, output.mediaType)
    return { status: 'downloading', externalJobId, ...persisted, ...billing }
  }
  if (output.url || status === 'succeeded' || status === 'completed') {
    const outputUrl = output.url ? safeDownloadUrl(output.url, base) : undefined
    if (output.url && !outputUrl) return { status: 'failed', externalJobId, reason: 'Remote media output URL is outside the bound Provider origin', ...billing }
    return { status: 'downloading', externalJobId, ...(outputUrl ? { outputUrl } : {}), mediaType: output.mediaType, ...billing }
  }
  return { status: 'running', externalJobId, ...billing }
}

async function streamRemoteOutput(response: Response, rootDir: string, job: MediaJobRecord, requestedOffset: number): Promise<MediaRemoteJobObservation> {
  if (!response.body) return { status: 'failed', externalJobId: job.providerExternalJobId ?? job.externalJobId, reason: 'Remote media download returned no body' }
  const declared = Number(response.headers.get('content-length'))
  const maxBytes = 2 * 1024 * 1024 * 1024
  const declaredTransferSize = response.status === 206 ? requestedOffset + declared : declared
  if (Number.isFinite(declared) && (declared <= 0 || declaredTransferSize > maxBytes)) {
    await response.body.cancel().catch(() => undefined)
    return { status: 'failed', externalJobId: job.providerExternalJobId ?? job.externalJobId, reason: 'Remote media output exceeds the 2 GiB limit' }
  }
  const directory = join(mediaProjectRoot(rootDir, job.projectId), 'provider-outputs')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = partialDownloadPath(rootDir, job)
  const resumeOffset = await validatedResumeOffset(response, temporary, requestedOffset)
  const totalBytes = contentTotal(response, resumeOffset, declared)
  if (totalBytes !== undefined && totalBytes > maxBytes) {
    await response.body.cancel().catch(() => undefined)
    return { status: 'failed', externalJobId: job.providerExternalJobId ?? job.externalJobId, reason: 'Remote media output exceeds the 2 GiB limit' }
  }
  const quota = await getMediaStore(rootDir).assertProjectStorageAvailable(job.projectId, totalBytes ?? 0)
  const handle = await open(temporary, resumeOffset > 0 ? constants.O_WRONLY | constants.O_APPEND : constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY, 0o600)
  const hash = createHash('sha256')
  if (resumeOffset > 0) await hashExistingFile(temporary, hash)
  const reader = response.body.getReader()
  let sizeBytes = resumeOffset
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      sizeBytes += result.value.byteLength
      if (sizeBytes > maxBytes) throw new Error('Remote media output exceeds the 2 GiB limit')
      if (sizeBytes > quota.availableBytes) throw new Error('Media project storage quota exceeded during download')
      hash.update(result.value)
      await handle.write(result.value)
    }
    if (sizeBytes === 0) throw new Error('Remote media output is empty')
    await handle.sync()
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    await handle.close().catch(() => undefined)
    return {
      status: 'waiting_reconciliation',
      externalJobId: job.providerExternalJobId ?? job.externalJobId,
      reason: error instanceof Error ? error.message : String(error),
      downloadReceivedBytes: sizeBytes,
      ...(totalBytes ? { downloadTotalBytes: totalBytes } : {})
    }
  }
  await handle.close()
  const hex = hash.digest('hex')
  const outputFilePath = join(directory, hex)
  try {
    await rename(temporary, outputFilePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    await rm(temporary, { force: true })
    const state = await lstat(outputFilePath)
    if (!state.isFile() || state.isSymbolicLink() || state.size !== sizeBytes) throw new Error('Existing remote media output is invalid')
  }
  await syncDirectory(dirname(outputFilePath))
  return {
    status: 'succeeded',
    externalJobId: job.providerExternalJobId ?? job.externalJobId,
    outputFilePath,
    outputDigest: `sha256:${hex}`,
    outputSizeBytes: sizeBytes,
    mediaType: response.headers.get('content-type')?.split(';', 1)[0]?.trim() || job.remoteOutputMediaType || 'application/octet-stream',
    downloadReceivedBytes: sizeBytes,
    downloadTotalBytes: totalBytes ?? sizeBytes
  }
}

function partialDownloadPath(rootDir: string, job: MediaJobRecord): string {
  return join(
    mediaProjectRoot(rootDir, job.projectId),
    'provider-outputs',
    `.download-${createHash('sha256').update(job.id).digest('hex').slice(0, 32)}.part`
  )
}

async function partialDownloadBytes(rootDir: string, job: MediaJobRecord): Promise<number> {
  try {
    const state = await lstat(partialDownloadPath(rootDir, job))
    if (!state.isFile() || state.isSymbolicLink() || state.size > 2 * 1024 * 1024 * 1024) {
      throw new Error('Remote media partial download is invalid')
    }
    return state.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

async function validatedResumeOffset(response: Response, temporary: string, requestedOffset: number): Promise<number> {
  if (requestedOffset === 0) return 0
  const contentRange = response.headers.get('content-range')
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange ?? '')
  if (response.status === 206 && match && Number(match[1]) === requestedOffset) return requestedOffset
  await rm(temporary, { force: true })
  return 0
}

function contentTotal(response: Response, offset: number, declared: number): number | undefined {
  const match = /^bytes \d+-\d+\/(\d+)$/i.exec(response.headers.get('content-range') ?? '')
  const ranged = match ? Number(match[1]) : undefined
  if (Number.isSafeInteger(ranged) && ranged! > 0) return ranged
  return Number.isSafeInteger(declared) && declared > 0 ? offset + declared : undefined
}

async function hashExistingFile(path: string, hash: ReturnType<typeof createHash>): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const reader = createReadStream(path)
    reader.on('data', (chunk) => hash.update(chunk))
    reader.on('error', reject)
    reader.on('end', resolvePromise)
  })
}

function jsonRequest(url: string, body: Record<string, unknown>, headers: Record<string, string> = {}): { url: string; method: string; headers: Record<string, string>; body: string } {
  return { url, method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }
}

function mediaAccept(job: MediaJobRecord, operation: string): string {
  if (operation === 'download') return '*/*'
  if (job.operation.startsWith('image.')) return 'application/json, image/*'
  if (job.operation.startsWith('speech.')) return 'audio/*, application/json'
  return 'application/json, video/*'
}

function isDirectMediaResponse(contentType: string, profile: MediaProviderProfile, job: MediaJobRecord): boolean {
  return contentType.startsWith('image/') || contentType.startsWith('audio/') || contentType.startsWith('video/') ||
    (profile.endpointClass === 'openai-speech' && job.operation.startsWith('speech.') && contentType === 'application/octet-stream')
}

async function failedHttpObservation(response: Response, job: MediaJobRecord): Promise<MediaRemoteJobObservation> {
  const bytes = await readBoundedResponse(response, 64 * 1024).catch(() => Buffer.alloc(0))
  const body = parseJson(bytes)
  return {
    status: 'failed',
    externalJobId: job.providerExternalJobId ?? job.externalJobId,
    reason: `${providerError(body)} (HTTP ${response.status})`.slice(0, 500)
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => undefined)
    throw new Error('Remote media response exceeds its metadata limit')
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > maxBytes) throw new Error('Remote media response exceeds its metadata limit')
      chunks.push(Buffer.from(result.value))
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  return Buffer.concat(chunks, total)
}

function extractJsonOutput(body: Record<string, unknown>): { url?: string; base64?: string; mediaType?: string } {
  const data = Array.isArray(body.data) && body.data[0] && typeof body.data[0] === 'object'
    ? body.data[0] as Record<string, unknown>
    : undefined
  const output = body.output && typeof body.output === 'object' && !Array.isArray(body.output)
    ? body.output as Record<string, unknown>
    : undefined
  const rawUrl = firstString(body.output_url, body.url, data?.url, output?.url)
  const base64 = firstString(body.b64_json, data?.b64_json, output?.b64_json)
  return {
    ...(rawUrl ? { url: rawUrl } : {}),
    ...(base64 ? { base64 } : {}),
    ...(firstString(body.media_type, body.content_type, data?.media_type, output?.media_type) ? {
      mediaType: firstString(body.media_type, body.content_type, data?.media_type, output?.media_type)
    } : {})
  }
}

function providerBilling(body: Record<string, unknown>, bytes: Buffer): Pick<MediaRemoteJobObservation, 'actualUsd' | 'billingReceiptDigest'> {
  const billing = body.billing && typeof body.billing === 'object' && !Array.isArray(body.billing)
    ? body.billing as Record<string, unknown>
    : undefined
  const raw = body.actual_cost_usd ?? body.cost_usd ?? billing?.actual_usd ?? billing?.cost_usd
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1_000_000) return {}
  return { actualUsd: raw, billingReceiptDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
}

function mediaCancellationObservation(body: Record<string, unknown>, bytes: Buffer, job: MediaJobRecord): MediaRemoteJobObservation {
  const state = typeof body.status === 'string' ? body.status.toLowerCase() : ''
  const cancelled = state === 'cancelled' || state === 'canceled' || body.deleted === true
  return { status: cancelled ? 'cancelled' : 'running', externalJobId: job.providerExternalJobId ?? job.externalJobId,
    ...providerBilling(body, bytes), ...(cancelled ? {} : { reason: '厂商已响应取消请求，尚未确认任务取消；请继续查询原任务。' }) }
}

function providerError(body: Record<string, unknown>): string {
  if (typeof body.error === 'string' && body.error.trim()) return body.error.trim()
  if (body.error && typeof body.error === 'object' && !Array.isArray(body.error)) {
    const message = (body.error as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  return 'Remote media Provider reported failure'
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim()
}

function safeDownloadUrl(value: string | undefined, providerBase: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value, providerBase)
    const base = new URL(providerBase)
    if (url.protocol !== base.protocol || url.host !== base.host || url.username || url.password || url.hash) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

async function persistRemoteBytes(
  bytes: Buffer,
  rootDir: string,
  job: MediaJobRecord,
  mediaType = defaultOutputMediaType(job)
): Promise<Pick<MediaRemoteJobObservation, 'outputFilePath' | 'outputDigest' | 'outputSizeBytes' | 'mediaType'>> {
  const directory = join(mediaProjectRoot(rootDir, job.projectId), 'provider-outputs')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const hex = createHash('sha256').update(bytes).digest('hex')
  const target = join(directory, hex)
  const temporary = join(directory, `.inline-${process.pid}-${randomUUID()}.tmp`)
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await handle.write(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    await rm(temporary, { force: true })
  }
  await syncDirectory(directory)
  return { outputFilePath: target, outputDigest: `sha256:${hex}`, outputSizeBytes: bytes.byteLength, mediaType }
}

function defaultOutputMediaType(job: MediaJobRecord): string {
  if (job.capability === 'image') return 'image/png'
  if (job.capability === 'tts') return 'audio/mpeg'
  return 'video/mp4'
}

async function resolveInputFiles(job: MediaJobRecord, rootDir: string): Promise<Array<{ path: string; mediaType: string; fileName: string }>> {
  if (!job.inputAssetIds?.length) return []
  const production = (await getMediaStore(rootDir).getMediaStudio(job.projectId)).productions.find((item) => item.id === job.productionId)
  if (!production) throw new Error('Media input Production is unavailable')
  const resolved = []
  for (const id of job.inputAssetIds) {
    const asset = production.assets.find((item) => item.id === id)
    if (!asset?.artifactId || !asset.digest || !asset.sizeBytes) throw new Error(`Media input Asset is incomplete: ${id}`)
    const lifecycle = await getPersistedArtifactLifecycle(asset.artifactId, rootDir)
    if (!lifecycle || lifecycle.projectId !== job.projectId || lifecycle.digest !== asset.digest || lifecycle.sizeBytes !== asset.sizeBytes) {
      throw new Error(`Media input Asset integrity is invalid: ${id}`)
    }
    const path = lifecycle.storageKind === 'source_ref'
      ? lifecycle.sourceRef
      : lifecycle.blobRef ? artifactBlobPath(rootDir, lifecycle.digest) : undefined
    if (!path) throw new Error(`Media input Asset content is unavailable: ${id}`)
    const state = await lstat(path)
    if (!state.isFile() || state.isSymbolicLink() || state.size !== asset.sizeBytes) throw new Error(`Media input Asset bytes are unavailable: ${id}`)
    resolved.push({ path, mediaType: asset.mediaType ?? 'application/octet-stream', fileName: asset.sourceFileName ?? basename(path) })
  }
  return resolved
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, constants.O_RDONLY)
  try { await handle.sync() } finally { await handle.close() }
}

function renderMediaPath(template: string, id: string): string {
  const path = template.replace('{id}', encodeURIComponent(id))
  if (!path.startsWith('/') || path.includes('..') || path.includes('?') || path.includes('#')) throw new Error('Media Provider path template is invalid')
  return path
}

function parseJson(bytes: Buffer): Record<string, unknown> {
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export function mediaProviderDigest(profile: MediaProviderProfile, job: MediaJobRecord): string {
  return createHash('sha256').update(`${profile.id}\0${job.id}\0${job.idempotencyKey}`).digest('hex')
}
