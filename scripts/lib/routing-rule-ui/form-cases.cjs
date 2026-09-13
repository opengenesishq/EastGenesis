const assert = require('node:assert/strict')
const { React, renderToStaticMarkup, loader, expand, nodes, text, freeze, providers, businessLines, draft, sharedLoader } = require('./test-runtime.cjs')
const handlerLoader = loader(true), ssrLoader = loader(false)
const Form = handlerLoader.read('RoutingRuleForm.tsx').default
const StaticForm = ssrLoader.read('RoutingRuleForm.tsx').default
const state = handlerLoader.read('routing-form-state.ts')
// Test agreement against the real shared parser; the renderer does not import it.
const { ROUTING_RULE_LIMITS: limits, parseRoutingRuleSetDraft } = sharedLoader.read('routing-policy-parser.ts')
const targetA = { providerId: 'provider-a', model: 'common-model' }
const targetB = { providerId: 'provider-b', model: 'common-model' }
const retry = { kind: 'retry_allowed_targets', maxAdditionalAttempts: 2, retryOn: ['rate_limited'] }
const cases = []
function check(name, action) { cases.push({ name, action }) }
function view(input = draft(), extra = {}) {
  const changes = []
  const props = { draft: freeze(input), providers, businessLines, limits, onChange: (value) => changes.push(value), ...extra }
  const tree = expand(React.createElement(Form, props)), flat = nodes(tree)
  const all = (attribute) => flat.filter((node) => Object.hasOwn(node.props, attribute))
  const one = (attribute) => { const found = all(attribute); assert.equal(found.length, 1, attribute); return found[0] }
  return { tree, flat, changes, props, all, one, text: text(tree), html: renderToStaticMarkup(React.createElement(StaticForm, props)) }
}
function change(node, value) { node.props.onChange({ target: { value } }) }
function parse(rule) { return parseRoutingRuleSetDraft({ schemaVersion: 1, rules: [rule] }) }

