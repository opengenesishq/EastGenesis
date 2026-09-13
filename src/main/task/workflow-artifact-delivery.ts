/// <reference path="../zip-stream.d.ts" />

import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import ZipStream from 'zip-stream'
import type {
  WorkflowArtifactIntegrityBlocker,
  WorkflowArtifactIntegrityCheck,
  WorkflowArtifactIntegrityReport,
  WorkflowArtifactManifestExportResult,
  WorkflowProjectDeliveryIntegrityReport,
  WorkflowProjectDeliveryManifestExportResult,
  WorkflowProjectDeliveryPackageExportResult,
  WorkflowProjectDeliveryWorkbench
} from '../../shared/workflow-types'
import { canonicalJson, digest } from './workflow-ledger-codec'
import { getProjectDeliveryWorkbench } from './workflow-ledger-api'
import {
  createVerifiedWorkflowArtifactStream,
  resolveWorkflowArtifactExportSource,
  type WorkflowArtifactExportSource
} from './workflow-artifact-export'
import { readTaskSnapshotDatabase } from './task-snapshot'
import { findWorkflowArtifact } from './workflow-ledger-query'
import { setupWorkflowLedgerSchema } from './workflow-ledger-store'
import {
  getWorkflowDeliverySigningIdentity,
  signWorkflowProjectDeliveryManifest,
  type WorkflowDeliveryManifestSignature,
  type WorkflowDeliverySigningIdentity
} from './workflow-delivery-identity'

interface WorkflowArtifactDeliveryManifestBody {
  schemaVersion: 1
  format: 'caogen.artifact-delivery-manifest.v1'
  generatedAt: number
  artifact: WorkflowArtifactIntegrityReport['artifact']
  lineage: WorkflowArtifactIntegrityReport['lineage']
  evidence: WorkflowArtifactIntegrityReport['evidence']
  acceptances: WorkflowArtifactIntegrityReport['acceptances']
  verification: WorkflowArtifactIntegrityReport
}

export interface WorkflowArtifactDeliveryManifest extends WorkflowArtifactDeliveryManifestBody {
  manifestDigest: string
}

interface WorkflowProjectDeliveryManifestBody {
  schemaVersion: 1
  format: 'caogen.project-delivery-manifest.v1'
  generatedAt: number
  projectId: string
  summary: WorkflowProjectDeliveryIntegrityReport['summary']
  artifacts: WorkflowArtifactIntegrityReport[]
  verification: WorkflowProjectDeliveryIntegrityReport
}

export interface WorkflowProjectDeliveryManifest extends WorkflowProjectDeliveryManifestBody {
  manifestDigest: string
}

interface WorkflowProjectPackageEntry {
  artifactId: string
  title: string
  kind: WorkflowArtifactIntegrityReport['artifact']['kind']
  version: number
  digest: string
  sizeBytes: number
  mediaType?: string
  path: string
}

interface WorkflowProjectDeliveryPackageManifest {
  schemaVersion: 1
  format: 'caogen.project-delivery-package.v1'
  generatedAt: number
  projectId: string
  verdict: WorkflowProjectDeliveryIntegrityReport['verdict']
  verification: WorkflowProjectDeliveryIntegrityReport
  includedArtifacts: WorkflowProjectPackageEntry[]
  blockedArtifactIds: string[]
  signingIdentity: WorkflowDeliverySigningIdentity
  manifestDigest: string
  signature: WorkflowDeliveryManifestSignature
}

export async function verifyWorkflowArtifactIntegrity(
  rawArtifactId: string,
  rootDir?: string
): Promise<WorkflowArtifactIntegrityReport> {
  const artifactId = rawArtifactId.trim()
  if (!artifactId) throw new Error('Artifact ID is required')

  // Resolve Project ownership from the canonical Ledger before reading the Project-wide projection.
  const sourceResult = await resolveSourceResult(artifactId, rootDir)
  const projectId = sourceResult.source?.projectId ?? await resolveArtifactProjectId(artifactId, rootDir)
  const workbench = await getProjectDeliveryWorkbench(projectId, rootDir)
  const item = workbench.artifacts.find((candidate) => candidate.artifact.id === artifactId)
  if (!item || item.artifact.projectId !== projectId) {
    throw new Error(`Workflow Artifact ${artifactId} is outside the canonical Project delivery scope`)
  }

  return buildArtifactIntegrityReport(item, workbench, sourceResult.source)
}

