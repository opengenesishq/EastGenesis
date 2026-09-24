import { ipcRenderer } from 'electron'
import type { VoiceInputApi } from '../shared/voice-input-types'
export const voiceInputApi: VoiceInputApi = {
  prepareRealtimeVoice: (id) => ipcRenderer.invoke('appFeatures:invoke', 'voice-input', 'realtime-prepare', id),
  startRealtimeVoice: (id) => ipcRenderer.invoke('appFeatures:invoke', 'voice-input', 'realtime-start', id),
  submitRealtimeVoiceSegment: (input) => ipcRenderer.invoke('appFeatures:invoke', 'voice-input', 'realtime-segment', input),
  drainRealtimeVoice: (id) => ipcRenderer.invoke('appFeatures:invoke', 'voice-input', 'realtime-drain', id),
  stopRealtimeVoice: (id) => ipcRenderer.invoke('appFeatures:invoke', 'voice-input', 'realtime-stop', id),
  controlRealtimeVoice: (input) => ipcRenderer.invoke('appFeatures:invoke', 'voice-input', 'realtime-control', input),
  prepareVoiceInput: (contextId) => ipcRenderer.invoke('appFeatures:invoke', 'voice-input', 'prepare', contextId),
  requestVoiceMicrophonePermission: () => ipcRenderer.invoke('appFeatures:invoke', 'voice-input', 'permission'),
  transcribeVoiceInput: (input) => ipcRenderer.invoke('appFeatures:invoke', 'voice-input', 'transcribe', input),
  cancelVoiceInput: (id) => ipcRenderer.invoke('appFeatures:invoke', 'voice-input', 'cancel', id)
}
