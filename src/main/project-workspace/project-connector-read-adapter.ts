import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import type {
  ConnectorReadResult,
  ProjectResource,
  ProjectWorkspace
} from '../../shared/project-workspace-types'
import { connectorSupportsRead, createProjectConnectorReadResult, projectConnectorResource } from './connector-resource'
import { assertProjectConnectorReadEgressAllowed } from './resource-context'
import { getProvider, issueProviderCredentialLease } from '../providers'
import { issueProviderAuthorizationAccountLease } from '../provider/providerAuthorizationService'
import { providerCredentialHeaders } from '../provider/providerCredentialHeaders'
import { providerCredentialScopeForSession } from '../providerRuntimeAuth'
import { redeemProviderCredentialLease } from '../providerCredentialRuntime'

const MAX_CONNECTOR_BYTES = 1024 * 1024
const CONNECTOR_TIMEOUT_MS = 15_000

export interface ProjectConnectorReadAdapterOptions {
  fetchImpl?: typeof fetch
  /** Deterministic DNS resolver for loopback/synthetic connector tests. */
  lookupImpl?: typeof lookup
  signal?: AbortSignal
  /** Used by deterministic refresh/search calls that are not attached to a Session. */
  operationId?: string
}

/**
 * Execute a real, bounded read. A connector credentialRef is an opaque
 * reference to an existing Provider key (`provider:<providerId>/<keyId>`); the
 * token is leased in the main process and never enters Project state.
 */
export async function readProjectConnector(
  workspace: ProjectWorkspace,
  resourceId: string,
  options: ProjectConnectorReadAdapterOptions = {}
): Promise<ConnectorReadResult<string>> {
  const resource = projectConnectorResource(workspace, resourceId)
  // Connector reads are an external effect themselves. Enforce the resource
  // egress boundary here as well as in lifecycle orchestration so direct
  // refresh, search, recovery, and adapter callers cannot bypass deny/S3.
  assertProjectConnectorReadEgressAllowed(resource)
  if (!connectorSupportsRead(resource)) {
    throw new Error('Connector is not authorized for read operations')
  }
  const credential = resource.connector?.authorization.credentialRef
    ? await connectorCredential(workspace, resource, options)
    : undefined
  const connectorId = resource.connector?.connectorId ?? 'generic'
  if (connectorId === 'github') return readGitHub(workspace, resource, options, credential)
  if (connectorId === 'notion') return readNotion(workspace, resource, options, credential)
  if (connectorId === 'slack') return readSlack(workspace, resource, options, credential)
  if (connectorId === 'linear') return readLinear(workspace, resource, options, credential)
  if (connectorId === 'jira') return readJira(workspace, resource, options, credential)
  if (connectorId === 'figma') return readFigma(workspace, resource, options, credential)
  if (connectorId === 'feishu') return readFeishu(workspace, resource, options, credential)
  if (connectorId === 'generic') return readPublicHttps(workspace, resource, options, credential)
  throw new Error(`Connector adapter is not available:${connectorId}`)
}

type ConnectorCredential = {
  provider: Parameters<typeof providerCredentialHeaders>[0]
  lease: NonNullable<ReturnType<typeof issueProviderCredentialLease>['lease']>
  scope: ReturnType<typeof providerCredentialScopeForSession>
}

async function connectorCredential(
  workspace: ProjectWorkspace,
  resource: ProjectResource,
  options: ProjectConnectorReadAdapterOptions
): Promise<ConnectorCredential> {
  const reference = resource.connector?.authorization.credentialRef?.trim() ?? ''
  const oauthMatch = /^oauth:([^/\s]+)\/([^/\s]+)$/.exec(reference)
  const match = /^provider:([^/\s]+)\/([^/\s]+)$/.exec(reference)
  if (!oauthMatch && !match) throw new Error('Connector credentialRef must use oauth:<providerId>/<accountId> or provider:<providerId>/<keyId>')
  const [, providerId, referenceId] = (oauthMatch ?? match)!
  const provider = getProvider(providerId)
  if (!provider) throw new Error('Connector credential Provider was not found')
  const scope = providerCredentialScopeForSession({
    id: `connector:${resource.id}`,
    workspaceId: workspace.id,
    projectId: workspace.id
  }, provider.id, options.operationId?.trim() || `connector-refresh:${workspace.id}:${resource.id}`)
  if (oauthMatch) {
    const principalId = resource.connector?.authorization.principalId.trim()
    if (!principalId || principalId !== referenceId) {
      throw new Error('Connector OAuth principalId must match the selected authorization account')
    }
    const selection = await issueProviderAuthorizationAccountLease(provider, referenceId, scope)
    return { provider: selection.credentialProvider, lease: selection.lease, scope }
  }
  const selection = issueProviderCredentialLease(provider, scope, { ttlMs: 60_000 }, referenceId)
  if (!selection.lease) throw new Error('Connector credential is unavailable or disabled')
  return { provider, lease: selection.lease, scope }
}

