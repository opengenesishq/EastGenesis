import type { ProviderModelProfile } from './types'

/**
 * Capabilities shared by routing, provider setup and every business line.
 * Values are intentionally derived only from the model profile declaration;
 * callers must keep the distinction between declared and verified capability.
 */
export const PROVIDER_MODEL_CAPABILITIES = ['text', 'tools', 'vision', 'image', 'video', 'audio'] as const
export type ProviderModelCapability = typeof PROVIDER_MODEL_CAPABILITIES[number]

export interface ProviderModelCapabilitySummary {
  total: number
  classified: number
  unclassified: number
  byCapability: Record<ProviderModelCapability, number>
}

const CAPABILITY_ALIASES: Record<ProviderModelCapability, string[]> = {
  text: ['text', 'chat', 'completion', 'summarization', 'reasoning', 'coding'],
  tools: ['tools', 'tool', 'tool-use', 'tool_use', 'function-calling', 'function_calling'],
  vision: ['vision', 'image-understanding', 'multimodal'],
  image: ['image', 'image-generation'],
  video: ['video', 'video-generation'],
  audio: ['audio', 'speech', 'tts', 'synthesis', 'transcription']
}

export function hasDeclaredProviderModelCapability(
  profile: ProviderModelProfile,
  capability: ProviderModelCapability
): boolean {
  const values = new Set((profile.capabilities ?? []).map(normalizeCapability))
  return CAPABILITY_ALIASES[capability].some((alias) => values.has(normalizeCapability(alias)))
    || [...values].some((value) => value.startsWith('protocol:') && value.includes(capability))
}

export function summarizeProviderModelProfiles(
  profiles: ProviderModelProfile[] | undefined
): ProviderModelCapabilitySummary {
  const list = profiles ?? []
  const byCapability = Object.fromEntries(
    PROVIDER_MODEL_CAPABILITIES.map((capability) => [capability, 0])
  ) as Record<ProviderModelCapability, number>
  let classified = 0
  for (const profile of list) {
    const capabilities = PROVIDER_MODEL_CAPABILITIES.filter((capability) =>
      hasDeclaredProviderModelCapability(profile, capability)
    )
    if (capabilities.length > 0) classified += 1
    for (const capability of capabilities) byCapability[capability] += 1
  }
  return {
    total: list.length,
    classified,
    unclassified: list.length - classified,
    byCapability
  }
}

function normalizeCapability(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-').replace(/_/g, '-')
}
