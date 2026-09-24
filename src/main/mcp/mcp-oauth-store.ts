import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { McpOAuthBinding } from '../../shared/mcp-oauth-types'
import type { ProviderCredentialRecord, ProviderCredentialRef, ProviderCredentialResolution } from '../providerCredentialBroker'
import type { McpOAuthMetadata } from './mcp-oauth-discovery'

export interface McpOAuthGrant {
  connectionId: string
  binding: McpOAuthBinding
  metadata: McpOAuthMetadata
  clientId: string
  scopes: string[]
  grantedAt: number
  expiresAt?: number
  access: ProviderCredentialRecord
  refresh?: ProviderCredentialRecord
  authorizationRequired?: boolean
}
export interface McpOAuthCredentials {
  store(ref: ProviderCredentialRef, token: string): ProviderCredentialRecord
  resolve(ref: ProviderCredentialRef, record: ProviderCredentialRecord): ProviderCredentialResolution
  forget(ref: ProviderCredentialRef): void
}

export class McpOAuthStore {
  private grants = new Map<string, McpOAuthGrant>()
  private readonly path: string
  constructor(root: string) {
    this.path = join(root, 'mcp-oauth.json')
    try {
      if (statSync(this.path).size > 1024 * 1024) return
      const value = JSON.parse(readFileSync(this.path, 'utf8'))
      if (value.schemaVersion !== 1 || !Array.isArray(value.grants)) return
      for (const item of value.grants) {
        if (Array.isArray(item) && typeof item[0] === 'string' && /^[a-f0-9]{64}$/.test(item[0]) && validGrant(item[1])) this.grants.set(item[0], item[1])
      }
    } catch { /* No authorization can be recovered from an absent or invalid state file. */ }
  }
  get(key: string): McpOAuthGrant | undefined { const value = this.grants.get(key); return value && structuredClone(value) }
  set(key: string, grant: McpOAuthGrant): void { const next = new Map(this.grants); next.set(key, structuredClone(grant)); this.persist(next) }
  delete(key: string): void { const next = new Map(this.grants); next.delete(key); this.persist(next) }
  private persist(next: Map<string, McpOAuthGrant>): void {
    if (next.size > 256) throw new Error('MCP OAuth 连接数已达到上限。')
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, grants: [...next] }), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, this.path); this.grants = next
  }
}
function validGrant(value: unknown): value is McpOAuthGrant {
  if (!value || typeof value !== 'object') return false
  const grant = value as McpOAuthGrant
  const credential = (record: ProviderCredentialRecord | undefined): boolean => !!record && typeof record.encryptedToken === 'string' && (record.encryptedToken.startsWith('enc:') || (record.encryptedToken === '' && record.sessionOnly === true))
  return typeof grant.connectionId === 'string' && !!grant.connectionId && !!grant.binding && ['registryItemKey', 'contentDigest', 'capabilityDigest', 'serverId'].every(key => typeof grant.binding[key as keyof McpOAuthBinding] === 'string')
    && !!grant.metadata && ['resource', 'issuer', 'authorizationEndpoint', 'tokenEndpoint'].every(key => typeof grant.metadata[key as keyof McpOAuthMetadata] === 'string')
    && typeof grant.clientId === 'string' && Array.isArray(grant.scopes) && grant.scopes.every(scope => typeof scope === 'string')
    && Number.isFinite(grant.grantedAt) && credential(grant.access) && (!grant.refresh || credential(grant.refresh))
}
