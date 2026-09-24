import type { TaskSnapshotRecord } from '../../shared/types'
import type { ModelAttemptRecord, ModelAttemptEventRecord } from '../../shared/model-attempt-types'
import type { WorkflowArtifactEdgeRecord, WorkflowArtifactLocationRecord } from '../../shared/workflow-types'
import { selectClosedWorkflowLedger, type WorkflowLedgerClosedSelection } from '../task/workflow-ledger-export-scope'
import { readTaskSnapshotDatabase, type TaskSnapshotDatabase } from '../task/task-snapshot'
import { readCanonicalRecoverySessions, upsertWorkflowRecoverySession } from '../task/workflow-ledger-recovery'
import { readArtifactEdges, readArtifactLocations, verifyWorkflowArtifactGraph } from '../task/workflow-ledger-artifact-graph-query'
import { readArtifactLifecycles, readArtifactPurges, readArtifactRetentionRevisions, importArtifactLifecycleSlice } from '../task/artifact-lifecycle-store'
import { selectModelAttempts } from '../task/model-attempt-store'
import { importModelAttemptRecords } from '../data-lifecycle/model-attempt-import'
import { insertArtifactEdge, insertArtifactLocation, reboundEvidencePayload, workflowEvidenceInput } from '../data-lifecycle/workflow-project-import'
import { insertGoal, insertWorkItem, insertRun, insertArtifact, insertAcceptance, insertEvidenceLink } from '../task/workflow-ledger-sql'
import { appendWorkflowEvent, verifyWorkflowLedger } from '../task/workflow-ledger-store'
import { readAndVerifyEvents, readGoals, readWorkItems, readRuns, readArtifacts, readAcceptances, readEvidenceLinks } from '../task/workflow-ledger-query'
import { appendWorkflowEvidence, readAllWorkflowEvidenceForIntegrity, verifyWorkflowEvidence } from '../task/workflow-evidence-store'
import { backfillTaskEvidence, selectTaskEvidence, verifyTaskEvidence } from '../task/task-evidence-store'
import { canonicalJson, digest } from '../task/workflow-ledger-codec'
import { isLocalProjectWorkspaceAuthorityEvent } from '../project-workspace/ledger-import-authority'
import { verifyConversationLedgerArchive } from '../task/conversation-ledger-store'

type Row = Record<string, string | number | null>
export interface HandoffLedger extends WorkflowLedgerClosedSelection {
  snapshots: TaskSnapshotRecord[]
  artifactEdges: WorkflowArtifactEdgeRecord[]
  artifactLocations: WorkflowArtifactLocationRecord[]
  lifecycles: ReturnType<typeof readArtifactLifecycles>
  purges: ReturnType<typeof readArtifactPurges>
  retentionRevisions: ReturnType<typeof readArtifactRetentionRevisions>
  modelAttempts: ModelAttemptRecord[]
  modelAttemptEvents: ModelAttemptEventRecord[]
  conversation: { streams: Row[]; generations: Row[]; events: Row[] }
}
export type Baselines = Record<string, string>
export type MergeGuard = (key: string, actual: unknown, incoming: unknown, immutable?: boolean) => void

export async function captureHandoffLedger(root: string, sessionId: string, workItemId?: string): Promise<HandoffLedger> {
  return readTaskSnapshotDatabase(root, db => {
    verifyWorkflowLedger(db); verifyTaskEvidence(db); verifyWorkflowEvidence(db)
    const scope = workItemId ? { sessionId, workItemId } : { sessionId }
    const selected = selectClosedWorkflowLedger(db, scope)
    if (selected.runs.some(run => run.sessionId !== sessionId)) throw new Error('任务闭包包含其他 Session，请先解除共享 WorkItem 或父子运行依赖')
    const artifactIds = new Set(selected.artifacts.map(item => item.id))
    const artifactEdges = readArtifactEdges(db).filter(item => artifactIds.has(item.fromArtifactId) || artifactIds.has(item.toArtifactId))
    if (artifactEdges.some(item => !artifactIds.has(item.fromArtifactId) || !artifactIds.has(item.toArtifactId))) throw new Error('成果依赖另一任务，当前单任务交接不能闭合')
    const modelAttempts: ModelAttemptRecord[] = [], modelAttemptEvents: ModelAttemptEventRecord[] = []
    for (const run of selected.runs) {
      let cursor: string | undefined
      do {
        const page = selectModelAttempts(db, { runId: run.id, limit: 500, cursor })
        modelAttempts.push(...page.attempts); modelAttemptEvents.push(...page.events)
        cursor = page.nextCursor
      } while (cursor)
    }
    if (modelAttempts.some(item => item.status === 'started')) throw new Error('模型调用尚未结束，不能交接')
    const streams = query(db, 'SELECT * FROM conversation_ledger_streams WHERE current_session_id = ? OR origin_session_id = ?', [sessionId, sessionId])
    const sdkIds = new Set(streams.map(row => String(row.sdk_session_id)))
    const conversation = {
      streams,
      generations: query(db, 'SELECT * FROM conversation_ledger_generations').filter(row => sdkIds.has(String(row.sdk_session_id))),
      events: query(db, 'SELECT * FROM conversation_ledger_events').filter(row => sdkIds.has(String(row.sdk_session_id)))
    }
    verifyConversationLedgerArchive(db)
    return {
      ...selected,
      events: selected.events.filter(event => !isLocalProjectWorkspaceAuthorityEvent(event)),
      snapshots: readCanonicalRecoverySessions(db).filter(item => item.sessionId === sessionId),
      artifactEdges,
      artifactLocations: readArtifactLocations(db).filter(item => artifactIds.has(item.artifactId)),
      lifecycles: readArtifactLifecycles(db).filter(item => artifactIds.has(item.artifactId)),
      purges: readArtifactPurges(db).filter(item => artifactIds.has(item.artifactId)),
      retentionRevisions: readArtifactRetentionRevisions(db).filter(item => artifactIds.has(item.artifactId)),
      modelAttempts, modelAttemptEvents, conversation
    }
  })
}

