import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SkillRecordingService } from '../skill-recording/recording'
import { captureRecordingSource, listRecordingSources } from '../skill-recording/capture'
import { saveRecordedSkill } from '../skill-recording/storage'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

const recorder = new SkillRecordingService({ sources: listRecordingSources, capture: captureRecordingSource,
  temporary: () => Boolean(process.env.CAOGEN_TEMPORARY_PROFILE_ID),
  save: (name, markdown, images) => saveRecordedSkill(process.env.CAOGEN_TEMPORARY_PROFILE_ID ? app.getPath('userData') : homedir(), join(app.getPath('userData'), 'plugin-registry-state.json'), name, markdown, images) })
const observed = new WeakSet<Electron.WebContents>()
function owner(event: IpcMainInvokeEvent): number {
  assertTrustedWorkflowLedgerSender(event)
  if (!observed.has(event.sender)) {
    observed.add(event.sender)
    const id = event.sender.id
    event.sender.once('destroyed', () => recorder.clearOwner(id))
    event.sender.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) recorder.clearOwner(id) })
  }
  return event.sender.id
}
export function registerSkillRecordingIpc(): void {
  ipcMain.handle('skillRecording:begin', (event, input: unknown) => recorder.begin(owner(event), input))
  ipcMain.handle('skillRecording:add', (event, id: unknown, input: unknown) => recorder.add(owner(event), id, input))
  ipcMain.handle('skillRecording:remove', (event, id: unknown, step: unknown) => recorder.remove(owner(event), id, step))
  ipcMain.handle('skillRecording:sources', (event, id: unknown) => recorder.sources(owner(event), id))
  ipcMain.handle('skillRecording:capture', (event, id: unknown, step: unknown, source: unknown) => recorder.capture(owner(event), id, step, source))
  ipcMain.handle('skillRecording:removeImage', (event, id: unknown, step: unknown) => recorder.remove(owner(event), id, step, true))
  ipcMain.handle('skillRecording:stop', (event, id: unknown) => recorder.stop(owner(event), id))
  ipcMain.handle('skillRecording:save', (event, id: unknown, markdown: unknown, reviewed: unknown) => recorder.save(owner(event), id, markdown, reviewed))
  ipcMain.handle('skillRecording:cancel', (event, id: unknown) => recorder.cancel(owner(event), id))
}
