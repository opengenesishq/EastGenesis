const assert = require('node:assert/strict')
const { loader, fixtureLoader, sharedLoader } = require('./test-runtime.cjs')
const source = loader(false), fixtures = fixtureLoader().read('display-fixtures.ts')
const state = source.read('routing-controller-state.ts'), commands = source.read('routing-controller-commands.ts'), results = source.read('routing-controller-results.ts')
const { parseRoutingRuleSaveInput, validateRoutingRuleDraftBase } = sharedLoader.read('routing-policy-command-parser.ts')
const { readV1, readLegacy, invalidRead, saveResults } = fixtures
const cases = []
function check(name, action) { cases.push({ name, action }) }
function loaded(read = readV1) {
  const transition = commands.requestRoutingRead(state.createRoutingControllerState())
  return results.receiveRoutingRead(transition.state, transition.command.requestId, read)
}
function edited() {
  const base = loaded(); return state.editRoutingDraft(base, { ...base.draft, rules: base.draft.rules.map((rule) => ({ ...rule, name: '用户新草稿' })) })
}
function saveStart() { return commands.requestRoutingSave(edited()) }
function unknown() { const operation = saveStart(); return results.receiveRoutingSave(operation.state, operation.command.requestId, saveResults.unknown) }
function refreshedUnknown() {
  const old = unknown(), operation = commands.requestRoutingRead(old)
  return results.receiveRoutingRead(operation.state, operation.command.requestId, newerRead())
}
function newerRead() {
  return { ...readV1, ruleSet: { ...readV1.ruleSet, revision: 4, rules: readV1.ruleSet.rules.map((rule) => ({ ...rule, version: 2, name: '他处的新版本' })) } }
}
function context() { return { kind: 'new_task', businessLineId: 'assistant', prompt: '核对报告', routingIntent: { kind: 'global' } } }
const previewFixture = {
  status: 'ready', draftDigest: 'a'.repeat(64), catalogDigest: 'b'.repeat(64), contextDigest: 'c'.repeat(64), previewDigest: 'd'.repeat(64),
  matchedRules: [], allowedAlternatives: [], excludedTargets: [], conflicts: [], diagnostics: [],
  limitations: { kind: 'local_configuration_only', providerRequestsMade: false, realTaskVerified: false }
}

