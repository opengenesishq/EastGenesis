import { randomUUID } from 'node:crypto'
import type { GuiPreviewAction } from '../../shared/gui-preview-types'
import type { SessionMeta } from '../../shared/types'
import type { ToolExecResult } from '../agent/tools/tool-types'

export interface GuiPreviewBinding {
  sessionId: string
  ownership: string
  runId?: string
  authorityRevision: number
  permissionKey: string
}
export interface GuiPreviewCapture {
  path: string
  cwd: string
  sha256: string
  sourceLabel: string
  capturedAt: number
  width: number
  height: number
}
export interface GuiPreviewInvocation {
  binding: GuiPreviewBinding
  action: GuiPreviewAction
  cwd: string
}
export type GuiPreviewEvent =
  | { kind: 'started'; invocation: GuiPreviewInvocation }
  | { kind: 'finished'; invocation: GuiPreviewInvocation; ok: boolean; capture?: GuiPreviewCapture }
  | { kind: 'invalidated'; sessionId?: string }

const actions: Record<string, string> = {
  gui_list_windows: '查看窗口', gui_activate_window: '切换窗口', gui_screenshot: '截取画面',
  gui_click: '点击', gui_type: '输入文字', gui_scroll: '滚动', gui_hotkey: '使用快捷键'
}
const listeners = new Set<(event: GuiPreviewEvent) => void>()
// Only bounded, sanitized main-process records are retained. No desktop bytes or raw input.
const latest = new Map<string, Exclude<GuiPreviewEvent, { kind: 'invalidated' }>>()
const captures = new Map<string, Extract<GuiPreviewEvent, { kind: 'finished' }>>()

export function guiPreviewBinding(meta: SessionMeta, ownership: string, runId: string | undefined, authorityRevision: number): GuiPreviewBinding {
  return { sessionId: meta.id, ownership, runId, authorityRevision,
    permissionKey: JSON.stringify([meta.permissionMode, meta.driveMode, meta.taskStrategy]) }
}
export function sameGuiPreviewBinding(a: GuiPreviewBinding, b: GuiPreviewBinding): boolean {
  return a.sessionId === b.sessionId && a.ownership === b.ownership && a.runId === b.runId &&
    a.authorityRevision === b.authorityRevision && a.permissionKey === b.permissionKey
}
export function subscribeGuiPreviewEvents(listener: (event: GuiPreviewEvent) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function latestGuiPreviewEvent(sessionId: string): Exclude<GuiPreviewEvent, { kind: 'invalidated' }> | undefined {
  return latest.get(sessionId)
}
export function latestGuiPreviewCaptureEvent(sessionId: string): Extract<GuiPreviewEvent, { kind: 'finished' }> | undefined {
  return captures.get(sessionId)
}
function publish(event: GuiPreviewEvent): void {
  for (const listener of listeners) {
    // A view must never fail or block native tool execution.
    try { listener(event) } catch { /* isolated observer */ }
  }
}
export function invalidateGuiPreview(sessionId?: string): void {
  if (sessionId) { latest.delete(sessionId); captures.delete(sessionId) }
  else { latest.clear(); captures.clear() }
  publish({ kind: 'invalidated', sessionId })
}
function label(value: unknown, limit = 100): string {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : ''
}
export function guiPreviewTarget(input: Record<string, unknown>): string {
  const target = [label(input.processName), label(input.title), label(input.windowId), label(input.sourceId)].filter(Boolean)
  if (typeof input.pid === 'number' && Number.isSafeInteger(input.pid)) target.push(`PID ${input.pid}`)
  const element = label(input.elementName || input.elementId || input.automationId)
  if (element) target.push(element)
  if (Number.isFinite(input.x) && Number.isFinite(input.y)) target.push(`(${input.x}, ${input.y})`)
  return target.join(' · ').slice(0, 240) || '当前桌面'
}
/** Call only at the actual, post-approval execution point. */
export function beginGuiPreviewTool(binding: GuiPreviewBinding, cwd: string, name: string, input: Record<string, unknown>): GuiPreviewInvocation | undefined {
  if (!actions[name] || !binding.runId) return undefined
  const invocation: GuiPreviewInvocation = { binding: { ...binding }, cwd,
    action: { id: randomUUID(), toolName: name, label: actions[name], target: guiPreviewTarget(input), startedAt: Date.now() } }
  const event = { kind: 'started' as const, invocation }
  const previousCapture = captures.get(binding.sessionId)
  if (previousCapture && !sameGuiPreviewBinding(previousCapture.invocation.binding, binding)) captures.delete(binding.sessionId)
  latest.delete(binding.sessionId); latest.set(binding.sessionId, event)
  while (latest.size > 64) { const oldest = latest.keys().next().value!; latest.delete(oldest); captures.delete(oldest) }
  publish(event)
  return invocation
}
export function finishGuiPreviewTool(invocation: GuiPreviewInvocation | undefined, result: ToolExecResult): void {
  if (!invocation || latest.get(invocation.binding.sessionId)?.invocation.action.id !== invocation.action.id) return
  let capture: GuiPreviewCapture | undefined
  if (result.ok && invocation.action.toolName === 'gui_screenshot') {
    const artifact = result.producedArtifacts?.find(item => item.producer === 'gui_screenshot' && item.kind === 'screenshot' &&
      item.mediaType === 'image/png' && item.evidenceVerifier === 'gui-runtime')
    const meta = artifact?.metadata
    if (artifact && typeof meta?.captureSha256 === 'string' && /^[a-f0-9]{64}$/.test(meta.captureSha256) &&
      typeof meta.capturedAt === 'number' && Number.isFinite(meta.capturedAt) &&
      typeof meta.width === 'number' && typeof meta.height === 'number') {
      capture = { path: artifact.path, cwd: invocation.cwd, sha256: meta.captureSha256,
        capturedAt: meta.capturedAt, sourceLabel: label(meta.sourceName, 180) || label(meta.sourceId) || '已授权截图',
        width: meta.width, height: meta.height }
    }
  }
  const event = { kind: 'finished' as const, invocation: { ...invocation, action: { ...invocation.action, finishedAt: Date.now() } }, ok: result.ok, capture }
  if (capture) captures.set(invocation.binding.sessionId, event)
  latest.set(invocation.binding.sessionId, event)
  publish(event)
}
