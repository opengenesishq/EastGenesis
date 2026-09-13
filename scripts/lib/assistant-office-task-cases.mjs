import assert from 'node:assert/strict'
import { insertDesktopText } from './desktop-text-input.mjs'
import { approveOriginalPermission, dismissRecoveryDrawer } from './assistant-office-permission-ui.mjs'

/** These extra Sessions are real native executions of the same canonical WorkItem, not injected renderer projections. */
export async function verifyTaskGroupingUi({ page, personal, provider, until, screenshot, onEvidence = () => undefined }) {
  const sessions = await page.evaluate(async ({ personal, provider }) => {
    const api = window.agentDesk; const sessions = []
    for (const title of ['GROUP_APPROVAL_A', 'GROUP_APPROVAL_B', 'GROUP_HISTORY_COMPLETED']) {
      const session = await api.createSession({ cwd: personal.cwd, workspaceId: personal.workspaceId, goalId: personal.goalId, workItemId: personal.workItemId,
        businessLineId: 'assistant', experienceModeOverride: 'assistant', unassigned: false,
        providerId: provider.id, model: 'office-golden-local', routingScope: 'fixed', taskStrategy: 'execute', title })
      sessions.push(session)
    }
    return sessions
  }, { personal, provider })
  onEvidence({ sessions })
  for (const session of sessions) {
    await until(() => page.evaluate((id) => window.agentDesk.listSessions().then((items) => items.find((item) => item.id === id)?.status), session.id), (status) => status === 'idle', 20000, 'alias initialized')
    assert.equal(await page.evaluate((session) => window.agentDesk.sendMessage(session.id, session.title), session), true)
  }
  const [first, second, historical] = sessions
  for (const session of [first, second]) await until(() => page.evaluate((id) => window.agentDesk.getTranscript(id), session.id), (entries) => entries.some((entry) => entry.event.kind === 'permission-request'), 20000, 'real approval pending')
  await until(() => page.evaluate((id) => window.agentDesk.getTranscript(id), historical.id), (entries) => entries.some((entry) => entry.event.kind === 'turn-result' && !entry.event.isError), 20000, 'history execution completed')
  Object.assign(historical, await page.evaluate((id) => window.agentDesk.listSessions().then((items) => items.find((item) => item.id === id)), historical.id))
  await page.evaluate((id) => window.agentDesk.closeSession(id), historical.id)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await dismissRecoveryDrawer(page, true)
  const group = `[data-sidebar-task="task:assistant:${personal.workItemId}"]`
  await page.waitForSelector(group, { visible: true, timeout: 20000 })
  assert.equal(await page.$$eval('[data-sidebar-assistant-sessions] [data-sidebar-task]', (items) => items.length), 1)
  for (const session of [first, second]) await page.waitForSelector(`${group} [data-session-id="${session.id}"]`, { visible: true })
  await page.click(`${group} summary`)
  await page.waitForSelector(`${group} [data-session-id="${historical.id}"]`, { visible: true })
  await screenshot('same-task-all-approvals-and-history')
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.down(modifier); await page.keyboard.press('k'); await page.keyboard.up(modifier)
  await page.waitForSelector('.command-palette', { visible: true })
  await page.type('.command-palette-input', 'GROUP')
  await page.click('[data-command-id$=":executions"]')
  await page.waitForSelector('.command-palette-task-scope', { visible: true })
  for (const session of [personal, first, second]) assert(await page.$(`[data-command-id="session:${session.id}"]`))
  assert(await page.$(`[data-command-id="history:${historical.id}"]`))
  await page.click('.command-palette-task-scope button')
  await page.waitForFunction(() => !document.querySelector('.command-palette-task-scope'))
  await page.keyboard.press('Escape')
  for (const session of [first, second]) {
    await page.click(`${group} [data-session-id="${session.id}"]`)
    onEvidence({ approval: await approveOriginalPermission({ page, session, until }) })
  }
  await page.click(`${group} [data-session-id="${historical.id}"]`)
  const resumed = await until(() => page.evaluate(() => window.agentDesk.listSessions()), (items) => items.some((item) => item.sdkSessionId === historical.sdkSessionId), 20000, 'original history resumed')
    .then((items) => items.find((item) => item.sdkSessionId === historical.sdkSessionId))
  await page.waitForSelector(`.session-card.active[data-session-id="${resumed.id}"]`, { visible: true, timeout: 20000 })
}

export async function verifyCustomCanonicalUi({ page, until, screenshot, onEvidence = () => undefined }) {
  await page.click('[data-manage-business-lines]')
  await page.waitForSelector('[data-business-line-manager]', { visible: true })
  await fill(page, '[name="businessLineName"]', '采购审查自定义线')
  await fill(page, '[name="businessLineObjective"]', '复核采购资料与来源')
  await fill(page, '[name="businessLineWorkflow"]', '读取资料\n形成草稿\n核对证据')
  await fill(page, '[name="businessLineDeliverables"]', '采购审查结果')
  await fill(page, '[name="businessLineAcceptance"]', '所有数字都有可追溯来源')
  await page.select('[name="businessLineToolScope"]', 'execute')
  await page.click('[data-save-business-line]')
  await page.waitForSelector('[data-business-line-workbench]', { visible: true })
  const lineId = await page.$eval('[data-business-line-workbench]', (node) => node.getAttribute('data-business-line-workbench'))
  await fill(page, '#business-line-task-input', 'CUSTOM_CANONICAL 请先形成采购审查计划，等待我批准后执行。')
  await page.click('[data-business-line-start]')
  const session = await until(() => page.evaluate((id) => window.agentDesk.listSessions().then((items) => items.find((item) => item.businessLineId === id)), lineId), (item) => item?.workItemId, 30000, 'custom canonical first task')
  onEvidence({ customSession: session })
  assert.equal(session.businessLineId, lineId); assert.equal(session.unassigned, false); assert.equal(session.taskStrategy, 'plan')
  const plan = await until(() => page.evaluate((id) => window.agentDesk.getTaskPlan(id), session.id), (state) => state.approvalStatus === 'pending' && Boolean(state.currentVersion), 30000, 'durable unapproved plan before first send')
  assert.equal(plan.approvalStatus, 'pending'); assert(plan.currentVersion.acceptanceCriteria.includes('所有数字都有可追溯来源'))
  const transcript = await until(() => page.evaluate((id) => window.agentDesk.getTranscript(id), session.id), (entries) => entries.some((entry) => entry.event.kind === 'turn-result' && !entry.event.isError), 30000, 'custom first native turn')
  assert(transcript.some((entry) => entry.event.kind === 'user-message' && entry.event.text.includes('CUSTOM_CANONICAL')))
  await page.waitForSelector(`[data-business-line-workbench="${lineId}"] .business-line-active-task`, { visible: true, timeout: 20000 })
  const result = await page.evaluate((id) => window.agentDesk.getStudioResultSnapshot(id), session.id)
  assert.equal(result.scope.workItemId, session.workItemId)
  await screenshot('custom-canonical-unapproved-acceptance-plan')
}

async function fill(page, selector, text) { await insertDesktopText(page, selector, text) }
