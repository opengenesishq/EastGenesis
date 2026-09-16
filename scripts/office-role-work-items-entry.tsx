import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import OfficeRoleWorkItems, { officeRoleWorkItems } from '../src/renderer/src/components/office/OfficeRoleWorkItems'
import { openOfficeWorkItem } from '../src/renderer/src/components/office/officeWorkItemNavigation'
import { takeProjectWorkspaceNavigation } from '../src/renderer/src/components/studio/projectWorkspaceNavigation'
import type { WorkItem, ProjectWorkspace } from '../src/shared/project-workspace-types'
import type { SystemRoleId } from '../src/renderer/src/components/office/kit/palace/systemRoleCatalog'
import type { OfficeOperationStatus } from '../src/renderer/src/components/office/officeOperationRefresh'
import PalaceInstitutionWorkItem from '../src/renderer/src/components/office/PalaceInstitutionWorkItem'
import { palaceInstitutionExecution } from '../src/renderer/src/components/office/palaceActions'
import { useStore, type SessionState } from '../src/renderer/src/store'
import type { WorkflowRunSummary } from '../src/shared/types'

const fixtureWindow = window as typeof window & {
  IS_REACT_ACT_ENVIRONMENT: boolean
  runOfficeRoleHarness: () => Promise<{ id: string; status: 'passed' }[]>
}
fixtureWindow.IS_REACT_ACT_ENVIRONMENT = true
function task(id: string, role: string | undefined, owner?: WorkItem['owner']): WorkItem {
  return { schemaVersion: 1, id, projectId: 'project:actual', title: `真实任务 ${id}`, type: 'coding',
    role, owner, dependencyIds: [], priority: 1, status: 'running', acceptanceSpec: [], artifactRefs: ['artifact:actual'],
    runRefs: ['run:actual'], createdAt: 1, updatedAt: 2, revision: 1 }
}
const items = [task('work:owner', 'gongbu', { type: 'digital_worker', id: 'worker:actual', displayName: '实际工程员' }),
  task('work:unassigned', 'research'), task('work:human', undefined, { type: 'human', id: 'human:actual', displayName: '真实负责人' })]
const projects = [{ id: 'project:actual', name: '真实项目' }] as ProjectWorkspace[]

