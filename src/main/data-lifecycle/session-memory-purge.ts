import { join } from 'node:path'
import { listTaskSnapshots } from '../task/task-snapshot'
import { listMemoryEntriesForLifecycle, memoryProjectHash, memoryProjectIdHash, mutateMemoryEntries, type LayeredMemoryEntry } from '../memory/memory-manager'
import { readMemorySessionIdentities, type MemorySessionIdentity } from '../memory/memory-session-inventory'
import type { SessionDeletionMemoryScope } from './session-deletion-journal'

export async function captureSessionDeletionMemoryScope(root: string, sessionId: string): Promise<SessionDeletionMemoryScope> {
  const identities = readMemorySessionIdentities(root, await listTaskSnapshots(root)).filter(meta => meta.id === sessionId)
  if (!identities.length) return { ownership: 'unresolved' }
  const bindings = identities.map(binding)
  if (bindings.some(value => value === undefined)) return { ownership: 'unresolved' }
  const unique = new Map(bindings.map(value => [JSON.stringify(value), value!]))
  if (unique.size !== 1) throw new Error('Session memory ownership changed across retained records')
  return { ownership: 'resolved', ...[...unique.values()][0] }
}

export async function purgeStandaloneSessionMemory(root: string, sessionId: string, scope?: SessionDeletionMemoryScope): Promise<number> {
  if (scope?.ownership !== 'resolved') return 0
  const snapshots = await listTaskSnapshots(root)
  return mutateMemoryEntries(join(root, 'memory'), entries => {
    if (hasRetainedOwner(root, sessionId, scope, snapshots)) return { entries, result: 0 }
    const kept = entries.filter(entry => !matches(entry, scope))
    return { entries: kept, result: entries.length - kept.length }
  })
}

export async function countStandaloneSessionMemory(root: string, sessionId: string, scope?: SessionDeletionMemoryScope): Promise<number> {
  if (scope?.ownership !== 'resolved') return 0
  if (hasRetainedOwner(root, sessionId, scope, await listTaskSnapshots(root))) return 0
  return (await listMemoryEntriesForLifecycle(join(root, 'memory'))).filter(entry => matches(entry, scope)).length
}

function hasRetainedOwner(root: string, deletedSessionId: string, scope: Extract<SessionDeletionMemoryScope, { ownership: 'resolved' }>, snapshots: readonly unknown[]): boolean {
  return readMemorySessionIdentities(root, snapshots).some(meta => {
    if (meta.id === deletedSessionId || (meta.taskMemorySessionId ?? meta.id) !== scope.sessionId) return false
    const candidate = binding(meta)
    // A matching anchor with incomplete metadata may still depend on this memory.
    return !candidate || candidate.projectHash === scope.projectHash
  })
}

function binding(meta: MemorySessionIdentity): { sessionId: string; projectHash: string } | undefined {
  const projectId = meta.workspaceId, cwd = meta.sourceCwd ?? meta.cwd
  if (!projectId && !cwd) return undefined
  return { sessionId: meta.taskMemorySessionId ?? meta.id, projectHash: projectId ? memoryProjectIdHash(projectId) : memoryProjectHash(cwd!) }
}
function matches(entry: LayeredMemoryEntry, scope: Extract<SessionDeletionMemoryScope, { ownership: 'resolved' }>): boolean {
  return entry.layer === 'working' && !entry.workItemId && entry.sessionId === scope.sessionId && entry.projectHash === scope.projectHash
}
