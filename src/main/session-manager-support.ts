import type {
  AgentEvent,
  AgentEventIdentity,
  DispatchSubagentsInput,
  SessionMeta,
  TaskDagExecutionView,
  TaskDagRuntimeSnapshot,
  TaskRunRecord,
  TaskSnapshotReason,
  TaskSnapshotRecord,
  TaskSnapshotSubtaskState,
  TranscriptEntry
} from '../shared/types'
import { settingsForCaoGenDrive } from './model/drive'
import type { Engine } from './engine'
import { getProvider } from './providers'
import {
  builtinOpenAiPricingForModel,
  estimateProviderCostUsd,
  providerPricingForModel
} from './provider/providerAdvancedConfig'
import { getSettings } from './settings'
import { runHasUnresolvedEffects } from './task/effect-runtime'
import {
  recoverWorkflowTestFailureIngresses,
  WorkflowTestFailureRuntime
} from './task/workflow-test-failure-runtime'
import {
  bindWorkflowRunToCanonicalWorkItem,
  recoverWorkflowRunCanonicalBindings
} from './task/workflow-run-canonical-binding'
import {
  ensureSupervisorRunBinding,
  recoverSupervisorRunBindings
} from './task/supervisor-taskrun-bridge'
import { SupervisorStateStore } from './task/supervisor-state'
import { buildTaskSnapshot, saveTaskSnapshot } from './task/task-snapshot'
import type { WorkflowAcceptanceFailureResult } from './task/workflow-acceptance-failure-ingress'

export interface SessionNotificationState {
  turnActive: boolean
  permissionNotified: boolean
  terminalNotified: boolean
}

export interface ManagedSessionCreationOptions {
  /** Main-only ID reserved by a durable task submission; never forwarded from renderer options. */
  reservedSessionId?: string
  awaitStart?: boolean
  retainJournal?: boolean
  /** Durable owner binding that must commit before the engine can emit events. */
  beforeStart?: (meta: Readonly<SessionMeta>) => Promise<void>
}

const unresolvedEffectSendError = '当前任务存在尚未完成真实状态对账的外部副作用，已阻止继续发送；请先完成效果对账。'

export function sendableSession(
  session: Engine | undefined,
  run?: TaskRunRecord
): Engine | null {
  if (!session) return null
  if (runHasUnresolvedEffects(run)) {
    session.rejectSend(unresolvedEffectSendError)
    return null
  }
  if (session.meta.status !== 'running' && session.meta.status !== 'starting') return session
  session.rejectSend('上一轮仍在运行,请等待完成或中断后再发送。')
  return null
}

export function rejectSessionSend(session: Engine, message: string): false {
  session.rejectSend(message)
  return false
}

export function managedSessionSendGateError(
  snapshotReplayPending: boolean,
  supervisorBlocked: boolean
): string | undefined {
  if (snapshotReplayPending) return '快照恢复仍在按顺序续跑未完成步骤；请等待恢复完成或先中断。'
  if (supervisorBlocked) return 'Supervisor 已暂停或仅授权重试；必须通过受信控制路径恢复后才能继续执行。'
  return undefined
}

export function managedTaskRunSendGateError(
  meta: SessionMeta,
  hasUnresolvedEffects: boolean,
  budgetError: string | null
): string | undefined {
  if (meta.workspaceId && !meta.workItemId) {
    return '当前会话已关联 Workspace，但未指定 WorkItem；已阻止创建脱离业务任务的 Run。'
  }
  if (hasUnresolvedEffects) {
    return unresolvedEffectSendError
  }
  return budgetError ?? undefined
}

interface Lookup<T> { get(key: string): T | undefined }
type WorkflowSession = { meta: SessionMeta; getTranscript(): TranscriptEntry[] }
interface SessionWorkflowRuntimeDependencies {
  sessions: Lookup<WorkflowSession>
  runs: Lookup<TaskRunRecord>
  snapshotState(sessionId: string, seq: number): { total: number; lastSeq: number; lastEventId?: string }
  subtasks(sessionId: string): TaskSnapshotSubtaskState[]
  dagExecutions(sessionId: string): TaskDagExecutionView[]
  dagRuntimes(sessionId: string): TaskDagRuntimeSnapshot[]
  onAcceptanceFailure?(result: WorkflowAcceptanceFailureResult): Promise<void> | void
}

