import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire, Module } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const root = mkdtempSync(join(tmpdir(), 'caogen-council-'))
const repo = process.cwd(), cache = new Map(), stubs = new Map()
const provider = { id: 'fixture-provider', name: 'Offline fixture', engine: 'openai', baseUrl: 'https://fixture.invalid/v1', models: ['fixture-model'],
  advancedConfig: { modelProfiles: [{ model: 'fixture-model', contextWindow: 200000, pricing: { inputPerMillion: 1, outputPerMillion: 1, source: 'user' } }] } }
const providerModule = { getProvider: () => provider, providerIsReady: () => true,
  getProviderConnectionIdentity: () => ({ generationId: 'fixture-generation', revision: 1 }) }
stubs.set(resolve('src/main/providers.ts'), providerModule)
stubs.set('electron', { app: { getPath: () => root } })
function load(file) {
  if (stubs.has(file)) return stubs.get(file)
  if (cache.has(file)) return cache.get(file).exports
  const mod = new Module(file); cache.set(file, mod)
  mod.filename = file; mod.paths = Module._nodeModulePaths(dirname(file))
  mod.require = (name) => {
    if (stubs.has(name)) return stubs.get(name)
    if (!name.startsWith('.')) return require(name)
    const path = resolve(dirname(file), name)
    return load(path.endsWith('.ts') ? path : `${path}.ts`)
  }
  mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: file }).outputText, file)
  return mod.exports
}
const source = (path) => load(resolve(path))
function method(path, className, methodName, globals) {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true)
  const owner = file.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === className)
  const member = owner.members.find((node) => node.name?.getText(file) === methodName)
  assert(member, `missing production ${className}.${methodName}`)
  const js = ts.transpileModule(`class Subject { ${member.getText(file)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(globals), `${js}; return Subject.prototype.${methodName}`)(...Object.values(globals))
}
let passed = 0
async function check(name, operation) { await operation(); passed++; console.log(`PASS ${name}`) }

try {
  const guard = source('src/main/council/council-request-guard.ts')
  const { stableValueDigest } = source('src/main/task/tool-idempotency.ts')
  const { projectInstitutionTemplate } = source('src/shared/project-institution-template.ts')
  const template = { schemaVersion: 1, templateId: 'cabinet-six-ministries', templateVersion: 1 }
  const { isCouncilRuntimeBinding } = source('src/main/council/council-contract.ts')
  const role = projectInstitutionTemplate(template).roles.find((role) => role.id === 'neige')
  const now = Date.now(), parentId = 'fixture-parent', requestId = 'fixture-request'
  const councilId = `council-${stableValueDigest({ sessionId: parentId, requestId }).slice(0, 32)}`
  const participant = { institutionId: role.id, institutionName: role.name, duty: role.duty, providerId: provider.id,
    providerName: provider.name, engine: 'openai', model: 'fixture-model', budgetUsd: 0.5 }
  const preview = { schemaVersion: 1, sessionId: parentId, requestId, projectId: 'fixture-project', goalId: 'fixture-goal', workItemId: 'fixture-work',
    topic: 'Review the task', template, participants: [participant], blockedReasons: [],
    limits: { rounds: 1, maxParticipants: 2, retries: 0, timeoutMs: 300000, totalBudgetUsd: 0.5, maxOutputTokens: 2048 } }
  const binding = { schemaVersion: 1, context: '{}', connectionDigests: { neige: guard.councilConnectionDigest(provider.id, participant.model) }, requestClaims: [],
    budgetContext: { parentLimitUsd: 0.5, goalSessionIds: [parentId], goalSpentUsd: 0 },
    record: { ...preview, councilId, phase: 'running', startedAt: now, deadlineAt: now + 300000,
      opinions: [{ institutionId: role.id, sessionId: `${councilId}-1`, status: 'running' }] } }
  binding.record.previewDigest = stableValueDigest({ ...preview, context: binding.context, connectionDigests: binding.connectionDigests, budgetContext: binding.budgetContext })
  const meta = { id: `${councilId}-1`, parentSessionId: parentId, orchestrationId: councilId, childRole: 'council:neige',
    workspaceId: preview.projectId, goalId: preview.goalId, workItemId: `${councilId}-1-review`, taskStrategy: 'view', routingScope: 'fixed',
    permissionMode: 'default', providerId: provider.id, model: participant.model, budgetUsd: 0.5, costUsd: 0 }
  let persisted = 0
  guard.registerCouncilRequestBinding(binding, async () => { persisted++ }, () => [meta])
  await check('strict council snapshot preserves bounded identity and rejects changed limits/digest', () => {
    assert(isCouncilRuntimeBinding(binding))
    for (const mutation of [value => { value.record.limits.retries = 2 }, value => { value.record.limits.timeoutMs = 0 },
      value => { value.record.participants[0].budgetUsd = 1 }, value => { value.context = 'changed' },
      value => { value.record.opinions[0].sessionId = 'foreign' }]) {
      const value = structuredClone(binding); mutation(value); assert.equal(isCouncilRuntimeBinding(value), false)
    }
  })
  await check('actual wire body strips every tool surface and fixes explicit output limits', () => {
    for (const [protocol, key] of [['openai.chat-completions', 'max_completion_tokens'], ['openai.responses', 'max_output_tokens'], ['anthropic.messages', 'max_tokens']]) {
      const body = guard.boundedCouncilBody(meta, { model: participant.model, tools: [{}], tool_choice: 'required', functions: [{}], mcp_servers: [{}], max_tokens: 99999 }, provider.id, participant.model, protocol)
      assert.equal(body[key], 2048); for (const key of ['tools', 'tool_choice', 'functions', 'mcp_servers']) assert.equal(body[key], undefined)
    }
    assert.throws(() => guard.boundedCouncilBody(meta, { model: 'other' }, provider.id, participant.model, 'openai.responses'), /模型/)
    provider.baseUrl = 'https://changed.invalid/v1'
    assert.throws(() => guard.boundedCouncilBody(meta, {}, provider.id, participant.model, 'openai.responses'), /变化/)
    provider.baseUrl = 'https://fixture.invalid/v1'
  })
  await check('production OpenAI physical dispatch claims before fetch and never retries', async () => {
    let fetches = 0
    const physical = method('src/main/openaiEngine.ts', 'OpenAIEngine', 'executeProviderFetch', {
      ...guard, getProvider: () => provider, providerCredentialScopeForSession: () => ({}), ensureProviderAuthorizationFresh: async () => undefined,
      issueProviderCredentialLease: () => ({ available: true, lease: {} }), openAIRequestHeaders: () => ({}),
      fetchWithProviderCredentialLease: async () => { assert.equal(persisted, 1); fetches++; throw new Error('unknown transport result') }
    })
    const engine = { meta, effectiveModel: () => participant.model, protocol: () => 'chat' }
    const args = ['https://fixture.invalid/v1/chat/completions', { body: JSON.stringify({ model: participant.model }) }, { provider, providerId: provider.id, authMode: 'none' }, 'operation']
    await assert.rejects(physical.call(engine, ...args), /unknown transport/)
    await assert.rejects(physical.call(engine, ...args), /禁止重试/)
    assert.equal(fetches, 1); assert.deepEqual(binding.requestClaims, [meta.id])
    await assert.rejects(physical.call({ ...engine, meta: { ...meta, taskStrategy: 'execute' } }, ...args), /绑定/)
  })
  await check('actual native tool gate denies read, write, network and recursion before permissions', () => {
    const preflight = method('src/main/native-tool-runtime.ts', 'NativeToolRuntime', 'preflightToolGate', { isCouncilSession: guard.isCouncilSession })
    for (const tool of ['read_file', 'web_search', 'write_file', 'task_dispatch_dag', 'mcp_call_tool']) assert.equal(preflight.call({ meta }, tool, {}, 'tool').allow, false)
  })
  await check('production child completion never enters generic finalizer or sends parent turn', async () => {
    let opinions = 0
    const complete = method('src/main/sessionManager.ts', 'SessionManager', 'dispatchChildResult', {
      isCouncilSession: guard.isCouncilSession, shouldDispatchChildResult: () => true
    })
    const runtime = { sessions: new Map([[parentId, {}]]), council: { complete: async () => { opinions++ } }, agentCapacity: { scheduleDrain() {} },
      dispatch() { assert.fail('parent event dispatch') }, subagentOrchestration: { recordChildResult() { assert.fail('generic finalizer') } } }
    complete.call(runtime, meta.id, { meta }, { kind: 'turn-result', resultText: 'Conclusion', isError: false })
    await Promise.resolve(); assert.equal(opinions, 1)
  })
  await check('durable shared request budget covers parent, peers, unknown charges and unpriced requests', () => {
    const budget = source('src/main/budget/request-budget-store.ts')
    const scope = (sessionId) => ({ sessionId, sessionTextCostUsd: 0, sessionLimitUsd: 1, monthlyTextSpentUsd: 0, observedSessions: [],
      aggregateBudgets: [{ id: 'original-task', sessionIds: ['budget-parent', 'peer-a', 'peer-b'], limitUsd: 0.5, textSpentUsd: 0 }] })
    budget.reserveRequestBudget({ rootDir: root, id: 'parent-request', kind: 'model', providerId: 'offline', estimatedUsd: 0.2, scope: scope('budget-parent') })
    budget.reserveRequestBudget({ rootDir: root, id: 'peer-request', kind: 'model', providerId: 'offline', estimatedUsd: 0.25, scope: scope('peer-a') })
    assert.throws(() => budget.reserveRequestBudget({ rootDir: root, id: 'exceeds', kind: 'model', providerId: 'offline', estimatedUsd: 0.1, scope: scope('peer-b') }), /预算/)
    assert.throws(() => budget.reserveRequestBudget({ rootDir: root, id: 'unpriced', kind: 'model', providerId: 'offline', scope: scope('peer-b') }), /预算/)
    budget.settleRequestBudget({ rootDir: root, id: 'peer-request', status: 'unknown' })
    assert.throws(() => budget.reserveRequestBudget({ rootDir: root, id: 'parent-again', kind: 'model', providerId: 'offline', estimatedUsd: 0.01, scope: scope('budget-parent') }), /预算/)
    const snapshot = budget.readRequestBudgetSnapshot(root, scope('peer-b'))
    assert.equal(snapshot.monthlySpentUsd, 0.45, 'aggregate must not charge monthly cost twice')
    assert.deepEqual(snapshot.aggregateRemainingUsd, [0])
  })
  await check('stopped, expired, unknown and missing restored authority forbid physical requests', async () => {
    for (const phase of ['stopped', 'needs_reconciliation', 'completed']) {
      binding.record.phase = phase
      await assert.rejects(guard.claimCouncilPhysicalRequest(meta), /停止/)
    }
    binding.record.phase = 'running'; binding.record.deadlineAt = Date.now() - 1
    await assert.rejects(guard.claimCouncilPhysicalRequest(meta), /截止/)
    await assert.rejects(guard.claimCouncilPhysicalRequest({ ...meta, orchestrationId: 'council-missing' }), /绑定/)
  })
  console.log(`Council focused offline checks: ${passed}/${passed} passed; no Provider calls.`)
} finally { rmSync(root, { recursive: true, force: true }) }
