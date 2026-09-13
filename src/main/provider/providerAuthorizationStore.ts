import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ProviderAuthorizationAccountView,
  ProviderAuthorizationAccountPolicy,
  ProviderAuthorizationQuotaView,
  ProviderAuthorizationService
} from '../../shared/provider-authorization-types'
import type { ProviderCredentialStorage } from '../../shared/types'
import type { ProviderCredentialRecord } from '../providerCredentialBroker'
import {
  forgetProviderCredential,
  inspectProviderCredential,
  resolveProviderCredential,
  restoreProviderCredentials,
  snapshotProviderCredentials,
  storeProviderCredential
} from '../providerCredentialRuntime'
import { normalizeProviderAuthorizationAccountPolicy } from './providerAuthorizationRouting'
import { stageProviderAuthorizationPoolDigest } from '../providers'
import { changedAuthorizationPools, readAuthorizationPoolDocument } from './providerAuthorizationPoolIdentity'
import { withProviderStoreMutationLock } from './providerStoreMutationLock'

interface StoredProviderAuthorizationAccount {
  schemaVersion: 1
  id: string
  providerId: string
  service: ProviderAuthorizationService
  label: string
  refreshToken: ProviderCredentialRecord
  authenticatedAt: number
  updatedAt: number
  policy?: ProviderAuthorizationAccountPolicy
  lastFailureAt?: number
  lastQuota?: ProviderAuthorizationQuotaView
}

const MAX_STORE_BYTES = 2 * 1024 * 1024
let cache: StoredProviderAuthorizationAccount[] | null = null

export function listProviderAuthorizationAccountsFromStore(
  providerId: string,
  boundAccountId?: string,
  service?: ProviderAuthorizationService
): ProviderAuthorizationAccountView[] {
  return load()
    .filter((account) => account.providerId === providerId && (!service || account.service === service))
    .map((account) => toView(account, boundAccountId))
    .sort((left, right) => Number(right.bound) - Number(left.bound) || right.updatedAt - left.updatedAt)
}

export function storeProviderAuthorizationAccount(input: {
  id: string
  providerId: string
  service?: ProviderAuthorizationService
  label: string
  refreshToken: string
  authenticatedAt: number
}): ProviderAuthorizationAccountView {
  const current = clone(load())
  const service = input.service ?? 'xai-oauth'
  const previous = current.find((account) =>
    account.providerId === input.providerId && account.id === input.id && account.service === service)
  const ref = credentialRef(input.providerId, input.id, service)
  const snapshot = snapshotProviderCredentials(ref.providerId)
  try {
    const now = Date.now()
    const next: StoredProviderAuthorizationAccount = {
      schemaVersion: 1,
      id: validId(input.id, 'account id'),
      providerId: validId(input.providerId, 'provider id'),
      service,
      label: validLabel(input.label),
      refreshToken: storeProviderCredential(ref, input.refreshToken),
      authenticatedAt: validTimestamp(input.authenticatedAt),
      updatedAt: now,
      policy: normalizeProviderAuthorizationAccountPolicy(previous?.policy),
      lastFailureAt: previous?.lastFailureAt,
      lastQuota: previous?.lastQuota
    }
    const index = previous ? current.indexOf(previous) : -1
    if (index >= 0) current[index] = next
    else current.push(next)
    persist(current)
    return toView(next, input.id)
  } catch (error) {
    restoreProviderCredentials(ref.providerId, snapshot)
    throw error
  }
}

export function updateStoredProviderAuthorizationAccountPolicy(
  providerId: string,
  accountId: string,
  service: ProviderAuthorizationService,
  policy: Partial<ProviderAuthorizationAccountPolicy>
): ProviderAuthorizationAccountView {
  const current = clone(load())
  const index = current.findIndex((account) =>
    account.providerId === providerId && account.id === accountId && account.service === service)
  if (index < 0) throw new Error('Provider authorization account was not found')
  current[index] = {
    ...current[index],
    policy: normalizeProviderAuthorizationAccountPolicy({ ...current[index].policy, ...policy }),
    updatedAt: Date.now()
  }
  persist(current)
  return toView(current[index], accountId)
}

export function markStoredProviderAuthorizationAccountFailure(
  providerId: string,
  accountId: string,
  service: ProviderAuthorizationService,
  failedAt = Date.now()
): void {
  const current = clone(load())
  const index = current.findIndex((account) =>
    account.providerId === providerId && account.id === accountId && account.service === service)
  if (index < 0) return
  current[index] = { ...current[index], lastFailureAt: validTimestamp(failedAt), updatedAt: failedAt }
  persist(current)
}

