import { ipcRenderer } from 'electron'
import type { DesktopCompanionApi, DesktopCompanionWorkbenchApi, DesktopCompanionDraftDelivery, DesktopCompanionSnapshot, DesktopCompanionNavigation } from '../shared/desktop-companion-types'
export const isDesktopCompanion = process.argv.includes('--caogen-desktop-companion')
export const desktopCompanionApi: DesktopCompanionApi = {
  prepareVoiceInput: contextId => ipcRenderer.invoke('desktop-companion:voice-prepare', contextId),
  requestVoiceMicrophonePermission: () => ipcRenderer.invoke('desktop-companion:voice-permission'),
  transcribeVoiceInput: input => ipcRenderer.invoke('desktop-companion:voice-transcribe', input),
  cancelVoiceInput: id => ipcRenderer.invoke('desktop-companion:voice-cancel', id),
  setMode: mode => ipcRenderer.invoke('desktop-companion:set-mode', mode),
  getFigure: () => ipcRenderer.invoke('desktop-companion:get-figure'),
  getState: () => ipcRenderer.invoke('desktop-companion:get-state'),
  selectTask: (id) => ipcRenderer.invoke('desktop-companion:select-task', id),
  setExpanded: (expanded) => ipcRenderer.invoke('desktop-companion:set-expanded', expanded),
  hide: () => ipcRenderer.invoke('desktop-companion:hide'),
  openTask: (id, target = 'main') => ipcRenderer.invoke('desktop-companion:open-task', id, target),
  openMain: (target = 'main') => ipcRenderer.invoke('desktop-companion:open-main', target),
  submitDraft: input => ipcRenderer.invoke('desktop-companion:submit-draft', input),
  onState: (cb) => { const listener = (_event: Electron.IpcRendererEvent, state: DesktopCompanionSnapshot) => cb(state); ipcRenderer.on('desktop-companion:state', listener); return () => ipcRenderer.removeListener('desktop-companion:state', listener) }
}
export const desktopCompanionWorkbenchApi: DesktopCompanionWorkbenchApi = {
  onNavigate: cb => { const listener = (_event: Electron.IpcRendererEvent, value: DesktopCompanionNavigation) => cb(value); ipcRenderer.on('desktop-companion:navigate', listener); return () => ipcRenderer.removeListener('desktop-companion:navigate', listener) },
  acknowledgeNavigation: id => ipcRenderer.invoke('desktop-companion:navigation-ack', id),
  readyDesktopCompanionReceiver: () => ipcRenderer.invoke('desktop-companion:receiver-ready'),
  acknowledgeDesktopCompanionDraft: (delivery: DesktopCompanionDraftDelivery) => ipcRenderer.invoke('desktop-companion:draft-ack', delivery),
  onDesktopCompanionDraft: (cb) => { const listener = (_event: Electron.IpcRendererEvent, delivery: DesktopCompanionDraftDelivery) => cb(delivery); ipcRenderer.on('desktop-companion:draft', listener); return () => ipcRenderer.removeListener('desktop-companion:draft', listener) }
}
