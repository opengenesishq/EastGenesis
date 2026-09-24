import assert from 'node:assert/strict'
import { normalizeNotificationPreferences, normalizeTerminalPreferences, shouldShowDesktopNotification } from '../src/shared/desktop-behavior-preferences'
import { normalizeVoiceInputSettings } from '../src/shared/voice-input-types'
import { selectLocalSpeechVoice } from '../src/renderer/src/components/local-speech'
let passed = 0
function check(name: string, callback: () => void): void { callback(); passed++; console.log(`PASS ${name}`) }
check('Notification master switch, categories and foreground rule are independent', () => {
  for (const kind of ['complete', 'failure', 'approval', 'update'] as const) assert.equal(shouldShowDesktopNotification(false, undefined, kind, false), false)
  assert.equal(shouldShowDesktopNotification(true, { completion: 'never' }, 'complete', false), false)
  assert.equal(shouldShowDesktopNotification(true, { completion: 'background' }, 'complete', true), false)
  assert.equal(shouldShowDesktopNotification(true, { completion: 'background' }, 'complete', false), true)
  assert.equal(shouldShowDesktopNotification(true, { completion: 'never' }, 'approval', true), true)
  assert.equal(shouldShowDesktopNotification(true, { approvals: false }, 'approval', false), false)
  assert.equal(shouldShowDesktopNotification(true, { failures: false }, 'failure', false), false)
  assert.equal(normalizeNotificationPreferences({ sound: false }).sound, false)
})
check('Malformed preference values fail before persistence; old defaults remain valid', () => {
  assert.deepEqual(normalizeTerminalPreferences(undefined), { fontSize: 12, scrollback: 5000, cursorBlink: true })
  for (const value of [{ fontSize: NaN }, { scrollback: 100001 }, { cursorBlink: 'true' }]) assert.throws(() => normalizeTerminalPreferences(value))
  assert.throws(() => normalizeNotificationPreferences({ completion: 'sometimes' }))
  assert.throws(() => normalizeVoiceInputSettings({ speechRate: Infinity }))
  assert.throws(() => normalizeVoiceInputSettings({ localVoiceUri: 'bad\nvoice' }))
})
check('Speech selects only local voices and reports a vanished preference while preserving rate', () => {
  const voices = [{ voiceURI: 'remote', lang: 'zh-CN', localService: false }, { voiceURI: 'english', lang: 'en-US', localService: true }, { voiceURI: 'chinese', lang: 'zh-CN', localService: true }] as SpeechSynthesisVoice[]
  const settings = normalizeVoiceInputSettings({ providerId: '', model: '', localVoiceUri: 'remote', speechRate: 1.3 })
  const selected = selectLocalSpeechVoice(voices, settings, 'zh')
  assert.equal(selected.voice?.voiceURI, 'chinese'); assert.equal(selected.fallback, true); assert.equal(selected.rate, 1.3)
  assert.equal(selectLocalSpeechVoice(voices, { ...settings!, localVoiceUri: 'english' }, 'zh').voice?.voiceURI, 'english')
  assert.equal(selectLocalSpeechVoice(voices.slice(0, 1), undefined, 'zh').voice, undefined)
})
console.log(JSON.stringify({ passed, modelCalls: 0, audioPlayed: false, systemNotificationsShown: false }))
