export type DesktopNotificationKind = 'complete' | 'failure' | 'approval' | 'update'
export interface DesktopNotificationPreferences {
  completion: 'never' | 'background' | 'always'
  failures: boolean
  approvals: boolean
  sound: boolean
}
export interface TerminalPreferences { fontSize: number; scrollback: number; cursorBlink: boolean }
export const DEFAULT_NOTIFICATION_PREFERENCES: DesktopNotificationPreferences = { completion: 'always', failures: true, approvals: true, sound: true }
export const DEFAULT_TERMINAL_PREFERENCES: TerminalPreferences = { fontSize: 12, scrollback: 5000, cursorBlink: true }
function record(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('桌面偏好配置无效。')
  return raw as Record<string, unknown>
}
function bool(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  if (typeof raw !== 'boolean') throw new Error('开关配置必须是布尔值。')
  return raw
}
export function normalizeNotificationPreferences(raw: unknown): DesktopNotificationPreferences {
  const value = record(raw), completion = value.completion ?? DEFAULT_NOTIFICATION_PREFERENCES.completion
  if (typeof completion !== 'string' || !['never', 'background', 'always'].includes(completion)) throw new Error('任务完成通知选项无效。')
  return { completion: completion as DesktopNotificationPreferences['completion'], failures: bool(value.failures, true), approvals: bool(value.approvals, true), sound: bool(value.sound, true) }
}
export function shouldShowDesktopNotification(enabled: boolean, raw: unknown, kind: DesktopNotificationKind, workbenchFocused: boolean): boolean {
  if (!enabled) return false
  const config = normalizeNotificationPreferences(raw)
  if (kind === 'complete') return config.completion === 'always' || config.completion === 'background' && !workbenchFocused
  if (kind === 'failure') return config.failures
  if (kind === 'approval') return config.approvals
  return true
}
export function normalizeTerminalPreferences(raw: unknown): TerminalPreferences {
  const value = record(raw)
  const fontSize = value.fontSize ?? 12, scrollback = value.scrollback ?? 5000
  if (typeof fontSize !== 'number' || !Number.isFinite(fontSize) || fontSize < 8 || fontSize > 28 ||
    typeof scrollback !== 'number' || !Number.isInteger(scrollback) || scrollback < 100 || scrollback > 100000) throw new Error('终端字号须为 8–28，回看行数须为 100–100000。')
  return { fontSize, scrollback, cursorBlink: bool(value.cursorBlink, true) }
}
