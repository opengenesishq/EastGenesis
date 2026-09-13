import type { ProviderModelProfile } from '../../shared/types'
import type { ModelCapabilityProfile, ModelCostProfile, ModelProfile } from './model-profile'

/** Saved declarations override built-in guesses, including an explicitly empty capability list. */
export function applyConfiguredModelProfile(
  profile: ModelProfile,
  configured: ProviderModelProfile | undefined
): ModelProfile {
  if (!configured) return profile
  const capabilities = configured.capabilities === undefined ? undefined : new Set(
    configured.capabilities.map((value) => value.toLowerCase().replace(/[^a-z0-9]/g, ''))
  )
  const supportsTools = capabilities === undefined ? profile.supportsTools
    : hasCapability(capabilities, ['tools', 'tooluse', 'toolcalling', 'functioncalling', 'functioncall'])
  const supportsVision = capabilities === undefined ? profile.supportsVision
    : hasCapability(capabilities, ['vision', 'imageinput', 'inputimage', 'imageunderstanding'])
  return {
    ...profile,
    contextWindowTokens: configured.contextWindow ?? profile.contextWindowTokens,
    cost: configuredCost(configured) ?? profile.cost,
    supportsTools,
    supportsVision,
    supportsText: declaredTextOutput(capabilities),
    capabilities: declaredStrengths(profile.capabilities, capabilities, supportsTools, supportsVision),
    tags: [...profile.tags, 'configured'],
    verification: configured.verification?.generation === 'failed' ? 'failed'
      : configured.verification?.responseValidation === 'protocol-json-v1' ? configured.verification.generation : undefined
  }
}

export function findConfiguredModelProfile(
  model: string,
  configured: ProviderModelProfile[] | undefined
): ProviderModelProfile | undefined {
  const normalized = model.toLowerCase()
  return configured?.find((profile) => profile.model.toLowerCase() === normalized
    || profile.aliases?.some((alias) => alias.toLowerCase() === normalized))
}

function configuredCost(configured: ProviderModelProfile): ModelCostProfile | undefined {
  if (!configured.pricing) return undefined
  const { inputPerMillion, outputPerMillion } = configured.pricing
  const referenceCost = inputPerMillion * 0.004 + outputPerMillion * 0.002
  return {
    inputUsdPerMTok: inputPerMillion,
    outputUsdPerMTok: outputPerMillion,
    tier: referenceCost <= 0.008 ? 'low' : referenceCost <= 0.04 ? 'medium' : 'high'
  }
}

function declaredStrengths(
  original: ModelCapabilityProfile,
  declared: Set<string> | undefined,
  tools: boolean,
  vision: boolean
): ModelCapabilityProfile {
  if (declared === undefined) return original
  return {
    coding: hasCapability(declared, ['coding', 'code']) ? 'high' : 'low',
    reasoning: hasCapability(declared, ['reasoning', 'thinking']) ? 'high' : 'low',
    toolUse: tools ? 'high' : 'low',
    vision: vision ? 'high' : 'low',
    longContext: hasCapability(declared, ['longcontext']) ? 'high' : 'low',
    summarization: hasCapability(declared, ['summarization', 'summarize']) ? 'high' : 'low'
  }
}

function hasCapability(declared: Set<string>, names: string[]): boolean {
  return names.some((name) => declared.has(name))
}

function declaredTextOutput(declared: Set<string> | undefined): boolean {
  if (!declared) return true
  const media = ['image', 'video', 'tts', 'audio', 'imagegenerate', 'imageedit', 'videotexttovideo', 'videoimagetovideo', 'videoreferencetovideo', 'speechsynthesize', 'protocolopenaiimage', 'protocolopenaivideo', 'protocolopenaispeech']
  const text = ['text', 'chat', 'textgeneration', 'coding', 'code', 'reasoning', 'thinking', 'tools', 'tooluse', 'toolcalling', 'functioncalling', 'vision', 'imageunderstanding', 'summarization']
  return !hasCapability(declared, media) || hasCapability(declared, text)
}
