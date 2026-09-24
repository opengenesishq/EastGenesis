import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalInfo } from '../../../../shared/terminal-operation-types'
import { useStore } from '../../store'
import { workspaceTerminalMatches } from '../../store/terminal-actions'
import { normalizeTerminalPreferences } from '../../../../shared/desktop-behavior-preferences'
import '@xterm/xterm/css/xterm.css'
import './terminal-viewport.css'

/** The existing terminal process owns execution; this component only renders its PTY. */
export default function TerminalViewport({ terminal, active }: { terminal: TerminalInfo; active: boolean }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const preferences = normalizeTerminalPreferences(useStore(state => state.settings.terminalPreferences))
  const terminalView = useRef<Terminal>()
  const fitView = useRef<() => void>()
  const interactive = useRef(active && !terminal.exit)
  interactive.current = active && !terminal.exit

  useEffect(() => {
    const element = host.current
    if (!element) return
    let disposed = false
    let input = ''
    let inputTimer: ReturnType<typeof setTimeout> | undefined
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    let writeQueue = Promise.resolve()
    let lastSize = `${terminal.cols}:${terminal.rows}`
    const view = new Terminal({
      cursorBlink: preferences.cursorBlink,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || '"SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: preferences.fontSize,
      lineHeight: 1.35,
      scrollback: preferences.scrollback,
      allowProposedApi: false,
      disableStdin: !interactive.current,
      theme: { background: '#181818', foreground: '#dedede', cursor: '#dedede', selectionBackground: '#66666680' }
    })
    const fit = new FitAddon()
    view.loadAddon(fit)
    view.open(element)
    terminalView.current = view
    const initial = useStore.getState().workbench
    if (initial.terminal?.id === terminal.id && initial.terminalBuffer) view.write(initial.terminalBuffer)
    const unsubscribe = window.agentDesk.onTerminalEvent(event => {
      if (disposed || event.kind === 'started' || event.id !== terminal.id) return
      if (event.kind === 'output') view.write(event.data)
      if (event.kind === 'exit') view.options.disableStdin = true
    })
    const ownsCurrentInput = (): boolean => {
      const state = useStore.getState()
      return !disposed && interactive.current && state.workbench.terminal?.id === terminal.id
        && (state.workbench.terminalScope === 'workspace' ? workspaceTerminalMatches(state, terminal) : terminal.sessionId === state.activeId)
    }
    const showError = (cause: unknown): void => {
      if (disposed || useStore.getState().workbench.terminal?.id !== terminal.id) return
      useStore.setState(state => ({ workbench: { ...state.workbench, terminalError: cause instanceof Error ? cause.message : String(cause) } }))
    }
    const flushInput = (): void => {
      inputTimer = undefined
      const data = input
      input = ''
      if (!data || !ownsCurrentInput()) return
      writeQueue = writeQueue.then(async () => {
        if (!ownsCurrentInput()) return
        const result = await window.agentDesk.writeTerminal(terminal.id, data)
        if (!result.ok) throw new Error(result.error)
      }).catch(showError)
    }
    const inputSubscription = view.onData(data => {
      if (!ownsCurrentInput()) return
      input += data
      // Keep key order while grouping paste and short bursts into one existing Effect.
      if (!inputTimer) inputTimer = setTimeout(flushInput, 24)
    })
    const resize = (): void => {
      if (disposed || !element.clientWidth || !element.clientHeight) return
      fit.fit()
      const size = `${view.cols}:${view.rows}`
      if (size === lastSize) return
      lastSize = size
      void window.agentDesk.resizeTerminal(terminal.id, view.cols, view.rows).then(result => {
        if (!result.ok) showError(result.error)
      }).catch(showError)
    }
    const scheduleResize = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(resize, 120)
    }
    fitView.current = scheduleResize
    const observer = new ResizeObserver(scheduleResize)
    observer.observe(element)
    const applyTheme = (): void => {
      view.options.fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || '"SF Mono", Menlo, Monaco, Consolas, monospace'
      const light = document.documentElement.dataset.theme === 'light'
      view.options.theme = light
        ? { background: '#ffffff', foreground: '#242424', cursor: '#242424', selectionBackground: '#cccccc80' }
        : { background: '#181818', foreground: '#dedede', cursor: '#dedede', selectionBackground: '#66666680' }
      scheduleResize()
    }
    const themeObserver = new MutationObserver(applyTheme)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    applyTheme()
    scheduleResize()
    return () => {
      disposed = true
      if (inputTimer) clearTimeout(inputTimer)
      if (resizeTimer) clearTimeout(resizeTimer)
      input = ''
      unsubscribe()
      observer.disconnect()
      themeObserver.disconnect()
      inputSubscription.dispose()
      view.dispose()
      terminalView.current = undefined
      fitView.current = undefined
    }
  }, [terminal.id])

  useEffect(() => {
    if (terminalView.current) {
      terminalView.current.options.fontSize = preferences.fontSize
      terminalView.current.options.scrollback = preferences.scrollback
      terminalView.current.options.cursorBlink = preferences.cursorBlink
      fitView.current?.()
    }
  }, [preferences.fontSize, preferences.scrollback, preferences.cursorBlink])

  useEffect(() => {
    if (terminalView.current) terminalView.current.options.disableStdin = !active || Boolean(terminal.exit)
    if (active) fitView.current?.()
  }, [active, terminal.exit])

  return <div ref={host} className="terminal-viewport" data-terminal-viewport={terminal.id} role="region" aria-label="Terminal" />
}
