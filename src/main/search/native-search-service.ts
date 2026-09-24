import type { SessionMeta } from '../../shared/types'
import type { AssistantSearchAttempt, AssistantSearchRequest } from '../../shared/assistant-search-types'
import { AssistantSearchAuthority, type AssistantSearchSession } from './assistant-search-authority'
import { SearchBroker, createSearchEvidenceBatchSink, type SearchAdapter } from './search-broker'
import { createBrowserSearchAdapter } from './browser-search-adapter'
import { taskRuntimeRegistry } from '../task/task-runtime-registry'
import { readTaskSnapshotDatabase } from '../task/task-snapshot'
import { findWorkflowRun, findWorkflowWorkItem } from '../task/workflow-ledger-store'
import { taskExecutionAuthorityBindingDigest } from '../permission/task-execution-authority-store'

export interface NativeSearchContext {
  sessionMeta?: SessionMeta
  userDataRoot?: string
  toolUseId?: string
  signal?: AbortSignal
  /** Only NativeToolRuntime supplies this after its actual permission gate. */
  assertSearchAuthorized?: (query: string) => void
}
export interface NativeSearchDependencies {
  resolveSession(sessionId: string): Promise<AssistantSearchSession>
  ensureBrowser(sessionId: string): Promise<void>
  adapter(options: { assertAuthorized(request: AssistantSearchRequest): Promise<AssistantSearchSession> }): SearchAdapter
}

/** Uses the same durable SearchBroker attempts and canonical Evidence sink as
 * the manual search panel. No renderer/model field can mint the native permit. */
export class NativeSearchService {
  private readonly authority: AssistantSearchAuthority
  private readonly broker: SearchBroker
  private readonly guards = new Map<string, () => void>()
  constructor(private readonly rootDir: string, private readonly dependencies: NativeSearchDependencies) {
    this.authority = new AssistantSearchAuthority(dependencies.resolveSession)
    const assertAuthorized = async (request: AssistantSearchRequest) => {
      const guard = this.guards.get(request.authorizationId ?? '')
      if (!guard) throw new Error('搜索缺少原生工具权限。')
      guard()
      const resolved = await this.authority.assertAuthorized(request)
      guard(); return resolved
    }
    const adapter = dependencies.adapter({ assertAuthorized })
    this.broker = new SearchBroker({ rootDir, adapters: [{ ...adapter, search: async (request, context) => {
      const result = await adapter.search(request, context)
      // Also check the live native grant inside the canonical Evidence commit.
      return { ...result, assertCurrent: () => {
        const guard = this.guards.get(request.authorizationId ?? '')
        if (!guard) throw new Error('搜索授权已失效。')
        guard(); result.assertCurrent?.()
      } }
    } }],
      recordEvidenceBatch: createSearchEvidenceBatchSink(rootDir),
      validateScope: async request => { await assertAuthorized(request) } })
  }
  async search(input: Record<string, unknown>, context: NativeSearchContext): Promise<AssistantSearchAttempt> {
    if (Object.keys(input).some(key => key !== 'query') || typeof input.query !== 'string') throw new Error('web_search 只接受 query。')
    const { sessionMeta: meta, toolUseId, assertSearchAuthorized } = context
    if (!meta || !toolUseId || context.userDataRoot !== this.rootDir || !assertSearchAuthorized) throw new Error('web_search 缺少已审批的原生任务上下文。')
    const query = input.query.trim(), binding = taskExecutionAuthorityBindingDigest(meta), runId = taskRuntimeRegistry.get(meta.id)?.id
    const assertActive = () => {
      if (context.signal?.aborted) throw new Error('搜索已中断。')
      if (!runId || taskRuntimeRegistry.get(meta.id)?.id !== runId || taskExecutionAuthorityBindingDigest(meta) !== binding || meta.status === 'closed') throw new Error('搜索期间任务或运行身份已变化。')
      assertSearchAuthorized(query)
    }
    assertActive()
    const request = await this.authority.authorize({ sessionId: meta.id, requestId: `native:${toolUseId}`, query }, 0)
    assertActive()
    const authorizationId = request.authorizationId!
    if (this.guards.has(authorizationId)) throw new Error('此搜索已经在执行，未重复派发。')
    this.guards.set(authorizationId, assertActive)
    try {
      // This opens only the task's blank embedded view when none exists; the
      // broker performs the actual outbound query after checking the permit.
      await this.dependencies.ensureBrowser(meta.id)
      assertActive()
      return await this.broker.search(request, { signal: context.signal })
    } finally { this.guards.delete(authorizationId) }
  }
}

