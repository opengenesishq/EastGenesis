import { app } from 'electron'
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type {
  AgentEvent,
  AgentEventIdentity,
  ConversationLedgerIntegrityView,
  TranscriptEntry
} from '../shared/types'
import { applyTranscriptRestorePlan, planTranscriptRestore } from './checkpointRestorePlan'
import type { TranscriptRestorePlan } from './checkpointRestorePlan'
import { redactSensitiveValue } from './security/secret-redaction'

/**
 * Provider 无关的耐久会话事件。
 * 流式 delta 仍是瞬态；其余会影响恢复、审批、路由或上下文边界的语义事件进入同一 JSONL。
 */
const PERSIST_KINDS = new Set<AgentEvent['kind']>([
  'init',
  'status',
  'meta',
  'user-message',
  'assistant-message',
  'tool-start',
  'tool-result',
  'permission-request',
  'permission-resolved',
  'turn-result',
  'routing',
  'failover',
  'provider-key-failover',
  'provider-model-failover',
  'provider-protocol-failover',
  'provider-recovery-exhausted',
  'checkpoint',
  'checkpoint-restore',
  'subagent-result',
  'task-dag-update',
  'hook-event'
])
const SESSION_RUNTIME_KINDS = new Set<AgentEvent['kind']>(['init', 'status', 'meta'])
const FORK_EXCLUDED_KINDS = new Set<AgentEvent['kind']>([
  ...SESSION_RUNTIME_KINDS,
  'permission-request',
  'permission-resolved'
])

/** 回放上限:超长会话只回填最近这么多条,避免打开即卡死 */
const MAX_REPLAY_ENTRIES = 1000
const CONVERSATION_LEDGER_VERSION = 1 as const

export class ConversationLedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConversationLedgerIntegrityError'
  }
}

export class ConversationLedgerPersistenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConversationLedgerPersistenceError'
  }
}

export type ConversationLedgerFileReplacer = (temp: string, target: string) => void

export type ConversationLedgerSyncKind = 'file' | 'directory'

export interface ConversationLedgerFileOperations {
  open(path: string, flags: number, mode?: number): number
  append(descriptor: number, data: string, target: string): void
  write(descriptor: number, data: string | Uint8Array, target: string): void
  fsync(descriptor: number, target: string, kind: ConversationLedgerSyncKind): void
  close(descriptor: number, target: string): void
  rename(temp: string, target: string): void
}

const NODE_FILE_OPERATIONS: ConversationLedgerFileOperations = Object.freeze({
  open: (path: string, flags: number, mode?: number) => openSync(path, flags, mode),
  append: (descriptor: number, data: string) => appendFileSync(descriptor, data, 'utf8'),
  write: (descriptor: number, data: string | Uint8Array) => writeFileSync(descriptor, data),
  fsync: (descriptor: number) => fsyncSync(descriptor),
  close: (descriptor: number) => closeSync(descriptor),
  rename: (temp: string, target: string) => renameSync(temp, target)
})

/** Fault-injection tests wrap the same low-level operations used by production. */
export function createConversationLedgerFileOperations(
  overrides: Partial<ConversationLedgerFileOperations> = {}
): ConversationLedgerFileOperations {
  return Object.freeze({ ...NODE_FILE_OPERATIONS, ...overrides })
}

export interface EventReceipt extends AgentEventIdentity {
  kind: AgentEvent['kind']
  toolUseId?: string
  requestId?: string
  messageId?: string
  status?: string
  isError?: boolean
  behavior?: 'allow' | 'deny'
}

function transcriptsDir(): string {
  return join(app.getPath('userData'), 'transcripts')
}

function eventReceiptsDir(): string {
  return join(app.getPath('userData'), 'event-receipts')
}

export function transcriptFile(sdkSessionId: string): string {
  return join(transcriptsDir(), `${sdkSessionId}.jsonl`)
}

export function eventReceiptsFile(sdkSessionId: string): string {
  return join(eventReceiptsDir(), `${sdkSessionId}.jsonl`)
}

function legacyStreamId(path: string): string {
  return `legacy-stream:${createHash('sha256').update(path).digest('hex').slice(0, 24)}`
}

function normalizeEntry(path: string, entry: TranscriptEntry): TranscriptEntry {
  const eventId = entry.eventId?.trim() || `legacy-event:${createHash('sha256')
    .update(`${path}\n${entry.seq}\n${JSON.stringify(entry.event)}`)
    .digest('hex')
    .slice(0, 32)}`
  return {
    ...entry,
    eventId,
    streamId: entry.streamId?.trim() || legacyStreamId(path)
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) out[key] = canonicalValue(record[key])
  }
  return out
}

