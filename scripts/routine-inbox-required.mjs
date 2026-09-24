import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Module } from 'node:module'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'caogen-routine-inbox-')), runsRoot = join(root, 'routines')
mkdirSync(runsRoot)
const oldFetch = globalThis.fetch
globalThis.fetch = async () => { throw Error('Real network forbidden in routine inbox fixtures') }
let groups = 0
const pass = text => { groups++; console.log(`PASS ${text}`) }
try {
  const built = await build({ stdin: { contents: `export { RoutineInboxService } from './src/main/routines/routine-inbox-service'; export { listRoutineRuns } from './src/main/routines/routine-runner';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{ name: 'no-execution', setup(builder) {
      builder.onResolve({ filter: /(?:^|\/)routineStore$|^electron$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const listRoutines = () => { throw Error("Scheduler access forbidden") }; export const markRun = listRoutines; export const updateRoutine = listRoutines; export const app = { getPath: listRoutines };', loader: 'js' }))
    } }] })
  const filename = resolve('scripts/.routine-inbox-fixture.cjs'), loaded = new Module(filename)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(dirname(filename)); loaded._compile(built.outputFiles[0].text, filename)
  const { RoutineInboxService, listRoutineRuns } = loaded.exports
  const record = (id, patch = {}) => ({ id, routineId: 'plan-a', routineName: '每日客户汇报', projectId: 'project-a', goalId: 'goal-a', workItemId: 'item-a', projectCwd: '/fixture/project', startedAt: 1000,
    finishedAt: 2000, status: 'succeeded', inboxStatus: 'needs_review', dispatchState: 'prompt_accepted', sessionId: `session-${id}`, workflowRunId: `run-${id}`, resultText: `result ${id}`, ...patch })
  let records = Array.from({ length: 45 }, (_, i) => record(`occurrence-${i}`, { startedAt: 1000 + i, finishedAt: 3000 + i, routineId: i % 2 ? 'plan-b' : 'plan-a', projectId: i % 2 ? 'project-b' : 'project-a', ...(i === 3 ? { status: 'failed', inboxStatus: 'failed', error: 'fixture missing source' } : {}) }))
  const persist = () => writeFileSync(join(runsRoot, 'routine-runs.json'), JSON.stringify({ version: 1, runs: records }))
  persist()
  const metas = new Map(records.map(run => [run.sessionId, { id: run.sessionId, createdAt: run.startedAt + 1, cwd: run.projectCwd, workspaceId: run.projectId, goalId: run.goalId, workItemId: run.workItemId }]))
  const page = items => ({ items, total: items.length, hasMore: false })
  let ledgerMode = 'normal', calls = 0, clock = 5000
  const runtime = { runs: () => listRoutineRuns(runsRoot), meta: id => metas.get(id), ledger: async run => {
    calls++
    const canonical = { id: run.workflowRunId, sessionId: run.sessionId, projectId: run.projectId, goalId: run.goalId, workItemId: run.workItemId, status: 'completed', revision: 1, attempt: 1, taskRunDigest: 'fixture-digest' }
    if (ledgerMode === 'foreign') canonical.sessionId = 'another-task'
    if (ledgerMode === 'throws') throw Error('database unavailable')
    if (ledgerMode === 'mutates') { records = records.map(item => item.id === run.id ? { ...item, error: 'new error after initial read' } : item); persist() }
    return { goals: page([]), runs: page(ledgerMode === 'missing' ? [] : [canonical]), workItems: page([{ id: run.workItemId, projectId: run.projectId }]),
      artifacts: page([{ id: 'artifact-current', projectId: run.projectId, runId: run.workflowRunId }, { id: 'artifact-other', projectId: run.projectId, runId: 'another-run' }]),
      acceptances: page([{ id: 'acceptance-current', workItemId: run.workItemId, projectId: run.projectId }]),
      evidenceLinks: page([{ id: 'evidence-current', runId: run.workflowRunId, projectId: run.projectId }]), events: page([]) }
  } }
  let service = new RoutineInboxService(root, runtime, () => clock)
  const first = await service.list(1), second = await service.list(1, { page: 2 }), last = await service.list(1, { page: 3 })
  assert.equal(first.total, 45); assert.equal(first.items.length, 20); assert(first.hasMore)
  assert.equal(second.items.length, 20); assert.equal(last.items.length, 5); assert.equal(last.hasMore, false)
  assert.equal(new Set([...first.items, ...second.items, ...last.items].map(item => item.run.id)).size, 45)
  assert.equal((await service.list(1, { routineId: 'plan-a', projectId: 'project-a' })).total, 23)
  assert.equal((await service.list(1, { status: 'failed', query: 'missing source' })).items[0].run.id, 'occurrence-3')
  assert.equal((await service.list(1, { query: '每日客户' })).total, 45)
  assert.equal((await service.list(1, { page: 99 })).page, 3)
  await assert.rejects(service.list(1, { page: -1 }), /参数无效/)
  pass('real persisted run reader, all 45 occurrences reachable, exact plan/project/status/text filters and pagination')

  const newest = first.items[0]
  service.mark(1, { snapshotId: first.snapshotId, runIds: [newest.run.id], read: true })
  let refreshed = await service.list(1)
  assert.equal(refreshed.items[0].unread, false); assert.equal(refreshed.unreadCount, 44)
  service.mark(1, { snapshotId: refreshed.snapshotId, runIds: [newest.run.id], read: false })
  service.mark(1, { snapshotId: first.snapshotId, runIds: [newest.run.id], read: true })
  assert.equal((await service.list(1)).items[0].unread, true, 'stale read cannot undo newer explicit unread')
  refreshed = await service.list(1)
  records = records.map(run => run.id === newest.run.id ? { ...run, resultText: 'new result version' } : run); persist()
  service.mark(1, { snapshotId: refreshed.snapshotId, runIds: [newest.run.id], read: true })
  assert.equal((await service.list(1)).items[0].unread, true, 'old page cannot consume new source version')
  await assert.rejects(service.read(1, refreshed.snapshotId, newest.run.id), /已更新/)
  service = new RoutineInboxService(root, runtime, () => clock)
  assert.equal((await service.list(1)).unreadCount, 45, 'receipts survive service restart; changed result remains unread')
  pass('durable per-occurrence receipts preserve new result versions and concurrent explicit unread decisions')

  const a = record('heartbeat-a', { sessionId: 'original-task', startedAt: 6000, finishedAt: 7000, heartbeat: {
    target: { kind: 'existing_session', sessionId: 'original-task', sessionCreatedAt: 20, cwd: '/fixture/project', workspaceId: 'project-a', goalId: 'goal-a', workItemId: 'item-a' },
    scheduledAt: 6000, inputRequestId: 'heartbeat-a', messageId: 'session-input:original-task:heartbeat-a', prompt: 'Continue report', phase: 'accepted' } })
  const b = record('heartbeat-b', { ...a, id: 'heartbeat-b', workflowRunId: 'run-heartbeat-b', startedAt: 8000, finishedAt: 9000, heartbeat: { ...a.heartbeat, scheduledAt: 8000, inputRequestId: 'heartbeat-b', messageId: 'session-input:original-task:heartbeat-b' } })
  records.push(a,b); persist()
  metas.set('original-task', { id: 'original-task', createdAt: 20, cwd: '/fixture/project', workspaceId: 'project-a', goalId: 'goal-a', workItemId: 'item-a' })
  let scoped = await service.list(2, {}, 'original-task')
  assert.equal(scoped.total, 2)
  service.mark(2, { snapshotId: scoped.snapshotId, runIds: ['heartbeat-a'], read: true }, 'original-task')
  scoped = await service.list(2, {}, 'original-task')
  assert.equal(scoped.items.find(item => item.run.id === 'heartbeat-a').unread, false)
  assert.equal(scoped.items.find(item => item.run.id === 'heartbeat-b').unread, true)
  assert.throws(() => service.mark(1, { snapshotId: scoped.snapshotId, runIds: ['heartbeat-b'], read: true }), /不属于此窗口/)
  assert.throws(() => service.mark(2, { snapshotId: scoped.snapshotId, runIds: ['occurrence-0'], read: true }, 'original-task'), /不属于当前页/)
  await assert.rejects(service.read(2, scoped.snapshotId, 'heartbeat-b', 'foreign-task'), /不属于此窗口/)
  const target = await service.resolve(2, scoped.snapshotId, 'heartbeat-b', 'original-task')
  assert.equal(target.sessionCreatedAt, 20)
  metas.set('original-task', { ...metas.get('original-task'), createdAt: 21 })
  await assert.rejects(service.resolve(2, scoped.snapshotId, 'heartbeat-b', 'original-task'), /身份已变化/)
  metas.delete('original-task')
  const retained = await service.read(2, scoped.snapshotId, 'heartbeat-b', 'original-task')
  assert.equal(retained.detail.runs[0].id, 'run-heartbeat-b')
  pass('same-session heartbeat occurrences stay distinct; exact task identities and window scopes reject rebound or foreign navigation')

  let snapshot = await service.list(1), runId = snapshot.items[0].run.id
  let result = await service.read(1, snapshot.snapshotId, runId)
  assert.equal(result.detail.runs[0].id, records.find(run => run.id === runId).workflowRunId)
  assert.deepEqual(result.detail.artifacts.map(artifact => artifact.id), ['artifact-current'])
  ledgerMode = 'foreign'; result = await service.read(1, snapshot.snapshotId, runId)
  assert.equal(result.detail, undefined); assert.match(result.workflowIssue, /身份不匹配/)
  ledgerMode = 'missing'; result = await service.read(1, snapshot.snapshotId, runId)
  assert.equal(result.detail, undefined); assert(result.item.run.resultText)
  ledgerMode = 'throws'; result = await service.read(1, snapshot.snapshotId, runId)
  assert.match(result.workflowIssue, /暂时无法/); assert(result.item.run.resultText)
  ledgerMode = 'mutates'
  await assert.rejects(service.read(1, snapshot.snapshotId, runId), /已更新/)
  ledgerMode = 'normal'
  pass('exact Run and evidence selection, foreign/missing/unavailable ledger fallback, and change-during-read rejection')

  records.push(record('before-session-failure', { routineId: 'deleted-plan', routineName: '已删除计划的失败记录', sessionId: undefined, workflowRunId: undefined, projectId: undefined, goalId: undefined, workItemId: undefined, startedAt: 20000, finishedAt: 20001, status: 'failed', inboxStatus: 'failed', dispatchState: 'preparing', resultText: undefined, error: 'File missing before session creation' })); persist()
  snapshot = await service.list(1, { status: 'failed' })
  const beforeCalls = calls, beforeStore = readFileSync(join(runsRoot, 'routine-runs.json'), 'utf8')
  result = await service.read(1, snapshot.snapshotId, 'before-session-failure')
  assert.equal(result.item.run.error, 'File missing before session creation'); assert.equal(result.detail, undefined); assert.match(result.workflowIssue, /尚未生成 Run/)
  assert.equal(calls, beforeCalls, 'no invented Run read')
  service.mark(1, { snapshotId: snapshot.snapshotId, runIds: ['before-session-failure'], read: true })
  assert.equal(readFileSync(join(runsRoot, 'routine-runs.json'), 'utf8'), beforeStore, 'reading does not edit acceptance, scheduler state, or run store')
  await assert.rejects(service.resolve(1, snapshot.snapshotId, 'before-session-failure'), /原任务已移除/)
  clock += 11*60_000
  assert.throws(() => service.mark(1, { snapshotId: snapshot.snapshotId, runIds: [], read: true }), /已过期/)
  pass('no-session/no-Run failures remain visible after plan removal; read-only access never executes or alters acceptance')
  console.log(`PASS ${groups} routine inbox groups`)
} finally { globalThis.fetch = oldFetch; rmSync(root, { recursive: true, force: true }) }
