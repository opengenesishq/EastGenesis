import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { CompanionVoiceController } from '../src/main/companion-voice'
import { normalizeDesktopCompanionSettings, desktopCompanionSize } from '../src/shared/desktop-companion-settings'
import type { SessionMeta } from '../src/shared/types'
import type { VoiceInputTranscriptionInput, VoiceInputTranscriptionResult } from '../src/shared/voice-input-types'

async function main(): Promise<void> {
  let current: SessionMeta | undefined = { id: 'task-a', createdAt: 1, cwd: tmpdir(), status: 'idle' } as SessionMeta
  let cancelled = 0, uploaded = 0
  let delayed: ((result: VoiceInputTranscriptionResult) => void) | undefined
  const service = {
    prepare: (_owner: number, contextId: string) => ({ contextId, preparationId: 'prep-a', providerName: 'fixture', model: 'fixture', expiresAt: Date.now() + 60000, maxBytes: 100, maxDurationMs: 100 }),
    transcribe: async (_owner: number, input: VoiceInputTranscriptionInput): Promise<VoiceInputTranscriptionResult> => { uploaded++; return new Promise(resolve => { delayed = resolve }) },
    cancel: () => { cancelled++ }, cancelOwner: () => { cancelled++ }
  }
  const controller = new CompanionVoiceController(service, owner => owner === 1 ? current : undefined)
  assert.throws(() => controller.prepare(2, 'task-a'))
  assert.throws(() => controller.prepare(1, 'task-b'))
  controller.prepare(1, 'task-a')
  assert.equal(controller.permitsMicrophone(1), false)
  assert.equal(await controller.permission(1, async () => true), true)
  assert.equal(controller.permitsMicrophone(1), true)
  console.log('PASS: microphone requires preparation, selected task, owning window and explicit permission')

  const input = { preparationId: 'prep-a', requestId: 'request', audio: new ArrayBuffer(1), mimeType: 'audio/webm', durationMs: 100 }
  const result = controller.transcribe(1, input)
  current = { ...current!, id: 'task-b' }
  delayed!({ requestId: 'request', contextId: 'task-a', text: 'original text', providerName: 'fixture', model: 'fixture', durationMs: 100, costStatus: 'unknown' })
  await assert.rejects(result, /变化/)
  assert.equal(uploaded, 1); assert.equal(controller.permitsMicrophone(1), false)
  console.log('PASS: late transcription cannot enter a different task')

  controller.prepare(1, 'task-b')
  await assert.rejects(controller.permission(1, async () => { current = undefined; return true }))
  controller.prune(); assert.equal(controller.permitsMicrophone(1), false)
  await assert.rejects(controller.transcribe(1, input)); assert.equal(uploaded, 1)
  assert(cancelled >= 3)
  console.log('PASS: hidden or closed task cancels preparation and rejects upload')

  const prefs = normalizeDesktopCompanionSettings({ mode: 'mini', enabled: true, size: 'small' })
  assert.equal(prefs.mode, 'mini'); assert.equal(desktopCompanionSize(prefs.size, false, prefs.mode).width, 280)
  assert.equal(normalizeDesktopCompanionSettings({}).mode, 'figure')
  console.log('PASS: Mini persists with compact geometry; existing configuration retains figure mode')
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
