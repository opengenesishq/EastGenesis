import { app, ipcMain } from 'electron'
import type { AssistantSearchRequest } from '../../shared/assistant-search-types'
import {
  createSearchEvidenceBatchSink,
  SearchBroker,
  type SearchAdapterFactory,
  type SearchBrokerOptions
} from '../search/search-broker'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { getTaskSnapshot } from '../task/task-snapshot'

/** Main-owned configuration for Assistant Search. Adapters are deliberately
 * resolved through an explicit factory so renderer input can never provide a
 * credential-bearing implementation. */
export interface AssistantSearchIpcOptions {
  rootDir?: string
  adapterFactory?: SearchAdapterFactory
  recordEvidence?: SearchBrokerOptions['recordEvidence']
  /** Main-owned scope validator. Renderer input never supplies this callback. */
  validateScope?: SearchBrokerOptions['validateScope']
}

export function registerAssistantSearchIpc(options: AssistantSearchIpcOptions = {}): void {
  const rootDir = options.rootDir ?? app.getPath('userData')
  const broker = new SearchBroker({
    rootDir,
    adapters: [],
    ...(options.adapterFactory ? { adapterFactory: options.adapterFactory } : {}),
    ...(options.recordEvidence
      ? { recordEvidence: options.recordEvidence }
      : { recordEvidenceBatch: createSearchEvidenceBatchSink(rootDir) }),
    validateScope: options.validateScope ?? (async (request) => {
      if (!request.runId) return
      const snapshot = await getTaskSnapshot(request.runId, rootDir)
      const run = snapshot?.run
      if (!run || run.id !== request.runId) throw new Error('Search Run scope is unavailable')
      const projectId = snapshot?.meta.workspaceId ?? snapshot?.meta.projectId
      if (request.projectId && request.projectId !== projectId) throw new Error('Search Project scope does not match the Run')
      if (request.goalId && request.goalId !== snapshot?.meta.goalId) throw new Error('Search Goal scope does not match the Run')
      if (request.workItemId && request.workItemId !== snapshot?.meta.workItemId) throw new Error('Search WorkItem scope does not match the Run')
    })
  })

  ipcMain.handle('assistantSearch:search', (event, rawRequest: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    return broker.search(rawRequest as AssistantSearchRequest)
  })
  ipcMain.handle('assistantSearch:getAttempt', (event, rawIdempotencyKey: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    if (typeof rawIdempotencyKey !== 'string' || !rawIdempotencyKey.trim()) {
      throw new Error('Assistant Search idempotency key is invalid')
    }
    return broker.getAttempt(rawIdempotencyKey.trim()) ?? null
  })
}
