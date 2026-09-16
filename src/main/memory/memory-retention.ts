import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type { MemoryRetentionInput, MemoryRetentionLayer, MemoryRetentionPreview, MemoryRetentionSaveInput, MemoryRetentionView } from '../../shared/memory-retention-types'
import { withDataLifecycleMutation } from '../data-lifecycle/data-lifecycle-mutation-lock'
import { writeDurableFile } from '../durable-file'
import { expireProjectMemoryByAge } from '../learning/learning-lifecycle'
import { readLearningState } from '../learning/learning-store'
import { projectLearningNamespace } from '../project-aggregate/project-memory-adapter'
import { memoryProjectHash, memoryProjectIdHash, mutateMemoryEntries, type MemoryScope } from './memory-manager'
import { assertMemoryProjectWritable } from './memory-project-lifecycle'
import { assertMemorySessionWritable } from './memory-session-lifecycle'
import {
  entryMatchesRetentionTarget, isMemoryRetentionLayer, layeredMemoryExpired, MEMORY_RETENTION_FILE, memoryAgeExpired,
  normalizeMemoryRetentionDays, readMemoryRetentionPolicies, retentionTargetKey,
  type MemoryRetentionPolicyFile, type MemoryRetentionTarget
} from './memory-retention-policy'

const LAYERS: MemoryRetentionLayer[] = ['working', 'project', 'user']

export async function readMemoryRetention(memoryRoot: string, scope: MemoryScope): Promise<MemoryRetentionView> {
  const file = await readMemoryRetentionPolicies(memoryRoot)
  return view(file, scope)
}

export function previewMemoryRetention(memoryRoot: string, scope: MemoryScope, input: MemoryRetentionInput,
  now = Date.now()): Promise<MemoryRetentionPreview> {
  return withDataLifecycleMutation(dirname(resolve(memoryRoot)), async () => {
    assertScopeWritable(memoryRoot, scope)
    const file = await readMemoryRetentionPolicies(memoryRoot)
    validateInput(file, input)
    const target = requiredTarget(scope, input.layer)
    await applyPolicies(memoryRoot, file, now)
    return buildPreview(memoryRoot, target, input, now)
  })
}

export function saveMemoryRetention(memoryRoot: string, scope: MemoryScope, input: MemoryRetentionSaveInput,
  now = Date.now()): Promise<MemoryRetentionView> {
  return withDataLifecycleMutation(dirname(resolve(memoryRoot)), async () => {
    assertScopeWritable(memoryRoot, scope)
    const file = await readMemoryRetentionPolicies(memoryRoot)
    validateInput(file, input)
    const target = requiredTarget(scope, input.layer)
    if (!Number.isSafeInteger(input.evaluatedAt) || input.evaluatedAt > now || now - input.evaluatedAt > 300_000) {
      throw new Error('记忆清理预览已过期，请重新预览')
    }
    // Expiry is permanent. Turning a policy off cannot revive entries that already expired.
    await applyPolicies(memoryRoot, file, now)
    const preview = await buildPreview(memoryRoot, target, input, input.evaluatedAt)
    if (preview.digest !== input.digest) throw new Error('记忆或作用域已变化，请重新预览')
    const key = retentionTargetKey(target)
    const next: MemoryRetentionPolicyFile = {
      version: 1, revision: file.revision + 1,
      policies: file.policies.filter((policy) => retentionTargetKey(policy.target) !== key)
    }
    if (input.days !== null) next.policies.push({ target, days: input.days, configuredAt: new Date(now).toISOString() })
    await writeDurableFile(join(memoryRoot, MEMORY_RETENTION_FILE), `${JSON.stringify(next, null, 2)}\n`)
    await applyPolicies(memoryRoot, next, now)
    return view(next, scope)
  })
}

/** Called by the existing app retention scheduler; an absent policy never expires data. */
export function sweepMemoryRetention(memoryRoot: string, now = Date.now()): Promise<{ layeredCount: number; projectCount: number }> {
  return withDataLifecycleMutation(dirname(resolve(memoryRoot)), async () =>
    applyPolicies(memoryRoot, await readMemoryRetentionPolicies(memoryRoot), now))
}