export function recordStoredProviderAuthorizationQuota(
  quota: ProviderAuthorizationQuotaView,
  service: ProviderAuthorizationService
): void {
  const current = clone(load())
  const index = current.findIndex((account) =>
    account.providerId === quota.providerId && account.id === quota.accountId && account.service === service)
  if (index < 0) return
  current[index] = {
    ...current[index],
    lastQuota: cloneQuota(quota),
    updatedAt: Math.max(current[index].updatedAt, quota.queriedAt)
  }
  persist(current)
}

export function resolveProviderAuthorizationRefreshToken(
  providerId: string,
  accountId: string,
  service: ProviderAuthorizationService = 'xai-oauth'
): string {
  const account = load().find((item) =>
    item.providerId === providerId && item.id === accountId && item.service === service)
  if (!account) throw new Error('Provider authorization account was not found')
  const resolved = resolveProviderCredential(credentialRef(providerId, accountId, service), account.refreshToken)
  if (!resolved.available || !resolved.token) throw new Error('Provider authorization must be renewed')
  return resolved.token
}

export function removeProviderAuthorizationAccount(
  providerId: string,
  accountId: string,
  service?: ProviderAuthorizationService
): boolean {
  const current = clone(load())
  const removed = current.filter((account) =>
    account.providerId === providerId && account.id === accountId && (!service || account.service === service))
  const next = current.filter((account) => !removed.includes(account))
  if (next.length === current.length) return false
  persist(next)
  for (const account of removed) forgetProviderCredential(credentialRef(providerId, accountId, account.service))
  return true
}

export function removeAllProviderAuthorizationAccounts(providerId: string): void {
  const current = clone(load())
  const removed = current.filter((account) => account.providerId === providerId)
  if (removed.length === 0) return
  persist(current.filter((account) => account.providerId !== providerId))
  for (const account of removed) forgetProviderCredential(credentialRef(providerId, account.id, account.service))
}

function load(): StoredProviderAuthorizationAccount[] {
  if (cache) return cache
  const file = storeFile()
  if (!existsSync(file)) return (cache = [])
  const info = lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STORE_BYTES) {
    throw new Error('Provider authorization store is invalid')
  }
  if (process.platform !== 'win32') chmodSync(file, 0o600)
  const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
  if (!Array.isArray(value)) {
    throw new Error('Provider authorization store is corrupted')
  }
  const supported = value.filter((entry) => !hasUnsupportedAuthorizationService(entry))
  if (!supported.every(isStoredAccount)) throw new Error('Provider authorization store is corrupted')
  if (supported.length !== value.length) persist(supported)
  cache = clone(supported)
  return cache
}

function persist(accounts: StoredProviderAuthorizationAccount[]): void {
  if (!accounts.every(isStoredAccount)) throw new Error('Provider authorization store value is invalid')
  // Hold the Provider mutation lock across both files. The identity revision is
  // staged first, then the authorization pool is committed while no competing
  // Provider/profile or OAuth-pool writer can interleave. If the second write
  // fails, the staged revision intentionally remains conservative and execution
  // stays blocked until the same desired pool is retried or reconciled.
  withProviderStoreMutationLock(app.getPath('userData'), () => {
    const changes = changedAuthorizationPools(readAuthorizationPoolDocument(app.getPath('userData')), accounts)
    for (const change of changes) stageProviderAuthorizationPoolDigest(change.providerId, change.digest)
    const file = storeFile()
    const temp = `${file}.tmp-${process.pid}-${randomUUID()}`
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    try {
      const descriptor = openSync(temp, 'wx', 0o600)
      try {
        writeFileSync(descriptor, `${JSON.stringify(accounts, null, 2)}\n`, 'utf8')
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      renameSync(temp, file)
      if (process.platform !== 'win32') chmodSync(file, 0o600)
    } catch (error) {
      cache = null
      try { unlinkSync(temp) } catch { /* best effort */ }
      throw error
    }
    cache = clone(accounts)
  })
}

function toView(
  account: StoredProviderAuthorizationAccount,
  boundAccountId?: string
): ProviderAuthorizationAccountView {
  const credential = inspectProviderCredential(
    credentialRef(account.providerId, account.id, account.service),
    account.refreshToken
  )
  return {
    id: account.id,
    providerId: account.providerId,
    service: account.service,
    label: account.label,
    authenticatedAt: account.authenticatedAt,
    updatedAt: account.updatedAt,
    bound: account.id === boundAccountId,
    requiresReauth: !credential.available,
    credentialStorage: credentialStorage(credential.storage),
    policy: normalizeProviderAuthorizationAccountPolicy(account.policy),
    lastFailureAt: account.lastFailureAt,
    lastQuota: account.lastQuota ? cloneQuota(account.lastQuota) : undefined
  }
}

function credentialRef(
  providerId: string,
  accountId: string,
  service: ProviderAuthorizationService
): { providerId: string; keyId: string } {
  return {
    providerId: `provider-authorization:${providerId}`,
    keyId: `xai-refresh:${createHash('sha256').update(accountId).digest('hex')}`
  }
}

function storeFile(): string {
  return join(app.getPath('userData'), 'provider-authorizations.json')
}

function isStoredAccount(value: unknown): value is StoredProviderAuthorizationAccount {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const account = value as Partial<StoredProviderAuthorizationAccount>
  return [
    account.schemaVersion === 1,
    isAuthorizationService(account.service),
    typeof account.id === 'string',
    typeof account.providerId === 'string',
    typeof account.label === 'string',
    typeof account.authenticatedAt === 'number',
    typeof account.updatedAt === 'number',
    optionalStoredPolicy(account.policy),
    optionalStoredTimestamp(account.lastFailureAt),
    optionalStoredQuota(account.lastQuota, account.providerId, account.id),
    Boolean(account.refreshToken),
    typeof account.refreshToken?.encryptedToken === 'string'
  ].every(Boolean)
}

function optionalStoredPolicy(value: unknown): boolean {
  return value === undefined || isStoredPolicy(value)
}

function optionalStoredTimestamp(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && validStoredTimestamp(value))
}

