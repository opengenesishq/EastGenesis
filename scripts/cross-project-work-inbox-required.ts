import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { adaptCrossProjectWorkInbox, mergeWorkflowLedgerPages } from '../src/renderer/src/components/studio/workInboxNavigation'
import type { ProjectWorkspace, WorkflowLedgerRendererSelection } from '../src/shared/types'

const stamp = 1_700_000_000_000
const project = (id: string, name: string): ProjectWorkspace => ({ id, name, kind: 'software', status: 'active', revision: 1, ownerId: 'local', resources: [], createdAt: stamp, updatedAt: stamp } as ProjectWorkspace)
const workItem = (id: string, projectId: string, status: 'waiting_approval' | 'running' | 'blocked' | 'verifying' | 'done') => ({
  schemaVersion: 1, id, projectId, goalId: `goal-${id}`, type: 'coding', title: id, status, revision: 1,
  source: 'explicit', runIds: [], createdAt: stamp, updatedAt: stamp
})
const emptyPage = <T,>(items: T[]) => ({ items, total: items.length, hasMore: false })
const ledger = (items: ReturnType<typeof workItem>[]): WorkflowLedgerRendererSelection => ({
  goals: emptyPage([]), workItems: emptyPage(items), runs: emptyPage([]), artifacts: emptyPage(items.filter((item) => item.status === 'verifying' || item.status === 'done').map((item) => ({ schemaVersion: 1, id: `artifact-${item.id}`, projectId: item.projectId, workItemId: item.id, kind: 'document', title: 'artifact', version: 1, digest: `digest-${item.id}`, provenance: 'explicit', createdAt: stamp, updatedAt: stamp }))), acceptances: emptyPage(items.filter((item) => item.status === 'verifying' || item.status === 'done').map((item) => ({ schemaVersion: 1, id: `acceptance-${item.id}`, projectId: item.projectId, workItemId: item.id, criteria: ['criterion'], status: 'passed', evidenceRefs: [], revision: 1, createdAt: stamp, updatedAt: stamp }))), evidenceLinks: emptyPage([]), events: emptyPage([])
})

const items = [workItem('confirm', 'p1', 'waiting_approval'), workItem('run', 'p1', 'running'), workItem('blocked', 'p2', 'blocked'), workItem('delivery', 'p2', 'verifying'), workItem('complete', 'p2', 'done')]
const projection = adaptCrossProjectWorkInbox(ledger(items), [project('p1', 'Alpha'), project('p2', 'Beta')])
assert.equal(projection.total, 5)
assert.deepEqual(Object.fromEntries(Object.entries(projection.lanes).map(([lane, value]) => [lane, value.count])), { needs_confirmation: 1, running: 1, blocked: 1, ready_for_delivery: 1, completed: 1 })
assert.equal(projection.lanes.blocked.items[0]?.projectName, 'Beta')
assert.equal(projection.lanes.completed.items[0]?.projectAvailable, true)
const unknown = adaptCrossProjectWorkInbox(ledger([workItem('orphan', 'missing', 'running')]), [project('p1', 'Alpha')])
assert.equal(unknown.items[0]?.projectAvailable, false)
const merged = mergeWorkflowLedgerPages([ledger(items.slice(0, 2)), ledger(items.slice(2))])
assert.equal(merged?.workItems.items.length, 5)

const report = { schemaVersion: 1, contract: 'V2-013 cross-project Work Inbox navigation', status: 'passed', checks: 6, passed: 6, coverage: { verified: ['shared Ledger to five lane adapter', 'project labels and availability gate', 'page merge without duplicate identities'], explicitlyNotVerified: ['human click path in packaged Electron', 'Provider calls'] }, generatedAt: new Date().toISOString() }
const output = resolve(process.cwd(), 'test-results/cross-project-work-inbox/latest.json')
mkdirSync(resolve(output, '..'), { recursive: true })
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ ...report, reportPath: output }, null, 2))
