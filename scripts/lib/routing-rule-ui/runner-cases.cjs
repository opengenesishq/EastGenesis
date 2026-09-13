const assert = require('node:assert/strict')
const { sharedLoader } = require('./test-runtime.cjs')
const { fixtures, source, createRoutingControllerRunner, state, commands, initial, setup, controlledApi, newerRead, context, preview } = require('./runner-fixture.cjs')
const { validateRoutingRuleDraftBase } = sharedLoader.read('routing-policy-command-parser.ts')
const cases = []
function check(name, action) { cases.push({ name, action }) }

check('Runner construction emits no invented result or API call; snapshots are isolated', () => {
  const test = setup({ initialState: initial() }), snapshot = test.runner.getSnapshot()
  snapshot.draft.rules[0].name = '调用方修改副本'
  assert.equal(test.runner.getSnapshot().draft.rules[0].name, '保留的客户端草稿')
  assert.equal(test.runner.getSnapshot().lastSave, undefined)
  assert.deepEqual(test.calls, []); assert.deepEqual(test.notices, [])
})
check('Deferred read accepts one API call and suppresses duplicate commands until its exact reply', async () => {
  const test = setup(), operation = test.runner.read()
  await test.runner.read(); await test.runner.save(); await test.runner.preview()
  assert.deepEqual(test.calls.map((call) => call.method), ['get'])
  assert.equal(test.runner.getSnapshot().read, null)
  test.calls[0].pending.resolve(fixtures.readV1); await operation
  assert.equal(test.runner.getSnapshot().read.ruleSet.revision, 3)
  assert.equal(test.runner.getSnapshot().pending, undefined)
})
check('Preview dispatch uses the exact contract input and API mutation cannot alter the frozen draft', async () => {
  const test = setup({ initialState: initial() }); test.runner.setContext(context)
  const operation = test.runner.preview(), sent = test.calls[0].input
  assert.deepEqual(Object.keys(sent).sort(), ['context', 'draft'])
  assert.deepEqual(sent.context, context)
  sent.draft.rules[0].name = 'API 参数副本变化'
  assert.equal(test.runner.getSnapshot().pending.input.draft.rules[0].name, '保留的客户端草稿')
  test.calls[0].pending.resolve(preview); await operation
  assert.deepEqual(test.runner.getSnapshot().preview, preview)
  test.runner.editDraft(test.runner.getSnapshot().draft)
  assert.equal(test.runner.getSnapshot().preview, undefined)
})
check('Save dispatch preserves original versions and double action sends exactly once', async () => {
  const test = setup({ initialState: initial() }), operation = test.runner.save()
  await test.runner.save()
  assert.equal(test.calls.length, 1); assert.equal(test.calls[0].method, 'save')
  assert.equal(test.calls[0].input.expectedRevision, 3); assert.equal(test.calls[0].input.draft.rules[0].expectedVersion, 1)
  test.calls[0].input.draft.rules[0].expectedVersion = 99
  assert.equal(test.runner.getSnapshot().pending.input.draft.rules[0].expectedVersion, 1)
  assert.equal(test.runner.getSnapshot().lastSave, undefined)
  test.calls[0].pending.resolve(fixtures.saveResults.saved); await operation
  assert.equal(test.runner.getSnapshot().lastSave.status, 'saved'); assert.equal(test.runner.getSnapshot().dirty, false)
})
check('Rejected save is local unknown, never a made-up server receipt or automatic retry', async () => {
  const test = setup({ initialState: initial() }), operation = test.runner.save()
  test.calls[0].pending.reject(new Error('IPC returned no receipt')); await operation
  const unknown = test.runner.getSnapshot()
  assert.equal(unknown.error.kind, 'save_outcome_unknown'); assert.equal(unknown.lastSave, undefined)
  assert.equal(unknown.uncertainSave.input.expectedRevision, 3)
  await test.runner.save(); await test.runner.preview()
  assert.equal(test.calls.length, 1)
  const read = test.runner.read(); assert.deepEqual(test.calls.map((call) => call.method), ['save', 'get'])
  test.calls[1].pending.resolve(newerRead()); await read
  assert.equal(test.runner.getSnapshot().draft.rules[0].expectedVersion, 1)
  assert.equal(test.runner.getSnapshot().read.ruleSet.revision, 3)
  await test.runner.save(); assert.equal(test.calls.length, 2)
})
check('Server unknown reply stays intact after explicit reread and still requires reviewed comparison', async () => {
  const test = setup({ initialState: initial() }), operation = test.runner.save()
  test.calls[0].pending.resolve(fixtures.saveResults.unknown); await operation
  const read = test.runner.read(); test.calls[1].pending.resolve(newerRead()); await read
  const current = test.runner.getSnapshot()
  assert.deepEqual(current.lastSave, fixtures.saveResults.unknown)
  assert.equal(current.uncertainSave.input.expectedRevision, 3); assert.equal(current.comparison.current.ruleSet.revision, 4)
  test.runner.resolveComparison({ kind: 'use_reviewed_draft', draft: current.draft })
  assert.equal(test.runner.getSnapshot().draft.rules[0].expectedVersion, 1)
  const explicit = test.runner.save()
  assert.equal(test.calls[2].input.expectedRevision, 4)
  assert.equal(validateRoutingRuleDraftBase(newerRead().ruleSet, test.calls[2].input.draft)[0].code, 'RULE_VERSION_CONFLICT')
  test.calls[2].pending.resolve(fixtures.saveResults.invalid); await explicit
})
check('Conflict and known noncommit responses preserve draft without scheduling a second save', async () => {
  for (const key of ['conflict', 'invalid', 'not_attempted', 'not_committed']) {
    const test = setup({ initialState: initial() }), operation = test.runner.save()
    test.calls[0].pending.resolve(fixtures.saveResults[key]); await operation
    assert.equal(test.calls.length, 1); assert.equal(test.runner.getSnapshot().dirty, true)
    assert.equal(test.runner.getSnapshot().draft.rules[0].name, '保留的客户端草稿')
    assert.deepEqual(test.runner.getSnapshot().lastSave, fixtures.saveResults[key])
  }
})
check('An older disposed read completing after the replacement view cannot overwrite its new draft', async () => {
  let displayed
  const onStateChange = (value) => { displayed = value }
  const old = setup({ onStateChange }), first = old.runner.read()
  old.runner.dispose()
  const next = setup({ onStateChange }), second = next.runner.read()
  next.calls[0].pending.resolve(newerRead()); await second
  next.runner.editDraft({ ...displayed.draft, rules: displayed.draft.rules.map((rule) => ({ ...rule, name: '新界面的草稿' })) })
  const expected = structuredClone(displayed)
  old.calls[0].pending.resolve(fixtures.readV1); await first
  assert.deepEqual(displayed, expected); assert.equal(displayed.draft.rules[0].name, '新界面的草稿')
  assert.equal(displayed.read.ruleSet.revision, 4)
})
check('Disposing an unresolved save retains exact unknown input and ignores later success delivery', async () => {
  const test = setup({ initialState: initial() }), operation = test.runner.save()
  const retained = test.runner.dispose(), noticeCount = test.notices.length
  assert.equal(retained.error.kind, 'save_outcome_unknown'); assert.equal(retained.uncertainSave.input.expectedRevision, 3)
  test.calls[0].pending.resolve(fixtures.saveResults.saved); await operation
  assert.equal(test.notices.length, noticeCount); assert.equal(test.runner.getSnapshot().lastSave, undefined)
  const restored = setup({ initialState: retained })
  await restored.runner.save(); assert.equal(restored.calls.length, 0)
  assert.equal(restored.runner.getSnapshot().uncertainSave.input.draft.rules[0].expectedVersion, 1)
})
check('A restored pending save becomes unknown locally without dispatching the old command', async () => {
  const operation = commands.requestRoutingSave(initial()), test = setup({ initialState: operation.state })
  assert.equal(test.runner.getSnapshot().pending, undefined)
  assert.deepEqual(test.runner.getSnapshot().uncertainSave.input, operation.command.input)
  assert.equal(test.runner.getSnapshot().lastSave, undefined)
  await test.runner.save(); assert.equal(test.calls.length, 0)
})
check('Synchronous API rejection uses controller failure paths without manufacturing success', async () => {
  const control = controlledApi()
  const runner = createRoutingControllerRunner({ api: { ...control.api, previewRoutingRuleSet() { throw new Error('同步拒绝') } },
    initialState: state.setRoutingPreviewContext(initial(), context), onStateChange() {} })
  await runner.preview()
  assert.equal(runner.getSnapshot().error.kind, 'transport'); assert.equal(runner.getSnapshot().preview, undefined)
  assert.equal(runner.getSnapshot().lastSave, undefined); assert.equal(runner.getSnapshot().dirty, true)
})
check('Disposal during pending notification prevents dispatch and all later actions stay inert', async () => {
  const control = controlledApi(); let runner
  runner = createRoutingControllerRunner({ api: control.api, onStateChange() { runner.dispose() } })
  await runner.read(); await runner.save(); await runner.preview()
  assert.equal(control.calls.length, 0)
  const before = runner.getSnapshot(); runner.editDraft({ schemaVersion: 1, rules: [] })
  assert.deepEqual(runner.getSnapshot(), before)
  assert.ok([...source.imported].every((entry) => entry.startsWith('./')))
})

module.exports = { group: 'runner', expectedChecks: 12, cases }
