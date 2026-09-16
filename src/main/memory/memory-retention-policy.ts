import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryRetentionLayer } from '../../shared/memory-retention-types'
import type { LayeredMemoryEntry } from './memory-manager'
import { memoryProjectIdHash } from './memory-project-identity'

export type MemoryRetentionTarget =
  | { layer: 'user' }
  | { layer: 'project'; projectHash: string; projectId: string }
  | { layer: 'working'; projectHash: string; projectId?: string; ownerKind: 'session' | 'workItem'; ownerId: string }

export interface MemoryRetentionPolicy {
  target: MemoryRetentionTarget
  days: number
  configuredAt: string
}

export interface MemoryRetentionPolicyFile {
  version: 1
  revision: number
  policies: MemoryRetentionPolicy[]
}

export const MEMORY_RETENTION_FILE = 'memory-retention.json'
export const MEMORY_RETENTION_DAY_MS = 86_400_000

export function retentionTargetKey(target: MemoryRetentionTarget): string {
  return target.layer === 'user' ? 'user' : target.layer === 'project'
    ? JSON.stringify(['project', target.projectHash, target.projectId])
    : JSON.stringify(['working', target.projectHash, target.projectId ?? null, target.ownerKind, target.ownerId])
}

export function normalizeMemoryRetentionDays(value: unknown): number | null {
  if (value === null) return null
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 36_500) {
    throw new Error('保留天数须为 1 至 36500 的整数，或永久保留')
  }
  return Number(value)
}

export async function readMemoryRetentionPolicies(memoryRoot: string): Promise<MemoryRetentionPolicyFile> {
  let raw: string
  try { raw = await readFile(join(memoryRoot, MEMORY_RETENTION_FILE), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, revision: 0, policies: [] }
    throw error
  }
  try {
    const value = JSON.parse(raw)
    if (value?.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.policies)) throw new Error('schema')
    for (const policy of value.policies) {
      if (!policy || normalizeMemoryRetentionDays(policy.days) === null || !Number.isFinite(Date.parse(policy.configuredAt))) throw new Error('policy')
      const target = policy.target
      if (!target || !['working', 'project', 'user'].includes(target.layer)) throw new Error('target')
      if (target.layer !== 'user' && !/^[a-f0-9]{64}$/.test(target.projectHash)) throw new Error('project hash')
      if (target.layer === 'project' && !safeIdentity(target.projectId)) throw new Error('project')
      if (target.layer === 'working' && (!['session', 'workItem'].includes(target.ownerKind) || !safeIdentity(target.ownerId)
        || (target.projectId !== undefined && !safeIdentity(target.projectId))
        || (target.ownerKind === 'workItem' && !target.projectId))) throw new Error('owner')
      if (target.layer !== 'user' && target.projectId !== undefined && memoryProjectIdHash(target.projectId) !== target.projectHash) throw new Error('project identity mismatch')
    }
    if (new Set(value.policies.map((policy: MemoryRetentionPolicy) => retentionTargetKey(policy.target))).size !== value.policies.length) throw new Error('duplicate')
    return value as MemoryRetentionPolicyFile
  } catch {
    throw new Error('记忆保留设置损坏，已保留原文件并停止清理')
  }
}

export function entryMatchesRetentionTarget(entry: LayeredMemoryEntry, target: MemoryRetentionTarget): boolean {
  if (entry.layer !== target.layer) return false
  if (target.layer === 'user') return true
  if (entry.projectHash !== target.projectHash) return false
  if (target.layer === 'project') return true
  return target.ownerKind === 'workItem'
    ? entry.workItemId === target.ownerId
    : !entry.workItemId && entry.sessionId === target.ownerId
}

export function memoryAgeExpired(updatedAt: string, days: number, now: number): boolean {
  const updated = Date.parse(updatedAt)
  return Number.isFinite(updated) && updated <= now - days * MEMORY_RETENTION_DAY_MS
}

export function layeredMemoryExpired(entry: LayeredMemoryEntry, policies: readonly MemoryRetentionPolicy[], now: number): boolean {
  return policies.some((policy) => entryMatchesRetentionTarget(entry, policy.target) && memoryAgeExpired(entry.updatedAt, policy.days, now))
}

export function isMemoryRetentionLayer(value: unknown): value is MemoryRetentionLayer {
  return value === 'working' || value === 'project' || value === 'user'
}

function safeIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
}
