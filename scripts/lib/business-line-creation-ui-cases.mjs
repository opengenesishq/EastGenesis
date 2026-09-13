import assert from 'node:assert/strict'

const lineA = 'business-line:creation-video'
const lineB = 'business-line:creation-tasks'

export async function verifyBusinessLineCreationUi({ page, check, input, screenshot, waitForValue }) {
  await page.evaluate(async ({ lineA, lineB }) => {
    const common = { schemaVersion: 1, origin: 'custom', objective: '验证业务归属', workflow: ['执行'], deliverables: ['结果'], enabled: true, routingPreference: 'balanced', toolScope: 'view' }
    await window.agentDesk.updateSettings({ businessLines: [{ ...common, id: lineA, name: '只有视频的业务线', workSurfaces: ['video'], order: 3 }, { ...common, id: lineB, name: '另一条业务线', order: 4 }], selectedBusinessLineId: lineA })
  }, { lineA, lineB })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await check('generic new task leaves a video-only custom surface and keeps its owner', async () => {
    await page.waitForSelector(`[data-video-business-line="${lineA}"]`, { visible: true })
    await page.click('.sidebar-primary-nav .sidebar-new')
    await page.waitForSelector('#business-line-task-input', { visible: true })
    assert.equal(await page.$eval('[data-business-line-workbench]', (node) => node.dataset.businessLineWorkbench), lineA)
    assert.equal(await page.$eval('[data-business-line-surface-option="tasks"]', (node) => node.getAttribute('aria-pressed')), 'true')
    await screenshot('new-task-from-custom-video')
  })
  await check('3D new task belongs to the viewed custom line despite a different workspace selection', async () => {
    await page.click('[data-business-line-option="assistant"]')
    await page.click('[data-sidebar-action="control-room"]')
    await page.waitForSelector(`[data-office-business-view-option="${lineB}"]`, { visible: true, timeout: 25000 })
    await page.click(`[data-office-business-view-option="${lineB}"]`)
    assert.equal((await page.evaluate(() => window.agentDesk.getSettings())).selectedBusinessLineId, 'assistant')
    await page.click('[data-office-new-work]')
    await page.waitForSelector(`[data-business-line-workbench="${lineB}"] #business-line-task-input`, { visible: true })
    await input('#business-line-task-input', '3D当前业务线新建归属验证')
    const knownSessionIds = await page.evaluate(async () => (await window.agentDesk.listSessions()).map((item) => item.id))
    await page.click('[data-business-line-start]')
    const session = await completedOwnedTask({ page, knownSessionIds, waitForValue })
    assert.equal(session.businessLineId, lineB)
    await screenshot('new-task-from-viewed-business-space')
  })
  await check('3D builtin video new opens its lazy QuickStart and creates a video-owned production', async () => {
    await page.click('[data-sidebar-action="control-room"]')
    await page.waitForSelector('[data-office-business-view-option="video"]', { visible: true, timeout: 25000 })
    await page.click('[data-office-business-view-option="video"]')
    await page.click('[data-office-new-work]')
    await page.waitForSelector('[data-video-business-line="video"] [data-video-quick-start]', { visible: true })
    assert.equal((await page.evaluate(() => window.agentDesk.getSettings())).selectedBusinessLineId, 'video')
    await input('[name="videoTitle"]', '3D内置视频新建验证')
    await input('[name="videoScript"]', '通过明确待处理导航打开视频新建。')
    await page.click('[data-video-quick-start] button[type="submit"]')
    const production = await waitForValue(() => page.evaluate(async () => (await window.agentDesk.getMediaStudio()).productions.find((item) => item.title === '3D内置视频新建验证')), Boolean, 15000, 'builtin video production')
    assert.equal(production.businessLineId, 'video')
    await screenshot('new-video-from-video-space')
  })
}

async function completedOwnedTask({ page, knownSessionIds, waitForValue }) {
  let sessionId
  const result = await waitForValue(async () => {
    const added = (await page.evaluate(() => window.agentDesk.listSessions())).filter((item) => !knownSessionIds.includes(item.id))
    assert(added.length <= 1, `owned task identity: expected one new session, observed ${JSON.stringify(added.map(({ id, title, businessLineId }) => ({ id, title, businessLineId })))}`)
    if (!added.length) return { expectedBusinessLineId: lineB, newSessions: [] }
    const session = added[0]
    assert.equal(session.businessLineId, lineB, `new task ${session.id} belongs to the wrong business line`)
    if (!sessionId) sessionId = session.id
    assert.equal(session.id, sessionId, 'new task identity changed while waiting for its first turn')
    return { session, transcript: await page.evaluate((id) => window.agentDesk.getTranscript(id), sessionId) }
  }, ownedTurnComplete, 30000, `completed owned task in ${lineB}`)
  for (const field of ['workspaceId', 'goalId', 'workItemId']) assert.ok(result.session[field], `owned task ${sessionId} has no canonical ${field}`)
  assert.equal(result.session.unassigned, false)
  const userMessages = result.transcript.filter((entry) => entry.event.kind === 'user-message')
  assert.equal(userMessages.length, 1, 'the owned task must have exactly one initial user message')
  assert.equal(userMessages[0].event.text.split('\n')[0], '3D当前业务线新建归属验证')
  const userIndex = result.transcript.indexOf(userMessages[0])
  assert(result.transcript.slice(userIndex + 1).some((entry) => entry.event.kind === 'turn-result' && !entry.event.isError), 'successful first turn must follow the owned task message')
  return result.session
}

function ownedTurnComplete({ session, transcript = [] }) {
  return session?.status === 'idle' && Boolean(session.sdkSessionId) && transcript.some((entry) => entry.event.kind === 'turn-result' && !entry.event.isError)
}
