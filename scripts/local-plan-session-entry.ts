import assert from 'node:assert/strict'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { AUTO_MODEL, AUTO_PROVIDER_ID, type AgentEvent, type CreateSessionOptions } from '../src/shared/types'
import { prepareSessionCreationDraft } from '../src/main/session-create-lifecycle'
import { OpenAIEngine } from '../src/main/openaiEngine'
import { listProviders } from '../src/main/providers'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { openProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { createTaskRun } from '../src/main/task/task-run'
import { taskRuntimeRegistry } from '../src/main/task/task-runtime-registry'
import { TaskPlanContractStore } from '../src/main/task/task-plan-contract-store'
import { resolveRuntimeSessionRoute } from '../src/main/model/session-runtime-routing'
import { planActiveSessionRecovery, writeActiveSessionRegistry } from '../src/main/session-active-registry'
import { readTranscriptEntriesStrict, transcriptFile } from '../src/main/transcript'
import { archiveConversationLedgerFromJsonl, restoreConversationLedgerJsonlFromArchive } from '../src/main/task/conversation-ledger-archive'
import { archiveConversationLedgerEntries, conversationLedgerArchiveIdentity, selectCurrentConversationLedgerEntries, verifyConversationLedgerArchive } from '../src/main/task/conversation-ledger-store'
import { mutateTaskSnapshotDatabase, readTaskSnapshotDatabase } from '../src/main/task/task-snapshot'

const root = process.argv[2]
if (!root) throw new Error('fixture root is required')
let fetchCalls = 0
globalThis.fetch = async () => { fetchCalls += 1; throw new Error('fixture forbids Provider calls') }

async function main(): Promise<void> {
  assert.equal(listProviders().length, 0)
  const store = await openProjectWorkspaceStore(root)
  await store.createWorkspace({ id: 'local-plan-project', name: 'Local plan fixture', kind: 'opc', ownerId: 'fixture-user' })
  const commands = await openProjectWorkspaceCommandService(root)
  await commands.createGoal({ id: 'local-plan-goal', projectId: 'local-plan-project', title: 'Create a local plan', objective: 'Plan before choosing a Provider', status: 'planned' })
  await commands.createWorkItem({ id: 'local-plan-item', projectId: 'local-plan-project', goalId: 'local-plan-goal', type: 'planning', businessLineId: 'studio', title: 'Plan locally', status: 'ready', owner: { type: 'human', id: 'fixture-user' } })
  const input: CreateSessionOptions = {
    cwd: root, model: AUTO_MODEL, providerId: AUTO_PROVIDER_ID, taskStrategy: 'plan',
    workspaceId: 'local-plan-project', goalId: 'local-plan-goal', workItemId: 'local-plan-item',
    businessLineId: 'studio', initialPrompt: '先生成本地计划，确认后再执行。'
  }
  const draft = prepareSessionCreationDraft(input)
  assert.equal(draft.baseMeta.providerId, '')
  assert.equal(draft.baseMeta.model, AUTO_MODEL)
  assert.equal(draft.baseMeta.modelRoutingDecision, undefined)
  assert.equal(draft.baseMeta.engine, 'openai')
  writeActiveSessionRegistry([draft.baseMeta], true)
  const initialRegistry = planActiveSessionRecovery(new Set(), new Set())
  assert.equal(initialRegistry.registryReadError, undefined)
  assert.equal(initialRegistry.records[0]?.providerId, '')
  assert.equal(initialRegistry.records[0]?.taskStrategy, 'plan')
  assert.equal(initialRegistry.restorable.length, 0, 'uninitialized local plan has no transcript to restore yet')
  const events: AgentEvent[] = []
  const engine = new OpenAIEngine(draft.baseMeta, (event) => events.push(event))
  await engine.start()
  assert.equal(engine.meta.status, 'idle')
  assert(engine.meta.sdkSessionId)
  assert.equal(events.filter((event) => event.kind === 'user-message').length, 0)
  writeActiveSessionRegistry([engine.meta], true)
  const persistedRegistry = readFileSync(join(root, 'active-sessions.json'), 'utf8')
  for (const patch of [
    { taskStrategy: 'execute' }, { taskStrategy: 'view' }, { routingScope: 'fixed' }, { routingScope: 'provider' },
    { model: 'fixed-model' }, { providerId: undefined }, { parentSessionId: 'parent' },
    { workspaceId: undefined }, { goalId: undefined }, { workItemId: undefined }, { workspaceId: ' ' },
    { permissionMode: 'bypassPermissions' }, { engine: 'anthropic' }, { status: 'running' }
  ]) {
    assert.throws(() => writeActiveSessionRegistry([{ ...engine.meta, ...patch } as typeof engine.meta], true), /session at index 0 is invalid/)
    assert.equal(readFileSync(join(root, 'active-sessions.json'), 'utf8'), persistedRegistry, 'rejected registry write must preserve the last valid record')
  }
  const recoveredRegistry = planActiveSessionRecovery(new Set(), new Set())
  assert.equal(recoveredRegistry.registryReadError, undefined)
  assert.equal(recoveredRegistry.skippedErrors.length, 0)
  assert.equal(recoveredRegistry.restorable.length, 1)
  assert.equal(recoveredRegistry.restorable[0].sdkSessionId, engine.meta.sdkSessionId)
  assert.equal(recoveredRegistry.restorable[0].providerId, '')
  await verifyLocalPlanArchive(engine.meta)
  const contracts = new TaskPlanContractStore(() => root)
  assert.throws(() => contracts.assertExecutionAuthorized(engine.meta.id, true), /计划|授权/)
  taskRuntimeRegistry.set(engine.meta.id, createTaskRun({ sessionId: engine.meta.id, taskId: engine.meta.id, digitalWorkerBinding: { kind: 'unscoped' } }))
  engine.send('这次尝试发送仍然必须等待 Provider。')
  assert(events.some((event) => event.kind === 'turn-result' && event.isError && event.subtype === 'routing-blocked'))
  assert.equal(engine.meta.status, 'error')
  assert.throws(() => resolveRuntimeSessionRoute({ meta: engine.meta, payload: { text: 'execute' } }), /Provider|候选|模型|路由/)

  // Dispatch creates execution/child Sessions through this same boundary.
  for (const options of [
    { ...input, taskStrategy: 'execute' as const },
    { ...input, workItemId: undefined },
    { ...input, parentSessionId: engine.meta.id },
    { ...input, routingScope: 'fixed' as const },
    { ...input, routingScope: 'provider' as const },
    { ...input, model: 'fixed-model' },
    { ...input, providerId: 'missing-provider' }
  ]) assert.throws(() => prepareSessionCreationDraft(options), /Provider|候选|模型|路由/)

  const restartedEvents: AgentEvent[] = []
  const restartMeta = { ...recoveredRegistry.restorable[0], status: 'starting' as const }
  await engine.dispose()
  const restarted = new OpenAIEngine(restartMeta, (event) => restartedEvents.push(event), restartMeta.sdkSessionId)
  await restarted.start()
  assert.equal(restarted.meta.status, 'idle', 'restored local plan stays usable without authentication')
  await restarted.setTaskStrategy('execute')
  restarted.send('执行依然没有可用路由。')
  assert(restartedEvents.some((event) => event.kind === 'turn-result' && event.isError && event.subtype === 'routing-blocked'))
  assert.equal(fetchCalls, 0)
  await restarted.dispose()
  taskRuntimeRegistry.delete(engine.meta.id)
  if (process.argv[3] === '--prepare-legacy-cold-start') {
    await mutateTaskSnapshotDatabase(root, (db) => {
      db.run('ALTER TABLE conversation_ledger_streams DROP COLUMN provider_binding')
    })
  }
  console.log(JSON.stringify({ status: 'passed', providerCalls: false, humanEvidence: false,
    evidenceStrength: 'production-lifecycle-and-engine-local-fixture', fetchCalls,
    checks: ['canonical local plan creation without Provider', 'engine initializes local transcript and reaches idle',
      'initialPrompt does not execute', 'plan authorization remains required', 'send still rejects without routing',
      'execution and child creation still reject without Provider', 'fixed and incomplete targets do not bypass selection',
      'uninitialized local plan persists through the actual active registry',
      'initialized local plan reads back as restorable from the active registry',
      'unbound execute, fixed, child and malformed registry writes reject without replacing valid data',
      'provider-bound archive survives legacy schema migration',
      'unrouted local plan archives without a fabricated Provider',
      'archive rejects unmarked and malformed provider-neutral identities',
      'missing local transcript restores byte-for-byte from reopened SQLite archive',
      'archive readback rejects a corrupt provider binding or canonical identity',
      'binding a Provider identity preserves the local conversation generation',
      'restored local plan starts locally', 'switching to execute does not bypass route checks'] }))
}

async function verifyLocalPlanArchive(meta: OpenAIEngine['meta']): Promise<void> {
  const entries = readTranscriptEntriesStrict(meta.sdkSessionId!)
  assert(entries.length > 0)
  const identity = conversationLedgerArchiveIdentity(meta)!
  assert.equal(identity.providerBinding, 'unrouted-local-plan')
  assert.equal(identity.providerId, '')
  const legacyIdentity = { ...identity, sdkSessionId: 'legacy-provider-archive', providerId: 'fixture-provider', providerBinding: undefined }
  await mutateTaskSnapshotDatabase(root, (db) => {
    archiveConversationLedgerEntries(db, legacyIdentity, entries)
    db.run('ALTER TABLE conversation_ledger_streams DROP COLUMN provider_binding')
  })
  const archived = await archiveConversationLedgerFromJsonl(identity, { rootDir: root })
  assert.equal(archived?.entryCount, entries.length)
  assert.equal(archived?.generation, 1)
  await readTaskSnapshotDatabase(root, (db) => {
    assert.deepEqual(selectCurrentConversationLedgerEntries(db, legacyIdentity.sdkSessionId), entries)
    const rows = db.exec('SELECT sdk_session_id, provider_id, provider_binding FROM conversation_ledger_streams ORDER BY sdk_session_id')[0].values
    assert(rows.some((row) => row[0] === legacyIdentity.sdkSessionId && row[1] === 'fixture-provider' && row[2] === 'provider'))
    assert(rows.some((row) => row[0] === meta.sdkSessionId && row[1] === '' && row[2] === 'unrouted-local-plan'))
    assert.equal(verifyConversationLedgerArchive(db).valid, true)
  })
  for (const patch of [
    { taskStrategy: 'execute' }, { taskStrategy: 'view' }, { routingScope: 'fixed' }, { routingScope: 'provider' },
    { model: 'fixed-model' }, { parentSessionId: 'parent' }, { permissionMode: 'bypassPermissions' }, { engine: 'anthropic' }
  ]) {
    const rejected = conversationLedgerArchiveIdentity({ ...meta, ...patch } as typeof meta)!
    assert.equal(rejected.providerBinding, undefined)
    await assert.rejects(archiveConversationLedgerFromJsonl(rejected, { rootDir: root }), /providerId/)
  }
  for (const patch of [
    { providerBinding: undefined }, { providerBinding: 'unknown' }, { providerId: ' ' },
    { providerId: 'fixture-provider' }, { model: 'fixed-model' }, { engine: 'anthropic' },
    { workspaceId: undefined }, { goalId: ' ' }, { workItemId: undefined }
  ]) {
    await assert.rejects(archiveConversationLedgerFromJsonl({ ...identity, ...patch } as typeof identity, { rootDir: root }), /providerId|provider binding|local plan identity/)
  }
  const original = readFileSync(transcriptFile(meta.sdkSessionId!), 'utf8')
  unlinkSync(transcriptFile(meta.sdkSessionId!))
  assert.equal(await restoreConversationLedgerJsonlFromArchive(meta.sdkSessionId, root), true)
  assert.equal(readFileSync(transcriptFile(meta.sdkSessionId!), 'utf8'), original)
  assert.equal(await restoreConversationLedgerJsonlFromArchive(meta.sdkSessionId, root), false)
  // Read-only database handles are discarded after each callback; corruptions
  // below exercise the actual decoder without changing the durable archive.
  for (const sql of [
    "UPDATE conversation_ledger_streams SET provider_binding = 'provider' WHERE provider_id = ''",
    "UPDATE conversation_ledger_streams SET provider_binding = 'unknown' WHERE provider_id = ''",
    "UPDATE conversation_ledger_streams SET goal_id = NULL WHERE provider_id = ''"
  ]) await readTaskSnapshotDatabase(root, (db) => {
    db.run(sql)
    assert.throws(() => selectCurrentConversationLedgerEntries(db, meta.sdkSessionId!), /providerId|provider binding|local plan identity/)
  })
  const boundIdentity = conversationLedgerArchiveIdentity({ ...meta, providerId: 'fixture-provider', model: 'fixture-model' })!
  const bound = await archiveConversationLedgerFromJsonl(boundIdentity, { rootDir: root })
  assert.equal(bound?.generation, 1)
  assert.equal(bound?.appended, 0)
  await readTaskSnapshotDatabase(root, (db) => {
    assert.deepEqual(selectCurrentConversationLedgerEntries(db, meta.sdkSessionId!), entries)
    const rows = db.exec('SELECT provider_id, provider_binding FROM conversation_ledger_streams WHERE sdk_session_id = ?', [meta.sdkSessionId!])[0].values
    assert.deepEqual(rows, [['fixture-provider', 'provider']])
    assert.equal(verifyConversationLedgerArchive(db).valid, true)
  })
}

async function verifyLegacyArchiveColdStart(): Promise<void> {
  // This process has never opened the task store. Readiness must inspect the
  // legacy archive before any normal archive write can migrate its schema.
  const archived = await readTaskSnapshotDatabase(root, (db) => {
    const hasBindingColumn = () => db.exec('PRAGMA table_info(conversation_ledger_streams)')[0].values.some((row) => row[1] === 'provider_binding')
    assert.equal(hasBindingColumn(), false, 'cold-start readiness must inspect the unmodified legacy source')
    assert.equal(verifyConversationLedgerArchive(db).valid, true)
    assert.equal(hasBindingColumn(), false, 'read-only archive verification must not migrate its source')
    db.run('SAVEPOINT legacy_provider_validation')
    try {
      db.run("UPDATE conversation_ledger_streams SET provider_id = '' WHERE sdk_session_id = 'legacy-provider-archive'")
      assert.throws(() => verifyConversationLedgerArchive(db), /providerId/)
    } finally {
      db.run('ROLLBACK TO legacy_provider_validation')
      db.run('RELEASE legacy_provider_validation')
    }
    return selectCurrentConversationLedgerEntries(db, 'legacy-provider-archive')
  })
  assert(archived.length > 0)
  const meta = planActiveSessionRecovery(new Set(), new Set()).restorable[0]
  assert(meta)
  const identity = {
    ...conversationLedgerArchiveIdentity(meta)!, sdkSessionId: 'legacy-provider-archive',
    providerId: 'fixture-provider', providerBinding: undefined
  }
  await mutateTaskSnapshotDatabase(root, (db) => {
    archiveConversationLedgerEntries(db, identity, archived)
  })
  await readTaskSnapshotDatabase(root, (db) => {
    assert(db.exec('PRAGMA table_info(conversation_ledger_streams)')[0].values.some((row) => row[1] === 'provider_binding'))
    assert.deepEqual(selectCurrentConversationLedgerEntries(db, identity.sdkSessionId), archived)
    assert.equal(verifyConversationLedgerArchive(db).valid, true)
  })
  assert.equal(await restoreConversationLedgerJsonlFromArchive(identity.sdkSessionId, root), true)
  assert.deepEqual(readTranscriptEntriesStrict(identity.sdkSessionId), archived)
  assert.equal(fetchCalls, 0)
  console.log(JSON.stringify({ status: 'passed', fetchCalls, checks: [
    'an independent cold process opens the legacy archive through the real task-store readiness gate',
    'legacy archive migration and transcript recovery preserve sealed events across processes',
    'legacy read-only validation neither mutates schema nor accepts an empty Provider identity'
  ] }))
}

const operation = process.argv[3] === '--verify-legacy-cold-start' ? verifyLegacyArchiveColdStart() : main()
operation.then(() => process.exit(0), (error: unknown) => { console.error(error); process.exit(1) })
