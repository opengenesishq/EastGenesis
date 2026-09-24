import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { McpOAuthBinding, McpOAuthConnectOptions, McpOAuthPreparation, McpOAuthState } from '../../shared/mcp-oauth-types'
import type { McpServerConfig } from './mcp-client'
import { createMcpOAuthCallback, type McpOAuthCallback } from './mcp-oauth-callback'
import { defaultOAuthRequest, discoverMcpOAuth, oauthJson, oauthScopes, validateOAuthEndpoint, type McpOAuthMetadata, type OAuthRequest } from './mcp-oauth-discovery'
import { McpOAuthStore, type McpOAuthCredentials, type McpOAuthGrant } from './mcp-oauth-store'

interface AuthorizedConfig { binding: McpOAuthBinding; config: McpServerConfig }
export interface McpOAuthServiceDependencies {
  root: string
  authorize(binding: McpOAuthBinding): AuthorizedConfig
  credentials: McpOAuthCredentials
  openExternal(url: string): Promise<void>
  request?: OAuthRequest
}
interface Preparation { public: McpOAuthPreparation; metadata: McpOAuthMetadata; binding: McpOAuthBinding; owner: number }
interface Pending { owner: number; controller: AbortController; callback?: McpOAuthCallback; epoch: number }
interface TokenResult { access: string; refresh?: string; expiresAt?: number; scopes?: string[] }
export class McpOAuthService {
  private readonly store: McpOAuthStore
  private readonly request: OAuthRequest
  private readonly preparations = new Map<string, Preparation>()
  private readonly pending = new Map<string, Pending>()
  private readonly messages = new Map<string, string>()
  private readonly epochs = new Map<string, number>()
  private readonly refreshes = new Map<string, Promise<string>>()
  private readonly blocked = new Set<string>()
  constructor(private readonly deps: McpOAuthServiceDependencies) { this.store = new McpOAuthStore(deps.root); this.request = deps.request ?? defaultOAuthRequest }

  get(binding: McpOAuthBinding, owner?: number): McpOAuthState {
    const authorized = this.deps.authorize(binding), { config } = authorized
    if (config.command || !config.url) return { status: 'unsupported', message: '本地 stdio MCP 使用进程环境凭据，无远程 OAuth 连接。' }
    const key = mcpOAuthKey(binding, config), grant = this.store.get(key), preparation = this.preparations.get(key)
    const common = { resource: config.url, message: this.messages.get(key) }
    if (this.pending.has(key)) return { ...common, status: 'authorizing', issuer: preparation?.metadata.issuer }
    if (preparation && preparation.public.expiresAt > Date.now() && preparation.owner === owner) return { ...common, status: 'ready', preparation: preparation.public }
    if (grant) {
      const credential = this.deps.credentials.resolve(ref(key, 'access'), grant.access)
      const needs = grant.authorizationRequired || this.blocked.has(key) || !credential.available || (!!grant.expiresAt && grant.expiresAt <= Date.now() && !grant.refresh)
      return { ...common, status: needs ? 'authorization_required' : 'connected', issuer: grant.metadata.issuer, scopes: grant.scopes, expiresAt: grant.expiresAt, storage: grant.access.sessionOnly || grant.refresh?.sessionOnly ? 'session' : 'encrypted',
        ...(!credential.available && !common.message ? { message: '本次运行凭据已不可用，请重新连接。' } : {}) }
    }
    return { ...common, status: 'disconnected' }
  }

  async prepare(binding: McpOAuthBinding, owner: number, current: () => void): Promise<McpOAuthState> {
    const { config } = this.deps.authorize(binding), key = mcpOAuthKey(binding, config)
    if (config.command || !config.url) throw new Error('仅远程 HTTP / SSE MCP 支持 OAuth。')
    if (this.pending.has(key)) throw new Error('此 MCP 正在授权，请先完成或取消。')
    this.cancelKey(key); this.preparations.delete(key); this.messages.delete(key)
    const operation: Pending = { owner, controller: new AbortController(), epoch: this.epoch(key) }
    this.pending.set(key, operation)
    try {
      current()
      const metadata = await discoverMcpOAuth(config.url, this.request, operation.controller.signal)
      this.assertCurrent(key, binding, operation, current)
      this.preparations.set(key, { owner, binding: { ...binding }, metadata, public: { id: randomUUID(), resource: metadata.resource, issuer: metadata.issuer, scopes: metadata.scopes, dynamicRegistration: !!metadata.registrationEndpoint, expiresAt: Date.now() + 5 * 60_000 } })
    } finally { if (this.pending.get(key) === operation) this.pending.delete(key) }
    return this.get(binding, owner)
  }

