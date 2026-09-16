import { app, ipcMain } from 'electron'
import type { AssistantSearchAuthorizationInput, AssistantSearchRequest } from '../../shared/assistant-search-types'
import {
  createSearchEvidenceBatchSink,
  SearchBroker, searchRequestIdempotencyKey,
  type SearchAdapterFactory,
  type SearchBrokerOptions
} from '../search/search-broker'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { getTaskSnapshot } from '../task/task-snapshot'
import { readTaskSnapshotDatabase } from '../task/task-snapshot'
import { sessionManager } from '../sessionManager'
import { sessionReadyHandler } from './session-ready-handler'
import { taskRuntimeRegistry } from '../task/task-runtime-registry'
import { findWorkflowRun, findWorkflowWorkItem } from '../task/workflow-ledger-store'
import { assertPersistedSessionDomainOwnership } from '../session-create-lifecycle'
import { taskExecutionAuthorityBindingDigest } from '../permission/task-execution-authority-store'
import { AssistantSearchAuthority, type AssistantSearchSession } from '../search/assistant-search-authority'
import { createBrowserSearchAdapter } from '../search/browser-search-adapter'

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
  const production = !options.adapterFactory
  const resolveSession = async (sessionId: string): Promise<AssistantSearchSession> => {
    const current = () => {
      const meta = sessionManager.get(sessionId)?.meta
      const runId = taskRuntimeRegistry.get(sessionId)?.id
      if (!meta || !runId || !['idle', 'error'].includes(meta.status)) {
        throw new Error('请先打开并暂停原任务，再从该任务搜索资料。')
      }
      if (!(meta.workspaceId ?? meta.projectId)) throw new Error('当前任务尚未绑定可记录来源的工作区。')
      return { meta, runId }
    }
    const initial = current(), binding = taskExecutionAuthorityBindingDigest(initial.meta)
    await assertPersistedSessionDomainOwnership(initial.meta, rootDir)
    let canonical: { projectId?: string; goalId?: string; workItemId?: string } = {}
    await readTaskSnapshotDatabase(rootDir, db => {
      const run = findWorkflowRun(db, initial.runId)
      const work = run && findWorkflowWorkItem(db, run.workItemId)
      const projectId = initial.meta.workspaceId ?? initial.meta.projectId
      if (!run || !work || run.sessionId !== sessionId || run.taskRun.sessionId !== sessionId ||
        run.taskRun.id !== run.id || run.projectId !== projectId || work.projectId !== projectId ||
        work.goalId !== run.goalId || (initial.meta.goalId && initial.meta.goalId !== run.goalId) ||
        (initial.meta.workItemId && initial.meta.workItemId !== run.workItemId)) {
        throw new Error('原任务的项目、目标、工作项或运行记录不一致，无法登记来源。')
      }
      canonical = { projectId: run.projectId, goalId: run.goalId, workItemId: run.workItemId }
    })
    const live = current()
    if (live.runId !== initial.runId || taskExecutionAuthorityBindingDigest(live.meta) !== binding) {
      throw new Error('搜索期间任务身份已变化，请重试。')
    }
    return { ...live, ...canonical }
  }
  const authority = new AssistantSearchAuthority(resolveSession)
  const browserAdapter = createBrowserSearchAdapter({ rootDir,
    resolveSession: request => authority.assertAuthorized(request),
    assertAuthorized: async request => { await authority.assertAuthorized(request) } })
  const broker = new SearchBroker({
    rootDir,
    adapters: [],
    adapterFactory: options.adapterFactory ?? (() => browserAdapter),
    ...(options.recordEvidence
      ? { recordEvidence: options.recordEvidence }
      : { recordEvidenceBatch: createSearchEvidenceBatchSink(rootDir) }),
    validateScope: options.validateScope ?? (async (request) => {
      if (production) { await authority.assertAuthorized(request); return }
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

  ipcMain.handle('assistantSearch:authorize', sessionReadyHandler((event, input: AssistantSearchAuthorizationInput) => {
    assertTrustedWorkflowLedgerSender(event)
    return authority.authorize(input, event.sender.id)
  }))
  ipcMain.handle('assistantSearch:cancel', sessionReadyHandler((event, sessionId: string, requestId: string) => {
    assertTrustedWorkflowLedgerSender(event)
    const request = authority.cancel(sessionId, requestId, event.sender.id)
    if (request) broker.cancelAttempt(searchRequestIdempotencyKey(request))
  }))
  ipcMain.handle('assistantSearch:search', sessionReadyHandler(async (event, rawRequest: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    if (production) await authority.assertAuthorized(rawRequest as AssistantSearchRequest, event.sender.id)
    return broker.search(rawRequest as AssistantSearchRequest)
  }))
  ipcMain.handle('assistantSearch:getAttempt', sessionReadyHandler(async (event, rawIdempotencyKey: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    if (typeof rawIdempotencyKey !== 'string' || !rawIdempotencyKey.trim()) {
      throw new Error('Assistant Search idempotency key is invalid')
    }
    const attempt = broker.getAttempt(rawIdempotencyKey.trim())
    if (production && attempt) {
      if (!attempt.sessionId) throw new Error('此搜索记录缺少原始任务身份。')
      const current = await resolveSession(attempt.sessionId)
      if (current.runId !== attempt.runId) throw new Error('此搜索记录属于其他运行，请查看任务来源记录。')
    }
    return attempt ?? null
  }))
}
