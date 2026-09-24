import { systemPreferences, type IpcMainInvokeEvent } from 'electron'
import type { RealtimeVoiceSegmentInput, VoiceInputTranscriptionInput } from '../../shared/voice-input-types'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { voiceInputService } from '../voice-input/runtime'
import { realtimeVoiceService } from '../voice-input/realtime-runtime'

const observed = new WeakSet<Electron.WebContents>()
export function handleVoiceInputIpc(event: IpcMainInvokeEvent, action: unknown, input: unknown): unknown {
  assertTrustedWorkflowLedgerSender(event)
  const owner = event.sender.id
  if (!observed.has(event.sender)) {
    observed.add(event.sender)
    const cancel = (): void => { voiceInputService.cancelOwner(owner); void realtimeVoiceService.cancelOwner(owner).catch(() => undefined) }
    event.sender.once('destroyed', cancel)
    event.sender.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) cancel() })
  }
  if (action === 'realtime-prepare') return realtimeVoiceService.prepare(owner, typeof input === 'string' ? input : '')
  if (action === 'realtime-start') return realtimeVoiceService.start(owner, typeof input === 'string' ? input : '')
  if (action === 'realtime-segment') return realtimeVoiceService.segment(owner, input as RealtimeVoiceSegmentInput)
  if (action === 'realtime-drain') return realtimeVoiceService.drain(owner, typeof input === 'string' ? input : '')
  if (action === 'realtime-stop') return realtimeVoiceService.stop(owner, typeof input === 'string' ? input : '')
  if (action === 'realtime-control') return realtimeVoiceService.control(owner, input as { callId: string; command: 'pause' | 'cancel' })
  if (action === 'permission') return process.platform === 'darwin' ? systemPreferences.askForMediaAccess('microphone') : true
  if (action === 'prepare') return voiceInputService.prepare(owner, typeof input === 'string' ? input : '')
  if (action === 'cancel') return voiceInputService.cancel(owner, typeof input === 'string' ? input : '')
  if (action === 'transcribe') return voiceInputService.transcribe(owner, input as VoiceInputTranscriptionInput)
  throw new Error('语音输入操作无效。')
}