function unsealedEntry(entry: TranscriptEntry): TranscriptEntry {
  const { ledgerVersion: _version, previousDigest: _previous, digest: _digest, ...rest } = entry
  return rest
}

function digestForEntry(entry: TranscriptEntry, previousDigest?: string): string {
  return createHash('sha256').update(canonicalJson({
    ledgerVersion: CONVERSATION_LEDGER_VERSION,
    previousDigest: previousDigest ?? null,
    entry: unsealedEntry(entry)
  })).digest('hex')
}

function legacyAnchor(entries: TranscriptEntry[]): string | undefined {
  if (entries.length === 0) return undefined
  return `legacy:${createHash('sha256')
    .update(canonicalJson(entries.map(unsealedEntry)))
    .digest('hex')}`
}

function sealEntry(entry: TranscriptEntry, previousDigest?: string): TranscriptEntry {
  const base = unsealedEntry(entry)
  return {
    ...base,
    ledgerVersion: CONVERSATION_LEDGER_VERSION,
    ...(previousDigest ? { previousDigest } : {}),
    digest: digestForEntry(base, previousDigest)
  }
}

function sealEntries(path: string, entries: TranscriptEntry[]): TranscriptEntry[] {
  let previousDigest: string | undefined
  return entries.map((entry) => {
    const normalized = normalizeEntry(path, entry)
    const sealed = sealEntry({
      ...normalized,
      event: redactTranscriptEvent(normalized.event)
    }, previousDigest)
    previousDigest = sealed.digest
    return sealed
  })
}

export function verifyConversationLedgerEntries(entries: TranscriptEntry[]): ConversationLedgerIntegrityView {
  if (entries.length === 0) {
    return { schemaVersion: 1, valid: true, mode: 'empty', entryCount: 0 }
  }
  let previousSeq = 0
  let sealed = false
  let expectedPrevious: string | undefined
  const legacyEntries: TranscriptEntry[] = []
  for (const entry of entries) {
    if (!Number.isInteger(entry.seq) || entry.seq <= previousSeq) {
      return ledgerFailure(entries, `event seq is not strictly increasing at ${entry.seq}`)
    }
    previousSeq = entry.seq
    if (!entry.eventId?.trim() || !entry.streamId?.trim() || !entry.event) {
      return ledgerFailure(entries, `event identity is incomplete at seq ${entry.seq}`)
    }
    if (entry.ledgerVersion === undefined && entry.digest === undefined && entry.previousDigest === undefined) {
      if (sealed) return ledgerFailure(entries, `legacy event appears after sealed suffix at seq ${entry.seq}`)
      legacyEntries.push(entry)
      continue
    }
    if (entry.ledgerVersion !== CONVERSATION_LEDGER_VERSION || !entry.digest?.trim()) {
      return ledgerFailure(entries, `ledger seal is invalid at seq ${entry.seq}`)
    }
    if (!sealed) {
      sealed = true
      expectedPrevious = legacyAnchor(legacyEntries)
    }
    if ((entry.previousDigest ?? undefined) !== expectedPrevious) {
      return ledgerFailure(entries, `previous digest mismatch at seq ${entry.seq}`)
    }
    const expectedDigest = digestForEntry(entry, expectedPrevious)
    if (entry.digest !== expectedDigest) {
      return ledgerFailure(entries, `digest mismatch at seq ${entry.seq}`)
    }
    expectedPrevious = entry.digest
  }
  return {
    schemaVersion: 1,
    valid: true,
    mode: sealed ? 'sealed' : 'legacy',
    entryCount: entries.length,
    ...(sealed && expectedPrevious ? { headDigest: expectedPrevious } : {})
  }
}

function ledgerFailure(entries: TranscriptEntry[], error: string): ConversationLedgerIntegrityView {
  return { schemaVersion: 1, valid: false, mode: 'sealed', entryCount: entries.length, error }
}

function readEntriesStrict(path: string): TranscriptEntry[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const out: TranscriptEntry[] = []
  const lines = raw.split('\n')
  const lastContentIndex = lines.reduce((last, line, index) => line.trim() ? index : last, -1)
  for (let index = 0; index <= lastContentIndex; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as TranscriptEntry
      if (typeof parsed?.seq !== 'number' || !parsed.event) {
        throw new ConversationLedgerIntegrityError(`invalid transcript entry at line ${index + 1}`)
      }
      out.push(normalizeEntry(path, parsed))
    } catch (error) {
      // 仅容忍 EOF 且没有换行的最后半行；完整坏行会改变事件因果链，必须 fail closed。
      if (
        index === lastContentIndex &&
        !raw.endsWith('\n') &&
        !(error instanceof ConversationLedgerIntegrityError)
      ) break
      throw error
    }
  }
  const verification = verifyConversationLedgerEntries(out)
  if (!verification.valid) {
    throw new ConversationLedgerIntegrityError(verification.error ?? 'conversation ledger verification failed')
  }
  return out
}

