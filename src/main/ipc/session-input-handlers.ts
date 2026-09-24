import { app, ipcMain } from 'electron'
import { getSessionInputService, scheduleSessionFollowUp } from '../task/session-input-runtime'
import type { SessionInputQueueOptions } from '../../shared/session-follow-up'
import { normalizeSendPayload } from './session-message-input'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { sessionReadyHandler } from './session-ready-handler'

export function registerSessionInputIpc(): void {
  const service = getSessionInputService(app.getPath('userData'))
  ipcMain.handle('sessionInputs:list', sessionReadyHandler(async (event, id: string) => {
    assertTrustedWorkflowLedgerSender(event)
    return service.list(id)
  }))
  ipcMain.handle('sessionInputs:queue', sessionReadyHandler(async (event, id: string, requestId: string, raw: unknown, options?: SessionInputQueueOptions) => {
    assertTrustedWorkflowLedgerSender(event)
    const payload = normalizeSendPayload(id, raw)
    if (!payload) throw new Error('补充要求不能为空')
    const input = raw as { images?: unknown[]; documents?: unknown[] }
    if ((input.images?.length ?? 0) !== (payload.images?.length ?? 0) ||
        (input.documents?.length ?? 0) !== (payload.documents?.length ?? 0)) throw new Error('补充资料不属于当前会话')
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) ||
        Object.keys(options).some(key => key !== 'followUpBehavior') ||
        (options.followUpBehavior !== undefined && !['queue', 'pause_and_apply', 'manual'].includes(options.followUpBehavior)))) throw new Error('追问行为无效')
    const record = await service.queue(id, requestId, payload, options)
    if (record.followUp) scheduleSessionFollowUp(app.getPath('userData'), id)
    return record
  }))
  ipcMain.handle('sessionInputs:apply', sessionReadyHandler((event, id: string, requestId: string) => {
    assertTrustedWorkflowLedgerSender(event)
    return service.apply(id, requestId)
  }))
  ipcMain.handle('sessionInputs:cancel', sessionReadyHandler((event, id: string, requestId: string) => {
    assertTrustedWorkflowLedgerSender(event)
    return service.cancel(id, requestId)
  }))
}
