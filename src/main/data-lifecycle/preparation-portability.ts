import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import type { ProjectAggregatePortableRuntime } from '../../shared/project-aggregate-types'
import type { PortablePreparationSession, ProjectPreparationSlice } from '../../shared/preparation-portability-types'
import { parsePreparationPermissionRecord, type PreparationPermissionRecord } from '../permission/preparation-permission-store'
import { projectAggregateCanonicalJson, projectAggregateDigest, assertNoCredentialMaterial } from '../project-aggregate/codec'
import { writeDurableFileSync } from '../durable-file'
import { assertPreparationPath, permissionTemporaryFiles, preparationDraftFiles, preparationPaths } from './preparation-data-files'

type Context = Pick<ProjectAggregatePortableRuntime, 'sessionIds' | 'sessionHistory' | 'activeSessions' | 'sessionCreationJournal'> &
  Partial<Pick<ProjectAggregatePortableRuntime, 'taskSnapshots'>>
const MAX_BYTES = 64 * 1024 * 1024
const MAX_FILES = 2000

export function collectProjectPreparation(root: string, projectId: string, context: Context): ProjectPreparationSlice {
  const sessions: PortablePreparationSession[] = []
  for (const sessionId of context.sessionIds) {
    const paths = preparationPaths(root, sessionId), filePaths = preparationDraftFiles(root, sessionId)
    const permissionExists = assertPreparationPath(root, paths.permission, false)
    const auditExists = assertPreparationPath(root, paths.audit, false)
    if (permissionTemporaryFiles(root, paths.permission).length || permissionTemporaryFiles(root, paths.audit).length) fail('unpublished permission write must be recovered before export')
    if (!permissionExists && !auditExists && filePaths.length === 0) continue
    const metas = sessionMetadata(sessionId, context)
    if (!metas.length) fail('preparation Session metadata is missing')
    const meta = metas[0]
    const files = filePaths.map(path => {
      const rel = portablePath(relative(paths.files, path))
      if (path.endsWith('.caogen-write.tmp')) fail('unfinished preparation write must be recovered before export')
      const info = lstatSync(path)
      if (info.size > MAX_BYTES) fail('draft exceeds portable size limit')
      const bytes = readFileSync(path)
      return { path: rel, encoding: 'base64' as const, data: bytes.toString('base64'), sizeBytes: bytes.length, digest: `sha256:${hashBytes(bytes)}` }
    }).sort((a, b) => a.path.localeCompare(b.path))
    let permissionSource: string | undefined
    let priorPermissionSources: string[] = []
    if (auditExists) {
      const audit = JSON.parse(readFileSync(paths.audit, 'utf8')) as PortablePreparationSession
      if (audit.sessionId !== sessionId || audit.workspaceId !== projectId) fail('source audit ownership mismatch')
      permissionSource = audit.permissionSource
      priorPermissionSources = audit.priorPermissionSources ?? []
    }
    if (permissionExists) {
      if (permissionSource) priorPermissionSources = [...priorPermissionSources, permissionSource]
      permissionSource = readFileSync(paths.permission, 'utf8')
      parsePreparationPermissionRecord(JSON.parse(permissionSource), sessionId, paths.files)
    }
    sessions.push({ sessionId, workspaceId: projectId,
      ...(typeof meta.goalId === 'string' ? { goalId: meta.goalId } : {}),
      ...(typeof meta.workItemId === 'string' ? { workItemId: meta.workItemId } : {}),
      ...(permissionSource ? { permissionSource } : {}),
      ...(priorPermissionSources.length ? { priorPermissionSources: [...new Set(priorPermissionSources)] } : {}), files })
  }
  const body = { schemaVersion: 1 as const, projectId, sessions: sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId)) }
  const slice = { ...body, sliceDigest: projectAggregateDigest(body) }
  validateProjectPreparation(projectId, slice, context)
  return slice
}

