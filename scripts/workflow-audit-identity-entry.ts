import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { ProjectAggregateService } from '../src/main/project-aggregate/project-aggregate-service'
import { assertNoCredentialMaterial, sanitizeProjectAggregateValue } from '../src/main/project-aggregate/codec'
import { projectImportSemanticDigest } from '../src/main/data-lifecycle/project-import-validation'
import { importWorkflowProjectAggregate } from '../src/main/data-lifecycle/workflow-project-import'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { openProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { buildTaskSnapshot, mutateTaskSnapshotDatabase, saveTaskSnapshot } from '../src/main/task/task-snapshot'
import { appendWorkflowEvent } from '../src/main/task/workflow-ledger-store'
import { listPersistedWorkflowLedger, verifyPersistedWorkflowLedger } from '../src/main/task/workflow-ledger-api'
import { exportPersistedWorkflowLedger } from '../src/main/task/workflow-ledger-maintenance'
import { redactSensitiveText } from '../src/main/security/secret-redaction'
import type { SessionMeta, TaskRunRecord } from '../src/shared/types'
import type { ProjectWorkspaceEvent } from '../src/shared/project-workspace-types'

const root = process.argv[2]
if (!root) throw new Error('fixture root is required')
const sourceRoot = join(root, 'source')
const targetRoot = join(root, 'target')
const projectId = 'audit-identity-project'
const goalId = 'audit-identity-goal'
const workItemId = 'audit-identity-work-item'
const runId = 'legacy-audit-identity-session'
const sessionId = 'audit-identity-session'
const now = 1_800_000_000_000

function aggregateService(rootDir: string): ProjectAggregateService {
  return new ProjectAggregateService({
    workspaceRoot: rootDir, workflowRoot: rootDir, digitalWorkerRoot: rootDir,
    aggregateRoot: rootDir, routineRoot: join(rootDir, 'routines'), learningRoot: join(rootDir, 'learning')
  })
}

async function main(): Promise<void> {
  await mkdir(sourceRoot, { recursive: true })
  await mkdir(targetRoot, { recursive: true })
  const workspace = await openProjectWorkspaceStore(sourceRoot)
  await workspace.createWorkspace({ id: projectId, name: 'Audit identity fixture', kind: 'opc', ownerId: 'fixture-user' })
  const commands = await openProjectWorkspaceCommandService(sourceRoot)
  await commands.createGoal({ id: goalId, projectId, title: 'Recovery audit history', objective: 'Retain every recovery revision', status: 'planned' })
  await commands.createWorkItem({ id: workItemId, projectId, goalId, businessLineId: 'studio', type: 'testing', title: 'Recovery audit', status: 'ready', owner: { type: 'human', id: 'fixture-user' } })

  const meta = {
    id: sessionId, childTaskId: 'audit-identity-task', title: 'Audit identity fixture', cwd: sourceRoot, workspaceId: projectId, goalId, workItemId,
    engine: 'openai', model: 'fixture-model', providerId: 'fixture-provider', taskStrategy: 'plan', permissionMode: 'plan',
    digitalWorkerBinding: { kind: 'unscoped' }, status: 'error', costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextTokens: 0, createdAt: now
  } as SessionMeta
  for (const [index, status] of (['failed', 'recovering', 'failed', 'recovering', 'failed'] as const).entries()) {
    const run: TaskRunRecord = {
      schemaVersion: 1, id: runId, sessionId, taskId: 'audit-identity-task', status,
      revision: index + 1, attempt: 1 + Math.ceil(index / 2), recoveryCount: Math.ceil(index / 2),
      digitalWorkerBinding: { kind: 'unscoped' }, createdAt: now, updatedAt: now + index
    }
    await saveTaskSnapshot(buildTaskSnapshot({ meta, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created', run, now: now + index }), sourceRoot)
  }
  const rawBefore = await listPersistedWorkflowLedger({ projectId, limit: 500 }, sourceRoot)
  const rawRunEvents = rawBefore.events.items.filter((event) => event.entityType === 'run')
  assert.equal(rawRunEvents.length, 5)
  assert.equal(new Set(rawRunEvents.map((event) => event.eventId)).size, 5)
  assert.equal(new Set(rawRunEvents.map((event) => redactSensitiveText(event.eventId))).size, 1,
    'fixture must reproduce lossy session: event identity redaction')
  const causationId = rawRunEvents.at(-1)!.eventId
  await mutateTaskSnapshotDatabase(sourceRoot, (db) => appendWorkflowEvent(db, {
    eventId: 'workflow:audit:identity:probe', streamId: `work-item:${workItemId}`,
    entityType: 'run', entityId: runId, kind: 'workflow.audit.identity.probe',
    payload: { note: 'session:fixture-sensitive-canary' }, causationId, occurredAt: now + 6
  }, { projectId, goalId, workItemId, runId, sessionId }))
  const rawLedger = await listPersistedWorkflowLedger({ projectId, limit: 500 }, sourceRoot)
  const exported = await exportPersistedWorkflowLedger({ scope: { projectId } }, sourceRoot)
  const events = exported.ledger.events.items
  const exportedRunEvents = events.filter((event) => event.entityType === 'run' && event.kind !== 'workflow.audit.identity.probe')
  assert.equal(new Set(events.map((event) => event.eventId)).size, events.length)
  assert.equal(exportedRunEvents.length, 5)
  assert(exportedRunEvents.every((event) => /^workflow-event-redacted:[a-f0-9]{64}$/.test(event.eventId)))
  const probe = events.find((event) => event.eventId === 'workflow:audit:identity:probe')!
  assert.equal(probe.causationId, exportedRunEvents.at(-1)!.eventId)
  assert.equal(probe.payload.note, 'session:[REDACTED]')
  assert(!JSON.stringify(exported).includes('fixture-sensitive-canary'))

  const source = aggregateService(sourceRoot)
  const snapshot = await source.verifyLiveProject(projectId)
  assert.equal(new Set(snapshot.audit.map((event) => event.id)).size, snapshot.audit.length)
  assert.deepEqual(sanitizeProjectAggregateValue(snapshot), snapshot, 'second sanitization must retain audit identities')
  assertNoCredentialMaterial(snapshot)
  const seal = await source.sealProject(projectId)
  assert.equal((await source.queryProject(projectId)).aggregateDigest, seal.aggregateDigest)
  assert.deepEqual((await listPersistedWorkflowLedger({ projectId, limit: 500 }, sourceRoot)).events, rawLedger.events,
    'export, aggregate and seal must leave persisted event identities and chain unchanged')

  const targetWorkspace = await openProjectWorkspaceStore(targetRoot)
  await targetWorkspace.createWorkspace({ id: 'unrelated-project', name: 'Existing target Project', kind: 'opc', ownerId: 'fixture-user' })
  const targetCommands = await openProjectWorkspaceCommandService(targetRoot)
  await targetCommands.createGoal({ id: 'unrelated-goal', projectId: 'unrelated-project', title: 'Shift target sequence', objective: 'Ensure portable identities do not depend on local seq', status: 'planned' })
  await targetCommands.createGoal({ id: 'unrelated-goal-two', projectId: 'unrelated-project', title: 'Shift target sequence again', objective: 'Exercise a nonempty target ledger', status: 'planned' })
  const imported = await importWorkflowProjectAggregate(snapshot, targetRoot)
  await targetWorkspace.importProjectSlice({
    workspace: snapshot.workspace, goals: snapshot.goals, workItems: snapshot.workItems, squads: snapshot.squads,
    members: snapshot.members, invitations: snapshot.invitations, comments: snapshot.comments,
    sharedApprovals: snapshot.sharedApprovals, inboxReceipts: snapshot.inboxReceipts ?? [],
    events: snapshot.audit.filter((event) => event.source === 'project_workspace').map((event) => event.value as ProjectWorkspaceEvent)
  })
  assert.deepEqual(await importWorkflowProjectAggregate(snapshot, targetRoot), imported, 'import replay must be idempotent')
  assert.equal((await verifyPersistedWorkflowLedger(targetRoot)).valid, true)
  const reexported = await exportPersistedWorkflowLedger({ scope: { projectId } }, targetRoot)
  const importedProbe = reexported.ledger.events.items.find((event) => event.eventId === probe.eventId)!
  assert.notEqual(importedProbe.seq, probe.seq, 'roundtrip must exercise a different local ledger sequence')
  assert.equal(importedProbe.causationId, probe.causationId)
  assert.deepEqual(reexported.ledger.events.items.filter((event) => event.entityType === 'run').map((event) => event.eventId),
    events.filter((event) => event.entityType === 'run').map((event) => event.eventId))
  const target = aggregateService(targetRoot)
  const restored = await target.verifyLiveProject(projectId)
  assert.equal(projectImportSemanticDigest(restored), projectImportSemanticDigest(snapshot))
  const targetSeal = await target.sealProject(projectId)
  assert.equal((await target.queryProject(projectId)).aggregateDigest, targetSeal.aggregateDigest)
  console.log(JSON.stringify({ status: 'passed', providerCalls: false, humanEvidence: false,
    evidenceStrength: 'production-store-local-fixture', checks: [
      'five recovery revisions survive lossy text redaction', 'causation IDs use the same portable mapping',
      'safe IDs stay unchanged and credential text stays redacted', 'aggregate identity survives repeated sanitization',
      'source seal verifies without ledger mutation', 'import and re-export preserve IDs across different ledger sequences',
      'import replay is idempotent and chains verify', 'restored aggregate remains semantically equal and can be sealed'
    ], runEvents: exportedRunEvents.length, sourceAuditCount: snapshot.audit.length, targetAuditCount: restored.audit.length }))
}

main().then(() => process.exit(0), (error: unknown) => { console.error(error); process.exit(1) })
