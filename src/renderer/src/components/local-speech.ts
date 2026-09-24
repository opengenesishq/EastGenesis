import type { VoiceInputSettings } from '../../../shared/voice-input-types'
export function selectLocalSpeechVoice(voices: SpeechSynthesisVoice[], settings: VoiceInputSettings | undefined, language: string): { voice?: SpeechSynthesisVoice; fallback: boolean; rate: number } {
  const local = voices.filter(voice => voice.localService)
  const selected = local.find(voice => voice.voiceURI === settings?.localVoiceUri)
  return { voice: selected ?? local.find(voice => voice.lang.toLowerCase().startsWith(language.toLowerCase())) ?? local[0], fallback: Boolean(settings?.localVoiceUri && !selected), rate: settings?.speechRate ?? 1 }
}
