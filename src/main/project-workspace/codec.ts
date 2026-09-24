import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type {
  AcceptanceResult,
  AcceptanceSpec,
  ConnectorLatestCitation,
  ConnectorResourceContract,
  ConnectorResourceLifecycle,
  ConnectorRefreshStatus,
  Goal,
  GoalBudget,
  GoalContract,
  GoalContractInput,
  ProjectResource,
  ProjectResourceInput,
  WorkItemOwner
} from '../../shared/project-workspace-types'
import { isGoalRiskLevel } from '../../shared/project-workspace-types'
import { ProjectWorkspaceError } from './errors'
import { isProjectInstitutionTemplateRef, type ProjectInstitutionTemplateRef } from '../../shared/project-institution-template'

export function normalizeInstitutionTemplate(value: unknown): ProjectInstitutionTemplateRef {
  if (!isProjectInstitutionTemplateRef(value)) {
    throw new ProjectWorkspaceError('invalid_input', 'project institution template or version is invalid')
  }
  return { schemaVersion: 1, templateId: value.templateId, templateVersion: 1 }
}

export function clone<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

export function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProjectWorkspaceError('invalid_input', `${label} is required`)
  }
  return value.trim()
}

export function optionalId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredId(value, label)
}

export function normalizePrimaryResource(value: unknown, resources: ProjectResource[]): string | undefined {
  if (value === undefined || value === null) return undefined
  const id = requiredId(value, 'primary resource id')
  const resource = resources.find(item => item.id === id)
  if (!resource || !['directory', 'repository'].includes(resource.kind) ||
      !resource.path || !isAbsolute(resource.path) || /[\0-\x1f\x7f]/.test(resource.path)) {
    throw new ProjectWorkspaceError('invalid_input', '主文件夹必须是项目中已登记的本机文件夹或仓库。')
  }
  return id
}

export function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProjectWorkspaceError('invalid_input', `${label} is required`)
  }
  return value.trim()
}

export function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ProjectWorkspaceError('invalid_input', `${label} must be text`)
  return value.trim()
}

export function timestamp(value: unknown, label: string, fallback = Date.now()): number {
  const candidate = value === undefined ? fallback : value
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) {
    throw new ProjectWorkspaceError('invalid_input', `${label} must be a finite timestamp`)
  }
  return candidate
}

export function positiveInteger(value: unknown, label: string, fallback: number): number {
  const candidate = value === undefined ? fallback : value
  if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 0) {
    throw new ProjectWorkspaceError('invalid_input', `${label} must be a non-negative integer`)
  }
  return candidate
}

export function finiteNumber(value: unknown, label: string, fallback: number): number {
  const candidate = value === undefined ? fallback : value
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new ProjectWorkspaceError('invalid_input', `${label} must be a finite number`)
  }
  return candidate
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    )
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function redact(value: unknown, key = ''): unknown {
  if (/(?:secret|token|password|api[-_]?key|authorization|credential)/i.test(key)) {
    return '[REDACTED]'
  }
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, redact(item, name)])
    )
  }
  return value
}

function normalizeResource(input: ProjectResourceInput, index: number): ProjectResource {
  if (!input || typeof input !== 'object') {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} must be an object`)
  }
  const validKinds = new Set(['directory', 'file_set', 'repository', 'knowledge_base', 'connector', 'url', 'custom'])
  if (!validKinds.has(input.kind)) throw new ProjectWorkspaceError('invalid_input', `resource ${index} kind is invalid`)
  const path = optionalText(input.path, `resource ${index} path`)
  const rawUri = optionalText(input.uri, `resource ${index} uri`)
  const uri = input.kind === 'connector' && rawUri ? sanitizeConnectorUri(rawUri) : rawUri
  if (!path && !uri && input.kind !== 'custom') {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} requires path or uri`)
  }
  const dataClass = normalizeResourceDataClass(input.dataClass, input.kind, index)
  const requestedEgressPolicy = normalizeResourceEgressPolicy(input.egressPolicy, index)
  return {
    id: optionalId(input.id, `resource ${index} id`) ?? randomUUID(),
    kind: input.kind,
    label: optionalText(input.label, `resource ${index} label`),
    path,
    uri,
    dataClass,
    egressPolicy: dataClass === 'S3' ? 'deny' : requestedEgressPolicy,
    connector: input.kind === 'connector'
      ? normalizeConnectorContract(input.connector, index)
      : undefined,
    metadata: input.metadata ? redact(input.metadata) as Record<string, unknown> : undefined
  }
}

