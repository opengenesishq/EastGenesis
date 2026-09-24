export const VOICE_INPUT_MAX_BYTES = 20 * 1024 * 1024
export const VOICE_INPUT_MAX_DURATION_MS = 120_000

export interface VoiceInputSettings {
  providerId: string
  model: string
  /** Empty means language detection by the configured provider. */
  language?: string
  localVoiceUri?: string
  speechRate?: number
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
export interface VoiceInputApi extends RealtimeVoiceApi {
  prepareVoiceInput(contextId: string): Promise<VoiceInputPreparation>
  requestVoiceMicrophonePermission(): Promise<boolean>
  transcribeVoiceInput(input: VoiceInputTranscriptionInput): Promise<VoiceInputTranscriptionResult>
  cancelVoiceInput(preparationId: string): Promise<void>
}
export type VoiceDraftApi = Pick<VoiceInputApi, 'prepareVoiceInput' | 'requestVoiceMicrophonePermission' | 'transcribeVoiceInput' | 'cancelVoiceInput'>

/** Application-level segmented ASR + local TTS; not a provider-native duplex protocol. */
export interface RealtimeVoicePreparation extends VoiceInputPreparation {
  callId: string
  sessionId: string
  maxSegmentDurationMs: number
}
export interface RealtimeVoiceSegmentInput {
  callId: string
  segmentId: string
  sequence: number
  audio: ArrayBuffer
  mimeType: string
  durationMs: number
}
export interface RealtimeVoiceSegmentResult {
  callId: string
  sessionId: string
  segmentId: string
  text: string
  action: 'input' | 'pause' | 'cancel'
  input?: import('./session-input-types').SessionInputRecord
}
export interface RealtimeVoiceApi {
  prepareRealtimeVoice(sessionId: string): Promise<RealtimeVoicePreparation>
  startRealtimeVoice(callId: string): Promise<void>
  submitRealtimeVoiceSegment(input: RealtimeVoiceSegmentInput): Promise<RealtimeVoiceSegmentResult>
  drainRealtimeVoice(callId: string): Promise<import('./session-input-types').SessionInputRecord[]>
  stopRealtimeVoice(callId: string): Promise<void>
  controlRealtimeVoice(input: { callId: string; command: 'pause' | 'cancel' }): Promise<void>
}
export function normalizeVoiceInputSettings(value: unknown): VoiceInputSettings | undefined {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('语音输入配置无效。')
  const config = value as Record<string, unknown>
  const providerId = typeof config.providerId === 'string' ? config.providerId.trim() : ''
  const model = typeof config.model === 'string' ? config.model.trim() : ''
  const language = typeof config.language === 'string' ? config.language.trim().toLowerCase() : ''
  const localVoiceUri = typeof config.localVoiceUri === 'string' ? config.localVoiceUri.trim() : ''
  const speechRate = config.speechRate === undefined ? 1 : config.speechRate
  if (localVoiceUri.length > 1024 || /[\r\n\0]/.test(localVoiceUri) || typeof speechRate !== 'number' || !Number.isFinite(speechRate) || speechRate < 0.5 || speechRate > 2) throw new Error('本地声线或语速无效。')
  if (providerId.length > 160 || model.length > 200 || /[\r\n\0]/.test(providerId + model) || (language && !/^[a-z]{2,3}(?:-[a-z]{2})?$/.test(language))) {
    throw new Error('语音输入厂商、模型或语言配置无效。')
  }
  return { providerId, model, language: language || undefined, localVoiceUri: localVoiceUri || undefined, speechRate }
}