function readEntries(path: string): TranscriptEntry[] {
  try {
    return readEntriesStrict(path)
  } catch (error) {
    console.error('[agent-desk] 会话账本读取失败:', error)
    return []
  }
}

function repairAppendBoundary(
  path: string,
  entries: TranscriptEntry[],
  operations: ConversationLedgerFileOperations,
  replaceFile: ConversationLedgerFileReplacer
): void {
  if (!existsSync(path)) return
  const raw = readFileSync(path, 'utf8')
  if (!raw || raw.endsWith('\n')) return
  const temp = `${path}.${process.pid}.${randomUUID()}.tail.tmp`
  const body = entries.map((entry) => JSON.stringify(entry)).join('\n')
  durableAtomicReplace(temp, path, body ? `${body}\n` : '', operations, replaceFile)
}

export function readTranscriptEntries(sdkSessionId: string): TranscriptEntry[] {
  return readEntries(transcriptFile(sdkSessionId))
}

/** Canonical archive/recovery paths must surface corruption instead of returning an empty conversation. */
export function readTranscriptEntriesStrict(sdkSessionId: string): TranscriptEntry[] {
  return readEntriesStrict(transcriptFile(sdkSessionId))
}

/** Build the portable history inherited by a new conversation fork. */
export function transcriptForkSeedEntries(
  sourceSdkSessionId: string,
  checkpointId?: string
): TranscriptEntry[] {
  const source = sourceSdkSessionId.trim()
  if (!source) throw new Error('分叉来源 sdkSessionId 不能为空')
  const sourceEntries = readEntriesStrict(transcriptFile(source)).map(unsealedEntry)
  if (sourceEntries.length === 0) {
    throw new Error('分叉来源没有可移植的 EastGenesis 会话账本，不能伪装恢复隐藏 Provider 上下文')
  }
  let candidates = sourceEntries
  if (checkpointId !== undefined) {
    const checkpoint = checkpointId.trim()
    if (!checkpoint) throw new Error('分叉 checkpointId 不能为空')
    const plan = planTranscriptRestore(sourceEntries, checkpoint)
    if (!plan.ok) throw new Error(plan.reason ?? `找不到分叉 checkpoint:${checkpoint}`)
    candidates = applyTranscriptRestorePlan(sourceEntries, plan)
  }
  return candidates.filter((entry) => !FORK_EXCLUDED_KINDS.has(entry.event.kind))
}

export function shouldPersistConversationLedgerEvent(kind: AgentEvent['kind']): boolean {
  return PERSIST_KINDS.has(kind)
}

function readReceipts(path: string): EventReceipt[] {
  try {
    const out: EventReceipt[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const receipt = JSON.parse(line) as EventReceipt
        if (
          receipt?.schemaVersion === 1 &&
          typeof receipt.streamId === 'string' &&
          typeof receipt.eventId === 'string' &&
          typeof receipt.seq === 'number' &&
          typeof receipt.occurredAt === 'number' &&
          typeof receipt.kind === 'string'
        ) {
          out.push(receipt)
        }
      } catch {
        // 尾行可能因异常退出而截断,跳过。
      }
    }
    return out
  } catch {
    return []
  }
}

export function readEventReceipts(sdkSessionId: string): EventReceipt[] {
  return readReceipts(eventReceiptsFile(sdkSessionId))
}

function repairReceiptAppendBoundary(
  path: string,
  operations: ConversationLedgerFileOperations,
  replaceFile: ConversationLedgerFileReplacer
): void {
  if (!existsSync(path)) return
  const raw = readFileSync(path, 'utf8')
  if (!raw || raw.endsWith('\n')) return
  const receipts = readReceipts(path)
  const body = receipts.map((receipt) => JSON.stringify(receipt)).join('\n')
  durableAtomicReplace(
    `${path}.${process.pid}.${randomUUID()}.tail.tmp`,
    path,
    body ? `${body}\n` : '',
    operations,
    replaceFile
  )
}

