import type { EngineKind, Provider } from '../../shared/types'

export const PROVIDER_ENGINE_BLOCKED_UNKNOWN = 'blocked_unknown_engine' as const

export class ProviderEngineResolutionError extends Error {
  readonly code = PROVIDER_ENGINE_BLOCKED_UNKNOWN
  readonly engine: string | undefined

  constructor(engine: unknown) {
    const value = typeof engine === 'string' ? engine : undefined
    super(value
      ? `Provider execution engine is unsupported: ${value}`
      : 'Provider execution engine is missing')
    this.name = 'ProviderEngineResolutionError'
    this.engine = value
  }
}

export function resolveProviderEngine(provider: Pick<Provider, 'engine' | 'name' | 'baseUrl' | 'models' | 'openaiProtocol'>): EngineKind {
  const engine = (provider as unknown as { engine?: string }).engine
  if (engine === 'openai' || engine === 'anthropic' || engine === 'gemini') return engine
  if (engine === 'claude') return 'anthropic'
  // Missing engine metadata is a legacy record shape. Preserve the existing
  // protocol/endpoint inference for those records, but never guess for an
  // explicitly unknown engine value.
  if (engine !== undefined && engine !== '') throw new ProviderEngineResolutionError(engine)
  if (provider.openaiProtocol === 'chat') return 'openai'
  const identity = `${provider.name}\n${provider.baseUrl}\n${provider.models.join('\n')}`.toLowerCase()
  return /anthropic|claude|\/anthropic(?:\/|$)/.test(identity) ? 'anthropic' : 'openai'
}
