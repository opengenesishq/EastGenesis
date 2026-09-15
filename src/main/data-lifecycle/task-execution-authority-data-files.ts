import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertPreparationPath, permissionTemporaryFiles, preparationSessionKey } from './preparation-data-files'
import { parseTaskExecutionAuthorityRecord } from '../permission/task-execution-authority-store'

function authorityPath(root: string, sessionId: string): string {
  return join(resolve(root), 'private', 'task-execution-authorities', `${preparationSessionKey(sessionId)}.json`)
}

export function taskExecutionAuthorityFiles(root: string, sessionIds: Iterable<string>): string[] {
  const targets = new Set<string>()
  for (const sessionId of new Set(sessionIds)) {
    const path = authorityPath(root, sessionId)
    if (assertPreparationPath(root, path, false)) targets.add(path)
    for (const temporary of permissionTemporaryFiles(root, path)) targets.add(temporary)
  }
  return [...targets].sort()
}

export function purgeTaskExecutionAuthorityFiles(root: string, sessionIds: Iterable<string>): string[] {
  const paths = taskExecutionAuthorityFiles(root, sessionIds)
  for (const path of paths) rmSync(path)
  return paths
}

/** Retain ownership discovery if a crash removed the public Session indexes first. */
export function taskExecutionAuthorityProjectSessionIds(root: string, projectId: string): string[] {
  const directory = join(resolve(root), 'private', 'task-execution-authorities')
  if (!assertPreparationPath(root, directory, true)) return []
  const ids = new Set<string>()
  for (const name of readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name) && !/^\.[a-f0-9]{64}\.json\..+\.tmp$/.test(name)) continue
    const path = join(directory, name)
    assertPreparationPath(root, path, false)
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || typeof value.sessionId !== 'string') throw new Error('Task execution authority cleanup identity is invalid')
    const key = preparationSessionKey(value.sessionId)
    if (name !== `${key}.json` && !(name.startsWith(`.${key}.json.`) && name.endsWith('.tmp'))) {
      throw new Error('Task execution authority cleanup path differs from its Session')
    }
    const record = parseTaskExecutionAuthorityRecord(value, value.sessionId)
    if (record.projectId === projectId || record.workspaceId === projectId) ids.add(record.sessionId)
  }
  return [...ids].sort()
}
