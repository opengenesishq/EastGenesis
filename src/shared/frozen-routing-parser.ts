import { digest, fail, integer, list, oneOf, parseResult, record, stableId, unique } from './routing-policy-parse-fields'
import { readFailure, readSelection } from './routing-policy-parser'
import { readRoutingIntent } from './routing-policy-command-parser'
import { readFrozenBusinessId, readFrozenHardBounds, readFrozenNativeTarget, readFrozenOwner, readFrozenQualifiedTarget, readFrozenRuleReference, frozenTargetKey } from './frozen-routing-fields'
import { assertFrozenRoutingStructure } from './frozen-routing-validation'
import type { FrozenRunRoutingPolicyV1, FrozenRoutingQualifiedTarget } from './frozen-routing-types'

const POLICY_FIELDS = ['schemaVersion', 'evaluatorVersion', 'executionDomain', 'owner', 'messageId', 'frozenAt',
  'originalPromptDigest', 'ruleSetRevision', 'ruleSetDigest', 'matchedRules', 'contextDigest', 'catalogDigest', 'evaluationDigest',
  'baseStrategy', 'baseStrategySource', 'userIntent', 'effectivePolicy', 'initialTarget', 'qualifiedTargets', 'retryTargets', 'hardBounds', 'policyDigest'] as const
const STRATEGIES = ['balanced', 'quality', 'cost', 'speed'] as const

/** Shape-only shared parser; main additionally verifies the canonical content digest. */
export function parseFrozenRoutingPolicy(value: unknown) {
  return parseResult<FrozenRunRoutingPolicyV1>(() => {
    const row = record(value, '$', POLICY_FIELDS)
    if (row.schemaVersion !== 1 || row.evaluatorVersion !== 1) fail('INVALID_VALUE', '$.schemaVersion', 'Unsupported frozen routing schema/evaluator version.')
    const parsed: FrozenRunRoutingPolicyV1 = {
      schemaVersion: 1, evaluatorVersion: 1, executionDomain: oneOf(row.executionDomain, '$.executionDomain', ['native_text']),
      owner: readFrozenOwner(row.owner, '$.owner'), messageId: stableId(row.messageId, '$.messageId'), frozenAt: integer(row.frozenAt, '$.frozenAt', 0),
      originalPromptDigest: digest(row.originalPromptDigest, '$.originalPromptDigest'), ruleSetRevision: integer(row.ruleSetRevision, '$.ruleSetRevision', 1),
      ruleSetDigest: digest(row.ruleSetDigest, '$.ruleSetDigest'), matchedRules: list(row.matchedRules, '$.matchedRules', readFrozenRuleReference, 1, 0),
      contextDigest: digest(row.contextDigest, '$.contextDigest'), catalogDigest: digest(row.catalogDigest, '$.catalogDigest'),
      evaluationDigest: digest(row.evaluationDigest, '$.evaluationDigest'), baseStrategy: oneOf(row.baseStrategy, '$.baseStrategy', STRATEGIES),
      baseStrategySource: readBaseStrategySource(row.baseStrategySource), userIntent: readRoutingIntent(row.userIntent, '$.userIntent'),
      effectivePolicy: readEffectivePolicy(row.effectivePolicy), initialTarget: readFrozenNativeTarget(row.initialTarget, '$.initialTarget'),
      qualifiedTargets: unique<FrozenRoutingQualifiedTarget>(list(row.qualifiedTargets, '$.qualifiedTargets', readFrozenQualifiedTarget, 1024), '$.qualifiedTargets', frozenTargetKey),
      retryTargets: unique(list(row.retryTargets, '$.retryTargets', readFrozenNativeTarget, 1024, 0), '$.retryTargets', frozenTargetKey),
      hardBounds: readFrozenHardBounds(row.hardBounds, '$.hardBounds'), policyDigest: digest(row.policyDigest, '$.policyDigest')
    }
    assertFrozenRoutingStructure(parsed)
    return parsed
  })
}

function readBaseStrategySource(value: unknown): FrozenRunRoutingPolicyV1['baseStrategySource'] {
  const row = record(value, '$.baseStrategySource', ['kind'], ['businessLineId'])
  if (row.kind === 'global') { record(value, '$.baseStrategySource', ['kind']); return { kind: 'global' } }
  if (row.kind !== 'business_line') fail('INVALID_VALUE', '$.baseStrategySource.kind', 'Only global or business-line baseline sources are supported.')
  record(value, '$.baseStrategySource', ['kind', 'businessLineId'])
  return { kind: 'business_line', businessLineId: readFrozenBusinessId(row.businessLineId, '$.baseStrategySource.businessLineId') }
}

function readEffectivePolicy(value: unknown): FrozenRunRoutingPolicyV1['effectivePolicy'] {
  const row = record(value, '$.effectivePolicy', ['selection', 'strategy', 'failure'])
  return { selection: readSelection(row.selection, '$.effectivePolicy.selection'),
    strategy: oneOf(row.strategy, '$.effectivePolicy.strategy', STRATEGIES), failure: readFailure(row.failure, '$.effectivePolicy.failure') }
}