function normalizeConnectorContract(value: unknown, index: number): ConnectorResourceContract {
  if (value === undefined) return legacyRevokedConnectorContract()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} connector contract must be an object`)
  }
  const input = value as ConnectorResourceContract
  if (input.schemaVersion !== 1) {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} connector schemaVersion is invalid`)
  }
  const usage = normalizedStringSet(input.usage, `resource ${index} connector usage`)
  if (!usage.every((entry) => entry === 'resource' || entry === 'knowledge_source' || entry === 'tool')) {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} connector usage is invalid`)
  }
  const capabilities = normalizedStringSet(input.capabilities, `resource ${index} connector capabilities`)
  if (input.dataDirection !== 'read' && input.dataDirection !== 'write' && input.dataDirection !== 'bidirectional') {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} connector dataDirection is invalid`)
  }
  const authorization = normalizeConnectorAuthorization(input.authorization, index)
  const revocation = normalizeConnectorRevocation(input.revocation, index)
  const writePolicy = normalizeConnectorWritePolicy(input.writePolicy, index)
  return {
    schemaVersion: 1,
    ...(input.connectorId === undefined ? {} : { connectorId: requiredText(input.connectorId, `resource ${index} connector connectorId`) }),
    usage: usage as ConnectorResourceContract['usage'],
    capabilities,
    dataDirection: input.dataDirection,
    authorization,
    version: requiredText(input.version, `resource ${index} connector version`),
    revocation,
    writePolicy,
    lifecycle: normalizeConnectorLifecycle(input.lifecycle, index)
  }
}

function normalizeConnectorLifecycle(
  value: ConnectorResourceLifecycle | undefined,
  index: number
): ConnectorResourceLifecycle {
  if (value === undefined) return { enabled: true, refresh: { status: 'idle' } }
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean' ||
      !value.refresh || typeof value.refresh !== 'object') {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} connector lifecycle is invalid`)
  }
  const status = value.refresh.status
  const validStatuses: ConnectorRefreshStatus[] = ['idle', 'requested', 'running', 'succeeded', 'failed']
  if (!validStatuses.includes(status)) {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} connector refresh status is invalid`)
  }
  const refresh = value.refresh
  const result: ConnectorResourceLifecycle = {
    enabled: value.enabled,
    refresh: {
      status,
      ...(refresh.requestedAt === undefined ? {} : { requestedAt: optionalTimestamp(refresh.requestedAt, `resource ${index} connector requestedAt`) }),
      ...(refresh.startedAt === undefined ? {} : { startedAt: optionalTimestamp(refresh.startedAt, `resource ${index} connector startedAt`) }),
      ...(refresh.completedAt === undefined ? {} : { completedAt: optionalTimestamp(refresh.completedAt, `resource ${index} connector completedAt`) }),
      ...(refresh.errorDigest === undefined ? {} : { errorDigest: requiredDigest(refresh.errorDigest, `resource ${index} connector errorDigest`) }),
      ...(refresh.latestCitation === undefined ? {} : { latestCitation: normalizeConnectorCitation(refresh.latestCitation, index) })
    },
    ...(value.autoRefresh === undefined ? {} : { autoRefresh: normalizeConnectorAutoRefresh(value.autoRefresh, index) }),
    ...(value.cache === undefined ? {} : { cache: normalizeConnectorCache(value.cache, index) }),
    ...(value.revocation === undefined ? {} : { revocation: normalizeConnectorRevocationState(value.revocation, index) })
  }
  if (status === 'failed' && !result.refresh.errorDigest) {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} failed connector refresh requires errorDigest`)
  }
  return result
}

function normalizeConnectorAutoRefresh(
  value: NonNullable<ConnectorResourceLifecycle['autoRefresh']>,
  index: number
): NonNullable<ConnectorResourceLifecycle['autoRefresh']> {
  const intervals = [0, 900_000, 3_600_000, 21_600_000, 86_400_000]
  if (!value || typeof value !== 'object' || !intervals.includes(value.intervalMs)) {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} connector autoRefresh is invalid`)
  }
  return {
    intervalMs: value.intervalMs,
    ...(value.nextAt === undefined ? {} : { nextAt: optionalTimestamp(value.nextAt, `resource ${index} connector autoRefresh nextAt`) })
  }
}

