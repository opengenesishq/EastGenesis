import type { EngineKind, SessionMeta, TranscriptEntry } from '../../shared/types'
import { verifyConversationLedgerEntries } from '../transcript'
import { stableValueDigest } from './tool-idempotency'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { setupConversationLedgerSchema } from './conversation-ledger-schema'

const ARCHIVE_GENESIS_DIGEST = '0'.repeat(64)

export type ConversationLedgerArchiveReason =
  | 'initial'
  | 'append'
  | 'backfill'
  | 'checkpoint_restore'
  | 'source_rewrite'

export interface ConversationLedgerArchiveIdentity {
  sdkSessionId: string
  currentSessionId: string
  sourceSdkSessionId?: string
  projectId?: string
  workspaceId?: string
  goalId?: string
  workItemId?: string
  sourceCwd: string
  providerId: string
  model: string
  engine?: EngineKind
  createdAt: number
  updatedAt?: number
}

export interface ConversationLedgerArchiveResult {
  sdkSessionId: string
  generation: number
  entryCount: number
  appended: number
  rewritten: boolean
  ledgerHeadDigest?: string
  archiveHeadDigest?: string
}

export interface ConversationLedgerArchiveVerification {
  valid: true
  streams: number
  generations: number
  events: number
  currentEvents: number
  digest: string
}

export interface ConversationLedgerProjectPurgeResult {
  streams: number
  generations: number
  events: number
}

export interface ConversationLedgerProjectSessionInventory {
  sessionIds: string[]
  sdkSessionIds: string[]
}

export interface ConversationLedgerSessionPurgeResult {
  streams: number
  generations: number
  events: number
}

interface StreamRow {
  sdkSessionId: string
  originSessionId: string
  currentSessionId: string
  sourceSdkSessionId?: string
  projectId?: string
  workspaceId?: string
  goalId?: string
  workItemId?: string
  sourceCwd: string
  providerId: string
  model: string
  engine?: EngineKind
  currentGeneration: number
  createdAt: number
  updatedAt: number
}

interface GenerationRow {
  sdkSessionId: string
  generation: number
  entryCount: number
  ledgerMode: 'empty' | 'legacy' | 'sealed'
  ledgerHeadDigest?: string
  archiveHeadDigest?: string
  supersedesGeneration?: number
  rewriteReason: string
  createdAt: number
  updatedAt: number
}

interface EventRow {
  sdkSessionId: string
  generation: number
  seq: number
  eventId: string
  streamId: string
  occurredAt: number
  kind: string
  ledgerDigest?: string
  sourceDigest: string
  previousArchiveDigest: string
  archiveDigest: string
  payload: string
}

export function conversationLedgerArchiveIdentity(
  meta: Pick<SessionMeta,
    'id' | 'sdkSessionId' | 'conversationForkSourceSdkSessionId' | 'projectId' | 'workspaceId' |
    'goalId' | 'workItemId' | 'sourceCwd' | 'cwd' | 'providerId' | 'model' | 'engine' | 'createdAt'>,
  updatedAt = Date.now()
): ConversationLedgerArchiveIdentity | null {
  const sdkSessionId = meta.sdkSessionId?.trim()
  if (!sdkSessionId) return null
  return {
    sdkSessionId,
    currentSessionId: meta.id,
    sourceSdkSessionId: meta.conversationForkSourceSdkSessionId,
    projectId: meta.projectId,
    workspaceId: meta.workspaceId,
    goalId: meta.goalId,
    workItemId: meta.workItemId,
    sourceCwd: meta.sourceCwd ?? meta.cwd,
    providerId: meta.providerId,
    model: meta.model,
    engine: meta.engine,
    createdAt: meta.createdAt,
    updatedAt
  }
}

