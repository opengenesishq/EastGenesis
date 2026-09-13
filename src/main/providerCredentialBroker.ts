import { randomUUID } from 'node:crypto'

export interface CredentialCryptoBackend {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}

export interface ProviderCredentialRef {
  providerId: string
  keyId: string
}

export interface ProviderCredentialRecord {
  encryptedToken: string
  sessionOnly?: boolean
}

export type CredentialStorageState =
  | 'encrypted'
  | 'session'
  | 'legacy-b64'
  | 'unavailable'
  | 'missing'

export interface ProviderCredentialResolution {
  token: string
  storage: CredentialStorageState
  available: boolean
}

export interface ProviderCredentialLeaseScope {
  providerId: string
  projectId: string
  sessionId: string
  operationId: string
}

export interface ProviderCredentialLease extends ProviderCredentialLeaseScope {
  id: string
  keyId: string
  issuedAt: number
  expiresAt: number
}

export interface ProviderCredentialLeaseOptions {
  now?: number
  ttlMs?: number
}

export type ProviderCredentialLeaseErrorCode =
  | 'invalid_scope'
  | 'unavailable'
  | 'not_found'
  | 'scope_mismatch'
  | 'expired'

export class ProviderCredentialLeaseError extends Error {
  readonly name = 'ProviderCredentialLeaseError'

  constructor(readonly code: ProviderCredentialLeaseErrorCode) {
    super(`Provider credential lease rejected: ${code}`)
  }
}

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token'
])

const SENSITIVE_CREDENTIAL_NAME_PART =
  /(?:^|[-_])(?:api[-_]?key|apikey|auth|authcode|authentication|authorization|client[-_]?key|credential|hmac|key|password|private|secret|sig|sign|signature|subscription|token|access[-_]?key)(?:$|[-_])/i
const SENSITIVE_CREDENTIAL_COMPACT_PART =
  /apikey|apisecret|apisign|authcode|authkey|authtoken|bearertoken|clientkey|clientsecret|credential|hmac|password|privatekey|secret|signature|subscriptionkey|accesstoken|accesskey/
const SAFE_CUSTOM_HEADER_NAMES = new Set([
  'accept',
  'accept-encoding',
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'http-referer',
  'openai-organization',
  'openai-project',
  'referer',
  'user-agent',
  'x-rapidapi-host',
  'x-title'
])
const SAFE_CUSTOM_HEADER_NAME_PATTERN =
  /^(?:(?:x-)?(?:account|channel|correlation|debug|deployment|endpoint|experiment|feature|gateway|meta|metadata|model|org|organization|project|provider|region|request|route|routing|source|tag|tenant|trace|vendor|version|workspace)(?:-|$)|helicone-property-)/i
const ALLOWED_MANAGED_CREDENTIAL_HEADER_NAMES = new Set([
  'authorization',
  'api-key',
  'apikey',
  'api_key',
  'x-api-key',
  'x-api_key',
  'x-api-token',
  'x-auth-key',
  'x-auth-token',
  'x-access-token',
  'x-figma-token',
  'x-goog-api-key',
  'x-rapidapi-key',
  'ocp-apim-subscription-key'
])
const CREDENTIAL_VALUE_MARKER =
  /(?:^|[^A-Za-z0-9])(?:(?:basic|bearer)\s+|sk[-_]|gh[pousr]_|github_pat_|glpat-|npm_|xox[baprs]-|AIza|ya29\.|(?:AKIA|ASIA)[A-Z0-9]{12,}|eyJ)/i
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const FORBIDDEN_HEADER_VALUE_CHARACTERS = /[\0-\x08\x0A-\x1F\x7F]/

export type ProviderCredentialSessionSnapshot = Array<[keyId: string, token: string]>

interface ProviderCredentialLeaseState {
  ref: ProviderCredentialRef
  record?: ProviderCredentialRecord
  token?: string
  scope: ProviderCredentialLeaseScope
  issuedAt: number
  expiresAt: number
}

