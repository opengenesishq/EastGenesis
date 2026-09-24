import type { SessionMeta } from '../../../../shared/types'

/** An open palace surface keeps the task identity it was opened for. */
export type PalaceSessionBinding = Pick<SessionMeta, 'id' | 'workspaceId' | 'goalId' | 'workItemId'>

export function capturePalaceSessionBinding(meta: SessionMeta): PalaceSessionBinding {
  return { id: meta.id, workspaceId: meta.workspaceId, goalId: meta.goalId, workItemId: meta.workItemId }
}

export function isPalaceSessionBindingCurrent(binding: PalaceSessionBinding, meta: SessionMeta | undefined): boolean {
  return Boolean(meta && meta.status !== 'closed' && meta.id === binding.id && meta.workspaceId === binding.workspaceId &&
    meta.goalId === binding.goalId && meta.workItemId === binding.workItemId)
}
