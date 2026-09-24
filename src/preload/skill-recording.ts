import { ipcRenderer } from 'electron'
import type { SkillRecordingApi } from '../shared/skill-recording-types'
export const skillRecordingApi: SkillRecordingApi = {
  beginSkillRecording: input => ipcRenderer.invoke('skillRecording:begin', input),
  addSkillRecordingStep: (id, input) => ipcRenderer.invoke('skillRecording:add', id, input),
  removeSkillRecordingStep: (id, step) => ipcRenderer.invoke('skillRecording:remove', id, step),
  listSkillRecordingSources: id => ipcRenderer.invoke('skillRecording:sources', id),
  captureSkillRecordingStep: (id, step, source) => ipcRenderer.invoke('skillRecording:capture', id, step, source),
  removeSkillRecordingImage: (id, step) => ipcRenderer.invoke('skillRecording:removeImage', id, step),
  stopSkillRecording: id => ipcRenderer.invoke('skillRecording:stop', id),
  saveSkillRecording: (id, markdown, reviewed) => ipcRenderer.invoke('skillRecording:save', id, markdown, reviewed),
  cancelSkillRecording: id => ipcRenderer.invoke('skillRecording:cancel', id)
}