export function archiveConversationLedgerEntries(
  db: WorkflowLedgerDatabase,
  identityInput: ConversationLedgerArchiveIdentity,
  entries: readonly TranscriptEntry[],
  reason: ConversationLedgerArchiveReason = 'append'
): ConversationLedgerArchiveResult {
  setupConversationLedgerSchema(db)
  const identity = normalizeIdentity(identityInput)
  const normalizedEntries = entries.map((entry) => ({ ...entry }))
  const verification = verifyConversationLedgerEntries(normalizedEntries)
  if (!verification.valid) throw new Error(verification.error ?? 'conversation ledger verification failed')
  if (normalizedEntries.length === 0) {
    throw new Error(`Conversation Ledger ${identity.sdkSessionId} has no durable events to archive`)
  }

  const existing = findStream(db, identity.sdkSessionId)
  if (!existing) {
    const generation = 1
    insertStream(db, identity, generation)
    const archiveHeadDigest = insertGeneration(
      db,
      identity.sdkSessionId,
      generation,
      normalizedEntries,
      verification,
      undefined,
      reason === 'append' ? 'initial' : reason,
      identity.updatedAt!
    )
    return {
      sdkSessionId: identity.sdkSessionId,
      generation,
      entryCount: normalizedEntries.length,
      appended: normalizedEntries.length,
      rewritten: false,
      ledgerHeadDigest: verification.headDigest,
      archiveHeadDigest
    }
  }

  assertImmutableOwnership(existing, identity)
  const current = requireGeneration(db, existing.sdkSessionId, existing.currentGeneration)
  const currentEvents = readEventRows(db, existing.sdkSessionId, existing.currentGeneration)
  if (currentEvents.length !== current.entryCount) {
    throw new Error(`Conversation Ledger archive generation ${existing.sdkSessionId}/${current.generation} count mismatch`)
  }
  const sourceDigests = normalizedEntries.map(sourceDigestFor)
  const prefixMatches = currentEvents.length <= sourceDigests.length &&
    currentEvents.every((event, index) => event.sourceDigest === sourceDigests[index])

  if (!prefixMatches) {
    const generation = existing.currentGeneration + 1
    const rewriteReason = reason === 'checkpoint_restore' ? reason : 'source_rewrite'
    const archiveHeadDigest = insertGeneration(
      db,
      identity.sdkSessionId,
      generation,
      normalizedEntries,
      verification,
      existing.currentGeneration,
      rewriteReason,
      identity.updatedAt!
    )
    updateStream(db, existing, identity, generation)
    return {
      sdkSessionId: identity.sdkSessionId,
      generation,
      entryCount: normalizedEntries.length,
      appended: normalizedEntries.length,
      rewritten: true,
      ledgerHeadDigest: verification.headDigest,
      archiveHeadDigest
    }
  }

  const suffix = normalizedEntries.slice(currentEvents.length)
  let archiveHeadDigest = current.archiveHeadDigest
  if (suffix.length > 0) {
    archiveHeadDigest = insertEvents(
      db,
      identity.sdkSessionId,
      current.generation,
      suffix,
      archiveHeadDigest ?? ARCHIVE_GENESIS_DIGEST
    )
    db.run(
      `UPDATE conversation_ledger_generations
       SET entry_count = ?, ledger_mode = ?, ledger_head_digest = ?, archive_head_digest = ?, updated_at = ?
       WHERE sdk_session_id = ? AND generation = ?`,
      [
        normalizedEntries.length,
        verification.mode,
        verification.headDigest ?? null,
        archiveHeadDigest ?? null,
        identity.updatedAt!,
        identity.sdkSessionId,
        current.generation
      ]
    )
  }
  updateStream(db, existing, identity, current.generation)
  return {
    sdkSessionId: identity.sdkSessionId,
    generation: current.generation,
    entryCount: normalizedEntries.length,
    appended: suffix.length,
    rewritten: false,
    ledgerHeadDigest: verification.headDigest,
    archiveHeadDigest
  }
}

export function selectCurrentConversationLedgerEntries(
  db: WorkflowLedgerDatabase,
  sdkSessionIdInput: string
): TranscriptEntry[] {
  setupConversationLedgerSchema(db)
  const sdkSessionId = requiredText(sdkSessionIdInput, 'sdkSessionId')
  const stream = findStream(db, sdkSessionId)
  if (!stream) return []
  const generation = requireGeneration(db, sdkSessionId, stream.currentGeneration)
  const rows = readEventRows(db, sdkSessionId, stream.currentGeneration)
  const entries = rows.map(parseEventPayload)
  const verification = verifyConversationLedgerEntries(entries)
  if (!verification.valid || entries.length !== generation.entryCount ||
      verification.mode !== generation.ledgerMode ||
      (verification.headDigest ?? undefined) !== generation.ledgerHeadDigest) {
    throw new Error(`Conversation Ledger archive current generation ${sdkSessionId}/${stream.currentGeneration} is invalid`)
  }
  verifyArchiveEventChain(rows)
  return entries
}

