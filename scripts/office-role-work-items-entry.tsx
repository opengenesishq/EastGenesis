import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import OfficeRoleWorkItems, { officeRoleWorkItems } from '../src/renderer/src/components/office/OfficeRoleWorkItems'
import { openOfficeWorkItem } from '../src/renderer/src/components/office/officeWorkItemNavigation'
import { takeProjectWorkspaceNavigation } from '../src/renderer/src/components/studio/projectWorkspaceNavigation'
import type { WorkItem, ProjectWorkspace } from '../src/shared/project-workspace-types'
import type { SystemRoleId } from '../src/renderer/src/components/office/kit/palace/systemRoleCatalog'
import type { OfficeOperationStatus } from '../src/renderer/src/components/office/officeOperationRefresh'

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
    return checks
  } finally { await act(async () => root.unmount()) }
}
