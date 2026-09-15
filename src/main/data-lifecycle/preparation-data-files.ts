import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export function preparationSessionKey(sessionId: string): string {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200 || /[\0-\x1f]/.test(sessionId)) throw new Error('Invalid preparation Session identity')
  return createHash('sha256').update(JSON.stringify(sessionId)).digest('hex')
}
export function preparationPaths(root: string, sessionId: string) {
  const key = preparationSessionKey(sessionId)
  const base = realpathSync(resolve(root))
  return { drafts: join(base, 'preparation-drafts', key),
    files: join(base, 'preparation-drafts', key, 'files'),
    permission: join(base, 'private', 'preparation-permissions', `${key}.json`),
    audit: join(base, 'private', 'preparation-import-audits', `${key}.json`) }
}

/** Checks every ancestor, including broken symlinks; a missing target is the only permitted absence. */
export function assertPreparationPath(root: string, path: string, directory: boolean): boolean {
  const base = realpathSync(resolve(root))
  const resolvedPath = resolve(path).startsWith(`${resolve(root)}/`) ? join(base, relative(resolve(root), resolve(path))) : resolve(path)
  const rel = relative(base, resolvedPath)
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Preparation data escapes application root')
  let current = base
  const parts = rel.split(/[\\/]/)
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    let info: ReturnType<typeof lstatSync>
    try { info = lstatSync(current) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 || directory ? !info.isDirectory() : !info.isFile())) {
      throw new Error('Preparation data path is not regular')
    }
  }
  return true
}

export function preparationDraftFiles(root: string, sessionId: string): string[] {
  const base = preparationPaths(root, sessionId).drafts
  if (!assertPreparationPath(root, base, true)) return []
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('Preparation draft contains an unsupported file')
      assertPreparationPath(root, path, entry.isDirectory())
      if (entry.isDirectory()) visit(path)
      else files.push(path)
    }
  }
  visit(base)
  return files.sort()
}

export function preparationDataCounts(root: string, sessionIds: Iterable<string>): Record<string, number> {
  let preparationDrafts = 0, preparationPermissions = 0, preparationImportAudits = 0
  for (const sessionId of new Set(sessionIds)) {
    const paths = preparationPaths(root, sessionId)
    preparationDrafts += preparationDraftFiles(root, sessionId).length
    if (assertPreparationPath(root, paths.permission, false)) preparationPermissions++
    if (assertPreparationPath(root, paths.audit, false)) preparationImportAudits++
    // Crash files have the same owned basename. Never leave raw authorization audit data behind.
    preparationPermissions += permissionTemporaryFiles(root, paths.permission).length
    preparationImportAudits += permissionTemporaryFiles(root, paths.audit).length
  }
  return { preparationDrafts, preparationPermissions, preparationImportAudits }
}

export function purgePreparationData(root: string, sessionIds: Iterable<string>): string[] {
  const targets: string[] = []
  for (const sessionId of new Set(sessionIds)) {
    const paths = preparationPaths(root, sessionId)
    preparationDraftFiles(root, sessionId)
    for (const [path, directory] of [[paths.drafts, true], [paths.permission, false], [paths.audit, false]] as const) {
      if (assertPreparationPath(root, path, directory)) targets.push(path)
    }
    targets.push(...permissionTemporaryFiles(root, paths.permission), ...permissionTemporaryFiles(root, paths.audit))
  }
  for (const path of targets) rmSync(path, { recursive: true, force: false })
  return targets.sort()
}

export function permissionTemporaryFiles(root: string, path: string): string[] {
  const slash = path.lastIndexOf('/'), directory = path.slice(0, slash), name = path.slice(slash + 1)
  if (!assertPreparationPath(root, directory, true)) return []
  return readdirSync(directory).filter(file => file.startsWith(`.${name}.`) && file.endsWith('.tmp')).map(file => {
    const result = join(directory, file); assertPreparationPath(root, result, false); return result
  })
}

/** Imported audit ownership remains discoverable after partial lifecycle cleanup. */
export function preparationProjectSessionIds(root: string, projectId: string): string[] {
  const directory = join(resolve(root), 'private', 'preparation-import-audits')
  if (!assertPreparationPath(root, directory, true)) return []
  const ids: string[] = []
  for (const file of readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
    const path = join(directory, file); assertPreparationPath(root, path, false)
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || value.schemaVersion !== 1 || typeof value.sessionId !== 'string' || file !== `${preparationSessionKey(value.sessionId)}.json`) throw new Error('Invalid preparation import audit')
    if (value.workspaceId === projectId) ids.push(value.sessionId)
  }
  return ids
}
