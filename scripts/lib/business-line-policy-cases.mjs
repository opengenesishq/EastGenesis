import assert from 'node:assert/strict'

export async function verifyBusinessLinePolicy(runtime, { draft, provider, port, checks }) {
  const id = 'business-line:policy-fixture'
  const line = {
    schemaVersion: 1, id, origin: 'custom', name: '只读图像研究', objective: '核查图像证据', workflow: ['核查', '报告'],
    deliverables: ['报告'], routingPreference: 'cost', enabled: true, order: 3, requiredCapabilities: ['vision'], toolScope: 'view', taskBudgetUsd: 1
  }
  const capable = provider('openai', port, '-capable', [0.02, 0.03])
  capable.advancedConfig.modelProfiles[1].capabilities.push('vision')
  runtime.providers.commitProviderProfileStore([capable])
  runtime.settings.updateSettings({ budgetUsdPerMonth: 0, businessLines: [...runtime.businessLines.createDefaultBusinessLines(), line] })
  const meta = draft(runtime, { businessLineId: id })
  assert.equal(meta.modelRoutingDecision.model, capable.models[1], 'cheaper model without required vision cannot win')
  assert.equal(meta.budgetUsd, 1)
  assert.throws(() => draft(runtime, { businessLineId: id, providerId: capable.id, model: capable.models[0] }), /所需能力/)
  assert.throws(() => draft(runtime, { businessLineId: id, taskStrategy: 'execute' }), /工具范围/)
  for (const budgetUsd of [-1, 0, NaN, 2]) assert.throws(() => draft(runtime, { businessLineId: id, budgetUsd }), /预算/)
  const child = runtime.lifecycle.prepareSessionCreationDraft({ cwd: meta.cwd, unassigned: true, providerId: capable.id, model: capable.models[1] }, meta).baseMeta
  assert.equal(child.taskStrategy, 'view')
  assert.equal(child.budgetUsd, 1)
  const history = runtime.historyEntry({ ...meta, budgetUsd: 0.25, costUsd: 0.15, sdkSessionId: 'business-policy-history' })
  runtime.history.upsertHistory(history)
  const resume = () => runtime.lifecycle.prepareSessionCreationDraft({ cwd: meta.cwd, resumeSdkSessionId: history.sdkSessionId, unassigned: true }).baseMeta
  assert.equal(resume().budgetUsd, 0.25, 'restart must preserve a stricter task budget')
  assert.equal(resume().costUsd, 0.15, 'restart must not reset previously consumed task budget')
  runtime.history.upsertHistory({ ...history, taskStrategy: 'execute' })
  assert.throws(resume, /工具范围/, 'inherited execution cannot bypass a business line scope')
  runtime.history.upsertHistory(history)
  runtime.settings.updateSettings({ businessLines: runtime.businessLines.createDefaultBusinessLines() })
  checks.push('business policy: capability hard filter, fixed rejection, budget/strategy ceiling, child and restart enforcement')
}
