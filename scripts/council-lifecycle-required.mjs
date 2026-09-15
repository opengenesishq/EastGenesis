import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire, Module } from 'node:module'

const require = createRequire(import.meta.url), ts = require('typescript')
const root = mkdtempSync(join(tmpdir(), 'caogen-council-replay-')), file = join(root, 'existing-task-snapshot.json')
const cache = new Map(), stubs = new Map()
function load(path) {
  if (stubs.has(path)) return stubs.get(path)
  if (cache.has(path)) return cache.get(path).exports
  const mod = new Module(path); cache.set(path, mod); mod.filename = path; mod.paths = Module._nodeModulePaths(dirname(path))
  mod.require = (name) => {
    if (stubs.has(name)) return stubs.get(name)
    if (!name.startsWith('.')) return require(name)
    const target = resolve(dirname(path), name)
    return load(target.endsWith('.ts') ? target : `${target}.ts`)
  }
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), { fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, path)
  return mod.exports
}
const source = (path) => load(resolve(path))
const stub = (path, value) => stubs.set(resolve(path), value)
function method(path, className, methodName, globals) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true)
  const owner = source.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === className)
  const member = owner.members.find((node) => node.name?.getText(source) === methodName)
  const js = ts.transpileModule(`class Subject { ${member.getText(source)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(globals), `${js}; return Subject.prototype.${methodName}`)(...Object.values(globals))
}

try {
  const provider = { id: 'offline-provider', name: 'Offline', engine: 'openai', baseUrl: 'https://fixture.invalid/v1', models: ['offline-model'],
    advancedConfig: { modelProfiles: [{ model: 'offline-model', contextWindow: 200000, pricing: { inputPerMillion: 1, outputPerMillion: 1, source: 'user' } }] } }
  stub('src/main/providers.ts', { getProvider: () => provider, providerIsReady: () => true, getProviderConnectionIdentity: () => ({ generationId: 'fixture', revision: 1 }) })
  const { estimateNativeRequestUpperCost } = source('src/main/model/native-request-cost.ts')
  stub('src/main/model/native-request-budget.ts', { estimateNativeRequestUpperCost,
    nativeBudgetScope: () => ({ sessionLimitUsd: 0.5 }), nativeBudgetSnapshot: () => ({ sessionUnknown: false, monthlyUnknown: false, sessionRemainingUsd: 0.5 }) })
  const template = { schemaVersion: 1, templateId: 'cabinet-six-ministries', templateVersion: 1 }
  const parent = { id: 'parent', workspaceId: 'project', goalId: 'goal', workItemId: 'work', providerId: provider.id, model: 'offline-model',
    taskStrategy: 'view', status: 'idle', cwd: root, businessLineId: 'office', costUsd: 0, budgetUsd: 0.5 }
  const goal = { id: 'goal', projectId: 'project', title: 'Goal', objective: 'Preserve all user constraints', constraints: ['Must keep this exact fact'],
    successCriteria: [], forbiddenActions: [], contract: { constraints: ['Must keep this exact fact'] }, status: 'active' }
  const task = { id: 'work', goalId: 'goal', title: 'Task', artifactRefs: [], status: 'todo' }
  stub('src/main/project-workspace/institution-goal-binding.ts', { readGoalInstitutionContext: async () => ({ template }) })
  stub('src/main/project-workspace/canonical-read-service.ts', { ProjectWorkspaceReadService: class { async getWorkspaceExecutionState() { return { goals: [goal], workItems: [task] } } } })
  let workItems = 0
  stub('src/main/project-workspace/command-service.ts', { openProjectWorkspaceCommandService: async () => ({ createWorkItem: async () => { workItems++ } }) })
  stub('src/main/task/supervisor-state.ts', { SupervisorStateStore: class { async listRuns() { return [] } } })
  let stored
  const read = () => JSON.parse(readFileSync(file, 'utf8'))
  const save = (value) => { stored = structuredClone(value); writeFileSync(file, JSON.stringify(stored)); return stored }
  stub('src/main/task/task-snapshot.ts', { listTaskRuns: async () => [], listTaskSnapshots: async () => stored ? [read()] : [],
    getTaskSnapshot: async () => stored ? read() : null, saveTaskSnapshot: async (value) => save(value) })
  const { CouncilService } = source('src/main/council/council-service.ts')
  let sends = 0, creates = 0, service
  const metas = new Map([[parent.id, parent]]), executions = new Map()
  const runtime = {
    ready: async () => undefined, meta: (id) => metas.get(id), metas: () => [...metas.values()], transcript: () => [],
    create: async (options, id) => { creates++; const child = { ...options, id, status: 'idle', permissionMode: 'default' }; metas.set(id, child); return child },
    inputs: () => ({ queue: async () => undefined, apply: async () => { sends++; return { phase: 'applied' } } }),
    persist: async (id) => save({ id, sessionId: id, meta: parent, run: { id: 'parent-run', sessionId: id, status: 'completed' },
      dagExecutions: [...executions.values()], dagRuntimes: service.snapshots(id) }),
    update: (view) => executions.set(view.id, view), interrupt: async () => undefined, reserve: () => () => undefined, acknowledge() {}
  }
  service = new CouncilService(root, runtime)
  const input = { sessionId: 'parent', requestId: 'same-request', topic: 'Review', institutionIds: [] }
  const preview = await service.preview(input)
  assert.equal(preview.participants.length, 2)
  assert.equal(preview.blockedReasons.length, 0)
  const started = await service.start({ ...input, previewDigest: preview.previewDigest })
  assert.equal(sends, 2); assert.equal(creates, 2); assert.equal(workItems, 2)
  for (const opinion of started.opinions) await service.complete(opinion.sessionId, { ok: true, resultText: `Original opinion ${opinion.institutionId}` })
  const completed = read(), counter = { sends, creates, workItems }
  assert.equal(completed.dagRuntimes[0].council.record.phase, 'completed')
  assert.match(completed.dagRuntimes[0].council.record.report, /Original opinion/)
  service = new CouncilService(root, runtime)
  const replay = await service.start({ ...input, previewDigest: preview.previewDigest })
  assert.equal(replay.phase, 'completed'); assert.deepEqual({ sends, creates, workItems }, counter)
  assert.equal(replay.councilId, started.councilId)
  console.log('PASS restarted same-request start reads existing durable record before admission; zero replacement WorkItems, children or sends')

  let deleted = 0, kept = 0
  const reconcile = method('src/main/sessionManager.ts', 'SessionManager', 'reconcileTaskSnapshots', {
    mapWithConcurrencyInOrder: async (items, concurrency, action) => Promise.all(items.map(action)), TASK_SNAPSHOT_RECONCILIATION_CONCURRENCY: 1,
    isInteractiveOperationSnapshot: () => false,
    reconcileSnapshotWithReceipts: (snapshot) => ({ snapshot, terminalRun: snapshot.run }),
    reconcileExistingPersistedTaskSnapshot: async (snapshot) => { kept++; return snapshot },
    deleteTaskSnapshot: async () => { deleted++ }
  })
  const snapshots = await reconcile.call({ sessions: new Map(), dagFinalizationCoordinator: { hasIncomplete: () => false }, workflow: { bindSnapshot: async () => undefined } }, [completed])
  assert.equal(snapshots.length, 1); assert.equal(kept, 1); assert.equal(deleted, 0)
  console.log('PASS real startup terminal reconciliation preserves parent Council snapshot, opinions and budget binding')

  const terminalCleanup = method('src/main/sessionManager.ts', 'SessionManager', 'persistBindAndDeleteActiveTaskSnapshot', { deleteTaskSnapshot: async () => { deleted++ } })
  await terminalCleanup.call({ writeTaskSnapshot: async () => undefined, council: service, taskRuns: new Map() }, 'parent', 'shutdown', 0)
  assert.equal(deleted, 0)
  metas.clear()
  const history = await service.get({ sessionId: 'parent' })
  assert.equal(history.history[0].phase, 'completed')
  assert.match(history.history[0].report, /Original opinion/)
  console.log('PASS terminal cleanup barrier and closed-parent read preserve the archived original opinions')
  console.log('Council durable lifecycle checks: 3/3 passed; no Provider calls.')
} finally { rmSync(root, { recursive: true, force: true }) }