function optionalStoredQuota(value: unknown, providerId: unknown, accountId: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const quota = value as Partial<ProviderAuthorizationQuotaView>
  return isStoredQuotaHeader(quota, providerId, accountId)
    && quota.tiers.every(isStoredQuotaTier)
    && optionalStoredErrorCode(quota.errorCode)
}

function isStoredQuotaHeader(
  quota: Partial<ProviderAuthorizationQuotaView>,
  providerId: unknown,
  accountId: unknown
): quota is ProviderAuthorizationQuotaView {
  return [
    quota.providerId === providerId,
    quota.accountId === accountId,
    ['ready', 'expired', 'unavailable'].includes(String(quota.status)),
    typeof quota.queriedAt === 'number' && validStoredTimestamp(quota.queriedAt),
    Array.isArray(quota.tiers),
    Array.isArray(quota.tiers) && quota.tiers.length <= 16
  ].every(Boolean)
}

function isStoredQuotaTier(tier: ProviderAuthorizationQuotaView['tiers'][number]): boolean {
  if (!tier) return false
  return [
    typeof tier.name === 'string',
    tier.name.length > 0,
    tier.name.length <= 80,
    typeof tier.utilization === 'number',
    Number.isFinite(tier.utilization),
    tier.utilization >= 0,
    tier.utilization <= 100,
    optionalFiniteNumber(tier.windowSeconds),
    optionalStoredTimestamp(tier.resetsAt)
  ].every(Boolean)
}

function optionalStoredErrorCode(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= 160)
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function isStoredPolicy(value: unknown): value is ProviderAuthorizationAccountPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const policy = value as Partial<ProviderAuthorizationAccountPolicy>
  return typeof policy.enabled === 'boolean'
    && typeof policy.priority === 'number'
    && typeof policy.minimumQuotaRemainingPercent === 'number'
    && typeof policy.requireKnownQuota === 'boolean'
    && typeof policy.failureCooldownMinutes === 'number'
}

function validStoredTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function isAuthorizationService(value: unknown): value is ProviderAuthorizationService {
  return value === 'xai-oauth'
}

function hasUnsupportedAuthorizationService(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && 'service' in value && !isAuthorizationService(value.service))
}

function validId(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 512 || /[\0-\x1f\x7f]/.test(normalized)) {
    throw new Error(`Provider authorization ${label} is invalid`)
  }
  return normalized
}

function validLabel(value: string): string {
  const label = value.trim()
  if (!label || label.length > 320 || /[\0\r\n]/.test(label)) {
    throw new Error('Provider authorization account label is invalid')
  }
  return label
}

function validTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Provider authorization timestamp is invalid')
  return value
}

function credentialStorage(value: string): ProviderCredentialStorage {
  if (value === 'encrypted' || value === 'session' || value === 'legacy-b64' || value === 'unavailable') return value
  return 'none'
}

function clone(accounts: StoredProviderAuthorizationAccount[]): StoredProviderAuthorizationAccount[] {
  return accounts.map((account) => ({
    ...account,
    refreshToken: { ...account.refreshToken },
    lastQuota: account.lastQuota ? cloneQuota(account.lastQuota) : undefined
  }))
}

function cloneQuota(quota: ProviderAuthorizationQuotaView): ProviderAuthorizationQuotaView {
  return { ...quota, tiers: quota.tiers.map((tier) => ({ ...tier })) }
}
