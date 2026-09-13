import type {
  EngineKind,
  OpenAIProtocol,
  Provider,
  ProviderApiKey,
  ProviderInput
} from '../../shared/types'
import { resolvedProviderCredentialHeaderNames } from './providerCredentialHeaders'
import { normalizeProviderCredentialRoutingMode } from '../providerKeyRouting'

interface ProviderPatchFields {
  baseUrl: string
  customHeaders?: string
  credentialHeaderNames?: string[]
}

interface ProviderPatchFieldDependencies {
  normalizedCustomHeaders(value: string | undefined): string | undefined
  normalizedCredentialHeaderNames(value: unknown): string[] | undefined
  normalizeBaseUrl(baseUrl: string, engine: EngineKind, protocol?: OpenAIProtocol): string
  resolveProviderEngine(provider: Provider): EngineKind
}

interface ProviderMergeDependencies {
  normalizeBudget(value: unknown): number
  resolveProviderEngine(provider: Provider): EngineKind
}

interface ProviderPatchOptions {
  replaceOptionalConfiguration?: boolean
}

export function resolveProviderPatchFields(
  previous: Provider,
  patch: Partial<ProviderInput>,
  dependencies: ProviderPatchFieldDependencies,
  options: ProviderPatchOptions = {}
): ProviderPatchFields {
  const customHeaders = patch.customHeaders === undefined && !options.replaceOptionalConfiguration
    ? previous.customHeaders
    : dependencies.normalizedCustomHeaders(patch.customHeaders)
  const credentialHeaderNames = patch.credentialHeaderNames === undefined && !options.replaceOptionalConfiguration
    ? previous.credentialHeaderNames
    : dependencies.normalizedCredentialHeaderNames(patch.credentialHeaderNames)
  const baseUrl = patch.baseUrl === undefined
    ? previous.baseUrl
    : dependencies.normalizeBaseUrl(
        patch.baseUrl,
        patch.engine ?? dependencies.resolveProviderEngine(previous),
        patch.openaiProtocol ?? previous.openaiProtocol
      )
  return { baseUrl, customHeaders, credentialHeaderNames }
}

export function removeProviderKeys(
  providerId: string,
  keys: ProviderApiKey[],
  removeKeyIds: string[] | undefined,
  forgetCredential: (providerId: string, keyId: string) => void
): ProviderApiKey[] {
  const removeIds = new Set((removeKeyIds ?? []).filter(Boolean))
  if (removeIds.size === 0) return keys
  for (const keyId of removeIds) forgetCredential(providerId, keyId)
  return keys.filter((key) => !removeIds.has(key.id))
}

export function mergeProviderPatch(
  previous: Provider,
  patch: Partial<ProviderInput>,
  fields: ProviderPatchFields,
  apiKeys: ProviderApiKey[],
  activeKeyId: string | undefined,
  dependencies: ProviderMergeDependencies,
  options: ProviderPatchOptions = {}
): Provider {
  const activeKey = apiKeys.find((key) => key.id === activeKeyId)
  const next: Provider = {
    ...previous,
    name: patch.name ?? previous.name,
    baseUrl: fields.baseUrl,
    models: patch.models ?? previous.models,
    authMode: patch.authMode ?? previous.authMode,
    engine: patch.engine ?? dependencies.resolveProviderEngine(previous),
    customHeaders: fields.customHeaders,
    credentialHeaderNames: fields.credentialHeaderNames,
    budgetUsd: patch.budgetUsd === undefined && !options.replaceOptionalConfiguration
      ? dependencies.normalizeBudget(previous.budgetUsd)
      : dependencies.normalizeBudget(patch.budgetUsd),
    openaiProtocol: options.replaceOptionalConfiguration
      ? patch.openaiProtocol
      : patch.openaiProtocol ?? previous.openaiProtocol,
    note: options.replaceOptionalConfiguration
      ? patch.note?.trim() || undefined
      : patch.note ?? previous.note,
    encryptedToken: activeKey?.encryptedToken ?? '',
    apiKeys,
    activeKeyId,
    credentialRoutingMode: normalizeProviderCredentialRoutingMode(
      patch.credentialRoutingMode ?? previous.credentialRoutingMode
    )
  }
  next.credentialHeaderNames = resolvedProviderCredentialHeaderNames(next)
  next.credentialMigrationRequired = resolveCredentialMigrationRequired(
    previous,
    next,
    patch,
    apiKeys,
    dependencies.resolveProviderEngine
  )
  return next
}

function resolveCredentialMigrationRequired(
  previous: Provider,
  next: Provider,
  patch: Partial<ProviderInput>,
  apiKeys: ProviderApiKey[],
  resolveProviderEngine: (provider: Provider) => EngineKind
): boolean | undefined {
  if (apiKeys.length === 0 || providerPatchReplacesCredentials(patch)) return false
  if (providerCredentialBindingChanged(previous, next, resolveProviderEngine)) return true
  return previous.credentialMigrationRequired
}

export function providerPatchReplacesCredentials(patch: Partial<ProviderInput>): boolean {
  return patch.token !== undefined
    || patch.additionalTokens?.some((item) => Boolean(item.token.trim())) === true
}

export function providerCredentialBindingChanged(
  previous: Provider,
  next: Provider,
  resolveProviderEngine: (provider: Provider) => EngineKind
): boolean {
  return providerCredentialBindingIdentity(previous, resolveProviderEngine) !==
    providerCredentialBindingIdentity(next, resolveProviderEngine)
}

function providerCredentialBindingIdentity(
  provider: Provider,
  resolveProviderEngine: (provider: Provider) => EngineKind
): string {
  return JSON.stringify({
    baseUrl: provider.baseUrl.trim().replace(/\/+$/, ''),
    engine: resolveProviderEngine(provider),
    openaiProtocol: provider.openaiProtocol ?? '',
    customHeaders: provider.customHeaders?.trim() ?? '',
    credentialHeaderNames: resolvedProviderCredentialHeaderNames(provider).sort()
  })
}
