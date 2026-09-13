import { createHash } from 'node:crypto'
import type {
  ConnectorAutoRefreshInterval,
  ConnectorLatestCitation,
  ConnectorResourceLifecycle,
  ProjectConnectorMutation,
  ProjectResource,
  ProjectWorkspace,
  MutationOptions
} from '../../shared/project-workspace-types'
import { connectorAuthorizationDigest, connectorResourceAvailability, projectConnectorResource } from './connector-resource'
import { assertProjectConnectorReadEgressAllowed } from './resource-context'
import { openProjectWorkspaceStore } from './store'
import { readProjectConnector } from './project-connector-read-adapter'
import { createWorkflowEvidence } from '../task/workflow-ledger-api'
import { getProvider } from '../providers'
import { listProviderAuthorizationAccounts } from '../provider/providerAuthorizationAccountService'
import {
  purgeProjectConnectorCache,
  writeProjectConnectorCache
} from './project-connector-cache'

export interface ProjectConnectorRefreshCompletion {
  status: 'succeeded' | 'failed'
  citation?: ConnectorLatestCitation
  errorDigest?: string
}

export interface ProjectConnectorRevocationRuntimeResult {
  pausedSessionIds: string[]
  pausedRunIds: string[]
}

export interface ProjectConnectorLifecycleRuntime {
  blockRevokedSource(projectId: string, resourceId: string): Promise<ProjectConnectorRevocationRuntimeResult>
}

export async function mutateProjectConnector(
  rootDir: string,
  projectId: string,
  resourceId: string,
  mutation: ProjectConnectorMutation,
  options: MutationOptions = {},
  runtime?: ProjectConnectorLifecycleRuntime
): Promise<ProjectWorkspace> {
  const store = await openProjectWorkspaceStore(rootDir)
  const workspace = await store.getWorkspace(projectId)
  if (!workspace) throw new Error(`Project not found:${projectId}`)
  const resource = projectConnectorResource(workspace, resourceId)
  const now = Date.now()
  const updated = applyConnectorMutation(resource, mutation, now)
  const persisted = await store.updateWorkspace(projectId, {
    resources: workspace.resources.map((candidate) => candidate.id === resourceId ? updated : candidate)
  }, options)
  if (mutation.kind === 'request_refresh') {
    return executeRequestedProjectConnectorRefresh(rootDir, persisted, resourceId)
  }
  if (mutation.kind === 'purge_cache') {
    return executeProjectConnectorCachePurge(rootDir, persisted, resourceId)
  }
  if (mutation.kind === 'bind_authorization') {
    assertAuthorizationBinding(mutation.principalId, mutation.credentialRef)
    return executeProjectConnectorCachePurge(rootDir, persisted, resourceId)
  }
  if (mutation.kind === 'set_authorization' && mutation.status === 'revoked') {
    return executeProjectConnectorRevocation(rootDir, persisted, resourceId, runtime)
  }
  return persisted
}

