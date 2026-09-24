export const DESKTOP_SHORTCUTS = [
  { id: 'newTask', zh: '新建任务', en: 'New task', defaultKey: 'CommandOrControl+N', group: 'navigation' },
  { id: 'settings', zh: '打开设置', en: 'Settings', defaultKey: 'CommandOrControl+,', group: 'navigation' },
  { id: 'commandPalette', zh: '命令面板', en: 'Command palette', defaultKey: 'CommandOrControl+K', group: 'navigation' },
  { id: 'findConversation', zh: '查找当前对话', en: 'Find in conversation', defaultKey: 'CommandOrControl+F', group: 'navigation' },
  { id: 'searchTasks', zh: '搜索所有任务', en: 'Search tasks', defaultKey: 'CommandOrControl+Shift+F', group: 'navigation' },
  ...Array.from({ length: 9 }, (_, index) => ({ id: `session${index + 1}` as `session${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`,
    zh: `切换到任务 ${index + 1}`, en: `Switch to task ${index + 1}`, defaultKey: `CommandOrControl+${index + 1}`, group: 'navigation' as const })),
  { id: 'toggleTerminal', zh: '展开 / 收起终端', en: 'Toggle terminal', defaultKey: 'CommandOrControl+J', group: 'workbench' },
  { id: 'rewind', zh: '回退到检查点', en: 'Rewind to checkpoint', defaultKey: 'Escape Escape', group: 'workbench' },
  { id: 'saveFile', zh: '保存当前文件', en: 'Save file', defaultKey: 'CommandOrControl+S', group: 'workbench' },
  { id: 'closeFile', zh: '关闭文件标签', en: 'Close file tab', defaultKey: 'CommandOrControl+W', group: 'workbench' },
  { id: 'nextFile', zh: '下一个文件标签', en: 'Next file tab', defaultKey: 'Control+Tab', group: 'workbench' },
  { id: 'previousFile', zh: '上一个文件标签', en: 'Previous file tab', defaultKey: 'Control+Shift+Tab', group: 'workbench' },
  { id: 'goToDefinition', zh: '转到定义', en: 'Go to definition', defaultKey: 'F12', group: 'workbench' },
  { id: 'completeCode', zh: '代码补全', en: 'Complete code', defaultKey: 'Control+Space', group: 'workbench' },
  { id: 'sendMessage', zh: '发送任务消息', en: 'Send task message', defaultKey: 'Enter', group: 'input' },
  { id: 'submitMultiline', zh: '提交多行指令 / 侧聊', en: 'Submit multiline request / side chat', defaultKey: 'CommandOrControl+Enter', group: 'input' },
  { id: 'quickbar', zh: '全局快捷输入', en: 'Global quick input', defaultKey: 'CommandOrControl+Shift+Space', group: 'input' }
] as const

export type DesktopShortcutAction = typeof DESKTOP_SHORTCUTS[number]['id']
export type DesktopShortcutSettings = Partial<Record<DesktopShortcutAction, string | null>>
export type ShortcutPlatform = 'darwin' | 'other'
export interface ShortcutKeyEvent { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean; repeat?: boolean }

const MODIFIERS = ['CommandOrControl', 'Control', 'Command', 'Alt', 'Shift'] as const
const ALIASES: Record<string, string> = { cmd: 'Command', meta: 'Command', command: 'Command', ctrl: 'Control', control: 'Control',
  mod: 'CommandOrControl', cmdorctrl: 'CommandOrControl', commandorcontrol: 'CommandOrControl', option: 'Alt', alt: 'Alt', shift: 'Shift',
  esc: 'Escape', escape: 'Escape', ' ': 'Space', space: 'Space', enter: 'Enter', return: 'Enter', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
  up: 'Up', arrowup: 'Up', down: 'Down', arrowdown: 'Down', left: 'Left', arrowleft: 'Left', right: 'Right', arrowright: 'Right',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', plus: 'Plus', '+': 'Plus' }
const SYMBOL_KEYS = new Set([',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`'])
const NAMED_KEYS = new Set(['Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Plus'])

function normalizeKey(value: string): string | null {
  const key = ALIASES[value.toLowerCase()] ?? value.toUpperCase()
  return /^[A-Z0-9]$/.test(key) || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key) || SYMBOL_KEYS.has(key) || NAMED_KEYS.has(key) ? key : null
}

export function normalizeShortcut(value: unknown, action?: DesktopShortcutAction): string | null | undefined {
  if (value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 100) return undefined
  if (value === 'Escape Escape') return action === 'rewind' ? value : undefined
  const tokens = value.split('+').map(token => token.trim())
  const key = normalizeKey(tokens.pop() ?? '')
  if (!key) return undefined
  const modifiers = tokens.map(token => ALIASES[token.toLowerCase()] ?? token)
  if (new Set(modifiers).size !== modifiers.length || modifiers.some(mod => !MODIFIERS.includes(mod as typeof MODIFIERS[number]))) return undefined
  if (modifiers.includes('CommandOrControl') && (modifiers.includes('Control') || modifiers.includes('Command'))) return undefined
  if (!modifiers.some(mod => mod !== 'Shift') && !/^F\d+$/.test(key) && !(action === 'sendMessage' && key === 'Enter' && !modifiers.length)) return undefined
  return [...MODIFIERS.filter(mod => modifiers.includes(mod)), key].join('+')
}

export function shortcutFor(action: DesktopShortcutAction, settings?: DesktopShortcutSettings): string | null {
  const configured = settings?.[action]
  const normalized = configured === undefined ? undefined : normalizeShortcut(configured, action)
  return normalized === undefined ? DESKTOP_SHORTCUTS.find(item => item.id === action)!.defaultKey : normalized
}