function buildArtifactIntegrityReport(
  item: WorkflowProjectDeliveryWorkbench['artifacts'][number],
  workbench: WorkflowProjectDeliveryWorkbench,
  source: WorkflowArtifactExportSource | undefined
): WorkflowArtifactIntegrityReport {
  const projectId = workbench.projectId

  const evidenceById = new Map(workbench.evidence.map((record) => [record.evidenceId, record]))
  const acceptanceById = new Map(workbench.acceptances.map((record) => [record.id, record]))
  const evidence = item.evidenceIds.flatMap((evidenceId) => {
    const record = evidenceById.get(evidenceId)
    return record ? [{
      evidenceId: record.evidenceId,
      kind: record.kind,
      source: record.source,
      verifier: record.verifier,
      observedAt: record.observedAt,
      contentDigest: record.contentDigest
    }] : []
  })
  const acceptances = item.acceptanceIds.flatMap((acceptanceId) => {
    const record = acceptanceById.get(acceptanceId)
    return record ? [{
      acceptanceId: record.id,
      status: record.status,
      revision: record.revision,
      evidenceRefs: [...record.evidenceRefs].sort(),
      ...(record.verifier ? { verifier: record.verifier } : {}),
      ...(record.verifiedAt !== undefined ? { verifiedAt: record.verifiedAt } : {})
    }] : []
  })
  const availableLocations = item.locations.filter((location) => location.availability === 'available')
  const availableLocalLocations = availableLocations.filter((location) =>
    Boolean(location.path || location.uri?.toLowerCase().startsWith('file:'))
  )
  const blockers: WorkflowArtifactIntegrityBlocker[] = []
  if (!item.isCurrent) blockers.push({ code: 'HISTORICAL_VERSION', message: '该版本已被更新版本替代' })
  if (!source) blockers.push({
    code: 'LOCAL_LOCATION_UNVERIFIED',
    message: availableLocalLocations.length === 0 ? '没有可校验的本地文件位置' : '本地文件与 canonical 摘要或大小不一致'
  })
  if (evidence.length === 0) blockers.push({ code: 'EVIDENCE_MISSING', message: '没有绑定 Evidence' })
  if (acceptances.length === 0) blockers.push({ code: 'ACCEPTANCE_MISSING', message: '没有绑定 Acceptance' })
  if (acceptances.some((record) => record.status === 'failed')) {
    blockers.push({ code: 'ACCEPTANCE_FAILED', message: '至少一项 Acceptance 失败' })
  }
  if (acceptances.some((record) => record.status === 'pending' || record.status === 'verifying')) {
    blockers.push({ code: 'ACCEPTANCE_PENDING', message: '至少一项 Acceptance 尚未完成' })
  }

  const checks: WorkflowArtifactIntegrityCheck[] = [
    { kind: 'canonical_ownership', status: 'passed', message: 'Artifact 归属当前 Project' },
    { kind: 'artifact_graph', status: 'passed', message: 'Artifact Graph 完整性有效' },
    check('current_version', item.isCurrent, item.isCurrent ? '当前 lineage 版本' : '历史 lineage 版本'),
    check('local_location', availableLocalLocations.length > 0,
      availableLocalLocations.length > 0 ? '存在可用本地文件位置' : '缺少可用本地文件位置'),
    check('content_identity', Boolean(source),
      source ? '文件身份、大小和 SHA-256 已复核' : '文件字节未通过 canonical 复核'),
    check('evidence_binding', evidence.length > 0,
      evidence.length > 0 ? `已绑定 ${evidence.length} 条 Evidence` : '没有绑定 Evidence'),
    check('acceptance_status', acceptances.length > 0 && acceptances.every((record) =>
      record.status === 'passed' || record.status === 'waived'),
    acceptances.length === 0 ? '没有绑定 Acceptance' : `${acceptances.length} 项 Acceptance 已读取`)
  ]
  const verifiedAt = Date.now()
  return {
    schemaVersion: 1,
    format: 'caogen.artifact-integrity-report.v1',
    artifact: {
      id: item.artifact.id,
      projectId,
      title: item.artifact.title,
      kind: item.artifact.kind,
      version: item.artifact.version,
      digest: item.artifact.digest,
      ...(item.artifact.mediaType ? { mediaType: item.artifact.mediaType } : {}),
      ...(source ? { sizeBytes: source.sizeBytes } : {})
    },
    lineage: {
      ...(item.predecessorArtifactId ? { predecessorArtifactId: item.predecessorArtifactId } : {}),
      successorArtifactIds: [...item.successorArtifactIds],
      currentArtifactIds: [...item.currentArtifactIds],
      lineageArtifactIds: [...item.lineageArtifactIds],
      current: item.isCurrent
    },
    locations: {
      total: item.locations.length,
      available: availableLocations.length,
      availableLocal: availableLocalLocations.length,
      byteVerified: Boolean(source)
    },
    evidence,
    acceptances,
    checks,
    blockers,
    verdict: blockers.length === 0 ? 'ready' : 'blocked',
    verifiedAt
  }
}

