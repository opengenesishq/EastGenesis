import { createHash, randomUUID } from 'node:crypto'
import type { RealtimeVoicePreparation, RealtimeVoiceSegmentInput, RealtimeVoiceSegmentResult } from '../../shared/voice-input-types'
import type { SessionInputRecord } from '../../shared/session-input-types'
import type { createVoiceInputService } from './service'

export interface RealtimeVoiceDependencies {
  voice: ReturnType<typeof createVoiceInputService>
  session(id: string): { status: string } | undefined
  inputs: {
    queue(sessionId: string, id: string, payload: { text: string }): Promise<SessionInputRecord>
    list(sessionId: string): Promise<SessionInputRecord[]>
    apply(sessionId: string, id: string, beforeDispatch?: () => Promise<void>): Promise<SessionInputRecord>
    cancel(sessionId: string, id: string): Promise<SessionInputRecord>
  }
  control(sessionId: string, command: 'pause' | 'cancel'): Promise<void>
  now?: () => number
}
interface Call {
  owner: number
  prepared: RealtimeVoicePreparation
  active: boolean
  nextSequence: number
  segments: Map<string, { digest: string; result: Promise<RealtimeVoiceSegmentResult> }>
  inputIds: Set<string>
  tail: Promise<unknown>
  draining?: Promise<SessionInputRecord[]>
}
const MAX_SEGMENTS = 240
const MAX_SEGMENT_DURATION_MS = 30_000

