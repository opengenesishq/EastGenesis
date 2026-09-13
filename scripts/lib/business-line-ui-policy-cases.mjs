import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

export function mockBusinessLineReply(request) {
  const text = JSON.stringify(request.messages)
  if (!text.includes('业务线配置草稿')) return '业务线验证完成'
  return JSON.stringify({ name: '模型草稿业务', objective: '核查报告中的数据来源', workflow: ['核查来源', '交付报告'], deliverables: ['带来源的报告'], routingPreference: 'balanced', roleInstructions: '证据核查员', acceptanceCriteria: ['每项结论可追溯'], requiredCapabilities: ['tools'], toolScope: 'view' })
}

export async function verifyBusinessLineUiPolicies(context) {
  await verifyPortableBusinessLine(context)
  await verifyGeneratedBusinessLine(context)
  await verifyAcceptancePlan(context)
}

async function verifyPortableBusinessLine({ page, temp, check, input, waitForValue }) {
  await check('duplicate a builtin and export/import a credential-free editable definition', async () => {
    const downloads = path.join(temp, 'business-line-downloads'); mkdirSync(downloads)
    const cdp = await page.createCDPSession()
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
    await page.click('[data-manage-business-lines]')
    await page.click('[data-business-line-definition="assistant"] .business-line-edit')
    assert.equal(await page.$$eval('[data-business-builtin-surface="assistant"]', (nodes) => nodes.length), 1)
    assert.equal(await page.$('[data-business-work-surface]'), null, 'builtin dedicated workspaces must not expose ineffective editable surface controls')
    await page.click('[data-business-line-duplicate]')
    assert.equal(await page.$$eval('[data-business-work-surface]', (nodes) => nodes.length), 3)
    await input('[name="businessLineName"]', '助手复制验证')
    await page.click('[data-business-line-export]')
    const file = await waitForValue(async () => readdirSync(downloads).find((name) => name.endsWith('.json')), Boolean, 10000, 'export download')
    const exported = JSON.parse(readFileSync(path.join(downloads, file), 'utf8'))
    assert.equal(exported.definition.origin, 'custom')
    assert.equal(exported.definition.builtinMode, undefined)
    assert(!Object.keys(exported.definition).some((key) => /token|key|url|provider/i.test(key)))
    const fileInput = await page.$('.business-line-draft-tools input[type="file"]')
    await fileInput.uploadFile(path.join(downloads, file))
    await waitForValue(() => page.$eval('[name="businessLineName"]', (node) => node.value), (value) => value === '助手复制验证', 10000, 'imported draft')
    await input('[name="businessLineName"]', '导入的助手业务')
    await page.click('[data-save-business-line]')
    await page.waitForSelector('[data-business-line-manager]', { hidden: true })
    const saved = await page.evaluate(async () => (await window.agentDesk.getSettings()).businessLines.find((line) => line.name === '导入的助手业务'))
    assert.equal(saved.origin, 'custom'); assert.notEqual(saved.id, exported.definition.id)
    await cdp.detach()
  })
}

async function verifyGeneratedBusinessLine({ page, requests, check, input, screenshot, waitForValue }) {
  await check('natural-language draft uses a real local model turn and requires review before saving', async () => {
    await page.click('[data-manage-business-lines]')
    await page.click('.business-line-draft-tools summary')
    await input('textarea[aria-label="业务线需求描述"]', '创建一个核对报告中事实和来源的业务线')
    const before = requests.length
    await page.click('[data-business-line-generate]')
    await waitForValue(() => page.$eval('[name="businessLineName"]', (node) => node.value), (name) => name === '模型草稿业务', 30000, 'validated real model draft')
    assert(requests.length > before)
    let lines = await page.evaluate(async () => (await window.agentDesk.getSettings()).businessLines)
    assert(!lines.some((line) => line.name === '模型草稿业务'), 'generated draft must not auto-save')
    const session = await page.evaluate(async () => (await window.agentDesk.listSessions()).find((item) => item.title === '业务线配置草稿'))
    assert.equal(session.taskStrategy, 'view'); assert.equal(session.businessLineId, 'assistant')
    await input('[name="businessLineName"]', '审查后的报告业务')
    await screenshot('reviewable-model-business-line-draft')
    await page.click('[data-save-business-line]')
    await page.waitForSelector('[data-business-line-manager]', { hidden: true })
    lines = await page.evaluate(async () => (await window.agentDesk.getSettings()).businessLines)
    assert(lines.some((line) => line.name === '审查后的报告业务' && line.acceptanceCriteria[0] === '每项结论可追溯'))
  })
}

