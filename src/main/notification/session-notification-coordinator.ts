import type { AgentEvent, SessionMeta } from '../../shared/types'
import { showDesktopNotification } from '../desktopNotify'
import { getSettings } from '../settings'
import type { SessionNotificationState } from '../session-manager-support'

export class SessionNotificationCoordinator {
  private readonly states = new Map<string, SessionNotificationState>()

  constructor(private readonly findMeta: (sessionId: string) => SessionMeta | undefined) {}

  delete(sessionId: string): void {
    this.states.delete(sessionId)
  }

  clear(): void {
    this.states.clear()
  }

  handle(sessionId: string, event: AgentEvent): void {
    const meta = this.findMeta(sessionId)
    if (!meta && !this.states.has(sessionId)) return
    const state = this.state(sessionId)
    const label = sessionLabel(meta)
    if (event.kind === 'user-message') return this.startTurn(state)
    if (event.kind === 'status') return this.handleStatus(sessionId, event, state, label, meta)
    if (event.kind === 'permission-request') return this.handlePermission(sessionId, event, state, label)
    if (event.kind === 'permission-resolved') {
      state.pendingPermissionIds.delete(event.requestId)
      return
    }
    if (event.kind === 'turn-result') this.handleTurnResult(sessionId, event, state, label)
  }

  private state(sessionId: string): SessionNotificationState {
    let state = this.states.get(sessionId)
    if (!state) {
      state = { turnActive: false, permissionRequestIds: new Set(), pendingPermissionIds: new Set(), terminalNotified: false }
      this.states.set(sessionId, state)
    }
    return state
  }

  private startTurn(state: SessionNotificationState): void {
    state.turnActive = true
    state.permissionRequestIds = new Set(state.pendingPermissionIds)
    state.terminalNotified = false
  }

  private handleStatus(
    sessionId: string,
    event: Extract<AgentEvent, { kind: 'status' }>,
    state: SessionNotificationState,
    label: string,
    meta?: SessionMeta
  ): void {
    if (event.status === 'running' && !state.turnActive) this.startTurn(state)
    else if (event.status === 'error') {
      if (!state.terminalNotified) {
        const error = event.error || meta?.lastError || '未知错误'
        this.notify(sessionId, 'CaoGen: 任务失败', `${label} · ${trimText(error)}`)
        state.terminalNotified = true
      }
      state.turnActive = false
    } else if (event.status === 'idle' || event.status === 'closed') {
      state.turnActive = false
      if (event.status === 'closed') this.states.delete(sessionId)
    }
  }

  private handlePermission(
    sessionId: string,
    event: Extract<AgentEvent, { kind: 'permission-request' }>,
    state: SessionNotificationState,
    label: string
  ): void {
    const requestId = event.request.requestId
    if (state.permissionRequestIds.has(requestId)) return
    state.permissionRequestIds.add(requestId)
    const needsAttention = state.pendingPermissionIds.size === 0
    state.pendingPermissionIds.add(requestId)
    if (needsAttention) {
      this.notify(sessionId, 'CaoGen: 等待权限', `${label} · ${trimText(event.request.toolName, 60)} · 打开任务查看待办`)
    }
  }

  private handleTurnResult(
    sessionId: string,
    event: Extract<AgentEvent, { kind: 'turn-result' }>,
    state: SessionNotificationState,
    label: string
  ): void {
    if (!state.terminalNotified) {
      const bits = turnResultBits(label, event)
      this.notify(sessionId, event.isError ? 'CaoGen: 任务失败' : 'CaoGen: 任务完成', bits.join(' · '))
      state.terminalNotified = true
    }
    state.turnActive = false
  }

  private notify(sessionId: string, title: string, body: string): void {
    if (!getSettings().notificationsEnabled) return
    showDesktopNotification({ title, body, sessionId })
  }
}

function sessionLabel(meta: SessionMeta | undefined): string {
  if (!meta) return '未知会话'
  if (meta.title && meta.title !== '新会话') return trimText(meta.title, 80)
  return trimText(meta.cwd, 100)
}

function turnResultBits(label: string, event: Extract<AgentEvent, { kind: 'turn-result' }>): string[] {
  const bits = [label]
  const duration = formatDuration(event.durationMs)
  if (duration) bits.push(duration)
  if (typeof event.costUsd === 'number' && Number.isFinite(event.costUsd)) bits.push(`$${event.costUsd.toFixed(4)}`)
  if (event.isError && event.resultText) bits.push(trimText(event.resultText))
  return bits
}

function trimText(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function formatDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`
}
