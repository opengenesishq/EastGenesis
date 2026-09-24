import './task-entry-groups.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { modelOptionsForProvider, useStore } from '../store'
import { useT } from '../i18n'
import {
  buildPaletteCommands,
  buildPluginCommands,
  filterCommandItems
} from '../commands'
import { taskPaletteItems, runPaletteItem, type PaletteItem, type PaletteSection } from './task-palette-items'
import { projectedPaletteItems } from './experience/projectedComposerCommands'
import { useExperienceProjection } from './experience/ExperienceProjection'

function useCloseOnEscape(setVisible: (visible: boolean) => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setVisible(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [setVisible])
}

export default function CommandPalette(): React.JSX.Element {
  const t = useT()
  const projection = useExperienceProjection()
  const [query, setQuery] = useState('')
  const [taskGroup, setTaskGroup] = useState<PaletteItem>()
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const order = useStore((s) => s.order)
  const activeId = useStore((s) => s.activeId)
  const sessions = useStore((s) => s.sessions)
  const history = useStore((s) => s.history)
  const providers = useStore((s) => s.providers)
  const theme = useStore((s) => s.settings.theme)
  const pluginRegistry = useStore((s) => s.workbench.pluginRegistry)
  const pluginRegistryLoading = useStore((s) => s.workbench.pluginRegistryLoading)
  const setShowCommandPalette = useStore((s) => s.setShowCommandPalette)
  const setShowNewSession = useStore((s) => s.setShowNewSession)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const selectSession = useStore((s) => s.selectSession)
  const resumeFromHistory = useStore((s) => s.resumeFromHistory)
  const openLatestRewindPanel = useStore((s) => s.openLatestRewindPanel)
  const openBrowserPanel = useStore((s) => s.openBrowserPanel)
  const openDiffPanel = useStore((s) => s.openDiffPanel)
  const openFilesPanel = useStore((s) => s.openFilesPanel)
  const openWorktreePanel = useStore((s) => s.openWorktreePanel)
  const openTerminalPanel = useStore((s) => s.openTerminalPanel)
  const openPluginRegistryPanel = useStore((s) => s.openPluginRegistryPanel)
  const openSubagentPanel = useStore((s) => s.openSubagentPanel)
  const openRoutinePanel = useStore((s) => s.openRoutinePanel)
  const openMemoryPanel = useStore((s) => s.openMemoryPanel)
  const loadPluginRegistryForSlash = useStore((s) => s.loadPluginRegistryForSlash)
  const sendPluginRegistryItemToAgent = useStore((s) => s.sendPluginRegistryItemToAgent)
  const dispatchPluginAgent = useStore((s) => s.dispatchPluginAgent)
  const updateSettings = useStore((s) => s.updateSettings)
  const setModel = useStore((s) => s.setModel)
  useEffect(() => { requestAnimationFrame(() => inputRef.current?.focus()) }, [])
  useCloseOnEscape(setShowCommandPalette)
  useEffect(() => {
    if (!pluginRegistry && !pluginRegistryLoading) void loadPluginRegistryForSlash()
  }, [loadPluginRegistryForSlash, pluginRegistry, pluginRegistryLoading])
  const close = (): void => setShowCommandPalette(false)

  const items = useMemo<PaletteItem[]>(() => {
    const activeMeta = activeId ? sessions[activeId]?.meta : undefined
    const commandItems: PaletteItem[] = buildPaletteCommands({
      t,
      modelOptions: modelOptionsForProvider(
        providers,
        activeMeta?.providerId ?? '',
        t('autoRoute'),
        activeMeta?.model
      ),
      theme,
      setShowNewSession,
      setShowSettings,
      focusSidebarSearch,
      openLatestRewindPanel,
      openDiffPanel,
      openBrowserPanel,
      openFilesPanel,
      openWorktreePanel,
      openTerminalPanel,
      openPluginRegistryPanel,
      openSubagentPanel,
      openRoutinePanel,
      openMemoryPanel,
      updateSettings,
      setModel
    }).map((item) => ({ ...item, section: 'command' }))
    const taskItems = taskPaletteItems({ order, sessions, history, selectSession, resume: resumeFromHistory })

    const pluginItems: PaletteItem[] = projection === 'studio'
      ? buildPluginCommands(pluginRegistry?.items ?? [], {
        sendPluginRegistryItemToAgent,
        dispatchPluginAgent
      }).map((item) => ({ ...item, section: 'plugin' }))
      : []

    return [...projectedPaletteItems(projection, commandItems), ...taskItems, ...pluginItems]
  }, [
    activeId,
    dispatchPluginAgent,
    history,
    openBrowserPanel,
    openDiffPanel,
    openFilesPanel,
    openLatestRewindPanel,
    openMemoryPanel,
    openPluginRegistryPanel,
    openRoutinePanel,
    openSubagentPanel,
    openTerminalPanel,
    openWorktreePanel,
    order,
    pluginRegistry,
    providers,
    projection,
    resumeFromHistory,
    selectSession,
    sendPluginRegistryItemToAgent,
    sessions,
    setModel,
    setShowNewSession,
    setShowSettings,
    t,
    theme,
    updateSettings
  ])

  const matches = useMemo(() => filterCommandItems(query, taskGroup?.children ?? items).slice(0, 80), [items, query, taskGroup])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    if (activeIndex >= matches.length) setActiveIndex(Math.max(0, matches.length - 1))
  }, [activeIndex, matches.length])

  const runItem = (item: PaletteItem | undefined): void => runPaletteItem(item, close, (group) => { setTaskGroup(group); setQuery('') })

  const sectionLabel = (section: PaletteSection): string => {
    if (section === 'session') return t('commandSectionSession')
    if (section === 'history') return t('commandSectionHistory')
    if (section === 'plugin') return t('commandSectionPlugin')
    return t('commandSectionCommand')
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (matches.length === 0 ? 0 : (i + 1) % matches.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (matches.length === 0 ? 0 : (i - 1 + matches.length) % matches.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      runItem(matches[activeIndex] ?? matches[0])
    }
  }

  return (
    <div
      className="command-palette-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
      onKeyDown={onKeyDown}
    >
      <div className="command-palette" role="dialog" aria-modal="true" aria-label={t('commandPaletteTitle')}>
        <input
          ref={inputRef}
          className="input command-palette-input"
          value={query}
          placeholder={t('commandPalettePlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
        />
        <PaletteTaskScope group={taskGroup} onBack={() => { setTaskGroup(undefined); setQuery('') }} />
        <div className="command-palette-list">
          {matches.length === 0 ? (
            <div className="command-palette-empty">{t('commandNoResults')}</div>
          ) : (
            matches.map((item, index) => (
              <button
                key={item.id}
                data-command-id={item.id}
                className={`command-palette-item ${index === activeIndex ? 'active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => runItem(item)}
              >
                <span className="command-palette-section">{sectionLabel(item.section)}</span>
                <span className="command-palette-main">
                  <span className="command-palette-item-title">{item.title}</span>
                  <span className="command-palette-item-hint">{item.hint}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function focusSidebarSearch(): void {
  useStore.getState().setView('list')
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>('.sidebar-search')
    if (!input) return
    input.focus()
    input.select()
  })
}

function PaletteTaskScope({ group, onBack }: { group?: PaletteItem; onBack(): void }): React.JSX.Element | null {
  if (!group) return null
  return <div className="command-palette-task-scope"><button type="button" className="btn btn-secondary btn-sm" onClick={onBack}>返回全部任务与命令</button><span>{group.title}</span></div>
}