async function readGitHub(
  workspace: ProjectWorkspace,
  resource: ProjectResource,
  options: ProjectConnectorReadAdapterOptions,
  credential?: ConnectorCredential
): Promise<ConnectorReadResult<string>> {
  const repository = githubRepository(resource.uri)
  const endpoint = new URL(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/readme`)
  const response = await boundedFetch(endpoint, {
    Accept: 'application/vnd.github.raw+json',
    'User-Agent': 'CaoGen-Project-Connector'
  }, options, credential)
  const source = `github://${repository.owner}/${repository.repo}/README`
  return createProjectConnectorReadResult(workspace, resource.id, {
    data: response.data,
    source,
    version: response.version
  })
}

async function readPublicHttps(
  workspace: ProjectWorkspace,
  resource: ProjectResource,
  options: ProjectConnectorReadAdapterOptions,
  credential?: ConnectorCredential
): Promise<ConnectorReadResult<string>> {
  if (!resource.uri) throw new Error('Generic connector requires an HTTPS URI')
  const endpoint = publicHttpsUrl(resource.uri)
  const response = await boundedFetch(endpoint, {
    Accept: 'text/plain, text/markdown, application/json'
  }, options, credential)
  return createProjectConnectorReadResult(workspace, resource.id, {
    data: response.data,
    source: sanitizedUrl(endpoint),
    version: response.version
  })
}

async function readNotion(
  workspace: ProjectWorkspace,
  resource: ProjectResource,
  options: ProjectConnectorReadAdapterOptions,
  credential?: ConnectorCredential
): Promise<ConnectorReadResult<string>> {
  const id = connectorPathId(resource.uri, 'notion', 'page')
  const headers = {
    'Notion-Version': '2022-06-28',
    Accept: 'application/json'
  }
  const page = await boundedFetch(
    new URL(`https://api.notion.com/v1/pages/${encodeURIComponent(id)}`),
    headers,
    options,
    credential
  )
  const blocks = await boundedFetch(
    new URL(`https://api.notion.com/v1/blocks/${encodeURIComponent(id)}/children?page_size=100`),
    headers,
    options,
    credential
  )
  const data = JSON.stringify({ page: parseJsonObject(page.data, 'Notion page'), blocks: parseJsonObject(blocks.data, 'Notion blocks') })
  if (Buffer.byteLength(data, 'utf8') > MAX_CONNECTOR_BYTES) throw new Error('Connector response exceeds the 1 MiB limit')
  return createProjectConnectorReadResult(workspace, resource.id, {
    data,
    source: `notion://page/${id}`,
    version: page.version === blocks.version ? page.version : `page:${page.version};blocks:${blocks.version}`
  })
}

async function readSlack(
  workspace: ProjectWorkspace,
  resource: ProjectResource,
  options: ProjectConnectorReadAdapterOptions,
  credential?: ConnectorCredential
): Promise<ConnectorReadResult<string>> {
  const channel = connectorPathId(resource.uri, 'slack', 'channel')
  const endpoint = new URL('https://slack.com/api/conversations.history')
  endpoint.searchParams.set('channel', channel)
  endpoint.searchParams.set('limit', '100')
  const response = await boundedFetch(endpoint, { Accept: 'application/json' }, options, credential)
  const payload = parseJsonObject(response.data, 'Slack response')
  if (payload.ok !== true) throw new Error('Slack connector returned an unsuccessful response')
  return createProjectConnectorReadResult(workspace, resource.id, {
    data: response.data,
    source: `slack://channel/${channel}`,
    version: response.version
  })
}

async function readLinear(
  workspace: ProjectWorkspace,
  resource: ProjectResource,
  options: ProjectConnectorReadAdapterOptions,
  credential?: ConnectorCredential
): Promise<ConnectorReadResult<string>> {
  const issueId = connectorPathId(resource.uri, 'linear', 'issue')
  const body = JSON.stringify({
    query: 'query($id:String!){issue(id:$id){id identifier title description state{name} url updatedAt}}',
    variables: { id: issueId }
  })
  const response = await boundedRequest(new URL('https://api.linear.app/graphql'), {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }, options, credential, { method: 'POST', body })
  const payload = parseJsonObject(response.data, 'Linear response')
  if (Array.isArray(payload.errors) && payload.errors.length > 0) throw new Error('Linear connector returned GraphQL errors')
  return createProjectConnectorReadResult(workspace, resource.id, {
    data: response.data,
    source: `linear://issue/${issueId}`,
    version: response.version
  })
}

async function readJira(
  workspace: ProjectWorkspace,
  resource: ProjectResource,
  options: ProjectConnectorReadAdapterOptions,
  credential?: ConnectorCredential
): Promise<ConnectorReadResult<string>> {
  const target = jiraTarget(resource.uri)
  const endpoint = new URL(`${target.origin}/rest/api/3/issue/${encodeURIComponent(target.issueKey)}`)
  endpoint.searchParams.set('fields', 'summary,description,status,updated,project,issuetype')
  const response = await boundedFetch(endpoint, { Accept: 'application/json' }, options, credential)
  return createProjectConnectorReadResult(workspace, resource.id, {
    data: response.data,
    source: `jira://${target.host}/issue/${target.issueKey}`,
    version: response.version
  })
}

async function readFigma(
  workspace: ProjectWorkspace,
  resource: ProjectResource,
  options: ProjectConnectorReadAdapterOptions,
  credential?: ConnectorCredential
): Promise<ConnectorReadResult<string>> {
  const fileKey = connectorPathId(resource.uri, 'figma', 'file')
  const endpoint = new URL(`https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}`)
  endpoint.searchParams.set('depth', '2')
  const response = await boundedFetch(endpoint, { Accept: 'application/json' }, options, credential)
  return createProjectConnectorReadResult(workspace, resource.id, {
    data: response.data,
    source: `figma://file/${fileKey}`,
    version: response.version
  })
}

async function readFeishu(
  workspace: ProjectWorkspace,
  resource: ProjectResource,
  options: ProjectConnectorReadAdapterOptions,
  credential?: ConnectorCredential
): Promise<ConnectorReadResult<string>> {
  const documentId = connectorPathId(resource.uri, 'feishu', 'doc')
  const endpoint = new URL(`https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`)
  const response = await boundedFetch(endpoint, { Accept: 'application/json' }, options, credential)
  return createProjectConnectorReadResult(workspace, resource.id, {
    data: response.data,
    source: `feishu://doc/${documentId}`,
    version: response.version
  })
}

interface BoundedConnectorResponse {
  data: string
  version: string
}

async function boundedFetch(
  endpoint: URL,
  headers: Record<string, string>,
  options: ProjectConnectorReadAdapterOptions,
  credential?: ConnectorCredential
): Promise<BoundedConnectorResponse> {
  return boundedRequest(endpoint, headers, options, credential, { method: 'GET' })
}

async function boundedRequest(
  endpoint: URL,
  headers: Record<string, string>,
  options: ProjectConnectorReadAdapterOptions,
  credential: ConnectorCredential | undefined,
  request: Pick<RequestInit, 'method' | 'body'>
): Promise<BoundedConnectorResponse> {
  await assertPublicEndpoint(endpoint, options.lookupImpl)
  if (options.signal?.aborted) throw new Error('Connector read was cancelled')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CONNECTOR_TIMEOUT_MS)
  const abort = (): void => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const requestHeaders = credential
      ? { ...headers, ...providerCredentialHeaders(credential.provider, redeemProviderCredentialLease(credential.lease, credential.scope).token) }
      : headers
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      ...request,
      headers: requestHeaders,
      redirect: 'manual',
      signal: controller.signal
    })
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Connector redirects are not accepted')
    }
    if (!response.ok) throw new Error(`Connector read failed with HTTP ${response.status}`)
    const contentLength = response.headers.get('content-length')
    if (contentLength && Number(contentLength) > MAX_CONNECTOR_BYTES) {
      throw new Error('Connector response exceeds the 1 MiB limit')
    }
    return {
      data: await readTextResponse(response),
      version: responseVersion(response)
    }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

