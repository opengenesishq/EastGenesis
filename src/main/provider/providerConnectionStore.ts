import { app } from 'electron'
import type { Provider } from '../../shared/types'
import { assignProviderConnectionIdentity, assertProviderAuthorizationPoolReady, ProviderConnectionUnavailableError, readProviderConnectionIdentity } from './providerConnectionIdentity'
import { readProviderAuthorizationPoolDigest } from './providerAuthorizationPoolIdentity'

interface ConnectionStoreDependencies {
  load(): Provider[]
  diskDigest(): string
  digest(providers: Provider[]): string
  mutate<T>(action: string, operation: () => T): T
  replace(providers: Provider[]): void
  persist(): void
}

export function providerConnectionStore(deps: ConnectionStoreDependencies) {
  function identity(providerId: string) {
    const providers = deps.load()
    if (deps.diskDigest() !== deps.digest(providers)) throw new ProviderConnectionUnavailableError('store_diverged', 'Provider memory and durable configuration differ; reload before execution.')
    const provider = providers.find((item) => item.id === providerId)
    if (!provider) throw new ProviderConnectionUnavailableError('invalid_identity', 'Provider is unavailable.')
    assertProviderAuthorizationPoolReady(provider, readProviderAuthorizationPoolDigest(app.getPath('userData'), providerId))
    return readProviderConnectionIdentity(provider)
  }
  function stageAuthorizationPool(providerId: string, desiredDigest: string): void {
    const before = deps.load(), previous = before.find((item) => item.id === providerId)
    if (!previous) return // Provider deletion may precede cleanup of its authorization accounts.
    if (previous.connectionAuthorizationPoolDigest === desiredDigest) return
    const next = assignProviderConnectionIdentity(previous, previous, { authorizationPoolDigest: desiredDigest })
    deps.mutate('准备 Provider 授权池变更', () => {
      deps.replace(before.map((provider) => provider.id === providerId ? next : provider))
      try { deps.persist() } catch (error) { deps.replace(before); throw error }
    })
  }
  return { identity, stageAuthorizationPool }
}

export function migrateProviderConnectionIdentity(previous: Provider, candidate: Provider): Provider {
  const poolDigest = previous.connectionAuthorizationPoolDigest ?? readProviderAuthorizationPoolDigest(app.getPath('userData'), previous.id)
  const next = assignProviderConnectionIdentity(previous, candidate, { authorizationPoolDigest: poolDigest })
  return JSON.stringify(next.connectionIdentity) === JSON.stringify(previous.connectionIdentity) && poolDigest === previous.connectionAuthorizationPoolDigest ? candidate : next
}

/** Preparation precedes operation-journal digests. Never use imported identity fields. */
export function prepareProviderConnectionSet(before: Provider[], desired: Provider[], credentialReplacements: ReadonlySet<string> = new Set()): Provider[] {
  return desired.map((candidate) => {
    const previous = before.find((provider) => provider.id === candidate.id)
    return assignProviderConnectionIdentity(previous, candidate, { credentialReplacement: credentialReplacements.has(candidate.id),
      authorizationPoolDigest: previous?.connectionAuthorizationPoolDigest ?? readProviderAuthorizationPoolDigest(app.getPath('userData'), candidate.id) })
  })
}

export function assertPreparedProviderConnections(before: Provider[], desired: Provider[]): void {
  const generations = new Set(before.map((provider) => readProviderConnectionIdentity(provider).generationId))
  for (const candidate of desired) {
    const identity = readProviderConnectionIdentity(candidate), previous = before.find((provider) => provider.id === candidate.id)
    if (!previous) {
      if (identity.revision !== 1 || generations.has(identity.generationId)) throw new ProviderConnectionUnavailableError('invalid_identity', 'New Provider must have a new main-created connection generation.')
      continue
    }
    const current = readProviderConnectionIdentity(previous)
    const required = assignProviderConnectionIdentity(previous, candidate, { authorizationPoolDigest: candidate.connectionAuthorizationPoolDigest }).connectionIdentity!
    if (identity.generationId !== current.generationId || identity.revision < required.revision || identity.revision > current.revision + 1) {
      throw new ProviderConnectionUnavailableError('invalid_identity', 'Prepared Provider connection transition is inconsistent.')
    }
  }
}
