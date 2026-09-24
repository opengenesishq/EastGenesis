import assert from 'node:assert/strict'
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderCredentialBroker } from '../src/main/providerCredentialBroker'
import { McpOAuthService } from '../src/main/mcp/mcp-oauth-service'
import { discoverMcpOAuth, oauthChallenge, type OAuthRequest } from '../src/main/mcp/mcp-oauth-discovery'
import { createMcpOAuthCallback } from '../src/main/mcp/mcp-oauth-callback'
import { bindMcpOAuthRuntime, configureMcpOAuthRuntime, mcpRuntimeHeaders, assertMcpHttpAuthorized } from '../src/main/mcp/mcp-oauth-runtime'
import type { McpOAuthBinding } from '../src/shared/mcp-oauth-types'
import type { McpServerConfig } from '../src/main/mcp/mcp-client'

const resource = 'http://127.0.0.1:43199/mcp', issuer = 'http://127.0.0.1:43198/tenant'
const binding: McpOAuthBinding = { registryItemKey: '["mcp","fixture","fixture","remote"]', contentDigest: 'fixture-content', capabilityDigest: 'fixture-capability', serverId: 'remote' }
const config: McpServerConfig = { transport: 'http', url: resource }
const owner = 7
async function until(check: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 5000
  while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 15)) }
  throw new Error(`Timed out: ${label}`)
}
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'caogen-mcp-oauth-')), cryptoKey = randomBytes(32)
  let encrypted = false, authorized = true, current = true, url = '', codeVerifier = '', tokenCount = 0, refreshCount = 0, registered = 0, refreshFails = false, resourceMismatch = false, issuerMismatch = false, s256 = true, lifetime = 3600
  let refreshPause: Promise<void> | undefined, refreshRelease = (): void => undefined
  const requests: Array<{ url: string; method: string; headers: unknown; body?: string }> = []
  const broker = new ProviderCredentialBroker({
    isEncryptionAvailable: () => encrypted, getSelectedStorageBackend: () => 'fixture_aes',
    encryptString: value => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', cryptoKey, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]) },
    decryptString: value => { const cipher = createDecipheriv('aes-256-gcm', cryptoKey, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(-16)); return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString('utf8') }
  })
  const request: OAuthRequest = async (address, init) => {
    if (init.signal?.aborted) throw new Error('fixture canceled')
    requests.push({ url: address, method: init.method ?? 'GET', headers: init.headers, body: typeof init.body === 'string' ? init.body : undefined })
    const response = (value: unknown, status = 200, headers?: Record<string, string>) => ({ response: new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } }), finalUrl: new URL(address) })
    if (address === resource) return response({}, 401, { 'WWW-Authenticate': `Basic realm="fixture", Bearer resource_metadata="http://127.0.0.1:43199/meta", scope="read write"` })
    if (address === 'http://127.0.0.1:43199/meta') return response({ resource: resourceMismatch ? resource + '/other' : resource, authorization_servers: [issuer], scopes_supported: ['read', 'write', 'admin'] })
    if (address.endsWith('/.well-known/oauth-authorization-server/tenant')) return response({ issuer: issuerMismatch ? issuer + '/other' : issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', registration_endpoint: issuer + '/register', revocation_endpoint: issuer + '/revoke', code_challenge_methods_supported: s256 ? ['S256'] : ['plain'], token_endpoint_auth_methods_supported: ['none'], response_types_supported: ['code'], authorization_response_iss_parameter_supported: true })
    if (address === issuer + '/register') { registered++; const parsed = JSON.parse(String(init.body)); assert.equal(parsed.token_endpoint_auth_method, 'none'); return response({ client_id: 'fixture-client', redirect_uris: parsed.redirect_uris, token_endpoint_auth_method: 'none' }) }
    if (address === issuer + '/token') {
      const body = new URLSearchParams(String(init.body)); assert.equal(body.get('resource'), resource); assert.equal(body.get('client_id'), 'fixture-client')
      if (body.get('grant_type') === 'authorization_code') { tokenCount++; codeVerifier = body.get('code_verifier')!; assert.equal(body.get('code'), 'fixture-code'); return response({ token_type: 'Bearer', access_token: `fixture-access-${tokenCount}`, refresh_token: `fixture-refresh-${tokenCount}`, expires_in: lifetime, scope: 'read write' }) }
      refreshCount++; if (refreshPause) await refreshPause
      if (refreshFails) throw new Error('fixture lost refresh response')
      return response({ token_type: 'Bearer', access_token: `fixture-rotated-${refreshCount}`, refresh_token: `fixture-rotated-refresh-${refreshCount}`, expires_in: 3600 })
    }
    if (address === issuer + '/revoke') return response({})
    return response({}, 404)
  }
  const host = { root, authorize: () => { if (!authorized) throw new Error('fixture plugin revoked'); return { binding, config } }, credentials: { store: broker.store.bind(broker), resolve: broker.resolve.bind(broker), forget: broker.forget.bind(broker) }, openExternal: async (value: string) => { url = value }, request }
  const service = new McpOAuthService(host)
  const currentGuard = () => { if (!current) throw new Error('fixture owner revoked') }
  async function connect(): Promise<URL> {
    const prepared = await service.prepare(binding, owner, currentGuard)
    assert.equal(prepared.status, 'ready'); assert.deepEqual(prepared.preparation!.scopes, ['read', 'write'])
    const connected = await service.connect(binding, { preparationId: prepared.preparation!.id }, owner, currentGuard)
    assert.equal(connected.status, 'authorizing')
    const authorization = new URL(url)
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256'); assert.equal(authorization.searchParams.get('resource'), resource)
    return authorization
  }
  async function callback(authorization: URL, params: Record<string, string> = {}): Promise<Response> {
    const target = new URL(authorization.searchParams.get('redirect_uri')!)
    for (const [name, value] of Object.entries({ code: 'fixture-code', state: authorization.searchParams.get('state')!, iss: issuer, ...params })) target.searchParams.set(name, value)
    return fetch(target)
  }
  async function finish(authorization: URL): Promise<void> { assert.equal((await callback(authorization)).status, 200); await until(() => service.get(binding, owner).status === 'connected', 'connected') }
  let groups = 0
  try {
    assert.deepEqual(oauthChallenge('Basic realm="a,b", Bearer resource_metadata="https://example.test/meta", scope="a b"'), { metadata: 'https://example.test/meta', scopes: ['a', 'b'] })
    resourceMismatch = true; await assert.rejects(discoverMcpOAuth(resource, request), /资源 metadata/); resourceMismatch = false
    issuerMismatch = true; await assert.rejects(discoverMcpOAuth(resource, request), /issuer/); issuerMismatch = false
    s256 = false; await assert.rejects(discoverMcpOAuth(resource, request), /S256/); s256 = true; groups++

    const first = await connect(); assert.equal((await callback(first, { state: 'wrong' })).status, 400); assert.equal(tokenCount, 0)
    await finish(first)
    assert.equal(createHash('sha256').update(codeVerifier).digest('base64url'), first.searchParams.get('code_challenge'))
    assert.equal(service.get(binding, owner).storage, 'session'); assert.equal(await service.accessToken(binding, config), 'fixture-access-1')
    const stateFile = await readFile(join(root, 'mcp-oauth.json'), 'utf8'); assert(!stateFile.includes('fixture-access')); assert(!stateFile.includes('fixture-refresh')); assert(!stateFile.includes(codeVerifier)); assert(!JSON.stringify(service.get(binding, owner)).includes('fixture-access'))
    assert.equal(registered, 1); groups++

    configureMcpOAuthRuntime((identity, configuration) => service.accessToken(identity, configuration), (identity, configuration) => service.reject(identity, configuration), (identity, configuration) => service.authorizationContext(identity, configuration))
    const runtime = { ...config }; bindMcpOAuthRuntime(runtime, binding)
    assert.equal((await mcpRuntimeHeaders(runtime)).Authorization, 'Bearer fixture-access-1')
    assert.deepEqual(await mcpRuntimeHeaders({ ...config }), {})
    const collision = { ...config, headers: { authorization: 'Bearer static' } }; bindMcpOAuthRuntime(collision, binding); await assert.rejects(mcpRuntimeHeaders(collision), /静态/)
    assert(!JSON.stringify(runtime).includes('fixture-access')); groups++

    await service.disconnect(binding, false, currentGuard); encrypted = true
    const second = await connect(); await finish(second)
    assert.equal(service.get(binding, owner).storage, 'encrypted')
    const persisted = await readFile(join(root, 'mcp-oauth.json'), 'utf8'); assert(persisted.includes('enc:')); assert(!persisted.includes('fixture-access'))
    assert.equal(await new McpOAuthService(host).accessToken(binding, config), 'fixture-access-2')
    await assert.rejects(mcpRuntimeHeaders(runtime), /账号已变化/); groups++

    await service.disconnect(binding, false, currentGuard); lifetime = 1
    const expiring = await connect(); await finish(expiring)
    refreshPause = new Promise(resolve => { refreshRelease = resolve })
    const a = service.accessToken(binding, config), b = service.accessToken(binding, config), c = service.accessToken(binding, config)
    await until(() => refreshCount === 1, 'single flight'); assert.equal(refreshCount, 1)
    assert.equal(new McpOAuthService(host).get(binding, owner).status, 'authorization_required')
    refreshRelease(); assert.deepEqual(await Promise.all([a, b, c]), ['fixture-rotated-1', 'fixture-rotated-1', 'fixture-rotated-1']); refreshPause = undefined
    assert.equal(service.get(binding, owner).status, 'connected'); groups++

    await service.disconnect(binding, false, currentGuard); const failed = await connect(); await finish(failed); refreshFails = true
    await assert.rejects(service.accessToken(binding, config), /刷新/); const afterFailure = refreshCount
    await assert.rejects(service.accessToken(binding, config), /失效/); assert.equal(refreshCount, afterFailure); assert.equal(new McpOAuthService(host).get(binding, owner).status, 'authorization_required')
    refreshFails = false; groups++

    await service.disconnect(binding, false, currentGuard); lifetime = 3600
    const cancellation = await connect(); const count = tokenCount; service.stopOwner(owner)
    await assert.rejects(callback(cancellation)); assert.equal(tokenCount, count); assert.equal(service.get(binding, owner).status, 'disconnected'); groups++

    const denied = await connect(); authorized = false; await callback(denied); await until(() => { try { authorized = true; return service.get(binding, owner).status !== 'authorizing' } finally { authorized = false } }, 'revoked callback')
    authorized = true; assert.equal(tokenCount, count); groups++

    const afterRevocation = await connect(); await finish(afterRevocation)
    const bound = { ...config }; bindMcpOAuthRuntime(bound, binding)
    const before401 = requests.length
    await assert.rejects(assertMcpHttpAuthorized(bound, new Response('{}', { status: 401 })), /未自动重放/)
    assert.equal(requests.length, before401); await assert.rejects(mcpRuntimeHeaders(bound), /失效/); groups++

    const recovered = await connect(); await finish(recovered)
    const disconnected = await service.disconnect(binding, true, currentGuard)
    assert.equal(disconnected.status, 'disconnected'); assert.match(disconnected.message!, /已接受/)
    assert(requests.some(item => item.url === issuer + '/revoke')); assert.equal(await service.accessToken(binding, config), undefined)
    assert(!requests.some(item => JSON.stringify(item.headers).includes('fixture-access'))); groups++

    const controlled = new AbortController(), standalone = await createMcpOAuthCallback('fixture-state', issuer, true, 0, controlled.signal)
    const rejected = assert.rejects(standalone.wait, /取消/); controlled.abort(); await rejected
    await assert.rejects(createMcpOAuthCallback('fixture', issuer, true, 80)); groups++

    console.log(`PASS ${groups} MCP OAuth fixture groups; only local callback sockets and in-memory OAuth responses, no external accounts`)
  } finally { authorized = true; current = true; refreshRelease(); service.dispose(); configureMcpOAuthRuntime(undefined, undefined); await rm(root, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
