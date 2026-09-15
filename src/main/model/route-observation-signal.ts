import type { ProviderConnectionIdentity } from '../../shared/provider-connection-identity'
import type { ProviderView } from '../../shared/types'
import { findConfiguredModelProfile } from './configured-model-profile'
import { resolveOpenAIProtocol, resolveProviderRuntimeTarget } from '../provider/providerRuntimeTarget'

export interface RouteObservationIdentity {
  providerId: string
  connectionIdentity: ProviderConnectionIdentity
  protocol: string
  /** Canonical wire model; aliases do not create separate observations. */
  model: string
}

export interface RouteObservationSignal extends RouteObservationIdentity {
  successes: number
  failures: number
  reliability: number
  latencyEmaMs?: number
}

let snapshot = new Map<string, RouteObservationSignal>()

export function routeObservationKey(identity: RouteObservationIdentity): string {
  return JSON.stringify([identity.providerId, identity.connectionIdentity.generationId,
    identity.connectionIdentity.revision, identity.protocol, identity.model])
}

/** Main supplies the opaque current connection identity; no endpoint or credential is hashed. */
export function routeObservationIdentity(provider: ProviderView, model: string,
  connectionIdentity?: ProviderConnectionIdentity): RouteObservationIdentity | undefined {
  if (!connectionIdentity || !/^[a-f0-9-]{36}$/i.test(connectionIdentity.generationId) ||
      !Number.isSafeInteger(connectionIdentity.revision) || connectionIdentity.revision < 1) return undefined
  const raw = model.trim()
  const stripPrefix = (value: string) => provider.engine === 'gemini' ? value.replace(/^models\//, '') : value
  const canonical = findConfiguredModelProfile(raw, provider.advancedConfig?.modelProfiles)?.model
    ?? findConfiguredModelProfile(stripPrefix(raw), provider.advancedConfig?.modelProfiles)?.model ?? raw
  let target: ReturnType<typeof resolveProviderRuntimeTarget>
  try { target = resolveProviderRuntimeTarget(provider, { appId: provider.engine, model: raw }) }
  catch { return undefined }
  // An app remap is not evidence for the scored model. The existing route gate
  // still decides whether such a candidate is executable.
  if (stripPrefix(target.model) !== stripPrefix(canonical)) return undefined
  const protocol = provider.engine === 'anthropic' ? 'anthropic.messages'
    : provider.engine === 'gemini' ? 'google.generative-language'
      : provider.engine === 'openai' ? resolveOpenAIProtocol(target) === 'responses' ? 'openai.responses' : 'openai.chat-completions'
        : undefined
  if (!protocol) return undefined
  return { providerId: provider.id, connectionIdentity: { ...connectionIdentity }, protocol,
    model: stripPrefix(canonical) }
}

/** Synchronous request-path projection; rebuilding it never creates a second attempt log. */
export function getRouteObservationSignal(identity: RouteObservationIdentity): RouteObservationSignal | undefined {
  return snapshot.get(routeObservationKey(identity))
}

export function publishRouteObservationSnapshot(next: ReadonlyMap<string, RouteObservationSignal>): void {
  snapshot = new Map(next)
}