async function executeRequestedProjectConnectorRefresh(
  rootDir: string,
  requested: ProjectWorkspace,
  resourceId: string
): Promise<ProjectWorkspace> {
  const running = await markProjectConnectorRefreshRunning(rootDir, requested, resourceId)
  let cacheWritten = false
  try {
    const runningResource = projectConnectorResource(running, resourceId)
    assertProjectConnectorReadEgressAllowed(runningResource)
    const operationId = `connector-refresh:${running.id}:${resourceId}:${running.revision}:${runningResource.connector?.lifecycle?.refresh.requestedAt ?? 'unknown'}`
    const read = await readProjectConnector(running, resourceId, { operationId })
    const cached = await writeProjectConnectorCache(rootDir, running.id, resourceId, read, {
      authorizationDigest: connectorAuthorizationDigest(runningResource)
    })
    cacheWritten = true
    const citation = cached.citation
    if (!citation.contentDigest) throw new Error('Connector read did not produce a content digest')
    const evidenceId = `connector-refresh:${running.id}:${resourceId}:${citation.contentDigest.slice(7)}:${citation.retrievedAt}`
    await createWorkflowEvidence({
      evidenceId,
      projectId: running.id,
      kind: 'research_source',
      title: 'Project connector refresh source',
      summary: 'An authorized Project connector returned a bounded source version.',
      contentDigest: citation.contentDigest,
      mediaType: 'text/plain',
      metadata: {
        resourceId,
        connectorId: projectConnectorResource(running, resourceId).connector?.connectorId ?? 'generic',
        sourceVersion: citation.version
      }
    }, rootDir, {
      source: 'runtime',
      verifier: 'project-connector-refresh',
      observedAt: citation.retrievedAt
    })
    return completeProjectConnectorRefresh(rootDir, running.id, resourceId, {
      status: 'succeeded',
      citation,
      cache: {
        authorizationDigest: cached.authorizationDigest,
        contentDigest: citation.contentDigest!,
        bytes: cached.bytes,
        cachedAt: cached.cachedAt
      }
    }, { expectedRevision: running.revision })
  } catch (error) {
    if (cacheWritten) {
      await purgeProjectConnectorCache(rootDir, running.id, resourceId).catch(() => undefined)
    }
    try {
      let failed = await completeProjectConnectorRefresh(rootDir, running.id, resourceId, {
        status: 'failed',
        errorDigest: connectorErrorDigest(error)
      }, { expectedRevision: running.revision })
      if (cacheWritten) {
        failed = await updateConnectorLifecycle(rootDir, running.id, resourceId, (current) => ({
          ...current,
          cache: { status: 'purged', purgedAt: Date.now() }
        }))
      }
      return failed
    } catch {
      const current = await (await openProjectWorkspaceStore(rootDir)).getWorkspace(running.id)
      if (current) return current
      throw error
    }
  }
}

async function markProjectConnectorRefreshRunning(
  rootDir: string,
  requested: ProjectWorkspace,
  resourceId: string
): Promise<ProjectWorkspace> {
  const store = await openProjectWorkspaceStore(rootDir)
  const resource = projectConnectorResource(requested, resourceId)
  const current = connectorLifecycle(resource)
  if (current.refresh.status !== 'requested') throw new Error('Connector refresh was not requested')
  const now = Date.now()
  return store.updateWorkspace(requested.id, {
    resources: requested.resources.map((candidate) => candidate.id === resourceId
      ? withLifecycle(candidate, {
          ...current,
          enabled: current.enabled,
          refresh: {
            ...current.refresh,
            status: 'running',
            requestedAt: current.refresh.requestedAt,
            startedAt: now,
            completedAt: undefined,
            errorDigest: undefined
          }
        })
      : candidate)
  }, { expectedRevision: requested.revision })
}

/** Called by a real adapter after it has completed a requested refresh. */
export async function completeProjectConnectorRefresh(
  rootDir: string,
  projectId: string,
  resourceId: string,
  completion: ProjectConnectorRefreshCompletion & {
    cache?: { authorizationDigest: string; contentDigest: string; bytes: number; cachedAt: number }
  },
  options: MutationOptions = {}
): Promise<ProjectWorkspace> {
  const store = await openProjectWorkspaceStore(rootDir)
  const workspace = await store.getWorkspace(projectId)
  if (!workspace) throw new Error(`Project not found:${projectId}`)
  const resource = projectConnectorResource(workspace, resourceId)
  const current = connectorLifecycle(resource)
  const now = Date.now()
  if (completion.status === 'succeeded') {
    if (!completion.citation) throw new Error('Successful connector refresh requires a citation')
    assertCitationOwnership(completion.citation, projectId, resourceId)
    return store.updateWorkspace(projectId, {
      resources: workspace.resources.map((candidate) => candidate.id === resourceId
        ? withLifecycle(candidate, {
            ...current,
            enabled: current.enabled,
            refresh: {
              ...current.refresh,
              status: 'succeeded', completedAt: now, errorDigest: undefined,
              latestCitation: completion.citation
            },
            ...(current.autoRefresh && current.autoRefresh.intervalMs > 0
              ? { autoRefresh: { ...current.autoRefresh, nextAt: now + current.autoRefresh.intervalMs } }
              : {}),
            ...(completion.cache
              ? {
                  cache: {
                    status: 'ready',
                    authorizationDigest: completion.cache.authorizationDigest,
                    contentDigest: completion.cache.contentDigest,
                    bytes: completion.cache.bytes,
                    cachedAt: completion.cache.cachedAt
                  }
                }
              : {})
          })
        : candidate)
    }, options)
  }
  if (!completion.errorDigest || !/^sha256:[a-f0-9]{64}$/.test(completion.errorDigest)) {
    throw new Error('Failed connector refresh requires a SHA-256 errorDigest')
  }
  return store.updateWorkspace(projectId, {
      resources: workspace.resources.map((candidate) => candidate.id === resourceId
        ? withLifecycle(candidate, {
          ...current,
          enabled: current.enabled,
          refresh: { ...current.refresh, status: 'failed', completedAt: now, errorDigest: completion.errorDigest },
          ...(current.autoRefresh && current.autoRefresh.intervalMs > 0
            ? { autoRefresh: { ...current.autoRefresh, nextAt: now + current.autoRefresh.intervalMs } }
            : {})
        })
      : candidate)
  }, options)
}