function normalizeConnectorCache(
  value: NonNullable<ConnectorResourceLifecycle['cache']>,
  index: number
): NonNullable<ConnectorResourceLifecycle['cache']> {
  if (!value || typeof value !== 'object' ||
      !['empty', 'ready', 'purging', 'purged', 'purge_failed'].includes(value.status)) {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} connector cache is invalid`)
  }
  if (value.bytes !== undefined && (!Number.isSafeInteger(value.bytes) || value.bytes < 0)) {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} connector cache bytes is invalid`)
  }
  const result: NonNullable<ConnectorResourceLifecycle['cache']> = {
    status: value.status,
    ...(value.authorizationDigest === undefined ? {} : { authorizationDigest: requiredDigest(value.authorizationDigest, `resource ${index} connector cache authorizationDigest`) }),
    ...(value.contentDigest === undefined ? {} : { contentDigest: requiredDigest(value.contentDigest, `resource ${index} connector cache contentDigest`) }),
    ...(value.bytes === undefined ? {} : { bytes: value.bytes }),
    ...(value.cachedAt === undefined ? {} : { cachedAt: optionalTimestamp(value.cachedAt, `resource ${index} connector cache cachedAt`) }),
    ...(value.purgeRequestedAt === undefined ? {} : { purgeRequestedAt: optionalTimestamp(value.purgeRequestedAt, `resource ${index} connector cache purgeRequestedAt`) }),
    ...(value.purgedAt === undefined ? {} : { purgedAt: optionalTimestamp(value.purgedAt, `resource ${index} connector cache purgedAt`) }),
    ...(value.errorDigest === undefined ? {} : { errorDigest: requiredDigest(value.errorDigest, `resource ${index} connector cache errorDigest`) })
  }
  // authorizationDigest was added after lifecycle v1 shipped. Old lifecycle
  // metadata remains readable, while runtime cache reads reject it until a
  // refresh writes the authorization-bound cache format.
  if (result.status === 'ready' && (!result.contentDigest || result.bytes === undefined || result.cachedAt === undefined)) {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} ready connector cache is incomplete`)
  }
  if (result.status === 'purge_failed' && !result.errorDigest) {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} failed connector cache purge requires errorDigest`)
  }
  return result
}

function normalizeConnectorRevocationState(
  value: NonNullable<ConnectorResourceLifecycle['revocation']>,
  index: number
): NonNullable<ConnectorResourceLifecycle['revocation']> {
  if (!value || typeof value !== 'object' ||
      !['blocking', 'completed', 'failed'].includes(value.status) ||
      !Array.isArray(value.pausedSessionIds) || !Array.isArray(value.pausedRunIds)) {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} connector revocation state is invalid`)
  }
  const result: NonNullable<ConnectorResourceLifecycle['revocation']> = {
    status: value.status,
    requestedAt: timestamp(value.requestedAt, `resource ${index} connector revocation requestedAt`),
    pausedSessionIds: normalizedIdList(value.pausedSessionIds, `resource ${index} connector revocation pausedSessionIds`),
    pausedRunIds: normalizedIdList(value.pausedRunIds, `resource ${index} connector revocation pausedRunIds`),
    ...(value.completedAt === undefined ? {} : { completedAt: optionalTimestamp(value.completedAt, `resource ${index} connector revocation completedAt`) }),
    ...(value.errorDigest === undefined ? {} : { errorDigest: requiredDigest(value.errorDigest, `resource ${index} connector revocation errorDigest`) })
  }
  if (result.status === 'failed' && !result.errorDigest) {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} failed connector revocation requires errorDigest`)
  }
  return result
}

function normalizedIdList(value: unknown[], label: string): string[] {
  return [...new Set(value.map((entry) => requiredText(entry, label)))].sort()
}