function connectorPathId(value: string | undefined, protocol: string, segment: string): string {
  if (!value) throw new Error(`${protocol} connector requires a ${segment} URI`)
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${protocol} connector URI is invalid`) }
  if (url.protocol !== `${protocol}:`) throw new Error(`${protocol} connector URI is invalid`)
  const parts = url.pathname.split('/').filter(Boolean)
  if (url.hostname !== segment || parts.length !== 1 || !/^[A-Za-z0-9._~-]{3,256}$/.test(parts[0])) {
    throw new Error(`${protocol} connector URI must be ${protocol}://${segment}/<id>`)
  }
  return parts[0]
}

function jiraTarget(value: string | undefined): { origin: string; host: string; issueKey: string } {
  if (!value) throw new Error('Jira connector requires an issue URI')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Jira connector URI is invalid') }
  if (url.protocol === 'jira:') {
    const issueKey = url.pathname.split('/').filter(Boolean)
    if (url.hostname !== 'issue' || issueKey.length !== 1) throw new Error('Jira URI must be jira://issue/<key> with site in metadata')
    throw new Error('Jira URI must use https://<site>.atlassian.net/browse/<key>')
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.atlassian.net')) throw new Error('Jira connector requires an Atlassian HTTPS URI')
  const parts = url.pathname.split('/').filter(Boolean)
  const issueKey = parts[0] === 'browse' ? parts[1] : undefined
  if (!issueKey || !/^[A-Za-z][A-Za-z0-9_-]{1,80}$/.test(issueKey)) throw new Error('Jira URI must target /browse/<issue-key>')
  return { origin: url.origin, host: url.hostname, issueKey }
}

async function readTextResponse(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType && !contentType.includes('text/') && !contentType.includes('json')) {
    throw new Error('Connector response is not text or JSON')
  }
  if (!response.body) throw new Error('Connector response body is missing')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_CONNECTOR_BYTES) throw new Error('Connector response exceeds the 1 MiB limit')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
  if (!text.trim()) throw new Error('Connector response is empty')
  return text
}

