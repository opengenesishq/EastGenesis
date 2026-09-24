import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createVoiceInputService, type VoiceTarget } from '../src/main/voice-input/service'
import { readVoiceTranscription, voiceTranscriptionEndpoint } from '../src/main/voice-input/transport'
import type { VoiceInputUsageRecord } from '../src/main/voice-input/usage'
import type { VoiceInputTranscriptionInput } from '../src/shared/voice-input-types'

async function main(): Promise<void> {
  const captured: string[] = []
  let fail = false, waiting = false
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      captured.push(Buffer.concat(chunks).toString())
      if (waiting) return
      response.setHeader('content-type', 'application/json')
      response.statusCode = fail ? 429 : 200
      response.end(JSON.stringify(fail ? { error: { message: 'sensitive-error-must-not-return' } } : { text: '合成音频转写到当前草稿。' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const target: VoiceTarget = { providerId: 'fixture-voice', providerName: 'Fixture speech', model: 'fixture-transcribe',
    baseUrl: `http://127.0.0.1:${address.port}/v1`, identity: 'saved-connection-1', keyId: 'fixture-key', language: 'zh' }
  const usage: VoiceInputUsageRecord[] = []
  const budget: string[] = []
  const service = createVoiceInputService({
    target: () => ({ ...target }), saveUsage: (value) => usage.push(value),
    reserve: () => ({ sent: () => { budget.push('sent') }, finish: () => { budget.push('finish') } }),
    execute: async (saved, form, signal) => readVoiceTranscription(await fetch(voiceTranscriptionEndpoint(saved.baseUrl), { method: 'POST', body: form, signal, redirect: 'error' }))
  })
  const audio = new Uint8Array(64).buffer
  const input = (preparationId: string): VoiceInputTranscriptionInput => ({ preparationId, requestId: randomUUID(), audio, mimeType: 'audio/wav', durationMs: 1000 })
  try {
    const prepared = service.prepare(1, 'current-task')
    assert.equal(JSON.stringify(prepared).includes('fixture-key'), false)
    assert.equal('baseUrl' in prepared, false)
    const request = input(prepared.preparationId)
    const first = service.transcribe(1, request)
    assert.equal(service.transcribe(1, request), first)
    const result = await first
    assert.equal(result.contextId, 'current-task'); assert.equal(result.text, '合成音频转写到当前草稿。')
    assert.equal(result.costStatus, 'unknown'); assert.equal('costUsd' in result, false)
    assert.equal(captured.length, 1)
    assert.ok(captured[0].includes('name="model"\r\n\r\nfixture-transcribe'))
    assert.ok(captured[0].includes('name="language"\r\n\r\nzh'))
    assert.ok(captured[0].includes('name="file"; filename="voice-input.wav"'))
    assert.deepEqual(usage.map((record) => record.status), ['started', 'succeeded'])
    assert.equal(JSON.stringify(usage).includes(result.text), false)
    assert.equal(JSON.stringify(usage).includes('audio/wav'), false)
    assert.deepEqual(budget, ['sent', 'finish'])
    assert.throws(() => service.transcribe(2, input(prepared.preparationId)), /过期/)
    assert.throws(() => service.transcribe(1, { ...input(prepared.preparationId), baseUrl: 'https://untrusted.invalid' } as VoiceInputTranscriptionInput), /字段/)
    assert.throws(() => service.transcribe(1, { ...input(prepared.preparationId), durationMs: 120_001 }), /时长/)
    assert.throws(() => service.transcribe(1, { ...input(prepared.preparationId), audio: new ArrayBuffer(20 * 1024 * 1024 + 1) }), /20 MB/)
    target.identity = 'connection-replaced'
    assert.throws(() => service.transcribe(1, input(prepared.preparationId)), /变化/)
    assert.equal(captured.length, 1)

    const retry = service.prepare(1, 'current-task')
    fail = true
    await assert.rejects(service.transcribe(1, input(retry.preparationId)), (error) => error instanceof Error && /额度/.test(error.message) && !/sensitive-error/.test(error.message))
    fail = false
    assert.equal((await service.transcribe(1, input(retry.preparationId))).text, result.text)
    const cancelBefore = service.prepare(1, 'another-task')
    const pending = service.transcribe(1, input(cancelBefore.preparationId)); service.cancel(1, cancelBefore.preparationId)
    await assert.rejects(pending, /取消/)
    assert.equal(captured.length, 3)

    const cancelled = service.prepare(1, 'current-task'); waiting = true
    const inflight = service.transcribe(1, input(cancelled.preparationId))
    await new Promise((resolve) => setTimeout(resolve, 40))
    service.cancelOwner(1)
    await assert.rejects(inflight, /取消/)
    assert.equal(usage.at(-1)?.status, 'cancelled')
    assert.equal(voiceTranscriptionEndpoint('https://example.test/compatible-mode/v1'), 'https://example.test/compatible-mode/v1/audio/transcriptions')
    assert.equal(voiceTranscriptionEndpoint('https://example.test/v1/responses'), 'https://example.test/v1/audio/transcriptions')
    await assert.rejects(readVoiceTranscription(new Response(JSON.stringify({ text: '' }))), /没有识别/)
    await assert.rejects(readVoiceTranscription(new Response('x'.repeat(256 * 1024 + 1))), /过大/)
    console.log('PASS: Voice transcription via synthetic local HTTP, multipart model/language, target ownership/version, limits, deduplication, retry, cancellation, private usage and unknown-cost preservation.')
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
