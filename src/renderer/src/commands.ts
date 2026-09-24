import type { AppTheme, PluginRegistryItem } from '../../shared/types'
import type { TParams } from './i18n'
import {
  buildPluginSlashCommands,
  pluginSlashCommandMatches,
  shouldLoadPluginSlashRegistry,
  type PluginSlashCommandDescriptor
} from './pluginSlashCommands'

export { buildPluginSlashCommands, pluginSlashCommandMatches, shouldLoadPluginSlashRegistry }
export type { PluginSlashCommandDescriptor }

export interface CommandDescriptor {
  id: string
  title: string
  hint: string
  searchText?: string
  insert?: string
  run?: () => void
}

export interface ModelOption {
  value: string
  label: string
}

export type TranslateFn = (key: string, params?: TParams) => string

function runSettingsUpdate(update: () => void | Promise<void>): void {
  try {
    void Promise.resolve(update()).catch((error) => {
      console.error('[agent-desk] Failed to persist command settings:', error)
    })
  } catch (error) {
    console.error('[agent-desk] Failed to persist command settings:', error)
  }
}

export interface ComposerCommandContext {
  t: TranslateFn
  modelOptions: ModelOption[]
  theme: AppTheme
  openLatestRewindPanel(reason?: 'button' | 'shortcut' | 'command'): void
  openDiffPanel(): void | Promise<void>
  openBrowserPanel(): void | Promise<void>
  openFilesPanel(): void | Promise<void>
  openWorktreePanel(): void | Promise<void>
  openTerminalPanel(): void | Promise<void>
  openPluginRegistryPanel(): void | Promise<void>
  openSubagentPanel(): void
  openRoutinePanel(): void | Promise<void>
  openMemoryPanel(): void
  updateSettings(patch: { theme: AppTheme }): void | Promise<void>
  setModel(model: string): void | Promise<void>
}

export interface PluginCommandHandlers {
  sendPluginRegistryItemToAgent(item: PluginRegistryItem): void | Promise<void>
  dispatchPluginAgent(item: PluginRegistryItem): void | Promise<void>
}

export interface PaletteCommandContext extends ComposerCommandContext {
  setShowNewSession(value: boolean): void
  setShowSettings(value: boolean): void
  focusSidebarSearch(): void
}

export function buildComposerSlashCommands(ctx: ComposerCommandContext): CommandDescriptor[] {
  return [
    {
      id: 'rewind',
      title: '/rewind',
      hint: ctx.t('slashRewindHint'),
      run: () => ctx.openLatestRewindPanel('command')
    },
    {
      id: 'diff',
      title: '/diff',
      hint: ctx.t('slashDiffHint'),
      run: () => void ctx.openDiffPanel()
    },
    {
      id: 'browser',
      title: '/browser',
      hint: ctx.t('slashBrowserHint'),
      run: () => void ctx.openBrowserPanel()
    },
    {
      id: 'files',
      title: '/files',
      hint: ctx.t('slashFilesHint'),
      run: () => void ctx.openFilesPanel()
    },
    {
      id: 'plugins',
      title: '/plugins',
      hint: ctx.t('slashPluginsHint'),
      run: () => void ctx.openPluginRegistryPanel()
    },
    {
      id: 'subagents',
      title: '/subagents',
      hint: ctx.t('slashSubagentsHint'),
      run: () => ctx.openSubagentPanel()
    },
    {
      id: 'routine',
      title: '/routine',
      hint: ctx.t('slashRoutineHint'),
      run: () => void ctx.openRoutinePanel()
    },
    {
      id: 'memory',
      title: '/memory',
      hint: ctx.t('slashMemoryHint'),
      run: () => ctx.openMemoryPanel()
    },
    {
      id: 'worktree',
      title: '/worktree',
      hint: ctx.t('slashWorktreeHint'),
      run: () => void ctx.openWorktreePanel()
    },
    {
      id: 'terminal',
      title: '/terminal',
      hint: ctx.t('slashTerminalHint'),
      run: () => void ctx.openTerminalPanel()
    },
    {
      id: 'theme',
      title: '/theme',
      hint: ctx.t('slashThemeHint'),
      run: () =>
        runSettingsUpdate(() =>
          ctx.updateSettings({
            theme: ctx.theme === 'dark' ? 'light' : ctx.theme === 'light' ? 'system' : 'dark'
          })
        )
    },
    {
      id: 'model-auto',
      title: '/model auto',
      hint: ctx.t('slashModelAutoHint'),
      run: () => void ctx.setModel('auto')
    },
    ...ctx.modelOptions
      .filter((m) => m.value && m.value !== 'auto')
      .map<CommandDescriptor>((m) => ({
        id: `model-${m.value}`,
        title: `/model ${m.value}`,
        hint: ctx.t('slashModelHint', { model: m.label }),
        run: () => void ctx.setModel(m.value)
      }))
  ]
}