async function verifyAcceptancePlan({ page, lineId, requests, check, input, screenshot, waitForValue, onEvidence = () => undefined }) {
  await check('execution line saves a real unapproved acceptance plan before its model turn', async () => {
    await page.click('[data-manage-business-lines]')
    await page.click(`[data-business-line-definition="${lineId}"] .business-line-edit`)
    await page.select('[name="businessLineToolScope"]', 'execute')
    await page.click('[data-save-business-line]')
    await waitForValue(() => page.evaluate(async (id) => (await window.agentDesk.getSettings()).businessLines.find((line) => line.id === id).toolScope, lineId), (scope) => scope === 'execute', 10000, 'updated tool scope')
    await page.click('[data-business-line-manager] button[aria-label="关闭"]')
    await page.click(`[data-business-line-option="${lineId}"]`)
    await input('#business-line-task-input', '验收计划验证任务')
    const before = requests.length
    const knownSessionIds = await page.evaluate(async () => (await window.agentDesk.listSessions()).map((item) => item.id))
    await page.click('[data-business-line-start]')
    await waitForValue(async () => requests.length, (count) => count > before, 30000, 'planned task local model request')
    const { session, transcript } = await completedPlannedTask({ page, lineId, knownSessionIds, waitForValue })
    assert.equal(session.taskStrategy, 'plan'); assert.equal(session.businessLineId, lineId)
    const plan = await page.evaluate((id) => window.agentDesk.getTaskPlan(id), session.id)
    assert.equal(plan.currentVersion.objective, '验收计划验证任务')
    assert.deepEqual(plan.currentVersion.acceptanceCriteria, ['文案必须有来源依据'])
    assert.equal(plan.approvalStatus, 'pending')
    assert.notEqual(plan.approvalStatus, 'approved')
    assert.equal(plan.approvalEvents.length, 0)
    await assert.rejects(() => page.evaluate((id) => window.agentDesk.setTaskStrategy(id, 'execute'), session.id), /审批|批准/)
    onEvidence({ plannedTask: { sessionId: session.id, title: session.title, businessLineId: session.businessLineId,
      workspaceId: session.workspaceId, goalId: session.goalId, workItemId: session.workItemId,
      approvalStatus: plan.approvalStatus, acceptanceCriteria: plan.currentVersion.acceptanceCriteria,
      firstTurn: transcript.find((entry) => entry.event.kind === 'turn-result').event } })
    await screenshot('durable-business-acceptance-plan')
  })
}

async function completedPlannedTask({ page, lineId, knownSessionIds, waitForValue }) {
  const sessions = await page.evaluate(() => window.agentDesk.listSessions())
  const added = sessions.filter((item) => !knownSessionIds.includes(item.id))
  const candidates = added.filter((item) => item.businessLineId === lineId)
  assert.equal(candidates.length, 1, `planned task identity: expected exactly one new session in ${lineId}; observed ${JSON.stringify(added.map(({ id, title, businessLineId, workItemId }) => ({ id, title, businessLineId, workItemId })))}`)
  const sessionId = candidates[0].id
  for (const field of ['workspaceId', 'goalId', 'workItemId']) assert.ok(candidates[0][field], `planned task ${sessionId} has no canonical ${field}`)
  assert.equal(candidates[0].unassigned, false)
  const result = await waitForValue(() => page.evaluate(async (id) => ({
    session: (await window.agentDesk.listSessions()).find((item) => item.id === id),
    transcript: await window.agentDesk.getTranscript(id)
  }), sessionId), plannedTurnComplete, 30000, `planned task completion for ${sessionId}`)
  const messages = result.transcript.filter((entry) => entry.event.kind === 'user-message')
  assert.equal(messages.length, 1, 'the new planned task must have exactly one initial user message')
  assert.equal(messages[0].event.text.split('\n')[0], '验收计划验证任务')
  const userIndex = result.transcript.indexOf(messages[0])
  assert(result.transcript.slice(userIndex + 1).some((entry) => entry.event.kind === 'turn-result' && !entry.event.isError), 'successful first turn must follow this task message')
  return result
}

function plannedTurnComplete({ session, transcript }) {
  return session?.status === 'idle' && Boolean(session.sdkSessionId) && transcript.some((entry) => entry.event.kind === 'turn-result' && !entry.event.isError)
}
