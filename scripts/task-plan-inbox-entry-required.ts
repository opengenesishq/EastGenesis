import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveInboxTaskDestination } from '../src/renderer/src/components/studio/workInboxTaskNavigation'
import type { SessionMeta, WorkflowLedgerRendererSelection, WorkflowRunSummary, WorkflowWorkItemRecord } from '../src/shared/types'
import type { WorkInboxItem } from '../src/shared/work-inbox-projection'
import { sessionExperienceMode } from '../src/renderer/src/store/session-experience'

const root = process.cwd()
const inbox = readFileSync(resolve(root, 'src/renderer/src/components/studio/WorkInbox.tsx'), 'utf8')
const workbench = readFileSync(resolve(root, 'src/renderer/src/components/experience/TaskPlanWorkbench.tsx'), 'utf8')
const checks: Array<{ id: string; status: 'passed'; detail: string }> = []
function check(id: string, condition: boolean, detail: string): void {
  assert(condition, detail)
  checks.push({ id, status: 'passed', detail })
}
check('canonical-session-navigation', inbox.includes('requestTaskPlanNavigation(target.sessionId)') && inbox.includes('selectSession(target.sessionId)') && inbox.includes('await syncSession(target.sessionId)'), 'Inbox loads the resolved canonical session before navigation')
check('single-plan-workbench', !inbox.includes('<TaskPlanWorkbench '), 'Inbox does not mount a duplicate plan editor with synthetic running state')
check('original-session-surface', inbox.includes("setStudioSurface('session')") && !inbox.includes("setExperienceMode('studio')"), 'Opening a task preserves its own experience mode and shows the session surface')
check('plan-entry-visible', inbox.includes('localized(\'打开计划\', \'Open plan\')'), 'Inbox exposes an Open plan action')
check('existing-plan-workbench', workbench.includes('approveTaskPlan') && workbench.includes('revokeTaskPlanApproval') && workbench.includes('dispatchApprovedTaskPlan'), 'Open plan lands on the existing approval workbench')
check('approval-is-explicit', workbench.includes('onApproveAndExecute') && workbench.includes('canApprove'), 'Plan approval and execution remain explicit')
check('no-provider-from-inbox', !/window\.agentDesk\.(sendMessage|run|execute|fetchProvider)/u.test(inbox), 'Inbox plan navigation does not call a Provider')

async function main(): Promise<void> {
assert.equal(sessionExperienceMode({ workspaceId: 'personal', workItemId: 'work', experienceModeOverride: 'assistant' }), 'assistant')
assert.equal(sessionExperienceMode({ workspaceId: 'project', workItemId: 'work' }), 'studio')
check('standalone-and-project-surfaces', true, 'Standalone work opens in Assistant and project work opens in Studio')
const item: WorkInboxItem = { id: 'row', sourceKind: 'work_item', sourceId: 'work', workItemId: 'work',
  projectId: 'project', goalId: 'goal', runId: 'old', title: 'Task', lane: 'running', status: 'running', artifactIds: [], updatedAt: 1 }
const work = { id: 'work', projectId: 'project', goalId: 'goal', runIds: ['old', 'current'], currentRunId: 'current' } as WorkflowWorkItemRecord
const run = { id: 'current', projectId: 'project', goalId: 'goal', workItemId: 'work', sessionId: 'session-current' } as WorkflowRunSummary
const session = { id: 'session-current', workspaceId: 'project', goalId: 'goal', workItemId: 'work', status: 'idle' } as SessionMeta
const page = (workItems: WorkflowWorkItemRecord[], runs: WorkflowRunSummary[]) => ({ workItems: { items: workItems }, runs: { items: runs } }) as WorkflowLedgerRendererSelection
const host = (works = [work], runs = [run], sessions = [session]) => ({
  readLedger: async () => page(works, runs), listSessions: async () => sessions
})
assert.equal((await resolveInboxTaskDestination(item, host())).sessionId, session.id)
check('current-run-wins-over-old-inbox-row', true, 'A stale row follows the canonical current Run, not the old session')
assert.equal((await resolveInboxTaskDestination(item, host([work], []))).reason, 'missing_run')
check('missing-current-run-does-not-fall-back', true, 'Missing current Run does not select an older task session')
assert.equal((await resolveInboxTaskDestination(item, host([work], [{ ...run, goalId: 'other' }]))).reason, 'identity_conflict')
assert.equal((await resolveInboxTaskDestination(item, host([work], [run], [{ ...session, workspaceId: 'other' }]))).reason, 'missing_session')
check('run-and-session-ownership-match', true, 'Both ledger and loaded session must match Project, Goal and WorkItem')
assert.equal((await resolveInboxTaskDestination(item, host([work], [run], [{ ...session, id: 'other-session' }]))).reason, 'missing_session')
check('missing-original-session-does-not-substitute', true, 'Another session on the same task is not adopted when the Run binds a missing session')
assert.equal((await resolveInboxTaskDestination(item, host([{ ...work, runIds: [], currentRunId: undefined }], [], [session]))).sessionId, session.id)
assert.equal((await resolveInboxTaskDestination(item, host([{ ...work, runIds: [], currentRunId: undefined }], [], [session, { ...session, id: 'duplicate' }]))).reason, 'identity_conflict')
check('unstarted-task-requires-unique-session', true, 'Tasks with no Run may use their sole matching session; ambiguity is rejected')
assert.equal((await resolveInboxTaskDestination(item, host([]))).reason, 'missing_task')
check('deleted-task-is-not-recreated', true, 'Missing tasks cannot navigate or cause new task creation')
const report = { schemaVersion: 1, contract: 'Work Inbox to canonical task and plan', status: 'passed', checks, summary: `${checks.length}/${checks.length} checks passed`, limitations: ['resolver runtime and renderer wiring only', 'does not prove Electron click path', 'does not approve or execute a plan'], generatedAt: new Date().toISOString() }
const output = resolve(root, 'test-results/task-plan-inbox-entry/latest.json')
mkdirSync(resolve(output, '..'), { recursive: true })
writeFileSync(output, `${JSON.stringify({ ...report, reportPath: output }, null, 2)}\n`)
console.log(JSON.stringify({ ...report, reportPath: output }, null, 2))
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
