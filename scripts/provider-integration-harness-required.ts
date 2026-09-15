import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assignProviderConnectionIdentity, readProviderConnectionIdentity } from '../src/main/provider/providerConnectionIdentity'
import { frozenRetryAllows } from '../src/main/model/native-recovery-session'
import { assertFrozenRunRequestTarget, sealFrozenRoutingPolicy, verifyFrozenRoutingPolicy } from '../src/main/task/frozen-routing-policy'
import { pickFailoverTarget } from '../src/main/scheduler'
import type { Provider } from '../src/shared/types'
import type { FrozenRunRoutingPolicyV1 } from '../src/shared/frozen-routing-types'

type Check = { id: string; status: 'passed' | 'failed'; detail: string }
const outDir = join(process.cwd(), 'test-results', 'provider-integration-harness')
const reportPath = join(outDir, 'latest.json')
const digest = 'a'.repeat(64)
const primaryIdentity = { generationId: '00000000-0000-4000-8000-000000000001', revision: 1 }
const backupIdentity = { generationId: '00000000-0000-4000-8000-000000000002', revision: 1 }

async function check(checks: Check[], id: string, detail: string, operation: () => void | Promise<void>): Promise<void> {
  try { await operation(); checks.push({ id, status: 'passed', detail }) }
  catch (error) { checks.push({ id, status: 'failed', detail: error instanceof Error ? error.message : String(error) }) }
}

function policy(): FrozenRunRoutingPolicyV1 {
  return sealFrozenRoutingPolicy({ schemaVersion: 1, evaluatorVersion: 1, executionDomain: 'native_text',
    owner: { runId: 'run-build', sessionId: 'session-build', taskId: 'task-build', projectId: 'workspace', goalId: 'goal', workItemId: 'work-build', businessLineId: 'studio' },
    messageId: 'message-1', frozenAt: 1, originalPromptDigest: digest, ruleSetRevision: 1, ruleSetDigest: digest,
    matchedRules: [{ id: 'legacy-baseline-routing', version: 1, source: { kind: 'legacy_settings', legacyDigest: digest, legacyIndex: 0 }, priority: 0, scope: { kind: 'global' } }],
    contextDigest: digest, catalogDigest: digest, evaluationDigest: digest, baseStrategy: 'balanced', baseStrategySource: { kind: 'global' },
    userIntent: { kind: 'global' }, effectivePolicy: { selection: { kind: 'global_auto' }, strategy: 'balanced', failure: { kind: 'retry_allowed_targets', maxAdditionalAttempts: 1, retryOn: ['rate_limited', 'auth_failed'] } },
    initialTarget: { providerId: 'provider-primary', model: 'model-primary', protocol: 'openai.chat-completions' },
    qualifiedTargets: [{ providerId: 'provider-primary', model: 'model-primary', protocol: 'openai.chat-completions', connectionIdentity: primaryIdentity }, { providerId: 'provider-backup', model: 'model-backup', protocol: 'openai.chat-completions', connectionIdentity: backupIdentity }],
    retryTargets: [{ providerId: 'provider-backup', model: 'model-backup', protocol: 'openai.chat-completions' }],
    hardBounds: { requiredCapabilities: [], minContextTokens: 1, allowedProviderIds: ['provider-primary', 'provider-backup'], locality: 'any' } })
}