const DEFAULT_LEASE_TTL_MS = 30_000
const MAX_LEASE_TTL_MS = 60_000

export class ProviderCredentialBroker {
  private readonly sessionTokens = new Map<string, Map<string, string>>()
  private readonly leases = new Map<string, ProviderCredentialLeaseState>()
  private readonly knownTokens = new Set<string>()

  constructor(private readonly backend: CredentialCryptoBackend) {}

  canPersistSecurely(): boolean {
    try {
      if (!this.backend.isEncryptionAvailable()) return false
      const selectedBackend = this.backend.getSelectedStorageBackend?.()
      return selectedBackend?.trim().toLowerCase() !== 'basic_text'
    } catch {
      return false
    }
  }

  store(ref: ProviderCredentialRef, token: string): ProviderCredentialRecord {
    if (!isValidProviderCredentialToken(token)) {
      throw new Error('Credential token must be non-empty and must not contain ASCII control characters')
    }
    this.rememberToken(token)
    if (this.canPersistSecurely()) {
      try {
        const encrypted = this.backend.encryptString(token)
        if (!Buffer.isBuffer(encrypted)) throw new Error('Credential encryption returned a non-buffer')
        this.forget(ref)
        return { encryptedToken: `enc:${encrypted.toString('base64')}` }
      } catch {
        // A backend can report itself available and still fail at write time.
        // Keep the new credential in this process instead of writing reversible data.
      }
    }

    this.setSessionToken(ref, token)
    return { encryptedToken: '', sessionOnly: true }
  }

  resolve(
    ref: ProviderCredentialRef,
    record: ProviderCredentialRecord
  ): ProviderCredentialResolution {
    if (record.sessionOnly) {
      const sessionToken = this.getSessionToken(ref)
      if (sessionToken.found) {
        this.rememberToken(sessionToken.token)
        return {
          token: sessionToken.token,
          storage: 'session',
          available: true
        }
      }
      return unavailableResolution()
    }

    const encryptedToken = record.encryptedToken
    if (!encryptedToken) return missingResolution()

    if (encryptedToken.startsWith('enc:')) {
      if (!this.canPersistSecurely()) return unavailableResolution()
      const encrypted = decodeBase64Strict(encryptedToken.slice(4))
      if (!encrypted) return unavailableResolution()
      try {
        const token = this.backend.decryptString(encrypted)
        if (!isValidProviderCredentialToken(token)) return unavailableResolution()
        this.rememberToken(token)
        return {
          token,
          storage: 'encrypted',
          available: true
        }
      } catch {
        return unavailableResolution()
      }
    }

    if (encryptedToken.startsWith('b64:')) {
      const token = decodeUtf8Base64Strict(encryptedToken.slice(4))
      if (token === null || !isValidProviderCredentialToken(token)) return unavailableResolution()
      this.rememberToken(token)
      return {
        token,
        storage: 'legacy-b64',
        available: true
      }
    }

    return unavailableResolution()
  }

  inspect(
    ref: ProviderCredentialRef,
    record: ProviderCredentialRecord
  ): Omit<ProviderCredentialResolution, 'token'> {
    const { storage, available } = this.resolve(ref, record)
    return { storage, available }
  }

  issueLease(
    ref: ProviderCredentialRef,
    record: ProviderCredentialRecord,
    scope: ProviderCredentialLeaseScope,
    options: ProviderCredentialLeaseOptions = {}
  ): ProviderCredentialLease {
    return this.issueLeaseState(ref, { record }, scope, options)
  }

  issueTokenLease(
    ref: ProviderCredentialRef,
    token: string,
    scope: ProviderCredentialLeaseScope,
    options: ProviderCredentialLeaseOptions = {}
  ): ProviderCredentialLease {
    if (!isValidProviderCredentialToken(token)) {
      throw new ProviderCredentialLeaseError('unavailable')
    }
    this.rememberToken(token)
    return this.issueLeaseState(ref, { token }, scope, options)
  }

