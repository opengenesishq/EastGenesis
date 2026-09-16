import { join } from 'node:path'
import type { ProjectAggregatePortableRuntime, ProjectAggregateSnapshot } from '../../shared/project-aggregate-types'
import type { ProjectLayeredMemorySlice } from '../../shared/layered-memory-portability-types'
import {
  isMemoryEntry, listMemoryEntriesForLifecycle, memoryProjectIdHash, mutateMemoryEntries, vectorize,
  type LayeredMemoryEntry
} from '../memory/memory-manager'
import { assertNoCredentialMaterial, projectAggregateCanonicalJson, projectAggregateDigest, sanitizeProjectAggregateValue } from '../project-aggregate/codec'
import { layeredMemoryExpired, readMemoryRetentionPolicies } from '../memory/memory-retention-policy'
import { withDataLifecycleMutation } from './data-lifecycle-mutation-lock'

type Context = Pick<ProjectAggregatePortableRuntime, 'sessionHistory' | 'activeSessions' | 'sessionCreationJournal' | 'taskSnapshots'>
type Aggregate = Pick<ProjectAggregateSnapshot, 'projectId' | 'workItems' | 'workflow'>

export async function collectProjectLayeredMemory(root: string, aggregate: Aggregate, context: Context): Promise<ProjectLayeredMemorySlice> {
  const hash = memoryProjectIdHash(aggregate.projectId)
  // Expire this Project before taking an export/backup snapshot. Restore verification
  // uses the raw inventory below so it compares the exact imported source first.
  const owned = await withDataLifecycleMutation(root, async () => {
    const memoryRoot = join(root, 'memory')
    const { policies } = await readMemoryRetentionPolicies(memoryRoot)
    const now = Date.now()
    return mutateMemoryEntries(memoryRoot, (values) => {
      const entries = values.filter(entry => entry.layer === 'user' || entry.projectHash !== hash || !layeredMemoryExpired(entry, policies, now))
      return { entries, result: entries.filter(entry => entry.layer !== 'user' && entry.projectHash === hash) }
    })
  })
  const entries = owned
    .map(({ vector: _, ...entry }) => sanitizeProjectAggregateValue(entry) as Omit<LayeredMemoryEntry, 'vector'>)
    .sort(byId)
  const body = { schemaVersion: 1 as const, projectId: aggregate.projectId, entries,
    ownership: 'canonical_project_id' as const, legacyPathOwnership: 'unresolved_not_included' as const,
    unknownOwnership: 'unresolved_not_included' as const }
  const slice = { ...body, sliceDigest: projectAggregateDigest(body) }
  validateProjectLayeredMemory(slice, aggregate, context)
  return slice
}

export function validateProjectLayeredMemory(slice: ProjectLayeredMemorySlice | undefined, aggregate: Aggregate, context: Context): void {
  if (slice === undefined) return
  if (!isRecord(slice) || slice.schemaVersion !== 1 || slice.projectId !== aggregate.projectId || !Array.isArray(slice.entries) ||
      slice.ownership !== 'canonical_project_id' || slice.legacyPathOwnership !== 'unresolved_not_included' ||
      slice.unknownOwnership !== 'unresolved_not_included') fail('invalid slice or ownership')
  const { sliceDigest, ...body } = slice
  if (projectAggregateDigest(body) !== sliceDigest) fail('slice digest mismatch')
  assertNoCredentialMaterial(slice)
  const ids = new Set<string>(), workItems = new Map(aggregate.workItems.map(item => [item.id, item]))
  const hash = memoryProjectIdHash(aggregate.projectId)
  for (const entry of slice.entries) {
    if (!isMemoryEntry({ ...entry, vector: {} }) || !entry.id.trim() || 'vector' in entry || ids.has(entry.id) ||
        entry.layer === 'user' || entry.projectHash !== hash) fail('invalid entry or cross-project ownership')
    ids.add(entry.id)
    if (entry.workItemId) {
      const item = workItems.get(entry.workItemId)
      if (!item || item.projectId !== aggregate.projectId) fail('task ownership is unknown or crosses Project')
    }
    if (entry.sessionId) {
      const bindings = sessionBindings(entry.sessionId, aggregate, context)
      // WorkItem identity remains authoritative after its original Session is deleted.
      // Session-only entries require durable metadata; never widen them to Project memory.
      if ((!entry.workItemId && !bindings.length) || bindings.some(binding =>
        binding.projectId !== aggregate.projectId || (entry.workItemId && binding.workItemId !== entry.workItemId))) {
        fail('Session ownership is unknown or conflicts with the task')
      }
    }
  }
}