export function validateProjectPreparation(projectId: string, slice: ProjectPreparationSlice | undefined, context: Context): void {
  if (slice === undefined) return
  if (!isRecord(slice) || slice.schemaVersion !== 1 || slice.projectId !== projectId || !Array.isArray(slice.sessions)) fail('invalid portable slice')
  const { sliceDigest, ...body } = slice
  if (sliceDigest !== projectAggregateDigest(body)) fail('slice digest mismatch')
  assertNoCredentialMaterial(slice)
  const sessionIds = new Set<string>(), declared = new Set(context.sessionIds)
  let totalBytes = 0, totalFiles = 0
  for (const session of slice.sessions) {
    if (!isRecord(session) || typeof session.sessionId !== 'string' || session.workspaceId !== projectId ||
        !declared.has(session.sessionId) || sessionIds.has(session.sessionId) || !Array.isArray(session.files)) fail('invalid Session ownership')
    preparationPaths('.', session.sessionId)
    sessionIds.add(session.sessionId)
    const metas = sessionMetadata(session.sessionId, context)
    if (!metas.length || metas.some(meta => (meta.workspaceId ?? meta.projectId) !== projectId ||
        meta.goalId !== session.goalId || meta.workItemId !== session.workItemId)) fail('preparation Session binding mismatch')
    if (session.permissionSource !== undefined) {
      if (typeof session.permissionSource !== 'string') fail('invalid permission source')
      const permission = parsePreparationPermissionRecord(JSON.parse(session.permissionSource), session.sessionId)
      assertPermissionCredentialFree(permission)
      if (!isAbsolute(permission.directory) && !/^[A-Za-z]:[\\/]/.test(permission.directory)) fail('source permission directory is not absolute')
    }
    if (session.priorPermissionSources !== undefined) {
      if (!Array.isArray(session.priorPermissionSources) || session.priorPermissionSources.length > 1000) fail('invalid prior permission sources')
      for (const raw of session.priorPermissionSources) {
        if (typeof raw !== 'string') fail('invalid prior permission source')
        assertPermissionCredentialFree(parsePreparationPermissionRecord(JSON.parse(raw), session.sessionId))
      }
    }
    const paths = new Set<string>()
    for (const file of session.files) {
      if (!isRecord(file) || typeof file.path !== 'string' || typeof file.data !== 'string' || file.encoding !== 'base64' ||
          !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > MAX_BYTES) fail('invalid draft file')
      const path = portablePath(file.path)
      if (paths.has(path) || path.endsWith('.caogen-write.tmp')) fail('duplicate or unfinished draft file')
      paths.add(path)
      const bytes = Buffer.from(file.data, 'base64')
      if (bytes.toString('base64') !== file.data || bytes.length !== file.sizeBytes || `sha256:${hashBytes(bytes)}` !== file.digest) fail('draft content digest mismatch')
      // write_file produces UTF-8 text. Do not bury credential material in base64 archives.
      if (Buffer.from(bytes.toString('utf8')).compare(bytes) !== 0) fail('preparation draft is not UTF-8 text')
      assertNoCredentialMaterial(bytes.toString('utf8'))
      totalBytes += bytes.length; totalFiles++
      if (totalBytes > MAX_BYTES || totalFiles > MAX_FILES) fail('preparation slice exceeds portable limits')
    }
  }
}

export function assertProjectPreparationImportable(root: string, projectId: string, slice: ProjectPreparationSlice | undefined, context: Context): void {
  validateProjectPreparation(projectId, slice, context)
  if (!slice) return
  for (const session of slice.sessions) {
    const paths = preparationPaths(root, session.sessionId)
    if (permissionTemporaryFiles(root, paths.permission).length || permissionTemporaryFiles(root, paths.audit).length) fail('destination has unfinished permission writes')
    const expectedPermission = importedPermission(root, session)
    if (assertPreparationPath(root, paths.permission, false)) {
      const existing = parsePreparationPermissionRecord(JSON.parse(readFileSync(paths.permission, 'utf8')), session.sessionId, paths.files)
      if (existing.status === 'granted' || !expectedPermission || projectAggregateCanonicalJson(existing) !== projectAggregateCanonicalJson(expectedPermission)) fail('destination permission conflict; current authority is preserved')
    }
    const expected = new Map(session.files.map(file => [file.path, file]))
    for (const path of preparationDraftFiles(root, session.sessionId)) {
      if (!expected.has(portablePath(relative(paths.files, path)))) fail('destination contains another preparation draft')
    }
    for (const file of session.files) {
      const target = join(paths.files, portablePath(file.path))
      if (assertPreparationPath(root, target, false)) {
        const bytes = readFileSync(target)
        if (bytes.length !== file.sizeBytes || `sha256:${hashBytes(bytes)}` !== file.digest) fail('destination draft conflict')
      }
    }
    if (assertPreparationPath(root, paths.audit, false) && readFileSync(paths.audit, 'utf8') !== projectAggregateCanonicalJson(auditRecord(session))) fail('destination audit conflict')
  }
}