check('Initial state makes no invented read, draft, receipt or service call', () => {
  const initial = state.createRoutingControllerState()
  assert.equal(initial.read, null); assert.equal(initial.draft, null); assert.equal(initial.lastSave, undefined)
  assert.equal(commands.requestRoutingSave(initial).command, undefined)
})
check('A real read response supplies saved expectedVersions while omitting main-only source', () => {
  const base = loaded()
  assert.equal(base.read.ruleSet.revision, 3); assert.equal(base.draft.rules[0].expectedVersion, 1)
  assert.equal(Object.hasOwn(base.draft.rules[0], 'version'), false); assert.equal(Object.hasOwn(base.draft.rules[0], 'source'), false)
  assert.equal(base.dirty, false)
})
check('Legacy read preserves original migration and creates no saved V1 entity', () => {
  const base = loaded(readLegacy)
  assert.equal(base.read.mode, 'legacy_active'); assert.equal(Object.hasOwn(base.read, 'ruleSet'), false)
  assert.deepEqual(base.read.migration, readLegacy.migration)
  assert.deepEqual(base.migration, { legacyDigest: readLegacy.legacyDigest, resolutions: [] })
  assert.equal(base.lastSave, undefined)
})
check('Invalid V1 does not fall back or permit preview/save', () => {
  const base = loaded(invalidRead)
  assert.equal(base.read.mode, 'invalid_v1'); assert.equal(base.draft, null)
  assert.equal(commands.requestRoutingSave(base).command, undefined)
  assert.equal(commands.requestRoutingPreview(state.setRoutingPreviewContext(base, context())).command, undefined)
})
check('Save command preserves exact base revision/rule version and freezes a separate input', () => {
  const operation = saveStart()
  assert.equal(operation.command.input.expectedRevision, 3)
  assert.equal(operation.command.input.draft.rules[0].expectedVersion, 1)
  assert.equal(parseRoutingRuleSaveInput(operation.command.input).ok, true)
  operation.command.input.draft.rules[0].name = '外部修改发送对象'
  assert.equal(operation.state.pending.input.draft.rules[0].name, '用户新草稿')
  assert.equal(operation.state.draft.rules[0].name, '用户新草稿')
})
check('Pending operation cannot double-submit, mutate draft or replace context', () => {
  const operation = saveStart()
  assert.equal(commands.requestRoutingSave(operation.state).command, undefined)
  assert.equal(commands.requestRoutingRead(operation.state).command, undefined)
  assert.equal(state.editRoutingDraft(operation.state, { schemaVersion: 1, rules: [] }), operation.state)
  assert.equal(state.setRoutingPreviewContext(operation.state, context()), operation.state)
})
check('Wrong request IDs and response kinds are ignored', () => {
  const operation = saveStart()
  assert.equal(results.receiveRoutingSave(operation.state, operation.command.requestId + 1, saveResults.saved), operation.state)
  assert.equal(results.receiveRoutingRead(operation.state, operation.command.requestId, readV1), operation.state)
  assert.equal(results.receiveRoutingPreview(operation.state, operation.command.requestId, previewFixture), operation.state)
})
check('Only an actual saved event can replace base and clear dirty draft', () => {
  const operation = saveStart(), reply = structuredClone(saveResults.saved)
  const next = results.receiveRoutingSave(operation.state, operation.command.requestId, reply)
  assert.equal(next.dirty, false); assert.equal(next.lastSave.status, 'saved'); assert.equal(next.pending, undefined)
  reply.ruleSet.rules[0].when.keywords.values[0] = '服务对象之后变化'
  assert.equal(next.draft.rules[0].when.keywords.values[0], '报告')
})
check('Conflict preserves old base, client draft and expectedVersion until explicit review', () => {
  const operation = saveStart(), conflict = { ...saveResults.conflict, current: newerRead() }
  const next = results.receiveRoutingSave(operation.state, operation.command.requestId, conflict)
  assert.equal(next.read.ruleSet.revision, 3); assert.equal(next.draft.rules[0].expectedVersion, 1)
  assert.equal(next.draft.rules[0].name, '用户新草稿'); assert.equal(next.comparison.current.ruleSet.revision, 4)
  assert.equal(commands.requestRoutingSave(next).command, undefined)
})
check('Invalid and confirmed noncommit outcomes preserve draft and need explicit new request', () => {
  for (const kind of ['invalid', 'not_attempted', 'not_committed']) {
    const operation = saveStart(), next = results.receiveRoutingSave(operation.state, operation.command.requestId, saveResults[kind])
    assert.equal(next.pending, undefined); assert.equal(next.dirty, true); assert.equal(next.draft.rules[0].name, '用户新草稿')
    const retry = commands.requestRoutingSave(next)
    assert.equal(retry.command.kind, 'save'); assert(retry.command.requestId > operation.command.requestId)
  }
})
check('Unknown save retains original exact input/revision and only permits a read', () => {
  const next = unknown()
  assert.equal(next.uncertainSave.input.expectedRevision, 3)
  assert.equal(next.uncertainSave.input.draft.rules[0].expectedVersion, 1)
  assert.equal(next.uncertainSave.originalRead.ruleSet.revision, 3)
  assert.equal(commands.requestRoutingSave(next).command, undefined)
  assert.equal(commands.requestRoutingPreview(next).command, undefined)
  assert.equal(commands.requestRoutingRead(next).command.kind, 'read')
})
check('Reread does not rebind versions, clear unknown, synthesize saved or retry', () => {
  const next = refreshedUnknown()
  assert.equal(next.read.ruleSet.revision, 3); assert.equal(next.draft.rules[0].expectedVersion, 1)
  assert.equal(next.lastSave.status, 'storage_error'); assert.equal(next.lastSave.commitState, 'unknown')
  assert.equal(next.comparison.kind, 'unknown'); assert.equal(next.comparison.current.ruleSet.revision, 4)
  assert.equal(commands.requestRoutingSave(next).command, undefined)
})
check('Explicit use of reviewed draft does not silently update rule expectedVersions', () => {
  const next = refreshedUnknown(), reviewed = state.resolveRoutingComparison(next, { kind: 'use_reviewed_draft', draft: next.draft })
  assert.equal(reviewed.read.ruleSet.revision, 4); assert.equal(reviewed.draft.rules[0].expectedVersion, 1)
  assert.equal(reviewed.uncertainSave.input.expectedRevision, 3); assert.equal(reviewed.uncertainSave.reviewed, true)
  assert.equal(reviewed.lastSave, undefined)
  const newRequest = commands.requestRoutingSave(reviewed)
  assert.equal(newRequest.command.input.expectedRevision, 4)
  assert.equal(validateRoutingRuleDraftBase(newerRead().ruleSet, newRequest.command.input.draft)[0].code, 'RULE_VERSION_CONFLICT')
})
check('Explicit adoption takes latest versions but never fabricates a saved receipt', () => {
  const next = state.resolveRoutingComparison(refreshedUnknown(), { kind: 'adopt_latest' })
  assert.equal(next.draft.rules[0].expectedVersion, 2); assert.equal(next.dirty, false)
  assert.equal(next.lastSave, undefined); assert.equal(next.uncertainSave.input.expectedRevision, 3)
  assert.equal(commands.requestRoutingSave(next).command, undefined)
})
check('Save IPC rejection is local unknown evidence, not a made-up server result', () => {
  const operation = saveStart(), next = results.rejectRoutingOperation(operation.state, operation.command.requestId, 'IPC timeout')
  assert.equal(next.error.kind, 'save_outcome_unknown'); assert.equal(next.lastSave, undefined)
  assert.equal(next.uncertainSave.input.expectedRevision, 3)
  assert.equal(commands.requestRoutingSave(next).command, undefined)
  assert.equal(commands.requestRoutingRead(next).command.kind, 'read')
})
check('Dirty refresh preserves draft/base and requires explicit comparison', () => {
  const initial = edited(), operation = commands.requestRoutingRead(initial)
  const next = results.receiveRoutingRead(operation.state, operation.command.requestId, newerRead())
  assert.equal(next.read.ruleSet.revision, 3); assert.equal(next.draft.rules[0].name, '用户新草稿')
  assert.equal(next.comparison.kind, 'refresh'); assert.equal(commands.requestRoutingSave(next).command, undefined)
})
check('Preview echoes only genuine supplied receipt and edits invalidate it', () => {
  const base = state.setRoutingPreviewContext(edited(), context()), operation = commands.requestRoutingPreview(base)
  assert.equal(operation.command.input.context.routingIntent.kind, 'global')
  const next = results.receiveRoutingPreview(operation.state, operation.command.requestId, previewFixture)
  assert.deepEqual(commands.requestRoutingSave(next).command.input.preview,
    { draftDigest: previewFixture.draftDigest, catalogDigest: previewFixture.catalogDigest, contextDigest: previewFixture.contextDigest, previewDigest: previewFixture.previewDigest })
  assert.equal(state.editRoutingDraft(next, next.draft).preview, undefined)
  assert.equal(state.setRoutingPreviewContext(next, { ...context(), prompt: '新任务上下文' }).preview, undefined)
})
check('Legacy saves require all explicit dispositions and retain revision zero', () => {
  let next = loaded(readLegacy)
  next = state.editRoutingDraft(next, { schemaVersion: 1, rules: [{ ...fixtures.shellDraft, expectedVersion: null }] })
  assert.equal(commands.requestRoutingSave(next).command, undefined)
  next = state.editRoutingMigration(next, { legacyDigest: readLegacy.legacyDigest, resolutions: [
    { legacyIndex: 0, kind: 'replace', ruleId: 'rule-first' }, { legacyIndex: 1, kind: 'retire' }] })
  const operation = commands.requestRoutingSave(next)
  assert.equal(operation.command.input.expectedRevision, 0); assert.equal(operation.command.input.draft.rules[0].expectedVersion, null)
  assert.equal(parseRoutingRuleSaveInput(operation.command.input).ok, true)
})
module.exports = { group: 'controller', expectedChecks: 18, cases }
