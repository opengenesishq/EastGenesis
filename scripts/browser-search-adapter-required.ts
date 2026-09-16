import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, session, type WebContentsView } from 'electron'
import type { SessionMeta, TaskRunRecord } from '../src/shared/types'
import type { AssistantSearchRequest } from '../src/shared/assistant-search-types'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { createProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { buildTaskSnapshot, saveTaskSnapshot } from '../src/main/task/task-snapshot'
import { listWorkflowEvidence, listPersistedWorkflowLedger, verifyPersistedWorkflowLedger } from '../src/main/task/workflow-ledger-api'
import { taskRuntimeRegistry } from '../src/main/task/task-runtime-registry'
import { browserViewManager } from '../src/main/browserView'
import { createBrowserSearchAdapter } from '../src/main/search/browser-search-adapter'
import { SearchBroker, createSearchEvidenceBatchSink, searchRequestIdempotencyKey, SearchOperationError } from '../src/main/search/search-broker'

export async function run(_stage: string, root: string) {
  const projectId = 'search-project', goalId = 'search-goal', workItemId = 'search-work'
  const meta = { id: 'search-session', createdAt: 1, cwd: root, status: 'idle', taskStrategy: 'view',
    title: 'Search', providerId: 'fixture', model: 'fixture', engine: 'openai', permissionMode: 'default',
    costUsd: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextTokens: 0,
    workspaceId: projectId, projectId, goalId, workItemId, childTaskId: 'search-task' } as SessionMeta
  const run: TaskRunRecord = { schemaVersion: 1, id: 'search-run', sessionId: meta.id, taskId: meta.childTaskId!,
    status: 'executing', revision: 1, attempt: 1, recoveryCount: 0, createdAt: 1, updatedAt: 2,
    steps: [], toolExecutions: [], effects: [] }
  const workspace = await openProjectWorkspaceStore(root)
  await workspace.createWorkspace({ id: projectId, name: 'Search', kind: 'office' })
  const commands = createProjectWorkspaceCommandService(workspace, { rootDir: root })
  await commands.reconcileShadowProjection()
  await commands.createGoal({ id: goalId, projectId, title: 'Search', objective: 'Search actual sources', status: 'verifying' })
  await commands.createWorkItem({ id: workItemId, projectId, goalId, title: 'Search', type: 'planning', status: 'verifying' })
  await saveTaskSnapshot(buildTaskSnapshot({ meta, run, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created', now: 2 }), root)
  const item = await workspace.getWorkItem(workItemId)
  await commands.updateWorkItem(workItemId, { runRefs: [run.id] }, { expectedRevision: item!.revision })
  taskRuntimeRegistry.set(meta.id, run)
  const query = 'annual revenue findings'
  const request = (id: string): AssistantSearchRequest => ({ requestId: id, query, sessionId: meta.id,
    projectId, goalId, workItemId, runId: run.id, authorizationId: 'authorized-query', egress: 'allow' })
  let authorized = true, queryCalls = 0
  let releaseHeld: (() => void) | undefined
  let onHeld: (() => void) | undefined
  let holdNext = false
  let html = `<html><body><div id="b_results">
    <li class="b_algo"><h2><a href="https://example.org/report">Original report</a></h2><div class="b_caption"><p>Revenue is described in the annual report.</p></div></li>
    <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1${Buffer.from('https://example.com/data').toString('base64url')}">Published data</a></h2><div class="b_caption"><p>Data from the publication.</p></div></li>
    <li class="b_algo"><h2><a href="javascript:alert(1)">Unsafe link</a></h2><div class="b_caption"><p>Excluded unsafe scheme.</p></div></li>
    <li class="b_algo" hidden><h2><a href="https://example.org/hidden">Hidden</a></h2><div class="b_caption"><p>Not shown.</p></div></li>
    <script>window.results=[{url:'https://fake.invalid',summary:'Invented'}]; document.querySelectorAll=()=>{throw new Error('page override')};</script>
    </div></body></html>`
  const partition = session.fromPartition('persist:caogen-browser-search-session')
  await partition.protocol.handle('https', async req => {
    if (new URL(req.url).pathname === '/search') {
      queryCalls++
      assert.equal(new URL(req.url).searchParams.get('q'), query)
      if (holdNext) {
        holdNext = false
        await new Promise<void>(resolve => { releaseHeld = resolve; onHeld?.() })
      }
    }
    return new Response(html, { headers: { 'content-type': 'text/html' } })
  })
  const owner = new BrowserWindow({ show: false, width: 900, height: 700 })
  const adapter = createBrowserSearchAdapter({ rootDir: root, resolveSession: () => ({ meta, runId: run.id }),
    assertAuthorized: req => {
      if (!authorized || req.authorizationId !== 'authorized-query' || req.query !== query) throw new SearchOperationError('egress_denied', 'No query receipt')
    } })
  const brokerFor = (timeout = 3000) => new SearchBroker({ rootDir: root, adapters: [adapter], adapterTimeoutMs: timeout,
    recordEvidenceBatch: createSearchEvidenceBatchSink(root) })
  const broker = brokerFor()
  const evidence = () => listWorkflowEvidence({ projectId, kind: 'research_source' }, root)
  let passed = 0
  const check = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`PASS ${name}`) }
  try {
    await browserViewManager.open(owner, meta.id, 'https://www.bing.com/fixture')
    browserViewManager.setBounds(meta.id, { x: 0, y: 0, width: 800, height: 600 })
    const accepts = (await listPersistedWorkflowLedger({ projectId }, root)).acceptances.items
    await check('explicitly authorized physical search DOM produces snippet Evidence in the original task', async () => {
      const result = await broker.search(request('success'))
      assert.equal(result.status, 'succeeded')
      assert.equal(result.adapterKind, 'browser_fallback')
      assert.deepEqual(result.citations.map(c => c.url), ['https://example.org/report', 'https://example.com/data'])
      const rows = await evidence()
      assert.equal(rows.length, 2)
      for (const citation of result.citations) {
        assert.equal(citation.contentKind, 'search_snippet')
        assert.equal(citation.sourcePageUrl, 'https://www.bing.com/search')
        assert.equal(citation.contentDigest, `sha256:${createHash('sha256').update(citation.summary).digest('hex')}`)
        assert.match(citation.summary, /未读取原网页/)
        const row = rows.find(e => e.evidenceId === citation.evidenceId)!
        assert.deepEqual([row.projectId, row.goalId, row.workItemId, row.runId], [projectId, goalId, workItemId, run.id])
        assert.equal(row.metadata?.contentKind, 'search_snippet')
        assert.equal(row.contentDigest, citation.contentDigest.slice(7))
      }
      assert.deepEqual((await listPersistedWorkflowLedger({ projectId }, root)).acceptances.items, accepts)
      assert(!readFileSync(join(root, 'search-broker/attempts.json'), 'utf8').includes(query))
    })
    await check('same request returns durable receipt without repeating the external query', async () => {
      const before = queryCalls, rows = await evidence()
      assert.equal((await broker.search(request('success'))).status, 'succeeded')
      assert.equal(queryCalls, before)
      assert.deepEqual(await evidence(), rows)
    })
    await check('missing consent, revoked consent and cross-task requests fail before query dispatch', async () => {
      const before = queryCalls, rows = await evidence()
      assert.equal((await broker.search({ ...request('no-consent'), authorizationId: undefined })).failureCode, 'egress_denied')
      authorized = false
      assert.equal((await broker.search(request('revoked'))).failureCode, 'egress_denied')
      authorized = true
      assert.equal((await broker.search({ ...request('wrong'), workItemId: 'other' })).failureCode, 'scope_denied')
      assert.equal(queryCalls, before)
      assert.deepEqual(await evidence(), rows)
    })
    await check('cancellation aborts a physical pending navigation and never publishes or replays its query', async () => {
      const rows = await evidence(), req = request('cancelled')
      holdNext = true
      const entered = new Promise<void>(resolve => { onHeld = resolve })
      const pending = broker.search(req)
      await entered
      assert.equal(broker.cancelAttempt(searchRequestIdempotencyKey(req)), true)
      assert.equal((await pending).failureCode, 'cancelled')
      releaseHeld?.(); releaseHeld = undefined
      const calls = queryCalls
      assert.equal((await broker.search(req)).failureCode, 'cancelled')
      assert.equal(queryCalls, calls)
      assert.deepEqual(await evidence(), rows)
    })
    await check('adapter timeout cancels navigation and leaves a durable non-replaying failure', async () => {
      const rows = await evidence(), req = request('timed-out'), timed = brokerFor(500)
      holdNext = true
      const entered = new Promise<void>(resolve => { onHeld = resolve })
      const pending = timed.search(req)
      await entered
      assert.equal((await pending).failureCode, 'timeout')
      releaseHeld?.(); releaseHeld = undefined
      const calls = queryCalls
      assert.equal((await timed.search(req)).failureCode, 'timeout')
      assert.equal(queryCalls, calls)
      assert.deepEqual(await evidence(), rows)
    })
    await check('same-URL replacement or live task change during extraction cannot register sources', async () => {
      const rows = await evidence()
      const wc = (owner.contentView.children[0] as WebContentsView).webContents
      const original = wc.executeJavaScriptInIsolatedWorld.bind(wc)
      wc.executeJavaScriptInIsolatedWorld = async (...args) => { const result = await original(...args); await wc.loadURL(wc.getURL()); return result }
      try { assert.equal((await broker.search(request('reload-race'))).status, 'failed') }
      finally { wc.executeJavaScriptInIsolatedWorld = original }
      wc.executeJavaScriptInIsolatedWorld = async (...args) => { const result = await original(...args); meta.cwd = 'changed'; return result }
      try { assert.equal((await broker.search(request('task-race'))).failureCode, 'scope_denied') }
      finally { wc.executeJavaScriptInIsolatedWorld = original; meta.cwd = root }
      assert.deepEqual(await evidence(), rows)
    })
    await check('empty/challenge page returns no_results without fabricating sources', async () => {
      const rows = await evidence()
      html = '<html><body>Search challenge; no actual result elements.</body></html>'
      assert.equal((await broker.search(request('empty'))).failureCode, 'no_results')
      assert.deepEqual(await evidence(), rows)
    })
    await check('interrupted and corrupt receipts fail closed without dispatching another query', async () => {
      const path = join(root, 'search-broker/attempts.json'), beforeCalls = queryCalls
      const doc = JSON.parse(readFileSync(path, 'utf8'))
      const req = request('crash'), key = searchRequestIdempotencyKey(req)
      doc.attempts.push({ ...doc.attempts[0], requestId: req.requestId, idempotencyKey: key, attemptId: `search:${key}`, status: 'running', citations: [], evidenceIds: [] })
      writeFileSync(path, JSON.stringify(doc))
      assert.equal((await brokerFor().search(req)).failureCode, 'unknown')
      const valid = readFileSync(path, 'utf8')
      writeFileSync(path, '{broken')
      try { await assert.rejects(brokerFor().search(request('corrupt')), /cannot be replayed safely/) }
      finally { writeFileSync(path, valid) }
      assert.equal(queryCalls, beforeCalls)
    })
    assert.equal((await verifyPersistedWorkflowLedger(root)).valid, true)
    console.log(`Browser search adapter: ${passed}/${passed} passed; physical Electron DOM, local protocol only, no network or Provider calls.`)
  } finally {
    releaseHeld?.()
    browserViewManager.close(meta.id)
    owner.destroy()
    taskRuntimeRegistry.clear()
    await partition.protocol.unhandle('https')
  }
}