  redeemLease(
    lease: ProviderCredentialLease,
    expectedScope: ProviderCredentialLeaseScope,
    now = Date.now()
  ): ProviderCredentialResolution {
    const state = this.leases.get(lease.id)
    if (!state) throw new ProviderCredentialLeaseError('not_found')
    // Every redemption attempt consumes the capability, including a mismatched one.
    this.leases.delete(lease.id)
    if (!sameLeaseDescriptor(lease, state) || !sameCredentialScope(expectedScope, state.scope)) {
      throw new ProviderCredentialLeaseError('scope_mismatch')
    }
    if (!Number.isFinite(now) || now >= state.expiresAt) {
      throw new ProviderCredentialLeaseError('expired')
    }
    const resolution = state.record
      ? this.resolve(state.ref, state.record)
      : directTokenResolution(state.token)
    if (!resolution.available || !resolution.token) {
      throw new ProviderCredentialLeaseError('unavailable')
    }
    return resolution
  }

  revokeLease(leaseId: string): void {
    this.leases.delete(leaseId)
  }

  redactKnownCredentials(value: string): string {
    let redacted = value
    for (const token of this.knownTokens) {
      if (token) redacted = redacted.split(token).join('[REDACTED]')
    }
    return redacted
  }

  migrateLegacy(
    ref: ProviderCredentialRef,
    encryptedToken: string
  ): ProviderCredentialRecord | null {
    if (!encryptedToken.startsWith('b64:') || !this.canPersistSecurely()) return null
    const token = decodeUtf8Base64Strict(encryptedToken.slice(4))
    if (!token || !isValidProviderCredentialToken(token)) return null

    try {
      const encrypted = this.backend.encryptString(token)
      if (!Buffer.isBuffer(encrypted)) return null
      this.forget(ref)
      return { encryptedToken: `enc:${encrypted.toString('base64')}` }
    } catch {
      return null
    }
  }

  forget(ref: ProviderCredentialRef): void {
    this.revokeMatchingLeases(ref)
    const providerTokens = this.sessionTokens.get(ref.providerId)
    if (!providerTokens) return
    providerTokens.delete(ref.keyId)
    if (providerTokens.size === 0) this.sessionTokens.delete(ref.providerId)
  }

  forgetProvider(providerId: string): void {
    this.sessionTokens.delete(providerId)
    for (const [leaseId, state] of this.leases) {
      if (state.ref.providerId === providerId) this.leases.delete(leaseId)
    }
  }

  snapshotProvider(providerId: string): ProviderCredentialSessionSnapshot {
    return [...(this.sessionTokens.get(providerId)?.entries() ?? [])]
  }

  restoreProvider(providerId: string, snapshot: ProviderCredentialSessionSnapshot): void {
    if (snapshot.length === 0) {
      this.sessionTokens.delete(providerId)
      return
    }
    this.sessionTokens.set(providerId, new Map(snapshot))
  }

  private setSessionToken(ref: ProviderCredentialRef, token: string): void {
    let providerTokens = this.sessionTokens.get(ref.providerId)
    if (!providerTokens) {
      providerTokens = new Map()
      this.sessionTokens.set(ref.providerId, providerTokens)
    }
    providerTokens.set(ref.keyId, token)
  }

  private getSessionToken(
    ref: ProviderCredentialRef
  ): { found: true; token: string } | { found: false; token: '' } {
    const providerTokens = this.sessionTokens.get(ref.providerId)
    if (!providerTokens?.has(ref.keyId)) return { found: false, token: '' }
    return { found: true, token: providerTokens.get(ref.keyId) ?? '' }
  }

