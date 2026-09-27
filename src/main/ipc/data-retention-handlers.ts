import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  DataLegalHoldCreateInput,
  DataLegalHoldReleaseInput,
  DataPurgeEvaluationInput,
  DataRetentionPolicyUpdateInput
} from '../../shared/data-lifecycle-types'
import { evaluateDataPurge } from '../data-lifecycle/retention-authority'
import { DataRetentionAuthorityStore } from '../data-lifecycle/retention-authority-store'
import {
  buildDataRetentionAuthorityExport,
  serializeDataRetentionAuthorityExport
} from '../data-lifecycle/retention-authority-export'
import { writeDurableFile } from '../durable-file'
import { readDataRetentionPendingDeletions } from '../data-lifecycle/retention-pending-deletions'
import { requestDataRetentionExpirySweep } from '../data-lifecycle/retention-expiry-scheduler'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

export function registerDataRetentionIpc(): void {
  ipcMain.handle('dataRetention:get', (event) => {
    assertTrustedWorkflowLedgerSender(event)
    return store().read()
  })
  ipcMain.handle('dataRetention:updatePolicy', async (event, input: DataRetentionPolicyUpdateInput) => {
    assertTrustedWorkflowLedgerSender(event)
    const next = await store().updatePolicy(input, trustedActorId(event))
    requestDataRetentionExpirySweep()
    return next
  })
  ipcMain.handle('dataRetention:createLegalHold', (event, input: DataLegalHoldCreateInput) => {
    assertTrustedWorkflowLedgerSender(event)
    return store().createLegalHold(input, trustedActorId(event))
  })
  ipcMain.handle('dataRetention:releaseLegalHold', async (event, input: DataLegalHoldReleaseInput) => {
    assertTrustedWorkflowLedgerSender(event)
    const next = await store().releaseLegalHold(input, trustedActorId(event))
    requestDataRetentionExpirySweep()
    return next
  })
  ipcMain.handle('dataRetention:evaluatePurge', (event, input: DataPurgeEvaluationInput) => {
    assertTrustedWorkflowLedgerSender(event)
    return evaluateDataPurge(app.getPath('userData'), input)
  })
  ipcMain.handle('dataRetention:saveExport', async (event) => {
    assertTrustedWorkflowLedgerSender(event)
    return saveAuthorityExport(event)
  })
  ipcMain.handle('dataRetention:pending', (event) => {
    assertTrustedWorkflowLedgerSender(event)
    return readDataRetentionPendingDeletions(app.getPath('userData'))
  })
}

async function saveAuthorityExport(event: IpcMainInvokeEvent) {
  const exported = buildDataRetentionAuthorityExport(store().read())
  const window = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showSaveDialog(window, {
    title: '导出数据保留策略与 Legal Hold 审计',
    defaultPath: `eastgenesis-data-retention-${new Date(exported.exportedAt).toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  await writeDurableFile(result.filePath, serializeDataRetentionAuthorityExport(exported), {
    mode: 0o600,
    replace: true
  })
  return {
    canceled: false,
    filePath: result.filePath,
    exportDigest: exported.exportDigest,
    authorityRevision: exported.authorityRevision
  }
}

function store(): DataRetentionAuthorityStore {
  return new DataRetentionAuthorityStore(app.getPath('userData'))
}

function trustedActorId(event: unknown): string {
  if (!event || typeof event !== 'object' || !('sender' in event)) throw new Error('trusted actor identity is unavailable')
  const sender = (event as { sender?: { id?: unknown } }).sender
  if (!sender || !Number.isSafeInteger(sender.id) || Number(sender.id) <= 0) {
    throw new Error('trusted actor identity is unavailable')
  }
  return `local-user:webcontents-${sender.id}`
}