async function applyPolicies(memoryRoot: string, file: MemoryRetentionPolicyFile, now: number): Promise<{ layeredCount: number; projectCount: number }> {
  if (!file.policies.length) return { layeredCount: 0, projectCount: 0 }
  const root = dirname(resolve(memoryRoot))
  const policies = file.policies.filter((policy) => {
    if (policy.target.layer === 'user' || !policy.target.projectId) return true
    try { assertMemoryProjectWritable(root, policy.target.projectId); return true } catch { return false }
  })
  const layeredCount = await mutateMemoryEntries(memoryRoot, (entries) => {
    const retained = entries.filter((entry) => !layeredMemoryExpired(entry, policies, now))
    return { entries: retained, result: entries.length - retained.length }
  })
  let projectCount = 0
  for (const policy of policies) {
    if (policy.target.layer !== 'project') continue
    projectCount += await expireProjectMemoryByAge(projectLearningNamespace(policy.target.projectId), join(root, 'learning'), policy.days, now)
  }
  return { layeredCount, projectCount }
}

async function buildPreview(memoryRoot: string, target: MemoryRetentionTarget, input: MemoryRetentionInput,
  evaluatedAt: number): Promise<MemoryRetentionPreview> {
  const layered = await mutateMemoryEntries(memoryRoot, (entries) => ({ entries, result: entries
    .filter((entry) => input.days !== null && entryMatchesRetentionTarget(entry, target) && memoryAgeExpired(entry.updatedAt, input.days, evaluatedAt))
    .map((entry) => [entry.id, entry.updatedAt]) }))
  const learning = target.layer === 'project'
    ? (await readLearningState(join(dirname(resolve(memoryRoot)), 'learning'), projectLearningNamespace(target.projectId))).records
      .filter((record) => input.days !== null && record.kind === 'memory' && record.scope === 'project'
        && (record.status === 'active' || record.status === 'draft') && memoryAgeExpired(record.updatedAt, input.days, evaluatedAt))
      .map((record) => [record.id, record.updatedAt, record.digest, record.status])
    : []
  const digest = createHash('sha256').update(JSON.stringify({
    target: retentionTargetKey(target), layer: input.layer, days: input.days, revision: input.expectedRevision,
    evaluatedAt, layered: layered.sort(), learning: learning.sort()
  })).digest('hex')
  return { layer: input.layer, days: input.days, expectedRevision: input.expectedRevision, evaluatedAt, digest,
    layeredCount: layered.length, projectCount: learning.length }
}

function view(file: MemoryRetentionPolicyFile, scope: MemoryScope): MemoryRetentionView {
  return { revision: file.revision, settings: LAYERS.map((layer) => {
    const target = targetFor(scope, layer)
    const policy = target && file.policies.find((policy) => retentionTargetKey(policy.target) === retentionTargetKey(target))
    return { layer, available: Boolean(target), days: policy?.days ?? null }
  }) }
}

function validateInput(file: MemoryRetentionPolicyFile, input: MemoryRetentionInput): void {
  if (!input || !isMemoryRetentionLayer(input.layer)) throw new Error('记忆保留范围无效')
  normalizeMemoryRetentionDays(input.days)
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== file.revision) throw new Error('保留设置已变化，请刷新后重新预览')
}

function targetFor(scope: MemoryScope, layer: MemoryRetentionLayer): MemoryRetentionTarget | undefined {
  if (layer === 'user') return { layer }
  const projectHash = scope.projectId ? memoryProjectIdHash(scope.projectId) : scope.projectRoot ? memoryProjectHash(scope.projectRoot) : undefined
  if (!projectHash) return undefined
  if (layer === 'project') return scope.projectId ? { layer, projectHash, projectId: scope.projectId } : undefined
  const ownerId = scope.workItemId ?? scope.sessionId
  if (!ownerId) return undefined
  return { layer, projectHash, ...(scope.projectId ? { projectId: scope.projectId } : {}),
    ownerKind: scope.workItemId ? 'workItem' : 'session', ownerId }
}

function requiredTarget(scope: MemoryScope, layer: MemoryRetentionLayer): MemoryRetentionTarget {
  const target = targetFor(scope, layer)
  if (!target) throw new Error(layer === 'project' ? '先将当前任务关联到项目，再配置项目记忆保留期限' : '当前任务记忆范围不可用')
  return target
}

function assertScopeWritable(memoryRoot: string, scope: MemoryScope): void {
  const root = dirname(resolve(memoryRoot))
  if (scope.projectId) assertMemoryProjectWritable(root, scope.projectId)
  assertMemorySessionWritable(root, scope)
}
