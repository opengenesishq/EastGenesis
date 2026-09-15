import { ipcMain } from 'electron'
import type { CouncilGetInput, CouncilPreviewInput, CouncilStartInput, CouncilStopInput } from '../../shared/council-types'
import { sessionManager } from '../sessionManager'
import { sessionReadyHandler } from './session-ready-handler'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

export function registerCouncilIpc(): void {
  ipcMain.handle('council:get', sessionReadyHandler((event, input: CouncilGetInput) => {
    assertTrustedWorkflowLedgerSender(event)
    return sessionManager.council.get(input)
  }))
  ipcMain.handle('council:preview', sessionReadyHandler((event, input: CouncilPreviewInput) => {
    assertTrustedWorkflowLedgerSender(event)
    return sessionManager.council.preview(input)
  }))
  ipcMain.handle('council:start', sessionReadyHandler((event, input: CouncilStartInput) => {
    assertTrustedWorkflowLedgerSender(event)
    return sessionManager.council.start(input)
  }))
  ipcMain.handle('council:stop', sessionReadyHandler((event, input: CouncilStopInput) => {
    assertTrustedWorkflowLedgerSender(event)
    return sessionManager.council.stop(input)
  }))
}