fixtureWindow.runOfficeRoleHarness = async () => {
  const checks: { id: string; status: 'passed' }[] = []
  const passed = (id: string) => checks.push({ id, status: 'passed' })
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message) }
  const container = document.getElementById('root')!
  const root = createRoot(container)
  const read = (selector: string) => container.querySelector<HTMLElement>(selector)
  const calls: string[] = []
  const navigation = { openProjectWorkspace: (id: string) => calls.push(`project:${id}`), setView: (view: 'list') => calls.push(`view:${view}`) }
  function Harness({ workItems = items, status = { state: 'ready' } }: { workItems?: WorkItem[]; status?: OfficeOperationStatus }) {
    const [role, setRole] = useState<SystemRoleId>('taizi')
    return <OfficeRoleWorkItems roleId={role} onSelectRole={setRole} workItems={workItems} projects={projects}
      status={status} zh onOpen={(item) => openOfficeWorkItem(item, navigation)} />
  }
  const render = async (workItems = items, status: OfficeOperationStatus = { state: 'ready' }) => {
    await act(async () => root.render(<Harness workItems={workItems} status={status} />))
  }
  const selectRole = async (value: SystemRoleId) => {
    const select = read('[data-office-role-selector]') as HTMLSelectElement
    await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
  }
  try {
    const frozen = JSON.stringify(items)
    await render()
    assert(container.querySelectorAll('[data-office-role-work-item]').length === 3, 'coordinator omitted canonical tasks')
    assert(container.textContent?.includes('真实项目'), 'project title missing')
    assert(calls.length === 0, 'render must never open or write a task')
    assert(JSON.stringify(items) === frozen, 'projection mutated canonical input')
    passed('coordination-renders-canonical-tasks-without-mutation')
    assert(read('[data-office-role-work-item-owner="worker:actual"]')?.textContent?.includes('实际工程员'), 'real owner missing')
    assert(read('[data-office-role-work-item="work:unassigned"]')?.textContent?.includes('未分派'), 'unassigned task acquired a synthetic owner')
    assert(read('[data-office-role-work-item-owner="human:actual"]')?.textContent?.includes('真实负责人'), 'human owner missing')
    passed('owners-come-from-canonical-assignment-and-unassigned-is-explicit')
    await selectRole('gongbu')
    assert(container.querySelectorAll('[data-office-role-work-item]').length === 1, 'role view guessed unrelated task roles')
    assert(read('[data-office-role-work-item="work:owner"]'), 'explicit task role missing')
    passed('keyboard-accessible-role-selector-filters-only-explicit-role-id')
    await selectRole('hubu')
    assert(read('[data-office-role-work-items-empty]')?.textContent?.includes('尚无明确分派'), 'unconfigured role claimed readiness')
    assert(!read('[data-office-open-role-work-item]'), 'empty role has a synthetic runnable task')
    passed('unconfigured-role-shows-no-executor-or-task-claim')
    await selectRole('taizi')
    await act(async () => read('[data-office-open-role-work-item="work:owner"]')!.click())
    const target = takeProjectWorkspaceNavigation('project:actual')
    assert(target?.workItemId === 'work:owner' && target.focus === 'work-item', 'navigation lost canonical WorkItem')
    assert(calls.join('|') === 'project:project:actual|view:list', 'navigation did not enter the existing workbench')
    passed('row-action-opens-exact-project-and-work-item-in-existing-workbench')
    await render(items.map((item) => item.id === 'work:owner' ? { ...item, status: 'failed', revision: 2 } : item))
    assert(read('[data-office-role-work-item="work:owner"] [data-office-role-work-item-status="failed"]')?.textContent === '失败', 'new canonical status was not reflected')
    passed('new-canonical-failure-replaces-prior-running-state')
    await render([], { state: 'loading' })
    assert(read('[aria-busy="true"]') && !read('[data-office-role-work-items-empty]'), 'loading was presented as no tasks')
    passed('loading-is-distinct-from-empty')
    await render(items, { state: 'stale', error: 'fixture offline' })
    assert(read('[role="alert"]') && read('[data-office-role-work-item="work:owner"]'), 'stale read hid old records or failure')
    passed('refresh-failure-keeps-last-records-with-visible-warning')
    const before = calls.length
    try { openOfficeWorkItem({ id: '', projectId: 'project:actual' }, navigation) } catch { /* expected */ }
    assert(calls.length === before, 'invalid identity caused navigation')
    passed('invalid-task-identity-does-not-navigate')
    const twentyOne = Array.from({ length: 21 }, (_, index) => task(`many:${index}`, undefined))
    await render(twentyOne)
    assert(container.querySelectorAll('[data-office-role-work-item]').length === 20, 'list is not bounded')
    assert(read('[data-office-role-work-items-count="21"]')?.textContent?.includes('20 / 21'), 'limited list hid total count')
    assert(officeRoleWorkItems('gongbu', [task('looks-like-ministry', undefined, { type: 'digital_worker', id: 'gongbu', displayName: '工部' })]).length === 0, 'owner name inferred role')
    passed('bounded-list-discloses-total-and-owner-names-never-infer-roles')

    const patrolItem = { ...items[0], goalId: 'goal:actual', runRefs: ['run:old', 'run:current'] }
    const runs = ['old', 'current'].map((suffix, index) => ({ id: `run:${suffix}`, projectId: patrolItem.projectId,
      goalId: patrolItem.goalId, workItemId: patrolItem.id, sessionId: `session:${suffix}`, status: index ? 'completed' : 'failed',
      createdAt: index + 1, revision: 1 })) as WorkflowRunSummary[]
    const session = (id: string): SessionState => ({ meta: { id, workspaceId: patrolItem.projectId, goalId: patrolItem.goalId,
      workItemId: patrolItem.id, status: 'idle', title: id }, pendingPermissions: [], runningTools: {} } as SessionState)
    const patrolSessions = { 'session:old': session('session:old'), 'session:current': session('session:current') }
    const originalState = useStore.getState()
    const patrolCalls: string[] = []
    const renderPatrol = async (nextRuns = runs, nextSessions = patrolSessions) => {
      await act(async () => root.render(<PalaceInstitutionWorkItem item={patrolItem} runs={nextRuns} sessions={nextSessions} zh
        onRun={id => patrolCalls.push(`run:${id}`)} onStudy={id => patrolCalls.push(`study:${id}`)}
        onDelivery={() => patrolCalls.push('delivery')} onWorkItem={() => patrolCalls.push('work-item')} />))
    }
    try {
      useStore.setState({ sessions: patrolSessions, activeId: 'session:unrelated', taskSnapshots: [], taskSnapshotsError: undefined,
        modelAttemptReconciliations: [], syncSession: async id => { patrolCalls.push(`sync:${id}`); return true },
        hydrateTaskRecoveryCandidates: async () => { patrolCalls.push('recovery-check') },
        sendMessage: async (_text, id) => { patrolCalls.push(`send:${id}`) },
        interrupt: async id => { patrolCalls.push(`stop:${id}`) } })
      await renderPatrol()
      assert(patrolCalls.length === 0, 'render issued an institution task command')
      assert(read('[data-palace-institution-run="run:current"]'), 'patrol did not bind latest canonical execution')
      assert(container.querySelectorAll('[data-palace-institution-run-selector] option').length === 2, 'earlier execution missing')
      assert(read('[data-office-session-actions="session:current"]'), 'controls bound the old session')
      passed('patrol-binds-latest-canonical-execution-and-retains-history')
      await act(async () => read('[data-office-session-continue]')!.click())
      assert(patrolCalls.join('|') === 'sync:session:current|recovery-check|send:session:current', 'continue bypassed recovery or used global selection')
      passed('patrol-continues-exact-task-through-existing-recovery-gate')
      const runningSessions = { ...patrolSessions, 'session:current': { ...patrolSessions['session:current'], meta: { ...patrolSessions['session:current'].meta, status: 'running' as const } } }
      useStore.setState({ sessions: runningSessions })
      await renderPatrol(runs, runningSessions)
      await act(async () => read('[data-office-session-stop]')!.click())
      assert(patrolCalls.at(-1) === 'stop:session:current', 'stop targeted another session')
      passed('patrol-stops-only-current-institution-execution')
      const select = read('[data-palace-institution-run-selector]') as HTMLSelectElement
      await act(async () => { select.value = 'run:old'; select.dispatchEvent(new Event('change', { bubbles: true })) })
      assert(!read('[data-office-session-actions]'), 'historical execution showed current execution mutation controls')
      await act(async () => read('[data-palace-institution-run="run:old"]')!.click())
      assert(patrolCalls.at(-1) === 'run:run:old', 'historical execution opened current run')
      await act(async () => read('[data-palace-institution-delivery]')!.click())
      assert(patrolCalls.at(-1) === 'delivery', 'task delivery review was not opened')
      passed('patrol-opens-historical-run-and-delivery-without-controlling-newer-run')
      await renderPatrol(runs.slice(0, 1))
      assert(!read('[data-office-session-actions]') && read('[role="status"]')?.textContent?.includes('1 次运行'), 'missing latest record fell back to old live session')
      const crossProject = palaceInstitutionExecution(patrolItem, [{ ...runs[1], projectId: 'other' }], Object.values(patrolSessions).map(entry => entry.meta))
      const crossGoal = palaceInstitutionExecution(patrolItem, [{ ...runs[1], goalId: 'other' }], Object.values(patrolSessions).map(entry => entry.meta))
      const duplicates = palaceInstitutionExecution(patrolItem, [runs[1], runs[1]], Object.values(patrolSessions).map(entry => entry.meta))
      assert(!crossProject.sessionId && !crossGoal.sessionId && !duplicates.sessionId, 'untrusted run identity exposed task controls')
      passed('patrol-missing-duplicate-or-other-task-records-cannot-target-old-session')
    } finally { useStore.setState(originalState, true) }
    return checks
  } finally { await act(async () => root.unmount()) }
}
