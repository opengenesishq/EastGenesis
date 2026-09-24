import { ipcMain } from 'electron'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { inspectWslSync } from '../wsl/discovery'
import { createWslBinding } from '../wsl/binding'
import { normalizeWslDistributionName } from '../../shared/wsl-types'
export function registerWslIpc(): void {
  ipcMain.handle('wsl:inspect', event => { assertTrustedWorkflowLedgerSender(event); return inspectWslSync() })
  ipcMain.handle('wsl:validate-directory', (event, input: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('WSL 目录参数无效。')
    const value = input as Record<string, unknown>
    if (Object.keys(value).some(key => !['distribution', 'cwd'].includes(key)) || !normalizeWslDistributionName(value.distribution) ||
      typeof value.cwd !== 'string' || value.cwd.length > 4096) throw new Error('WSL 目录参数无效。')
    return createWslBinding(value.distribution as string, value.cwd)
  })
}
