import { act } from 'react'
import { createRoot } from 'react-dom/client'
import RunDetailPanel from '../src/renderer/src/components/studio/RunDetailPanel'
import WorkInbox from '../src/renderer/src/components/studio/WorkInbox'
import type { WorkflowRunSummary, WorkflowLedgerRendererSelection } from '../src/shared/workflow-types'

const fixtureWindow = window as typeof window & {
  IS_REACT_ACT_ENVIRONMENT: boolean
  recoveryUiStore: Record<string, unknown>
  runRecoveryHarness: () => Promise<{ name: string; status: 'passed' }[]>
}
fixtureWindow.IS_REACT_ACT_ENVIRONMENT = true

function canonicalRun(id: string, status: WorkflowRunSummary['status'] = 'failed'): WorkflowRunSummary {
  return {
    schemaVersion: 1, id, projectId: 'recovery-project', workItemId: `work-${id}`,
    sessionId: `session-${id}`, taskId: `task-${id}`, status, revision: 1,
    attempt: 1, taskRunDigest: `digest-${id}`, createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_001
  }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

fixtureWindow.runRecoveryHarness = async () => {
  const checks: { name: string; status: 'passed' }[] = []
  const container = document.getElementById('root')!
  const root = createRoot(container)
  const assert = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message)
  }
  const query = (selector: string) => container.querySelector<HTMLElement>(selector)
  const click = async (selector: string) => {
    const node = query(selector)
    assert(node, `missing click target: ${selector}`)
    await act(async () => node!.click())
  }
  // RunDetailPanel and its embedded effect-recovery view read the language
  // and recovery-center action even before the Work Inbox fixture is mounted.
  // Keep a minimal store available for those first renders; the richer store
  // below is installed immediately before the Work Inbox checks.
  fixtureWindow.recoveryUiStore = {
    settings: { language: 'en' },
    setShowTaskRecovery: () => {},
    onSessionEvent: () => () => {}
  }
  window.agentDesk = {
    getTaskEffectRecovery: async (sessionId: string, runId?: string, taskId?: string) => ({ sessionId, runId, taskId, snapshots: [] }),
    onSessionEvent: () => () => {}
  } as typeof window.agentDesk
  const noResult = () => !query('[data-run-recovery-result]') && !query('[data-run-recovery-error]')
  const renderRun = async (run: WorkflowRunSummary, recover: () => Promise<void>, section = 'run') => {
    await act(async () => root.render(<RunDetailPanel input={{ runs: [run] }} route={`run/${run.id}/${section}`} onRecover={recover} />))
  }
  try {
    await renderRun(canonicalRun('run-a'), async () => { throw new Error('recovery command rejected') })
    await click('[data-run-recover]')
    assert(query('[data-run-recovery-error]')?.textContent === 'recovery command rejected', 'rejected recovery must show its error')
    assert(!query('[data-run-recovery-result]'), 'rejected recovery must not show completion')
    checks.push({ name: 'recovery rejection is visible without completion', status: 'passed' })

    await renderRun(canonicalRun('run-b'), async () => {})
    assert(noResult(), 'Run B must not inherit Run A error')
    assert(!query('[data-run-recover]')?.hasAttribute('disabled'), 'Run B recovery must remain available')
    checks.push({ name: 'changing Run clears error and busy state', status: 'passed' })

    for (const outcome of ['resolve', 'reject'] as const) {
      const pending = deferred()
      await renderRun(canonicalRun('run-a'), () => pending.promise)
      await click('[data-run-recover]')
      assert(query('[data-run-recover]')?.hasAttribute('disabled'), 'pending recovery must disable its button')
      await renderRun(canonicalRun('run-b'), async () => {})
      await act(async () => outcome === 'resolve' ? pending.resolve() : pending.reject(new Error('old Run failure')))
      assert(noResult(), `old Run ${outcome} must not update Run B`)
      assert(!query('[data-run-recover]')?.hasAttribute('disabled'), 'old Run must not leave Run B busy')
      checks.push({ name: `late ${outcome} from previous Run cannot update the current Run`, status: 'passed' })
    }

    for (const outcome of ['resolve', 'reject'] as const) {
      const pending = deferred()
      await renderRun(canonicalRun(`status-${outcome}`), () => pending.promise)
      await click('[data-run-recover]')
      await renderRun(canonicalRun(`status-${outcome}`, 'recovering'), () => pending.promise, 'recovery')
      assert(!query('[data-run-recover]'), 'canonical recovering state must remove the recovery button')
      await act(async () => outcome === 'resolve' ? pending.resolve() : pending.reject(new Error('post-transition failure')))
      if (outcome === 'resolve') {
        assert(query('[data-run-recovery-result="completed"]'), 'resolved action must remain visible after canonical status change')
        assert(!query('[data-run-recovery-error]'), 'resolved action must not show an error')
      } else {
        assert(query('[data-run-recovery-error]')?.textContent === 'post-transition failure', 'rejected action must remain visible after canonical status change')
        assert(!query('[data-run-recovery-result]'), 'post-transition rejection must not show completion')
      }
      checks.push({ name: `${outcome} stays visible when canonical recovery action disappears`, status: 'passed' })
      await renderRun(canonicalRun('run-b'), async () => {})
      assert(noResult(), 'changing Run must clear settled results')
    }

    const deliveryRun = canonicalRun('delivery-run', 'recovering')
    let openedDelivery: string[] | undefined
    await act(async () => root.render(<RunDetailPanel input={{ runs: [deliveryRun] }} route="run/delivery-run/acceptance" onOpenDelivery={(projectId, workItemId) => { openedDelivery = [projectId, workItemId ?? ''] }} />))
    assert(query('[data-acceptance-gate-status="missing"]'), 'fixture must have no current Acceptance')
    await click('[data-run-open-delivery]')
    assert(openedDelivery?.[0] === deliveryRun.projectId && openedDelivery?.[1] === deliveryRun.workItemId, 'Delivery navigation must retain canonical WorkItem identity without an Acceptance')
    checks.push({ name: 'missing Acceptance keeps canonical WorkItem delivery navigation available', status: 'passed' })

    const run = canonicalRun('inbox-run')
    const page = <T,>(items: T[]) => ({ items, total: items.length, hasMore: false })
    const selection: WorkflowLedgerRendererSelection = {
      goals: page([]), workItems: page([]), runs: page([run]), artifacts: page([]),
      acceptances: page([]), evidenceLinks: page([]), events: page([])
    }
    let failRead = false
    let recoveryCalls = 0
    fixtureWindow.recoveryUiStore = {
      settings: { language: 'en' },
      projectWorkspaces: [{ id: 'recovery-project', name: 'Recovery fixture', status: 'active' }],
      taskSnapshots: [{ id: 'snapshot-inbox', sessionId: run.sessionId, taskId: run.taskId, run }],
      recoverTaskSnapshot: async (snapshotId: string) => {
        assert(snapshotId === 'snapshot-inbox', 'Work Inbox must recover the matching snapshot')
        recoveryCalls += 1
        failRead = true
      },
      refreshProjectWorkspaces: async () => [],
      onSessionEvent: () => () => {},
      selectSession: () => {}, setStudioSurface: () => {}, setExperienceMode: () => {},
      setShowNewSession: () => {}, openProjectWorkspace: () => {}, openNewProjectWorkspace: () => {}
    }
    window.agentDesk = {
      getTaskEffectRecovery: async (sessionId: string, runId?: string, taskId?: string) => ({ sessionId, runId, taskId, snapshots: [] }),
      onSessionEvent: () => () => {},
      listTaskSnapshots: async () => [{ id: 'snapshot-inbox', sessionId: run.sessionId, taskId: run.taskId, run }],
      listWorkflowLedger: async () => {
        if (failRead) throw new Error('canonical Ledger refresh failed')
        return selection
      }
    } as typeof window.agentDesk
    await act(async () => root.render(<WorkInbox active />))
    await click('[data-inbox-action="open-run"]')
    await click('[data-run-recover]')
    assert(recoveryCalls === 1, 'Work Inbox must invoke recovery once')
    assert(query('[data-run-recovery-error]')?.textContent === 'canonical Ledger refresh failed', 'post-recovery refresh failure must propagate to Run detail')
    assert(query('.pws-inbox-error')?.textContent === 'canonical Ledger refresh failed', 'refresh failure must remain visible in Work Inbox')
    assert(!query('[data-run-recovery-result]'), 'refresh failure must not claim recovered and refreshed success')
    checks.push({ name: 'Work Inbox recovery propagates canonical refresh failure to Run detail', status: 'passed' })

    let unhandled = false
    const onUnhandled = (event: PromiseRejectionEvent) => { unhandled = true; event.preventDefault() }
    window.addEventListener('unhandledrejection', onUnhandled)
    await click('.pws-inbox-header-actions button:last-child')
    await new Promise((resolve) => setTimeout(resolve, 0))
    window.removeEventListener('unhandledrejection', onUnhandled)
    assert(!unhandled, 'manual refresh failure must be handled locally')
    assert(query('.pws-inbox-error')?.textContent === 'canonical Ledger refresh failed', 'manual refresh must keep its visible error')
    checks.push({ name: 'ordinary refresh displays failure without an unhandled rejection', status: 'passed' })
    return checks
  } finally {
    await act(async () => root.unmount())
  }
}
