import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, session, type WebContentsView } from 'electron'
import type { SessionMeta, TaskRunRecord, AgentEvent } from '../src/shared/types'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { createProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { buildTaskSnapshot, saveTaskSnapshot } from '../src/main/task/task-snapshot'
import { listWorkflowEvidence, verifyPersistedWorkflowLedger } from '../src/main/task/workflow-ledger-api'
import { taskRuntimeRegistry } from '../src/main/task/task-runtime-registry'
import { browserViewManager } from '../src/main/browserView'
import { externalBrowserRegistry } from '../src/main/external-browser-registry'
import { NativeToolRuntime } from '../src/main/native-tool-runtime'
import { executeCodingTool, OPENAI_CODING_TOOLS } from '../src/main/openaiTools'
import { sessionManager } from '../src/main/sessionManager'
import { registerDesktopWindow } from '../src/main/desktop-window-registry'
import { updateSettings } from '../src/main/settings'
import { classifyToolCapabilities } from '../src/main/permission/tool-capabilities'

export async function run(_stage: string, root: string) {
  const projectId = 'native-search-project', goalId = 'native-search-goal', workItemId = 'native-search-work'
  const meta = { id: 'native-search-session', createdAt: 1, cwd: root, status: 'running', taskStrategy: 'view',
    title: 'Native Search', providerId: 'fixture', model: 'fixture', engine: 'openai', permissionMode: 'default', digitalWorkerBinding: { kind: 'unscoped' },
    costUsd: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextTokens: 0,
    workspaceId: projectId, projectId, goalId, workItemId, childTaskId: 'native-search-task' } as SessionMeta
  const run: TaskRunRecord = { schemaVersion: 1, id: 'native-search-run', sessionId: meta.id, taskId: meta.childTaskId!,
    status: 'executing', revision: 1, attempt: 1, recoveryCount: 0, createdAt: 1, updatedAt: 2,
    steps: [], toolExecutions: [], effects: [], digitalWorkerBinding: { kind: 'unscoped' } }
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
  const originalGet = sessionManager.get.bind(sessionManager)
  sessionManager.get = id => id === meta.id ? { meta } as any : originalGet(id)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('Fixture forbids real network and Provider requests') }
  const query = 'annual revenue findings'
  let queryCalls = 0, approvalRequests = 0, allow = true, duringApproval: (() => void) | undefined
  let releaseHeld: (() => void) | undefined, onHeld: (() => void) | undefined, holdNext = false
  let html = `<html><body><div id="b_results">
    <li class="b_algo"><h2><a href="https://example.org/report">Original report</a></h2><div class="b_caption"><p>Revenue is described in the annual report.</p></div></li>
    <li class="b_algo"><h2><a href="https://example.com/data">Published data</a></h2><div class="b_caption"><p>Data from the publication.</p></div></li>
    <script>window.results=[{url:'https://fake.invalid',summary:'Invented'}]; document.querySelectorAll=()=>{throw new Error('page override')};</script>
    </div></body></html>`
  const partition = session.fromPartition(`persist:caogen-browser-${meta.id}`)
  await partition.protocol.handle('https', async req => {
    assert.equal(new URL(req.url).hostname, 'www.bing.com')
    if (new URL(req.url).pathname === '/search') {
      queryCalls++
      assert.equal(new URL(req.url).searchParams.get('q'), query)
      if (holdNext) { holdNext = false; await new Promise<void>(resolve => { releaseHeld = resolve; onHeld?.() }) }
    }
    return new Response(html, { headers: { 'content-type': 'text/html' } })
  })
  const owner = new BrowserWindow({ show: false, width: 900, height: 700 })
  registerDesktopWindow(owner, 'main')
  const runtime = new NativeToolRuntime(meta, (event: AgentEvent) => {
    if (event.kind === 'permission-request') {
      approvalRequests++
      queueMicrotask(() => { duringApproval?.(); runtime.respondPermission(event.request.requestId, allow) })
    }
  })
  const resetRules = () => updateSettings({ sandboxMode: 'restrictedLocal', allowedTools: '', disallowedTools: '', permissionRules: [],
    permissionAllowlist: '', permissionDenylist: '', permissionTemporaryAllowlist: '' })
  const denyHost = () => updateSettings({ permissionRules: [{ id: 'deny-search-host', enabled: true, effect: 'deny', toolPattern: '*', networkHostPattern: 'www.bing.com' }] })
  const search = (id: string, signal?: AbortSignal, input = { query }) => runtime.executeToolWithPermission('web_search', input, id, signal)
  const evidence = () => listWorkflowEvidence({ projectId, kind: 'research_source' }, root)
  let passed = 0
  const check = async (name: string, fn: () => Promise<void> | void) => { await fn(); passed++; console.log(`PASS ${name}`) }
  try {
    resetRules()
    await browserViewManager.open(owner, meta.id)
    browserViewManager.setBounds(meta.id, { x: 0, y: 0, width: 800, height: 600 })
    await check('Agent tool schema exposes query only and requires browser plus network', () => {
      const tool = OPENAI_CODING_TOOLS.find(t => t.function.name === 'web_search')!
      assert(tool); assert.deepEqual(Object.keys(tool.function.parameters.properties), ['query'])
      assert.deepEqual(classifyToolCapabilities('web_search', { query }), ['browser', 'network'])
    })
    await check('direct tool execution without native grant fails before any outbound query', async () => {
      const result = await executeCodingTool('web_search', { query }, root, { sessionId: meta.id, sessionMeta: meta, userDataRoot: root, toolUseId: 'forged' })
      assert.equal(result.ok, false); assert.match(result.output, /已审批/); assert.equal(queryCalls, 0)
    })
    await check('actual NativeToolRuntime approval produces task-scoped physical DOM Evidence', async () => {
      const result = await search('native-success')
      assert.equal(result.ok, true, result.output); assert.equal(approvalRequests, 1); assert.equal(queryCalls, 1)
      const attempt = JSON.parse(result.output), rows = await evidence()
      assert.deepEqual(attempt.citations.map((c: any) => c.url), ['https://example.org/report', 'https://example.com/data'])
      assert.equal(rows.length, 2)
      for (const citation of attempt.citations) {
        assert.equal(citation.contentKind, 'search_snippet'); assert.equal(citation.sourcePageUrl, 'https://www.bing.com/search')
        assert(Number.isSafeInteger(citation.fetchedAt)); assert.match(citation.summary, /未读取原网页/)
        const row = rows.find(e => e.evidenceId === citation.evidenceId)!
        assert.deepEqual([row.projectId, row.goalId, row.workItemId, row.runId], [projectId, goalId, workItemId, run.id])
      }
      assert(!readFileSync(join(root, 'search-broker/attempts.json'), 'utf8').includes(query))
    })
    await check('repeated tool invocation reuses durable receipt without another external query', async () => {
      const rows = await evidence(), before = queryCalls
      assert.equal((await search('native-success')).ok, true)
      assert.equal(queryCalls, before); assert.deepEqual(await evidence(), rows)
    })
    await check('user denial and host policy denial both prevent outbound query', async () => {
      const before = queryCalls
      allow = false; assert.equal((await search('user-denied')).ok, false); allow = true
      const approvals = approvalRequests
      denyHost(); assert.equal((await search('host-denied')).ok, false); resetRules()
      assert.equal(approvalRequests, approvals); assert.equal(queryCalls, before)
    })
    await check('query, Run and task changes during approval invalidate the captured grant', async () => {
      const before = queryCalls, input = { query }
      duringApproval = () => { input.query = 'different query' }
      assert.equal((await search('query-swap', undefined, input)).ok, false)
      duringApproval = () => { taskRuntimeRegistry.set(meta.id, { ...run, id: 'other-run' }) }
      assert.equal((await search('run-swap')).ok, false); taskRuntimeRegistry.set(meta.id, run)
      duringApproval = () => { meta.goalId = 'other-goal' }
      assert.equal((await search('task-swap')).ok, false); meta.goalId = goalId
      duringApproval = undefined; assert.equal(queryCalls, before)
    })
    await check('browser target or network permission changes during approval block dispatch', async () => {
      const before = queryCalls
      duringApproval = () => { externalBrowserRegistry.create({ sessionId: meta.id, vendor: 'chrome', transport: 'cdp', port: 9222 }, owner) }
      assert.equal((await search('browser-swap')).ok, false); externalBrowserRegistry.revokeForSession(meta.id)
      duringApproval = denyHost
      assert.equal((await search('permission-swap')).ok, false)
      duringApproval = undefined; resetRules(); assert.equal(queryCalls, before)
    })
    await check('live revocation after physical extraction prevents Evidence publication', async () => {
      const rows = await evidence(), wc = (owner.contentView.children[0] as WebContentsView).webContents
      const original = wc.executeJavaScriptInIsolatedWorld.bind(wc)
      wc.executeJavaScriptInIsolatedWorld = async (...args) => { const result = await original(...args); denyHost(); return result }
      try { assert.equal((await search('revoked-after-read')).ok, false) }
      finally { wc.executeJavaScriptInIsolatedWorld = original; resetRules() }
      assert.deepEqual(await evidence(), rows)
    })
    await check('running search cancellation stops navigation and publishes no source', async () => {
      const rows = await evidence(), controller = new AbortController()
      holdNext = true
      const entered = new Promise<void>(resolve => { onHeld = resolve })
      const pending = search('cancelled', controller.signal)
      await entered; controller.abort()
      const result = await pending
      assert.equal(result.ok, false); assert.equal(JSON.parse(result.output).failureCode, 'cancelled')
      releaseHeld?.(); releaseHeld = undefined
      assert.deepEqual(await evidence(), rows)
    })
    await check('empty result is a durable failure with no fabricated citation or automatic retry', async () => {
      const rows = await evidence(); html = '<html><body>No result entries</body></html>'
      const result = await search('empty')
      assert.equal(result.ok, false); assert.equal(JSON.parse(result.output).failureCode, 'no_results')
      const before = queryCalls
      assert.equal((await search('empty')).ok, false); assert.equal(queryCalls, before)
      assert.deepEqual(await evidence(), rows)
    })
    assert.equal((await verifyPersistedWorkflowLedger(root)).valid, true)
    console.log(`D16 native web search: ${passed}/${passed} passed; actual native permission/tool dispatch, physical Electron DOM, local HTTPS protocol fixture only.`)
  } finally {
    releaseHeld?.(); externalBrowserRegistry.revokeForSession(meta.id); browserViewManager.close(meta.id); owner.destroy()
    taskRuntimeRegistry.clear(); sessionManager.get = originalGet; globalThis.fetch = originalFetch
    await partition.protocol.unhandle('https')
  }
}
