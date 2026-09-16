import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const HASH_NAMESPACE = 'caogen-layered-memory-v1'

export function memoryProjectHash(projectRoot: string): string {
  return createHash('sha256').update(`${HASH_NAMESPACE}\0${resolve(projectRoot)}`).digest('hex')
}

export function memoryProjectIdHash(projectId: string): string {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('projectId 不能为空')
  if (projectId.includes('\0')) throw new Error('projectId 包含非法字符')
  return createHash('sha256').update(`${HASH_NAMESPACE}\0project-id\0${projectId.trim()}`).digest('hex')
}