function receiptFor(entry: TranscriptEntry & AgentEventIdentity): EventReceipt {
  const event = entry.event
  const receipt: EventReceipt = {
    schemaVersion: 1,
    streamId: entry.streamId,
    eventId: entry.eventId,
    seq: entry.seq,
    occurredAt: entry.occurredAt,
    kind: event.kind,
    ...(entry.causationId ? { causationId: entry.causationId } : {}),
    ...(entry.correlationId ? { correlationId: entry.correlationId } : {})
  }
  if (event.kind === 'tool-start' || event.kind === 'tool-result') receipt.toolUseId = event.toolUseId
  if (event.kind === 'permission-request') {
    receipt.requestId = event.request.requestId
    receipt.toolUseId = event.request.toolUseId
  }
  if (event.kind === 'permission-resolved') receipt.requestId = event.requestId
  if (event.kind === 'permission-resolved') receipt.behavior = event.behavior
  if (event.kind === 'status') receipt.status = event.status
  if (event.kind === 'turn-result' || event.kind === 'tool-result') receipt.isError = event.isError
  if (event.kind === 'user-message' || event.kind === 'checkpoint' || event.kind === 'checkpoint-restore') {
    receipt.messageId = event.messageId
  }
  return receipt
}

export function restoreTranscriptIfMissing(
  sdkSessionId: string | undefined,
  entries: TranscriptEntry[],
  operations: ConversationLedgerFileOperations = NODE_FILE_OPERATIONS
): void {
  if (!sdkSessionId || entries.length === 0) return
  const target = transcriptFile(sdkSessionId)
  if (readEntriesStrict(target).length > 0) return
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    ensureDirectory(transcriptsDir(), operations)
    const body = sealEntries(target, entries).map((entry) => JSON.stringify(entry)).join('\n')
    durableAtomicReplace(
      temp,
      target,
      body ? `${body}\n` : '',
      operations,
      (source, destination) => replaceFileWithRetry(source, destination, operations)
    )
  } catch (err) {
    throw conversationLedgerPersistenceError('从任务快照恢复转录失败', err)
  }
}

/**
 * 单会话转录写入器。转录按 sdkSessionId 落盘:resume 延续同一对话即同一文件。
 * 新会话在 init 事件到达前先内存缓冲,拿到 sdkSessionId 后 flush。
 * 同时负责给该会话的所有事件(含瞬态)分配单调递增 seq,供渲染进程去重。
 */
export class TranscriptWriter {
  private seq: number
  private sdkSessionId: string | null = null
  private streamId = `stream:${randomUUID()}`
  private buffer: TranscriptEntry[] = []
  private receiptBuffer: EventReceipt[] = []
  private currentCorrelationId?: string
  private lastEventId?: string
  private lastLedgerDigest?: string
  private ledgerAppendBlocked = false
  private readonly toolEventIds = new Map<string, string>()
  private readonly requestEventIds = new Map<string, string>()
  private readonly replaceFile: ConversationLedgerFileReplacer
  private readonly fileOperations: ConversationLedgerFileOperations

  constructor(
    resumeSdkSessionId?: string,
    initialSeq = 0,
    replaceFile?: ConversationLedgerFileReplacer,
    fileOperations: ConversationLedgerFileOperations = NODE_FILE_OPERATIONS
  ) {
    this.fileOperations = fileOperations
    this.replaceFile = replaceFile ?? ((temp, target) =>
      replaceFileWithRetry(temp, target, this.fileOperations))
    this.seq = Math.max(0, Math.floor(initialSeq))
    if (resumeSdkSessionId) this.bind(resumeSdkSessionId)
  }

  /** Seed a new conversation ledger without binding or resuming the source Provider session. */
  seedFrom(sourceSdkSessionId: string, checkpointId?: string): void {
    const source = sourceSdkSessionId.trim()
    if (!source) throw new Error('分叉来源 sdkSessionId 不能为空')
    if (this.sdkSessionId || this.buffer.length > 0 || this.receiptBuffer.length > 0) {
      throw new Error('会话账本仅可在绑定前分叉一次')
    }
    const inheritedEntries = transcriptForkSeedEntries(source, checkpointId)
    this.buffer = inheritedEntries
    // A fork inherits observed history, not source-side runtime identity or effect receipts.
    this.receiptBuffer = []
    this.seq = Math.max(this.seq, inheritedEntries.reduce((max, entry) => Math.max(max, entry.seq), 0))
    for (const entry of inheritedEntries) this.rememberLinks(entry.event, { eventId: entry.eventId! })
  }

  /** 为事件分配 seq;耐久事件同时落盘(或缓冲) */
  next(event: AgentEvent): number {
    return this.nextEntry(event).seq
  }

