import { authorizeMcpNetworkUrl, requestMcpNetworkUrl, type McpNetworkRequestInit, type McpNetworkResponse } from './mcp-network-policy'

export type OAuthRequest = (url: string, init: McpNetworkRequestInit) => Promise<McpNetworkResponse>
export interface McpOAuthMetadata {
  resource: string
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  revocationEndpoint?: string
  scopes: string[]
  issuerResponseRequired: boolean
}
export const defaultOAuthRequest: OAuthRequest = (url, init) => requestMcpNetworkUrl(url, init)
const MAX_JSON_BYTES = 128 * 1024

export function oauthUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || !raw || raw.length > 4096 || raw.trim() !== raw || /[\0-\x20\x7f]/.test(raw)) throw new Error('OAuth 地址无效。')
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('OAuth 地址无效。') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('OAuth 地址协议或身份信息无效。')
  return url
}

export async function validateOAuthEndpoint(raw: unknown, resource: string): Promise<string> {
  const url = oauthUrl(raw), source = await authorizeMcpNetworkUrl(resource), endpoint = await authorizeMcpNetworkUrl(url)
  if (source.mode === 'public' && endpoint.mode !== 'public') throw new Error('公开 MCP 不得使用本机授权端点。')
  return url.href
}

export async function oauthJson(request: OAuthRequest, url: string, init: McpNetworkRequestInit = {}): Promise<Record<string, unknown>> {
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
  const { response } = await request(url, { ...init, signal, maxRedirects: 0, headers: { accept: 'application/json', ...init.headers } })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`OAuth 服务返回 HTTP ${response.status}。`)
  }
  if (!response.body) throw new Error('OAuth 服务未返回 JSON。')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_JSON_BYTES) { await reader.cancel(); throw new Error('OAuth 响应超过大小限制。') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks, total).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch { throw new Error('OAuth 服务返回的 JSON 无效。') }
}

export function oauthScopes(value: unknown): string[] {
  const scopes = Array.isArray(value) ? value : typeof value === 'string' ? value.split(' ').filter(Boolean) : []
  if (scopes.length > 128 || scopes.some(scope => typeof scope !== 'string' || !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(scope))) throw new Error('OAuth 权限范围格式无效。')
  return [...new Set(scopes as string[])]
}

export function oauthChallenge(header: string | null): { metadata?: string; scopes?: string[] } {
  if (!header || header.length > 16_384) return {}
  // Recognize challenge boundaries outside quoted strings; only Bearer parameters apply.
  const segments = header.match(/(?:[^,"\\]|\\.|"(?:[^"\\]|\\.)*")+/g) ?? []
  let bearer = false
  const params = new Map<string, string>()
  for (let segment of segments) {
    segment = segment.trim()
    const challenge = /^([A-Za-z][A-Za-z0-9_-]*)\s+(.*)$/.exec(segment)
    if (challenge && !challenge[2].startsWith('=')) { bearer = challenge[1].toLowerCase() === 'bearer'; segment = challenge[2] }
    if (!bearer) continue
    const parameter = /^([a-z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))$/i.exec(segment)
    if (parameter) params.set(parameter[1].toLowerCase(), (parameter[2] ?? parameter[3]).replace(/\\(.)/g, '$1'))
  }
  return { ...(params.has('resource_metadata') ? { metadata: params.get('resource_metadata') } : {}), ...(params.has('scope') ? { scopes: oauthScopes(params.get('scope')) } : {}) }
}

export async function discoverMcpOAuth(resource: string, request = defaultOAuthRequest, signal?: AbortSignal): Promise<McpOAuthMetadata> {
  const target = oauthUrl(resource)
  if (target.search) throw new Error('OAuth MCP 地址不能包含查询凭据或参数，请使用标准资源 URL。')
  await authorizeMcpNetworkUrl(target)
  const probe = await request(resource, { method: 'GET', headers: { accept: 'application/json, text/event-stream' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), maxRedirects: 0 })
  const challenge = oauthChallenge(probe.response.headers.get('www-authenticate'))
  await probe.response.body?.cancel().catch(() => undefined)
  const resourceCandidates = challenge.metadata ? [challenge.metadata] : [...new Set([
    `${target.origin}/.well-known/oauth-protected-resource${target.pathname === '/' ? '' : target.pathname}`,
    `${target.origin}/.well-known/oauth-protected-resource`
  ])]
  let protectedMetadata: Record<string, unknown> | undefined
  for (const candidate of resourceCandidates) {
    const endpoint = await validateOAuthEndpoint(candidate, resource)
    try { protectedMetadata = await oauthJson(request, endpoint, { signal }); break } catch (error) {
      if (signal?.aborted || candidate === resourceCandidates.at(-1)) throw error
    }
  }
  if (!protectedMetadata || oauthUrl(protectedMetadata.resource).href !== target.href) throw new Error('OAuth 资源 metadata 与已批准的 MCP 地址不匹配。')
  const servers = protectedMetadata.authorization_servers
  if (!Array.isArray(servers) || !servers.length || servers.length > 32) throw new Error('MCP 未声明标准 OAuth 授权服务器。')
  const issuer = oauthUrl(servers[0])
  const expectedIssuer = servers[0] as string
  if (issuer.search) throw new Error('OAuth issuer 不得含查询参数。')
  await validateOAuthEndpoint(issuer.href, resource)
  const path = issuer.pathname === '/' ? '' : issuer.pathname
  const candidates = [...new Set([
    `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    `${issuer.origin}/.well-known/openid-configuration${path}`,
    `${issuer.origin}${path}/.well-known/openid-configuration`
  ])]
  let metadata: Record<string, unknown> | undefined
  for (const endpoint of candidates) {
    try { metadata = await oauthJson(request, endpoint, { signal }); break } catch (error) {
      if (signal?.aborted || endpoint === candidates.at(-1)) throw error
    }
  }
  if (!metadata || metadata.issuer !== expectedIssuer) throw new Error('OAuth issuer 与发现文档不匹配。')
  if (!Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes('S256')) throw new Error('授权服务器未声明 PKCE S256，已停止连接。')
  if (Array.isArray(metadata.response_types_supported) && !metadata.response_types_supported.includes('code')) throw new Error('授权服务器不支持授权码流程。')
  if (Array.isArray(metadata.token_endpoint_auth_methods_supported) && !metadata.token_endpoint_auth_methods_supported.includes('none')) throw new Error('此服务需要客户端密钥，本版仅支持 public client。')
  return {
    resource: target.href, issuer: expectedIssuer,
    authorizationEndpoint: await validateOAuthEndpoint(metadata.authorization_endpoint, resource),
    tokenEndpoint: await validateOAuthEndpoint(metadata.token_endpoint, resource),
    ...(metadata.registration_endpoint ? { registrationEndpoint: await validateOAuthEndpoint(metadata.registration_endpoint, resource) } : {}),
    ...(metadata.revocation_endpoint ? { revocationEndpoint: await validateOAuthEndpoint(metadata.revocation_endpoint, resource) } : {}),
    scopes: challenge.scopes ?? oauthScopes(protectedMetadata.scopes_supported),
    issuerResponseRequired: metadata.authorization_response_iss_parameter_supported === true
  }
}
