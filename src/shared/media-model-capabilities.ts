import type { MediaOperation } from './media-types'

export const MEDIA_MODEL_PROTOCOLS = {
  'openai-image': { capability: 'image', operations: ['image.generate', 'image.edit'] },
  'openai-video': { capability: 'video', operations: ['video.text-to-video', 'video.image-to-video', 'video.reference-to-video'] },
  'openai-speech': { capability: 'tts', operations: ['speech.synthesize'] }
} as const
export type MediaModelProtocol = keyof typeof MEDIA_MODEL_PROTOCOLS

export function declaredMediaOperations(capabilities: string[] | undefined, protocol: MediaModelProtocol): MediaOperation[] {
  const declarations = new Set((capabilities ?? []).map((value) => value.toLowerCase().trim()))
  if (!declarations.has(`protocol:${protocol}`) && !declarations.has(protocol)) return []
  const spec = MEDIA_MODEL_PROTOCOLS[protocol]
  const operations = spec.operations.filter((operation) => declarations.has(operation))
  return operations.length ? operations : declarations.has(spec.capability) ? [spec.operations[0]] : []
}

export function updateDeclaredMediaOperations(capabilities: string[] | undefined, protocol: MediaModelProtocol, operations: MediaOperation[]): string[] {
  const spec = MEDIA_MODEL_PROTOCOLS[protocol]
  const owned = new Set<string>([protocol, `protocol:${protocol}`, spec.capability, ...spec.operations])
  const preserved = (capabilities ?? []).filter((value) => !owned.has(value.trim().toLowerCase()))
  return [...preserved, ...(operations.length ? [spec.capability, `protocol:${protocol}`, ...operations] : [])]
}