function applyConnectorMutation(
  resource: ProjectResource,
  mutation: ProjectConnectorMutation,
  now: number
): ProjectResource {
  const current = connectorLifecycle(resource)
  const connector = resource.connector
  if (!connector) throw new Error('Connector contract is missing')
  if (mutation.kind === 'set_enabled') {
    if (mutation.enabled && connector.authorization.status !== 'active') {
      throw new Error('Connector authorization must be active before enabling the resource')
    }
    return withLifecycle(resource, {
      ...current,
      enabled: mutation.enabled,
      refresh: current.refresh,
      ...(mutation.enabled ? { autoRefresh: scheduleAutoRefresh(current.autoRefresh, now) } : {})
    })
  }
  if (mutation.kind === 'set_authorization') {
    if (mutation.status === 'active') {
      const { revocation: _revocation, ...rest } = current
      const next = withLifecycle(resource, {
        ...rest,
        enabled: true,
        refresh: current.refresh,
        ...(current.autoRefresh ? { autoRefresh: scheduleAutoRefresh(current.autoRefresh, now) } : {})
      })
      const { revokedAt: _revokedAt, ...authorization } = next.connector!.authorization
      return {
        ...next,
        connector: {
          ...next.connector!,
          authorization: {
            ...authorization,
            status: 'active',
            grantedAt: now
          }
        }
      }
    }
    const next = withLifecycle(resource, {
      ...current,
      enabled: false,
      refresh: { ...current.refresh, status: 'idle', errorDigest: undefined },
      ...(connector.revocation.purgeCachedData
        ? {
            cache: {
              status: 'purging',
              purgeRequestedAt: now
            }
          }
        : {}),
      revocation: {
        status: 'blocking',
        requestedAt: now,
        pausedSessionIds: [],
        pausedRunIds: []
      }
    })
    return {
      ...next,
      connector: {
        ...next.connector!,
        authorization: {
          ...next.connector!.authorization,
          status: 'revoked',
          revokedAt: now
        }
      }
    }
  }
  if (mutation.kind === 'bind_authorization') {
    const principalId = mutation.principalId.trim()
    const credentialRef = mutation.credentialRef.trim()
    if (!principalId) throw new Error('Connector authorization principalId is required')
    if (!/^oauth:[^/\s]+\/[^/\s]+$/.test(credentialRef) && !/^provider:[^/\s]+\/[^/\s]+$/.test(credentialRef)) {
      throw new Error('Connector authorization credentialRef is invalid')
    }
    assertAuthorizationBinding(principalId, credentialRef)
    const { revocation: _revocation, ...rest } = current
    const { revokedAt: _revokedAt, ...authorization } = connector.authorization
    return {
      ...withLifecycle(resource, {
        ...rest,
        enabled: true,
        refresh: { ...current.refresh, status: 'idle', errorDigest: undefined },
        ...(current.autoRefresh ? { autoRefresh: scheduleAutoRefresh(current.autoRefresh, now) } : {}),
        ...(current.cache ? { cache: { status: 'purging', purgeRequestedAt: now } } : {})
      }),
      connector: {
        ...connector,
        authorization: {
          ...authorization,
          subject: mutation.subject ?? authorization.subject,
          principalId,
          credentialRef,
          status: 'active',
          grantedAt: now
        }
      }
    }
  }
  if (mutation.kind === 'set_auto_refresh') {
    assertAutoRefreshInterval(mutation.intervalMs)
    return withLifecycle(resource, {
      ...current,
      autoRefresh: mutation.intervalMs === 0
        ? { intervalMs: 0 }
        : { intervalMs: mutation.intervalMs, nextAt: now + mutation.intervalMs }
    })
  }
  if (mutation.kind === 'request_refresh') {
    const availability = connectorResourceAvailability(resource)
    if (!availability.available) throw new Error(availability.reason ?? 'Connector is unavailable')
    return withLifecycle(resource, {
      ...current,
      enabled: current.enabled,
      refresh: { ...current.refresh, status: 'requested', requestedAt: now, errorDigest: undefined }
    })
  }
  if (mutation.kind === 'purge_cache') {
    return withLifecycle(resource, {
      ...current,
      cache: { status: 'purging', purgeRequestedAt: now }
    })
  }
  throw new Error('Unsupported Project connector mutation')
}