  /** 生成稳定事件身份;引擎将整个 entry 交给 SessionManager。 */
  nextEntry(event: AgentEvent): TranscriptEntry & AgentEventIdentity {
    const safeEvent = redactTranscriptEvent(event)
    if (safeEvent.kind === 'init' && safeEvent.sdkSessionId) this.bind(safeEvent.sdkSessionId)
    const seq = ++this.seq
    const eventId = randomUUID()
    const occurredAt = Date.now()
    const identity = this.identityFor(safeEvent, eventId, seq, occurredAt)
    const entry: TranscriptEntry & AgentEventIdentity = { ...identity, event: safeEvent }
    if (PERSIST_KINDS.has(safeEvent.kind)) {
      if (this.sdkSessionId) this.append(entry)
      else this.buffer.push(entry)
    }
    if (safeEvent.kind !== 'text-delta' && safeEvent.kind !== 'thinking-delta') {
      const receipt = receiptFor(entry)
      if (this.sdkSessionId) this.appendReceipt(receipt)
      else this.receiptBuffer.push(receipt)
    }
    this.rememberLinks(safeEvent, entry)
    return entry
  }

  /** 已持久化 + 尚在缓冲的耐久事件,按 seq 有序,截取最近 MAX_REPLAY_ENTRIES 条 */
  read(): TranscriptEntry[] {
    const all = this.readAll()
    return all.length > MAX_REPLAY_ENTRIES ? all.slice(-MAX_REPLAY_ENTRIES) : all
  }

  /** 完整转录,用于回溯规划/写回;不要用于首屏回放。 */
  readAll(): TranscriptEntry[] {
    const persisted = this.sdkSessionId ? readEntries(transcriptFile(this.sdkSessionId)) : []
    const persistedEventIds = new Set(persisted.map((entry) => entry.eventId).filter(Boolean))
    return [
      ...persisted,
      ...this.buffer.filter((entry) => !entry.eventId || !persistedEventIds.has(entry.eventId))
    ]
  }

  planRestore(checkpointId: string): TranscriptRestorePlan {
    return planTranscriptRestore(this.readAll(), checkpointId)
  }

  restore(
    checkpointId: string,
    restoreEvent?: AgentEvent | ((plan: TranscriptRestorePlan) => AgentEvent)
  ): { plan: TranscriptRestorePlan; entries: TranscriptEntry[] } {
    const current = this.readAll()
    const plan = planTranscriptRestore(current, checkpointId)
    if (!plan.ok) return { plan, entries: current }
    const restored = applyTranscriptRestorePlan(current, plan)
    let auditEntry: TranscriptEntry & AgentEventIdentity | undefined
    if (restoreEvent) {
      const maxSeq = current.reduce((max, entry) => Math.max(max, entry.seq), 0)
      const event = typeof restoreEvent === 'function' ? restoreEvent(plan) : restoreEvent
      const identity = this.identityFor(event, randomUUID(), maxSeq + 1, Date.now())
      auditEntry = { ...identity, event }
      restored.push(auditEntry)
    }
    this.replace(restored)
    if (auditEntry) {
      if (this.sdkSessionId) this.appendReceipt(receiptFor(auditEntry))
      else this.receiptBuffer.push(receiptFor(auditEntry))
      this.rememberLinks(auditEntry.event, auditEntry)
    }
    return { plan, entries: restored }
  }