export function importProjectPreparation(root: string, projectId: string, slice: ProjectPreparationSlice | undefined, context: Context): void {
  assertProjectPreparationImportable(root, projectId, slice, context)
  if (!slice) return
  for (const session of slice.sessions) {
    const paths = preparationPaths(root, session.sessionId)
    // Write the revoked barrier first. A partial restore cannot inherit source authorization.
    const permission = importedPermission(root, session)
    if (permission && !assertPreparationPath(root, paths.permission, false)) {
      writePrivate(root, paths.permission, JSON.stringify(permission))
    }
    if (!assertPreparationPath(root, paths.audit, false)) writePrivate(root, paths.audit, projectAggregateCanonicalJson(auditRecord(session)))
    ensureDirectory(root, paths.files)
    for (const file of session.files) {
      const target = join(paths.files, portablePath(file.path))
      if (!assertPreparationPath(root, target, false)) writePrivate(root, target, Buffer.from(file.data, 'base64'))
    }
  }
}

export function verifyProjectPreparation(root: string, projectId: string, slice: ProjectPreparationSlice | undefined, context: Context): void {
  assertProjectPreparationImportable(root, projectId, slice, context)
  if (!slice) return
  for (const session of slice.sessions) {
    const paths = preparationPaths(root, session.sessionId)
    if (!assertPreparationPath(root, paths.audit, false) || (session.permissionSource && !assertPreparationPath(root, paths.permission, false))) fail('restored preparation record is missing')
    for (const file of session.files) if (!assertPreparationPath(root, join(paths.files, portablePath(file.path)), false)) fail('restored preparation file is missing')
  }
}

function importedPermission(root: string, session: PortablePreparationSession): PreparationPermissionRecord | undefined {
  if (!session.permissionSource) return undefined
  const source = parsePreparationPermissionRecord(JSON.parse(session.permissionSource), session.sessionId)
  const { digest: _, ...body } = source
  const revision = source.revision + 1
  const at = Math.max(source.grantedAt, source.revokedAt ?? 0, ...source.events.map(event => event.at))
  const target = { ...body, directory: preparationPaths(root, session.sessionId).files,
    directoryIdentity: { device: '0', inode: '0' }, revision, status: 'revoked' as const,
    revokedAt: at, importedNeedsReauthorization: true as const,
    events: [...source.events, { revision, status: 'revoked' as const, actorId: 'local-user:project-import', at }] }
  return { ...target, digest: hashBytes(Buffer.from(JSON.stringify(target))) }
}
function assertPermissionCredentialFree(permission: PreparationPermissionRecord): void {
  // This schema-validated boolean is a denial marker, not authorization material.
  const { importedNeedsReauthorization: _, ...source } = permission
  assertNoCredentialMaterial(source)
}
function auditRecord(session: PortablePreparationSession) {
  const { files: _, ...source } = session
  return { schemaVersion: 1, ...source }
}
function sessionMetadata(sessionId: string, context: Context): Record<string, unknown>[] {
  return [...context.sessionHistory, ...context.activeSessions, ...context.sessionCreationJournal, ...(context.taskSnapshots ?? [])].flatMap(value => {
    if (!isRecord(value)) return []
    const meta = isRecord(value.meta) ? value.meta : isRecord(value.draft) && isRecord(value.draft.baseMeta) ? value.draft.baseMeta : value
    return meta.id === sessionId || value.sessionId === sessionId ? [meta] : []
  })
}
function writePrivate(root: string, path: string, content: string | Buffer): void {
  ensureDirectory(root, dirname(path)); assertPreparationPath(root, path, false)
  writeDurableFileSync(path, content, { replace: false, mode: 0o600 })
}
function ensureDirectory(root: string, directory: string): void {
  let current = realpathSync(resolve(root))
  for (const part of relative(current, directory).split(/[\\/]/)) {
    current = join(current, part)
    if (!assertPreparationPath(root, current, true)) mkdirSync(current, { mode: 0o700 })
  }
}
function portablePath(value: string): string {
  if (!value || isAbsolute(value) || value.includes('\\') || /[\0-\x1f]/.test(value) || value === '.' || value === '..' || value.startsWith('../') || value !== posix.normalize(value)) fail('unsafe draft path')
  return value
}
function hashBytes(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function fail(message: string): never { throw new Error(`Project preparation portability: ${message}`) }
