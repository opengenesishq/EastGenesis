import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectAggregateSnapshot } from '../src/shared/project-aggregate-types'
import type { SessionMeta } from '../src/shared/types'
import type { WorkflowAcceptanceRecord, WorkflowRunRecord } from '../src/shared/workflow-types'
import { buildStudioAuditTimelinePage } from '../src/main/studio-result/studio-audit-timeline'
import { readOfficeRunRequirements } from '../src/main/task/office-delivery-requirement-ledger'
import { mutateTaskSnapshotDatabase } from '../src/main/task/task-snapshot'
import { appendWorkflowEvent } from '../src/main/task/workflow-ledger-store'
import { saveWorkflowAcceptance } from '../src/main/task/workflow-ledger-api'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { createProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'

const projectId = 'office-audit-project', goalId = 'office-audit-goal', workItemId = 'office-audit-work'
const session = { id: 'office-audit-session', workspaceId: projectId, goalId, workItemId } as SessionMeta
const acceptance = (id: string, own = false): WorkflowAcceptanceRecord => ({
  id, projectId, ...(own ? { goalId, workItemId } : {}), criteria: ['控制在六页'],
  status: own ? 'verifying' : 'failed', evidenceRefs: [], revision: 1, createdAt: 1, updatedAt: 2
})
const run = (id: string, owner = workItemId) => ({
  id, projectId, goalId, workItemId: owner, sessionId: session.id, status: 'completed', revision: 1, createdAt: 1, updatedAt: 2,
  taskRun: { id, sessionId: session.id, status: 'completed', steps: [], effects: [], toolExecutions: [] }
})
const aggregate = {
  projectId, aggregateDigest: 'fixture', workItems: [{ id: workItemId, goalId }, { id: 'foreign-work', goalId }],
  digitalWorkers: [], assignments: [], policies: [], audit: [],
  workflow: {
    runs: [run('original'), run('revision'), run('foreign', 'foreign-work')],
    artifacts: [
      { id: 'original-file', runId: 'original', workItemId },
      { id: 'revision-file', runId: 'revision', workItemId },
      { id: 'foreign-file', runId: 'foreign', workItemId: 'foreign-work' }
    ],
    acceptances: [acceptance('task-acceptance', true), acceptance('original-pages'),
      acceptance('revision-pages'), acceptance('foreign-pages'), acceptance('artifact-only-link'), acceptance('cross-run-link')],
    evidenceLinks: [
      { acceptanceId: 'original-pages', runId: 'original', artifactId: 'original-file' },
      { acceptanceId: 'revision-pages', runId: 'revision', artifactId: 'revision-file' },
      { acceptanceId: 'foreign-pages', runId: 'foreign', artifactId: 'foreign-file' },
      { acceptanceId: 'artifact-only-link', artifactId: 'original-file' },
      // A later run may reference an older artifact; filtering the earlier run
      // must not select this later run's acceptance through that shared file.
      { acceptanceId: 'cross-run-link', runId: 'revision', artifactId: 'original-file' }
    ],
    workflowEvidence: [], taskEvidence: []
  }
} as unknown as ProjectAggregateSnapshot
const selectedIds = (runId?: string) => buildStudioAuditTimelinePage({
  session, aggregate, query: { limit: 100, ...(runId ? { runId } : {}) }
}).items.filter(item => item.category === 'acceptance').map(item => item.acceptanceId).sort()
let passed = 0
function pass(name: string) { passed++; console.log(`PASS ${name}`) }

async function main() {
  const before = structuredClone(aggregate)
  assert.deepEqual(selectedIds(), ['artifact-only-link', 'cross-run-link', 'original-pages', 'revision-pages', 'task-acceptance'])
  pass('task audit includes artifact requirement failures and excludes another WorkItem')
  assert.deepEqual(selectedIds('original'), ['artifact-only-link', 'original-pages', 'task-acceptance'])
  assert.deepEqual(selectedIds('revision'), ['cross-run-link', 'revision-pages', 'task-acceptance'])
  pass('Run filtering preserves artifact-only links and excludes checks bound to another Run')
  assert.deepEqual(aggregate, before)
  assert(aggregate.workflow.acceptances.filter(item => item.id !== 'task-acceptance').every(item => !item.goalId && !item.workItemId))
  assert.equal(aggregate.workflow.acceptances.find(item => item.id === 'task-acceptance')?.status, 'verifying')
  pass('audit projection never grants whole-task acceptance ownership or approval')

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-office-audit-')))
  try {
    const workspace = await openProjectWorkspaceStore(root)
    await workspace.createWorkspace({ id: projectId, name: 'Office audit', kind: 'office' })
    const commands = createProjectWorkspaceCommandService(workspace, { rootDir: root })
    await commands.reconcileShadowProjection()
    await commands.createGoal({ id: goalId, projectId, title: 'Report', objective: '控制在六页', status: 'planned' })
    await commands.createWorkItem({ id: workItemId, projectId, goalId, title: 'Report', type: 'planning', status: 'ready' })
    const original = await saveWorkflowAcceptance({ id: 'frozen-contract', projectId, goalId, workItemId,
      criteria: ['输出 PPTX，控制在六页'], status: 'pending' }, root)
    await saveWorkflowAcceptance({ ...original, revision: original.revision + 1, status: 'verifying' }, root)
    // Exercise a same-entity, same-revision audit note; it is not an immutable
    // Acceptance projection and must not replace or duplicate that contract.
    await mutateTaskSnapshotDatabase(root, db => {
      appendWorkflowEvent(db, { eventId: 'office:acceptance-audit-note', streamId: `acceptance:${original.id}`,
        entityType: 'acceptance', entityId: original.id, kind: 'workflow.office.acceptance.audit_note',
        payload: { revision: original.revision, note: 'reviewed original requirement' }, occurredAt: Date.now()
      }, { projectId, goalId, workItemId })
    })
    const frozen = await readOfficeRunRequirements({ projectId, goalId, workItemId,
      acceptanceId: original.id, acceptanceRevision: original.revision } as WorkflowRunRecord, root)
    assert.deepEqual(frozen.criteria, original.criteria)
    assert.equal(frozen.binding.acceptanceRevision, original.revision)
    pass('historical Run contract ignores current revisions and unrelated same-revision audit notes')
  } finally { rmSync(root, { recursive: true, force: true }) }
  console.log(`Office requirement audit checks: ${passed}/${passed} passed; no Provider calls.`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
