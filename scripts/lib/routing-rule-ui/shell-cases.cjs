const assert = require('node:assert/strict')
const { React, renderToStaticMarkup, loader, expand, nodes, text, freeze, providers, businessLines, fixtureLoader, sharedLoader } = require('./test-runtime.cjs')
const handlerLoader = loader(true), ssrLoader = loader(false)
const Shell = handlerLoader.read('RoutingRuleEditorShell.tsx').default
const StaticShell = ssrLoader.read('RoutingRuleEditorShell.tsx').default
const Form = handlerLoader.read('RoutingRuleForm.tsx').default
const StaticForm = ssrLoader.read('RoutingRuleForm.tsx').default
const StaticSources = ssrLoader.read('RoutingPreviewRuleSources.tsx').default
const fixture = fixtureLoader().read('display-fixtures.ts')
const { legacyReviewProgress } = handlerLoader.read('routing-editor-state.ts')
const { ROUTING_RULE_LIMITS: limits } = sharedLoader.read('routing-policy-parser.ts')
const { parseRoutingRuleSaveInput } = sharedLoader.read('routing-policy-command-parser.ts')
const cases = []
function check(name, action) { cases.push({ name, action }) }
function view(patch = {}) {
  const calls = [], on = (name) => (...args) => calls.push({ name, args })
  const props = { read: fixture.readV1, draft: { schemaVersion: 1, rules: [fixture.shellDraft] }, selectedRuleId: 'rule-first',
    businessLines, dirty: true, onSelectRule: on('select'), onAddRule: on('add'), onRemoveRule: on('remove'),
    onResolveLegacy: on('resolveLegacy'), onPreview: on('preview'), onSave: on('save'), onReviewConflict: on('reviewConflict'), onReread: on('reread'), ...patch }
  freeze(props.read); freeze(props.draft); freeze(props.migration); freeze(props.lastSave)
  const formProps = { draft: props.draft.rules[0] ?? fixture.shellDraft, providers, businessLines, limits, onChange: on('edit') }
  const tree = expand(React.createElement(Shell, { ...props, editor: React.createElement(Form, formProps) })), flat = nodes(tree)
  const all = (attribute) => flat.filter((node) => Object.hasOwn(node.props, attribute))
  const one = (attribute) => { const found = all(attribute); assert.equal(found.length, 1, attribute); return found[0] }
  const html = renderToStaticMarkup(React.createElement(StaticShell, { ...props, editor: React.createElement(StaticForm, formProps) }))
  return { props, calls, tree, flat, all, one, html, text: text(tree) }
}
function click(ui, attribute) { ui.one(attribute).props.onClick() }
function legacy(resolutions, legacyDigest = fixture.readLegacy.legacyDigest) { return { read: fixture.readLegacy, migration: { legacyDigest, resolutions } } }
const fullResolution = [{ kind: 'replace', legacyIndex: 0, ruleId: 'rule-first' }, { kind: 'retire', legacyIndex: 1 }]