export async function assertProjectLayeredMemoryImportable(root: string, slice: ProjectLayeredMemorySlice | undefined): Promise<void> {
  if (!slice) return
  assertCompatible(await listMemoryEntriesForLifecycle(join(root, 'memory')), slice)
}

export async function importProjectLayeredMemory(root: string, slice: ProjectLayeredMemorySlice | undefined): Promise<void> {
  if (!slice) return
  await mutateMemoryEntries(join(root, 'memory'), entries => {
    assertCompatible(entries, slice)
    const installed = new Set(entries.map(entry => entry.id))
    return { entries: [...entries, ...slice.entries.filter(entry => !installed.has(entry.id)).map(materialize)], result: undefined }
  })
}

export async function verifyProjectLayeredMemory(root: string, slice: ProjectLayeredMemorySlice | undefined): Promise<void> {
  if (!slice) return
  const entries = await listMemoryEntriesForLifecycle(join(root, 'memory'))
  assertCompatible(entries, slice)
  const actual = entries.filter(entry => entry.layer !== 'user' && entry.projectHash === memoryProjectIdHash(slice.projectId))
  if (projectAggregateCanonicalJson(actual.sort(byId)) !== projectAggregateCanonicalJson(slice.entries.map(materialize).sort(byId))) {
    fail('restore readback mismatch')
  }
}

export async function purgeProjectLayeredMemory(root: string, projectId: string): Promise<void> {
  const hash = memoryProjectIdHash(projectId)
  await mutateMemoryEntries(join(root, 'memory'), entries => ({
    entries: entries.filter(entry => entry.layer === 'user' || entry.projectHash !== hash), result: undefined
  }))
}

export async function countProjectLayeredMemory(root: string, projectId: string): Promise<number> {
  const hash = memoryProjectIdHash(projectId)
  return (await listMemoryEntriesForLifecycle(join(root, 'memory'))).filter(entry => entry.layer !== 'user' && entry.projectHash === hash).length
}

function assertCompatible(existing: LayeredMemoryEntry[], slice: ProjectLayeredMemorySlice): void {
  const incoming = new Map(slice.entries.map(entry => [entry.id, materialize(entry)]))
  const hash = memoryProjectIdHash(slice.projectId)
  for (const entry of existing) {
    const expected = incoming.get(entry.id)
    if (expected && projectAggregateCanonicalJson(entry) !== projectAggregateCanonicalJson(expected)) fail('destination identity conflict')
    if (entry.layer !== 'user' && entry.projectHash === hash && !expected) fail('destination contains unexported Project memory')
  }
}

function materialize(entry: Omit<LayeredMemoryEntry, 'vector'>): LayeredMemoryEntry {
  return { ...structuredClone(entry), vector: vectorize(`${entry.title}\n${entry.body}\n${entry.tags.join(' ')}`) }
}

function sessionBindings(sessionId: string, aggregate: Aggregate, context: Context): { projectId: unknown; workItemId: unknown }[] {
  const records = [...context.sessionHistory, ...context.activeSessions, ...context.sessionCreationJournal, ...context.taskSnapshots]
  const bindings = records.flatMap(value => {
    if (!isRecord(value)) return []
    const meta = isRecord(value.meta) ? value.meta : isRecord(value.draft) && isRecord(value.draft.baseMeta) ? value.draft.baseMeta : value
    if (meta.id !== sessionId && value.sessionId !== sessionId && meta.taskMemorySessionId !== sessionId) return []
    return [{ projectId: meta.workspaceId, workItemId: meta.workItemId }]
  })
  return [...bindings, ...aggregate.workflow.runs.filter(run => run.sessionId === sessionId)
    .map(run => ({ projectId: run.projectId, workItemId: run.workItemId }))]
}
function byId(a: { id: string }, b: { id: string }): number { return a.id.localeCompare(b.id) }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function fail(message: string): never { throw new Error(`Project layered memory: ${message}`) }