  private bind(sdkSessionId: string): void {
    if (this.sdkSessionId === sdkSessionId) return
    const prev = this.sdkSessionId
    const prevStreamId = this.streamId
    const prevLedgerDigest = this.lastLedgerDigest
    const prevAppendBlocked = this.ledgerAppendBlocked
    this.sdkSessionId = sdkSessionId
    try {
      ensureDirectory(transcriptsDir(), this.fileOperations)
      ensureDirectory(eventReceiptsDir(), this.fileOperations)
      // resume 分叉出新 sdkSessionId 时,把旧转录复制过来延续对话
      if (prev && existsSync(transcriptFile(prev)) && !existsSync(transcriptFile(sdkSessionId))) {
        const inherited = readEntriesStrict(transcriptFile(prev))
        const body = inherited.map((entry) => JSON.stringify(entry)).join('\n')
        const target = transcriptFile(sdkSessionId)
        durableAtomicReplace(
          `${target}.${process.pid}.${randomUUID()}.copy.tmp`,
          target,
          body ? `${body}\n` : '',
          this.fileOperations,
          this.replaceFile
        )
      }
      if (prev && existsSync(eventReceiptsFile(prev)) && !existsSync(eventReceiptsFile(sdkSessionId))) {
        const target = eventReceiptsFile(sdkSessionId)
        durableAtomicReplace(
          `${target}.${process.pid}.${randomUUID()}.copy.tmp`,
          target,
          readFileSync(eventReceiptsFile(prev)),
          this.fileOperations,
          this.replaceFile
        )
      }
      const existing = readEntriesStrict(transcriptFile(sdkSessionId))
      const verification = verifyConversationLedgerEntries(existing)
      if (!verification.valid) {
        throw new ConversationLedgerIntegrityError(verification.error ?? 'conversation ledger verification failed')
      }
      repairAppendBoundary(
        transcriptFile(sdkSessionId),
        existing,
        this.fileOperations,
        this.replaceFile
      )
      this.lastLedgerDigest = verification.headDigest ?? legacyAnchor(existing)
      this.ledgerAppendBlocked = false
      repairReceiptAppendBoundary(
        eventReceiptsFile(sdkSessionId),
        this.fileOperations,
        this.replaceFile
      )
      const allReceipts = readReceipts(eventReceiptsFile(sdkSessionId))
      const canonicalEventIds = new Set(existing.map((entry) => entry.eventId).filter(Boolean))
      const receipts = existing.length > 0
        ? allReceipts.filter((receipt) => canonicalEventIds.has(receipt.eventId))
        : allReceipts
      const receiptEventIds = new Set(receipts.map((receipt) => receipt.eventId))
      this.buffer = this.buffer.filter((entry) => !entry.eventId || !canonicalEventIds.has(entry.eventId))
      this.receiptBuffer = this.receiptBuffer.filter((receipt) => !receiptEventIds.has(receipt.eventId))
      const existingMax = Math.max(
        existing.reduce((max, entry) => Math.max(max, entry.seq), 0),
        receipts.reduce((max, receipt) => Math.max(max, receipt.seq), 0)
      )
      const existingStreamId = receipts[0]?.streamId ?? existing[0]?.streamId
      if (existingStreamId) this.streamId = existingStreamId
      if ((this.buffer.length > 0 || this.receiptBuffer.length > 0) && existingMax >= this.firstBufferedSeq()) {
        throw new Error('不能把已广播的缓冲事件绑定到已有高游标的转录')
      }
      this.seq = Math.max(this.seq, existingMax)
      for (const entry of this.buffer.splice(0)) {
        this.append(entry)
      }
      for (const receipt of this.receiptBuffer.splice(0)) this.appendReceipt(receipt)
    } catch (err) {
      this.sdkSessionId = prev
      this.streamId = prevStreamId
      this.lastLedgerDigest = prevLedgerDigest
      this.ledgerAppendBlocked = prevAppendBlocked
      throw conversationLedgerPersistenceError('绑定转录文件失败', err)
    }
  }

  private append(entry: TranscriptEntry): void {
    if (!this.sdkSessionId) return
    if (this.ledgerAppendBlocked) {
      if (!this.buffer.some((candidate) => candidate.eventId === entry.eventId && candidate.seq === entry.seq)) {
        this.buffer.push(entry)
      }
      throw new ConversationLedgerPersistenceError('会话账本此前写入失败，已阻止继续追加未持久化事件')
    }
    try {
      ensureDirectory(transcriptsDir(), this.fileOperations)
      const target = transcriptFile(this.sdkSessionId)
      const current = readEntriesStrict(target)
      repairAppendBoundary(target, current, this.fileOperations, this.replaceFile)
      const currentHead = verifyConversationLedgerEntries(current).headDigest ?? legacyAnchor(current)
      if (currentHead !== this.lastLedgerDigest) {
        throw new ConversationLedgerIntegrityError('会话账本写入头已被其他 writer 改变')
      }
      const sealed = sealEntry(entry, this.lastLedgerDigest)
      durableAppend(target, `${JSON.stringify(sealed)}\n`, this.fileOperations)
      this.lastLedgerDigest = sealed.digest
    } catch (err) {
      if (!this.buffer.some((candidate) => candidate.eventId === entry.eventId && candidate.seq === entry.seq)) {
        this.buffer.push(entry)
      }
      this.ledgerAppendBlocked = true
      throw conversationLedgerPersistenceError('写入转录失败', err)
    }
  }

  private appendReceipt(receipt: EventReceipt): void {
    if (!this.sdkSessionId) return
    try {
      ensureDirectory(eventReceiptsDir(), this.fileOperations)
      const target = eventReceiptsFile(this.sdkSessionId)
      repairReceiptAppendBoundary(target, this.fileOperations, this.replaceFile)
      if (readReceipts(target).some((existing) => existing.eventId === receipt.eventId)) {
        this.receiptBuffer = this.receiptBuffer.filter((candidate) => candidate.eventId !== receipt.eventId)
        return
      }
      durableAppend(target, `${JSON.stringify(receipt)}\n`, this.fileOperations)
      this.receiptBuffer = this.receiptBuffer.filter((candidate) => candidate.eventId !== receipt.eventId)
    } catch (err) {
      if (!this.receiptBuffer.some((candidate) => candidate.eventId === receipt.eventId)) {
        this.receiptBuffer.push(receipt)
      }
      // Receipt 是 canonical transcript 的可重建投影，失败不能把已提交事件报告成未提交。
      console.error('[agent-desk] 写入事件回执投影失败:', conversationLedgerPersistenceError('写入事件回执失败', err))
    }
  }

