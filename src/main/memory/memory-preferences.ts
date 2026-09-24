import { AsyncLocalStorage } from 'node:async_hooks'
import type { SessionMeta } from '../../shared/types'
import { resolveMemoryPreferences, type TaskMemoryPreferences } from '../../shared/memory-preferences-types'
import { getSettings } from '../settings'

type TaskMemoryMeta = Pick<SessionMeta, 'memoryOverrides'> & Partial<Pick<SessionMeta, 'status'>>
type MetaSource = TaskMemoryMeta | (() => TaskMemoryMeta)
const taskContext = new AsyncLocalStorage<MetaSource>()

/** Keep a live task reference across store locks; a later switch must govern the eventual write. */
export function withTaskMemoryPreferences<T>(meta: MetaSource, operation: () => T): T {
  return taskContext.run(meta, operation)
}

export function currentTaskMemoryPreferences(meta?: TaskMemoryMeta): TaskMemoryPreferences {
  const source = taskContext.getStore()
  const task = meta ?? (typeof source === 'function' ? source() : source)
  return resolveMemoryPreferences(getSettings().memoryPreferences, task?.memoryOverrides,
    Boolean(process.env.CAOGEN_TEMPORARY_PROFILE_ID) || task?.status === 'closed')
}

export function assertSharedMemoryContributionAllowed(): void {
  if (!currentTaskMemoryPreferences().effective.contributeSharedMemory) {
    throw new Error('共享记忆贡献已关闭。可继续保存当前任务记忆；如需共享，请先开启记忆贡献。')
  }
}

export function isTaskOwnedMemory(entry: { layer: string; sessionId?: string; workItemId?: string }): boolean {
  return entry.layer === 'working' && Boolean(entry.sessionId || entry.workItemId)
}