export function buildPluginCommands(
  items: PluginRegistryItem[],
  handlers: PluginCommandHandlers
): CommandDescriptor[] {
  return buildPluginSlashCommands(items).map((cmd) => ({
    id: cmd.id,
    title: cmd.title,
    hint: cmd.hint,
    searchText: cmd.searchText,
    run: () => {
      if (cmd.action === 'dispatch-agent') {
        void handlers.dispatchPluginAgent(cmd.item)
      } else {
        void handlers.sendPluginRegistryItemToAgent(cmd.item)
      }
    }
  }))
}

export function buildPaletteCommands(ctx: PaletteCommandContext): CommandDescriptor[] {
  const slashCommands = buildComposerSlashCommands(ctx).map((cmd) => ({
    ...cmd,
    id: `slash:${cmd.id}`,
    searchText: [cmd.searchText, cmd.title, cmd.title.replace(/^\//, ''), cmd.hint].filter(Boolean).join(' ')
  }))
  const primaryCommand: CommandDescriptor = {
    id: 'app:new-session',
    title: ctx.t('commandNewSession'),
    hint: 'Cmd+N',
    searchText: 'new session 新建 会话',
    run: () => ctx.setShowNewSession(true)
  }
  return [
    primaryCommand,
    {
      id: 'app:settings',
      title: ctx.t('commandSettings'),
      hint: 'Cmd+,',
      searchText: 'settings preferences 设置 偏好',
      run: () => ctx.setShowSettings(true)
    },
    {
      id: 'app:search',
      title: ctx.t('commandSearchSessions'),
      hint: 'Cmd+F',
      searchText: 'find search sessions 搜索 会话',
      run: () => ctx.focusSidebarSearch()
    },
    ...slashCommands
  ]
}

export function commandMatches(command: Pick<CommandDescriptor, 'title' | 'hint' | 'searchText'>, query: string): boolean {
  const normalized = normalizeSearch(query)
  if (!normalized) return true
  if (command.searchText) return pluginSlashCommandMatches({ searchText: normalizeSearch(command.searchText) }, normalized)
  return normalizeSearch(`${command.title} ${command.hint}`).includes(normalized)
}

export function filterCommandItems<T extends Pick<CommandDescriptor, 'title' | 'hint' | 'searchText'>>(
  query: string,
  items: T[]
): T[] {
  const normalized = normalizeSearch(query)
  if (!normalized) return items
  return items
    .map((item, index) => ({ item, index, score: scoreCommand(item, normalized) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item)
}

function scoreCommand(command: Pick<CommandDescriptor, 'title' | 'hint' | 'searchText'>, query: string): number {
  const text = normalizeSearch([command.title, command.hint, command.searchText].filter(Boolean).join(' '))
  if (!query) return 1
  if (text === query) return 1000
  if (text.startsWith(query)) return 900 - text.length * 0.01
  const index = text.indexOf(query)
  if (index >= 0) return 700 - index - text.length * 0.001
  let cursor = 0
  let score = 0
  for (const char of query) {
    const next = text.indexOf(char, cursor)
    if (next < 0) return 0
    score += Math.max(1, 40 - (next - cursor))
    cursor = next + 1
  }
  return score
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}