export interface SessionWorkflowRuntimeOptions {
  /** Main-process userData root; omitted by isolated canonical-only callers. */
  userDataRoot?: string
}

export class SessionWorkflowRuntime {
  private readonly testFailure: WorkflowTestFailureRuntime
  private readonly blockedRecoveries = new Set<string>()
  private readonly userDataRoot?: string
  private readonly supervisorStore?: SupervisorStateStore

  constructor(
    private readonly dependencies: SessionWorkflowRuntimeDependencies,
    options: SessionWorkflowRuntimeOptions = {}
  ) {
    this.userDataRoot = options.userDataRoot
    this.supervisorStore = options.userDataRoot
      ? new SupervisorStateStore(options.userDataRoot)
      : undefined
    this.testFailure = new WorkflowTestFailureRuntime({
      context: (sessionId) => {
        const session = dependencies.sessions.get(sessionId)
        return session && {
          meta: { ...session.meta },
          run: dependencies.runs.get(sessionId),
          transcript: session.getTranscript()
        }
      },
      captureEventBarrier: (sessionId, identity) => this.captureSnapshot(
        sessionId, 'important-event', identity.seq, 'tool-result', identity.eventId, true),
      onAcceptanceFailure: dependencies.onAcceptanceFailure
    })
  }

  captureSnapshot(
    sessionId: string,
    reason: TaskSnapshotReason,
    seq: number,
    eventKind?: AgentEvent['kind'],
    eventId?: string,
    strict = false
  ): () => Promise<void> {
    const session = this.dependencies.sessions.get(sessionId)
    if (!session) return strict
      ? async () => { throw new Error(`strict task snapshot barrier lost active session: ${sessionId}`) }
      : async () => undefined
    const state = this.dependencies.snapshotState(sessionId, seq)
    const snapshot = buildTaskSnapshot({
      meta: session.meta,
      transcript: session.getTranscript(),
      lastSeq: Math.max(seq, state.lastSeq),
      lastEventId: eventId ?? state.lastEventId,
      lastEventKind: eventKind,
      eventCount: state.total,
      reason,
      run: this.dependencies.runs.get(sessionId),
      subtasks: this.dependencies.subtasks(sessionId),
      dagExecutions: this.dependencies.dagExecutions(sessionId),
      dagRuntimes: this.dependencies.dagRuntimes(sessionId)
    })
    return async () => this.bindSnapshot(await saveTaskSnapshot(snapshot))
  }

  handleEvent(sessionId: string, event: AgentEvent, identity: AgentEventIdentity): void {
    void this.testFailure.handleEvent(sessionId, event, identity).catch((error) => {
      console.error('[caogen] structured test failure ingress rejected:', error)
    })
  }

  flush(sessionId: string): Promise<void> {
    return this.testFailure.flush(sessionId)
  }

  recoveryBlocks(): ReadonlySet<string> {
    return this.blockedRecoveries
  }

  assertRecoveryResolved(sessionId: string): void {
    if (this.blockedRecoveries.has(sessionId)) {
      throw new Error(`workflow recovery is unresolved; snapshot deletion blocked:${sessionId}`)
    }
  }

  async persistShutdownSnapshot(sessionId: string, persist: () => Promise<void>): Promise<void> {
    try {
      await this.flush(sessionId)
      await persist()
    } catch (error) {
      console.error('[caogen] workflow ingress flush failed; preserving existing recovery snapshot:', error)
    }
  }

  async bindSnapshot(snapshot: Pick<TaskSnapshotRecord, 'meta' | 'run'>): Promise<void> {
    if (!snapshot.run) return
    if (this.userDataRoot && this.supervisorStore) {
      await ensureSupervisorRunBinding(snapshot.meta, snapshot.run, {
        rootDir: this.userDataRoot,
        store: this.supervisorStore
      })
      return
    }
    await bindWorkflowRunToCanonicalWorkItem(snapshot.meta, snapshot.run)
  }

