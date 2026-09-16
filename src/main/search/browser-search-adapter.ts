import type { SessionMeta } from '../../shared/types'
import { browserViewManager } from '../browserView'
import { readTaskSnapshotDatabase } from '../task/task-snapshot'
import { findWorkflowRun, findWorkflowWorkItem } from '../task/workflow-ledger-store'
import { taskRuntimeRegistry } from '../task/task-runtime-registry'
import { SearchOperationError, type SearchAdapter, type SearchRequest } from './search-broker'

export interface BrowserSearchAdapterOptions {
  rootDir: string
  /** Main-owned live Session lookup, never a renderer-provided object. */
  resolveSession(request: SearchRequest): { meta: SessionMeta; runId: string } | Promise<{ meta: SessionMeta; runId: string }>
  /** Checks the explicit one-query receipt and current outbound-data permission. */
  assertAuthorized(request: SearchRequest): void | Promise<void>
}

export function createBrowserSearchAdapter(options: BrowserSearchAdapterOptions): SearchAdapter {
  return {
    id: 'browser-fallback-bing-v1', kind: 'browser_fallback',
    available(request) {
      if (request.egress !== 'allow' || !request.authorizationId) return { ok: false, reason: 'egress_denied' }
      if (!request.sessionId || !request.runId || !request.projectId) return { ok: false, reason: 'scope_denied' }
      if (!browserViewManager.getState(request.sessionId)) return { ok: false, reason: 'browser_unavailable' }
      return { ok: true }
    },
    async search(request, execution) {
      if (request.egress !== 'allow' || !request.authorizationId) throw new SearchOperationError('egress_denied', 'Explicit query authorization is required')
      const signal = execution?.signal ?? new AbortController().signal
      const assertActive = () => { if (signal.aborted) throw new SearchOperationError('cancelled', 'Search cancelled') }
      assertActive()
      await options.assertAuthorized(request)
      const origin = await options.resolveSession(request)
      const frozen = freezeScope(origin.meta, origin.runId)
      assertRequestScope(request, frozen)
      const assertCurrent = () => {
        assertActive()
        if (freezeScope(origin.meta, origin.runId) !== frozen) throw new SearchOperationError('scope_denied', 'Search Session changed')
        const active = taskRuntimeRegistry.get(origin.meta.id)
        if (active && active.id !== origin.runId) throw new SearchOperationError('scope_denied', 'Search Run changed')
      }
      await readTaskSnapshotDatabase(options.rootDir, db => {
        const run = findWorkflowRun(db, origin.runId)
        const work = run && findWorkflowWorkItem(db, run.workItemId)
        if (!run || !work || run.sessionId !== request.sessionId || run.projectId !== request.projectId ||
          (request.goalId && run.goalId !== request.goalId) || (request.workItemId && run.workItemId !== request.workItemId) ||
          (origin.meta.goalId && run.goalId !== origin.meta.goalId) || (origin.meta.workItemId && run.workItemId !== origin.meta.workItemId) ||
          work.projectId !== run.projectId || work.goalId !== run.goalId) {
          throw new SearchOperationError('scope_denied', 'Search lacks its original canonical Run')
        }
      })
      assertCurrent()
      await options.assertAuthorized(request)
      assertCurrent()
      const result = await browserViewManager.searchPage(origin.meta.id, request.query, signal)
      assertCurrent()
      await options.assertAuthorized(request)
      const current = await options.resolveSession(request)
      if (freezeScope(current.meta, current.runId) !== frozen) throw new SearchOperationError('scope_denied', 'Search Session changed during query')
      assertCurrent()
      return { ...result, assertCurrent }
    }
  }
}

function freezeScope(meta: SessionMeta, runId: string): string {
  return JSON.stringify([meta.id, meta.workspaceId ?? meta.projectId, meta.goalId, meta.workItemId, meta.cwd, runId])
}
function assertRequestScope(request: SearchRequest, frozen: string): void {
  const [sessionId, projectId, goalId, workItemId, , runId] = JSON.parse(frozen)
  if (!sessionId || !projectId || !runId || sessionId !== request.sessionId || projectId !== request.projectId ||
    (goalId && request.goalId && goalId !== request.goalId) || (workItemId && request.workItemId && workItemId !== request.workItemId) || runId !== request.runId) {
    throw new SearchOperationError('scope_denied', 'Search request does not match its current Session')
  }
}