  private issueLeaseState(
    ref: ProviderCredentialRef,
    credential: { record?: ProviderCredentialRecord; token?: string },
    scope: ProviderCredentialLeaseScope,
    options: ProviderCredentialLeaseOptions
  ): ProviderCredentialLease {
    const normalizedRef = validCredentialRef(ref)
    const normalizedScope = validCredentialScope(scope)
    if (!normalizedRef || !normalizedScope || normalizedRef.providerId !== normalizedScope.providerId) {
      throw new ProviderCredentialLeaseError('invalid_scope')
    }
    if (credential.record && !this.inspect(normalizedRef, credential.record).available) {
      throw new ProviderCredentialLeaseError('unavailable')
    }
    const issuedAt = finiteTimestamp(options.now, Date.now())
    const requestedTtl = finiteTimestamp(options.ttlMs, DEFAULT_LEASE_TTL_MS)
    const ttlMs = Math.min(MAX_LEASE_TTL_MS, Math.max(1, requestedTtl))
    const expiresAt = issuedAt + ttlMs
    this.pruneExpiredLeases(issuedAt)
    const id = randomUUID()
    const state: ProviderCredentialLeaseState = {
      ref: normalizedRef,
      ...credential,
      scope: normalizedScope,
      issuedAt,
      expiresAt
    }
    this.leases.set(id, state)
    return { id, keyId: normalizedRef.keyId, ...normalizedScope, issuedAt, expiresAt }
  }

  private revokeMatchingLeases(ref: ProviderCredentialRef): void {
    for (const [leaseId, state] of this.leases) {
      if (state.ref.providerId === ref.providerId && state.ref.keyId === ref.keyId) {
        this.leases.delete(leaseId)
      }
    }
  }

  private pruneExpiredLeases(now: number): void {
    for (const [leaseId, state] of this.leases) {
      if (now >= state.expiresAt) this.leases.delete(leaseId)
    }
  }

  private rememberToken(token: string): void {
    if (isValidProviderCredentialToken(token)) this.knownTokens.add(token)
  }
}

function validCredentialRef(ref: ProviderCredentialRef): ProviderCredentialRef | null {
  const providerId = validScopePart(ref.providerId)
  const keyId = validScopePart(ref.keyId)
  return providerId && keyId ? { providerId, keyId } : null
}

function validCredentialScope(scope: ProviderCredentialLeaseScope): ProviderCredentialLeaseScope | null {
  const providerId = validScopePart(scope.providerId)
  const projectId = validScopePart(scope.projectId)
  const sessionId = validScopePart(scope.sessionId)
  const operationId = validScopePart(scope.operationId)
  return providerId && projectId && sessionId && operationId
    ? { providerId, projectId, sessionId, operationId }
    : null
}

function validScopePart(value: string): string | null {
  if (typeof value !== 'string' || value !== value.trim() || value.length === 0 || value.length > 256) return null
  return /[\0-\x1F\x7F]/.test(value) ? null : value
}

function sameCredentialScope(
  left: ProviderCredentialLeaseScope,
  right: ProviderCredentialLeaseScope
): boolean {
  const normalized = validCredentialScope(left)
  return Boolean(normalized)
    && normalized!.providerId === right.providerId
    && normalized!.projectId === right.projectId
    && normalized!.sessionId === right.sessionId
    && normalized!.operationId === right.operationId
}

function sameLeaseDescriptor(
  lease: ProviderCredentialLease,
  state: ProviderCredentialLeaseState
): boolean {
  return lease.keyId === state.ref.keyId
    && lease.issuedAt === state.issuedAt
    && lease.expiresAt === state.expiresAt
    && sameCredentialScope(lease, state.scope)
}

function finiteTimestamp(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
}

function directTokenResolution(token: string | undefined): ProviderCredentialResolution {
  return token && isValidProviderCredentialToken(token)
    ? { token, storage: 'session', available: true }
    : unavailableResolution()
}

export function isSensitiveProviderHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase()
  const compact = normalized.replace(/[-_\s]/g, '')
  return SENSITIVE_HEADER_NAMES.has(normalized)
    || SENSITIVE_CREDENTIAL_NAME_PART.test(normalized)
    || SENSITIVE_CREDENTIAL_COMPACT_PART.test(compact)
}

