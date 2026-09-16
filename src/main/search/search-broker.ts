import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableFileSync } from '../durable-file'
import { assertWorkflowArtifactUriSafe, assertWorkflowEvidenceTextSafe } from '../task/workflow-ledger-artifact-security'
import { findWorkflowRun } from '../task/workflow-ledger-store'
import type {
  AssistantSearchAdapterKind,
  AssistantSearchAttempt,
  AssistantSearchAttemptStatus,
  AssistantSearchCitation,
  AssistantSearchFailureCode,
  AssistantSearchRequest
} from '../../shared/assistant-search-types'

export type SearchAdapterKind = AssistantSearchAdapterKind
export type SearchAttemptStatus = AssistantSearchAttemptStatus
export type SearchFailureCode = AssistantSearchFailureCode
export type SearchRequest = AssistantSearchRequest
export type SearchCitation = AssistantSearchCitation

export interface SearchAdapterResult {
  citations: Array<Omit<SearchCitation, 'evidenceId' | 'artifactId'>>
  routeReason?: string
  /** Main-owned synchronous guard, checked again inside the Evidence transaction. */
  assertCurrent?: () => void
}

export interface SearchAdapter {
  id: string
  kind: SearchAdapterKind
  available(request: SearchRequest): { ok: true } | { ok: false; reason: SearchFailureCode | string }
  search(request: SearchRequest, context?: { signal: AbortSignal }): Promise<SearchAdapterResult>
}

export type SearchAttempt = AssistantSearchAttempt

export type SearchAdapterFactory = (
  request: SearchRequest
) => SearchAdapter | SearchAdapter[] | undefined | Promise<SearchAdapter | SearchAdapter[] | undefined>

export interface SearchBrokerOptions {
  rootDir: string
  adapters: SearchAdapter[]
  /** Maximum time an adapter may run before the attempt is failed closed. */
  adapterTimeoutMs?: number
  /** Optional main-owned factory for resolving configured native/BYOK adapters per request. */
  adapterFactory?: SearchAdapterFactory
  /** Main-owned canonical scope check; renderer claims are never trusted. */
  validateScope?: (request: SearchRequest) => Promise<void> | void
  now?: () => number
  /** Main-process Evidence sink. It may reject a citation; the attempt then fails closed. */
  recordEvidence?: (input: SearchEvidenceInput, context?: SearchEvidenceContext) => Promise<void>
  /**
   * Main-process batch Evidence sink. Search results are verified in memory
   * first and handed to this sink as one batch so a multi-citation result
   * cannot leave a partially published Evidence set behind. When omitted the
   * broker falls back to the legacy per-citation sink above.
   */
  recordEvidenceBatch?: (inputs: readonly SearchEvidenceInput[], context?: SearchEvidenceContext) => Promise<void>
}

export interface SearchEvidenceContext { signal?: AbortSignal; assertCurrent?: () => void }

export interface SearchEvidenceInput {
  evidenceId: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  artifactId?: string
  url: string
  fetchedAt: number
  summary: string
  contentDigest: string
  queryDigest: string
  sessionId?: string
  contentKind?: 'search_snippet'
  sourcePageUrl?: string
}

/**
 * Main-process sink for the canonical Evidence ledger. Projectless Assistant
 * searches are attributed to the hidden managed personal Workspace, so the
 * user can start searching before creating a visible Project.
 */
export function createSearchEvidenceSink(rootDir: string): NonNullable<SearchBrokerOptions['recordEvidence']> {
  const batchSink = createSearchEvidenceBatchSink(rootDir)
  return async (input, context) => batchSink([input], context)
}

/**
 * Default main-process sink for Search Broker results. All citations for one
 * adapter response are appended inside the shared Workflow Ledger mutation
 * transaction, so a failed citation cannot leave a partially committed set.
 */
