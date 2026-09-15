import { createHash } from 'node:crypto'
import type { SessionMeta } from '../../shared/types'
import type { WorkflowRunRecord } from '../../shared/workflow-types'
import { BROWSER_PAGE_TEXT_LIMIT, requireSourceUrl, type BrowserPageSource } from '../browser/browser-page-source'
import { taskRuntimeRegistry } from './task-runtime-registry'
import { readTaskSnapshotDatabase, mutateTaskSnapshotDatabase } from './task-snapshot'
import { findWorkflowRun, findWorkflowWorkItem } from './workflow-ledger-store'
import { recordWorkflowEvidence } from './workflow-ledger-api'
import { listWorkflowEvidence } from './workflow-evidence-store'
import { assertWorkflowEvidenceTextSafe } from './workflow-ledger-artifact-security'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'

export interface BrowserResearchContext {
  sessionMeta?: SessionMeta
  userDataRoot?: string
  toolUseId?: string
  signal?: AbortSignal
}

/** The caller has passed native tool permission checks; identity never comes from tool args. */
export async function readSessionBrowserResearchSource(context: BrowserResearchContext, readPage: () => Promise<BrowserPageSource>) {
  const meta = context.sessionMeta
  const projectId = meta?.workspaceId ?? meta?.projectId
  const runId = meta && taskRuntimeRegistry.get(meta.id)?.id
  if (!meta || !context.userDataRoot || !context.toolUseId || !projectId || !runId) {
    throw new Error('BROWSER_SOURCE_SCOPE：来源读取需要当前任务的项目与运行身份。')
  }
  const scope = { sessionId: meta.id, projectId, runId, goalId: meta.goalId, workItemId: meta.workItemId }
  const originalCwd = meta.cwd
  const assertUnchanged = () => {
    assertActive(context)
    if (meta !== context.sessionMeta || meta.id !== scope.sessionId || (meta.workspaceId ?? meta.projectId) !== scope.projectId ||
      meta.goalId !== scope.goalId || meta.workItemId !== scope.workItemId || meta.cwd !== originalCwd ||
      taskRuntimeRegistry.get(scope.sessionId)?.id !== scope.runId) throw new Error('BROWSER_SOURCE_SCOPE：读取期间当前任务或运行已切换。')
  }
  const toolUseId = context.toolUseId
  assertUnchanged()
  const original = await readTaskSnapshotDatabase(context.userDataRoot, db => requireRun(db, scope))
  assertUnchanged()
  const page = await readPage()
  assertUnchanged()
  requireSourceUrl(page.url)
  if (!page.text.trim() || page.text.length > BROWSER_PAGE_TEXT_LIMIT || typeof page.truncated !== 'boolean' || !Number.isSafeInteger(page.observedAt) || page.observedAt < 0) {
    throw new Error('BROWSER_SOURCE_INVALID：来源正文或采集时间无效。')
  }
  assertWorkflowEvidenceTextSafe(page.text, 'workflow evidence summary')
  assertWorkflowEvidenceTextSafe(page.title, 'workflow evidence title')
  const contentDigest = sha256(page.text)
  const evidenceId = `browser-source:${sha256(JSON.stringify([scope.projectId, scope.runId, toolUseId]))}`
  const record = await mutateTaskSnapshotDatabase(context.userDataRoot, db => {
    assertUnchanged()
    const run = requireRun(db, scope)
    if (run.workItemId !== original.workItemId || run.goalId !== original.goalId) throw new Error('BROWSER_SOURCE_SCOPE：原运行的归属已变化。')
    const existing = listWorkflowEvidence(db, { evidenceId })[0]
    return recordWorkflowEvidence(db, {
      evidenceId, projectId: scope.projectId, goalId: run.goalId, workItemId: run.workItemId, runId: run.id,
      kind: 'research_source', title: `网页来源：${page.title}`,
      summary: `${page.truncated ? '已读取部分正文（达到采集上限）。' : '已读取当前主框架可见正文。'}${page.filtered ? '敏感内容已隐藏。' : ''}\n${page.text.slice(0, 1000)}`,
      uri: page.url, mediaType: 'text/plain', contentDigest,
      metadata: { producer: 'browser_read', toolUseId, sourceScope: 'main_frame',
        contentTransform: 'visible-text-secret-filter-v1', textLimit: BROWSER_PAGE_TEXT_LIMIT,
        capturedCharacters: page.text.length, truncated: page.truncated, filtered: page.filtered }
    }, { source: 'runtime', verifier: 'browser-page-reader', observedAt: existing?.observedAt ?? page.observedAt })
  })
  return { ...page, observedAt: record.observedAt, evidenceId, contentDigest }
}

function requireRun(db: WorkflowLedgerDatabase, scope: { sessionId: string; projectId: string; runId: string; goalId?: string; workItemId?: string }): WorkflowRunRecord {
  const run = findWorkflowRun(db, scope.runId)
  const work = run && findWorkflowWorkItem(db, run.workItemId)
  if (!run || !work || run.sessionId !== scope.sessionId || run.projectId !== scope.projectId ||
    run.taskRun.id !== run.id || run.taskRun.sessionId !== scope.sessionId || work.projectId !== scope.projectId ||
    work.goalId !== run.goalId || (scope.goalId && run.goalId !== scope.goalId) || (scope.workItemId && run.workItemId !== scope.workItemId)) {
    throw new Error('BROWSER_SOURCE_SCOPE：当前会话与原始 Run / WorkItem / Goal 不匹配。')
  }
  return run
}
function assertActive(context: BrowserResearchContext) {
  if (context.signal?.aborted) throw new Error('BROWSER_SOURCE_CANCELLED：页面读取已中断，未登记来源。')
}
function sha256(value: string) { return createHash('sha256').update(value, 'utf8').digest('hex') }
