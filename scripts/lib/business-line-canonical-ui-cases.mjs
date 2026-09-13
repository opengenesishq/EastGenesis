import assert from 'node:assert/strict'

export async function createCanonicalBusinessFixture(page, businessLineId) {
  const result = await page.evaluate(async (id) => {
    const workspace = await window.agentDesk.createProjectWorkspace({ name: '自定义线媒体归属验证', kind: 'custom' })
    const parent = await window.agentDesk.createProjectWorkItem({ projectId: workspace.id, title: '自定义线传播计划', businessLineId: id })
    const child = await window.agentDesk.createProjectWorkItem({ projectId: workspace.id, title: '传播子项', parentId: parent.id })
    const production = await window.agentDesk.createVideoProduction({ projectId: workspace.id, businessLineId: id, title: '自定义线制作', script: '用于验证持久化归属的本地镜头', autoStructure: true })
    const job = await window.agentDesk.submitMediaJob({ projectId: workspace.id, productionId: production.id, capability: 'video', mediaProviderId: 'media-provider:mock-local', idempotencyKey: 'business-canonical-e2e', prompt: '本地验证' })
    const generated = await window.agentDesk.getProjectWorkItem(job.workItemId)
    return { projectId: workspace.id, production, job, parent, child, generated }
  }, businessLineId)
  for (const entity of [result.production, result.job, result.parent, result.child, result.generated]) assert.equal(entity.businessLineId, businessLineId)
  await assert.rejects(() => page.evaluate((data) => window.agentDesk.submitMediaJob({ projectId: data.projectId, productionId: data.production.id, businessLineId: 'video', capability: 'video', mediaProviderId: 'media-provider:mock-local', idempotencyKey: 'business-canonical-e2e-wrong' }), result), /归属/)
  return result
}

export async function verifyCanonicalBusinessRestart(page, fixture, businessLineId) {
  const data = await page.evaluate(async (input) => {
    const media = await window.agentDesk.getMediaStudio(input.projectId)
    return { sessions: await window.agentDesk.listSessions(), production: media.productions.find((item) => item.id === input.production.id), job: media.jobs.find((item) => item.id === input.job.id), parent: await window.agentDesk.getProjectWorkItem(input.parent.id), child: await window.agentDesk.getProjectWorkItem(input.child.id), generated: await window.agentDesk.getProjectWorkItem(input.generated.id) }
  }, fixture)
  assert.equal(data.sessions.length, 0, `restart fixture must prove identity without any loaded session: ${JSON.stringify(data.sessions.map((item) => ({ id: item.id, title: item.title, businessLineId: item.businessLineId })))}`)
  for (const entity of [data.production, data.job, data.parent, data.child, data.generated]) assert.equal(entity.businessLineId, businessLineId)
}