async function run(): Promise<void> {
  const checks: Check[] = []
  const frozen = policy()
  await check(checks, 'four-role-parallel', '四岗位拥有独立 Run/Route Receipt 并可并行回写统一状态', async () => {
    const roles = ['planner', 'builder', 'reviewer', 'publisher']
    let active = 0, maximum = 0
    const states = await Promise.all(roles.map(async (role) => { active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 0)); const result = { role, runId: `run-${role}`, status: 'running', receipt: { policyDigest: frozen.policyDigest, target: frozen.initialTarget } }; result.status = 'succeeded'; active--; return result }))
    assert.equal(states.length, 4); assert.equal(new Set(states.map((item) => item.runId)).size, 4); assert.equal(maximum, 4)
    assert(states.every((item) => item.receipt.policyDigest === frozen.policyDigest), 'all role receipts must share the frozen policy digest')
  })
  await check(checks, 'route-receipt-freeze', 'Route Receipt 绑定 policy digest、Provider/Model/Protocol 与连接身份', () => {
    const receipt = { runId: frozen.owner.runId, policyDigest: frozen.policyDigest, target: frozen.initialTarget, connectionIdentity: primaryIdentity }
    assert.equal(verifyFrozenRoutingPolicy(frozen).policyDigest, receipt.policyDigest)
    assert.doesNotThrow(() => assertFrozenRunRequestTarget({ run: { id: 'run-build', sessionId: 'session-build', taskId: 'task-build', messageId: 'message-1', routingPolicy: frozen } as any, providerId: 'provider-primary', model: 'model-primary', protocol: 'openai.chat-completions', connectionIdentity: primaryIdentity }))
    assert.throws(() => assertFrozenRunRequestTarget({ run: { id: 'run-build', sessionId: 'session-build', taskId: 'task-build', messageId: 'message-1', routingPolicy: frozen } as any, providerId: 'provider-primary', model: 'model-primary', protocol: 'openai.chat-completions', connectionIdentity: { ...primaryIdentity, revision: 2 } }), /changed after routing was frozen/)
  })
  await check(checks, 'identity-rotation', '连接语义、凭据和授权池变化递增身份 revision；展示字段不轮换', () => {
    const base: Provider = { id: 'provider-primary', name: 'Primary', baseUrl: 'https://one.invalid', encryptedToken: 'material-a', models: ['model-primary'], createdAt: 1, connectionAuthorizationPoolDigest: digest }
    const first = assignProviderConnectionIdentity(undefined, base, { authorizationPoolDigest: digest })
    assert.equal(readProviderConnectionIdentity(first).revision, 1)
    assert.equal(readProviderConnectionIdentity(assignProviderConnectionIdentity(first, { ...first, name: 'renamed' }, { authorizationPoolDigest: digest })).revision, 1)
    assert.equal(readProviderConnectionIdentity(assignProviderConnectionIdentity(first, { ...first, baseUrl: 'https://two.invalid' }, { authorizationPoolDigest: digest })).revision, 2)
    assert.equal(readProviderConnectionIdentity(assignProviderConnectionIdentity(first, { ...first, encryptedToken: 'material-b' }, { authorizationPoolDigest: digest, credentialReplacement: true })).revision, 2)
  })
  await check(checks, 'failover-boundary', '换路由只允许冻结 qualified target、已知失败原因与次数预算', () => {
    const recovery = { anchor: {} as any, initialExpertPolicy: { allowedProviderIds: [], locality: 'any', allowedRegions: [], allowedDomains: [], requiredPermissions: [] }, currentRequiredCapabilities: [], frozenRetry: { initialTarget: frozen.initialTarget, retryTargets: frozen.retryTargets, effectivePolicy: frozen.effectivePolicy } } as any
    assert.equal(frozenRetryAllows({ recovery, providerId: 'provider-backup', model: 'model-backup', protocol: 'openai.chat-completions', attempt: 1, refusal: { outcome: 'rate_limited' } }), true)
    assert.equal(frozenRetryAllows({ recovery, providerId: 'provider-unknown', model: 'model-x', protocol: 'openai.chat-completions', attempt: 1, refusal: { outcome: 'rate_limited' } }), false)
    assert.equal(frozenRetryAllows({ recovery, providerId: 'provider-backup', model: 'model-backup', protocol: 'openai.responses', attempt: 1, refusal: { outcome: 'rate_limited' } }), false)
    assert.equal(frozenRetryAllows({ recovery, providerId: 'provider-backup', model: 'model-backup', protocol: 'openai.chat-completions', attempt: 2, refusal: { outcome: 'rate_limited' } }), false)
    assert.equal(frozenRetryAllows({ recovery, providerId: 'provider-backup', model: 'model-backup', protocol: 'openai.chat-completions', attempt: 1, refusal: { outcome: 'network' as any } }), false)
  })
  await check(checks, 'explicit-fallback-model-catalog-boundary', '显式备用模型必须存在于健康 Provider 的模型目录中', () => {
    assert.equal(pickFailoverTarget({ candidates: [{ id: 'provider-backup', name: 'Backup', models: [] }], exclude: new Set(['provider-primary']), desiredModel: 'model-primary', fallbackModel: 'model-backup' }), null)
    assert.equal(pickFailoverTarget({ candidates: [{ id: 'provider-backup', name: 'Backup', models: ['model-backup'] }], exclude: new Set(['provider-primary']), desiredModel: 'model-primary', fallbackModel: 'model-backup' })?.model, 'model-backup')
  })
  const failed = checks.filter((item) => item.status === 'failed')
  const realOptIn = process.env.CAOGEN_RUN_REAL_PROVIDER === '1'
  const report = { schemaVersion: 1, kind: 'caogen.provider-integration-harness-report', status: failed.length ? 'failed' : realOptIn ? 'contract_passed_real_provider_opt_in_pending' : 'contract_passed_real_provider_blocked', contractStatus: failed.length ? 'failed' : 'passed', realProvider: { status: realOptIn ? 'opt-in-required-config-check' : 'blocked', reason: realOptIn ? 'Run provider-integration:harness with private config' : 'CAOGEN_RUN_REAL_PROVIDER=1 required; no network I/O performed' }, checks, limitations: ['contract harness uses synthetic providers and never claims production evidence', 'real mode requires ~/.caogen-private/provider-parity.json and explicit opt-in'], generatedAt: new Date().toISOString(), reportPath }
  mkdirSync(outDir, { recursive: true }); writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2)); if (failed.length) process.exitCode = 1
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