/** Voice only orchestrates the existing SessionInput outbox; it never owns execution truth. */
export function createRealtimeVoiceService(deps: RealtimeVoiceDependencies) {
  const calls = new Map<string, Call>()
  const now = deps.now ?? Date.now
  const session = (id: string) => {
    const value = deps.session(id)
    if (!value || value.status === 'closed') throw new Error('当前任务已关闭或不可用。')
    return value
  }
  const required = (owner: number, id: string, active = true): Call => {
    const call = calls.get(id)
    if (!call || call.owner !== owner || call.prepared.expiresAt <= now() || (active && !call.active)) throw new Error('语音会话已停止或过期，请重新开始。')
    session(call.prepared.sessionId)
    return call
  }
  const cancelQueued = async (call: Call): Promise<void> => {
    const records = await deps.inputs.list(call.prepared.sessionId)
    for (const record of records) if (call.inputIds.has(record.id) && record.phase === 'queued') {
      try { await deps.inputs.cancel(record.sessionId, record.id) } catch (error) {
        const latest = (await deps.inputs.list(record.sessionId)).find(item => item.id === record.id)
        if (latest && latest.phase !== 'queued') continue
        // The apply guard will reject after preflight; its finally retries withdrawal.
        if (!call.draining) throw error
      }
    }
  }
  const stop = async (owner: number, id: string): Promise<void> => {
    const call = calls.get(id)
    if (!call || call.owner !== owner) return
    call.active = false
    calls.delete(id)
    deps.voice.cancel(owner, call.prepared.preparationId)
    // A stopped call's accepted text remains in the outbox with a cancelled receipt.
    await cancelQueued(call)
  }
  const control = async (owner: number, input: { callId: string; command: 'pause' | 'cancel' }): Promise<void> => {
    if (!input || !['pause', 'cancel'].includes(input.command)) throw new Error('语音任务控制无效。')
    const call = required(owner, input.callId)
    // Invalidate first, so late transcription or authorization cannot dispatch more work.
    const stopping = stop(owner, input.callId)
    const results = await Promise.allSettled([stopping, deps.control(call.prepared.sessionId, input.command)])
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  return {
    prepare(owner: number, sessionId: string): RealtimeVoicePreparation {
      session(sessionId)
      for (const call of calls.values()) if (call.owner === owner) throw new Error('请先结束当前语音会话。')
      const prepared = { ...deps.voice.prepare(owner, sessionId), callId: randomUUID(), sessionId, maxSegmentDurationMs: MAX_SEGMENT_DURATION_MS }
      calls.set(prepared.callId, { owner, prepared, active: false, nextSequence: 0, segments: new Map(), inputIds: new Set(), tail: Promise.resolve() })
      return prepared
    },
    start(owner: number, id: string): void { required(owner, id, false).active = true },
    segment(owner: number, input: RealtimeVoiceSegmentInput): Promise<RealtimeVoiceSegmentResult> {
      if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['callId', 'segmentId', 'sequence', 'audio', 'mimeType', 'durationMs'].includes(key))) throw new Error('语音分段字段无效。')
      const call = required(owner, input.callId)
      if (typeof input.segmentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.segmentId) || !Number.isSafeInteger(input.sequence) || input.sequence < 0 ||
        !(input.audio instanceof ArrayBuffer) || input.audio.byteLength < 16 || input.audio.byteLength > call.prepared.maxBytes ||
        !Number.isFinite(input.durationMs) || input.durationMs < 100 || input.durationMs > MAX_SEGMENT_DURATION_MS || typeof input.mimeType !== 'string') throw new Error('语音分段身份、格式或时长无效。')
      const digest = createHash('sha256').update(Buffer.from(input.audio)).update(JSON.stringify([input.sequence, input.mimeType, input.durationMs])).digest('hex')
      const existing = call.segments.get(input.segmentId)
      if (existing) {
        if (existing.digest !== digest) throw new Error('同一语音分段不能替换内容。')
        return existing.result
      }
      if (input.sequence !== call.nextSequence || call.segments.size >= MAX_SEGMENTS) throw new Error('语音分段顺序无效或本次会话已达上限。')
      call.nextSequence++
      const result = call.tail.then(async (): Promise<RealtimeVoiceSegmentResult> => {
        required(owner, input.callId)
        const result = await deps.voice.transcribe(owner, { preparationId: call.prepared.preparationId, requestId: input.segmentId,
          audio: input.audio, mimeType: input.mimeType, durationMs: input.durationMs })
        required(owner, input.callId)
        if (result.contextId !== call.prepared.sessionId) throw new Error('语音转写任务身份不一致。')
        const command = result.text.trim().replace(/[。！!.]+$/, '').toLowerCase()
        const action = /^(暂停(这个|当前)?任务|暂停一下|pause( this task)?)$/.test(command) ? 'pause'
          : /^(取消(这个|当前)?任务|停止(这个|当前)?任务|cancel( this task)?|stop this task)$/.test(command) ? 'cancel' : 'input'
        const receipt: RealtimeVoiceSegmentResult = { callId: input.callId, sessionId: call.prepared.sessionId, segmentId: input.segmentId, text: result.text, action }
        if (action !== 'input') { await control(owner, { callId: input.callId, command: action }); return receipt }
        const id = `voice-${input.callId}-${input.sequence}`
        call.inputIds.add(id)
        const queued = await deps.inputs.queue(call.prepared.sessionId, id, { text: result.text })
        if (!call.active || !calls.has(input.callId)) {
          if (queued.phase === 'queued') await deps.inputs.cancel(queued.sessionId, queued.id)
          throw new Error('语音会话已停止，文字已保留，未继续提交。')
        }
        return { ...receipt, input: queued }
      })
      call.segments.set(input.segmentId, { digest, result })
      call.tail = result.catch(() => undefined)
      return result
    },
    drain(owner: number, id: string): Promise<SessionInputRecord[]> {
      const call = required(owner, id)
      if (call.draining) return call.draining
      const operation = Promise.resolve().then(async () => {
        const all = await deps.inputs.list(call.prepared.sessionId)
        const own = all.filter(record => call.inputIds.has(record.id))
        const first = all.find(record => !['applied', 'requirements_applied', 'cancelled'].includes(record.phase))
        // Never jump an older input or silently retry a dispatch with unknown outcome.
        if (!first || !call.inputIds.has(first.id) || first.phase !== 'queued') return own
        const status = required(owner, id) && session(call.prepared.sessionId).status
        if (status === 'running' || status === 'starting') return own
        const updated = await deps.inputs.apply(first.sessionId, first.id, async () => { required(owner, id) })
        return own.map(record => record.id === updated.id ? updated : record)
      }).finally(async () => {
        call.draining = undefined
        if (!call.active) await cancelQueued(call)
      })
      call.draining = operation
      return operation
    },
    stop,
    control,
    async cancelOwner(owner: number): Promise<void> {
      const results = await Promise.allSettled([...calls.values()].filter(call => call.owner === owner).map(call => stop(owner, call.prepared.callId)))
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    }
  }
}