function assertAuthorizationBinding(principalId: string, credentialRef: string): void {
  const oauth = /^oauth:([^/\s]+)\/([^/\s]+)$/.exec(credentialRef.trim())
  if (!oauth) return
  const [, providerId, accountId] = oauth
  const provider = getProvider(providerId)
  if (!provider || provider.engine !== 'openai' || !provider.authorization?.provider) {
    throw new Error('Connector OAuth Provider is not configured')
  }
  if (principalId.trim() !== accountId) {
    throw new Error('Connector OAuth principalId must match the authorization account')
  }
  const account = listProviderAuthorizationAccounts(providerId).find((candidate) => candidate.id === accountId)
  if (!account) throw new Error('Connector OAuth authorization account was not found')
  if (account.requiresReauth) throw new Error('Connector OAuth authorization account requires reauthorization')
}

function connectorLifecycle(resource: ProjectResource): ConnectorResourceLifecycle {
  return resource.connector?.lifecycle ?? { enabled: true, refresh: { status: 'idle' } }
}

function withLifecycle(resource: ProjectResource, lifecycle: ConnectorResourceLifecycle): ProjectResource {
  if (!resource.connector) throw new Error('Connector contract is missing')
  return { ...resource, connector: { ...resource.connector, lifecycle } }
}

function assertCitationOwnership(citation: ConnectorLatestCitation, projectId: string, resourceId: string): void {
  if (!citation.source.trim() || !citation.version.trim() || !Number.isFinite(citation.retrievedAt)) {
    throw new Error('Connector citation is invalid')
  }
  if (!resourceId.trim() || !projectId.trim() || citation.projectId !== projectId || citation.resourceId !== resourceId) {
    throw new Error('Connector citation crosses Project or Resource ownership')
  }
  if (citation.contentDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(citation.contentDigest)) {
    throw new Error('Connector citation contentDigest is invalid')
  }
}

function connectorErrorDigest(error: unknown): string {
  const category = error instanceof Error ? `${error.name}:${error.message}` : typeof error
  return `sha256:${createHash('sha256').update(category).digest('hex')}`
}

function assertAutoRefreshInterval(value: number): asserts value is ConnectorAutoRefreshInterval {
  if (![0, 900_000, 3_600_000, 21_600_000, 86_400_000].includes(value)) {
    throw new Error('Connector auto-refresh interval is invalid')
  }
}

function scheduleAutoRefresh(
  value: ConnectorResourceLifecycle['autoRefresh'],
  now: number
): ConnectorResourceLifecycle['autoRefresh'] | undefined {
  if (!value || value.intervalMs === 0) return value
  return { ...value, nextAt: now + value.intervalMs }
}

async function executeProjectConnectorRevocation(
  rootDir: string,
  revoked: ProjectWorkspace,
  resourceId: string,
  runtime?: ProjectConnectorLifecycleRuntime
): Promise<ProjectWorkspace> {
  try {
    const blocked = runtime
      ? await runtime.blockRevokedSource(revoked.id, resourceId)
      : { pausedSessionIds: [], pausedRunIds: [] }
    const resource = projectConnectorResource(revoked, resourceId)
    if (resource.connector?.revocation.purgeCachedData) {
      await purgeProjectConnectorCache(rootDir, revoked.id, resourceId)
    }
    return updateConnectorLifecycle(rootDir, revoked.id, resourceId, (current) => ({
      ...current,
      ...(resource.connector?.revocation.purgeCachedData
        ? { cache: { status: 'purged' as const, purgeRequestedAt: current.cache?.purgeRequestedAt, purgedAt: Date.now() } }
        : {}),
      revocation: {
        status: 'completed',
        requestedAt: current.revocation?.requestedAt ?? Date.now(),
        completedAt: Date.now(),
        pausedSessionIds: blocked.pausedSessionIds,
        pausedRunIds: blocked.pausedRunIds
      }
    }))
  } catch (error) {
    return updateConnectorLifecycle(rootDir, revoked.id, resourceId, (current) => ({
      ...current,
      ...(current.cache?.status === 'purging'
        ? { cache: { ...current.cache, status: 'purge_failed' as const, errorDigest: connectorErrorDigest(error) } }
        : {}),
      revocation: {
        status: 'failed',
        requestedAt: current.revocation?.requestedAt ?? Date.now(),
        pausedSessionIds: current.revocation?.pausedSessionIds ?? [],
        pausedRunIds: current.revocation?.pausedRunIds ?? [],
        errorDigest: connectorErrorDigest(error)
      }
    }))
  }
}