function githubRepository(value: string | undefined): { owner: string; repo: string } {
  if (!value) throw new Error('GitHub connector requires a repository URI')
  let owner = ''
  let repo = ''
  try {
    const url = new URL(value)
    if (url.protocol === 'github:') {
      owner = url.hostname
      repo = url.pathname.split('/').filter(Boolean)[0] ?? ''
    } else if (url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com') {
      const parts = url.pathname.split('/').filter(Boolean)
      owner = parts[0] ?? ''
      repo = parts[1] ?? ''
    }
  } catch {
    throw new Error('GitHub connector repository URI is invalid')
  }
  repo = repo.replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('GitHub connector repository URI is invalid')
  }
  return { owner, repo }
}

function publicHttpsUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Generic connector URI is invalid')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('Generic connector requires credential-free HTTPS on port 443')
  }
  for (const [name, queryValue] of url.searchParams.entries()) {
    if (/(?:api[_-]?key|auth(?:orization)?|bearer|credential|password|secret|token|signature)/i.test(name) ||
        /(?:secret|token|password|api[_-]?key)=/i.test(`${name}=${queryValue}`)) {
      throw new Error('Generic connector URI cannot carry credentials in the query')
    }
  }
  url.hash = ''
  return url
}

async function assertPublicEndpoint(url: URL, lookupImpl: typeof lookup = lookup): Promise<void> {
  const host = url.hostname.toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost') || isPrivateAddress(host)) {
    throw new Error('Connector endpoint must use a public host')
  }
  const addresses = await lookupImpl(host, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Connector endpoint resolved to a private address')
  }
}

function isPrivateAddress(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (!isIP(normalized)) return false
  if (normalized.includes(':')) {
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:10.') || normalized.startsWith('::ffff:192.168.')
  }
  const octets = normalized.split('.').map(Number)
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
}

function responseVersion(response: Response): string {
  const etag = response.headers.get('etag')?.trim()
  return etag && etag.length <= 256 ? `etag:${etag}` : 'content-digest'
}

function sanitizedUrl(url: URL): string {
  const copy = new URL(url)
  copy.username = ''
  copy.password = ''
  copy.search = ''
  copy.hash = ''
  return copy.toString()
}