  async recover(snapshots: readonly TaskSnapshotRecord[]): Promise<Set<string>> {
    const runBindings = this.userDataRoot && this.supervisorStore
      ? await recoverSupervisorRunBindings(snapshots, {
          rootDir: this.userDataRoot,
          store: this.supervisorStore
        })
      : await recoverWorkflowRunCanonicalBindings(snapshots)
    if (runBindings.failures.length > 0) {
      console.error(`[caogen] ${runBindings.failures.length} canonical Run binding(s) need manual reconciliation`)
    }
    const testFailures = await recoverWorkflowTestFailureIngresses(snapshots)
    if (testFailures.failures.length > 0) {
      console.error(`[caogen] ${testFailures.failures.length} structured test failure(s) need manual reconciliation`)
    }
    const failedRunIds = new Set(runBindings.failures.map((failure) => failure.runId))
    const failedEventIds = new Set(testFailures.failures.map((failure) => failure.sourceEventId))
    this.blockedRecoveries.clear()
    for (const sessionId of snapshots
      .filter((snapshot) =>
        (snapshot.run !== undefined && failedRunIds.has(snapshot.run.id)) ||
        snapshot.transcript.some((entry) => entry.eventId !== undefined && failedEventIds.has(entry.eventId)))
      .map((snapshot) => snapshot.sessionId)) this.blockedRecoveries.add(sessionId)
    return new Set(this.blockedRecoveries)
  }
}

export function subagentCwd(
  task: DispatchSubagentsInput['tasks'][number],
  input: DispatchSubagentsInput,
  parentMeta: SessionMeta
): string {
  return task.cwd ?? input.cwd ?? parentMeta.sourceCwd ?? parentMeta.cwd
}

export function shouldResumeDagFinalization(event: AgentEvent): boolean {
  return event.kind === 'init' ||
    event.kind === 'turn-result' ||
    (event.kind === 'status' && event.status === 'idle')
}

export function subtaskStatusFromSession(
  status: SessionMeta['status'] | undefined
): TaskSnapshotSubtaskState['status'] {
  if (status === 'starting' || status === 'running') return 'running'
  if (status === 'error') return 'failed'
  if (status === 'closed') return 'closed'
  return 'pending'
}

export function shouldPersistActiveRegistry(event: AgentEvent): boolean {
  return event.kind === 'init' ||
    event.kind === 'meta' ||
    event.kind === 'turn-result' ||
    event.kind === 'status'
}

export function shouldDispatchChildResult(
  meta: SessionMeta | undefined,
  event: AgentEvent,
  parentIsActive: (sessionId: string) => boolean
): event is Extract<AgentEvent, { kind: 'turn-result' }> {
  return event.kind === 'turn-result' &&
    Boolean(meta?.parentSessionId) &&
    parentIsActive(meta!.parentSessionId!)
}

export function requireDagPromptAccepted(accepted: boolean): void {
  if (!accepted) throw new Error('DAG child prompt was rejected before execution started')
}

export function buildTaskSnapshotReplayPrompts(snapshot: TaskSnapshotRecord): string[] {
  const pendingSteps = (snapshot.run?.steps ?? [])
    .filter((step) => step.status !== 'completed' && step.status !== 'failed' && step.status !== 'cancelled')
    .filter((step) => typeof step.requestText === 'string' && step.requestText.trim())
    .sort((a, b) => a.sequence - b.sequence)
  if (pendingSteps.length > 0) {
    return pendingSteps.map((step) =>
      buildTaskStepReplayPrompt(snapshot, step.requestText ?? '', step.messageId, step.sequence)
    )
  }
  const replay = snapshot.replayCandidate
  return replay ? [buildTaskStepReplayPrompt(snapshot, replay.text, replay.messageId, replay.seq)] : []
}

export function subtaskStatusFromDag(
  status: TaskDagExecutionView['tasks'][number]['status']
): TaskSnapshotSubtaskState['status'] {
  if (status === 'success') return 'success'
  if (status === 'failed') return 'failed'
  if (status === 'running') return 'running'
  return 'pending'
}

export function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export function cleanOneLine(text: string, fallback: string, max = 80): string {
  const clean = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return (clean || fallback).slice(0, max)
}