/** Original chains remain in the signed source bundle. Local chains append their own positions. */
export function importHandoffLedger(db: TaskSnapshotDatabase, source: HandoffLedger, targetCwd: string, guard: MergeGuard): void {
  const groups = [
    ['goals', source.goals, readGoals(db), insertGoal, false],
    ['workItems', source.workItems, readWorkItems(db), insertWorkItem, false],
    ['runs', source.runs, readRuns(db), insertRun, true],
    ['artifacts', source.artifacts, readArtifacts(db), insertArtifact, true],
    ['acceptances', source.acceptances, readAcceptances(db), insertAcceptance, false],
    ['evidenceLinks', source.evidenceLinks, readEvidenceLinks(db), insertEvidenceLink, true]
  ] as const
  for (const [name, records, current, insert, immutable] of groups) {
    for (const record of records) {
      const actual = current.find(item => item.id === record.id)
      guard(`ledger:${name}:${record.id}`, actual, record, immutable)
      if (actual && canonicalJson(actual) === canonicalJson(record)) continue
      // Each tuple binds the writer to exactly its record kind.
      ;(insert as (db: TaskSnapshotDatabase, item: unknown) => void)(db, record)
    }
  }
  for (const run of source.runs) {
    const prior = query(db, 'SELECT payload FROM task_runs WHERE id = ?', [run.id])[0]
    guard(`taskRun:${run.id}`, prior ? JSON.parse(String(prior.payload)) : undefined, run.taskRun, true)
    db.run('INSERT INTO task_runs(id,session_id,updated_at,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING',
      [run.id, run.sessionId, run.updatedAt, canonicalJson(run.taskRun)])
  }
  for (const edge of source.artifactEdges) {
    const actual = readArtifactEdges(db).find(item => item.id === edge.id)
    guard(`edge:${edge.id}`, actual, edge, true)
    if (!actual) insertArtifactEdge(db, edge)
  }
  for (const location of source.artifactLocations) {
    const actual = readArtifactLocations(db).find(item => item.id === location.id)
    guard(`location:${location.id}`, actual, location, true)
    if (!actual) insertArtifactLocation(db, location)
  }
  backfillTaskEvidence(db, source.runs.map(run => run.taskRun), source.runs.map(run => ({ sessionId: run.sessionId, projectId: run.projectId })))
  const evidence = new Map(selectTaskEvidence(db).map(item => [item.evidenceId, item]))
  for (const record of source.taskEvidence) {
    const actual = evidence.get(record.evidenceId)
    if (!actual || canonicalJson(stripChain(actual)) !== canonicalJson(stripChain(record))) throw new Error(`Task evidence 原文不匹配: ${record.evidenceId}`)
  }
  const workflowEvidence = source.workflowEvidence.map(record => appendWorkflowEvidence(db, workflowEvidenceInput(record), {
    source: record.source, verifier: record.verifier, observedAt: record.observedAt, createdAt: record.createdAt
  }))
  const workflowEvidenceById = new Map(workflowEvidence.map(item => [item.evidenceId, item]))
  for (const event of [...source.events].sort((a, b) => a.seq - b.seq)) {
    appendWorkflowEvent(db, {
      eventId: event.eventId, streamId: event.streamId, entityType: event.entityType, entityId: event.entityId,
      kind: event.kind, payload: reboundEvidencePayload(event, evidence, workflowEvidenceById),
      occurredAt: event.occurredAt, causationId: event.causationId, correlationId: event.correlationId
    }, { projectId: event.projectId, goalId: event.goalId, workItemId: event.workItemId, runId: event.runId, sessionId: event.sessionId })
  }
  importArtifactLifecycleSlice(db, source.lifecycles, source.purges, source.retentionRevisions)
  importModelAttemptRecords(db, source.modelAttempts)
  importConversation(db, source.conversation, guard)
  for (const snapshot of source.snapshots) {
    const next = placedSnapshot(snapshot, targetCwd)
    const actual = readCanonicalRecoverySessions(db).find(item => item.id === snapshot.id)
    guard(`snapshot:${snapshot.id}`, actual, next)
    db.run('INSERT INTO task_snapshots(id,session_id,updated_at,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, updated_at=excluded.updated_at,payload=excluded.payload',
      [next.id, next.sessionId, next.updatedAt, canonicalJson(next)])
    upsertWorkflowRecoverySession(db, next)
  }
  verifyWorkflowLedger(db); verifyTaskEvidence(db); verifyWorkflowEvidence(db); verifyWorkflowArtifactGraph(db)
}

