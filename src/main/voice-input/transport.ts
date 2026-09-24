import { VOICE_INPUT_MAX_BYTES, VOICE_INPUT_MAX_DURATION_MS } from '../../shared/voice-input-types'

const EXTENSIONS: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3' }

export function voiceTranscriptionEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('语音厂商地址无效。')
  let root = url.pathname.replace(/\/+$/, '')
  root = root.replace(/\/(?:chat\/completions|responses|audio\/transcriptions)$/, '')
  if (!/\/v\d+(?:beta\d*)?$/i.test(root)) root += '/v1'
  url.pathname = `${root}/audio/transcriptions`
  return url.toString()
}

export function voiceTranscriptionForm(input: { audio: ArrayBuffer; mimeType: string; durationMs: number }, model: string, language?: string): FormData {
  const mime = (typeof input.mimeType === 'string' ? input.mimeType : '').toLowerCase().split(';', 1)[0].trim()
  if (!(input.audio instanceof ArrayBuffer) || input.audio.byteLength < 16 || input.audio.byteLength > VOICE_INPUT_MAX_BYTES || !EXTENSIONS[mime]) throw new Error('录音为空、格式不支持或超过 20 MB。')
  if (!Number.isFinite(input.durationMs) || input.durationMs < 100 || input.durationMs > VOICE_INPUT_MAX_DURATION_MS) throw new Error('录音时长必须在 0.1 秒到 2 分钟之间。')
  const form = new FormData()
  form.set('file', new Blob([input.audio], { type: mime }), `voice-input.${EXTENSIONS[mime]}`)
  form.set('model', model)
  form.set('response_format', 'json')
  if (language) form.set('language', language)
  return form
}

export async function readVoiceTranscription(response: Response): Promise<string> {
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 401 || response.status === 403) throw new Error('语音转写被拒绝，请检查所选厂商的密钥和转写权限。')
    if (response.status === 404) throw new Error('此厂商或模型没有提供兼容的语音转写接口，请在语音设置中修改。')
    if (response.status === 429) throw new Error('语音转写额度或请求频率受限，录音仍保留，可稍后重试。')
    throw new Error(`语音转写失败（HTTP ${response.status}），录音仍保留，可重试。`)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('语音转写没有返回结果。')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 256 * 1024) { await reader.cancel(); throw new Error('语音转写响应过大。') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('语音厂商返回了无效的转写结果。') }
  const text = value && typeof value === 'object' && 'text' in value && typeof value.text === 'string' ? value.text.trim() : ''
  if (!text) throw new Error('没有识别到文字；录音仍保留，可重试或重新录音。')
  if (text.length > 32_000) throw new Error('转写文字超过长度限制。')
  return text
}