export function verifyConversationLedgerArchive(
  db: WorkflowLedgerDatabase
): ConversationLedgerArchiveVerification {
  const streams = readStreams(db)
  const generations = readGenerations(db)
  const generationKeys = new Set(generations.map((row) => generationKey(row.sdkSessionId, row.generation)))
  const summaries: Array<Record<string, unknown>> = []
  let events = 0
  let currentEvents = 0

  for (const stream of streams) {
    if (!generationKeys.has(generationKey(stream.sdkSessionId, stream.currentGeneration))) {
      throw new Error(`Conversation Ledger stream ${stream.sdkSessionId} points to a missing generation`)
    }
  }
  for (const generation of generations) {
    const stream = streams.find((candidate) => candidate.sdkSessionId === generation.sdkSessionId)
    if (!stream) throw new Error(`Conversation Ledger generation ${generation.sdkSessionId} has no stream`)
    if (generation.supersedesGeneration !== undefined &&
        generation.supersedesGeneration >= generation.generation) {
      throw new Error(`Conversation Ledger generation ${generation.sdkSessionId}/${generation.generation} has invalid ancestry`)
    }
    const rows = readEventRows(db, generation.sdkSessionId, generation.generation)
    const entries = rows.map(parseEventPayload)
    const verification = verifyConversationLedgerEntries(entries)
    verifyArchiveEventChain(rows)
    if (!verification.valid || rows.length !== generation.entryCount ||
        verification.mode !== generation.ledgerMode ||
        (verification.headDigest ?? undefined) !== generation.ledgerHeadDigest ||
        (rows.at(-1)?.archiveDigest ?? undefined) !== generation.archiveHeadDigest) {
      throw new Error(`Conversation Ledger generation ${generation.sdkSessionId}/${generation.generation} failed verification`)
    }
    events += rows.length
    if (stream.currentGeneration === generation.generation) currentEvents += rows.length
    summaries.push({
      sdkSessionId: generation.sdkSessionId,
      generation: generation.generation,
      entryCount: generation.entryCount,
      ledgerHeadDigest: generation.ledgerHeadDigest,
      archiveHeadDigest: generation.archiveHeadDigest,
      supersedesGeneration: generation.supersedesGeneration
    })
  }
  return {
    valid: true,
    streams: streams.length,
    generations: generations.length,
    events,
    currentEvents,
    digest: stableValueDigest(summaries)
  }
}

export function purgeConversationLedgerProject(
  db: WorkflowLedgerDatabase,
  projectIdInput: string,
  sessionIds: ReadonlySet<string> = new Set()
): ConversationLedgerProjectPurgeResult {
  setupConversationLedgerSchema(db)
  verifyConversationLedgerArchive(db)
  const projectId = requiredText(projectIdInput, 'Conversation Ledger purge projectId')
  const sessionValues = [...sessionIds].map((value) => requiredText(value, 'Conversation Ledger purge sessionId'))
  const sessionClause = sessionValues.map(() => '?').join(', ')
  const where = `project_id = ? OR workspace_id = ?${sessionClause
    ? ` OR origin_session_id IN (${sessionClause}) OR current_session_id IN (${sessionClause})`
    : ''}`
  const values = [projectId, projectId, ...sessionValues, ...sessionValues]
  const sdkSessionIds = selectTextColumn(
    db,
    `SELECT sdk_session_id FROM conversation_ledger_streams WHERE ${where} ORDER BY sdk_session_id`,
    values,
    'sdk_session_id'
  )
  if (sdkSessionIds.length === 0) return { streams: 0, generations: 0, events: 0 }
  const placeholders = sdkSessionIds.map(() => '?').join(', ')
  const events = countRows(
    db,
    `SELECT COUNT(*) AS count FROM conversation_ledger_events WHERE sdk_session_id IN (${placeholders})`,
    sdkSessionIds
  )
  const generations = countRows(
    db,
    `SELECT COUNT(*) AS count FROM conversation_ledger_generations WHERE sdk_session_id IN (${placeholders})`,
    sdkSessionIds
  )
  db.run(`DELETE FROM conversation_ledger_events WHERE sdk_session_id IN (${placeholders})`, sdkSessionIds)
  db.run(`DELETE FROM conversation_ledger_generations WHERE sdk_session_id IN (${placeholders})`, sdkSessionIds)
  db.run(`DELETE FROM conversation_ledger_streams WHERE sdk_session_id IN (${placeholders})`, sdkSessionIds)
  verifyConversationLedgerArchive(db)
  return { streams: sdkSessionIds.length, generations, events }
}

/**
 * Conversation archive rows are private Session content. Canonical workflow
 * records intentionally remain untouched when a user deletes visible history.
 */
