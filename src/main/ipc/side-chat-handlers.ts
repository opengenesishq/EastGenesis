import { ipcMain } from 'electron'
import type { SideChatAdoptInput, SideChatCreateInput, SideChatSendInput } from '../../shared/side-chat-types'
import { sideChatService } from '../side-chat/side-chat-service'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

export function registerSideChatIpc(): void {
  ipcMain.handle('side-chat:create', (event, input: SideChatCreateInput) => { assertTrustedWorkflowLedgerSender(event); return sideChatService.create(input) })
  ipcMain.handle('side-chat:list', (event, id: string) => { assertTrustedWorkflowLedgerSender(event); return sideChatService.list(id) })
  ipcMain.handle('side-chat:get', (event, id: string) => { assertTrustedWorkflowLedgerSender(event); return sideChatService.get(id) })
  ipcMain.handle('side-chat:send', (event, input: SideChatSendInput) => { assertTrustedWorkflowLedgerSender(event); return sideChatService.send(input) })
  ipcMain.handle('side-chat:interrupt', (event, id: string) => { assertTrustedWorkflowLedgerSender(event); return sideChatService.interrupt(id) })
  ipcMain.handle('side-chat:close', (event, id: string) => { assertTrustedWorkflowLedgerSender(event); return sideChatService.close(id) })
  ipcMain.handle('side-chat:adopt', (event, input: SideChatAdoptInput) => { assertTrustedWorkflowLedgerSender(event); return sideChatService.adopt(input) })
}
