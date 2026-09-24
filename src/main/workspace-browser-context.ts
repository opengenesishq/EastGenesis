import { randomUUID } from 'node:crypto'

export interface WorkspaceBrowserContext {
  id: string
  ownerId: number
  cwd: string
  sourceKind: 'workspace_human'
}
/** Browser identity is a window-owned UI context, never a chat Session. */
export class WorkspaceBrowserRegistry {
  private readonly byOwner = new Map<number, WorkspaceBrowserContext>()
  private readonly byId = new Map<string, WorkspaceBrowserContext>()
  acquire(ownerId: number, cwd: string): WorkspaceBrowserContext {
    const existing = this.byOwner.get(ownerId)
    if (existing) return existing
    const context = { id: `workspace-browser:${randomUUID()}`, ownerId, cwd, sourceKind: 'workspace_human' as const }
    this.byOwner.set(ownerId, context); this.byId.set(context.id, context)
    return context
  }
  get(id: string, ownerId: number): WorkspaceBrowserContext | undefined {
    if (typeof id !== 'string' || !id.trim()) throw new Error('浏览器标识无效。')
    if (!id.startsWith('workspace-browser:')) return undefined
    const value = this.byId.get(id)
    if (!value || value.ownerId !== ownerId) throw new Error('此独立浏览器不属于当前窗口或已经关闭。')
    return value
  }
  visible(id: string | undefined, ownerId: number): boolean {
    if (id === undefined) return true
    if (!id.startsWith('workspace-browser:')) return true
    return this.byId.get(id)?.ownerId === ownerId
  }
  release(ownerId: number): string | undefined {
    const context = this.byOwner.get(ownerId)
    if (!context) return undefined
    this.byOwner.delete(ownerId); this.byId.delete(context.id)
    return context.id
  }
}
export const workspaceBrowserRegistry = new WorkspaceBrowserRegistry()