  private replace(entries: TranscriptEntry[]): void {
    if (!this.sdkSessionId) {
      this.buffer = [...entries]
      this.lastLedgerDigest = undefined
      this.ledgerAppendBlocked = false
      this.seq = Math.max(this.seq, entries.reduce((max, entry) => Math.max(max, entry.seq), 0))
      return
    }
    const target = transcriptFile(this.sdkSessionId)
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      ensureDirectory(transcriptsDir(), this.fileOperations)
      const sealed = sealEntries(target, entries)
      const body = sealed.map((entry) => JSON.stringify(entry)).join('\n')
      durableAtomicReplace(
        temp,
        target,
        body ? `${body}\n` : '',
        this.fileOperations,
        this.replaceFile
      )
      this.buffer = []
      this.lastLedgerDigest = sealed[sealed.length - 1]?.digest
      this.ledgerAppendBlocked = false
      this.seq = Math.max(this.seq, entries.reduce((max, entry) => Math.max(max, entry.seq), 0))
    } catch (err) {
      this.ledgerAppendBlocked = true
      throw conversationLedgerPersistenceError('替换转录失败', err)
    }
  }

  private firstBufferedSeq(): number {
    const values = [
      ...this.buffer.map((entry) => entry.seq),
      ...this.receiptBuffer.map((receipt) => receipt.seq)
    ]
    return values.length > 0 ? Math.min(...values) : Number.POSITIVE_INFINITY
  }

  private identityFor(
    event: AgentEvent,
    eventId: string,
    seq: number,
    occurredAt: number
  ): AgentEventIdentity {
    let causationId = this.lastEventId
    let correlationId = this.currentCorrelationId
    if (event.kind === 'user-message') {
      causationId = undefined
      correlationId = eventId
    } else if (event.kind === 'permission-request') {
      causationId = event.request.toolUseId
        ? this.toolEventIds.get(event.request.toolUseId) ?? causationId
        : causationId
    } else if (event.kind === 'permission-resolved') {
      causationId = this.requestEventIds.get(event.requestId) ?? causationId
    } else if (event.kind === 'tool-result') {
      causationId = this.toolEventIds.get(event.toolUseId) ?? causationId
    }
    return {
      schemaVersion: 1,
      streamId: this.streamId,
      eventId,
      seq,
      occurredAt,
      ...(causationId ? { causationId } : {}),
      ...(correlationId ? { correlationId } : {})
    }
  }

  private rememberLinks(event: AgentEvent, identity: Pick<AgentEventIdentity, 'eventId'>): void {
    if (event.kind === 'user-message') this.currentCorrelationId = identity.eventId
    if (event.kind === 'assistant-message') {
      for (const block of event.blocks) {
        if (block.type === 'tool_use') this.toolEventIds.set(block.id, identity.eventId)
      }
    }
    if (event.kind === 'tool-start') this.toolEventIds.set(event.toolUseId, identity.eventId)
    if (event.kind === 'permission-request') {
      this.requestEventIds.set(event.request.requestId, identity.eventId)
      if (event.request.toolUseId) this.toolEventIds.set(event.request.toolUseId, identity.eventId)
    }
    if (event.kind === 'permission-resolved') this.requestEventIds.set(event.requestId, identity.eventId)
    if (event.kind === 'tool-result') this.toolEventIds.set(event.toolUseId, identity.eventId)
    this.lastEventId = identity.eventId
  }
}

/**
 * Anthropic's assistant-side replay signatures are opaque protocol state, not
 * credentials. They must remain in the private local conversation ledger
 * so a resumed Messages request is valid. Generic log redaction still applies
 * to every other field and all other event kinds.
 */
function redactTranscriptEvent(event: AgentEvent): AgentEvent {
  const redacted = redactSensitiveValue(event)
  if (event.kind !== 'assistant-message' || redacted.kind !== 'assistant-message') return redacted
  return {
    ...redacted,
    blocks: redacted.blocks.map((block, index) => {
      const original = event.blocks[index]
      if (
        (original?.type === 'thinking' || original?.type === 'tool_use') &&
        original.signature &&
        (block.type === 'thinking' || block.type === 'tool_use')
      ) {
        return { ...block, signature: original.signature }
      }
      return block
    })
  }
}