export function purgeConversationLedgerSession(
  db: WorkflowLedgerDatabase,
  sdkSessionIdInput: string
): ConversationLedgerSessionPurgeResult {
  setupConversationLedgerSchema(db)
  verifyConversationLedgerArchive(db)
  const sdkSessionId = requiredText(sdkSessionIdInput, 'Conversation Ledger purge sdkSessionId')
  const streams = countRows(
    db,
    'SELECT COUNT(*) AS count FROM conversation_ledger_streams WHERE sdk_session_id = ?',
    [sdkSessionId]
  )
  if (streams === 0) return { streams: 0, generations: 0, events: 0 }
  const generations = countRows(
    db,
    'SELECT COUNT(*) AS count FROM conversation_ledger_generations WHERE sdk_session_id = ?',
    [sdkSessionId]
  )
  const events = countRows(
    db,
    'SELECT COUNT(*) AS count FROM conversation_ledger_events WHERE sdk_session_id = ?',
    [sdkSessionId]
  )
  db.run('DELETE FROM conversation_ledger_events WHERE sdk_session_id = ?', [sdkSessionId])
  db.run('DELETE FROM conversation_ledger_generations WHERE sdk_session_id = ?', [sdkSessionId])
  db.run('DELETE FROM conversation_ledger_streams WHERE sdk_session_id = ?', [sdkSessionId])
  verifyConversationLedgerArchive(db)
  return { streams, generations, events }
}

export function countConversationLedgerSessionResiduals(
  db: WorkflowLedgerDatabase,
  sdkSessionIdInput: string
): ConversationLedgerSessionPurgeResult {
  setupConversationLedgerSchema(db)
  const sdkSessionId = requiredText(sdkSessionIdInput, 'Conversation Ledger residual sdkSessionId')
  return {
    streams: countRows(
      db,
      'SELECT COUNT(*) AS count FROM conversation_ledger_streams WHERE sdk_session_id = ?',
      [sdkSessionId]
    ),
    generations: countRows(
      db,
      'SELECT COUNT(*) AS count FROM conversation_ledger_generations WHERE sdk_session_id = ?',
      [sdkSessionId]
    ),
    events: countRows(
      db,
      'SELECT COUNT(*) AS count FROM conversation_ledger_events WHERE sdk_session_id = ?',
      [sdkSessionId]
    )
  }
}

export function countConversationLedgerProjectResiduals(
  db: WorkflowLedgerDatabase,
  projectIdInput: string,
  sessionIds: ReadonlySet<string> = new Set()
): ConversationLedgerProjectPurgeResult {
  setupConversationLedgerSchema(db)
  const projectId = requiredText(projectIdInput, 'Conversation Ledger residual projectId')
  const sessionValues = [...sessionIds].map((value) => requiredText(value, 'Conversation Ledger residual sessionId'))
  const sessionClause = sessionValues.map(() => '?').join(', ')
  const where = `project_id = ? OR workspace_id = ?${sessionClause
    ? ` OR origin_session_id IN (${sessionClause}) OR current_session_id IN (${sessionClause})`
    : ''}`
  const values = [projectId, projectId, ...sessionValues, ...sessionValues]
  const sdkSessionIds = selectTextColumn(
    db,
    `SELECT sdk_session_id FROM conversation_ledger_streams WHERE ${where} ORDER BY sdk_session_id`,
    values,
    'sdk_session_id'
  )
  if (sdkSessionIds.length === 0) return { streams: 0, generations: 0, events: 0 }
  const placeholders = sdkSessionIds.map(() => '?').join(', ')
  return {
    streams: sdkSessionIds.length,
    generations: countRows(
      db,
      `SELECT COUNT(*) AS count FROM conversation_ledger_generations WHERE sdk_session_id IN (${placeholders})`,
      sdkSessionIds
    ),
    events: countRows(
      db,
      `SELECT COUNT(*) AS count FROM conversation_ledger_events WHERE sdk_session_id IN (${placeholders})`,
      sdkSessionIds
    )
  }
}

