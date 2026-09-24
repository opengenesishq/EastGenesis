import type { GuiPreviewFrame, GuiPreviewSnapshot } from '../../shared/gui-preview-types'
import { sameGuiPreviewBinding, type GuiPreviewBinding, type GuiPreviewCapture, type GuiPreviewEvent } from './gui-preview-events'

export interface GuiPreviewContext {
  binding: GuiPreviewBinding
  title: string
  language: 'zh' | 'en'
  taskStatus: string
  enabled: boolean
  pendingApprovalCount: number
}

/** One state machine per window. Binding changes can never adopt another task's frame. */
export class GuiPreviewState {
  private context: GuiPreviewContext
  private readonly ownership: string
  private snapshotValue: GuiPreviewSnapshot
  private generation = 0
  private invalidated = false
  private stopped = false

  constructor(context: GuiPreviewContext) {
    this.context = context
    this.ownership = context.binding.ownership
    this.snapshotValue = { sessionId: context.binding.sessionId, title: context.title, runId: context.binding.runId,
      language: context.language, phase: 'idle', taskStatus: context.taskStatus, pendingApprovalCount: 0,
      canStop: false, available: true, revision: 0 }
    this.update(context)
  }

  update(context: GuiPreviewContext): void {
    if (context.binding.sessionId !== this.snapshotValue.sessionId || context.binding.ownership !== this.ownership) {
      this.invalidate('任务归属已变化，请从原任务重新打开画中画。', true)
      return
    }
    if (!sameGuiPreviewBinding(context.binding, this.context.binding)) {
      this.clear(); this.stopped = false
    }
    this.context = context
    const available = !this.invalidated && context.taskStatus !== 'closed'
    if (!available || !context.enabled) this.clear()
    this.snapshotValue = { ...this.snapshotValue, title: context.title, runId: context.binding.runId, language: context.language,
      taskStatus: context.taskStatus, pendingApprovalCount: context.pendingApprovalCount, available,
      canStop: available && !this.stopped && (context.taskStatus === 'running' || context.taskStatus === 'starting' || context.pendingApprovalCount > 0) }
    if (!available) {
      this.snapshotValue.phase = 'unavailable'
      this.snapshotValue.message ??= '原任务已关闭或不可用。'
    } else if (!context.enabled) {
      this.snapshotValue.phase = 'unavailable'; this.snapshotValue.message = '电脑操作权限已关闭。'
    } else if (!this.stopped && context.pendingApprovalCount > 0) {
      this.snapshotValue.phase = 'waiting'; this.snapshotValue.message = '请回到原任务审批此次操作。'
    } else if (!this.stopped && this.snapshotValue.phase === 'waiting') {
      this.snapshotValue.phase = 'idle'; this.snapshotValue.message = undefined
    } else if (!this.stopped && this.snapshotValue.phase === 'unavailable') {
      this.snapshotValue.phase = 'idle'; this.snapshotValue.message = undefined
    }
    this.snapshotValue.revision++
  }

  snapshot(): GuiPreviewSnapshot {
    return { ...this.snapshotValue, action: this.snapshotValue.action && { ...this.snapshotValue.action },
      frame: this.snapshotValue.frame && { ...this.snapshotValue.frame } }
  }

  async accept(event: GuiPreviewEvent, load: (capture: GuiPreviewCapture) => Promise<GuiPreviewFrame>, fresh: () => GuiPreviewContext): Promise<void> {
    if (event.kind === 'invalidated') {
      if (!event.sessionId || event.sessionId === this.snapshotValue.sessionId) this.invalidate('电脑操作授权已撤销，旧画面已清除。')
      return
    }
    this.update(fresh())
    if (!this.accepts(event.invocation.binding)) return
    const token = this.generation
    if (event.kind === 'started') {
      this.snapshotValue.action = { ...event.invocation.action }; this.snapshotValue.phase = 'running'
      this.snapshotValue.message = undefined; this.snapshotValue.revision++
      return
    }
    // A later operation must not be overwritten by an older concurrent completion.
    if (this.snapshotValue.action && this.snapshotValue.action.id !== event.invocation.action.id &&
      this.snapshotValue.action.startedAt >= event.invocation.action.startedAt) return
    this.snapshotValue.action = { ...event.invocation.action }
    this.snapshotValue.phase = event.ok ? 'completed' : 'failed'
    this.snapshotValue.message = event.ok ? undefined : '电脑操作未成功，请在原任务查看结果。'
    this.snapshotValue.revision++
    if (!event.capture) return
    try {
      const frame = await load(event.capture)
      this.update(fresh())
      if (token !== this.generation || !this.accepts(event.invocation.binding)) return
      if (!this.snapshotValue.frame || frame.capturedAt >= this.snapshotValue.frame.capturedAt) this.snapshotValue.frame = frame
    } catch {
      if (token === this.generation && this.accepts(event.invocation.binding)) this.snapshotValue.message = '截图已失效或无法读取，请在原任务查看记录。'
    }
    this.snapshotValue.revision++
  }

  startStopping(): void {
    if (!this.snapshotValue.canStop) throw new Error('原任务当前没有可暂停的执行。')
    this.clear(); this.stopped = true; this.snapshotValue.canStop = false
    this.snapshotValue.phase = 'stopping'; this.snapshotValue.message = '正在停止当前任务，等待执行器确认。'
    this.snapshotValue.revision++
  }
  stoppedResult(error?: string): void {
    if (error) { this.stopped = false; this.generation++; this.update(this.context) }
    this.snapshotValue.phase = error ? 'failed' : 'paused'
    this.snapshotValue.message = error ? `停止未完成：${error}` : '已停止当前任务并撤销临时电脑操作授权。可回原任务继续。'
    this.snapshotValue.revision++
  }
  invalidate(message: string, permanent = false): void {
    this.clear(); this.invalidated ||= permanent
    this.snapshotValue.message = message
    if (permanent) { this.snapshotValue.available = false; this.snapshotValue.canStop = false; this.snapshotValue.phase = 'unavailable' }
    this.snapshotValue.revision++
  }
  private accepts(binding: GuiPreviewBinding): boolean {
    return !this.invalidated && !this.stopped && this.context.enabled && this.snapshotValue.available &&
      Boolean(binding.runId) && sameGuiPreviewBinding(this.context.binding, binding)
  }
  private clear(): void {
    this.generation++; this.snapshotValue.action = undefined; this.snapshotValue.frame = undefined
    if (!this.stopped) this.snapshotValue.phase = 'idle'
  }
}