export function ledgerBaselines(source: HandoffLedger): Baselines {
  const result: Baselines = {}
  for (const kind of ['goals', 'workItems', 'runs', 'artifacts', 'acceptances', 'evidenceLinks'] as const) {
    for (const record of source[kind]) result[`ledger:${kind}:${record.id}`] = digest(record)
  }
  for (const snapshot of source.snapshots) result[`snapshot:${snapshot.id}`] = digest(snapshot)
  for (const [kind, rows] of Object.entries(source.conversation)) {
    for (const row of rows) result[`conversation:${kind}:${conversationKey(kind, row)}`] = digest(row)
  }
  return result
}

export function placedSnapshot(source: TaskSnapshotRecord, targetCwd: string): TaskSnapshotRecord {
  return {
    ...source, projectPath: targetCwd,
    meta: { ...source.meta, cwd: targetCwd, sourceCwd: targetCwd, permissionMode: 'default', status: 'idle',
      taskExecutionAuthorityRequired: true, worktreePath: undefined, repoRoot: undefined, isolated: false, responsesContext: undefined },
    execution: { ...source.execution, status: 'idle', resumeSessionAt: undefined },
    run: undefined, replayCandidate: undefined, worktree: undefined,
    subtasks: [], dagExecutions: [], dagRuntimes: []
  }
}

function importConversation(db: TaskSnapshotDatabase, source: HandoffLedger['conversation'], guard: MergeGuard): void {
  const groups = [['streams', 'conversation_ledger_streams', ['sdk_session_id']],
    ['generations', 'conversation_ledger_generations', ['sdk_session_id', 'generation']],
    ['events', 'conversation_ledger_events', ['sdk_session_id', 'generation', 'seq']]] as const
  for (const [kind, table, keys] of groups) {
    const columns = new Set(query(db, `PRAGMA table_info(${table})`).map(row => String(row.name)))
    for (const row of source[kind]) {
      if (Object.keys(row).length !== columns.size || Object.keys(row).some(key => !columns.has(key))) throw new Error(`会话账本列不兼容: ${table}`)
      const where = keys.map(key => `${key} = ?`).join(' AND ')
      const actual = query(db, `SELECT * FROM ${table} WHERE ${where}`, keys.map(key => row[key]))[0]
      guard(`conversation:${kind}:${conversationKey(kind, row)}`, actual, row, kind === 'events')
      if (actual && canonicalJson(actual) === canonicalJson(row)) continue
      const names = Object.keys(row)
      db.run(`INSERT INTO ${table}(${names.join(',')}) VALUES (${names.map(() => '?').join(',')}) ON CONFLICT(${keys.join(',')}) DO UPDATE SET ${names.filter(key => !(keys as readonly string[]).includes(key)).map(key => `${key}=excluded.${key}`).join(',')}`, names.map(name => row[name]))
    }
  }
  verifyConversationLedgerArchive(db)
}
function conversationKey(kind: string, row: Row): string { return JSON.stringify([row.sdk_session_id, ...(kind !== 'streams' ? [row.generation] : []), ...(kind === 'events' ? [row.seq] : [])]) }
export function query(db: TaskSnapshotDatabase, sql: string, args: (string | number | null)[] = []): Row[] {
  const statement = db.prepare(sql), rows: Row[] = []
  try { statement.bind(args); while (statement.step()) rows.push(statement.getAsObject() as Row) } finally { statement.free() }
  return rows
}
function stripChain<T>(record: T): unknown {
  const { seq: _seq, prevDigest: _prev, digest: _digest, ...value } = record as Record<string, unknown>
  return value
}
