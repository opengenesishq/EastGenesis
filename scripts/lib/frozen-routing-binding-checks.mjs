import assert from 'node:assert/strict'
import fs from 'node:fs'
import { seed, code, projections, assertUnbound } from './frozen-routing-fixture.mjs'

export async function bindingChecks(api, stage, check) {
  await check('evaluator adapter preserves initial target and provenance fields', async () => {
    const f = await seed(api, stage, 'evaluator-adapter')
    const target = { providerId: 'provider-a', model: 'model-a' }
    const result = { status: 'ready', matchedRules: [{ id: 'rule-a', version: 1, source: { kind: 'user' }, priority: 10, scope: { kind: 'global' }, enabled: true, name: 'rule', when: {}, selection: { kind: 'fixed', target }, strategy: 'balanced', failure: { kind: 'pause' } }], effectivePolicy: { selection: { kind: 'fixed', target }, strategy: 'balanced', failure: { kind: 'pause' }, source: 'matched_rule' }, initialTarget: target, qualifiedTargets: [target], allowedAlternatives: [], rankedCandidates: [], pricing: [], modelDecision: {}, decisionDigest: `sha256:${'a'.repeat(64)}`, task: { requiresTools: true, requiresVision: false, minContextTokens: 1024, taskKinds: ['chat'], riskLevel: 'low', strategy: 'balanced' } }
    const policy = api.fromSession.frozenPolicyFromEvaluation({ meta: f.meta, run: f.run, payload: { text: 'hello', messageId: f.policy.messageId }, context: { executionDomain: 'native_text', originalPrompt: 'hello', businessLine: { id: 'assistant', enabled: true, requiredCapabilities: ['tools'] }, userIntent: { kind: 'global' }, baseStrategy: 'balanced', baseStrategySource: { kind: 'global' }, task: { requiresTools: true } }, snapshots: { providers: [{ id: 'provider-a', name: 'a', models: ['model-a'], ready: true, engine: 'openai', authMode: 'none', baseUrl: 'http://localhost', budgetUsd: 0, createdAt: 1, hasToken: false, credentialStorage: 'memory', credentialRoutingMode: 'preferred' }], expertPolicy: { allowedProviderIds: [], locality: 'any' }, targetEligibility: [{ target, allowed: true, reasons: [], connectionFingerprint: 'identity' }], providerHealth: {}, scoringSignals: [] }, result, ruleSetRevision: 1, ruleSetDigest: 'b'.repeat(64), contextDigest: 'c'.repeat(64), catalogDigest: 'd'.repeat(64), connectionIdentities: new Map([['provider-a', f.policy.qualifiedTargets[0].connectionIdentity]]), protocolForTarget: () => 'openai.chat-completions' })
    assert.equal(policy.initialTarget.providerId, 'provider-a'); assert.equal(policy.matchedRules[0].id, 'rule-a'); assert.equal(policy.effectivePolicy.selection.kind, 'fixed')
  })
  await check('legacy SessionRoute shim refuses to fabricate a frozen policy', async () => {
    const f = await seed(api, stage, 'session-shim')
    assert.equal(api.fromSession.frozenPolicyForSessionRun(f.meta, f.run, { text: 'hello', messageId: f.policy.messageId }), undefined)
  })
  await check('physical request target is constrained by frozen protocol and connection identity', async () => {
    const f = await seed(api, stage, 'request-target')
    const run = await api.binding.bindFrozenRunRoutingPolicy(f.input, f.root)
    const identity = f.policy.qualifiedTargets[0].connectionIdentity
    assert.doesNotThrow(() => api.policy.assertFrozenRunRequestTarget({ run, providerId: 'provider-a', model: 'model-a', protocol: 'openai.chat-completions', connectionIdentity: identity }))
    assert.throws(() => api.policy.assertFrozenRunRequestTarget({ run, providerId: 'provider-a', model: 'model-a', protocol: 'openai.responses', connectionIdentity: identity }), code('POLICY_CONFLICT'))
    assert.throws(() => api.policy.assertFrozenRunRequestTarget({ run, providerId: 'provider-a', model: 'model-a', protocol: 'openai.chat-completions', connectionIdentity: { ...identity, revision: 2 } }), code('POLICY_CONFLICT'))
    assert.throws(() => api.policy.assertFrozenRunRequestTarget({ run, providerId: 'provider-b', model: 'model-a', protocol: 'openai.chat-completions', connectionIdentity: identity }), code('POLICY_CONFLICT'))
  })
  await check('first binding atomically updates canonical Run, recovery Run, snapshot and event', async () => {
    const f = await seed(api, stage, 'bind'), next = await api.binding.bindFrozenRunRoutingPolicy(f.input, f.root)
    assert.equal(next.revision, 2)
    const value = await projections(api, f)
    for (const run of [value.run.taskRun, value.runs[0], value.snapshots[0].run]) assert.equal(run.routingPolicy.policyDigest, f.policy.policyDigest)
    assert.equal(value.events.at(-1).payload.routingPolicyDigest, f.policy.policyDigest)
    assert.equal(value.events.at(-1).kind, 'run.projected')
    const count = value.events.length
    assert.deepEqual(await api.binding.bindFrozenRunRoutingPolicy(f.input, f.root), next)
    assert.equal((await projections(api, f)).events.length, count)
    for (const mode of ['canonical', 'compare', 'legacy']) {
      await api.snap.configureWorkflowLedgerReadMode(mode, f.root)
      assert.equal((await api.snap.getTaskSnapshot(f.run.sessionId, f.root)).run.routingPolicy.policyDigest, f.policy.policyDigest)
    }
  })
  await check('competing policies serialize first bind and never replace an accepted winner', async () => {
    const f = await seed(api, stage, 'race'), other = api.policy.sealFrozenRoutingPolicy({ ...f.draft, originalPromptDigest: 'a'.repeat(64) })
    const result = await Promise.allSettled([api.binding.bindFrozenRunRoutingPolicy(f.input, f.root), api.binding.bindFrozenRunRoutingPolicy({ ...f.input, policy: other }, f.root)])
    assert.equal(result.filter((item) => item.status === 'fulfilled').length, 1)
    assert.equal(result.find((item) => item.status === 'rejected').reason.code, 'POLICY_CONFLICT')
  })
  await check('ordinary first save, upsert and direct projection cannot first bind', async () => {
    const f = await seed(api, stage, 'generic'), bound = { ...f.run, routingPolicy: f.policy }
    await assert.rejects(api.snap.saveTaskSnapshot({ ...f.snapshot, run: bound }, f.root), code('FIRST_BINDING_REQUIRED'))
    await assert.rejects(api.snap.mutateTaskSnapshotDatabase(f.root, (db) => api.ledger.projectTaskRun(db, bound, { projectId: f.meta.workspaceId, workItemId: f.meta.workItemId })), code('FIRST_BINDING_REQUIRED'))
    const absent = { ...bound, id: 'absent' }
    absent.routingPolicy = api.policy.sealFrozenRoutingPolicy({ ...f.draft, owner: { ...f.draft.owner, runId: 'absent' } })
    await assert.rejects(api.snap.mutateTaskSnapshotDatabase(f.root, (db) => api.ledger.projectTaskRun(db, absent, {})), code('FIRST_BINDING_REQUIRED'))
    await assertUnbound(api, f)
  })
  await check('bound policy survives stale omission and rejects fresher replacement and snapshot rehoming', async () => {
    const f = await seed(api, stage, 'immutable'), run = await api.binding.bindFrozenRunRoutingPolicy(f.input, f.root)
    const next = { ...f.run, revision: 3, updatedAt: 300 }
    assert.equal(api.run.mergeTaskRunRecords(run, next).routingPolicy.policyDigest, f.policy.policyDigest)
    await api.snap.saveTaskSnapshot({ ...f.snapshot, updatedAt: 300, run: next }, f.root)
    const changed = api.policy.sealFrozenRoutingPolicy({ ...f.draft, frozenAt: 400 })
    assert.throws(() => api.run.mergeTaskRunRecords(run, { ...run, revision: 999, routingPolicy: changed }), code('POLICY_CONFLICT'))
    assert.equal(api.run.isTaskRunRecord({ ...run, routingPolicy: undefined }), false)
    await assert.rejects(api.snap.saveTaskSnapshot({ ...f.snapshot, meta: { ...f.meta, businessLineId: 'video' }, updatedAt: 500, run: { ...run, revision: 4, updatedAt: 500 } }, f.root), code('OWNER_MISMATCH'))
    assert.equal((await projections(api, f)).run.taskRun.routingPolicy.policyDigest, f.policy.policyDigest)
  })
  for (const field of ['sessionId', 'taskId', 'projectId', 'goalId', 'workItemId', 'businessLineId']) await check(`canonical owner rejects foreign ${field}`, async () => {
    const f = await seed(api, stage, `owner-${field}`)
    const value = field === 'businessLineId' ? 'video' : 'foreign'
    const policy = api.policy.sealFrozenRoutingPolicy({ ...f.draft, owner: { ...f.draft.owner, [field]: value }, baseStrategySource: { kind: 'global' } })
    await assert.rejects(api.binding.bindFrozenRunRoutingPolicy({ ...f.input, policy }, f.root), code('OWNER_MISMATCH'))
    await assertUnbound(api, f)
  })
  await check('revision CAS and missing snapshot refuse before durable binding', async () => {
    const f = await seed(api, stage, 'cas')
    await assert.rejects(api.binding.bindFrozenRunRoutingPolicy({ ...f.input, expectedRunRevision: 2 }, f.root), code('STALE_RUN'))
    await api.snap.mutateTaskSnapshotDatabase(f.root, (db) => {
      db.run('DELETE FROM task_snapshots'); db.run('DELETE FROM workflow_recovery_sessions')
    })
    await assert.rejects(api.binding.bindFrozenRunRoutingPolicy(f.input, f.root), code('MISSING_SNAPSHOT'))
    await assertUnbound(api, f)
  })
  await rollbackChecks(api, stage, check)
}

async function rollbackChecks(api, stage, check) {
  for (const table of ['workflow_events', 'task_runs', 'task_snapshots', 'workflow_recovery_sessions']) await check(`SQL failure at ${table} leaves every binding projection unchanged`, async () => {
    const f = await seed(api, stage, `rollback-${table}`)
    await api.snap.mutateTaskSnapshotDatabase(f.root, (db) => {
      const operation = table === 'workflow_events' ? 'INSERT' : 'UPDATE'
      db.run(`CREATE TRIGGER binding_fault BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture binding fault'); END`)
    })
    const before = fs.readFileSync(api.snap.taskSnapshotsDbFile(f.root))
    await assert.rejects(api.binding.bindFrozenRunRoutingPolicy(f.input, f.root), /fixture binding fault/)
    assert.deepEqual(fs.readFileSync(api.snap.taskSnapshotsDbFile(f.root)), before)
    await assertUnbound(api, f)
  })
}
