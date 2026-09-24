import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { decodeCompanionImage } from '../companion-image-decoder'
import { desktopWindowRole } from '../desktop-window-registry'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { companionImages } from '../companion-image-runtime'
import { getSettings } from '../settings'
import { normalizeDesktopCompanionSettings } from '../../shared/desktop-companion-settings'

function trusted(event: IpcMainInvokeEvent): BrowserWindow {
  assertTrustedWorkflowLedgerSender(event)
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed() || desktopWindowRole(window) !== 'main') throw new Error('请从主工作台设置管理随侍形象。')
  return window
}
export function registerCompanionAppearanceIpc(): void {
  ipcMain.handle('companion-images:list', event => { trusted(event); return companionImages().list() })
  ipcMain.handle('companion-images:preview', (event, id: string) => { trusted(event); return companionImages().preview(id) })
  ipcMain.handle('companion-images:import', async event => {
    const owner = trusted(event), frame = event.senderFrame
    let navigated = false
    const navigation = (_event: Electron.Event, _url: string, inPlace: boolean, main: boolean): void => { if (main && !inPlace) navigated = true }
    event.sender.on('did-start-navigation', navigation)
    try {
      const choice = await dialog.showOpenDialog(owner, { title: '导入随侍形象', properties: ['openFile'], filters: [{ name: 'PNG / GIF', extensions: ['png','gif'] }] })
      trusted(event)
      if (navigated || event.sender.mainFrame !== frame) throw new Error('设置页面已重新载入，请重新导入。')
      if (choice.canceled || !choice.filePaths[0]) return null
      return await companionImages().import(choice.filePaths[0], async bytes => {
        const valid = await decodeCompanionImage(bytes)
        trusted(event)
        if (navigated || event.sender.mainFrame !== frame) throw new Error('设置页面已重新载入，请重新导入。')
        return valid
      })
    } finally { if (!event.sender.isDestroyed()) event.sender.removeListener('did-start-navigation', navigation) }
  })
  ipcMain.handle('companion-images:remove', (event, id: string) => {
    trusted(event)
    const settings = normalizeDesktopCompanionSettings(getSettings().desktopCompanion)
    if (settings.imageId === id) throw new Error('请先切换到其他形象，再移除这张图片。')
    companionImages().remove(id)
  })
}