export async function mapWithConcurrencyInOrder<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (true) {
        const index = nextIndex++
        if (index >= items.length) return
        results[index] = await task(items[index], index)
      }
    }
  )
  await Promise.all(workers)
  return results
}

export function normalizeTaskId(value: string | undefined, fallback: string): string {
  const clean = typeof value === 'string' ? value.trim() : ''
  if (!clean) return fallback
  return clean.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 80) || fallback
}

export function effectiveBudgetUsd(meta: SessionMeta): number {
  const sessionBudget = normalizePositiveNumber(meta.budgetUsd)
  if (sessionBudget !== undefined) return sessionBudget
  const providerBudget = meta.providerId ? normalizePositiveNumber(getProvider(meta.providerId)?.budgetUsd) : undefined
  if (providerBudget !== undefined) return providerBudget
  return normalizePositiveNumber(settingsForCaoGenDrive(getSettings(), meta.driveMode).budgetUsdPerSession) ?? 0
}

export function canTrackCost(meta: SessionMeta): boolean {
  if (meta.engine === 'openai') return true
  const provider = meta.providerId ? getProvider(meta.providerId) : undefined
  return Boolean(providerPricingForModel(provider?.advancedConfig, sessionWireModel(meta)))
}

/** Goal-level USD accounting requires provider-reported cost, not a fallback model estimate. */
export function canEnforceGoalCostBudget(meta: SessionMeta): boolean {
  return canTrackCost(meta)
}

export async function withSessionCreationJournalBarrier<T>(
  retained: Set<string>,
  sessionId: string,
  activate: () => Promise<T>,
  acknowledge: () => void,
  rollback: () => Promise<void>
): Promise<T> {
  const retainAfterActivation = retained.has(sessionId)
  retained.add(sessionId)
  try {
    const result = await activate()
    if (!retainAfterActivation) {
      acknowledge()
      retained.delete(sessionId)
    }
    return result
  } catch (error) {
    await rollback()
    if (!retainAfterActivation) retained.delete(sessionId)
    throw error
  }
}

export function estimateTurnCostUsd(
  meta: SessionMeta,
  event: Extract<AgentEvent, { kind: 'turn-result' }>
): number | undefined {
  if (!event.usage) return undefined
  const provider = meta.providerId ? getProvider(meta.providerId) : undefined
  const configured = estimateProviderCostUsd(
    providerPricingForModel(provider?.advancedConfig, sessionWireModel(meta)),
    event.usage
  )
  if (configured !== undefined) return configured
  if (meta.engine !== 'openai') return undefined
  return estimateProviderCostUsd(builtinOpenAiPricingForModel(sessionWireModel(meta)), event.usage)
}

function sessionWireModel(meta: SessionMeta): string {
  return meta.model === 'auto' && meta.modelRoutingDecision?.providerId === meta.providerId
    ? meta.modelRoutingDecision.model : meta.model
}

function buildTaskStepReplayPrompt(
  snapshot: TaskSnapshotRecord,
  requestText: string,
  messageId: string | undefined,
  sequence: number
): string {
  const unknownTools = (snapshot.run?.toolExecutions ?? [])
    .filter((execution) => execution.status === 'unknown_outcome')
    .map((execution) =>
      `- ${execution.toolName}${execution.idempotencyKey ? ` (${execution.idempotencyKey})` : ''}`
    )
  return [
    '【CaoGen 断点续跑】程序从任务快照恢复。请继续完成上一条未完成的用户请求。',
    '',
    `原始用户请求(messageId=${messageId ?? 'unknown'}, step=${sequence}):`,
    requestText,
    ...(unknownTools.length > 0
      ? ['', '以下工具在退出时结果未知，重复执行前必须先核对实际状态:', ...unknownTools]
      : []),
    '',
    '续跑要求:',
    '1. 先检查当前文件状态、git diff 和已有工具结果,判断哪些步骤已经完成。',
    '2. 不要重复执行已经完成且可能产生副作用的文件修改、依赖安装、提交、推送或外部调用。',
    '3. 如果发现外部修改、冲突或无法确认的状态,先停止并向用户说明需要确认的点。',
    '4. 只继续执行原始请求剩余部分,不要扩大任务范围。'
  ].join('\n')
}