export function isAllowedProviderCustomHeaderName(name: string): boolean {
  const trimmed = name.trim()
  if (trimmed !== name || !trimmed || trimmed.length > 80 || !HTTP_HEADER_NAME.test(trimmed)) return false
  const normalized = trimmed.toLowerCase()
  return SAFE_CUSTOM_HEADER_NAMES.has(normalized) || SAFE_CUSTOM_HEADER_NAME_PATTERN.test(normalized)
}

export function isAllowedProviderManagedCredentialHeaderName(name: string): boolean {
  const trimmed = name.trim()
  return Boolean(trimmed)
    && trimmed.length <= 80
    && HTTP_HEADER_NAME.test(trimmed)
    && ALLOWED_MANAGED_CREDENTIAL_HEADER_NAMES.has(trimmed.toLowerCase())
}

export function looksLikeProviderCredentialValue(value: string): boolean {
  return CREDENTIAL_VALUE_MARKER.test(value.trim())
}

export function inspectProviderBaseUrl(value: string): {
  safeValue: string
  rejectedNames: string[]
} {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value.trim()
      ? { safeValue: '', rejectedNames: ['invalid Base URL'] }
      : { safeValue: value, rejectedNames: [] }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { safeValue: '', rejectedNames: [`URL protocol ${url.protocol}`] }
  }

  const rejectedNames: string[] = []
  const discardUrl = inspectProviderUrlAuthority(url, rejectedNames)
  inspectProviderUrlPath(url, rejectedNames)
  inspectProviderUrlQuery(value, url, rejectedNames)
  inspectProviderUrlFragment(value, url, rejectedNames)

  return {
    safeValue: rejectedNames.length > 0 ? (discardUrl ? '' : url.toString()) : value,
    rejectedNames
  }
}

export function inspectProviderCustomHeaders(value: string): {
  safeValue: string
  rejectedNames: string[]
} {
  const lines = splitHeaderLines(value)
  const rejectedNames: string[] = []
  const seenRejectedNames = new Set<string>()
  const safeLines: HeaderLine[] = []

  for (const line of lines) {
    const inspection = inspectProviderHeaderLine(line)
    if (inspection.safeLine) safeLines.push(inspection.safeLine)
    if (inspection.rejectedName) {
      addUniqueRejectedName(inspection.rejectedName, rejectedNames, seenRejectedNames)
    }
  }

  return {
    safeValue: joinSafeHeaderLines(safeLines, endsWithLineBreak(value)),
    rejectedNames
  }
}

interface HeaderLine {
  value: string
  ending: string
}

function inspectProviderUrlAuthority(url: URL, rejectedNames: string[]): boolean {
  if (url.username || url.password) {
    rejectedNames.push('URL userinfo')
    url.username = ''
    url.password = ''
  }
  if (!looksLikeProviderCredentialValue(url.hostname)) return false
  rejectedNames.push('credential-like URL host')
  return true
}

function inspectProviderUrlPath(url: URL, rejectedNames: string[]): void {
  let decodedPathname = url.pathname
  try {
    decodedPathname = decodeURIComponent(url.pathname)
  } catch {
    rejectedNames.push('invalid URL path encoding')
    url.pathname = '/'
  }
  if (looksLikeProviderCredentialValue(decodedPathname)) {
    rejectedNames.push('credential-like URL path')
    url.pathname = '/'
  }
}

function inspectProviderUrlQuery(value: string, url: URL, rejectedNames: string[]): void {
  const queryNames = [...new Set(url.searchParams.keys())]
  for (const name of queryNames) {
    pushUniqueRejectedName(rejectedProviderQueryName(name), rejectedNames)
  }
  if (queryNames.length > 0 || value.includes('?')) {
    if (queryNames.length === 0) rejectedNames.push('URL query')
    url.search = ''
  }
}

function rejectedProviderQueryName(name: string): string {
  if (looksLikeProviderCredentialValue(name)) return '(credential-like query parameter)'
  if (name && name.length <= 80 && !/[\0-\x1F\x7F]/.test(name)) return name
  return '(invalid query parameter)'
}

