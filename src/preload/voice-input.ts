import { ipcRenderer } from 'electron'
import type { VoiceInputApi } from '../shared/voice-input-types'
export const voiceInputApi: VoiceInputApi = {
  prepareVoiceInput: (contextId) => ipcRenderer.invoke('appFeatures:invoke', 'voice-input', 'prepare', contextId),
  requestVoiceMicrophonePermission: () => ipcRenderer.invoke('appFeatures:invoke', 'voice-input', 'permission'),
  transcribeVoiceInput: (input) => ipcRenderer.invoke('appFeatures:invoke', 'voice-input', 'transcribe', input),
  cancelVoiceInput: (id) => ipcRenderer.invoke('appFeatures:invoke', 'voice-input', 'cancel', id)
}