function normalizeConnectorCitation(value: ConnectorLatestCitation, index: number): ConnectorLatestCitation {
  if (!value || typeof value !== 'object') {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} connector citation is invalid`)
  }
  const contentDigest = value.contentDigest === undefined
    ? undefined
    : requiredDigest(value.contentDigest, `resource ${index} connector citation contentDigest`)
  return {
    ...(value.projectId === undefined ? {} : { projectId: requiredText(value.projectId, `resource ${index} connector citation projectId`) }),
    ...(value.resourceId === undefined ? {} : { resourceId: requiredText(value.resourceId, `resource ${index} connector citation resourceId`) }),
    source: sanitizeConnectorUri(requiredText(value.source, `resource ${index} connector citation source`)),
    version: requiredText(value.version, `resource ${index} connector citation version`),
    retrievedAt: timestamp(value.retrievedAt, `resource ${index} connector citation retrievedAt`),
    ...(contentDigest === undefined ? {} : { contentDigest })
  }
}

function requiredDigest(value: unknown, label: string): string {
  const candidate = requiredText(value, label)
  if (!/^sha256:[a-f0-9]{64}$/.test(candidate)) {
    throw new ProjectWorkspaceError('invalid_input', `${label} is invalid`)
  }
  return candidate
}

function normalizeConnectorAuthorization(
  value: ConnectorResourceContract['authorization'] | undefined,
  index: number
): ConnectorResourceContract['authorization'] {
  if (!value || typeof value !== 'object') {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} connector authorization is required`)
  }
  if (value.subject !== 'personal' && value.subject !== 'shared') {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} connector authorization subject is invalid`)
  }
  if (value.status !== 'active' && value.status !== 'revoked') {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} connector authorization status is invalid`)
  }
  const scopes = normalizedStringSet(value.scopes, `resource ${index} connector authorization scopes`)
  const grantedAt = optionalTimestamp(value.grantedAt, `resource ${index} connector grantedAt`)
  const revokedAt = optionalTimestamp(value.revokedAt, `resource ${index} connector revokedAt`)
  if (value.status === 'revoked' && revokedAt === undefined) {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} revoked connector requires revokedAt`)
  }
  return {
    subject: value.subject,
    principalId: requiredText(value.principalId, `resource ${index} connector principalId`),
    ...(value.credentialRef === undefined ? {} : { credentialRef: requiredText(value.credentialRef, `resource ${index} connector credentialRef`) }),
    scopes,
    status: value.status,
    ...(grantedAt === undefined ? {} : { grantedAt }),
    ...(revokedAt === undefined ? {} : { revokedAt })
  }
}

function normalizeConnectorRevocation(
  value: ConnectorResourceContract['revocation'] | undefined,
  index: number
): ConnectorResourceContract['revocation'] {
  if (!value || value.behavior !== 'deny_new_operations' || typeof value.purgeCachedData !== 'boolean') {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} connector revocation policy is invalid`)
  }
  return { behavior: 'deny_new_operations', purgeCachedData: value.purgeCachedData }
}