function inspectProviderUrlFragment(value: string, url: URL, rejectedNames: string[]): void {
  if (url.hash || value.includes('#')) {
    rejectedNames.push('URL fragment')
    url.hash = ''
  }
}

function pushUniqueRejectedName(name: string, rejectedNames: string[]): void {
  if (!rejectedNames.some((item) => item.toLowerCase() === name.toLowerCase())) rejectedNames.push(name)
}

function inspectProviderHeaderLine(line: HeaderLine): {
  safeLine?: HeaderLine
  rejectedName?: string
} {
  const colonIndex = line.value.indexOf(':')
  if (colonIndex <= 0) {
    return line.value.trim() ? { rejectedName: '(invalid header line)' } : { safeLine: line }
  }
  const name = line.value.slice(0, colonIndex)
  const headerValue = line.value.slice(colonIndex + 1).replace(/^[ \t]+|[ \t]+$/g, '')
  if (isSafeProviderHeader(name, headerValue)) {
    return {
      safeLine: { value: `${name}:${headerValue ? ` ${headerValue}` : ''}`, ending: line.ending }
    }
  }
  return { rejectedName: rejectedProviderHeaderName(name) }
}

function isSafeProviderHeader(name: string, value: string): boolean {
  return !isSensitiveProviderHeaderName(name)
    && isAllowedProviderCustomHeaderName(name)
    && !looksLikeProviderCredentialValue(name)
    && value.length <= 8192
    && !FORBIDDEN_HEADER_VALUE_CHARACTERS.test(value)
    && !looksLikeProviderCredentialValue(value)
}

function rejectedProviderHeaderName(name: string): string {
  if (looksLikeProviderCredentialValue(name)) return '(credential-like header name)'
  if (name && name.length <= 80 && HTTP_HEADER_NAME.test(name)) return name
  return '(invalid header name)'
}

function addUniqueRejectedName(
  name: string,
  rejectedNames: string[],
  seenRejectedNames: Set<string>
): void {
  const normalizedName = name.toLowerCase()
  if (seenRejectedNames.has(normalizedName)) return
  rejectedNames.push(name)
  seenRejectedNames.add(normalizedName)
}

function decodeBase64Strict(value: string): Buffer | null {
  if (
    !value ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null
  }

  try {
    const decoded = Buffer.from(value, 'base64')
    return decoded.toString('base64') === value ? decoded : null
  } catch {
    return null
  }
}

function decodeUtf8Base64Strict(value: string): string | null {
  const decoded = decodeBase64Strict(value)
  if (!decoded) return null
  const token = decoded.toString('utf8')
  return Buffer.from(token, 'utf8').equals(decoded) ? token : null
}

function isValidProviderCredentialToken(token: string): boolean {
  return Boolean(token) && !/[\0-\x1F\x7F]/.test(token)
}

function unavailableResolution(): ProviderCredentialResolution {
  return { token: '', storage: 'unavailable', available: false }
}

function missingResolution(): ProviderCredentialResolution {
  return { token: '', storage: 'missing', available: false }
}

function splitHeaderLines(value: string): HeaderLine[] {
  const lines: HeaderLine[] = []
  const matcher = /([^\r\n]*)(\r\n|\r|\n|$)/g
  let match: RegExpExecArray | null

  while ((match = matcher.exec(value)) !== null) {
    if (match[0] === '') break
    lines.push({ value: match[1], ending: match[2] })
  }

  return lines
}

function joinSafeHeaderLines(lines: HeaderLine[], preserveTrailingLineBreak: boolean): string {
  return lines
    .map((line, index) => {
      const isLast = index === lines.length - 1
      if (!isLast || preserveTrailingLineBreak) return `${line.value}${line.ending || '\n'}`
      return line.value
    })
    .join('')
}

function endsWithLineBreak(value: string): boolean {
  return /(?:\r\n|\r|\n)$/.test(value)
}
