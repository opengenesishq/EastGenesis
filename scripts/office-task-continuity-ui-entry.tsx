import { act } from 'react'
import { createRoot } from 'react-dom/client'
import OfficeCommandInput from '../src/renderer/src/components/office/OfficeCommandInput'
import { useSessionComposerDraft } from '../src/renderer/src/components/composer/useSessionComposerDraft'
import { readComposerDraft, writeComposerDraft } from '../src/renderer/src/store/composer-draft-persistence'
import { useStore, type SessionState } from '../src/renderer/src/store'
import type { BusinessLineDefinition } from '../src/shared/business-line-types'

const fixtureWindow = window as typeof window & {
  IS_REACT_ACT_ENVIRONMENT: boolean
  runOfficeTaskContinuityHarness: () => Promise<{ id: string; status: 'passed' }[]>
}
fixtureWindow.IS_REACT_ACT_ENVIRONMENT = true

// Exercise the shared composer contract on the other side of a view change.
// Full ChatView/WebGL and real Provider execution are outside this harness.
function WorkspaceDraft({ id }: { id: string }) {
  const [text, setText] = useSessionComposerDraft(id)
  return <textarea data-workspace-draft value={text} onChange={event => setText(event.target.value)} />
}

fixtureWindow.runOfficeTaskContinuityHarness = async () => {
  const checks: { id: string; status: 'passed' }[] = []
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message) }
  const passed = (id: string) => checks.push({ id, status: 'passed' })
  const originalState = useStore.getState()
  const originalAgentDesk = window.agentDesk
  const container = document.getElementById('root')!
  const root = createRoot(container)
  const opens: string[] = []
  const sends: { id: string; text: unknown }[] = []
  const session = (id: string) => ({ meta: { id, title: id, status: 'idle' }, pendingPermissions: [], runningTools: {} }) as SessionState
  const lines = [{ id: 'assistant', name: 'Tasks', enabled: true }] as BusinessLineDefinition[]
  const q = <T extends HTMLElement,>(selector: string): T => {
    const node = container.querySelector<T>(selector)
    assert(node, `Missing ${selector}`)
    return node!
  }
  const type = async (selector: string, value: string) => {
    const node = q<HTMLTextAreaElement>(selector)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, value)
      node.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const render = async (id: string) => {
    await act(async () => root.render(<OfficeCommandInput lines={lines} defaultLineId="assistant" zh preferSelection
      selectedSession={{ id, title: `Task ${id}` }} onOpenSession={id => opens.push(`palace:${id}`)}
      onOpenWorkspace={id => opens.push(`workspace:${id}`)} />))
  }
  try {
    window.agentDesk = { ...originalAgentDesk, listSessionInputs: async () => [] } as typeof window.agentDesk
    useStore.setState({ sessions: { a: session('a'), b: session('b') }, activeId: 'a', taskSnapshots: [], taskSnapshotsError: null,
      modelAttemptReconciliations: [], syncSession: async () => true, hydrateTaskRecoveryCandidates: async () => {},
      sendMessage: async (text, id) => { sends.push({ id: id!, text }) } })
    writeComposerDraft(window.localStorage, 'a', 'Modern task A draft')
    await render('a')
    assert(q('[data-office-command-target="session:a"]'), 'Palace entry lost task A')
    assert(q<HTMLTextAreaElement>('[data-office-command-text]').value === 'Modern task A draft', 'Modern draft not restored')
    assert(sends.length === 0, 'Opening palace dispatched work')
    passed('palace-entry-restores-current-task-and-modern-draft-without-dispatch')

    await type('[data-office-command-text]', 'A revised in palace')
    await render('b')
    assert(q('[data-office-command-target="session:b"]'), 'Nonempty A draft retained old target after selecting B')
    assert(q<HTMLTextAreaElement>('[data-office-command-text]').value === '', 'Task A draft leaked to B')
    await type('[data-office-command-text]', 'B instruction')
    await act(async () => q<HTMLButtonElement>('[data-office-command-send]').click())
    assert(sends.length === 1 && sends[0].id === 'b' && sends[0].text === 'B instruction', 'Instruction reached another task')
    assert(readComposerDraft(window.localStorage, 'a') === 'A revised in palace', 'Sending B deleted A draft')
    passed('changing-selected-figure-preserves-old-draft-and-sends-only-to-new-task')

    await render('a')
    await act(async () => q<HTMLButtonElement>('[data-office-command-conversation="a"]').click())
    await act(async () => q<HTMLButtonElement>('[data-office-command-workspace="a"]').click())
    assert(JSON.stringify(opens) === JSON.stringify(['palace:a', 'workspace:a']), 'Navigation changed task identity')
    assert(sends.length === 1, 'Navigation dispatched a second instruction')
    passed('conversation-and-workspace-shortcuts-carry-the-same-id-without-dispatch')

    await act(async () => root.render(<WorkspaceDraft id="a" />))
    assert(q<HTMLTextAreaElement>('[data-workspace-draft]').value === 'A revised in palace', 'Palace draft lost on workspace return')
    await type('[data-workspace-draft]', 'A revised in workspace')
    await render('a')
    assert(q<HTMLTextAreaElement>('[data-office-command-text]').value === 'A revised in workspace', 'Workspace edit lost when palace remounted')
    passed('unmounting-and-remounting-composers-preserves-edits-in-both-directions')

    const scope = q<HTMLSelectElement>('select[aria-label="指令作用范围"]')
    await act(async () => { scope.value = 'new'; scope.dispatchEvent(new Event('change', { bubbles: true })) })
    await type('[data-office-command-text]', 'Independent new task draft')
    await type('[data-office-command-text]', '')
    assert(q('[data-office-command-target="business:assistant"]'), 'Clearing new-task draft silently switched to old task')
    assert(readComposerDraft(window.localStorage, 'a') === 'A revised in workspace', 'New task scope overwrote existing draft')
    passed('explicit-new-task-scope-remains-stable-and-keeps-existing-task-draft')
    return checks
  } finally {
    await act(async () => root.unmount())
    useStore.setState(originalState, true)
    window.agentDesk = originalAgentDesk
  }
}
