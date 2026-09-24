import type { MenuCommand } from '../../shared/types'
import { matchesShortcut, shortcutFor, type DesktopShortcutAction, type DesktopShortcutSettings, type ShortcutKeyEvent, type ShortcutPlatform } from '../../shared/desktop-shortcuts'

export function desktopShortcutPlatform(): ShortcutPlatform { return /Mac|iPhone|iPad/.test(navigator.platform) ? 'darwin' : 'other' }
export function isShortcutCapture(target: EventTarget | null): boolean { return target instanceof Element && Boolean(target.closest('[data-shortcut-capture]')) }
export function matchesDesktopShortcut(event: ShortcutKeyEvent, action: DesktopShortcutAction, settings?: DesktopShortcutSettings): boolean {
  return matchesShortcut(event, action, settings, desktopShortcutPlatform())
}
export function desktopMenuCommand(event: KeyboardEvent, settings?: DesktopShortcutSettings): MenuCommand | 'searchTasks' | undefined {
  if (event.defaultPrevented || isShortcutCapture(event.target)) return undefined
  if (matchesDesktopShortcut(event, 'newTask', settings)) return { type: 'new-session' }
  if (matchesDesktopShortcut(event, 'settings', settings)) return { type: 'settings' }
  if (matchesDesktopShortcut(event, 'commandPalette', settings)) return { type: 'command-palette' }
  if (matchesDesktopShortcut(event, 'searchTasks', settings)) return 'searchTasks'
  if (matchesDesktopShortcut(event, 'findConversation', settings)) {
    if ((event.target as Element | null)?.closest?.('.monaco-editor, .xterm')) return undefined
    return { type: 'open-search' }
  }
  for (let index = 0; index < 9; index++) if (matchesDesktopShortcut(event, `session${index + 1}` as DesktopShortcutAction, settings)) return { type: 'select-session', index }
  return undefined
}
export function createRewindShortcutMatcher(): (event: KeyboardEvent, settings?: DesktopShortcutSettings) => boolean {
  let lastEscape = 0
  return (event, settings) => {
    if (isShortcutCapture(event.target) || event.isComposing || event.repeat || event.defaultPrevented) return false
    if (shortcutFor('rewind', settings) !== 'Escape Escape') return matchesDesktopShortcut(event, 'rewind', settings)
    if (event.key !== 'Escape' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) { lastEscape = 0; return false }
    const now = Date.now(), matched = lastEscape > 0 && now - lastEscape < 700
    lastEscape = matched ? 0 : now
    return matched
  }
}