async function executeProjectConnectorCachePurge(
  rootDir: string,
  requested: ProjectWorkspace,
  resourceId: string
): Promise<ProjectWorkspace> {
  try {
    await purgeProjectConnectorCache(rootDir, requested.id, resourceId)
    return updateConnectorLifecycle(rootDir, requested.id, resourceId, (current) => ({
      ...current,
      cache: { status: 'purged', purgeRequestedAt: current.cache?.purgeRequestedAt, purgedAt: Date.now() }
    }))
  } catch (error) {
    return updateConnectorLifecycle(rootDir, requested.id, resourceId, (current) => ({
      ...current,
      cache: {
        ...current.cache,
        status: 'purge_failed',
        purgeRequestedAt: current.cache?.purgeRequestedAt ?? Date.now(),
        errorDigest: connectorErrorDigest(error)
      }
    }))
  }
}

async function updateConnectorLifecycle(
  rootDir: string,
  projectId: string,
  resourceId: string,
  update: (current: ConnectorResourceLifecycle) => ConnectorResourceLifecycle
): Promise<ProjectWorkspace> {
  const store = await openProjectWorkspaceStore(rootDir)
  const workspace = await store.getWorkspace(projectId)
  if (!workspace) throw new Error(`Project not found:${projectId}`)
  const resource = projectConnectorResource(workspace, resourceId)
  return store.updateWorkspace(projectId, {
    resources: workspace.resources.map((candidate) => candidate.id === resourceId
      ? withLifecycle(candidate, update(connectorLifecycle(resource)))
      : candidate)
  }, { expectedRevision: workspace.revision })
}

export async function recoverProjectConnectorLifecycles(
  rootDir: string,
  runtime?: ProjectConnectorLifecycleRuntime
): Promise<{ recovered: string[]; failures: string[] }> {
  const store = await openProjectWorkspaceStore(rootDir)
  const workspaces = await store.listWorkspaces({ includeArchived: true, includeDeleted: false })
  const recovered: string[] = []
  const failures: string[] = []
  for (const workspace of workspaces.filter((candidate) => candidate.status === 'active')) {
    for (const resource of workspace.resources.filter((candidate) => candidate.kind === 'connector')) {
      const lifecycle = connectorLifecycle(resource)
      const key = `${workspace.id}:${resource.id}`
      try {
        if (resource.connector?.authorization.status === 'revoked' &&
            (lifecycle.revocation?.status === 'blocking' || lifecycle.revocation?.status === 'failed' ||
             lifecycle.cache?.status === 'purging' || lifecycle.cache?.status === 'purge_failed')) {
          const current = await (await openProjectWorkspaceStore(rootDir)).getWorkspace(workspace.id)
          if (current) await executeProjectConnectorRevocation(rootDir, current, resource.id, runtime)
          recovered.push(key)
          continue
        }
        if (lifecycle.refresh.status === 'running') {
          await updateConnectorLifecycle(rootDir, workspace.id, resource.id, (current) => ({
            ...current,
            refresh: { ...current.refresh, status: 'requested', startedAt: undefined }
          }))
        }
        if (lifecycle.refresh.status === 'requested' || lifecycle.refresh.status === 'running') {
          const current = await (await openProjectWorkspaceStore(rootDir)).getWorkspace(workspace.id)
          if (current) await executeRequestedProjectConnectorRefresh(rootDir, current, resource.id)
          recovered.push(key)
        }
      } catch (error) {
        failures.push(`${key}:${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return { recovered, failures }
}