export async function buildWorkflowArtifactDeliveryManifest(
  artifactId: string,
  rootDir?: string
): Promise<WorkflowArtifactDeliveryManifest> {
  const verification = await verifyWorkflowArtifactIntegrity(artifactId, rootDir)
  const body: WorkflowArtifactDeliveryManifestBody = {
    schemaVersion: 1,
    format: 'caogen.artifact-delivery-manifest.v1',
    generatedAt: verification.verifiedAt,
    artifact: verification.artifact,
    lineage: verification.lineage,
    evidence: verification.evidence,
    acceptances: verification.acceptances,
    verification
  }
  return { ...body, manifestDigest: `sha256:${digest(body)}` }
}

export async function verifyWorkflowProjectDelivery(
  rawProjectId: string,
  rootDir?: string
): Promise<WorkflowProjectDeliveryIntegrityReport> {
  return (await resolveWorkflowProjectDelivery(rawProjectId, rootDir)).verification
}

async function resolveWorkflowProjectDelivery(
  rawProjectId: string,
  rootDir?: string
): Promise<{
  verification: WorkflowProjectDeliveryIntegrityReport
  sourceByArtifactId: ReadonlyMap<string, WorkflowArtifactExportSource>
  authorityDigest: string
}> {
  const projectId = rawProjectId.trim()
  if (!projectId) throw new Error('Project ID is required')
  const workbench = await getProjectDeliveryWorkbench(projectId, rootDir)
  const currentArtifacts = workbench.artifacts
    .filter((item) => item.isCurrent)
    .sort((left, right) => left.artifact.id.localeCompare(right.artifact.id))
  const sourceResults = await mapWithConcurrency(currentArtifacts, 4, (item) =>
    resolveSourceResult(item.artifact.id, rootDir)
  )
  const sourceByArtifactId = new Map<string, WorkflowArtifactExportSource>()
  const artifacts = currentArtifacts.map((item, index) => {
    const source = sourceResults[index].source
    if (source) sourceByArtifactId.set(item.artifact.id, source)
    return buildArtifactIntegrityReport(item, workbench, source)
  })
  const blockerCountMap = new Map<WorkflowArtifactIntegrityBlocker['code'], number>()
  for (const report of artifacts) {
    for (const blocker of report.blockers) {
      blockerCountMap.set(blocker.code, (blockerCountMap.get(blocker.code) ?? 0) + 1)
    }
  }
  const readyArtifactCount = artifacts.filter((report) => report.verdict === 'ready').length
  const blockedArtifactCount = artifacts.length - readyArtifactCount
  const verification: WorkflowProjectDeliveryIntegrityReport = {
    schemaVersion: 1,
    format: 'caogen.project-delivery-integrity-report.v1',
    projectId,
    generatedAt: Date.now(),
    verdict: artifacts.length > 0 && blockedArtifactCount === 0 ? 'ready' : 'blocked',
    summary: {
      currentArtifactCount: artifacts.length,
      readyArtifactCount,
      blockedArtifactCount,
      verifiedBytes: artifacts.reduce((sum, report) => sum + (report.artifact.sizeBytes ?? 0), 0),
      blockerCounts: [...blockerCountMap.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
    },
    artifacts
  }
  return {
    verification,
    sourceByArtifactId,
    authorityDigest: projectDeliveryAuthorityDigest(workbench)
  }
}

export async function buildWorkflowProjectDeliveryManifest(
  projectId: string,
  rootDir?: string
): Promise<WorkflowProjectDeliveryManifest> {
  const verification = await verifyWorkflowProjectDelivery(projectId, rootDir)
  const body: WorkflowProjectDeliveryManifestBody = {
    schemaVersion: 1,
    format: 'caogen.project-delivery-manifest.v1',
    generatedAt: verification.generatedAt,
    projectId: verification.projectId,
    summary: verification.summary,
    artifacts: verification.artifacts,
    verification
  }
  return { ...body, manifestDigest: `sha256:${digest(body)}` }
}

export async function exportWorkflowArtifactManifestToPath(
  manifest: WorkflowArtifactDeliveryManifest,
  rawTargetPath: string
): Promise<Exclude<WorkflowArtifactManifestExportResult, { canceled: true }>> {
  const written = await writeManifestAtomically(manifest, rawTargetPath)
  return {
    canceled: false,
    artifactId: manifest.artifact.id,
    fileName: written.fileName,
    sizeBytes: written.sizeBytes,
    manifestDigest: manifest.manifestDigest,
    verdict: manifest.verification.verdict
  }
}

export async function exportWorkflowProjectDeliveryManifestToPath(
  manifest: WorkflowProjectDeliveryManifest,
  rawTargetPath: string
): Promise<Exclude<WorkflowProjectDeliveryManifestExportResult, { canceled: true }>> {
  const written = await writeManifestAtomically(manifest, rawTargetPath)
  return {
    canceled: false,
    projectId: manifest.projectId,
    fileName: written.fileName,
    sizeBytes: written.sizeBytes,
    manifestDigest: manifest.manifestDigest,
    verdict: manifest.verification.verdict,
    readyArtifactCount: manifest.summary.readyArtifactCount,
    blockedArtifactCount: manifest.summary.blockedArtifactCount
  }
}

export async function exportWorkflowProjectDeliveryPackageToPath(
  rawProjectId: string,
  rawTargetPath: string,
  rootDir?: string
): Promise<Exclude<WorkflowProjectDeliveryPackageExportResult, { canceled: true }>> {
  if (!rootDir?.trim()) throw new Error('Delivery package signing requires the CaoGen application data root')
  const resolved = await resolveWorkflowProjectDelivery(rawProjectId, rootDir)
  const verification = resolved.verification
  const readyReports = verification.artifacts.filter((report) => report.verdict === 'ready')
  const sources = readyReports.map((report) => {
    const source = resolved.sourceByArtifactId.get(report.artifact.id)
    if (!source) throw new Error(`Ready Artifact ${report.artifact.id} lost its verified source`)
    assertPackageSourceMatchesReport(source, report)
    return source
  })
  const includedArtifacts = sources.map((source, index) => packageEntry(source, readyReports[index], index))
  const signingIdentity = await getWorkflowDeliverySigningIdentity(rootDir)
  const manifestBody = {
    schemaVersion: 1 as const,
    format: 'caogen.project-delivery-package.v1' as const,
    generatedAt: verification.generatedAt,
    projectId: verification.projectId,
    verdict: verification.verdict,
    verification,
    includedArtifacts,
    signingIdentity,
    blockedArtifactIds: verification.artifacts
      .filter((report) => report.verdict === 'blocked')
      .map((report) => report.artifact.id)
      .sort()
  }
  const manifestDigest = `sha256:${digest(manifestBody)}`
  const signed = await signWorkflowProjectDeliveryManifest(rootDir, verification.projectId, manifestDigest)
  if (canonicalJson(signed.identity) !== canonicalJson(signingIdentity)) {
    throw new Error('Delivery signing identity changed while preparing the package')
  }
  const manifest: WorkflowProjectDeliveryPackageManifest = {
    ...manifestBody,
    manifestDigest,
    signature: signed.signature
  }
  const written = await writeDeliveryZipAtomically(manifest, sources, rawTargetPath, async () => {
    const current = await getProjectDeliveryWorkbench(verification.projectId, rootDir)
    if (projectDeliveryAuthorityDigest(current) !== resolved.authorityDigest) {
      throw new Error('Project delivery authority changed while the package was being created')
    }
  })
  return {
    canceled: false,
    projectId: verification.projectId,
    fileName: written.fileName,
    sizeBytes: written.sizeBytes,
    packageDigest: written.packageDigest,
    manifestDigest: manifest.manifestDigest,
    signatureStatus: 'valid',
    signingIdentityFingerprint: manifest.signingIdentity.fingerprint,
    identityTrust: 'local_identity',
    verdict: verification.verdict,
    includedArtifactCount: includedArtifacts.length,
    blockedArtifactCount: verification.summary.blockedArtifactCount
  }
}

export function suggestedWorkflowArtifactManifestName(title: string): string {
  const stem = title.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim()
  const safe = (stem || 'artifact').slice(0, 100).replace(/[. ]+$/g, '') || 'artifact'
  return `${safe}.delivery-manifest.json`
}

export function suggestedWorkflowProjectManifestName(projectId: string): string {
  const suffix = projectId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'project'
  return `${suffix}.delivery-manifest.json`
}

export function suggestedWorkflowProjectPackageName(projectId: string): string {
  const suffix = projectId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'project'
  return `${suffix}.verified-delivery.zip`
}

async function writeDeliveryZipAtomically(
  manifest: WorkflowProjectDeliveryPackageManifest,
  sources: readonly WorkflowArtifactExportSource[],
  rawTargetPath: string,
  beforePublish: () => Promise<void>
): Promise<{ fileName: string; sizeBytes: number; packageDigest: string }> {
  const targetPath = resolve(rawTargetPath)
  if (sources.some((source) => resolve(source.sourcePath) === targetPath)) {
    throw new Error('Delivery package destination must differ from every canonical Artifact source')
  }
  const parent = dirname(targetPath)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const temporaryPath = resolve(parent, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`)
  const archive = new ZipStream({ forceZip64: true, zlib: { level: 6 } })
  const writer = createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
  archive.pipe(writer)
  const completed = new Promise<void>((fulfill, reject) => {
    archive.once('error', reject)
    writer.once('error', reject)
    writer.once('finish', fulfill)
  })
  void completed.catch(() => undefined)
  try {
    const date = new Date(manifest.generatedAt)
    await addZipEntry(archive, Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8'), {
      name: 'manifest.json', date, mode: 0o600
    })
    for (let index = 0; index < sources.length; index += 1) {
      const entry = manifest.includedArtifacts[index]
      await addZipEntry(archive, createVerifiedWorkflowArtifactStream(sources[index]), {
        name: entry.path, date, mode: 0o600
      })
    }
    archive.finalize()
    await completed
    const handle = await open(temporaryPath, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    const observed = await hashStableFile(temporaryPath)
    await beforePublish()
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o600)
    const beforeRename = await lstat(temporaryPath, { bigint: true })
    await rename(temporaryPath, targetPath)
    await syncDirectory(parent)
    const afterRename = await lstat(targetPath, { bigint: true })
    if (!afterRename.isFile() || afterRename.isSymbolicLink() ||
        beforeRename.dev !== afterRename.dev || beforeRename.ino !== afterRename.ino ||
        beforeRename.size !== afterRename.size || beforeRename.mtimeNs !== afterRename.mtimeNs) {
      throw new Error('Delivery package identity changed during atomic publish')
    }
    return {
      fileName: basename(targetPath),
      sizeBytes: observed.sizeBytes,
      packageDigest: `sha256:${observed.digest}`
    }
  } catch (error) {
    archive.destroy()
    await closeWriteStream(writer)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function closeWriteStream(writer: ReturnType<typeof createWriteStream>): Promise<void> {
  if (writer.closed) return Promise.resolve()
  return new Promise((fulfill) => {
    writer.once('close', fulfill)
    writer.destroy()
  })
}

function projectDeliveryAuthorityDigest(workbench: WorkflowProjectDeliveryWorkbench): string {
  return digest({
    projectId: workbench.projectId,
    artifacts: workbench.artifacts.map((item) => ({
      artifact: item.artifact,
      locations: [...item.locations].sort((left, right) => left.id.localeCompare(right.id)),
      evidenceIds: [...item.evidenceIds].sort(),
      acceptanceIds: [...item.acceptanceIds].sort(),
      isCurrent: item.isCurrent,
      currentArtifactIds: [...item.currentArtifactIds].sort()
    })).sort((left, right) => left.artifact.id.localeCompare(right.artifact.id)),
    evidence: workbench.evidence,
    acceptances: workbench.acceptances,
    evidenceLinks: workbench.evidenceLinks
  })
}

function addZipEntry(
  archive: ZipStream,
  source: Buffer | Readable,
  options: { name: string; date: Date; mode: number }
): Promise<void> {
  return new Promise((fulfill, reject) => {
    archive.entry(source, options, (error) => error ? reject(error) : fulfill())
  })
}

function packageEntry(
  source: WorkflowArtifactExportSource,
  report: WorkflowArtifactIntegrityReport,
  index: number
): WorkflowProjectPackageEntry {
  const extension = safePackageExtension(source.suggestedFileName)
  return {
    artifactId: report.artifact.id,
    title: report.artifact.title,
    kind: report.artifact.kind,
    version: report.artifact.version,
    digest: report.artifact.digest,
    sizeBytes: source.sizeBytes,
    ...(report.artifact.mediaType ? { mediaType: report.artifact.mediaType } : {}),
    path: `artifacts/${String(index + 1).padStart(4, '0')}-${safePackageStem(report.artifact.title)}${extension}`
  }
}

function assertPackageSourceMatchesReport(
  source: WorkflowArtifactExportSource,
  report: WorkflowArtifactIntegrityReport
): void {
  const reportDigest = report.artifact.digest.replace(/^sha256:/i, '').toLowerCase()
  if (source.artifactId !== report.artifact.id || source.projectId !== report.artifact.projectId ||
      source.version !== report.artifact.version || source.digest !== reportDigest ||
      source.sizeBytes !== report.artifact.sizeBytes) {
    throw new Error(`Artifact ${report.artifact.id} changed while preparing the delivery package`)
  }
}

function safePackageStem(value: string): string {
  const stem = value.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim()
  return (stem || 'artifact').slice(0, 100).replace(/[. ]+$/g, '') || 'artifact'
}

function safePackageExtension(fileName: string): string {
  const extension = extname(fileName).toLowerCase()
  return /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : ''
}

async function hashStableFile(filePath: string): Promise<{ digest: string; sizeBytes: number }> {
  const before = await lstat(filePath, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Delivery package is not a regular file')
  const handle = await open(filePath, 'r')
  try {
    const openedBefore = await handle.stat({ bigint: true })
    if (!openedBefore.isFile() || openedBefore.dev !== before.dev || openedBefore.ino !== before.ino) {
      throw new Error('Delivery package identity changed before verification')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(256 * 1024)
    let sizeBytes = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      sizeBytes += bytesRead
      if (!Number.isSafeInteger(sizeBytes)) throw new Error('Delivery package is too large to verify safely')
    }
    const openedAfter = await handle.stat({ bigint: true })
    const after = await lstat(filePath, { bigint: true })
    if (openedAfter.dev !== openedBefore.dev || openedAfter.ino !== openedBefore.ino ||
        openedAfter.size !== openedBefore.size || openedAfter.mtimeNs !== openedBefore.mtimeNs ||
        after.dev !== openedAfter.dev || after.ino !== openedAfter.ino) {
      throw new Error('Delivery package changed during verification')
    }
    return { digest: hash.digest('hex'), sizeBytes }
  } finally {
    await handle.close()
  }
}

async function writeManifestAtomically(
  manifest: object,
  rawTargetPath: string
): Promise<{ fileName: string; sizeBytes: number }> {
  const targetPath = resolve(rawTargetPath)
  const bytes = Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8')
  const parent = dirname(targetPath)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const temporaryPath = resolve(parent, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, targetPath)
    await syncDirectory(parent)
    const stats = await lstat(targetPath)
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Delivery manifest target is not a regular file')
    const observed = await readFile(targetPath)
    if (!observed.equals(bytes)) throw new Error('Delivery manifest bytes changed after export')
    return { fileName: basename(targetPath), sizeBytes: bytes.byteLength }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await transform(values[index])
    }
  })
  await Promise.all(workers)
  return results
}

async function resolveSourceResult(artifactId: string, rootDir?: string) {
  try {
    return { source: await resolveWorkflowArtifactExportSource(artifactId, rootDir) }
  } catch {
    return { source: undefined }
  }
}

async function resolveArtifactProjectId(artifactId: string, rootDir?: string): Promise<string> {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    const artifact = findWorkflowArtifact(db, artifactId)
    if (!artifact) throw new Error(`Workflow Artifact ${artifactId} was not found`)
    if (!artifact.projectId) throw new Error(`Workflow Artifact ${artifactId} has no Project ownership`)
    return artifact.projectId
  })
}

function check(
  kind: WorkflowArtifactIntegrityCheck['kind'],
  passed: boolean,
  message: string
): WorkflowArtifactIntegrityCheck {
  return { kind, status: passed ? 'passed' : 'blocked', message }
}