const services = new Map<string, NativeSearchService>()
export async function nativeWebSearch(input: Record<string, unknown>, context: NativeSearchContext): Promise<AssistantSearchAttempt> {
  if (!context.userDataRoot) throw new Error('搜索缺少任务数据目录。')
  const rootDir = context.userDataRoot
  let service = services.get(rootDir)
  if (!service) {
    const [{ sessionManager }, { browserViewManager }, { externalBrowserRegistry }, { BrowserWindow }, { desktopWindowRole }, { assertPersistedSessionDomainOwnership }] = await Promise.all([
      import('../sessionManager'), import('../browserView'), import('../external-browser-registry'), import('electron'), import('../desktop-window-registry'), import('../session-create-lifecycle')
    ])
    const resolveSession = async (sessionId: string): Promise<AssistantSearchSession> => {
      const current = () => {
        const meta = sessionManager.get(sessionId)?.meta, runId = taskRuntimeRegistry.get(sessionId)?.id
        if (!meta || !runId || meta.status === 'closed') throw new Error('搜索任务或运行不可用。')
        return { meta, runId }
      }
      const initial = current(), binding = taskExecutionAuthorityBindingDigest(initial.meta)
      await assertPersistedSessionDomainOwnership(initial.meta, rootDir)
      const canonical = await readTaskSnapshotDatabase(rootDir, db => {
        const run = findWorkflowRun(db, initial.runId), work = run && findWorkflowWorkItem(db, run.workItemId)
        const projectId = initial.meta.workspaceId ?? initial.meta.projectId
        if (!run || !work || run.sessionId !== sessionId || run.taskRun.sessionId !== sessionId || run.taskRun.id !== run.id ||
          run.projectId !== projectId || work.projectId !== projectId || work.goalId !== run.goalId ||
          (initial.meta.goalId && initial.meta.goalId !== run.goalId) || (initial.meta.workItemId && initial.meta.workItemId !== run.workItemId)) throw new Error('搜索任务与原始项目、工作项和运行记录不一致。')
        return { projectId: run.projectId, goalId: run.goalId, workItemId: run.workItemId }
      })
      const live = current()
      if (live.runId !== initial.runId || taskExecutionAuthorityBindingDigest(live.meta) !== binding) throw new Error('搜索期间任务身份已变化。')
      return { ...live, ...canonical }
    }
    service = new NativeSearchService(rootDir, { resolveSession,
      ensureBrowser: async sessionId => {
        if (externalBrowserRegistry.taskStatus(sessionId)) { externalBrowserRegistry.forTask(sessionId); return }
        if (browserViewManager.getState(sessionId)) return
        const owner = BrowserWindow.getAllWindows().find(win => desktopWindowRole(win) === 'main' && !win.isDestroyed())
        if (!owner) throw new Error('请先打开当前任务的浏览器面板。')
        await browserViewManager.open(owner, sessionId)
      },
      adapter: ({ assertAuthorized }) => createBrowserSearchAdapter({ rootDir,
        resolveSession: assertAuthorized, assertAuthorized: async request => { await assertAuthorized(request) },
        browser: {
          available: sessionId => Boolean(externalBrowserRegistry.taskStatus(sessionId) || browserViewManager.getState(sessionId)),
          searchPage: async (sessionId, query, signal) => {
            const external = externalBrowserRegistry.forTask(sessionId)
            return external ? external.searchPage(query, signal) : browserViewManager.searchPage(sessionId, query, signal)
          }
        } })
    })
    services.set(rootDir, service)
  }
  return service.search(input, context)
}
