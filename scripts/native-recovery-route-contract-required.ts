import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { frozenRetryAllows, type NativeSessionRecoveryContext } from '../src/main/model/native-recovery-session'
import type { FrozenNativeProtocol, FrozenRunRoutingPolicyV1 } from '../src/shared/frozen-routing-types'
import type { RoutingRetryReason } from '../src/shared/routing-policy-types'

type Check = { id: string; status: 'passed' | 'failed'; detail: string }

const outputDir = join(process.cwd(), 'test-results', 'native-recovery-route-contract')
const reportPath = join(outputDir, 'latest.json')

const initial = { providerId: 'provider-a', model: 'model-a', protocol: 'openai.chat-completions' as const }
const alternate = { providerId: 'provider-b', model: 'model-b', protocol: 'openai.chat-completions' as const }
const protocolAlternate = { providerId: 'provider-a', model: 'model-a', protocol: 'openai.responses' as const }

function policy(failure: FrozenRunRoutingPolicyV1['effectivePolicy']['failure']): NativeSessionRecoveryContext['frozenRetry'] {
  return { initialTarget: initial, retryTargets: [alternate], effectivePolicy: { selection: { kind: 'global_auto' }, strategy: 'balanced', failure } }
}

function recovery(frozenRetry: NativeSessionRecoveryContext['frozenRetry']): NativeSessionRecoveryContext {
  return {
    anchor: {} as NativeSessionRecoveryContext['anchor'],
    initialExpertPolicy: { allowedProviderIds: [], locality: 'any', allowedRegions: [], allowedDomains: [], requiredPermissions: [] },
    currentRequiredCapabilities: [],
    ...(frozenRetry ? { frozenRetry } : {})
  }
}

function allowed(input: {
  retry: NativeSessionRecoveryContext['frozenRetry']
  target: { providerId: string; model: string; protocol: FrozenNativeProtocol }
  attempt: number
  outcome?: RoutingRetryReason
}): boolean {
  return frozenRetryAllows({ recovery: recovery(input.retry), ...input.target, attempt: input.attempt,
    ...(input.outcome ? { refusal: { outcome: input.outcome } } : {}) })
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function check(checks: Check[], id: string, detail: string, operation: () => void): void {
  try {
    operation()
    checks.push({ id, status: 'passed', detail })
  } catch (error) {
    checks.push({ id, status: 'failed', detail: error instanceof Error ? error.message : String(error) })
  }
}

function main(): void {
  const checks: Check[] = []
  const sameTarget = policy({ kind: 'retry_same_target', maxAdditionalAttempts: 1, retryOn: ['rate_limited'] })
  const allowedTargets = policy({ kind: 'retry_allowed_targets', maxAdditionalAttempts: 2, retryOn: ['rate_limited', 'auth_failed'] })
  const paused = policy({ kind: 'pause' })

  check(checks, 'known-failure-required', '冻结 Run 存在时，未携带已知失败原因不得自动恢复', () => {
    assert(!allowed({ retry: allowedTargets, target: alternate, attempt: 1 }), 'missing refusal must block recovery')
  })
  check(checks, 'pause-fail-closed', 'pause 策略不允许任何自动恢复目标', () => {
    assert(!allowed({ retry: paused, target: initial, attempt: 1, outcome: 'rate_limited' }), 'pause must block initial retry')
    assert(!allowed({ retry: paused, target: alternate, attempt: 1, outcome: 'auth_failed' }), 'pause must block alternate retry')
  })
  check(checks, 'same-target-boundary', 'retry_same_target 只允许初始目标、匹配原因和额度内的尝试', () => {
    assert(allowed({ retry: sameTarget, target: initial, attempt: 1, outcome: 'rate_limited' }), 'same target should be allowed')
    assert(!allowed({ retry: sameTarget, target: alternate, attempt: 1, outcome: 'rate_limited' }), 'same target must reject provider/model change')
    assert(!allowed({ retry: sameTarget, target: initial, attempt: 1, outcome: 'auth_failed' }), 'unlisted failure reason must block')
    assert(!allowed({ retry: sameTarget, target: initial, attempt: 2, outcome: 'rate_limited' }), 'attempt beyond maxAdditionalAttempts must block')
  })
  check(checks, 'allowed-target-boundary', 'retry_allowed_targets 只允许冻结 qualified target 集合内的目标', () => {
    assert(allowed({ retry: allowedTargets, target: initial, attempt: 1, outcome: 'rate_limited' }), 'initial target should be allowed')
    assert(allowed({ retry: allowedTargets, target: alternate, attempt: 1, outcome: 'auth_failed' }), 'qualified alternate should be allowed')
    assert(!allowed({ retry: allowedTargets, target: { providerId: 'provider-c', model: 'model-c', protocol: initial.protocol }, attempt: 1, outcome: 'rate_limited' }), 'unknown target must block')
    assert(!allowed({ retry: allowedTargets, target: alternate, attempt: 3, outcome: 'rate_limited' }), 'attempt beyond frozen budget must block')
  })
  check(checks, 'protocol-boundary', '协议变化不因同一 Provider/Model 身份而绕过冻结目标边界', () => {
    assert(!allowed({ retry: allowedTargets, target: protocolAlternate, attempt: 1, outcome: 'rate_limited' }), 'unqualified protocol must block')
  })
  check(checks, 'legacy-without-frozen-policy', '未绑定冻结策略的旧会话不由本门禁扩大恢复权限', () => {
    assert(allowed({ retry: undefined, target: alternate, attempt: 1 }), 'legacy path should remain delegated to its existing anchor')
  })

  const failed = checks.filter((item) => item.status === 'failed')
  const report = {
    schemaVersion: 1,
    kind: 'caogen.native-recovery-route-contract-report',
    status: failed.length === 0 ? 'passed' : 'failed',
    scope: 'frozen-policy local contract; no Provider network I/O',
    checks,
    limitations: ['does not prove real Provider failover', 'does not prove Electron UI recovery interaction']
  }
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  if (failed.length) process.exitCode = 1
}

main()
