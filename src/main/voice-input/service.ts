import { randomUUID } from 'node:crypto'
import type { VoiceInputPreparation, VoiceInputTranscriptionInput, VoiceInputTranscriptionResult } from '../../shared/voice-input-types'
import { VOICE_INPUT_MAX_BYTES, VOICE_INPUT_MAX_DURATION_MS } from '../../shared/voice-input-types'
import { voiceTranscriptionForm } from './transport'
import type { VoiceInputUsageRecord } from './usage'

export interface VoiceTarget {
  providerId: string
  providerName: string
  model: string
  language?: string
  baseUrl: string
  identity: string
  keyId?: string
  keyLabel?: string
}
export interface VoiceInputDependencies {
  target(): VoiceTarget
  execute(target: VoiceTarget, form: FormData, signal: AbortSignal): Promise<string>
  saveUsage(record: VoiceInputUsageRecord): void
  reserve(target: VoiceTarget, requestId: string, contextId: string): { sent(): void; finish(): void }
  now?: () => number
}
interface Prepared {
  owner: number
  public: VoiceInputPreparation
  target: VoiceTarget
  pending?: { requestId: string; controller: AbortController; result: Promise<VoiceInputTranscriptionResult> }
}
const MAX_PREPARATIONS = 64
const TTL = 15 * 60_000

export function createVoiceInputService(dependencies: VoiceInputDependencies) {
  const entries = new Map<string, Prepared>()
  const now = dependencies.now ?? Date.now
  const cancel = (owner: number, preparationId: string): void => {
    const entry = entries.get(preparationId)
    if (!entry || entry.owner !== owner) return
    entry.pending?.controller.abort()
    entries.delete(preparationId)
  }
  return {
    prepare(owner: number, contextId: string): VoiceInputPreparation {
      if (typeof contextId !== 'string' || !contextId.trim() || contextId.length > 200 || /[\r\n\0]/.test(contextId)) throw new Error('语音输入草稿身份无效。')
      for (const [id, entry] of entries) if (entry.public.expiresAt <= now()) cancel(entry.owner, id)
      if (entries.size >= MAX_PREPARATIONS) throw new Error('待处理录音过多，请关闭其他语音输入后重试。')
      const target = dependencies.target()
      const result: VoiceInputPreparation = { preparationId: randomUUID(), contextId, providerName: target.providerName, model: target.model,
        expiresAt: now() + TTL, maxBytes: VOICE_INPUT_MAX_BYTES, maxDurationMs: VOICE_INPUT_MAX_DURATION_MS }
      entries.set(result.preparationId, { owner, public: result, target })
      return result
    },
    transcribe(owner: number, input: VoiceInputTranscriptionInput): Promise<VoiceInputTranscriptionResult> {
      if (!input || typeof input !== 'object' || Object.keys(input).some((key) => !['preparationId', 'requestId', 'audio', 'mimeType', 'durationMs'].includes(key))) throw new Error('语音转写请求字段无效。')
      const entry = entries.get(input.preparationId)
      if (!entry || entry.owner !== owner || entry.public.expiresAt <= now()) throw new Error('录音准备已过期，请重新打开语音输入。')
      if (typeof input.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.requestId)) throw new Error('语音请求身份无效。')
      if (entry.pending) {
        if (entry.pending.requestId === input.requestId) return entry.pending.result
        throw new Error('此录音正在转写，请等待当前请求完成。')
      }
      const current = dependencies.target()
      if (current.identity !== entry.target.identity) throw new Error('语音模型或厂商连接已变化，请关闭后重新录音。')
      const form = voiceTranscriptionForm(input, entry.target.model, entry.target.language)
      const controller = new AbortController()
      const startedAt = now()
      const usage: VoiceInputUsageRecord = { id: input.requestId, providerId: entry.target.providerId, model: entry.target.model,
        keyLabel: entry.target.keyLabel, startedAt, durationMs: input.durationMs, audioBytes: input.audio.byteLength, status: 'started' }
      const budget = dependencies.reserve(entry.target, input.requestId, entry.public.contextId)
      try { dependencies.saveUsage(usage) } catch (error) { budget.finish(); throw error }
      const result = Promise.resolve().then(async () => {
        let status: VoiceInputUsageRecord['status'] = 'failed'
        const timeout = setTimeout(() => controller.abort(), 120_000)
        try {
          if (controller.signal.aborted) throw new Error('语音转写已取消。')
          budget.sent()
          const text = await dependencies.execute(entry.target, form, controller.signal)
          if (controller.signal.aborted || !entries.has(entry.public.preparationId)) throw new Error('语音转写已取消。')
          status = 'succeeded'
          return { requestId: input.requestId, contextId: entry.public.contextId, text, providerName: entry.target.providerName,
            model: entry.target.model, durationMs: input.durationMs, costStatus: 'unknown' as const }
        } catch (error) {
          status = controller.signal.aborted ? 'cancelled' : 'failed'
          if (controller.signal.aborted) throw new Error('转写已取消或超时；已上传的请求仍可能计费。录音未丢失时可手动重试。')
          throw error
        } finally {
          clearTimeout(timeout)
          try { try { dependencies.saveUsage({ ...usage, completedAt: now(), status }) } finally { budget.finish() } }
          finally { if (entry.pending?.requestId === input.requestId) entry.pending = undefined }
        }
      })
      entry.pending = { requestId: input.requestId, controller, result }
      return result
    },
    cancel,
    cancelOwner(owner: number): void { for (const [id, entry] of entries) if (entry.owner === owner) cancel(owner, id) }
  }
}
