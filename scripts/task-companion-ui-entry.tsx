import { act } from 'react'
import { createRoot } from 'react-dom/client'
import TaskCompanion from '../src/renderer/src/components/companion/TaskCompanion'
import CompanionPreference from '../src/renderer/src/components/companion/CompanionPreference'
import { setCompanionEnabled } from '../src/renderer/src/components/companion/companion-preference'
import { useStore, type SessionState } from '../src/renderer/src/store'

const host = window as typeof window & { IS_REACT_ACT_ENVIRONMENT: boolean; runCompanionChecks(): Promise<string[]> }
host.IS_REACT_ACT_ENVIRONMENT = true
const task = (id: string, status: SessionState['meta']['status']): SessionState => ({
  meta: { id, title: `任务 ${id}`, status }, pendingPermissions: [], runningTools: {}
} as SessionState)

host.runCompanionChecks = async () => {
  const checks: string[] = []
  const container = document.getElementById('root')!
  const root = createRoot(container)
  const original = useStore.getState()
  const calls: string[] = []
  const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message) }
  const q = (selector: string): HTMLButtonElement => {
    const node = container.querySelector<HTMLButtonElement>(selector)
    assert(node, `Missing ${selector}`); return node!
  }
  const click = async (selector: string): Promise<void> => { await act(async () => q(selector).click()) }
  let rejectPause: (error: Error) => void = () => {}
  const failedPause = new Promise<void>((_, reject) => { rejectPause = reject })
  try {
    await act(async () => {
      setCompanionEnabled(true)
      useStore.setState({ hydrated: true, showSettings: false, showCommandPalette: false, showTaskRecovery: false,
        settings: { ...original.settings, language: 'zh' }, view: 'list', activeId: 'a', order: ['a', 'b'],
        sessions: { a: task('a', 'running'), b: { ...task('b', 'idle'), pendingPermissions: [{ requestId: 'approval' }] } } as unknown as Record<string, SessionState>,
        selectSession: id => { calls.push(`select:${id}`); useStore.setState({ activeId: id }) },
        setView: view => { calls.push(`view:${view}`); useStore.setState({ view }) },
        setShowNewSession: () => { calls.push('new') },
        interrupt: async id => { calls.push(`pause:${id}`); await failedPause }
      })
      root.render(<><TaskCompanion /><CompanionPreference /></>)
    })
    assert(q('[data-companion-toggle]').textContent?.includes('1'), 'approval badge must reflect existing tasks')
    await click('[data-companion-toggle]')
    assert(q('[data-companion-task="b"]').textContent?.includes('等待你的审批'), 'pending permission hidden')
    assert(container.querySelector('[data-companion-active]')?.getAttribute('data-companion-active') === 'a', 'current task mismatch')
    assert(calls.length === 0, 'opening companion dispatched a command')
    checks.push('opening projects current task and pending approval without dispatch')

    await click('[data-companion-pause]')
    await click('[data-companion-pause]')
    assert(calls.filter(call => call.startsWith('pause:')).join() === 'pause:a', 'pause must use the exact task identity once')
    await act(async () => rejectPause(new Error('暂停未完成')))
    assert(container.querySelector('[role="alert"]')?.textContent === '暂停未完成', 'pause rejection hidden')
    assert(useStore.getState().sessions.a.meta.status === 'running', 'UI invented paused status')
    checks.push('pause uses existing command once and reports rejection without inventing status')

    await click('[data-companion-task="b"]')
    assert(calls.slice(-2).join() === 'select:b,view:list', 'approval must open existing task')
    assert(!container.querySelector('[role="dialog"]'), 'navigation should close the companion')
    await click('[data-companion-toggle]')
    assert(!container.querySelector('[data-companion-pause]'), 'idle task exposes pause')
    await click('[data-companion-palace]')
    assert(useStore.getState().activeId === 'b' && useStore.getState().view === 'office', 'palace transition changed identity')
    await click('[data-companion-toggle]')
    await click('[data-companion-palace]')
    assert(useStore.getState().activeId === 'b' && useStore.getState().view === 'list', 'return changed identity')
    checks.push('approval navigation and palace round trip preserve task identity')

    await click('[data-companion-toggle]')
    await click('.companion-hide')
    assert(!container.querySelector('[data-task-companion]'), 'hide preference did not apply')
    assert(localStorage.getItem('caogen.companion.visible.v1') === 'false', 'hide preference not persisted')
    await click('[data-companion-settings] input')
    assert(container.querySelector('[data-task-companion]'), 'settings did not restore companion')
    await act(async () => useStore.setState({ showSettings: true }))
    assert(!container.querySelector('[data-task-companion]'), 'companion obscures settings')
    checks.push('visibility persists and settings restores the companion')

    await act(async () => useStore.setState({ showSettings: false, activeId: null, sessions: {}, order: [] }))
    await click('[data-companion-toggle]')
    assert(!container.querySelector('[data-companion-continue]'), 'missing task exposes continue')
    await click('[data-companion-new]')
    assert(calls.at(-1) === 'new', 'new task bypasses existing entry')
    checks.push('empty state opens the existing new-task entry')
    return checks
  } finally {
    await act(async () => root.unmount())
    useStore.setState(original)
  }
}