export function selectConversationLedgerProjectSessionInventory(
  db: WorkflowLedgerDatabase,
  projectIdInput: string
): ConversationLedgerProjectSessionInventory {
  setupConversationLedgerSchema(db)
  const projectId = requiredText(projectIdInput, 'Conversation Ledger inventory projectId')
  const stmt = db.prepare(
    `SELECT sdk_session_id, origin_session_id, current_session_id
     FROM conversation_ledger_streams
     WHERE project_id = ? OR workspace_id = ?
     ORDER BY sdk_session_id`
  )
  const sessionIds = new Set<string>()
  const sdkSessionIds = new Set<string>()
  try {
    stmt.bind([projectId, projectId])
    while (stmt.step()) {
      const row = stmt.getAsObject()
      sdkSessionIds.add(requiredText(row.sdk_session_id, 'inventory.sdk_session_id'))
      sessionIds.add(requiredText(row.origin_session_id, 'inventory.origin_session_id'))
      sessionIds.add(requiredText(row.current_session_id, 'inventory.current_session_id'))
    }
  } finally {
    stmt.free()
  }
  return { sessionIds: [...sessionIds].sort(), sdkSessionIds: [...sdkSessionIds].sort() }
}

function insertStream(
  db: WorkflowLedgerDatabase,
  identity: Required<Pick<ConversationLedgerArchiveIdentity,
    'sdkSessionId' | 'currentSessionId' | 'sourceCwd' | 'providerId' | 'model' | 'createdAt' | 'updatedAt'>> &
    Omit<ConversationLedgerArchiveIdentity,
      'sdkSessionId' | 'currentSessionId' | 'sourceCwd' | 'providerId' | 'model' | 'createdAt' | 'updatedAt'>,
  generation: number
): void {
  db.run(
    `INSERT INTO conversation_ledger_streams(
       sdk_session_id, origin_session_id, current_session_id, source_sdk_session_id,
       project_id, workspace_id, goal_id, work_item_id, source_cwd,
       provider_id, model, engine, current_generation, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      identity.sdkSessionId,
      identity.currentSessionId,
      identity.currentSessionId,
      identity.sourceSdkSessionId ?? null,
      identity.projectId ?? null,
      identity.workspaceId ?? null,
      identity.goalId ?? null,
      identity.workItemId ?? null,
      identity.sourceCwd,
      identity.providerId,
      identity.model,
      identity.engine ?? null,
      generation,
      identity.createdAt,
      identity.updatedAt
    ]
  )
}

function insertGeneration(
  db: WorkflowLedgerDatabase,
  sdkSessionId: string,
  generation: number,
  entries: readonly TranscriptEntry[],
  verification: ReturnType<typeof verifyConversationLedgerEntries>,
  supersedesGeneration: number | undefined,
  rewriteReason: string,
  now: number
): string | undefined {
  db.run(
    `INSERT INTO conversation_ledger_generations(
       sdk_session_id, generation, entry_count, ledger_mode, ledger_head_digest,
       archive_head_digest, supersedes_generation, rewrite_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    [
      sdkSessionId,
      generation,
      entries.length,
      verification.mode,
      verification.headDigest ?? null,
      supersedesGeneration ?? null,
      rewriteReason,
      now,
      now
    ]
  )
  const archiveHeadDigest = insertEvents(db, sdkSessionId, generation, entries, ARCHIVE_GENESIS_DIGEST)
  db.run(
    `UPDATE conversation_ledger_generations SET archive_head_digest = ?
     WHERE sdk_session_id = ? AND generation = ?`,
    [archiveHeadDigest ?? null, sdkSessionId, generation]
  )
  return archiveHeadDigest
}

function insertEvents(
  db: WorkflowLedgerDatabase,
  sdkSessionId: string,
  generation: number,
  entries: readonly TranscriptEntry[],
  initialPreviousDigest: string
): string | undefined {
  let previousArchiveDigest = initialPreviousDigest
  for (const entry of entries) {
    const eventId = requiredText(entry.eventId, `Conversation Ledger seq ${entry.seq} eventId`)
    const streamId = requiredText(entry.streamId, `Conversation Ledger seq ${entry.seq} streamId`)
    const occurredAt = finiteTimestamp(entry.occurredAt ?? 0, `Conversation Ledger seq ${entry.seq} occurredAt`)
    const sourceDigest = sourceDigestFor(entry)
    const archiveDigest = archiveDigestFor({
      sdkSessionId,
      generation,
      seq: entry.seq,
      eventId,
      streamId,
      occurredAt,
      kind: entry.event.kind,
      ledgerDigest: entry.digest,
      sourceDigest,
      previousArchiveDigest
    })
    db.run(
      `INSERT INTO conversation_ledger_events(
         sdk_session_id, generation, seq, event_id, stream_id, occurred_at, kind,
         ledger_digest, source_digest, previous_archive_digest, archive_digest, payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sdkSessionId,
        generation,
        entry.seq,
        eventId,
        streamId,
        occurredAt,
        entry.event.kind,
        entry.digest ?? null,
        sourceDigest,
        previousArchiveDigest,
        archiveDigest,
        JSON.stringify(entry)
      ]
    )
    previousArchiveDigest = archiveDigest
  }
  return entries.length > 0 ? previousArchiveDigest : undefined
}

function updateStream(
  db: WorkflowLedgerDatabase,
  existing: StreamRow,
  identity: ReturnType<typeof normalizeIdentity>,
  generation: number
): void {
  db.run(
    `UPDATE conversation_ledger_streams
     SET current_session_id = ?, provider_id = ?, model = ?, engine = ?, current_generation = ?, updated_at = ?
     WHERE sdk_session_id = ?`,
    [
      identity.currentSessionId,
      identity.providerId,
      identity.model,
      identity.engine ?? null,
      generation,
      Math.max(existing.updatedAt, identity.updatedAt),
      identity.sdkSessionId
    ]
  )
}

function assertImmutableOwnership(stream: StreamRow, identity: ReturnType<typeof normalizeIdentity>): void {
  const expected = {
    sourceSdkSessionId: stream.sourceSdkSessionId,
    projectId: stream.projectId,
    workspaceId: stream.workspaceId,
    goalId: stream.goalId,
    workItemId: stream.workItemId,
    sourceCwd: stream.sourceCwd
  }
  const actual = {
    sourceSdkSessionId: identity.sourceSdkSessionId,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    goalId: identity.goalId,
    workItemId: identity.workItemId,
    sourceCwd: identity.sourceCwd
  }
  if (stableValueDigest(expected) !== stableValueDigest(actual)) {
    throw new Error(`Conversation Ledger ${stream.sdkSessionId} immutable ownership changed`)
  }
}

function verifyArchiveEventChain(rows: readonly EventRow[]): void {
  let previousArchiveDigest = ARCHIVE_GENESIS_DIGEST
  let previousSeq = 0
  for (const row of rows) {
    const entry = parseEventPayload(row)
    if (row.seq <= previousSeq || entry.seq !== row.seq || entry.eventId !== row.eventId ||
        entry.streamId !== row.streamId || (entry.occurredAt ?? 0) !== row.occurredAt ||
        entry.event.kind !== row.kind || (entry.digest ?? undefined) !== row.ledgerDigest ||
        sourceDigestFor(entry) !== row.sourceDigest || row.previousArchiveDigest !== previousArchiveDigest) {
      throw new Error(`Conversation Ledger archive event ${row.sdkSessionId}/${row.generation}/${row.seq} is inconsistent`)
    }
    const expected = archiveDigestFor({
      sdkSessionId: row.sdkSessionId,
      generation: row.generation,
      seq: row.seq,
      eventId: row.eventId,
      streamId: row.streamId,
      occurredAt: row.occurredAt,
      kind: row.kind,
      ledgerDigest: row.ledgerDigest,
      sourceDigest: row.sourceDigest,
      previousArchiveDigest
    })
    if (expected !== row.archiveDigest) {
      throw new Error(`Conversation Ledger archive digest mismatch at ${row.sdkSessionId}/${row.generation}/${row.seq}`)
    }
    previousArchiveDigest = row.archiveDigest
    previousSeq = row.seq
  }
}

function sourceDigestFor(entry: TranscriptEntry): string {
  return stableValueDigest(entry)
}

function archiveDigestFor(input: {
  sdkSessionId: string
  generation: number
  seq: number
  eventId: string
  streamId: string
  occurredAt: number
  kind: string
  ledgerDigest?: string
  sourceDigest: string
  previousArchiveDigest: string
}): string {
  return stableValueDigest({ schemaVersion: 1, ...input })
}

function normalizeIdentity(input: ConversationLedgerArchiveIdentity) {
  return {
    sdkSessionId: requiredText(input.sdkSessionId, 'sdkSessionId'),
    currentSessionId: requiredText(input.currentSessionId, 'currentSessionId'),
    sourceSdkSessionId: optionalText(input.sourceSdkSessionId),
    projectId: optionalText(input.projectId),
    workspaceId: optionalText(input.workspaceId),
    goalId: optionalText(input.goalId),
    workItemId: optionalText(input.workItemId),
    sourceCwd: requiredText(input.sourceCwd, 'sourceCwd'),
    providerId: requiredText(input.providerId, 'providerId'),
    model: input.model.trim(),
    engine: input.engine,
    createdAt: finiteTimestamp(input.createdAt, 'createdAt'),
    updatedAt: finiteTimestamp(input.updatedAt ?? Date.now(), 'updatedAt')
  }
}

function findStream(db: WorkflowLedgerDatabase, sdkSessionId: string): StreamRow | null {
  const stmt = db.prepare(
    `SELECT sdk_session_id, origin_session_id, current_session_id, source_sdk_session_id,
            project_id, workspace_id, goal_id, work_item_id, source_cwd,
            provider_id, model, engine, current_generation, created_at, updated_at
     FROM conversation_ledger_streams WHERE sdk_session_id = ?`
  )
  try {
    stmt.bind([sdkSessionId])
    if (!stmt.step()) return null
    return decodeStream(stmt.getAsObject())
  } finally {
    stmt.free()
  }
}

function readStreams(db: WorkflowLedgerDatabase): StreamRow[] {
  const stmt = db.prepare(
    `SELECT sdk_session_id, origin_session_id, current_session_id, source_sdk_session_id,
            project_id, workspace_id, goal_id, work_item_id, source_cwd,
            provider_id, model, engine, current_generation, created_at, updated_at
     FROM conversation_ledger_streams ORDER BY sdk_session_id`
  )
  const rows: StreamRow[] = []
  try {
    while (stmt.step()) rows.push(decodeStream(stmt.getAsObject()))
  } finally {
    stmt.free()
  }
  return rows
}

function requireGeneration(db: WorkflowLedgerDatabase, sdkSessionId: string, generation: number): GenerationRow {
  const stmt = db.prepare(
    `SELECT sdk_session_id, generation, entry_count, ledger_mode, ledger_head_digest,
            archive_head_digest, supersedes_generation, rewrite_reason, created_at, updated_at
     FROM conversation_ledger_generations WHERE sdk_session_id = ? AND generation = ?`
  )
  try {
    stmt.bind([sdkSessionId, generation])
    if (!stmt.step()) throw new Error(`Conversation Ledger generation ${sdkSessionId}/${generation} is missing`)
    return decodeGeneration(stmt.getAsObject())
  } finally {
    stmt.free()
  }
}

function readGenerations(db: WorkflowLedgerDatabase): GenerationRow[] {
  const stmt = db.prepare(
    `SELECT sdk_session_id, generation, entry_count, ledger_mode, ledger_head_digest,
            archive_head_digest, supersedes_generation, rewrite_reason, created_at, updated_at
     FROM conversation_ledger_generations ORDER BY sdk_session_id, generation`
  )
  const rows: GenerationRow[] = []
  try {
    while (stmt.step()) rows.push(decodeGeneration(stmt.getAsObject()))
  } finally {
    stmt.free()
  }
  return rows
}

function readEventRows(db: WorkflowLedgerDatabase, sdkSessionId: string, generation: number): EventRow[] {
  const stmt = db.prepare(
    `SELECT sdk_session_id, generation, seq, event_id, stream_id, occurred_at, kind,
            ledger_digest, source_digest, previous_archive_digest, archive_digest, payload
     FROM conversation_ledger_events
     WHERE sdk_session_id = ? AND generation = ? ORDER BY seq`
  )
  const rows: EventRow[] = []
  try {
    stmt.bind([sdkSessionId, generation])
    while (stmt.step()) rows.push(decodeEvent(stmt.getAsObject()))
  } finally {
    stmt.free()
  }
  return rows
}

function decodeStream(row: Record<string, unknown>): StreamRow {
  return {
    sdkSessionId: requiredText(row.sdk_session_id, 'stream.sdk_session_id'),
    originSessionId: requiredText(row.origin_session_id, 'stream.origin_session_id'),
    currentSessionId: requiredText(row.current_session_id, 'stream.current_session_id'),
    sourceSdkSessionId: nullableText(row.source_sdk_session_id, 'stream.source_sdk_session_id'),
    projectId: nullableText(row.project_id, 'stream.project_id'),
    workspaceId: nullableText(row.workspace_id, 'stream.workspace_id'),
    goalId: nullableText(row.goal_id, 'stream.goal_id'),
    workItemId: nullableText(row.work_item_id, 'stream.work_item_id'),
    sourceCwd: requiredText(row.source_cwd, 'stream.source_cwd'),
    providerId: requiredText(row.provider_id, 'stream.provider_id'),
    model: text(row.model, 'stream.model'),
    engine: nullableText(row.engine, 'stream.engine') as EngineKind | undefined,
    currentGeneration: positiveInteger(row.current_generation, 'stream.current_generation'),
    createdAt: finiteTimestamp(row.created_at, 'stream.created_at'),
    updatedAt: finiteTimestamp(row.updated_at, 'stream.updated_at')
  }
}

function decodeGeneration(row: Record<string, unknown>): GenerationRow {
  const mode = requiredText(row.ledger_mode, 'generation.ledger_mode')
  if (mode !== 'empty' && mode !== 'legacy' && mode !== 'sealed') {
    throw new Error(`Conversation Ledger generation mode ${mode} is invalid`)
  }
  return {
    sdkSessionId: requiredText(row.sdk_session_id, 'generation.sdk_session_id'),
    generation: positiveInteger(row.generation, 'generation.generation'),
    entryCount: nonNegativeInteger(row.entry_count, 'generation.entry_count'),
    ledgerMode: mode,
    ledgerHeadDigest: nullableText(row.ledger_head_digest, 'generation.ledger_head_digest'),
    archiveHeadDigest: nullableText(row.archive_head_digest, 'generation.archive_head_digest'),
    supersedesGeneration: nullablePositiveInteger(row.supersedes_generation, 'generation.supersedes_generation'),
    rewriteReason: requiredText(row.rewrite_reason, 'generation.rewrite_reason'),
    createdAt: finiteTimestamp(row.created_at, 'generation.created_at'),
    updatedAt: finiteTimestamp(row.updated_at, 'generation.updated_at')
  }
}

function decodeEvent(row: Record<string, unknown>): EventRow {
  return {
    sdkSessionId: requiredText(row.sdk_session_id, 'event.sdk_session_id'),
    generation: positiveInteger(row.generation, 'event.generation'),
    seq: positiveInteger(row.seq, 'event.seq'),
    eventId: requiredText(row.event_id, 'event.event_id'),
    streamId: requiredText(row.stream_id, 'event.stream_id'),
    occurredAt: finiteTimestamp(row.occurred_at, 'event.occurred_at'),
    kind: requiredText(row.kind, 'event.kind'),
    ledgerDigest: nullableText(row.ledger_digest, 'event.ledger_digest'),
    sourceDigest: digestText(row.source_digest, 'event.source_digest'),
    previousArchiveDigest: digestText(row.previous_archive_digest, 'event.previous_archive_digest'),
    archiveDigest: digestText(row.archive_digest, 'event.archive_digest'),
    payload: requiredText(row.payload, 'event.payload')
  }
}

function parseEventPayload(row: EventRow): TranscriptEntry {
  try {
    const parsed = JSON.parse(row.payload) as TranscriptEntry
    if (!parsed || typeof parsed !== 'object' || !Number.isInteger(parsed.seq) || !parsed.event) {
      throw new Error('payload shape is invalid')
    }
    return parsed
  } catch (error) {
    throw new Error(`Conversation Ledger archive payload ${row.sdkSessionId}/${row.generation}/${row.seq} is invalid: ${safeError(error)}`)
  }
}

function selectTextColumn(
  db: WorkflowLedgerDatabase,
  sql: string,
  values: readonly string[],
  column: string
): string[] {
  const rows: string[] = []
  const stmt = db.prepare(sql)
  try {
    stmt.bind([...values])
    while (stmt.step()) rows.push(requiredText(stmt.getAsObject()[column], column))
  } finally {
    stmt.free()
  }
  return rows
}

function countRows(db: WorkflowLedgerDatabase, sql: string, values: readonly string[]): number {
  const stmt = db.prepare(sql)
  try {
    stmt.bind([...values])
    if (!stmt.step()) return 0
    return nonNegativeIntegerValue(stmt.getAsObject().count, 'Conversation Ledger count')
  } finally {
    stmt.free()
  }
}

function generationKey(sdkSessionId: string, generation: number): string {
  return `${sdkSessionId}\n${generation}`
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  return value
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function nullableText(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined
  return requiredText(value, field)
}

function digestText(value: unknown, field: string): string {
  const digest = requiredText(value, field)
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${field} must be a SHA-256 digest`)
  return digest
}

function finiteTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be a timestamp`)
  return value
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be positive`)
  return value
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be non-negative`)
  return value
}

function nonNegativeIntegerValue(value: unknown, field: string): number {
  return nonNegativeInteger(value, field)
}

function nullablePositiveInteger(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined) return undefined
  return positiveInteger(value, field)
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