/** Old or malformed fields never become key handlers. Valid disabled bindings stay disabled. */
export function normalizeDesktopShortcuts(value: unknown): DesktopShortcutSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: DesktopShortcutSettings = {}
  for (const action of DESKTOP_SHORTCUTS) {
    if (!Object.prototype.hasOwnProperty.call(value, action.id)) continue
    const binding = normalizeShortcut((value as Record<string, unknown>)[action.id], action.id)
    if (binding !== undefined) result[action.id] = binding
  }
  return result
}

function resolvedModifiers(shortcut: string, platform: ShortcutPlatform): { key: string; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean } {
  const parts = shortcut.split('+'), key = parts.pop()!
  return { key, ctrl: parts.includes('Control') || (platform !== 'darwin' && parts.includes('CommandOrControl')),
    meta: parts.includes('Command') || (platform === 'darwin' && parts.includes('CommandOrControl')),
    alt: parts.includes('Alt'), shift: parts.includes('Shift') }
}

export function matchesShortcut(event: ShortcutKeyEvent, action: DesktopShortcutAction, settings: DesktopShortcutSettings | undefined, platform: ShortcutPlatform): boolean {
  if (event.isComposing || event.repeat) return false
  const binding = shortcutFor(action, settings)
  if (!binding || binding === 'Escape Escape') return false
  const expected = resolvedModifiers(binding, platform)
  const key = normalizeKey(event.key) ?? (event.code?.startsWith('Key') ? event.code.slice(3) : event.code?.startsWith('Digit') ? event.code.slice(5) : '')
  return expected.key === key && expected.ctrl === event.ctrlKey && expected.meta === event.metaKey && expected.alt === event.altKey && expected.shift === event.shiftKey
}

export function shortcutFromEvent(event: ShortcutKeyEvent, platform: ShortcutPlatform): string | undefined {
  const key = normalizeKey(event.key) ?? (event.code?.startsWith('Key') ? normalizeKey(event.code.slice(3)) : event.code?.startsWith('Digit') ? normalizeKey(event.code.slice(5)) : null)
  if (!key || event.isComposing) return undefined
  const modifiers: string[] = []
  if (platform === 'darwin' ? event.metaKey : event.ctrlKey) modifiers.push('CommandOrControl')
  if (platform === 'darwin' && event.ctrlKey) modifiers.push('Control')
  if (platform !== 'darwin' && event.metaKey) modifiers.push('Command')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  return [...modifiers, key].join('+')
}

export interface ShortcutConflict { actions: DesktopShortcutAction[]; reason: 'duplicate' | 'reserved'; platform: ShortcutPlatform; binding: string }
export function shortcutConflicts(settings: DesktopShortcutSettings): ShortcutConflict[] {
  const conflicts: ShortcutConflict[] = []
  for (const platform of ['darwin', 'other'] as const) {
    const seen = new Map<string, DesktopShortcutAction>()
    for (const action of DESKTOP_SHORTCUTS) {
      const binding = shortcutFor(action.id, settings)
      if (!binding || binding === 'Escape Escape') continue
      const resolved = resolvedModifiers(binding, platform), identity = JSON.stringify(resolved)
      const previous = seen.get(identity)
      // These actions belong to separate input surfaces; both may use Cmd/Ctrl+Enter.
      const separateInputs = previous && [previous, action.id].every(id => id === 'sendMessage' || id === 'submitMultiline')
      if (previous && !separateInputs) conflicts.push({ actions: [previous, action.id], reason: 'duplicate', platform, binding })
      else seen.set(identity, action.id)
      const primary = platform === 'darwin' ? resolved.meta && !resolved.ctrl : resolved.ctrl && !resolved.meta
      if ((primary && !resolved.alt && ['A', 'C', 'V', 'X', 'Z', 'Q'].includes(resolved.key))
        || (primary && !resolved.alt && resolved.shift && resolved.key === 'W')
        || (platform === 'other' && resolved.alt && !resolved.ctrl && !resolved.meta && resolved.key === 'F4')
        || (resolved.key === 'Delete' && resolved.ctrl && resolved.alt)) conflicts.push({ actions: [action.id], reason: 'reserved', platform, binding })
    }
  }
  return conflicts
}

/** Main calls this before persistence; a conflicting key never becomes an ambiguous action. */
export function validateDesktopShortcuts(value: unknown): DesktopShortcutSettings {
  const normalized = normalizeDesktopShortcuts(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('快捷键配置无效。')
  for (const [id, binding] of Object.entries(value)) {
    if (!DESKTOP_SHORTCUTS.some(action => action.id === id) || normalizeShortcut(binding, id as DesktopShortcutAction) === undefined) throw new Error(`快捷键格式无效：${id}`)
  }
  const conflict = shortcutConflicts(normalized)[0]
  if (conflict) throw new Error(conflict.reason === 'reserved' ? '此快捷键保留给系统或文本编辑。' : '两个动作使用了同一个快捷键，请先解除冲突。')
  return normalized
}

export function formatShortcut(binding: string | null, platform: ShortcutPlatform): string {
  if (!binding) return '—'
  if (binding === 'Escape Escape') return 'Esc Esc'
  return binding.replace('CommandOrControl', platform === 'darwin' ? '⌘' : 'Ctrl').replace('Command', '⌘').replace('Control', 'Ctrl').replace('Alt', platform === 'darwin' ? '⌥' : 'Alt').replace('Shift', '⇧')
}