check('All public read/save unions render in actual React without automatic callbacks', () => {
  for (const read of [fixture.readV1, fixture.readLegacy, fixture.invalidRead]) {
    for (const lastSave of [undefined, ...Object.values(fixture.saveResults)]) {
      const ui = view({ read, lastSave }); assert.match(ui.html, /模型路由规则/); assert.deepEqual(ui.calls, [])
    }
  }
})
check('Invalid V1 retains the draft and prohibits writes instead of falling back to legacy', () => {
  const ui = view({ read: fixture.invalidRead })
  assert.equal(ui.one('data-routing-editor-save').props.disabled, true)
  assert.equal(ui.one('data-routing-editor-detail').props.disabled, true)
  assert.equal(ui.all('data-routing-legacy-review').length, 0)
  click(ui, 'data-routing-editor-save'); click(ui, 'data-routing-editor-preview'); click(ui, 'data-routing-editor-add')
  assert.deepEqual(ui.calls, []); assert.equal(ui.props.draft.rules[0], fixture.shellDraft)
  click(ui, 'data-routing-editor-reread'); assert.deepEqual(ui.calls, [{ name: 'reread', args: [] }])
  assert.match(ui.text, /草稿已保留/); assert.doesNotMatch(ui.text, /revision|invalid_v1|版本 0/)
})
check('Unknown commit blocks retry and mutation while exposing only explicit reread', () => {
  const ui = view({ lastSave: fixture.saveResults.unknown })
  for (const attribute of ['data-routing-editor-save', 'data-routing-editor-add', 'data-routing-editor-remove', 'data-routing-editor-preview']) {
    assert.equal(ui.one(attribute).props.disabled, true); click(ui, attribute)
  }
  assert.deepEqual(ui.calls, []); assert.match(ui.text, /尚不能确认此次保存是否完成/)
  click(ui, 'data-routing-editor-reread')
  assert.deepEqual(ui.calls, [{ name: 'reread', args: [] }]); assert.equal(ui.props.draft.rules[0], fixture.shellDraft)
})
check('A new read alone does not clear an unknown commit or turn reread into save', () => {
  const ui = view({ read: { ...fixture.readV1, ruleSet: { ...fixture.savedSet, revision: 4 } }, lastSave: fixture.saveResults.unknown })
  assert.equal(ui.one('data-routing-editor-save').props.disabled, true)
  click(ui, 'data-routing-editor-reread'); assert.deepEqual(ui.calls.map((item) => item.name), ['reread'])
  const reconciled = view({ lastSave: fixture.saveResults.saved, dirty: false })
  assert.match(reconciled.text, /最近一次保存已完成/); assert.deepEqual(reconciled.calls, [])
  assert.equal(reconciled.one('data-routing-editor-save').props.disabled, true)
})
check('Known non-commits require a fresh explicit save click, never automatic retry', () => {
  for (const state of ['not_attempted', 'not_committed']) {
    const ui = view({ lastSave: fixture.saveResults[state] })
    assert.deepEqual(ui.calls, []); assert.equal(ui.one('data-routing-editor-save').props.disabled, false)
    click(ui, 'data-routing-editor-save'); assert.deepEqual(ui.calls, [{ name: 'save', args: [] }])
    assert.equal(ui.props.draft.rules[0], fixture.shellDraft)
  }
})
check('Conflict keeps the current draft and requires review rather than overwriting or retrying', () => {
  const ui = view({ lastSave: fixture.saveResults.conflict })
  assert.equal(ui.one('data-routing-editor-save').props.disabled, true)
  click(ui, 'data-routing-editor-save'); assert.deepEqual(ui.calls, [])
  click(ui, 'data-routing-editor-review-conflict')
  assert.deepEqual(ui.calls, [{ name: 'reviewConflict', args: [] }]); assert.equal(ui.props.draft.rules[0], fixture.shellDraft)
  assert.match(ui.text, /你的草稿已保留/)
})
check('Saved receipt never labels later dirty edits as saved', () => {
  const ui = view({ lastSave: fixture.saveResults.saved, dirty: true })
  assert.match(ui.text, /随后还有修改尚未保存/); assert.match(ui.text, /有未保存的修改/)
  assert.deepEqual(ui.calls, [])
})
check('Every legacy row remains visible and incomplete disposition blocks save', () => {
  const ui = view({ read: fixture.readLegacy })
  assert.equal(ui.all('data-routing-legacy-index').length, 2)
  assert.match(text(ui.one('data-routing-legacy-progress').children), /0 \/ 2/)
  assert.equal(ui.one('data-routing-editor-save').props.disabled, true)
  click(ui, 'data-routing-editor-save'); assert.deepEqual(ui.calls, [])
  assert.match(ui.text, /旧规则仍在使用/); assert.doesNotMatch(ui.text, /ambiguous-model/)
})
check('Actual legacy buttons emit precise replace/retire intents without changing either source', () => {
  const ui = view({ read: fixture.readLegacy })
  ui.all('data-routing-legacy-replace')[0].props.onClick()
  ui.all('data-routing-legacy-retire')[1].props.onClick()
  assert.deepEqual(ui.calls, fullResolution.map((resolution) => ({ name: 'resolveLegacy', args: [resolution] })))
  assert.equal(ui.props.migration, undefined); assert.equal(ui.props.read, fixture.readLegacy)
})
check('Complete legacy disposition enables explicit save and agrees with the shared save parser', () => {
  const ui = view(legacy(fullResolution))
  assert.deepEqual(legacyReviewProgress(ui.props), { complete: true, resolved: 2, total: 2, reason: undefined })
  assert.equal(ui.one('data-routing-editor-save').props.disabled, false)
  const input = { expectedRevision: 0, draft: ui.props.draft, migration: ui.props.migration }
  assert.equal(parseRoutingRuleSaveInput(input).ok, true)
  click(ui, 'data-routing-editor-save'); assert.deepEqual(ui.calls, [{ name: 'save', args: [] }])
})
check('Stale digest, missing, duplicate, extra and unavailable legacy choices stay blocked', () => {
  const invalid = [legacy(fullResolution, 'old'), legacy(fullResolution.slice(0, 1)),
    legacy([fullResolution[0], fullResolution[0]]), legacy([...fullResolution, { kind: 'retire', legacyIndex: 9 }]),
    legacy([{ ...fullResolution[0], ruleId: 'removed' }, fullResolution[1]]),
    legacy([fullResolution[0], { ...fullResolution[0], legacyIndex: 1 }])]
  for (const patch of invalid) {
    const ui = view(patch); assert.equal(ui.one('data-routing-editor-save').props.disabled, true)
    click(ui, 'data-routing-editor-save'); assert.deepEqual(ui.calls, [])
    assert.equal(ui.props.migration, patch.migration)
  }
})
check('Legacy replacement needs an actual selection and remains blocked while outcome is unknown', () => {
  for (const patch of [{ selectedRuleId: null }, { lastSave: fixture.saveResults.unknown }]) {
    const ui = view({ read: fixture.readLegacy, ...patch })
    const button = ui.all('data-routing-legacy-replace')[0]; assert.equal(button.props.disabled, true)
    button.props.onClick(); assert.deepEqual(ui.calls, [])
  }
})
check('Builtin/custom labels and explicit list actions keep stable IDs', () => {
  const custom = { ...fixture.shellDraft, id: 'custom-rule', scope: { kind: 'business_line', businessLineId: 'business-line:market' } }
  const ui = view({ draft: { schemaVersion: 1, rules: [fixture.shellDraft, custom] } })
  assert.deepEqual(ui.all('data-routing-editor-rule').map((node) => node.props['data-routing-editor-rule']), ['rule-first', 'custom-rule'])
  ui.all('data-routing-editor-rule')[1].props.onClick()
  assert.deepEqual(ui.calls, [{ name: 'select', args: ['custom-rule'] }])
  assert.match(ui.text, /全局/); assert.match(ui.text, /市场分析/)
})
check('Advanced controls are closed by default while primary sections stay clear', () => {
  const ui = view()
  for (const attribute of ['data-routing-advanced-preferences', 'data-routing-advanced-conditions']) {
    assert.equal(ui.one(attribute).type, 'details'); assert.notEqual(ui.one(attribute).props.open, true)
  }
  assert.deepEqual(ui.flat.filter((node) => node.type === 'h4').map((node) => text(node.children)), ['当', '使用', '失败后'])
  assert.doesNotMatch(ui.text, /外层|评分器|取交集/)
  assert.match(ui.text, /原生对话、代码任务和视频策划；媒体生成暂不适用/)
  assert.match(ui.text, /已运行的任务保留启动时的路由策略/)
})
check('Busy and clean states never dispatch a save by disabled handler invocation', () => {
  for (const patch of [{ busy: 'loading' }, { busy: 'saving' }, { busy: 'previewing' }, { dirty: false }]) {
    const ui = view(patch); assert.equal(ui.one('data-routing-editor-save').props.disabled, true)
    click(ui, 'data-routing-editor-save'); assert.deepEqual(ui.calls, [])
  }
})
check('All runtime imports remain local UI or React; callbacks never simulate a save service', () => {
  assert.ok([...handlerLoader.imported, ...ssrLoader.imported].every((entry) => entry.startsWith('./') || ['react', 'react/jsx-runtime'].includes(entry)))
  assert.equal(typeof global.window, 'undefined')
})
check('Only the explicit main migration diagnostic marks a user source as pending', () => {
  const rule = { id: 'rule-first', expectedVersion: null, scope: { kind: 'global' }, source: { kind: 'user' } }
  const diagnostic = { code: 'LEGACY_REVIEW_REQUIRED', path: '$.migration', severity: 'info', message: '来源将在保存时按逐条处置确认。' }
  const preview = freeze({ matchedRules: [rule], diagnostics: [diagnostic] })
  const html = renderToStaticMarkup(React.createElement(StaticSources, { preview, rules: [fixture.shellDraft] }))
  assert.match(html, /迁移来源待确认/); assert.doesNotMatch(html, /手动配置/)
  assert.deepEqual(preview.matchedRules[0].source, { kind: 'user' })
})
check('Migration notices never replace existing exact legacy source evidence', () => {
  const source = { kind: 'legacy_settings', legacyDigest: 'e'.repeat(64), legacyIndex: 2, legacyId: 'original-rule' }
  const preview = freeze({ matchedRules: [{ id: 'rule-first', expectedVersion: 1, scope: { kind: 'global' }, source }],
    diagnostics: [{ code: 'LEGACY_REVIEW_REQUIRED', path: '$.migration', severity: 'info', message: '待处置' }] })
  const html = renderToStaticMarkup(React.createElement(StaticSources, { preview }))
  assert.match(html, /旧规则第 3 条/); assert.match(html, new RegExp(source.legacyDigest)); assert.match(html, /original-rule/)
  assert.doesNotMatch(html, /迁移来源待确认|<details[^>]*\bopen\b/)
  assert.deepEqual(preview.matchedRules[0].source, source)
})
check('Unrelated legacy diagnostics leave authored sources unchanged', () => {
  for (const diagnostics of [[], [{ code: 'LEGACY_REVIEW_REQUIRED', path: '$.rules[0]', severity: 'info', message: '其它提示' }]]) {
    const preview = { matchedRules: [{ id: 'rule-first', expectedVersion: null, scope: { kind: 'global' }, source: { kind: 'user' } }], diagnostics }
    const html = renderToStaticMarkup(React.createElement(StaticSources, { preview }))
    assert.match(html, /手动配置/); assert.doesNotMatch(html, /迁移来源待确认/)
  }
})

module.exports = { group: 'shell', expectedChecks: 19, cases }
