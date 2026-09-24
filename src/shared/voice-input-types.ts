export const VOICE_INPUT_MAX_BYTES = 20 * 1024 * 1024
export const VOICE_INPUT_MAX_DURATION_MS = 120_000

export interface VoiceInputSettings {
  providerId: string
  model: string
  /** Empty means language detection by the configured provider. */
  language?: string
}
export interface VoiceInputPreparation {
  preparationId: string
  contextId: string
  providerName: string
  model: string
  expiresAt: number
  maxBytes: number
  maxDurationMs: number
}
export interface VoiceInputTranscriptionInput {
  preparationId: string
  requestId: string
  audio: ArrayBuffer
  mimeType: string
  durationMs: number
}
export interface VoiceInputTranscriptionResult {
  requestId: string
  contextId: string
  text: string
  providerName: string
  model: string
  durationMs: number
  /** Transcription providers generally omit billed costs. Unknown is never represented as zero. */
  costStatus: 'unknown'
}
export interface VoiceInputApi {
  prepareVoiceInput(contextId: string): Promise<VoiceInputPreparation>
  requestVoiceMicrophonePermission(): Promise<boolean>
  transcribeVoiceInput(input: VoiceInputTranscriptionInput): Promise<VoiceInputTranscriptionResult>
  cancelVoiceInput(preparationId: string): Promise<void>
}
export type VoiceDraftApi = Pick<VoiceInputApi, 'prepareVoiceInput' | 'requestVoiceMicrophonePermission' | 'transcribeVoiceInput' | 'cancelVoiceInput'>

export function normalizeVoiceInputSettings(value: unknown): VoiceInputSettings | undefined {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('语音输入配置无效。')
  const config = value as Record<string, unknown>
  const providerId = typeof config.providerId === 'string' ? config.providerId.trim() : ''
  const model = typeof config.model === 'string' ? config.model.trim() : ''
  const language = typeof config.language === 'string' ? config.language.trim().toLowerCase() : ''
  if (providerId.length > 160 || model.length > 200 || /[\r\n\0]/.test(providerId + model) || (language && !/^[a-z]{2,3}(?:-[a-z]{2})?$/.test(language))) {
    throw new Error('语音输入厂商、模型或语言配置无效。')
  }
  return { providerId, model, language: language || undefined }
}