/** 启动时清理:不在历史列表里的转录文件已不可达,删除 */
export function cleanupTranscripts(keepSdkSessionIds: Set<string>): void {
  for (const dir of [transcriptsDir(), eventReceiptsDir()]) {
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue
        if (!keepSdkSessionIds.has(name.slice(0, -'.jsonl'.length))) {
          unlinkSync(join(dir, name))
        }
      }
    } catch {
      // 目录不存在等,忽略
    }
  }
}

function ensureDirectory(
  directory: string,
  operations: ConversationLedgerFileOperations = NODE_FILE_OPERATIONS
): void {
  const missing: string[] = []
  let cursor = directory
  while (!existsSync(cursor)) {
    missing.push(cursor)
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (const created of missing) {
    syncDirectory(created, operations)
    const parent = dirname(created)
    if (parent !== created) syncDirectory(parent, operations)
  }
}

function durableAppend(
  target: string,
  data: string,
  operations: ConversationLedgerFileOperations
): void {
  let created = false
  withDescriptor(
    target,
    () => {
      const opened = openAppendDescriptor(target, operations)
      created = opened.created
      return opened.descriptor
    },
    operations,
    (descriptor) => {
      operations.append(descriptor, data, target)
      operations.fsync(descriptor, target, 'file')
    }
  )
  if (created) syncDirectoryAndParent(dirname(target), operations)
}

function openAppendDescriptor(
  target: string,
  operations: ConversationLedgerFileOperations
): { descriptor: number; created: boolean } {
  const defensive = noFollowFlag()
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return {
        descriptor: operations.open(
          target,
          constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | defensive,
          0o600
        ),
        created: true
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== 'EEXIST') throw error
    }
    try {
      return {
        descriptor: operations.open(target, constants.O_WRONLY | constants.O_APPEND | defensive),
        created: false
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT' || attempt === 7) throw error
    }
  }
  throw new Error(`无法打开 append ledger:${target}`)
}

function durableAtomicReplace(
  temp: string,
  target: string,
  data: string | Uint8Array,
  operations: ConversationLedgerFileOperations,
  replaceFile: ConversationLedgerFileReplacer
): void {
  let published = false
  try {
    withDescriptor(
      temp,
      () => operations.open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
        0o600
      ),
      operations,
      (descriptor) => {
        operations.write(descriptor, data, temp)
        operations.fsync(descriptor, temp, 'file')
      }
    )
    replaceFile(temp, target)
    published = true
    syncDirectoryAndParent(dirname(target), operations)
  } catch (error) {
    if (!published) unlinkIfExists(temp)
    throw error
  }
}

function withDescriptor(
  target: string,
  openDescriptor: () => number,
  operations: ConversationLedgerFileOperations,
  action: (descriptor: number) => void
): void {
  let descriptor: number | undefined
  let failure: unknown
  let failed = false
  try {
    descriptor = openDescriptor()
    action(descriptor)
  } catch (error) {
    failed = true
    failure = error
  }
  if (descriptor !== undefined) {
    try {
      operations.close(descriptor, target)
    } catch (error) {
      if (!failed) {
        failed = true
        failure = error
      }
    }
  }
  if (failed) throw failure
}

function syncDirectoryAndParent(
  directory: string,
  operations: ConversationLedgerFileOperations
): void {
  syncDirectory(directory, operations)
  const parent = dirname(directory)
  if (parent !== directory) syncDirectory(parent, operations)
}

function syncDirectory(directory: string, operations: ConversationLedgerFileOperations): void {
  // Node does not expose a durable directory flush primitive on Windows; keep that platform unverified.
  if (process.platform === 'win32') return
  withDescriptor(
    directory,
    () => operations.open(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | noFollowFlag()
    ),
    operations,
    (descriptor) => operations.fsync(descriptor, directory, 'directory')
  )
}

function noFollowFlag(): number {
  return process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)
}

function replaceFileWithRetry(
  temp: string,
  target: string,
  operations: ConversationLedgerFileOperations = NODE_FILE_OPERATIONS
): void {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      operations.rename(temp, target)
      return
    } catch (err) {
      if (!isRetryableFileReplaceError(err) || attempt === 7) throw err
      sleepSync(100)
    }
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path)
  } catch (err) {
    if (!isRecord(err) || err.code !== 'ENOENT') throw err
  }
}

function isRetryableFileReplaceError(err: unknown): boolean {
  return isRecord(err) && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')
}

function isRecord(value: unknown): value is { code?: unknown } { return typeof value === 'object' && value !== null }

function conversationLedgerPersistenceError(action: string, error: unknown): ConversationLedgerPersistenceError {
  if (error instanceof ConversationLedgerPersistenceError) return error
  const detail = error instanceof Error ? error.message : String(error)
  return new ConversationLedgerPersistenceError(`${action}: ${detail}`)
}

function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
