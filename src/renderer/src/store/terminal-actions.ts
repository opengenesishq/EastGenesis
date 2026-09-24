import type { StoreApi } from 'zustand'
import type { AppStore } from '../store'
import type { TerminalInfo, WorkspaceTerminalStartInput } from '../../../shared/terminal-operation-types'

type SetState = StoreApi<AppStore>['setState']
type GetState = StoreApi<AppStore>['getState']
type CloseBrowserView = (sessionId: string | null | undefined) => void

type TerminalContextState = Pick<AppStore, 'welcomeDraft' | 'newSessionProjectId' | 'projects'>
const workspaceBindings = new Map<string, { contextKey: string; actualCwd: string; projectId?: string }>()

function workspaceTerminalContext(state: TerminalContextState): { key: string; input: WorkspaceTerminalStartInput } {
  const projectChoice = state.welcomeDraft.projectChoice ?? state.newSessionProjectId
  const project = state.projects.find((item) => item.id === projectChoice && !item.archived)
  const cwd = state.welcomeDraft.cwd?.trim() || undefined
  return {
    key: JSON.stringify([projectChoice ?? null, cwd ?? null, project?.id ?? null, project?.path ?? null]),
    input: project ? { projectId: project.id, cwd: project.path } : cwd ? { cwd } : {}
  }
}

export function workspaceTerminalContextKey(state: TerminalContextState): string {
  return workspaceTerminalContext(state).key
}

/** A saved request context and main-resolved cwd must both match before accepting input. */
export function workspaceTerminalMatches(state: TerminalContextState, terminal: TerminalInfo | undefined): boolean {
  if (!terminal || terminal.sessionId) return false
  const binding = workspaceBindings.get(terminal.id)
  return Boolean(binding && binding.contextKey === workspaceTerminalContextKey(state)
    && binding.actualCwd === terminal.cwd && binding.projectId === terminal.projectId)
}

function terminalMatchesCurrentScope(state: AppStore, terminal: TerminalInfo): boolean {
  return state.workbench.terminalScope === 'workspace'
    ? workspaceTerminalMatches(state, terminal)
    : terminal.sessionId === state.activeId
}

type TerminalActions = Pick<
  AppStore,
  'openTerminalPanel' | 'closeTerminalPanel' | 'startTerminal' | 'sendTerminalInput' | 'closeTerminal'
>

export function createTerminalActions(
  set: SetState,
  get: GetState,
  _closeBrowserView: CloseBrowserView
): TerminalActions {
  const starts = new Map<string, Promise<void>>()
  return {
    async openTerminalPanel() {
      set((state) => ({
        workbench: {
          ...state.workbench,
          activePanelId: state.workbench.activePanelId ?? 'terminal',
          terminalDockOpen: true,
          mountedPanels: new Set(state.workbench.mountedPanels).add('terminal')
        }
      }))
      await get().startTerminal()
    },

    closeTerminalPanel() {
      set((state) => ({
        workbench: {
          ...state.workbench,
          terminalDockOpen: false,
          activePanelId: state.workbench.activePanelId === 'terminal' ? null : state.workbench.activePanelId
        }
      }))
    },

    async startTerminal() {
      const initial = get()
      const sessionId = initial.activeId
      const scope = initial.workbench.terminalScope ?? 'task'
      if (scope === 'task' && !sessionId) return
      const workspace = workspaceTerminalContext(initial)
      const currentRequest = (): boolean => (get().workbench.terminalScope ?? 'task') === scope
        && (scope === 'workspace' ? workspaceTerminalContextKey(get()) === workspace.key : get().activeId === sessionId)
      if (scope === 'workspace' && workspaceTerminalMatches(initial, initial.workbench.terminal) && !initial.workbench.terminal?.exit) {
        set((state) => ({ workbench: { ...state.workbench, terminalLoading: false } }))
        return
      }
      const requestKey = scope === 'workspace' ? `workspace:${workspace.key}` : `task:${sessionId}`
      const existing = starts.get(requestKey)
      if (existing) return existing
      const start = async (): Promise<void> => {
        set((state) => ({
          workbench: { ...state.workbench, terminalLoading: true, terminalError: undefined }
        }))
        try {
          const result = scope === 'workspace'
            ? await window.agentDesk.startWorkspaceTerminal({ ...workspace.input, cols: 100, rows: 28, reuse: true })
            : await window.agentDesk.startTerminal(sessionId!, { cols: 100, rows: 28, reuse: true })
          if (result.effectStatus === 'waiting_reconciliation') await get().refreshTaskSnapshots()
          if (!currentRequest()) return
          if (!result.ok && 'cancelled' in result && result.cancelled) {
            set((state) => ({ workbench: { ...state.workbench, terminalLoading: false } }))
            return
          }
          if (!result.ok) throw new Error(result.error)
          if (scope === 'workspace') workspaceBindings.set(result.terminal.id, {
            contextKey: workspace.key, actualCwd: result.terminal.cwd, projectId: result.terminal.projectId
          })
          set((state) => ({
            workbench: {
              ...state.workbench,
              terminal: result.terminal,
              terminalLoading: false,
              terminalBuffer:
                state.workbench.terminal?.id === result.terminal.id
                  ? state.workbench.terminalBuffer
                  : ''
            }
          }))
        } catch (error) {
          if (!currentRequest()) return
          set((state) => ({
            workbench: {
              ...state.workbench,
              terminalLoading: false,
              terminalError: error instanceof Error ? error.message : String(error)
            }
          }))
        }
      }
      const pending = start()
      starts.set(requestKey, pending)
      try { await pending } finally { if (starts.get(requestKey) === pending) starts.delete(requestKey) }
    },

    async sendTerminalInput(text) {
      const terminal = get().workbench.terminal
      if (!terminal || terminal.exit || get().workbench.terminalLoading || !terminalMatchesCurrentScope(get(), terminal)) return
      try {
        const result = await window.agentDesk.writeTerminal(terminal.id, text)
        if (result.effectStatus === 'waiting_reconciliation') await get().refreshTaskSnapshots()
        if (!result.ok) throw new Error(result.error)
      } catch (error) {
        if (get().workbench.terminal?.id !== terminal.id || !terminalMatchesCurrentScope(get(), terminal)) return
        set((state) => ({ workbench: { ...state.workbench, terminalError: error instanceof Error ? error.message : String(error) } }))
      }
    },

    async closeTerminal() {
      const terminal = get().workbench.terminal
      if (!terminal || !terminalMatchesCurrentScope(get(), terminal)) return
      try {
        const result = await window.agentDesk.closeTerminal(terminal.id)
        if (result.effectStatus === 'waiting_reconciliation') await get().refreshTaskSnapshots()
        if (!result.ok) throw new Error(result.error)
        workspaceBindings.delete(terminal.id)
        set((state) => state.workbench.terminal?.id !== terminal.id ? state : ({
          workbench: { ...state.workbench, terminal: undefined, terminalBuffer: '', terminalError: undefined }
        }))
      } catch (error) {
        if (get().workbench.terminal?.id !== terminal.id || !terminalMatchesCurrentScope(get(), terminal)) return
        set((state) => ({ workbench: { ...state.workbench, terminalError: error instanceof Error ? error.message : String(error) } }))
      }
    }
  }
}
