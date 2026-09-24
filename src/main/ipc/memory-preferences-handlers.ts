import { ipcMain } from 'electron'
import type { SessionMeta } from '../../shared/types'
import { validateMemoryOverrides, type MemoryOverrides } from '../../shared/memory-preferences-types'
import { currentTaskMemoryPreferences } from '../memory/memory-preferences'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

export function registerMemoryPreferencesIpc(options: {
  metaForSession(sessionId: string): SessionMeta | undefined
  updateSession(sessionId: string, overrides: MemoryOverrides): Promise<void>
}): void {
  const metaFor = (id: string): SessionMeta => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('必须指定当前任务')
    const meta = options.metaForSession(id)
    if (!meta || meta.status === 'closed') throw new Error('当前任务不存在或已关闭')
    return meta
  }
  ipcMain.handle('memory:preferencesRead', (event, id: string) => {
    assertTrustedWorkflowLedgerSender(event)
    return currentTaskMemoryPreferences(metaFor(id))
  })
  ipcMain.handle('memory:preferencesUpdate', async (event, id: string, input: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    metaFor(id)
    const overrides = validateMemoryOverrides(input)
    await options.updateSession(id, overrides)
    return currentTaskMemoryPreferences(metaFor(id))
  })
}
