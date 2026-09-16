import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { BrowserWindow, session, type WebContentsView } from 'electron'
import type { SessionMeta, TaskRunRecord } from '../src/shared/types'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { createProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { createProductionProjectAggregateService } from '../src/main/project-aggregate'
import { buildTaskSnapshot, saveTaskSnapshot } from '../src/main/task/task-snapshot'
import { listWorkflowEvidence, listPersistedWorkflowLedger, verifyPersistedWorkflowLedger } from '../src/main/task/workflow-ledger-api'
import { taskRuntimeRegistry } from '../src/main/task/task-runtime-registry'
import { browserViewManager } from '../src/main/browserView'
import { executeBrowserTool, BROWSER_TOOLS } from '../src/main/agent/tools/browser-tools'
import { readSessionBrowserResearchSource } from '../src/main/task/browser-research-source'
import { BROWSER_PAGE_TEXT_LIMIT, type BrowserPageSource } from '../src/main/browser/browser-page-source'
import { buildStudioResultSnapshot } from '../src/main/studio-result/studio-result-service'
import { decideTaskStrategyTool } from '../src/main/task/task-strategy'
import { isReadOnlyToolCall, isSideEffectingToolCall } from '../src/main/task/tool-idempotency'
import { isLimitedFileExecutionReadOnlyCall } from '../src/main/permission/limited-file-execution-policy'
import { classifyToolCapabilities } from '../src/main/permission/tool-capabilities'
import { buildEffectDescriptor } from '../src/main/task/effect-reconciler'
import { prepareEffectExecution, markEffectExecutionStarted, completeEffectExecution } from '../src/main/task/effect-runtime'

export async function run(_stage: string, root: string) {
  const projectId = 'research-project', goalId = 'research-goal', workItemId = 'research-work'
  const meta = { id: 'research-session', createdAt: 1, cwd: root, status: 'idle', taskStrategy: 'view',
    title: 'Research', providerId: 'fixture', model: 'fixture', engine: 'openai', permissionMode: 'default',
    costUsd: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextTokens: 0,
    workspaceId: projectId, projectId, goalId, workItemId, childTaskId: 'research-task' } as SessionMeta
  const run: TaskRunRecord = { schemaVersion: 1, id: 'research-run', sessionId: meta.id, taskId: meta.childTaskId!,
    status: 'executing', revision: 1, attempt: 1, recoveryCount: 0, createdAt: 1, updatedAt: 2,
    steps: [], toolExecutions: [], effects: [] }
  const workspace = await openProjectWorkspaceStore(root)
  await workspace.createWorkspace({ id: projectId, name: 'Research', kind: 'office' })
  const commands = createProjectWorkspaceCommandService(workspace, { rootDir: root })
  await commands.reconcileShadowProjection()
  await commands.createGoal({ id: goalId, projectId, title: 'Research', objective: 'Read actual sources', status: 'verifying' })
  await commands.createWorkItem({ id: workItemId, projectId, goalId, title: 'Research', type: 'planning', status: 'verifying' })
  await saveTaskSnapshot(buildTaskSnapshot({ meta, run, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created', now: 2 }), root)
  const item = await workspace.getWorkItem(workItemId)
  await commands.updateWorkItem(workItemId, { runRefs: [run.id] }, { expectedRevision: item!.revision })
  taskRuntimeRegistry.set(meta.id, run)
  const pageUrl = 'https://research.invalid/source'
  let html = `<html><title>Rendered source</title><body><h1>Annual figures</h1><p>Revenue increased by 12 percent.</p>
    <p hidden>HIDDEN TEXT</p><p style="display:none">INVISIBLE TEXT</p>
    <input value="FORM VALUE"><textarea>TEXTAREA VALUE</textarea><div contenteditable>EDITABLE VALUE</div>
    <iframe srcdoc="<p>FRAME TEXT</p>"></iframe><p>password=do-not-export-value</p>
    <p><span>password=</span><span>split-dom-value</span></p>
    <script>document.createTreeWalker = () => { throw new Error('page override'); };</script></body></html>`
  const partition = session.fromPartition('persist:caogen-browser-research-session')
  // Every HTTPS request is answered in-process with fixture HTML; no network transport is used.
  await partition.protocol.handle('https', () => new Response(html, { headers: { 'content-type': 'text/html' } }))
  const owner = new BrowserWindow({ show: false, width: 900, height: 700 })
  let passed = 0
  const check = async (name: string, fn: () => Promise<void> | void) => { await fn(); passed++; console.log(`PASS ${name}`) }
  const context = (toolUseId: string) => ({ sessionMeta: meta, userDataRoot: root, toolUseId })
  const evidence = () => listWorkflowEvidence({ projectId, kind: 'research_source' }, root)
  const call = async (toolUseId: string) => JSON.parse((await executeBrowserTool('browser_read', {}, meta.id, context(toolUseId))).output)
  const acceptsBefore = (await listPersistedWorkflowLedger({ projectId }, root)).acceptances.items
  try {
    await browserViewManager.open(owner, meta.id, pageUrl)
    browserViewManager.setBounds(meta.id, { x: 0, y: 0, width: 800, height: 600 })
    let source: BrowserPageSource & { evidenceId: string; contentDigest: string }
    await check('physical main-frame text enters original canonical Evidence and result page without auto acceptance', async () => {
      source = await call('read-1')
      assert.equal(source.url, pageUrl)
      assert(source.text.includes('Revenue increased by 12 percent.'))
      for (const excluded of ['HIDDEN TEXT', 'INVISIBLE TEXT', 'FORM VALUE', 'TEXTAREA VALUE', 'EDITABLE VALUE', 'FRAME TEXT', 'do-not-export-value', 'split-dom-value']) assert(!source.text.includes(excluded))
      assert.equal(source.filtered, true)
      assert.equal(source.contentDigest, createHash('sha256').update(source.text).digest('hex'))
      const rows = await evidence()
      assert.equal(rows.length, 1)
      assert.deepEqual([rows[0].projectId, rows[0].goalId, rows[0].workItemId, rows[0].runId], [projectId, goalId, workItemId, run.id])
      assert.equal(rows[0].uri, pageUrl)
      assert.equal(rows[0].contentDigest, source.contentDigest)
      const snapshot = buildStudioResultSnapshot(meta, await createProductionProjectAggregateService(root).verifyLiveProject(projectId))
      assert.equal(snapshot.evidence.find(entry => entry.id === source.evidenceId)?.sourceUri, pageUrl)
      assert.deepEqual((await listPersistedWorkflowLedger({ projectId }, root)).acceptances.items, acceptsBefore)
    })
    await check('same invocation replay preserves one immutable source; conflicting content is rejected', async () => {
      const original = await evidence()
      assert.equal((await call('read-1')).observedAt, source!.observedAt)
      assert.deepEqual(await evidence(), original)
      await assert.rejects(readSessionBrowserResearchSource(context('read-1'), async () => ({ ...source!, text: 'Different bytes' })), /different immutable content/)
      assert.deepEqual(await evidence(), original)
    })
    await check('capture limits are explicit and digest matches only returned partial text', async () => {
      html = `<html><title>Long source</title><body><p>${'Evidence '.repeat(4000)}</p></body></html>`
      await browserViewManager.navigate(meta.id, pageUrl)
      const partial = await call('read-2')
      assert.equal(partial.truncated, true)
      assert(partial.text.length <= BROWSER_PAGE_TEXT_LIMIT)
      assert.equal(partial.contentDigest, createHash('sha256').update(partial.text).digest('hex'))
      const row = (await evidence()).find(entry => entry.evidenceId === partial.evidenceId)!
      assert.equal(row.metadata?.truncated, true)
      assert.equal(row.metadata?.textLimit, BROWSER_PAGE_TEXT_LIMIT)
      assert.match(row.summary!, /部分正文/)
    })
    await check('same-URL document replacement during physical read cannot mix sources', async () => {
      const wc = (owner.contentView.children[0] as WebContentsView).webContents
      const original = wc.executeJavaScriptInIsolatedWorld.bind(wc)
      wc.executeJavaScriptInIsolatedWorld = async (...args) => {
        const result = await original(...args)
        await wc.loadURL(pageUrl)
        return result
      }
      const before = await evidence()
      try { await assert.rejects(call('reload-race'), /BROWSER_SOURCE_CHANGED/) }
      finally { wc.executeJavaScriptInIsolatedWorld = original }
      assert.deepEqual(await evidence(), before)
    })
    await check('private locators, blank pages, failed reads and wrong sessions leave no source evidence', async () => {
      const before = await evidence()
      await assert.rejects(readSessionBrowserResearchSource(context('failed'), async () => { throw new Error('fixture read failure') }), /fixture read failure/)
      await assert.rejects(readSessionBrowserResearchSource(context('file'), async () => ({ ...source!, url: 'file:///tmp/local.html' })), /BROWSER_SOURCE_URL/)
      await assert.rejects(readSessionBrowserResearchSource(context('private'), async () => ({ ...source!, url: `${pageUrl}?access_token=do-not-export-value` })), /secret-free/)
      html = '<html><body><input value="only field"></body></html>'
      await browserViewManager.navigate(meta.id, pageUrl)
      await assert.rejects(call('blank'), /BROWSER_SOURCE_EMPTY/)
      await assert.rejects(executeBrowserTool('browser_read', {}, 'other-session', context('wrong')), /BROWSER_SOURCE_SCOPE/)
      await assert.rejects(executeBrowserTool('browser_read', { url: pageUrl }, meta.id, context('args')), /不接受/)
      assert.deepEqual(await evidence(), before)
    })
    await check('scope change, run switch and cancellation during read cannot write to stale tasks', async () => {
      const before = await evidence()
      for (const key of ['cwd', 'goalId', 'workItemId', 'workspaceId'] as const) {
        const old = meta[key]
        try { await assert.rejects(readSessionBrowserResearchSource(context(`changed-${key}`), async () => { meta[key] = 'other'; return source! }), /BROWSER_SOURCE_SCOPE/) }
        finally { meta[key] = old }
      }
      try { await assert.rejects(readSessionBrowserResearchSource(context('changed-run'), async () => {
        taskRuntimeRegistry.set(meta.id, { ...run, id: 'different-run' }); return source!
      }), /BROWSER_SOURCE_SCOPE/) } finally { taskRuntimeRegistry.set(meta.id, run) }
      const controller = new AbortController()
      await assert.rejects(readSessionBrowserResearchSource({ ...context('abort'), signal: controller.signal }, async () => {
        controller.abort(); return source!
      }), /BROWSER_SOURCE_CANCELLED/)
      assert.deepEqual(await evidence(), before)
    })
    await check('tool admission inherits view, plan, limited-read and browser/network capability gates', () => {
      assert(BROWSER_TOOLS.some(tool => tool.function.name === 'browser_read'))
      for (const strategy of ['view', 'plan', 'execute']) assert.equal(decideTaskStrategyTool(strategy, 'browser_read', {}).allow, true)
      assert.equal(isReadOnlyToolCall('browser_read', {}), true)
      assert.equal(isSideEffectingToolCall('browser_read', {}), false)
      assert.equal(isLimitedFileExecutionReadOnlyCall('browser_read', {}), true)
      assert.deepEqual(classifyToolCapabilities('browser_read', {}), ['browser', 'network'])
    })
    const browserInput = (toolName: string, toolInput: Record<string, unknown>, toolUseId: string) => ({
      sessionId: meta.id, cwd: root, rootDir: root, toolName, toolInput, toolUseId
    })
    const descriptor = (toolName: string, toolInput: Record<string, unknown>) => buildEffectDescriptor(browserInput(toolName, toolInput, 'descriptor'))
    const wc = (owner.contentView.children[0] as WebContentsView).webContents
    const loaded = async () => {
      if (wc.isLoadingMainFrame()) await new Promise<void>(resolve => wc.once('did-stop-loading', () => resolve()))
    }
    html = '<html><body data-clicks="0"><input id="recipient"><button id="send" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks)+1)">Send</button></body></html>'
    await browserViewManager.navigate(meta.id, pageUrl)
    await loaded()
    await check('browser approval binds one page; same-URL replacement abandons its prepared effect', async () => {
      const input = browserInput('browser_click', { selector: '#send' }, 'approved-before-reload')
      const handle = await prepareEffectExecution(input)
      assert(handle)
      const approved = taskRuntimeRegistry.get(meta.id)!.effects!.find(effect => effect.id === handle.effectId)!
      assert.equal(approved.target.kind, 'unsupported')
      assert(approved.target.kind === 'unsupported' && approved.target.browserPage)
      assert(!JSON.stringify(approved.target).includes(pageUrl), 'raw URL must not enter the effect target')
      await browserViewManager.navigate(meta.id, pageUrl)
      await loaded()
      await assert.rejects(markEffectExecutionStarted(handle, input), /目标或输入已变化/)
      assert.equal(taskRuntimeRegistry.get(meta.id)!.effects!.find(effect => effect.id === handle.effectId)!.status, 'abandoned')
      await assert.rejects(executeBrowserTool('browser_click', input.toolInput, meta.id, { ...context('stale-page'), effectTarget: approved.target }), /原审批失效/)
      assert.equal(await wc.executeJavaScript('document.body.dataset.clicks'), '0')
    })
    await check('approved click, typing and DOM script execute through their original opaque effect', async () => {
      for (const [toolName, toolInput] of [
        ['browser_click', { selector: '#send' }],
        ['browser_type', { selector: '#recipient', text: 'approved recipient' }],
        ['browser_evaluate', { script: "document.body.dataset.reviewed = 'yes'" }]
      ] as const) {
        const input = browserInput(toolName, toolInput, `execute-${toolName}`)
        const handle = await prepareEffectExecution(input)
        assert(handle)
        await markEffectExecutionStarted(handle, input)
        const effect = taskRuntimeRegistry.get(meta.id)!.effects!.find(effect => effect.id === handle.effectId)!
        const result = await executeBrowserTool(toolName, toolInput, meta.id, { ...context(input.toolUseId), effectTarget: effect.target })
        assert.equal(result.ok, true)
        assert.equal((await completeEffectExecution(handle, result))?.status, 'confirmed')
      }
      assert.equal(await wc.executeJavaScript('document.body.dataset.clicks'), '1')
      assert.equal(await wc.executeJavaScript('document.querySelector("#recipient").value'), 'approved recipient')
      assert.equal(await wc.executeJavaScript('document.body.dataset.reviewed'), 'yes')
      await assert.rejects(executeBrowserTool('browser_click', { selector: '#send' }, meta.id, context('unbound')), /缺少已审批的页面版本/)
    })
    await check('navigation after the main-process check is rejected inside the actual mutation script', async () => {
      const target = (await descriptor('browser_click', { selector: '#send' })).target
      const original = wc.executeJavaScriptInIsolatedWorld.bind(wc)
      wc.executeJavaScriptInIsolatedWorld = async (...args) => { await wc.loadURL(pageUrl); await loaded(); return original(...args) }
      try { await assert.rejects(executeBrowserTool('browser_click', { selector: '#send' }, meta.id, { ...context('action-race'), effectTarget: target }), /原审批失效|Script failed to execute/) }
      finally { wc.executeJavaScriptInIsolatedWorld = original }
      assert.equal(await wc.executeJavaScript('document.body.dataset.clicks'), '0')
    })
    await check('page-authored properties cannot forge the isolated document binding', async () => {
      const target = (await descriptor('browser_type', { selector: '#recipient', text: 'old page' })).target
      assert(target.kind === 'unsupported' && target.browserPage)
      const originalToken = target.browserPage.documentToken
      await wc.loadURL(pageUrl)
      await loaded()
      await wc.executeJavaScript(`window.__caogenApprovedDocumentV1=${JSON.stringify(originalToken)}`)
      const next = await browserViewManager.captureMutationPage(meta.id)
      assert.notEqual(next.documentToken, originalToken)
      await assert.rejects(executeBrowserTool('browser_type', { selector: '#recipient', text: 'old page' }, meta.id, { ...context('forged'), effectTarget: target }), /原审批失效/)
      assert.equal(await wc.executeJavaScript('document.querySelector("#recipient").value'), '')
    })
    const resetForm = async () => {
      html = `<html><body data-sent="0"><aside id="news">Unrelated headline</aside>
        <form id="compose" action="/send" method="post" onsubmit="event.preventDefault();document.body.dataset.sent=String(Number(document.body.dataset.sent)+1)"
          onformdata="document.body.dataset.previewSideEffect='unexpected'">
          <input id="recipient" name="recipient" value="approved@example.invalid">
          <input id="hidden" type="hidden" name="token" value="fixture-private-form-value">
          <input id="opt-in" type="checkbox" name="optIn" checked>
          <select id="delivery" name="delivery"><option value="draft">Draft</option><option value="publish">Publish</option></select>
          <button id="send" type="submit">Send</button></form>
        <label id="send-label" for="send">Send label outside form</label>
        <form id="unrelated"><input id="unrelated-field" name="other" value="unrelated"></form></body></html>`
      await browserViewManager.navigate(meta.id, pageUrl); await loaded()
    }
    const staleTarget = /原审批失效|Script failed to execute|目标或输入已变化/
    const assertNoSend = async () => assert.equal(await wc.executeJavaScript('document.body.dataset.sent'), '0')
    await check('approval freezes same-document form payload and persists only its digest', async () => {
      await resetForm()
      const input = browserInput('browser_click', { selector: '#send' }, 'form-payload-version')
      const handle = await prepareEffectExecution(input); assert(handle)
      const approved = taskRuntimeRegistry.get(meta.id)!.effects!.find(effect => effect.id === handle.effectId)!
      assert(approved.target.kind === 'unsupported' && approved.target.browserPage?.actionTarget?.stateDigest)
      assert(!JSON.stringify(approved).includes('fixture-private-form-value'))
      assert(!JSON.stringify(approved).includes('approved@example.invalid'))
      assert.equal(await wc.executeJavaScript('document.body.dataset.previewSideEffect'), undefined)
      await wc.executeJavaScript('document.querySelector("#hidden").value="different-secret"')
      await assert.rejects(markEffectExecutionStarted(handle, input), staleTarget)
      assert.equal(taskRuntimeRegistry.get(meta.id)!.effects!.find(effect => effect.id === handle.effectId)!.status, 'abandoned')
      await assert.rejects(executeBrowserTool('browser_click', input.toolInput, meta.id, { ...context('changed-hidden'), effectTarget: approved.target }), staleTarget)
      await assertNoSend()
    })
    await check('identical replacement nodes and changed form destination require fresh approval', async () => {
      for (const mutation of [
        'document.querySelector("#send").replaceWith(document.querySelector("#send").cloneNode(true))',
        'document.querySelector("#recipient").replaceWith(document.querySelector("#recipient").cloneNode(true))',
        'document.querySelector("#compose").action="/different-recipient"',
        'document.querySelector("#send").formAction="/different-action"',
        'document.querySelector("#opt-in").checked=false',
        'document.querySelector("#delivery").value="publish"'
      ]) {
        await resetForm()
        const target = (await descriptor('browser_click', { selector: '#send' })).target
        await wc.executeJavaScript(mutation)
        await assert.rejects(executeBrowserTool('browser_click', { selector: '#send' }, meta.id, { ...context('changed-target'), effectTarget: target }), staleTarget)
        await assertNoSend()
      }
      await resetForm()
      const labelTarget = (await descriptor('browser_click', { selector: '#send-label' })).target
      await wc.executeJavaScript('document.querySelector("#recipient").value="label-changed"')
      await assert.rejects(executeBrowserTool('browser_click', { selector: '#send-label' }, meta.id, { ...context('changed-label-form'), effectTarget: labelTarget }), staleTarget)
      await assertNoSend()
    })
    await check('typing does not overwrite a changed value or reuse another form state', async () => {
      for (const mutation of ['document.querySelector("#recipient").value="human-edit"', 'document.querySelector("#hidden").value="new-context"']) {
        await resetForm()
        const args = { selector: '#recipient', text: 'agent-edit' }
        const target = (await descriptor('browser_type', args)).target
        await wc.executeJavaScript(mutation)
        const prior = await wc.executeJavaScript('document.querySelector("#recipient").value')
        await assert.rejects(executeBrowserTool('browser_type', args, meta.id, { ...context('typing-stale'), effectTarget: target }), staleTarget)
        assert.equal(await wc.executeJavaScript('document.querySelector("#recipient").value'), prior)
      }
    })
    await check('unrelated page and other-form updates preserve the exact approved action', async () => {
      await resetForm()
      const args = { selector: '#send' }, approved = await descriptor('browser_click', args)
      await wc.executeJavaScript('document.querySelector("#news").textContent="Updated headline";document.querySelector("#unrelated-field").value="other task"')
      assert.equal((await descriptor('browser_click', args)).targetDigest, approved.targetDigest)
      assert.equal((await executeBrowserTool('browser_click', args, meta.id, { ...context('unrelated-update'), effectTarget: approved.target })).ok, true)
      assert.equal(await wc.executeJavaScript('document.body.dataset.sent'), '1')
    })
    await check('form changes at the execution boundary and focus handlers cannot slip past approval', async () => {
      await resetForm()
      const args = { selector: '#send' }, approved = await descriptor('browser_click', args)
      const original = wc.executeJavaScriptInIsolatedWorld.bind(wc)
      wc.executeJavaScriptInIsolatedWorld = async (...parameters) => {
        await wc.executeJavaScript('document.querySelector("#recipient").value="raced-recipient"')
        return original(...parameters)
      }
      try { await assert.rejects(executeBrowserTool('browser_click', args, meta.id, { ...context('same-document-race'), effectTarget: approved.target }), staleTarget) }
      finally { wc.executeJavaScriptInIsolatedWorld = original }
      await assertNoSend()
      await resetForm()
      await wc.executeJavaScript('document.querySelector("#send").addEventListener("focus",()=>{document.querySelector("#hidden").value="focus-changed"})')
      // A hidden Electron window may suppress native focus. Deliver the real
      // DOM event at the focus boundary without showing a user-facing window.
      await wc.executeJavaScriptInIsolatedWorld(1003, [{ code: 'HTMLElement.prototype.focus=function(){this.dispatchEvent(new FocusEvent("focus"))};void 0' }])
      const focusApproval = await descriptor('browser_click', args)
      await assert.rejects(executeBrowserTool('browser_click', args, meta.id, { ...context('focus-race'), effectTarget: focusApproval.target }), staleTarget)
      await assertNoSend()
    })
    await check('arbitrary evaluation conservatively binds the entire document and form state', async () => {
      await resetForm()
      const args = { script: "document.body.dataset.executed='yes'" }, approved = await descriptor('browser_evaluate', args)
      await wc.executeJavaScript('document.querySelector("#unrelated-field").value="changed"')
      await assert.rejects(executeBrowserTool('browser_evaluate', args, meta.id, { ...context('evaluate-conservative'), effectTarget: approved.target }), staleTarget)
      assert.equal(await wc.executeJavaScript('document.body.dataset.executed'), undefined)
      const current = await descriptor('browser_evaluate', args)
      assert.equal((await executeBrowserTool('browser_evaluate', args, meta.id, { ...context('evaluate-current'), effectTarget: current.target })).ok, true)
      assert.equal(await wc.executeJavaScript('document.body.dataset.executed'), 'yes')
    })
    assert.equal((await verifyPersistedWorkflowLedger(root)).valid, true)
    console.log(`Browser research source: ${passed}/${passed} passed; physical Electron DOM, canonical stores, no network or Provider calls.`)
  } finally {
    browserViewManager.close(meta.id)
    owner.destroy()
    taskRuntimeRegistry.clear()
    await partition.protocol.unhandle('https')
  }
}