check('Five selections expose their own fields without implicit targets', () => {
  const selections = [
    [{ kind: 'global_auto' }, 0], [{ kind: 'provider_auto', providerId: 'provider-a' }, 0],
    [{ kind: 'candidate_set', targets: [targetA, targetB] }, 2],
    [{ kind: 'preferred', primary: targetA, alternatives: [] }, 1], [{ kind: 'fixed', target: targetA }, 1],
  ]
  for (const [selection, expected] of selections) {
    const ui = view(draft({ selection })); assert.equal(ui.all('data-routing-target-picker').length, expected)
    assert.equal(ui.one('data-routing-rule-selection').props.value, selection.kind)
    assert.equal(ui.changes.length, 0); assert.equal(parse(ui.props.draft).ok, true)
  }
})
check('Actual selection handler keeps scoring, failure, identity and expectedVersion', () => {
  const ui = view(draft({ expectedVersion: 4, failure: retry, selection: { kind: 'preferred', primary: targetB, alternatives: [targetA] } }))
  change(ui.one('data-routing-rule-selection'), 'fixed')
  const next = ui.changes[0]
  assert.deepEqual(next.selection, { kind: 'fixed', target: targetB })
  assert.equal(next.strategy, 'quality'); assert.deepEqual(next.failure, retry)
  assert.equal(next.id, ui.props.draft.id); assert.equal(next.expectedVersion, 4)
  assert.equal(Object.hasOwn(next, 'version'), false); assert.equal(Object.hasOwn(next, 'source'), false)
})
check('Existing invalid fixed cross-target retry is shown, preserved and rejected by the shared parser', () => {
  const ui = view(draft({ selection: { kind: 'fixed', target: targetA }, failure: retry }))
  assert.equal(ui.one('data-routing-failure-kind').props.value, 'retry_allowed_targets')
  assert.equal(ui.flat.find((node) => node.type === 'option' && node.props.value === 'retry_allowed_targets').props.disabled, true)
  assert.match(text(ui.one('data-routing-compatibility-error').children), /现有失败策略已保留/)
  assert.equal(ui.changes.length, 0)
  assert.equal(parse(ui.props.draft).diagnostics[0].code, 'FIXED_CROSS_TARGET_RETRY')
})
check('Explicit failure repair changes only the requested failure behavior', () => {
  for (const kind of ['pause', 'retry_same_target']) {
    const ui = view(draft({ selection: { kind: 'fixed', target: targetA }, failure: retry }))
    change(ui.one('data-routing-failure-kind'), kind)
    assert.equal(ui.changes[0].failure.kind, kind); assert.equal(parse(ui.changes[0]).ok, true)
    assert.deepEqual(ui.changes[0].selection.target, targetA)
  }
})
check('Changing provider with a same-named model requires an explicit model choice', () => {
  const ui = view(draft({ selection: { kind: 'fixed', target: targetA } }))
  change(ui.one('data-routing-target-provider'), 'provider-b')
  assert.deepEqual(ui.changes[0].selection.target, { providerId: 'provider-b', model: '' })
  assert.deepEqual(state.changeTargetProvider(targetA, 'provider-a'), targetA)
  const next = view(ui.changes[0]); change(next.one('data-routing-target-model'), 'common-model')
  assert.deepEqual(next.changes[0].selection.target, targetB)
})
check('Same-name models remain distinct provider/model pairs in candidates', () => {
  const ui = view(draft({ selection: { kind: 'candidate_set', targets: [targetA, targetB] } }))
  assert.deepEqual(ui.all('data-routing-target-provider').map((node) => node.props.value), ['provider-a', 'provider-b'])
  assert.deepEqual(ui.all('data-routing-target-summary').map((node) => text(node.children)), ['甲厂商 · 同名模型', '乙厂商 · 同名模型'])
  assert.equal(parse(ui.props.draft).ok, true)
})
check('Missing or unavailable catalog targets remain selected until repaired', () => {
  const invalid = [{ providerId: 'gone', model: 'original-model' }, { providerId: 'provider-a', model: 'gone-model' }, { providerId: 'provider-off', model: 'old-model' }]
  for (const target of invalid) {
    const ui = view(draft({ selection: { kind: 'fixed', target } }))
    assert.equal(ui.one('data-routing-target-provider').props.value, target.providerId)
    assert.equal(ui.one('data-routing-target-model').props.value, target.model)
    assert.match(ui.text, /原|停用/); assert.equal(ui.changes.length, 0)
  }
})
check('Preferred allows no alternatives and adds only a blank explicit target', () => {
  const ui = view(draft({ selection: { kind: 'preferred', primary: targetA, alternatives: [] } }))
  assert.match(ui.text, /尚无备选/); assert.equal(ui.all('data-routing-target-picker').length, 1)
  ui.one('data-routing-add-target').props.onClick()
  assert.deepEqual(ui.changes[0].selection.alternatives, [{ providerId: '', model: '' }])
  assert.equal(parse(ui.props.draft).ok, true)
})
check('Removing the final candidate leaves an incomplete candidate set, not global auto', () => {
  const ui = view(draft({ selection: { kind: 'candidate_set', targets: [targetA] } }))
  ui.one('data-routing-remove-target').props.onClick()
  assert.deepEqual(ui.changes[0].selection, { kind: 'candidate_set', targets: [] })
  assert.equal(parse(ui.changes[0]).ok, false)
  assert.match(view(ui.changes[0]).text, /至少明确选择一个候选/)
})
check('Builtin and custom lines are peers; disabled or missing scope never becomes global', () => {
  const ui = view(); const scope = ui.one('data-routing-rule-scope')
  assert.deepEqual(nodes(scope.children).filter((node) => node.type === 'option').map((node) => node.props.value), ['', ...businessLines.map((line) => line.id)])
  change(scope, 'business-line:market'); assert.deepEqual(ui.changes[0].scope, { kind: 'business_line', businessLineId: 'business-line:market' })
  for (const businessLineId of ['business-line:old', 'business-line:missing']) {
    const old = view(draft({ scope: { kind: 'business_line', businessLineId } }))
    assert.equal(old.one('data-routing-rule-scope').props.value, businessLineId)
    assert.match(old.text, /原归属保留/); assert.equal(old.changes.length, 0)
  }
})
check('When-strategy condition and result scoring strategy are independently editable', () => {
  const ui = view(draft({ when: { whenStrategy: 'cost' }, strategy: 'quality' }))
  assert.equal(ui.one('data-routing-when-strategy').props.value, 'cost')
  assert.equal(ui.one('data-routing-rule-strategy').props.value, 'quality')
  change(ui.one('data-routing-rule-strategy'), 'speed')
  assert.equal(ui.changes[0].when.whenStrategy, 'cost'); assert.equal(ui.changes[0].strategy, 'speed')
})
check('Removing the last condition never silently creates catch-all', () => {
  const ui = view(); ui.one('data-routing-remove-keywords').props.onClick()
  assert.deepEqual(ui.changes[0].when, { keywords: { mode: 'any', values: [] } })
  assert.equal(parse(ui.changes[0]).ok, false)
  assert.deepEqual(state.withoutConditionField({ minRiskLevel: 'high' }, 'minRiskLevel'), { keywords: { mode: 'any', values: [] } })
  const explicit = view(ui.changes[0]); change(explicit.one('data-routing-condition-mode'), 'all')
  assert.deepEqual(explicit.changes[0].when, {}); assert.equal(parse(explicit.changes[0]).ok, true)
})
check('Keywords preserve exact editing text and explicit any/all mode', () => {
  const ui = view(); change(ui.one('data-routing-keyword'), '  营业  报告  ')
  assert.equal(ui.changes[0].when.keywords.values[0], '  营业  报告  ')
  change(ui.one('data-routing-keyword-mode'), 'all')
  assert.equal(ui.changes[1].when.keywords.mode, 'all')
})
check('Retry controls use shared bounds and retain invalid input for validation', () => {
  const ui = view(draft({ failure: retry }))
  assert.equal(ui.one('data-routing-retry-count').props.max, limits.retries)
  assert.deepEqual(ui.all('data-routing-retry-reason').map((node) => node.props['data-routing-retry-reason']), ['rate_limited', 'auth_failed'])
  ui.one('data-routing-retry-count').props.onChange({ target: { valueAsNumber: 99 } })
  assert.equal(ui.changes[0].failure.maxAdditionalAttempts, 99); assert.equal(parse(ui.changes[0]).ok, false)
  ui.all('data-routing-retry-reason')[0].props.onChange({ target: { checked: false } })
  assert.deepEqual(ui.changes[1].failure.retryOn, []); assert.match(view(ui.changes[1]).text, /尚未允许重试/)
})
check('Target and keyword limits disable addition without deleting existing draft data', () => {
  const ui = view(draft({ selection: { kind: 'preferred', primary: targetA, alternatives: [targetB] } }), { limits: { ...limits, targets: 2, keywords: 1 } })
  assert.equal(ui.one('data-routing-add-target').props.disabled, true)
  assert.equal(ui.one('data-routing-add-keyword').props.disabled, true)
  assert.equal(ui.changes.length, 0)
})
check('Main diagnostics include related conflicts while leaving other rules separate', () => {
  const diagnostics = [
    { code: 'PRIORITY_CONFLICT', severity: 'error', path: '$.rules', ruleId: 'other', relatedRuleIds: ['rule-first'], message: '两条规则同时命中，请调整条件或优先级。' },
    { code: 'TARGET_UNAVAILABLE', severity: 'warning', path: '$.rules[2]', ruleId: 'unrelated', message: '其它规则的失效目标' },
  ]
  const ui = view(draft(), { diagnostics })
  assert.equal(ui.all('data-routing-rule-diagnostic').length, 1)
  assert.match(ui.text, /两条规则同时命中/); assert.doesNotMatch(ui.text, /PRIORITY_CONFLICT|其它规则的失效目标/)
  assert.equal(ui.one('data-routing-rule-diagnostic').props.role, 'alert')
})
check('Disabled surface, accessible names and draft-only actions are explicit', () => {
  const ui = view(draft(), { disabled: true })
  assert.equal(ui.flat.find((node) => node.type === 'fieldset' && node.props.className === 'rr-body').props.disabled, true)
  assert.ok(ui.flat.filter((node) => node.type === 'button').every((node) => node.props.type === 'button'))
  const inputIds = ui.flat.filter((node) => ['input', 'select'].includes(node.type) && node.props.id).map((node) => node.props.id)
  assert.equal(new Set(inputIds).size, inputIds.length)
  assert.match(ui.text, /明确适用条件、模型选择和失败后的处理方式/)
  assert.doesNotMatch(ui.text, /外层|评分器|取交集/)
  assert.doesNotMatch(ui.html, /data-routing-(project|step|nl|save|preview|execute)/)
})
check('Renderer imports no parser, IPC, settings, network or filesystem runtime', () => {
  const imports = [...handlerLoader.imported, ...ssrLoader.imported]
  assert.ok(imports.every((entry) => entry.startsWith('./') || ['react', 'react/jsx-runtime'].includes(entry)))
  assert.equal(typeof global.window, 'undefined')
})

module.exports = { group: 'form', expectedChecks: 18, cases }
