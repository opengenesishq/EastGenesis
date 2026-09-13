import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { StudioResultSnapshot } from '../../shared/studio-result-types'

const PORTABLE_ARTIFACT_MAX_BYTES = 128 * 1024 * 1024
const PORTABLE_PACKAGE_MAX_BYTES = 512 * 1024 * 1024

/**
 * Build the user portable package from the renderer-safe canonical result.
 * Only current, byte-verifiable artifacts whose Evidence and Acceptance are
 * already ready may cross the delivery boundary. Blocked/history artifacts
 * remain visible in manifest metadata without copying their bytes.
 */
export async function buildPortableDeliveryPackage(
  snapshot: StudioResultSnapshot,
  resultJson: string,
  exportDigest: string
): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('result.json', resultJson)
  const files: Array<Record<string, unknown>> = []
  const includedPathByDigest = new Map<string, string>()
  let includedBytes = 0

  for (const [index, artifact] of snapshot.artifacts.entries()) {
    const location = artifact.locations.find((candidate) =>
      candidate.availability === 'available' && typeof candidate.path === 'string' && candidate.path.length > 0)
    const entry: Record<string, unknown> = {
      artifactId: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      version: artifact.version,
      deliveryScope: artifact.deliveryScope,
      deliveryStatus: artifact.deliveryStatus,
      digest: artifact.digest,
      mediaType: artifact.mediaType,
      locationId: location?.id,
      locationKind: location?.kind,
      sizeBytes: location?.sizeBytes
    }
    const deliverable = artifact.deliveryScope === 'current' && artifact.deliveryStatus === 'ready' &&
      artifact.evidenceIds.length > 0 && artifact.acceptanceIds.length > 0
    if (!deliverable) {
      entry.contentStatus = 'not_deliverable'
    } else if (location?.path) {
      try {
        const info = await lstat(location.path)
        if (info.isFile() && !info.isSymbolicLink() && info.size <= PORTABLE_ARTIFACT_MAX_BYTES) {
          const bytes = await readFile(location.path)
          const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
          const withinPackageLimit = includedBytes + bytes.byteLength <= PORTABLE_PACKAGE_MAX_BYTES
          if (digest === artifact.digest && (withinPackageLimit || includedPathByDigest.has(artifact.digest))) {
            const fileDigest = artifact.digest
            const existingPath = includedPathByDigest.get(fileDigest)
            const extension = safeArtifactExtension(location.path, artifact.mediaType)
            const relativePath = existingPath ?? `artifacts/${String(index + 1).padStart(3, '0')}-${safeFileStem(artifact.title)}${extension}`
            if (!existingPath) {
              zip.file(relativePath, bytes)
              includedPathByDigest.set(fileDigest, relativePath)
              includedBytes += bytes.byteLength
            }
            entry.includedPath = relativePath
            entry.contentIncluded = true
            entry.contentDeduplicated = Boolean(existingPath)
          } else {
            entry.contentStatus = digest === artifact.digest ? 'package_limit' : 'digest_mismatch'
          }
        } else {
          entry.contentStatus = info.isFile() && !info.isSymbolicLink() ? 'artifact_too_large' : 'not_regular_file'
        }
      } catch {
        entry.contentStatus = 'unreadable'
      }
    } else {
      entry.contentStatus = 'no_available_file_location'
    }
    if (entry.contentIncluded !== true) entry.contentIncluded = false
    files.push(entry)
  }

  const manifest = {
    schemaVersion: 1,
    format: 'caogen.studio-delivery.v1',
    generatedAt: snapshot.generatedAt,
    scope: snapshot.scope,
    exportDigest,
    resultDigest: snapshot.verification.resultDigest,
    aggregateDigest: snapshot.verification.aggregateDigest,
    verification: snapshot.verification,
    summary: snapshot.summary,
    files,
    includedBytes
  }
  zip.file('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  if (bytes.byteLength > PORTABLE_PACKAGE_MAX_BYTES + 8 * 1024 * 1024) {
    throw new Error('STUDIO_RESULT_PACKAGE_TOO_LARGE: portable delivery package exceeds the safe size limit')
  }
  return bytes
}

function safeArtifactExtension(path: string, mediaType?: string): string {
  const pathExtension = extname(path).toLowerCase()
  if (/^\.[a-z0-9]{1,12}$/.test(pathExtension)) return pathExtension
  const mediaExtensions: Record<string, string> = {
    'application/pdf': '.pdf',
    'application/zip': '.zip',
    'application/json': '.json',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'video/mp4': '.mp4',
    'audio/mpeg': '.mp3'
  }
  return mediaType ? (mediaExtensions[mediaType] ?? '') : ''
}

export function safeFileStem(value: string): string {
  const stem = basename(value).replace(/[^a-z0-9\u4e00-\u9fff._-]+/gi, '-').replace(/^-+|-+$/g, '')
  return stem.slice(0, 64) || 'delivery'
}