function normalizeConnectorWritePolicy(
  value: ConnectorResourceContract['writePolicy'] | undefined,
  index: number
): ConnectorResourceContract['writePolicy'] {
  if (!value || value.effect !== 'required' ||
      (value.reconciliation !== 'queryable' && value.reconciliation !== 'manual_only')) {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} connector write policy is invalid`)
  }
  return { effect: 'required', reconciliation: value.reconciliation }
}

function normalizedStringSet(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new ProjectWorkspaceError('invalid_input', `${label} must be an array`)
  const normalized = [...new Set(value.map((entry) => requiredText(entry, label)))].sort()
  if (normalized.length === 0) throw new ProjectWorkspaceError('invalid_input', `${label} must not be empty`)
  if (normalized.length > 100) throw new ProjectWorkspaceError('invalid_input', `${label} exceeds 100 entries`)
  return normalized
}

function optionalTimestamp(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  return timestamp(value, label)
}

function legacyRevokedConnectorContract(): ConnectorResourceContract {
  return {
    schemaVersion: 1,
    connectorId: 'legacy',
    usage: ['resource'],
    capabilities: ['legacy:untrusted'],
    dataDirection: 'read',
    authorization: {
      subject: 'personal',
      principalId: 'legacy-unbound',
      scopes: ['none'],
      status: 'revoked',
      revokedAt: 0
    },
    version: 'unversioned',
    revocation: { behavior: 'deny_new_operations', purgeCachedData: true },
    writePolicy: { effect: 'required', reconciliation: 'manual_only' }
  }
}

function sanitizeConnectorUri(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return value
  }
}

function normalizeResourceDataClass(
  value: unknown,
  kind: ProjectResource['kind'],
  index: number
): NonNullable<ProjectResource['dataClass']> {
  if (value === undefined) return kind === 'connector' || kind === 'url' ? 'S1' : 'S2'
  if (value === 'S0' || value === 'S1' || value === 'S2' || value === 'S3' || value === 'S4') {
    return value
  }
  throw new ProjectWorkspaceError('invalid_input', `resource ${index} dataClass is invalid`)
}

function normalizeResourceEgressPolicy(
  value: unknown,
  index: number
): NonNullable<ProjectResource['egressPolicy']> {
  if (value === undefined) return 'allow'
  if (value === 'allow' || value === 'local_only' || value === 'deny') return value
  throw new ProjectWorkspaceError('invalid_input', `resource ${index} egressPolicy is invalid`)
}

export function normalizeResources(inputs: ProjectResourceInput[] | undefined): ProjectResource[] {
  if (inputs === undefined) return []
  if (!Array.isArray(inputs)) throw new ProjectWorkspaceError('invalid_input', 'resources must be an array')
  const resources = inputs.map(normalizeResource)
  const ids = new Set<string>()
  for (const resource of resources) {
    if (ids.has(resource.id)) throw new ProjectWorkspaceError('invalid_input', `duplicate resource id ${resource.id}`)
    ids.add(resource.id)
  }
  return resources
}

function normalizeBudget(value: GoalBudget | undefined): GoalBudget | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new ProjectWorkspaceError('invalid_input', 'goal budget must be an object')
  const budget: GoalBudget = {}
  if (value.amount !== undefined) {
    budget.amount = finiteNumber(value.amount, 'goal budget amount', 0)
    if (budget.amount < 0) throw new ProjectWorkspaceError('invalid_input', 'goal budget amount must be non-negative')
  }
  if (value.currency !== undefined) budget.currency = requiredText(value.currency, 'goal budget currency')
  if (value.maxTokens !== undefined) {
    budget.maxTokens = positiveInteger(value.maxTokens, 'goal budget maxTokens', 0)
    if (budget.maxTokens === 0) throw new ProjectWorkspaceError('invalid_input', 'goal budget maxTokens must be greater than zero')
  }
  if (value.maxRuns !== undefined) {
    budget.maxRuns = positiveInteger(value.maxRuns, 'goal budget maxRuns', 0)
    if (budget.maxRuns === 0) throw new ProjectWorkspaceError('invalid_input', 'goal budget maxRuns must be greater than zero')
  }
  if (value.maxConcurrentRuns !== undefined) {
    budget.maxConcurrentRuns = positiveInteger(
      value.maxConcurrentRuns,
      'goal budget maxConcurrentRuns',
      0
    )
    if (budget.maxConcurrentRuns === 0) {
      throw new ProjectWorkspaceError(
        'invalid_input',
        'goal budget maxConcurrentRuns must be greater than zero'
      )
    }
  }
  return budget
}

export function normalizeAcceptanceSpecs(value: AcceptanceSpec[] | undefined, label: string): AcceptanceSpec[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ProjectWorkspaceError('invalid_input', `${label} must be an array`)
  const ids = new Set<string>()
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new ProjectWorkspaceError('invalid_input', `${label}[${index}] must be an object`)
    const id = requiredId(item.id, `${label}[${index}].id`)
    const criterion = requiredText(item.criterion, `${label}[${index}].criterion`)
    if (ids.has(id)) throw new ProjectWorkspaceError('invalid_input', `${label} contains duplicate id ${id}`)
    ids.add(id)
    return { id, criterion, required: item.required !== false }
  })
}

export function normalizeAcceptanceResult(value: AcceptanceResult | undefined): AcceptanceResult | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new ProjectWorkspaceError('invalid_input', 'acceptance result must be an object')
  const status = value.status
  if (status !== 'pending' && status !== 'passed' && status !== 'failed' && status !== 'waived') {
    throw new ProjectWorkspaceError('invalid_input', 'acceptance result status is invalid')
  }
  if (!Array.isArray(value.evidenceRefs)) {
    throw new ProjectWorkspaceError('invalid_input', 'acceptance evidenceRefs must be an array')
  }
  const evidenceRefs = [...new Set(
    value.evidenceRefs.map((ref) => requiredId(ref, 'acceptance evidence ref'))
  )]
  if (status === 'passed' && evidenceRefs.length === 0) {
    throw new ProjectWorkspaceError('invalid_input', 'passed acceptance requires at least one evidence ref')
  }
  const waiverReason = optionalText(value.waiverReason, 'acceptance waiver reason')
  if (status === 'waived' && !waiverReason) {
    throw new ProjectWorkspaceError('invalid_input', 'waived acceptance requires a waiver reason')
  }
  return {
    status,
    evidenceRefs,
    verifiedBy: optionalText(value.verifiedBy, 'acceptance verifier'),
    verifiedAt: value.verifiedAt === undefined ? undefined : timestamp(value.verifiedAt, 'acceptance verifiedAt'),
    waiverReason
  }
}

function contractField<K extends keyof GoalContract>(
  source: GoalContractInput,
  fallback: Partial<GoalContract>,
  key: K,
  defaultValue: GoalContract[K]
): GoalContract[K] {
  const sourceValue = source[key]
  if (sourceValue !== undefined) return sourceValue as GoalContract[K]
  const fallbackValue = fallback[key]
  if (fallbackValue !== undefined) return fallbackValue as GoalContract[K]
  return defaultValue
}

function textList(value: string[], label: string): string[] {
  return value.map((item) => requiredText(item, label))
}

export function normalizeContract(input: GoalContractInput | undefined, fallback: Partial<GoalContract> = {}): GoalContract {
  const source = input ?? {}
  const objective = contractField(source, fallback, 'objective', '')
  const riskLevel = contractField(source, fallback, 'riskLevel', 'medium')
  if (!isGoalRiskLevel(riskLevel)) throw new ProjectWorkspaceError('invalid_input', 'goal riskLevel is invalid')
  const dueAt = contractField(source, fallback, 'dueAt', undefined)
  return {
    objective: requiredText(objective, 'goal objective'),
    background: optionalText(contractField(source, fallback, 'background', undefined), 'goal background'),
    constraints: textList(contractField(source, fallback, 'constraints', []), 'goal constraint'),
    successCriteria: textList(contractField(source, fallback, 'successCriteria', []), 'goal success criterion'),
    budget: normalizeBudget(contractField(source, fallback, 'budget', undefined)),
    dueAt: dueAt === undefined ? undefined : timestamp(dueAt, 'goal dueAt'),
    riskLevel,
    forbiddenActions: textList(contractField(source, fallback, 'forbiddenActions', []), 'goal forbidden action'),
    acceptance: normalizeAcceptanceSpecs(contractField(source, fallback, 'acceptance', []), 'goal acceptance')
  }
}

export function flattenContract(goal: Goal, contract: GoalContract): void {
  goal.objective = contract.objective
  goal.background = contract.background
  goal.constraints = clone(contract.constraints)
  goal.successCriteria = clone(contract.successCriteria)
  goal.budget = clone(contract.budget)
  goal.dueAt = contract.dueAt
  goal.riskLevel = contract.riskLevel
  goal.forbiddenActions = clone(contract.forbiddenActions)
  goal.acceptance = clone(contract.acceptance)
}

export function normalizeOwner(value: WorkItemOwner | string | null | undefined): WorkItemOwner | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return { type: 'digital_worker', id: requiredId(value, 'work item owner') }
  if (!value || typeof value !== 'object') throw new ProjectWorkspaceError('invalid_input', 'work item owner must be an object')
  if (value.type !== 'human' && value.type !== 'digital_worker') {
    throw new ProjectWorkspaceError('invalid_input', 'work item owner type is invalid')
  }
  return {
    type: value.type,
    id: requiredId(value.id, 'work item owner id'),
    displayName: optionalText(value.displayName, 'work item owner displayName')
  }
}
