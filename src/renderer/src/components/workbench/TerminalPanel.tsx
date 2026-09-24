import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import { PanelBottomClose, SquareTerminal } from 'lucide-react'
import TerminalViewport from './TerminalViewport'
import { workspaceTerminalContextKey, workspaceTerminalMatches } from '../../store/terminal-actions'

export default function TerminalPanel({ workspaceMode = false, active = true }: { workspaceMode?: boolean; active?: boolean }): React.JSX.Element {
  const t = useT()
  const activeId = useStore((s) => s.activeId)
  const workspaceContextKey = useStore(workspaceTerminalContextKey)
  const dockOpen = useStore((s) => s.workbench.terminalDockOpen || s.workbench.activePanelId === 'terminal')
  const visible = active && dockOpen
  const { terminal, terminalBuffer, terminalError, terminalLoading } = useStore((s) => s.workbench)
  const startTerminal = useStore((s) => s.startTerminal)
  const sendInput = useStore((s) => s.sendTerminalInput)
  const closeTerminal = useStore((s) => s.closeTerminal)
  const closePanel = useStore((s) => s.closeTerminalPanel)
  const [command, setCommand] = useState('')
  const scrollRef = useRef<HTMLPreElement>(null)
  const previousContext = useRef({ workspaceMode, key: workspaceContextKey })

  useEffect(() => {
    if (!active) return
    const changedWorkspace = workspaceMode && previousContext.current.workspaceMode
      && previousContext.current.key !== workspaceContextKey
    previousContext.current = { workspaceMode, key: workspaceContextKey }
    setCommand('')
    useStore.setState((state) => ({ workbench: {
      ...state.workbench, terminalScope: workspaceMode ? 'workspace' : 'task',
      ...(workspaceMode && !workspaceTerminalMatches(state, state.workbench.terminal)
        ? { terminal: undefined, terminalBuffer: '', terminalError: undefined, terminalLoading: false } : {})
    } }))
    // Editing a directory must only unbind old input; do not open a picker for every keystroke.
    if (!changedWorkspace && (activeId || workspaceMode) && visible) void startTerminal()
  }, [active, activeId, visible, workspaceMode, workspaceContextKey, startTerminal])

  const boundTerminal = terminal && (workspaceMode ? workspaceTerminalMatches(useStore.getState(), terminal) : terminal.sessionId === activeId) ? terminal : undefined
  const ready = Boolean(boundTerminal && !boundTerminal.exit && !terminalLoading)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [terminalBuffer])

  const runCommand = async (): Promise<void> => {
    const text = command.trim()
    if (!text || !ready) return
    setCommand('')
    await sendInput(`${text}\n`)
  }

  return (
    <div className="terminal-panel">
      <header className="workspace-diff-top">
        <div>
          <div className="workspace-diff-title"><SquareTerminal size={14} aria-hidden="true" />{t('terminalPanelTitle')}</div>
          <div className="workspace-diff-sub">
            {boundTerminal?.executionEnvironment?.kind === 'wsl' ? `WSL2 · ${boundTerminal.executionEnvironment.distribution} · ${boundTerminal.executionEnvironment.guestCwd}` : boundTerminal ? boundTerminal.cwd : t('terminalNotStarted')}
          </div>
        </div>
        <div className="workspace-diff-actions">
          <button className="btn btn-ghost btn-sm" disabled={terminalLoading} onClick={() => void startTerminal()}>
            {terminalLoading ? t('loadingDiff') : t('terminalRestart')}
          </button>
          {boundTerminal && (
            <button className="btn btn-ghost btn-sm" onClick={() => void closeTerminal()}>
              {t('terminalStop')}
            </button>
          )}
          <button className="icon-btn" aria-label={t('collapseToolPanel')} title={t('collapseToolPanel')} onClick={closePanel}>
            <PanelBottomClose size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      {terminalError && <div className="notice notice-error terminal-notice">{terminalError}</div>}
      {boundTerminal?.fallbackReason && (
        <div className="notice notice-info terminal-notice">{boundTerminal.fallbackReason}</div>
      )}

      {boundTerminal?.backend === 'pty' ? <TerminalViewport terminal={boundTerminal} active={Boolean(visible)} /> : <>
      <pre ref={scrollRef} className="terminal-output">
        {(boundTerminal ? terminalBuffer : '') || (terminalLoading ? t('terminalStarting') : t('terminalEmpty'))}
      </pre>

      <div className="terminal-input-row">
        <input
          className="input terminal-input"
          value={command}
          disabled={!ready}
          placeholder={boundTerminal?.exit ? t('terminalExited') : t('terminalCommandPlaceholder')}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void runCommand()
            }
          }}
        />
        <button className="btn btn-primary" disabled={!command.trim() || !ready} onClick={() => void runCommand()}>
          {t('terminalRun')}
        </button>
      </div>
      </>}
    </div>
  )
}