  preview(binding: McpOAuthBinding, options: McpOAuthConnectOptions, owner: number): McpOAuthPreparation {
    const { config } = this.deps.authorize(binding), key = mcpOAuthKey(binding, config)
    return this.requirePreparation(key, options, owner).public
  }

  async connect(binding: McpOAuthBinding, options: McpOAuthConnectOptions, owner: number, current: () => void): Promise<McpOAuthState> {
    const { config } = this.deps.authorize(binding), key = mcpOAuthKey(binding, config)
    if (this.pending.has(key) || this.refreshes.has(key)) throw new Error('此 MCP 正在授权或刷新，请稍后重试。')
    const preparation = this.requirePreparation(key, options, owner), metadata = preparation.metadata
    const scopes = options.scopes === undefined ? metadata.scopes : oauthScopes(options.scopes)
    if (scopes.some(scope => !metadata.scopes.includes(scope))) throw new Error('授权范围超出本次资源声明，请重新检查授权。')
    const providedClient = options.clientId?.trim()
    if (providedClient && (providedClient.length > 2048 || /[\0-\x20\x7f]/.test(providedClient))) throw new Error('OAuth client_id 格式无效。')
    if (!providedClient && !metadata.registrationEndpoint) throw new Error('此服务不支持动态注册，请填写已注册的 public client_id。')
    const operation: Pending = { owner, controller: new AbortController(), epoch: this.epoch(key) }
    this.pending.set(key, operation); this.messages.delete(key)
    try {
      const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url')
      operation.callback = await createMcpOAuthCallback(state, metadata.issuer, metadata.issuerResponseRequired, options.callbackPort, operation.controller.signal)
      this.assertCurrent(key, binding, operation, current)
      const redirectUri = operation.callback.redirectUri
      let clientId = providedClient
      if (!clientId) {
    const registration = await oauthJson(this.request, metadata.registrationEndpoint!, { method: 'POST', signal: operation.controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'EastGenesis', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) })
        this.assertCurrent(key, binding, operation, current)
        if (registration.client_secret || (registration.token_endpoint_auth_method && registration.token_endpoint_auth_method !== 'none') || typeof registration.client_id !== 'string' || !registration.client_id || registration.client_id.length > 2048 || /[\0-\x20\x7f]/.test(registration.client_id)) throw new Error('服务未注册兼容的 public client。')
        if (Array.isArray(registration.redirect_uris) && !registration.redirect_uris.includes(redirectUri)) throw new Error('服务注册的回调地址不匹配。')
        clientId = registration.client_id
      }
      const authorization = new URL(metadata.authorizationEndpoint)
      const params: Record<string, string> = { response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: metadata.resource }
      for (const [name, value] of Object.entries(params)) authorization.searchParams.set(name, value)
      if (scopes.length) authorization.searchParams.set('scope', scopes.join(' ')); else authorization.searchParams.delete('scope')
      await validateOAuthEndpoint(authorization.href, metadata.resource)
      this.assertCurrent(key, binding, operation, current)
      await this.deps.openExternal(authorization.href)
      this.assertCurrent(key, binding, operation, current)
      void this.finishConnection(key, binding, operation, metadata, clientId, scopes, redirectUri, verifier, current)
      return this.get(binding, owner)
    } catch (error) {
      operation.callback?.close(); operation.controller.abort()
      if (this.pending.get(key) === operation) this.pending.delete(key)
      throw error
    }
  }

  cancel(binding: McpOAuthBinding, owner: number): McpOAuthState {
    const { config } = this.deps.authorize(binding), key = mcpOAuthKey(binding, config), pending = this.pending.get(key)
    if (pending && pending.owner !== owner) throw new Error('请在发起授权的窗口取消连接。')
    this.cancelKey(key); this.preparations.delete(key); this.messages.delete(key)
    return this.get(binding, owner)
  }

  async disconnect(binding: McpOAuthBinding, revokeRemote: boolean, current: () => void): Promise<McpOAuthState> {
    const { config } = this.deps.authorize(binding), key = mcpOAuthKey(binding, config), grant = this.store.get(key)
    this.cancelKey(key); this.preparations.delete(key); this.blocked.add(key)
    const tokenRecord = grant?.refresh ?? grant?.access, tokenKind = grant?.refresh ? 'refresh' : 'access'
    const token = tokenRecord ? this.deps.credentials.resolve(ref(key, tokenKind), tokenRecord).token : undefined
    this.store.delete(key)
    this.deps.credentials.forget(ref(key, 'access')); this.deps.credentials.forget(ref(key, 'refresh'))
    let message = '已断开本机连接。服务端授权可在该服务的账号设置中管理。'
    if (revokeRemote && grant?.metadata.revocationEndpoint && token) {
      try {
        current(); this.deps.authorize(binding)
        await validateOAuthEndpoint(grant.metadata.revocationEndpoint, grant.metadata.resource)
        current()
        const body = new URLSearchParams({ token, token_type_hint: tokenKind === 'refresh' ? 'refresh_token' : 'access_token', client_id: grant.clientId })
        const { response } = await this.request(grant.metadata.revocationEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(15_000), maxRedirects: 0 })
        await response.body?.cancel().catch(() => undefined)
        message = response.ok ? '已断开本机连接；服务端已接受令牌撤销请求。' : '已断开本机连接；服务端撤销未确认，请在该服务的账号设置中撤销授权。'
      } catch { message = '已断开本机连接；服务端撤销结果未知，请在该服务的账号设置中核对。' }
    }
    this.messages.set(key, message)
    return { status: 'disconnected', resource: config.url, message }
  }

  async accessToken(binding: McpOAuthBinding, requested: McpServerConfig): Promise<string | undefined> {
    const { config } = this.deps.authorize(binding)
    if (config.url !== requested.url || config.command) throw new Error('MCP OAuth 资源绑定已变化。')
    const key = mcpOAuthKey(binding, config), grant = this.store.get(key)
    if (!grant) return undefined
    const inFlight = this.refreshes.get(key)
    if (inFlight && !this.blocked.has(key)) return inFlight
    if (grant.authorizationRequired || this.blocked.has(key)) throw new Error('MCP 服务授权已失效，请重新连接。')
    const token = this.deps.credentials.resolve(ref(key, 'access'), grant.access)
    if (!token.available) throw new Error('MCP 本次运行凭据不可用，请重新连接。')
    if (!grant.expiresAt || grant.expiresAt > Date.now() + 30_000) return token.token
    let refresh = this.refreshes.get(key)
    if (!refresh) {
      refresh = this.refresh(key, binding, grant, this.epoch(key))
      this.refreshes.set(key, refresh)
      void refresh.finally(() => { if (this.refreshes.get(key) === refresh) this.refreshes.delete(key) }).catch(() => undefined)
    }
    return refresh
  }

  reject(binding: McpOAuthBinding, config: McpServerConfig): void {
    const key = mcpOAuthKey(binding, config), grant = this.store.get(key)
    if (!grant) return
    this.blocked.add(key); this.epochs.set(key, this.epoch(key) + 1)
    this.store.set(key, { ...grant, authorizationRequired: true })
    this.messages.set(key, '服务拒绝了当前授权或权限不足，请重新连接；未自动重放工具调用。')
  }

  authorizationContext(binding: McpOAuthBinding, config: McpServerConfig): string | undefined {
    return this.store.get(mcpOAuthKey(binding, config))?.connectionId
  }

  stopOwner(owner: number): void {
    for (const [key, operation] of this.pending) if (operation.owner === owner) this.cancelKey(key)
    for (const [key, preparation] of this.preparations) if (preparation.owner === owner) this.preparations.delete(key)
  }
  dispose(): void { for (const key of this.pending.keys()) this.cancelKey(key); this.preparations.clear() }

  private async finishConnection(key: string, binding: McpOAuthBinding, operation: Pending, metadata: McpOAuthMetadata, clientId: string, scopes: string[], redirectUri: string, verifier: string, current: () => void): Promise<void> {
    try {
      const code = await operation.callback!.wait
      this.assertCurrent(key, binding, operation, current)
      const tokens = await this.tokens(metadata, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: metadata.resource }, operation.controller.signal)
      this.assertCurrent(key, binding, operation, current)
      this.saveTokens(key, { connectionId: randomUUID(), binding: { ...binding }, metadata, clientId, scopes, grantedAt: Date.now(), access: { encryptedToken: '' } }, tokens)
      this.blocked.delete(key); this.preparations.delete(key); this.messages.delete(key)
    } catch {
      if (this.pending.get(key) === operation) this.messages.set(key, '授权未完成、已超时或当前插件/任务授权已变化，请重新检查后连接。')
    } finally {
      operation.callback?.close(); operation.controller.abort()
      if (this.pending.get(key) === operation) this.pending.delete(key)
    }
  }

  private async refresh(key: string, binding: McpOAuthBinding, grant: McpOAuthGrant, epoch: number): Promise<string> {
    try {
      const refresh = grant.refresh && this.deps.credentials.resolve(ref(key, 'refresh'), grant.refresh)
      if (!refresh?.available) throw new Error('MCP 令牌已到期，请重新连接。')
      // Persist the uncertain boundary before sending a rotating refresh token. A crash or
      // timeout must never cause the previous refresh token to be replayed after restart.
      this.store.set(key, { ...grant, authorizationRequired: true })
      const tokens = await this.tokens(grant.metadata, { grant_type: 'refresh_token', refresh_token: refresh.token, client_id: grant.clientId, resource: grant.metadata.resource })
      this.deps.authorize(binding)
      if (epoch !== this.epoch(key) || this.blocked.has(key)) throw new Error('MCP 授权已撤销或变更。')
      this.saveTokens(key, grant, tokens)
      return tokens.access
    } catch {
      if (epoch === this.epoch(key)) { this.blocked.add(key); this.messages.set(key, '令牌刷新未完成，结果可能未知；请重新连接。旧刷新令牌不会自动重试。') }
      throw new Error('MCP 令牌刷新未完成，请重新连接；未重放工具调用。')
    }
  }

  private async tokens(metadata: McpOAuthMetadata, parameters: Record<string, string>, signal?: AbortSignal): Promise<TokenResult> {
    await validateOAuthEndpoint(metadata.tokenEndpoint, metadata.resource)
    const result = await oauthJson(this.request, metadata.tokenEndpoint, { method: 'POST', signal, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(parameters).toString() })
    const validToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 32_768 && !/[\0-\x20\x7f]/.test(value)
    if (!validToken(result.access_token) || typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer' || (result.refresh_token !== undefined && !validToken(result.refresh_token))) throw new Error('OAuth 服务未返回有效的 Bearer 令牌。')
    if (result.expires_in !== undefined && (typeof result.expires_in !== 'number' || !Number.isFinite(result.expires_in) || result.expires_in <= 0 || result.expires_in > 10 * 365 * 86400)) throw new Error('OAuth 令牌有效期无效。')
    return { access: result.access_token, ...(result.refresh_token ? { refresh: result.refresh_token as string } : {}), ...(typeof result.expires_in === 'number' ? { expiresAt: Date.now() + result.expires_in * 1000 } : {}), ...(typeof result.scope === 'string' ? { scopes: oauthScopes(result.scope) } : {}) }
  }
  private saveTokens(key: string, grant: McpOAuthGrant, tokens: TokenResult): void {
    const access = this.deps.credentials.store(ref(key, 'access'), tokens.access)
    const refresh = tokens.refresh ? this.deps.credentials.store(ref(key, 'refresh'), tokens.refresh) : grant.refresh
    this.store.set(key, { ...grant, access, refresh, expiresAt: tokens.expiresAt, scopes: tokens.scopes ?? grant.scopes, authorizationRequired: false })
  }
  private requirePreparation(key: string, options: McpOAuthConnectOptions, owner: number): Preparation {
    const preparation = this.preparations.get(key)
    if (!options || !preparation || preparation.owner !== owner || preparation.public.id !== options.preparationId || preparation.public.expiresAt <= Date.now()) throw new Error('OAuth 检查结果已过期或窗口已变化，请重新检查授权。')
    return preparation
  }
  private epoch(key: string): number { return this.epochs.get(key) ?? 0 }
  private cancelKey(key: string): void {
    this.epochs.set(key, this.epoch(key) + 1)
    const pending = this.pending.get(key)
    this.pending.delete(key); pending?.controller.abort(); pending?.callback?.close()
  }
  private assertCurrent(key: string, binding: McpOAuthBinding, operation: Pending, current: () => void): void {
    current(); this.deps.authorize(binding)
    if (operation.controller.signal.aborted || this.pending.get(key) !== operation || operation.epoch !== this.epoch(key)) throw new Error('OAuth 授权已取消或被替换。')
  }
}
export function mcpOAuthKey(binding: McpOAuthBinding, config: McpServerConfig): string {
  return createHash('sha256').update(JSON.stringify([binding.registryItemKey, binding.contentDigest, binding.capabilityDigest, binding.serverId, config.url ?? '', config.transport ?? 'http'])).digest('hex')
}
function ref(key: string, kind: 'access' | 'refresh'): { providerId: string; keyId: string } { return { providerId: `mcp-oauth:${key}`, keyId: kind } }
