import assert from 'node:assert/strict'

export async function verifyBusinessLineVideoUi(context) {
  const fixture = await createVideoThroughUi(context)
  await verifyBusinessLineVideoIsolation(context, fixture)
  await verifyControlRoomVideoReturn(context, fixture)
}

async function createVideoThroughUi({ page, lineId, check, input, screenshot, waitForValue }) {
  let fixture
  await check('custom video work surface creates its own production through user controls', async () => {
    await page.click(`[data-business-line-option="${lineId}"]`)
    await page.click('[data-business-line-surface-option="video"]')
    await page.waitForSelector(`[data-video-business-line="${lineId}"]`, { visible: true })
    await page.click('[data-video-new-project]')
    await input('[name="videoTitle"]', '增长营销视频 UI 验证')
    await input('[name="videoScript"]', '清晨，团队演示新品。\n用户打开产品查看结果。')
    await page.click('[data-video-quick-start] button[type="submit"]')
    fixture = await waitForValue(() => page.evaluate(async (id) => {
      const workspace = (await window.agentDesk.listProjectWorkspaces()).find((item) => item.name === '增长营销视频 UI 验证')
      if (!workspace) return null
      const snapshot = await window.agentDesk.getMediaStudio(workspace.id)
      const production = snapshot.productions.find((item) => item.businessLineId === id)
      return production ? { projectId: workspace.id, production } : null
    }, lineId), Boolean, 15000, 'user-created custom video production')
    await page.waitForSelector('.video-studio-header-actions select', { visible: true })
    assert.equal(await page.$eval('.video-studio-header-actions select', (node) => node.value), fixture.production.id)
    assert.equal(fixture.production.businessLineId, lineId)
    assert.equal((await page.evaluate(() => window.agentDesk.getSettings())).selectedBusinessLineId, lineId)
    await screenshot('custom-video-work-surface')
  })
  return fixture
}

async function verifyBusinessLineVideoIsolation({ page, lineId, check, input, screenshot, waitForValue }, fixture) {
  await check('custom and builtin video productions stay isolated while sharing valid projects and providers', async () => {
    fixture.foreign = await page.evaluate((projectId) => window.agentDesk.createVideoProduction({ projectId, businessLineId: 'video', title: '仅内置视频可见', script: '本地内置视频制作验证', autoStructure: true }), fixture.projectId)
    await page.click('.video-studio-header-actions button')
    await waitForValue(() => productionIds(page), (ids) => ids.includes(fixture.production.id), 10000, 'custom production list')
    assert(!(await productionIds(page)).includes(fixture.foreign.id))
    await page.$eval('[data-video-advanced-section="generation"]', (node) => { node.open = true })
    const providerLabels = await page.$$eval('[data-media-routing-controls] select:nth-of-type(1) option', (nodes) => nodes.map((node) => node.textContent))
    assert(providerLabels.some((name) => name.includes('Business line local mock') && name.includes('business-line-video')), 'same text provider must supply the media model catalog')
    await page.click('[data-business-line-option="video"]')
    await page.waitForSelector('[data-video-business-line="video"]', { visible: true })
    await page.select('.video-studio-project-picker select', fixture.projectId)
    await waitForValue(() => productionIds(page), (ids) => ids.includes(fixture.foreign.id), 10000, 'builtin isolated production')
    assert(!(await productionIds(page)).includes(fixture.production.id))
    fixture.sharedProject = await page.evaluate(() => window.agentDesk.createProjectWorkspace({ name: '共享空项目可选', kind: 'custom' }))
    await page.click(`[data-business-line-option="${lineId}"]`)
    await page.click('[data-business-line-surface-option="video"]')
    await waitForValue(() => page.$$eval('.video-studio-project-picker option', (nodes) => nodes.map((node) => node.value)), (ids) => ids.includes(fixture.sharedProject.id), 10000, 'shared project is available without existing owned productions')
    await page.select('.video-studio-project-picker select', fixture.sharedProject.id)
    await page.waitForSelector('.video-studio-create', { visible: true })
    await input('[aria-label="制作标题"]', '共享项目中的增长营销制作')
    await input('[aria-label="短剧本"]', '在没有这条业务线历史制作的共享项目里首次新建。')
    await page.click('.video-studio-create button')
    const sharedProduction = await waitForValue(() => page.evaluate(async (id) => (await window.agentDesk.getMediaStudio(id)).productions[0], fixture.sharedProject.id), Boolean, 10000, 'first production in a shared project')
    assert.equal(sharedProduction.businessLineId, lineId)
    await page.select('.video-studio-project-picker select', fixture.projectId)
    await waitForValue(() => productionIds(page), (ids) => ids.includes(fixture.production.id), 10000, 'custom production restored')
    await screenshot('isolated-custom-production-and-shared-catalog')
  })
}

async function verifyControlRoomVideoReturn({ page, lineId, check, screenshot, waitForValue }, fixture) {
  await check('3D media actor opens the exact custom video surface and disabled ownership gives a recoverable error', async () => {
    const job = await page.evaluate((data) => window.agentDesk.submitMediaJob({ projectId: data.projectId, productionId: data.production.id, capability: 'video', mediaProviderId: 'media-provider:mock-local', idempotencyKey: 'business-video-ui-navigation', prompt: '本地导航验证' }), fixture)
    await openActor(page, lineId, job.id)
    await page.click('[data-office-operational-open]')
    await page.waitForSelector(`[data-video-business-line="${lineId}"]`, { visible: true, timeout: 15000 })
    await page.waitForSelector('.video-studio-header-actions select', { visible: true, timeout: 15000 })
    await waitForValue(() => page.$eval('.video-studio-header-actions select', (node) => node.value), (id) => id === fixture.production.id, 10000, 'exact production navigation')
    assert.equal((await page.evaluate(() => window.agentDesk.getSettings())).selectedBusinessLineId, lineId)
    await openActor(page, lineId, job.id)
    await page.evaluate(async (id) => {
      const settings = await window.agentDesk.getSettings()
      await window.agentDesk.updateSettings({ businessLines: settings.businessLines.map((line) => line.id === id ? { ...line, enabled: false } : line) })
    }, lineId)
    await page.click('[data-office-operational-open]')
    await page.waitForSelector('[data-office-navigation-error]', { visible: true })
    assert.match(await page.$eval('[data-office-navigation-error]', (node) => node.textContent), /停用/)
    assert.equal((await page.evaluate((id) => window.agentDesk.getMediaStudio(id), fixture.projectId)).productions.find((item) => item.id === fixture.production.id).businessLineId, lineId)
    await screenshot('disabled-custom-media-history-navigation')
  })
}

async function openActor(page, lineId, jobId) {
  await page.click('[data-sidebar-action="control-room"]')
  await page.waitForSelector(`[data-office-business-view-option="${lineId}"]`, { visible: true, timeout: 25000 })
  await page.click(`[data-office-business-view-option="${lineId}"]`)
  await page.waitForFunction((id) => Array.from(document.querySelectorAll('.office-actor-picker option')).some((node) => node.value === `media:${id}`), { timeout: 25000 }, jobId)
  await page.select('.office-actor-picker', `media:${jobId}`)
  await page.waitForSelector('[data-office-operational-panel]', { visible: true })
}

async function productionIds(page) { return page.$$eval('.video-studio-header-actions option', (nodes) => nodes.map((node) => node.value)) }
