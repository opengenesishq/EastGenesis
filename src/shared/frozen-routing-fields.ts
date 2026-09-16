import { isBusinessLineId } from './business-line-types'
import { fail, integer, list, oneOf, record, stableId, string, unique } from './routing-policy-parse-fields'
import { readRoutingProviderId, readRoutingTargetRef, readScope, readSource } from './routing-policy-parser'
import type { FrozenNativeTarget, FrozenRoutingHardBounds, FrozenRoutingOwner, FrozenRoutingQualifiedTarget, FrozenRoutingRuleReference } from './frozen-routing-types'

export function readFrozenOwner(value: unknown, path: string): FrozenRoutingOwner {
  const row = record(value, path, ['runId', 'sessionId', 'taskId', 'workItemId', 'businessLineId'], ['projectId', 'goalId'])
  return { runId: stableId(row.runId, `${path}.runId`), sessionId: stableId(row.sessionId, `${path}.sessionId`),
    taskId: stableId(row.taskId, `${path}.taskId`), workItemId: stableId(row.workItemId, `${path}.workItemId`),
    businessLineId: readFrozenBusinessId(row.businessLineId, `${path}.businessLineId`),
    ...(row.projectId === undefined ? {} : { projectId: stableId(row.projectId, `${path}.projectId`) }),
    ...(row.goalId === undefined ? {} : { goalId: stableId(row.goalId, `${path}.goalId`) }) }
}

export function readFrozenBusinessId(value: unknown, path: string): string {
  if (!isBusinessLineId(value)) fail('INVALID_VALUE', path, 'Expected a business-line identifier.')
  return value
}

export function readFrozenNativeTarget(value: unknown, path: string): FrozenNativeTarget {
  const row = record(value, path, ['providerId', 'model', 'protocol'])
  return { ...readRoutingTargetRef({ providerId: row.providerId, model: row.model }, path),
    protocol: oneOf(row.protocol, `${path}.protocol`, ['openai.chat-completions', 'openai.responses', 'anthropic.messages', 'google.generative-language']) }
}

export function readFrozenQualifiedTarget(value: unknown, path: string): FrozenRoutingQualifiedTarget {
  const row = record(value, path, ['providerId', 'model', 'protocol', 'connectionIdentity'], ['declaredContextWindow'])
  const target = readFrozenNativeTarget({ providerId: row.providerId, model: row.model, protocol: row.protocol }, path)
  const connection = record(row.connectionIdentity, `${path}.connectionIdentity`, ['generationId', 'revision'])
  const generationId = string(connection.generationId, `${path}.connectionIdentity.generationId`, 36)
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(generationId)) {
    fail('INVALID_VALUE', `${path}.connectionIdentity.generationId`, 'Expected an opaque UUID generation, not connection configuration or a credential digest.')
  }
  return { ...target, connectionIdentity: { generationId, revision: integer(connection.revision, `${path}.connectionIdentity.revision`, 1) },
    ...(row.declaredContextWindow === undefined ? {} : { declaredContextWindow: integer(row.declaredContextWindow, `${path}.declaredContextWindow`, 1) }) }
}

export function readFrozenRuleReference(value: unknown, path: string): FrozenRoutingRuleReference {
  const row = record(value, path, ['id', 'version', 'source', 'priority', 'scope'])
  return { id: stableId(row.id, `${path}.id`), version: integer(row.version, `${path}.version`, 1),
    source: readSource(row.source, `${path}.source`), priority: integer(row.priority, `${path}.priority`, 0, 1_000_000),
    scope: readScope(row.scope, `${path}.scope`) }
}

export function readFrozenHardBounds(value: unknown, path: string): FrozenRoutingHardBounds {
  const row = record(value, path, ['requiredCapabilities', 'minContextTokens', 'allowedProviderIds', 'locality'], ['remainingBudgetUsd', 'allowedRegions', 'allowedDomains', 'requiredPermissions', 'executorEngine'])
  return { requiredCapabilities: unique(list(row.requiredCapabilities, `${path}.requiredCapabilities`,
    (value, path) => oneOf(value, path, ['tools', 'vision']), 2, 0), path, (value) => value),
    minContextTokens: integer(row.minContextTokens, `${path}.minContextTokens`, 1),
    allowedProviderIds: unique(list(row.allowedProviderIds, `${path}.allowedProviderIds`, readRoutingProviderId, 512, 0), path, (value) => value),
    locality: oneOf(row.locality, `${path}.locality`, ['any', 'local_only']),
    ...(row.executorEngine === undefined ? {} : { executorEngine: oneOf(row.executorEngine, `${path}.executorEngine`, ['openai', 'anthropic', 'gemini']) }),
    ...(row.allowedRegions === undefined ? {} : { allowedRegions: unique(list(row.allowedRegions, `${path}.allowedRegions`, (value, at) => string(value, at, 128).toLowerCase(), 100, 0), path, (value) => value) }),
    ...(row.allowedDomains === undefined ? {} : { allowedDomains: unique(list(row.allowedDomains, `${path}.allowedDomains`, (value, at) => string(value, at, 253).toLowerCase(), 100, 0), path, (value) => value) }),
    ...(row.requiredPermissions === undefined ? {} : { requiredPermissions: unique(list(row.requiredPermissions, `${path}.requiredPermissions`, (value, at) => string(value, at, 128).toLowerCase(), 100, 0), path, (value) => value) }),
    ...(row.remainingBudgetUsd === undefined ? {} : { remainingBudgetUsd: nonnegativeAmount(row.remainingBudgetUsd, `${path}.remainingBudgetUsd`) }) }
}

function nonnegativeAmount(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('INVALID_VALUE', path, 'Expected a finite nonnegative USD balance.')
  return value
}

export function frozenTargetKey(target: FrozenNativeTarget): string {
  return JSON.stringify([target.providerId, target.model, target.protocol])
}