export function createSearchEvidenceBatchSink(rootDir: string): NonNullable<SearchBrokerOptions['recordEvidenceBatch']> {
  return async (inputs, context) => {
    if (inputs.length === 0) return
    const [{ recordWorkflowEvidence }, { mutateTaskSnapshotDatabase }, { ensureManagedPersonalWorkspace, MANAGED_PERSONAL_WORKSPACE_ID }] = await Promise.all([
      import('../task/workflow-ledger-api.js'),
      import('../task/task-snapshot.js'),
      import('../project-workspace/managed-personal-workspace.js')
    ])
    await ensureManagedPersonalWorkspace(rootDir)
    await mutateTaskSnapshotDatabase(rootDir, (db) => {
      assertSearchActive(context?.signal)
      context?.assertCurrent?.()
      for (const input of inputs) {
        const projectId = input.projectId ?? MANAGED_PERSONAL_WORKSPACE_ID
        let goalId = input.goalId, workItemId = input.workItemId
        if (input.sessionId) {
          const run = input.runId && findWorkflowRun(db, input.runId)
          if (!run || run.sessionId !== input.sessionId || run.projectId !== projectId ||
            (input.goalId && run.goalId !== input.goalId) || (input.workItemId && run.workItemId !== input.workItemId)) {
            throw new SearchOperationError('scope_denied', 'Search source does not belong to the original Session and Run')
          }
          goalId = run.goalId; workItemId = run.workItemId
        }
        recordWorkflowEvidence(db, {
          evidenceId: input.evidenceId,
          projectId,
          ...(goalId ? { goalId } : {}),
          ...(workItemId ? { workItemId } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
          ...(input.artifactId ? { artifactId: input.artifactId } : {}),
          kind: 'research_source',
          title: `Search source: ${input.url}`,
          summary: input.summary,
          uri: input.url,
          mediaType: 'text/plain',
          // Workflow Ledger stores the canonical digest as bare lowercase
          // SHA-256; SearchCitation keeps the public `sha256:` label.
          contentDigest: input.contentDigest.slice(7),
          metadata: {
            queryDigest: input.queryDigest,
            fetchedAt: input.fetchedAt,
            broker: FORMAT,
            ...(input.contentKind ? { contentKind: input.contentKind } : {}),
            ...(input.sourcePageUrl ? { sourcePageUrl: input.sourcePageUrl } : {})
          }
        }, { source: 'runtime', verifier: 'search-broker', observedAt: input.fetchedAt })
      }
    })
  }
}

const FORMAT = 'caogen.search-broker.v1'
const MAX_QUERY_CHARS = 512
const MAX_SUMMARY_CHARS = 1_024

/**
 * CaoGen-owned search contract. Adapters only provide bounded citations; routing,
 * idempotency, durable attempt state and Evidence identity remain in CaoGen.
 */
export class SearchBroker {
  private readonly attemptsPath: string
  private readonly now: () => number
  private readonly adapters: SearchAdapter[]
  private readonly adapterTimeoutMs: number
  private readonly adapterFactory?: SearchAdapterFactory
  private readonly recordEvidence?: SearchBrokerOptions['recordEvidence']
  private readonly recordEvidenceBatch?: SearchBrokerOptions['recordEvidenceBatch']
  private readonly validateScope?: SearchBrokerOptions['validateScope']
  private readonly inFlight = new Map<string, Promise<SearchAttempt>>()
  private readonly controllers = new Map<string, AbortController>()

  constructor(options: SearchBrokerOptions) {
    if (!options.rootDir.trim()) throw new Error('Search Broker rootDir is required')
    this.attemptsPath = join(options.rootDir, 'search-broker', 'attempts.json')
    this.now = options.now ?? Date.now
    this.adapters = options.adapters.slice()
    this.adapterTimeoutMs = normalizeAdapterTimeout(options.adapterTimeoutMs)
    this.adapterFactory = options.adapterFactory
    this.recordEvidence = options.recordEvidence
    this.recordEvidenceBatch = options.recordEvidenceBatch
    this.validateScope = options.validateScope
  }

  async search(request: SearchRequest, options: { signal?: AbortSignal } = {}): Promise<SearchAttempt> {
    const normalized = normalizeRequest(request)
    const key = idempotencyKey(normalized)
    const existing = this.readAttempts().find((attempt) => attempt.idempotencyKey === key)
    if (existing && existing.status !== 'running') return existing
    const active = this.inFlight.get(key)
    if (active) return active
    // A running receipt with no in-process owner means the previous process
    // stopped after durable reservation. Do not replay an external request;
    // preserve an explicit unknown outcome for reconciliation.
    if (existing?.status === 'running') {
      return this.finish(existing, {
        status: 'failed',
        failureCode: 'unknown',
        failureMessage: 'Previous Search attempt was interrupted; adapter was not replayed'
      })
    }
    const controller = new AbortController()
    const abort = () => controller.abort(new SearchOperationError('cancelled', 'Search cancelled; the query will not be replayed'))
    if (options.signal?.aborted) abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    this.controllers.set(key, controller)
    const pending = this.run(normalized, key, controller)
    this.inFlight.set(key, pending)
    try { return await pending } finally {
      this.inFlight.delete(key); this.controllers.delete(key)
      options.signal?.removeEventListener('abort', abort)
    }
  }

  cancelAttempt(idempotency: string): boolean {
    const controller = this.controllers.get(idempotency)
    if (!controller) return false
    controller.abort(new SearchOperationError('cancelled', 'Search cancelled; the query will not be replayed'))
    return true
  }

  private async run(normalized: SearchRequest, key: string, controller: AbortController): Promise<SearchAttempt> {

    const startedAt = this.now()
    const running: SearchAttempt = {
      schemaVersion: 1,
      attemptId: `search:${key}`,
      idempotencyKey: key,
      requestId: normalized.requestId,
      ...(normalized.sessionId ? { sessionId: normalized.sessionId } : {}),
      queryDigest: digest(normalized.query),
      ...(normalized.projectId ? { projectId: normalized.projectId } : {}),
      ...(normalized.goalId ? { goalId: normalized.goalId } : {}),
      ...(normalized.workItemId ? { workItemId: normalized.workItemId } : {}),
      ...(normalized.runId ? { runId: normalized.runId } : {}),
      ...(normalized.artifactId ? { artifactId: normalized.artifactId } : {}),
      status: 'running', citations: [], evidenceIds: [], startedAt
    }
    this.upsert(running)

    if (controller.signal.aborted) return this.finish(running, { status: 'failed', failureCode: 'cancelled', failureMessage: 'Search cancelled before dispatch' })
    if (normalized.egress === 'deny') return this.finish(running, { status: 'failed', failureCode: 'egress_denied', failureMessage: 'Search egress denied by policy' })
    if (this.validateScope) {
      try { await this.validateScope(normalized) } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return this.finish(running, { status: 'failed', failureCode: 'scope_denied', failureMessage: message.slice(0, 512) })
      }
    }
    let adapters = this.adapters
    if (this.adapterFactory) {
      try {
        const configured = await this.adapterFactory(normalized)
        adapters = configured === undefined ? [] : Array.isArray(configured) ? configured : [configured]
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return this.finish(running, { status: 'failed', failureCode: 'provider_failed', failureMessage: message.slice(0, 512) })
      }
    }
    let selected: SearchAdapter | undefined
    let unavailableReason: SearchFailureCode | undefined
    try {
      for (const adapter of adapters) {
        if (!isSearchAdapter(adapter)) continue
        const availability = adapter.available(normalized)
        if (availability.ok) { selected = adapter; break }
        if (['egress_denied', 'scope_denied', 'browser_unavailable', 'no_credentials'].includes(availability.reason)) unavailableReason = availability.reason as SearchFailureCode
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.finish(running, { status: 'failed', failureCode: 'provider_failed', failureMessage: message.slice(0, 512) })
    }
    if (!selected) return this.finish(running, { status: 'failed', failureCode: unavailableReason ?? this.inferNoAdapterFailure(normalized), failureMessage: 'No eligible Search Adapter is available' })

    running.adapterId = selected.id
    running.adapterKind = selected.kind
    running.routeReason = `selected:${selected.kind}:${selected.id}`
    this.upsert(running)
    try {
      assertSearchActive(controller.signal)
      const result = await withTimeout(selected.search(normalized, { signal: controller.signal }), this.adapterTimeoutMs, controller)
      assertSearchActive(controller.signal)
      await this.validateScope?.(normalized)
      assertSearchActive(controller.signal)
      result.assertCurrent?.()
      if (!Array.isArray(result.citations)) throw new Error('Search Adapter returned invalid citations')
      if (result.citations.length === 0) return this.finish(running, { status: 'failed', failureCode: 'no_results', failureMessage: 'Search returned no results' })
      if (!this.recordEvidence && !this.recordEvidenceBatch) return this.finish(running, { status: 'failed', failureCode: 'invalid_result', failureMessage: 'Search Evidence sink is unavailable' })
      const citations: SearchCitation[] = []
      const evidenceInputs: SearchEvidenceInput[] = []
      for (const [index, citation] of result.citations.slice(0, 20).entries()) {
        const normalizedCitation = normalizeCitation(citation)
        const evidenceId = `search-evidence:${key}:${index}:${normalizedCitation.contentDigest.slice(7, 23)}`
        evidenceInputs.push({ evidenceId, ...(normalized.projectId ? { projectId: normalized.projectId } : {}), ...(normalized.goalId ? { goalId: normalized.goalId } : {}), ...(normalized.workItemId ? { workItemId: normalized.workItemId } : {}), ...(normalized.runId ? { runId: normalized.runId } : {}), ...(normalized.artifactId ? { artifactId: normalized.artifactId } : {}), ...(normalized.sessionId ? { sessionId: normalized.sessionId } : {}), url: normalizedCitation.url, fetchedAt: normalizedCitation.fetchedAt, summary: normalizedCitation.summary, contentDigest: normalizedCitation.contentDigest, queryDigest: running.queryDigest,
          ...(normalizedCitation.contentKind ? { contentKind: normalizedCitation.contentKind } : {}), ...(normalizedCitation.sourcePageUrl ? { sourcePageUrl: normalizedCitation.sourcePageUrl } : {}) })
        citations.push({ ...normalizedCitation, evidenceId, ...(normalized.artifactId ? { artifactId: normalized.artifactId } : {}) })
      }
      const evidenceContext = { signal: controller.signal, assertCurrent: result.assertCurrent }
      if (this.recordEvidenceBatch) await this.recordEvidenceBatch(evidenceInputs, evidenceContext)
      else for (const input of evidenceInputs) { assertSearchActive(controller.signal); result.assertCurrent?.(); await this.recordEvidence!(input, evidenceContext) }
      return this.finish(running, { status: 'succeeded', citations, evidenceIds: citations.map((citation) => citation.evidenceId), ...(result.routeReason ? { routeReason: result.routeReason } : {}) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const aborted = controller.signal.aborted ? controller.signal.reason : undefined
      const failureCode: SearchFailureCode = aborted instanceof SearchOperationError ? aborted.code : error instanceof SearchOperationError ? error.code : /timeout|timed out/i.test(message) ? 'timeout' : 'provider_failed'
      // Browser/network errors can embed query text. Persist a bounded category,
      // never raw remote URLs or pages in the attempt receipt.
      return this.finish(running, { status: 'failed', failureCode, failureMessage: `Search failed (${failureCode}); this request will not be replayed.` })
    }
  }

  getAttempt(idempotency: string): SearchAttempt | undefined {
    return this.readAttempts().find((attempt) => attempt.idempotencyKey === idempotency)
  }

  readAttempts(): SearchAttempt[] {
    try {
      const value = JSON.parse(readFileSync(this.attemptsPath, 'utf8')) as { format?: unknown; attempts?: unknown }
      if (value.format !== FORMAT || !Array.isArray(value.attempts) || !value.attempts.every(isAttempt)) throw new Error('Search attempt history is invalid; queries cannot be replayed safely')
      return value.attempts
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('Search attempt history is unavailable; queries cannot be replayed safely')
    }
  }

  private finish(base: SearchAttempt, patch: Partial<SearchAttempt>): SearchAttempt {
    const result = { ...base, ...patch, completedAt: this.now() } as SearchAttempt
    this.upsert(result)
    return result
  }

  private inferNoAdapterFailure(request: SearchRequest): SearchFailureCode {
    return request.egress === 'deny' ? 'egress_denied' : 'no_credentials'
  }

  private upsert(attempt: SearchAttempt): void {
    const attempts = this.readAttempts().filter((candidate) => candidate.idempotencyKey !== attempt.idempotencyKey)
    attempts.push(attempt)
    writeDurableFileSync(this.attemptsPath, JSON.stringify({ format: FORMAT, attempts }, null, 2) + '\n', { mode: 0o600 })
  }
}

function normalizeRequest(request: SearchRequest): SearchRequest {
  if (!request || typeof request !== 'object') throw new Error('Search request is required')
  const requestId = text(request.requestId, 'requestId')
  const query = text(request.query, 'query')
  if (query.length > MAX_QUERY_CHARS) throw new Error('Search query exceeds 512 characters')
  if (request.egress !== undefined && request.egress !== 'allow' && request.egress !== 'deny') throw new Error('Search egress policy is invalid')
  return { requestId, query, ...(request.sessionId ? { sessionId: text(request.sessionId, 'sessionId') } : {}), ...(request.authorizationId ? { authorizationId: text(request.authorizationId, 'authorizationId') } : {}), ...(request.projectId ? { projectId: text(request.projectId, 'projectId') } : {}), ...(request.goalId ? { goalId: text(request.goalId, 'goalId') } : {}), ...(request.workItemId ? { workItemId: text(request.workItemId, 'workItemId') } : {}), ...(request.runId ? { runId: text(request.runId, 'runId') } : {}), ...(request.artifactId ? { artifactId: text(request.artifactId, 'artifactId') } : {}), ...(request.egress ? { egress: request.egress } : {}) }
}

function normalizeCitation(citation: Omit<SearchCitation, 'evidenceId' | 'artifactId'>): Omit<SearchCitation, 'evidenceId' | 'artifactId'> {
  const url = text(citation.url, 'citation url')
  if (!/^https?:\/\//i.test(url) && !/^synthetic:\/\//i.test(url)) throw new Error('Search citation URL is invalid')
  if (/^https?:\/\//i.test(url)) {
    const parsed = new URL(url)
    if (parsed.username || parsed.password || parsed.port && parsed.port !== '443') throw new Error('Search citation URL contains forbidden credentials or port')
    if (parsed.protocol !== 'https:' || parsed.port && parsed.port !== '443') throw new Error('Search citation URL must use public HTTPS')
    if (/^(localhost|127\.|0\.0\.0\.0|::1|\[::1\])$/i.test(parsed.hostname)) throw new Error('Search citation URL points to a private host')
  }
  const summary = text(citation.summary, 'citation summary').slice(0, MAX_SUMMARY_CHARS)
  assertWorkflowArtifactUriSafe(url)
  assertWorkflowEvidenceTextSafe(summary, 'workflow evidence summary')
  if (typeof citation.contentDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(citation.contentDigest)) throw new Error('Search citation contentDigest must be a SHA-256 digest')
  const contentDigest = citation.contentDigest
  if (!Number.isFinite(citation.fetchedAt) || citation.fetchedAt <= 0) throw new Error('Search citation fetchedAt is invalid')
  if (citation.contentKind !== undefined && citation.contentKind !== 'search_snippet') throw new Error('Search citation content kind is invalid')
  if (citation.sourcePageUrl !== undefined) {
    const sourcePage = new URL(citation.sourcePageUrl)
    if (sourcePage.protocol !== 'https:' || sourcePage.search || sourcePage.hash) throw new Error('Search source page endpoint is invalid')
    assertWorkflowArtifactUriSafe(citation.sourcePageUrl)
  }
  return { url, fetchedAt: Math.floor(citation.fetchedAt), summary, contentDigest,
    ...(citation.contentKind ? { contentKind: citation.contentKind } : {}), ...(citation.sourcePageUrl ? { sourcePageUrl: citation.sourcePageUrl } : {}) }
}

function idempotencyKey(request: SearchRequest): string {
  const components = [request.requestId, request.query, request.projectId ?? '', request.goalId ?? '', request.workItemId ?? '', request.runId ?? '', request.artifactId ?? '']
  if (request.sessionId) components.push(request.sessionId)
  return digest(components.join('\0')).slice(7)
}

export function searchRequestIdempotencyKey(request: SearchRequest): string { return idempotencyKey(normalizeRequest(request)) }

export class SearchOperationError extends Error {
  constructor(readonly code: SearchFailureCode, message: string) { super(message); this.name = 'SearchOperationError' }
}
function assertSearchActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof SearchOperationError ? signal.reason : new SearchOperationError('cancelled', 'Search cancelled')
}

function digest(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}` }
function normalizeAdapterTimeout(value: number | undefined): number {
  if (value === undefined) return 30_000
  if (!Number.isFinite(value) || value < 1 || value > 300_000) throw new Error('Search adapter timeout must be between 1 and 300000 milliseconds')
  return Math.floor(value)
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        abort = () => reject(controller.signal.reason ?? new SearchOperationError('cancelled', 'Search cancelled'))
        controller.signal.addEventListener('abort', abort, { once: true })
        if (controller.signal.aborted) abort()
        timer = setTimeout(() => controller.abort(new SearchOperationError('timeout', 'Search timed out; the query will not be replayed')), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) controller.signal.removeEventListener('abort', abort)
  }
}
function text(value: unknown, label: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`); return value.trim() }
function isAttempt(value: unknown): value is SearchAttempt { return Boolean(value && typeof value === 'object' && (value as SearchAttempt).schemaVersion === 1 && typeof (value as SearchAttempt).idempotencyKey === 'string' && ['running', 'succeeded', 'failed'].includes((value as SearchAttempt).status)) }
function isSearchAdapter(value: unknown): value is SearchAdapter {
  return Boolean(value && typeof value === 'object' && typeof (value as SearchAdapter).id === 'string' &&
    ['native', 'byok', 'browser_fallback'].includes((value as SearchAdapter).kind) &&
    typeof (value as SearchAdapter).available === 'function' && typeof (value as SearchAdapter).search === 'function')
}
