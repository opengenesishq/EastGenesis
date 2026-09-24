import type { SessionMeta } from '../../shared/types'
import { SessionInputService } from './session-input-service'
import { beginSessionFollowUpDispatch, isSessionFollowUpActive, withdrawSessionFollowUp } from './session-follow-up-gate'

export interface FollowUpRuntime {
  meta(id: string): SessionMeta | undefined
  pause(id: string, messageId: string): Promise<void>
  barrier(id: string): Promise<void>
  assertSafe(id: string): void
}

/** One durable input starts one turn. Earlier manual/unknown receipts block later inputs. */
export class SessionFollowUpCoordinator {
  private draining = new Map<string, Promise<void>>()
  private pending = new Set<string>()

  constructor(private root: string, private service: SessionInputService, private runtime: FollowUpRuntime) {}

  schedule(id: string): void {
    this.pending.add(id)
    setImmediate(() => { void this.drain(id).catch(() => undefined) })
  }

  drain(id: string): Promise<void> {
    const current = this.draining.get(id)
    if (current) return current
    this.pending.delete(id)
    const operation = this.performDrain(id).finally(() => {
      this.draining.delete(id)
      if (this.pending.delete(id)) this.schedule(id)
    })
    this.draining.set(id, operation)
    return operation
  }

  private async performDrain(id: string): Promise<void> {
    const records = await this.service.list(id)
    const record = records.find(item => !['applied', 'requirements_applied', 'goal_revised', 'cancelled'].includes(item.phase))
    if (!record || record.phase !== 'queued' || !record.followUp || record.followUp.state !== 'armed') return
    if (record.payload.goalRevisionIntent || record.payload.requirementRevisionIntent) return
    if (!isSessionFollowUpActive(this.root, record, this.runtime.meta(id))) return
    let endDispatch: (() => void) | undefined
    try {
      const meta = this.runtime.meta(id)
      if (!meta || meta.status === 'closed' || meta.status === 'error') throw new Error('任务已停止，补充要求保留供手动继续')
      const running = meta.status === 'running' || meta.status === 'starting'
      if (running && record.followUp.behavior === 'queue') return
      endDispatch = beginSessionFollowUpDispatch(this.root, record, meta)
      if (running) await this.runtime.pause(id, record.messageId)
      await this.runtime.barrier(id)
      const assertCurrent = async (): Promise<void> => {
        if (!isSessionFollowUpActive(this.root, record, this.runtime.meta(id))) throw new Error('自动继续已暂停，补充要求仍保留在原任务')
        if (this.runtime.meta(id)?.status !== 'idle') throw new Error('执行器尚未安全停止，请核对原任务后继续')
        this.runtime.assertSafe(id)
      }
      await assertCurrent()
      await this.service.apply(id, record.id, assertCurrent)
    } catch (error) {
      withdrawSessionFollowUp(record)
      await this.service.suspendFollowUp(id, record.id, error instanceof Error ? error.message : String(error))
    } finally {
      endDispatch?.()
    }
  }
}
