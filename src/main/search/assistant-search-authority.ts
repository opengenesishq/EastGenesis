import { createHash, randomUUID } from 'node:crypto'
import type { SessionMeta } from '../../shared/types'
import type { AssistantSearchRequest } from '../../shared/assistant-search-types'
import type { AssistantSearchAuthorizationInput } from '../../shared/assistant-search-authority-types'
import { taskExecutionAuthorityBindingDigest } from '../permission/task-execution-authority-store'
import { assertWorkflowEvidenceTextSafe } from '../task/workflow-ledger-artifact-security'

export interface AssistantSearchSession { meta: SessionMeta; runId: string; projectId?: string; goalId?: string; workItemId?: string }
interface SearchConsent {
  actorId: number
  expiresAt: number
  bindingDigest: string
  requestDigest: string
  request: AssistantSearchRequest
  cancelled: boolean
}

/** A user gesture authorizes one query for one original task. Receipts never survive restart. */
export class AssistantSearchAuthority {
  private readonly receipts = new Map<string, SearchConsent>()
  constructor(private readonly resolveSession: (sessionId: string) => Promise<AssistantSearchSession>,
    private readonly now: () => number = Date.now) {}

  async authorize(raw: AssistantSearchAuthorizationInput, actorId: number): Promise<AssistantSearchRequest> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(key => !['sessionId', 'requestId', 'query'].includes(key))) throw new Error('搜索请求格式无效。')
    const sessionId = text(raw.sessionId, 200), requestId = text(raw.requestId, 200), query = text(raw.query, 512)
    // Queries can leave the computer; use the same secret filter as recorded source text.
    assertWorkflowEvidenceTextSafe(query, 'workflow evidence summary')
    const { meta, runId, projectId, goalId, workItemId } = await this.resolveSession(sessionId)
    const bindingDigest = taskExecutionAuthorityBindingDigest(meta)
    const request: AssistantSearchRequest = { sessionId, requestId, query, runId,
      projectId: projectId ?? meta.workspaceId ?? meta.projectId, goalId: goalId ?? meta.goalId, workItemId: workItemId ?? meta.workItemId, egress: 'allow' }
    const requestDigest = digestRequest(request)
    this.prune()
    for (const receipt of this.receipts.values()) {
      if (receipt.actorId !== actorId || receipt.request.sessionId !== sessionId || receipt.request.requestId !== requestId) continue
      if (receipt.cancelled || receipt.bindingDigest !== bindingDigest || receipt.requestDigest !== requestDigest) {
        throw new Error('此搜索请求已取消或任务与查询已变化，请重新提交。')
      }
      return { ...receipt.request }
    }
    if (this.receipts.size >= 256) throw new Error('待处理搜索过多，请稍后重试。')
    request.authorizationId = randomUUID()
    this.receipts.set(request.authorizationId, { actorId, expiresAt: this.now() + 5 * 60_000,
      bindingDigest, requestDigest, request: { ...request }, cancelled: false })
    return request
  }

  async assertAuthorized(request: AssistantSearchRequest, actorId?: number): Promise<AssistantSearchSession> {
    const receipt = this.receipts.get(request?.authorizationId ?? '')
    if (!receipt || receipt.cancelled || receipt.expiresAt <= this.now() ||
      (actorId !== undefined && actorId !== receipt.actorId) || receipt.requestDigest !== digestRequest(request)) {
      throw new Error('搜索未获得当前任务的单次授权，或授权已经失效。')
    }
    const current = await this.resolveSession(receipt.request.sessionId!)
    if (receipt.cancelled || receipt.expiresAt <= this.now() || current.runId !== receipt.request.runId ||
      taskExecutionAuthorityBindingDigest(current.meta) !== receipt.bindingDigest) {
      throw new Error('搜索期间任务或运行已变化，请在当前任务重新提交。')
    }
    return current
  }

  cancel(sessionId: string, requestId: string, actorId: number): AssistantSearchRequest | undefined {
    text(sessionId, 200); text(requestId, 200)
    for (const receipt of this.receipts.values()) {
      if (receipt.actorId === actorId && receipt.request.sessionId === sessionId && receipt.request.requestId === requestId) {
        receipt.cancelled = true
        return { ...receipt.request }
      }
    }
    return undefined
  }

  private prune(): void {
    for (const [id, receipt] of this.receipts) if (receipt.expiresAt <= this.now()) this.receipts.delete(id)
  }
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`搜索内容不能为空，且不能超过 ${limit} 个字符。`)
  }
  return value.trim()
}
function digestRequest(request: AssistantSearchRequest): string {
  return createHash('sha256').update(JSON.stringify([request.sessionId, request.requestId, request.query,
    request.projectId, request.goalId, request.workItemId, request.runId, request.artifactId, request.egress])).digest('hex')
}
