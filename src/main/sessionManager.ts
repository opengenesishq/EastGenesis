import { app, BrowserWindow, powerSaveBlocker } from 'electron'
import type { EffectResolution, TaskEffectRecoveryView } from '../shared/effect-recovery-types'
import { buildTaskEffectRecoveryView } from './task/effect-recovery-view'
import { isInteractiveOperationActive } from './task/operation-effect-gateway'
import { createHash, randomUUID } from 'node:crypto'
import { createEngine } from './engine'
import { preparePlacedSessionEngine } from './session-engine-creation'
import { prepareRuntimeContinuation } from './session-runtime-continuation'
import { clearSessionTurnRoute } from './model/session-turn-route'
import { normalizeSessionTurnCost } from './session-model-cost'
import type { Engine } from './engine'
import { registerBuiltinEngines } from './engines'
import { fixPathForGuiLaunch } from './pathFix'
import { configureModelStatsDir } from './modelStats'
import { configureAcceptanceQualityFeedback } from './model/acceptance-quality-feedback'
import { configureProviderHealthDir } from './providerHealth'
import { SessionHistoryRepository } from './session-history-repository'
import { getSettings } from './settings'
import { calculateMonthlyBudgetSnapshot } from './model/monthly-budget'
import { checkpointRestoreEffectBoundary } from './checkpoint-effect-boundary'
import { normalizeStableMessagePayload } from './stable-message-payload'
import { withSessionOperationQueue } from './session-operation-queue'
import { applySessionModelSwitch, applySessionRoutingControl } from './ipc/session-model-switch-handler'
import { assertSessionModelChangeReady, restoreModelChangeSourceRun, sealSessionModelChange } from './session-model-change'
import { prepareSessionModelHandoffCheckpoint } from './agent/session-model-handoff'
import { assertPersistedSessionExecutionAllowed } from './session-execution-ownership'
import {
  cleanupTranscripts, readTranscriptEntries, readTranscriptEntriesStrict, restoreTranscriptIfMissing,
  shouldPersistConversationLedgerEvent, transcriptForkSeedEntries
} from './transcript'
import { touchProject } from './projects'
import { inspectManagedWorktreeRegistryRecord, managedWorktreeRecordForSession } from './worktrees'
import {
  assertTaskSnapshotWorktreeProjection,
  managedSessionPlacement,
  sessionMetaForRecovery, synchronousSessionPlacement,
  type SessionCreationDraft, type SessionWorktreePlacement
} from './session-create-lifecycle'
import { prepareSessionIdentityForActivation } from './session-domain-activation'
import { prepareIdentifiedSessionDraft, SessionResumeCreationGuard } from './session-creation-identity'
import { authorizeOfficeRevisionSend } from './office-revision/intent'
import { configureDigitalWorkerActionPolicyRoot } from './digital-worker/action-policy'
import { digitalWorkerSendPolicyError } from './digital-worker/session-action-policy'
import { bindAndValidateTaskRun, resolveDigitalWorkerSessionScope } from './digital-worker/session-binding'
import { deletePendingSessionCreation, listPendingSessionCreations, savePendingSessionCreation } from './session-creation-journal'
import {
  managedSessionActivationRecoveryError, planPendingSessionCreations,
  requiresEffectReconciliation, sessionCreationResolutionBarrier,
  type PendingSessionRecoveryPlan
} from './session-creation-recovery'
import { completeManagedSessionInitialization } from './session-managed-initialization'
import { planPersonalTaskStartupRecovery } from './personal-task/personal-task-startup-recovery'
import {
  activeSessionArtifactsCanBePruned,
  activeSessionRegistryPreserveIds,
  planActiveSessionRecovery,
  restoreActiveSessionRegistry,
  updateActiveSessionRegistryWorktreeState,
  writeActiveSessionRegistry,
  type ActiveSessionRegistryRestoreResult
} from './session-active-registry'
import {
  buildTaskSnapshotReplayPrompts, canTrackCost, cleanOneLine, effectiveBudgetUsd,
  managedSessionSendGateError, managedTaskRunSendGateError, mapWithConcurrencyInOrder, normalizeTaskId, rejectSessionSend, requireDagPromptAccepted, sendableSession, shouldDispatchChildResult,
  shouldPersistActiveRegistry, shouldResumeDagFinalization, subagentCwd, subtaskStatusFromDag,
  subtaskStatusFromSession, withSessionCreationJournalBarrier, SessionWorkflowRuntime,
  type ManagedSessionCreationOptions
} from './session-manager-support'
import { SessionSupervisorRuntime } from './session-supervisor-runtime'
import {
  handleSessionTaskRunEvent,
  isTaskSnapshotCountedEvent,
  shouldCleanupTaskSnapshot,
  taskSnapshotReason
} from './session-task-run-events'
import { SessionNotificationCoordinator } from './notification/session-notification-coordinator'
import { showDesktopNotification } from './desktopNotify'
import { scheduleAutoSkillReview } from './skill/auto-skill-review'
import { clearIdeDocumentContext } from './ide/ide-document-context'
import {
  deleteTaskSnapshot, getTaskSnapshot, listTaskRuns as listPersistedTaskRuns, listTaskSnapshots,
  flushTaskSnapshotMutations
} from './task/task-snapshot'
import { ModelAttemptRecoveryGate } from './task/model-attempt-recovery-gate'
import { TaskSnapshotReplayCoordinator } from './task/task-snapshot-replay'
import { SubagentOrchestrationCoordinator } from './task/subagent-orchestration-coordinator'
import { DIRECT_SUBAGENT_LIMIT_MESSAGE, MAX_DIRECT_SUBAGENT_TASKS } from '../shared/agent-capacity-policy'
import { AgentCapacityCoordinator } from './agent/agent-capacity-coordinator'
import { provisionDagChildSession } from './agent/dag-child-provisioner'
import { createTaskRun, createSessionTaskRun, isTaskRunTerminal, transitionTaskRun } from './task/task-run'
import { bindFrozenRunRoutingPolicy } from './task/frozen-routing-binding'
import { frozenPolicyForSessionRun } from './task/frozen-routing-from-session'
import { assertFrozenRunRequestTarget, frozenRoutingPolicyForRun } from './task/frozen-routing-policy'
import { getProvider, getProviderConnectionIdentity, listProviders, providerIsReady } from './providers'
import { resolveProviderRuntimeTarget, resolveOpenAIProtocol } from './provider/providerRuntimeTarget'
import { isLocalProviderUrl } from './model/routing-expert-policy'
import { recoverTaskExecutionState } from './task/task-execution'
import { taskRuntimeRegistry } from './task/task-runtime-registry'
import { reconcileSnapshotWithReceipts } from './task/task-recovery'
import {
  reconcileExistingPersistedTaskSnapshot,
  resolvePersistedTaskEffect,
  recheckPersistedTaskEffect,
  runHasUnresolvedEffects
} from './task/effect-runtime'
import { prepareTaskSnapshotRecovery } from './task/task-snapshot-recovery-lifecycle'
import type { SupervisorSessionControlRequest, SupervisorSessionControlResult } from './task/supervisor-session-control'
import { SupervisorStateError, SupervisorStateStore } from './task/supervisor-state'
import {
  executeInteractiveOperationEffect,
  isInteractiveOperationSnapshot,
  type InteractiveOperationEffectOutcome
} from './task/operation-effect-gateway'
import { assertAgentRecoverySnapshot, reconcileInteractiveOperationSnapshot } from './ipc/operation-snapshot'
import { executeInteractiveOperationEffectRemoveWorktree } from './ipc/worktree-operation-handlers'
import { decomposeTask } from './agent/task-decomposer'
import { createModelDagDecomposer } from './agent/model-dag-decomposer'
import {
  assertOutboundContextAllowed,
  prepareOutboundContext
} from './project-workspace/outbound-context-policy'
import { buildDagTaskPrompt, TaskDagScheduler, type TaskDagSchedulerCallbacks } from './agent/dag-scheduler'
import { TaskDagFinalizationCoordinator } from './task/dag-finalization-coordinator'
import { requirePlanningTaskStrategy } from './task/task-strategy'
import { redactSensitiveValue } from './security/secret-redaction'
import { TaskPlanSessionCoordinator } from './task/task-plan-session-coordinator'
import { SessionStartCoordinator } from './session-start-coordinator'
import { approvedTaskPlanToDag, taskDagToPlanDraft } from './task/task-plan-dag'
import { unresolvedImportedSessionInputReason } from './data-lifecycle/submission-receipt-files'
import { ModelCrossValidationRuntime } from './model/cross-validation-runtime'
import { CouncilService } from './council/council-service'
import { assertCouncilSend, isCouncilSession } from './council/council-request-guard'
import { mergeTaskExecutionAuthorityMarker, reconcileTaskExecutionAuthorityMarker } from './permission/task-execution-authority-marker'
import { getSessionInputService } from './task/session-input-runtime'
import type {
  AgentEvent,
  AgentEventIdentity,
  CheckpointRestoreMode,
  CheckpointRestoreResult,
  CreateSessionOptions,
  DispatchSubagentsInput,
  SubagentDispatchResult,
  TaskDagDispatchInput,
  TaskDagDispatchResult,
  TaskDagExecutionView,
  TaskDagFinalizationRecord,
  TaskDagFinalizationResolution,
  TaskDagRuntimeMergeSession,
  TaskDagRuntimeSnapshot,
  TaskDecomposeInput,
  TaskDecomposeResult,
  SessionEventPayload,
  SessionMeta,
  RewindResult,
  SendMessagePayload,
  TaskSnapshotRecord,
  TaskSnapshotReason,
  TaskSnapshotSubtaskState,
  TaskPlanApprovalInput,
  TaskPlanDraftInput,
  TaskPlanDispatchResult,
  TaskPlanGenerateInput,
  TaskPlanMissionCompileInput,
  TaskPlanStateView,
  TaskRunRecord,
  TranscriptEntry
} from '../shared/types'
import type { SupervisorRunRecord } from '../shared/supervisor-types'
import type { ModelAttemptReconciliationResolution } from '../shared/model-attempt-types'
import { resumeProjectPermanentDeletionEffects } from './project-deletion-effect'
import {
  deleteStandaloneSession,
  resumeSessionDeletions
} from './data-lifecycle/session-deletion-coordinator'
import {
  archiveConversationLedgerFromJsonl,
  backfillConversationLedgerArchives,
  restoreConversationLedgerJsonlFromArchive
} from './task/conversation-ledger-archive'
import {
  conversationLedgerArchiveIdentity,
  type ConversationLedgerArchiveIdentity
} from './task/conversation-ledger-store'
import { resolveWorkspaceSessionCwd } from './project-workspace/workspace-session-cwd'
import type {
  WorkItemTransferRuntimeContinueInput,
  WorkItemTransferRuntimePreparation,
  WorkItemTransferRuntimePrepareInput
} from './project-workspace/work-item-transfer-service'
import type { WorkItemTransferContinuation } from '../shared/project-workspace-types'
import { queryWorkflowEvidence } from './task/workflow-ledger-api'
import {
  buildWorkflowAcceptanceRepairPrompt,
  startWorkflowAcceptanceRepair
} from './task/workflow-acceptance-repair-runtime'
import {
  markWorkflowAcceptanceRepairTerminalFailure,
  markWorkflowAcceptanceRepairVerifying
} from './task/workflow-acceptance-repair-service'
import type {
  WorkflowAcceptanceRecord,
  WorkflowAcceptanceRepairStartResult
} from '../shared/workflow-types'
import type { WorkItem } from '../shared/project-workspace-types'
import type { WorkflowAcceptanceFailureResult } from './task/workflow-acceptance-failure-ingress'

const TASK_SNAPSHOT_RECONCILIATION_CONCURRENCY = 4

type CheckpointOperationAttempt<T extends { error?: string }> = {
  phase: 'preflight' | 'executed'
  value: T
}
class SessionManager {
  private readonly sessions = new Map<string, Engine>()
  private readonly resumeCreationGuard = new SessionResumeCreationGuard(() =>
    [...this.sessions.values()].map((session) => session.meta))
  private readonly sessionStarts = new SessionStartCoordinator((id) => this.sessions.get(id))
  private readonly taskPlans = new TaskPlanSessionCoordinator(
    (id) => this.sessions.get(id), () => app.getPath('userData'))
  private readonly taskRuns = taskRuntimeRegistry
  /** Lazily resolved so recovery/test harnesses that compose the facade without running the constructor remain safe. */
  private sessionHistory: SessionHistoryRepository | undefined
  private readonly rejectedSendSessions = new Set<string>()
  private readonly sessionEventListeners = new Set<(payload: SessionEventPayload) => void>()
  private readonly notifications = new SessionNotificationCoordinator(
    (id) => this.sessions.get(id)?.meta)
  /** 自由编排在 child 拒发或父汇总暂不可投递时保持可观察、可重试。 */
  private readonly subagentOrchestration = new SubagentOrchestrationCoordinator({
    send: (sessionId, prompt) => this.send(sessionId, prompt),
    getMeta: (sessionId) => this.sessions.get(sessionId)?.meta,
    emit: (sessionId, event) => {
      const session = this.sessions.get(sessionId)
      if (session?.emitSyntheticEvent) session.emitSyntheticEvent(event)
      else this.dispatch(sessionId, event, 0)
    },
    acknowledgeSessionCreation: (sessionId) => this.acknowledgeSessionCreation(sessionId)
  })
  /** DAG 编排:executionId → 调度器;按依赖层释放 child sessions。 */
  private readonly dagSchedulers = new Map<string, TaskDagScheduler>()
  private readonly agentCapacity = new AgentCapacityCoordinator({
    schedulers: () => this.dagSchedulers.values(),
    orchestrations: () => this.subagentOrchestration.states(),
    sessions: () => [...this.sessions.values()].map((session) => session.meta)
  })
  /** DAG 最新执行视图:用于恢复/快照保留已经完成或已从调度器移除的 DAG 状态。 */
  private readonly dagExecutionSnapshots = new Map<string, TaskDagExecutionView>()
  readonly council = new CouncilService(app.getPath('userData'), {
    ready: () => this.whenInitialized(),
    meta: (id) => this.sessions.get(id)?.meta,
    metas: () => this.list(),
    transcript: (id) => this.getTranscript(id),
    create: (options, id) => this.createManaged(options, { reservedSessionId: id, retainJournal: true }),
    inputs: () => getSessionInputService(app.getPath('userData')),
    persist: async (id) => { await this.writeTaskSnapshot(id, 'important-event', 0, undefined, undefined, true) },
    update: (execution) => this.dagExecutionSnapshots.set(execution.id, execution),
    interrupt: (id) => this.interrupt(id),
    reserve: (id) => this.agentCapacity.tryReserve(id),
    acknowledge: (id) => this.acknowledgeSessionCreation(id)
  })
  /** Serializes repeated approval clicks before the deterministic DAG becomes observable. */
  private readonly approvedPlanDispatches = new Map<string, Promise<TaskPlanDispatchResult>>()
  private readonly workflowAcceptanceRepairStarts = new Map<string, Promise<WorkflowAcceptanceRepairStartResult>>()
  /** DAG 完成后执行的显式自动合并配置;默认不写主工作区。 */
  private readonly dagAutoMergeOptions = new Map<string, { enabled: boolean; verificationCommand?: string }>()
  private readonly dagRuntimeMergeSessions = new Map<string, TaskDagRuntimeMergeSession[]>()
  private readonly snapshotCounts = new Map<
    string,
    { total: number; sinceSave: number; lastSeq: number; lastEventId?: string }
  >()
  private readonly dagFinalizationCoordinator = new TaskDagFinalizationCoordinator({
    sessions: this.sessions,
    snapshotCursor: (sessionId) => this.snapshotCounts.get(sessionId),
    snapshotSubtasks: (sessionId) => this.snapshotSubtasksFor(sessionId),
    snapshotDagExecutions: (sessionId) => this.snapshotDagExecutionsFor(sessionId),
    snapshotDagRuntimes: (sessionId) => this.snapshotDagRuntimesFor(sessionId),
    send: (parentSessionId, payload) => this.send(parentSessionId, payload),
    emitParentEvent: (parentSessionId, event) => this.dispatch(parentSessionId, event, 0),
    updateExecution: (parentSessionId, execution, emit) => {
      if (emit) this.emitTaskDagUpdate(parentSessionId, execution)
      else this.dagExecutionSnapshots.set(execution.id, execution)
    },
    releaseScheduler: (executionId) => this.dagSchedulers.delete(executionId),
    cleanupExecution: (executionId) => {
      this.dagSchedulers.delete(executionId)
      this.dagAutoMergeOptions.delete(executionId)
      this.dagRuntimeMergeSessions.delete(executionId)
    },
    recoverParent: (parentSessionId) => this.recoverTaskSnapshot(parentSessionId)
  })
  private readonly recentEventIds = new Map<string, string[]>()
  private readonly modelCrossValidation = new ModelCrossValidationRuntime({
    create: (options) => this.create(options),
    getMeta: (sessionId) => this.sessions.get(sessionId)?.meta,
    getTranscript: (sessionId) => this.sessions.get(sessionId)?.getTranscript() ?? [], getRun: (sessionId) => this.taskRuns.get(sessionId),
    send: (sessionId, prompt) => this.send(sessionId, prompt),
    dispatch: (sessionId, event) => this.dispatch(sessionId, event, 0),
    onAcceptanceFailure: async (failure) => { await this.startWorkflowAcceptanceRepairFromFailure(failure) }
  })
  private readonly workflow = new SessionWorkflowRuntime({
    sessions: this.sessions,
    runs: this.taskRuns,
    snapshotState: (sessionId, seq) => this.snapshotCounts.get(sessionId) ?? { total: 0, lastSeq: seq },
    subtasks: (sessionId) => this.snapshotSubtasksFor(sessionId),
    dagExecutions: (sessionId) => this.snapshotDagExecutionsFor(sessionId),
    dagRuntimes: (sessionId) => this.snapshotDagRuntimesFor(sessionId),
    onAcceptanceFailure: async (failure) => { await this.startWorkflowAcceptanceRepairFromFailure(failure) }
  }, { userDataRoot: app.getPath('userData') })
  private readonly enginePowerBlockers = new Map<string, number>()
  private preservingSnapshotsOnDispose = false
  private readonly effectRecoveryPreservedSessions = new Set<string>()
  private initialization: Promise<void> | undefined
  private readonly closingSessions = new Map<string, Promise<void>>()
  private readonly recoveredPendingSessions = new Map<string, SessionCreationDraft>()
  private readonly blockedPendingDagSessions = new Map<string, SessionCreationDraft>()
  private readonly retainedSessionCreationJournals = new Set<string>()
  private readonly modelAttemptRecoveryGate = new ModelAttemptRecoveryGate()
  private readonly taskSnapshotReplay = new TaskSnapshotReplayCoordinator({
    send: (sessionId, prompt, options) => this.send(sessionId, prompt, options), emit: (sessionId, event) => this.dispatch(sessionId, event, 0) })
  private readonly supervisor = new SessionSupervisorRuntime(
    () => app.getPath('userData'), this.sessions, this.taskRuns,
    (sessionId, prompts, options) => this.taskSnapshotReplay.start(sessionId, prompts, options),
    (id) => this.interrupt(id), (id) => this.workflow.flush(id),
    (sessionId, reason, seq, eventKind, eventId, strict) => this.writeTaskSnapshot(sessionId, reason, seq, eventKind, eventId, strict)
  )

  constructor() {
    configureDigitalWorkerActionPolicyRoot(app.getPath('userData'))
  }

  list(): SessionMeta[] { return [...this.sessions.values()].map((s) => ({ ...s.meta })) }
  get(id: string): Engine | undefined { return this.sessions.get(id) }

  async deleteHistorySession(idInput: string): Promise<boolean> {
    await this.whenInitialized()
    const id = idInput.trim()
    if (!id) return false
    const history = this.historyRepository().findById(id)
    if (!history) return false
    const active = [...this.sessions.values()].find((session) =>
      session.meta.id === history.id || session.meta.sdkSessionId === history.sdkSessionId)
    if (active) throw new Error('活动会话不能删除；请先停止并关闭会话。')

    await this.workflow.flush(history.id)
    this.workflow.assertRecoveryResolved(history.id)
    const snapshot = await getTaskSnapshot(history.id)
    if (snapshot) await this.modelAttemptRecoveryGate.assertSnapshotDeletable(snapshot, app.getPath('userData'))
    const operationWaiting = snapshot?.run?.operation && snapshot.run.status === 'waiting_reconciliation'
    if (runHasUnresolvedEffects(snapshot?.run) || operationWaiting) {
      throw new Error('waiting_reconciliation 效果尚未处置，不能删除会话；请先确认已执行或未执行。')
    }
    if (this.dagFinalizationCoordinator.hasIncomplete(history.id)) {
      throw new Error('DAG finalizer 尚未完成，不能删除父任务会话。')
    }

    const worktree = inspectManagedWorktreeRegistryRecord(history.id)
    if ('error' in worktree) throw new Error(worktree.error)
    if (worktree.record?.state === 'active') {
      throw new Error('managed worktree 尚未移除；请先完成现有 remove Effect。')
    }
    if (!worktree.record && history.worktreeState === 'active') {
      throw new Error('历史记录仍声明 active managed worktree，但 registry 记录缺失；已阻止删除。')
    }

    await deleteStandaloneSession(
      history.id,
      history.sdkSessionId,
      app.getPath('userData'),
      {
        retentionAnchorAt: history.updatedAt,
        relatedLegalHoldSubjects: [
          history.workspaceId,
          history.projectId,
          history.personalWorkspaceId
        ].filter((id): id is string => Boolean(id)).map((id) => ({ kind: 'project', id }))
      }
    )
    this.snapshotCounts.delete(history.id)
    this.recentEventIds.delete(history.id)
    this.effectRecoveryPreservedSessions.delete(history.id)
    this.recoveredPendingSessions.delete(history.id)
    this.blockedPendingDagSessions.delete(history.id)
    this.retainedSessionCreationJournals.delete(history.id)
    this.modelAttemptRecoveryGate.clearSession(history.id)
    return true
  }

  async rewindFiles(id: string, messageId: string, dryRun: boolean): Promise<RewindResult> {
    const session = this.sessions.get(id)
    if (!session?.rewindFiles) return { canRewind: false, error: '会话不存在或引擎不支持' }
    if (dryRun) {
      const attempt = await withSessionOperationQueue(
        id,
        () => this.rewindFilesAttempt(id, messageId, true)
      )
      return attempt.value
    }
    const outcome = await executeInteractiveOperationEffect<CheckpointOperationAttempt<RewindResult>>({
      kind: 'checkpoint_restore',
      title: `恢复文件 checkpoint ${messageId}`,
      sourceSessionId: id,
      projectId: session.meta.workspaceId ?? session.meta.projectId,
      cwd: session.meta.cwd,
      toolName: 'checkpoint_restore',
      toolInput: { checkpointId: messageId, mode: 'code', legacy: true },
      execute: () => this.rewindFilesAttempt(id, messageId, false),
      isSuccess: checkpointOperationAttemptSucceeded,
      resultSummary: checkpointOperationAttemptSummary
    })
    return checkpointRewindOutcome(outcome)
  }

  async restoreCheckpoint(
    id: string,
    messageId: string,
    mode: CheckpointRestoreMode,
    dryRun: boolean
  ): Promise<CheckpointRestoreResult> {
    const session = this.sessions.get(id)
    if (!session?.restoreCheckpoint) {
      return {
        mode,
        checkpointId: messageId,
        canRewind: false,
        applied: false,
        error: '会话不存在或引擎不支持'
      }
    }
    if (dryRun) {
      const attempt = await withSessionOperationQueue(
        id,
        () => this.restoreCheckpointAttempt(id, messageId, mode, true)
      )
      return attempt.value
    }
    const outcome = await withSessionOperationQueue(id, () => executeInteractiveOperationEffect<CheckpointOperationAttempt<CheckpointRestoreResult>>({
      kind: 'checkpoint_restore',
      title: `恢复 ${mode} checkpoint ${messageId}`,
      sourceSessionId: id,
      projectId: session.meta.workspaceId ?? session.meta.projectId,
      cwd: session.meta.cwd,
      toolName: 'checkpoint_restore',
      toolInput: { checkpointId: messageId, mode },
      execute: () => this.restoreCheckpointAttempt(id, messageId, mode, false),
      isSuccess: checkpointOperationAttemptSucceeded,
      resultSummary: checkpointOperationAttemptSummary
    }))
    return checkpointRestoreOutcome(outcome, messageId, mode)
  }

  private async rewindFilesAttempt(
    id: string,
    messageId: string,
    dryRun: boolean
  ): Promise<CheckpointOperationAttempt<RewindResult>> {
    const session = this.sessions.get(id)
    if (!session?.rewindFiles) {
      return { phase: 'preflight', value: { canRewind: false, error: '会话不存在或引擎不支持' } }
    }
    if (session.meta.status === 'running' || session.meta.status === 'starting') {
      return { phase: 'preflight', value: { canRewind: false, error: '会话仍在运行,请停止后再回溯' } }
    }
    const boundary = checkpointRestoreEffectBoundary(this.taskRuns.get(id), dryRun)
    if (!boundary.allowed) {
      return { phase: 'preflight', value: { canRewind: false, error: boundary.reason } }
    }
    const result = await session.rewindFiles(messageId, dryRun)
    if (!dryRun && result.canRewind && !result.error) {
      await this.archiveCheckpointConversation(session)
    }
    return { phase: 'executed', value: result }
  }

  private async restoreCheckpointAttempt(
    id: string,
    messageId: string,
    mode: CheckpointRestoreMode,
    dryRun: boolean
  ): Promise<CheckpointOperationAttempt<CheckpointRestoreResult>> {
    const session = this.sessions.get(id)
    if (!session?.restoreCheckpoint) {
      return {
        phase: 'preflight',
        value: {
          mode,
          checkpointId: messageId,
          canRewind: false,
          applied: false,
          error: '会话不存在或引擎不支持'
        }
      }
    }
    if (session.meta.status === 'running' || session.meta.status === 'starting') {
      return {
        phase: 'preflight',
        value: {
          mode,
          checkpointId: messageId,
          canRewind: false,
          applied: false,
          error: '会话仍在运行,请停止后再回溯'
        }
      }
    }
    const boundary = checkpointRestoreEffectBoundary(this.taskRuns.get(id), dryRun)
    if (!boundary.allowed) {
      return {
        phase: 'preflight',
        value: {
          mode,
          checkpointId: messageId,
          canRewind: false,
          applied: false,
          error: boundary.reason
        }
      }
    }
    if (!dryRun && session.meta.modelChange) {
      assertSessionModelChangeReady(session.meta)
      const preview = await session.restoreCheckpoint(messageId, mode, true)
      if (!preview.canRewind || preview.error || !preview.chat?.ok) return { phase: 'preflight', value: preview }
      if (!session.meta.sdkSessionId) throw new Error('模型交接缺少原会话身份，不能回溯。')
      const handoff = prepareSessionModelHandoffCheckpoint(session.meta, messageId,
        readTranscriptEntriesStrict(session.meta.sdkSessionId), preview.chat)
      if (handoff) {
        // The shorter prefix remains valid even if the process exits before
        // truncation. Preserve the selected model and original source Run.
        session.meta.modelChange = sealSessionModelChange({ ...session.meta.modelChange, handoff })
        this.persistActiveSessions(true)
        this.persist(id)
        await this.writeTaskSnapshot(id, 'important-event', 0, undefined, undefined, true)
        session.emitSyntheticEvent?.({ kind: 'meta', meta: { ...session.meta } })
      }
    }
    const result = await session.restoreCheckpoint(messageId, mode, dryRun)
    if (!dryRun && result.applied === true && !result.error) {
      await this.archiveCheckpointConversation(session)
    }
    if (!dryRun || !boundary.reason) return { phase: 'executed', value: result }
    return {
      phase: 'executed',
      value: {
        ...result,
        applied: false,
        note: [
          result.note,
          boundary.reason,
          '当前结果仅为只读预览，完成对账前不可应用。'
        ].filter(Boolean).join(' ')
      }
    }
  }

  private async archiveCheckpointConversation(session: Engine): Promise<void> {
    const identity = conversationLedgerArchiveIdentity(session.meta)
    if (!identity) throw new Error('Checkpoint 已执行，但会话缺少可归档的 Conversation Ledger 身份')
    const archived = await archiveConversationLedgerFromJsonl(identity, {
      rootDir: app.getPath('userData'),
      reason: 'checkpoint_restore'
    })
    if (!archived) throw new Error('Checkpoint 已执行，但 Conversation Ledger 没有可归档事件')
  }

  async setTaskStrategy(id: string, value: unknown): Promise<void> {
    const meta = this.sessions.get(id)?.meta
    if (meta && isCouncilSession(meta) && value !== 'view') throw new Error('议事参与者的只读策略已固定')
    await this.taskPlans.setStrategy(id, value)
  }

  /** Persist the portable restriction before a local grant or revocation is written. */
  async requireTaskExecutionAuthority(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session || session.meta.status === 'closed') throw new Error('当前任务不可修改授权。')
    session.meta.taskExecutionAuthorityRequired = true
    // Keep this restriction in memory even if persistence fails. Retrying can
    // finish the write; a failed mutation must never reopen legacy access.
    this.persistActiveSessions(true)
    this.persist(id)
    await this.writeTaskSnapshot(id, 'important-event', 0, undefined, undefined, true)
    session.emitSyntheticEvent?.({ kind: 'meta', meta: { ...session.meta } })
  }

  getTaskPlan(id: string): TaskPlanStateView {
    return this.taskPlans.get(id)
  }

  createTaskPlanVersion(id: string, draft: TaskPlanDraftInput): Promise<TaskPlanStateView> {
    return this.taskPlans.createManualVersion(id, draft)
  }

  createAgentTaskPlanVersion(id: string, draft: TaskPlanDraftInput): Promise<TaskPlanStateView> {
    return this.taskPlans.createAgentVersion(id, draft)
  }

  compileMissionTaskPlan(id: string, input: TaskPlanMissionCompileInput): Promise<TaskPlanStateView> {
    return this.taskPlans.compileMission(id, input)
  }

  async generateTaskPlan(id: string, input: TaskPlanGenerateInput): Promise<TaskPlanStateView> {
    const session = this.sessions.get(id)
    if (!session) throw new Error('会话不存在')
    const objective = typeof input?.objective === 'string' ? input.objective.replace(/\s+/g, ' ').trim() : ''
    if (!objective || objective.length > 20_000) throw new Error('工作流目标无效')
    const existing = this.taskPlans.get(id)
    if (existing.currentVersion) {
      const current = await this.taskPlans.createGeneratedVersion(id, { ...existing.currentVersion, objective })
      this.recordPlanningObjective(session, objective)
      return current
    }
    this.recordPlanningObjective(session, objective)
    const decomposed = await decomposeTask({
      request: objective,
      cwd: session.meta.sourceCwd ?? session.meta.cwd,
      useModel: false
    })
    return await this.taskPlans.createGeneratedVersion(id, taskDagToPlanDraft(decomposed.dag, {
      reason: decomposed.reason,
      warnings: decomposed.warnings
    }))
  }

  private recordPlanningObjective(session: Engine, objective: string): void {
    const messageId = `plan-objective-${createHash('sha256')
      .update(`caogen.plan-objective.v1\0${session.meta.id}\0${objective}`)
      .digest('hex')
      .slice(0, 32)}`
    if (session.getTranscript().some((entry) =>
      entry.event.kind === 'user-message' && entry.event.messageId === messageId)) return
    if (!session.emitSyntheticEvent) throw new Error('会话引擎不支持本地目标记录')
    session.emitSyntheticEvent({ kind: 'user-message', text: objective, messageId })
  }

  approveTaskPlan(id: string, input: TaskPlanApprovalInput, actorId = 'local-user'): Promise<TaskPlanStateView> {
    return this.taskPlans.approve(id, input, actorId)
  }

  async dispatchApprovedTaskPlan(
    id: string,
    input: TaskPlanApprovalInput
  ): Promise<TaskPlanDispatchResult> {
    const dispatchKey = `${id}:${input.version}:${input.digest}`
    const pending = this.approvedPlanDispatches.get(dispatchKey)
    if (pending) return pending
    const operation = this.dispatchApprovedTaskPlanOnce(id, input)
    this.approvedPlanDispatches.set(dispatchKey, operation)
    try {
      return await operation
    } finally {
      if (this.approvedPlanDispatches.get(dispatchKey) === operation) {
        this.approvedPlanDispatches.delete(dispatchKey)
      }
    }
  }

  private async dispatchApprovedTaskPlanOnce(
    id: string,
    input: TaskPlanApprovalInput
  ): Promise<TaskPlanDispatchResult> {
    const approved = await this.taskPlans.requireApprovedVersion(id, input)
    const dag = approvedTaskPlanToDag(id, approved.version, approved.projection)
    const existing = this.currentTaskDagExecution(dag.id)
    await this.taskPlans.setStrategy(id, 'execute')
    const result = existing
      ? { execution: this.assertMatchingTaskDag(id, dag, existing), children: [] }
      : await this.dispatchTaskDag(id, { dag, isolated: this.sessions.get(id)?.meta.isolated === true })
    return {
      executionId: result.execution.id,
      status: result.execution.status,
      taskCount: result.execution.tasks.length,
      reused: Boolean(existing)
    }
  }

  private currentTaskDagExecution(executionId: string): TaskDagExecutionView | undefined {
    return this.dagExecutionSnapshots.get(executionId) ?? this.dagSchedulers.get(executionId)?.view()
  }

  private assertMatchingTaskDag(
    parentSessionId: string,
    dag: TaskDagDispatchInput['dag'],
    execution: TaskDagExecutionView
  ): TaskDagExecutionView {
    if (execution.parentSessionId !== parentSessionId || JSON.stringify(execution.dag) !== JSON.stringify(dag)) {
      throw new Error('已有同 ID 的 DAG 与当前批准版本不一致，已阻止重复执行')
    }
    return execution
  }

  revokeTaskPlanApproval(id: string, input: TaskPlanApprovalInput, actorId = 'local-user'): Promise<TaskPlanStateView> {
    return this.taskPlans.revoke(id, input, actorId)
  }

  async assertInteractiveExecutionAuthorized(id: string, action: string): Promise<void> {
    await this.taskPlans.assertInteractiveExecution(id, action)
  }

  subscribe(listener: (payload: SessionEventPayload) => void): () => void {
    this.sessionEventListeners.add(listener)
    return () => {
      this.sessionEventListeners.delete(listener)
    }
  }

  /** Read-only task Run projection for main-process lifecycle coordinators. */
  getTaskRun(sessionId: string): TaskRunRecord | undefined {
    const run = this.taskRuns.get(sessionId)
    return run ? structuredClone(run) : undefined
  }

  setModel(sessionId: string, model: unknown): Promise<void> {
    return this.changeSessionRouting(sessionId, model, false)
  }

  setRoutingControl(sessionId: string, control: unknown): Promise<void> {
    return this.changeSessionRouting(sessionId, control, true)
  }

  private changeSessionRouting(sessionId: string, value: unknown, routingControl: boolean): Promise<void> {
    return withSessionOperationQueue(sessionId, async () => {
      const session = this.sessions.get(sessionId)
      if (session?.meta.modelChange?.state === 'prepared' && !this.taskRuns.get(sessionId)) {
        const persisted = await listPersistedTaskRuns(sessionId)
        if (this.sessions.get(sessionId) !== session || this.taskRuns.get(sessionId)) {
          throw new Error('任务状态已变化，请重新选择模型。')
        }
        const source = restoreModelChangeSourceRun(session.meta, persisted)
        if (source) this.taskRuns.set(sessionId, source)
      }
      await (routingControl ? applySessionRoutingControl : applySessionModelSwitch)(session, value, {
        rootDir: app.getPath('userData'), getRun: () => this.getTaskRun(sessionId),
        isCurrent: candidate => this.sessions.get(sessionId) === candidate,
        assertRecoveryAllowed: async () => {
          await this.modelAttemptRecoveryGate.refreshBeforeSend(sessionId)
          const gate = this.modelAttemptRecoveryGate.decideSend(sessionId, this.taskRuns.get(sessionId), false)
          if (!gate.allowed) throw new Error(gate.error)
        },
        persist: async () => {
          await this.writeTaskSnapshot(sessionId, 'important-event', 0, undefined, undefined, true)
          this.persistActiveSessions(true)
          this.persist(sessionId)
        }
      })
      if (session) session.emitSyntheticEvent?.({ kind: 'meta', meta: { ...session.meta } })
    })
  }

  /** Persist the latest TaskRun projection before a lifecycle consumer writes dependent records. */
  async persistTaskRunLifecycleBarrier(sessionId: string): Promise<TaskRunRecord | undefined> {
    const run = this.taskRuns.get(sessionId)
    if (!run) return undefined
    await this.writeTaskSnapshot(
      sessionId,
      'important-event',
      0,
      run.lastEventKind,
      undefined,
      true
    )
    return this.getTaskRun(sessionId)
  }

  async prepareWorkItemTransfer(
    input: WorkItemTransferRuntimePrepareInput
  ): Promise<WorkItemTransferRuntimePreparation> {
    await this.whenInitialized()
    const candidates = [...this.sessions.values()]
      .filter((session) =>
        session.meta.workspaceId === input.projectId &&
        session.meta.workItemId === input.workItemId)
      .sort((left, right) => right.meta.createdAt - left.meta.createdAt)
    const frozen = await Promise.all(candidates.map((session) =>
      withSessionOperationQueue(
        session.meta.id,
        () => this.supervisor.freezeForWorkItemTransfer(session.meta.id)
      ).then((run) => ({ sessionId: session.meta.id, run }))
    ))
    const predecessor = frozen.find((candidate) => candidate.run && !isTaskRunTerminal(candidate.run.status)) ??
      frozen.find((candidate) => candidate.run) ?? frozen[0]
    return {
      pausedSessionIds: frozen.map((candidate) => candidate.sessionId),
      pausedRunIds: frozen.flatMap((candidate) => candidate.run ? [candidate.run.id] : []),
      ...(predecessor ? { predecessorSessionId: predecessor.sessionId } : {}),
      ...(predecessor?.run ? { predecessorRunId: predecessor.run.id } : {})
    }
  }

  async blockRevokedConnectorSource(
    projectId: string,
    resourceId: string
  ): Promise<{ pausedSessionIds: string[]; pausedRunIds: string[] }> {
    await this.whenInitialized()
    const evidence = []
    let cursor: string | undefined
    do {
      const page = await queryWorkflowEvidence({
        projectId,
        kind: 'research_source',
        limit: 500,
        ...(cursor ? { cursor } : {})
      }, app.getPath('userData'))
      evidence.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)
    const matching = evidence.filter((record) => record.metadata?.resourceId === resourceId)
    const referencedRunIds = new Set(matching.flatMap((record) => record.runId ? [record.runId] : []))
    const referencedWorkItemIds = new Set(matching.flatMap((record) => record.workItemId ? [record.workItemId] : []))
    const candidates = [...this.sessions.values()]
      .map((session) => ({ session, run: this.taskRuns.get(session.meta.id) }))
      .filter(({ session, run }) =>
        session.meta.workspaceId === projectId &&
        Boolean(run && !isTaskRunTerminal(run.status)) &&
        Boolean(
          (run && referencedRunIds.has(run.id)) ||
          (session.meta.workItemId && referencedWorkItemIds.has(session.meta.workItemId))
        ))
      .sort((left, right) => left.session.meta.id.localeCompare(right.session.meta.id))
    for (const candidate of candidates) {
      this.supervisor.blockForSourceRevocation(candidate.session.meta.id)
    }
    const unresolved = candidates.find(({ run }) => runHasUnresolvedEffects(run) || run?.status === 'waiting_reconciliation')
    if (unresolved?.run) {
      throw new Error(`run ${unresolved.run.id} has unresolved outcomes; reconcile before connector source revocation`)
    }
    const frozen: Array<{ sessionId: string; run?: TaskRunRecord }> = []
    for (const candidate of candidates) {
      const run = await withSessionOperationQueue(
        candidate.session.meta.id,
        () => this.supervisor.freezeForSourceRevocation(candidate.session.meta.id)
      )
      frozen.push({ sessionId: candidate.session.meta.id, ...(run ? { run } : {}) })
    }
    return {
      pausedSessionIds: frozen.map((candidate) => candidate.sessionId),
      pausedRunIds: frozen.flatMap((candidate) => candidate.run ? [candidate.run.id] : [])
    }
  }

  async continueWorkItemTransfer(
    input: WorkItemTransferRuntimeContinueInput
  ): Promise<WorkItemTransferContinuation> {
    return withSessionOperationQueue(
      `work-item-transfer:${input.requestId}`,
      () => this.performWorkItemTransferContinuation(input)
    )
  }

  private async performWorkItemTransferContinuation(
    input: WorkItemTransferRuntimeContinueInput
  ): Promise<WorkItemTransferContinuation> {
    await this.whenInitialized()
    const existing = await this.findWorkItemTransferSuccessor(input.requestId, input.assignmentId)
    if (existing) {
      return {
        status: 'successor_created',
        pausedSessionIds: input.preparation?.pausedSessionIds ?? [],
        pausedRunIds: input.preparation?.pausedRunIds ?? [],
        releasedWorkerLeaseIds: [],
        ...(existing.continuation?.kind === 'work_item_transfer' && existing.continuation.sourceSessionId
          ? { predecessorSessionId: existing.continuation.sourceSessionId }
          : {}),
        ...(existing.continuation?.kind === 'work_item_transfer' && existing.continuation.sourceRunId
          ? { predecessorRunId: existing.continuation.sourceRunId }
          : {}),
        successorSessionId: existing.sessionId,
        successorRunId: existing.id
      }
    }
    if (input.target.type === 'human') {
      return {
        status: 'paused_for_human',
        pausedSessionIds: input.preparation?.pausedSessionIds ?? [],
        pausedRunIds: input.preparation?.pausedRunIds ?? [],
        releasedWorkerLeaseIds: [],
        ...(input.preparation?.predecessorSessionId
          ? { predecessorSessionId: input.preparation.predecessorSessionId }
          : {}),
        ...(input.preparation?.predecessorRunId
          ? { predecessorRunId: input.preparation.predecessorRunId }
          : {})
      }
    }

    const predecessor = input.preparation?.predecessorSessionId
      ? this.sessions.get(input.preparation.predecessorSessionId)?.meta
      : undefined
    const cwd = predecessor?.cwd ?? predecessor?.sourceCwd ??
      await resolveWorkspaceSessionCwd(input.projectId, app.getPath('userData'))
    let successorRun: TaskRunRecord | undefined
    let successorSessionId: string | undefined
    let meta: SessionMeta
    try {
      meta = await this.createManaged({
        cwd,
        workspaceId: input.projectId,
        ...(input.goalId ? { goalId: input.goalId } : {}),
        workItemId: input.workItemId,
        isolated: false,
        ...(predecessor?.driveMode ? { driveMode: predecessor.driveMode } : {}),
        ...(predecessor?.model ? { model: predecessor.model } : {}),
        ...(predecessor?.providerId ? { providerId: predecessor.providerId } : {}),
        ...(predecessor?.routingScope ? { routingScope: predecessor.routingScope } : {}),
        ...(predecessor?.taskStrategy ? { taskStrategy: predecessor.taskStrategy } : {}),
        experienceModeOverride: predecessor?.experienceModeOverride ?? 'studio',
        title: input.workItemTitle
      }, {
        beforeStart: async (created) => {
          successorSessionId = created.id
          successorRun = createTaskRun({
            sessionId: created.id,
            taskId: input.workItemId,
            digitalWorkerBinding: created.digitalWorkerBinding,
            continuation: {
              schemaVersion: 1,
              kind: 'work_item_transfer',
              requestId: input.requestId,
              assignmentId: input.assignmentId,
              ...(input.preparation?.predecessorSessionId
                ? { sourceSessionId: input.preparation.predecessorSessionId }
                : {}),
              ...(input.preparation?.predecessorRunId
                ? { sourceRunId: input.preparation.predecessorRunId }
                : {})
            }
          })
          this.taskRuns.set(created.id, successorRun)
          await this.writeTaskSnapshot(created.id, 'created', 0, undefined, undefined, true)
        }
      })
    } catch (error) {
      if (successorSessionId) this.taskRuns.delete(successorSessionId)
      throw error
    }
    if (!successorRun) throw new Error('WorkItem transfer successor TaskRun was not created')
    return {
      status: 'successor_created',
      pausedSessionIds: input.preparation?.pausedSessionIds ?? [],
      pausedRunIds: input.preparation?.pausedRunIds ?? [],
      releasedWorkerLeaseIds: [],
      ...(input.preparation?.predecessorSessionId
        ? { predecessorSessionId: input.preparation.predecessorSessionId }
        : {}),
      ...(input.preparation?.predecessorRunId
        ? { predecessorRunId: input.preparation.predecessorRunId }
        : {}),
      successorSessionId: meta.id,
      successorRunId: successorRun.id
    }
  }

  private async findWorkItemTransferSuccessor(
    requestId: string,
    assignmentId: string
  ): Promise<TaskRunRecord | undefined> {
    const active = [...this.sessions.keys()]
      .map((sessionId) => this.taskRuns.get(sessionId))
      .find((run) => workItemTransferContinuationMatches(run, requestId, assignmentId))
    if (active) return active
    return (await listPersistedTaskRuns())
      .find((run) => workItemTransferContinuationMatches(run, requestId, assignmentId))
  }

  /** Compatibility entrypoint for resume, non-Git and non-isolated sessions. */
  async create(opts: CreateSessionOptions): Promise<SessionMeta> {
    return this.resumeCreationGuard.run(opts, async () => {
      const draft = await this.validatedSessionCreationDraft(opts)
      return this.activateSessionCreation(draft, synchronousSessionPlacement(draft))
    })
  }

  /** Creates a session only after any managed worktree effect is durably confirmed. */
  async createManaged(
    opts: CreateSessionOptions,
    lifecycle: ManagedSessionCreationOptions = {}
  ): Promise<SessionMeta> {
    return this.resumeCreationGuard.run(opts, () => this.createManagedWithClaim(opts, lifecycle))
  }

  private async createManagedWithClaim(
    opts: CreateSessionOptions,
    lifecycle: ManagedSessionCreationOptions
  ): Promise<SessionMeta> {
    const draft = await this.validatedSessionCreationDraft(opts, lifecycle.reservedSessionId)
    savePendingSessionCreation(draft)
    let placement: SessionWorktreePlacement
    try {
      placement = await managedSessionPlacement(draft)
    } catch (error) {
      if (!requiresEffectReconciliation(error)) deletePendingSessionCreation(draft.baseMeta.id)
      throw error
    }
    if (lifecycle.retainJournal) this.retainedSessionCreationJournals.add(draft.baseMeta.id)
    try {
      return await this.activateManagedSessionCreation(draft, placement, lifecycle)
    } catch (error) {
      this.retainedSessionCreationJournals.delete(draft.baseMeta.id)
      throw managedSessionActivationRecoveryError(error, draft.baseMeta.id)
    }
  }

  private async validatedSessionCreationDraft(opts: CreateSessionOptions, reservedSessionId?: string): Promise<SessionCreationDraft> {
    await restoreConversationLedgerJsonlFromArchive(
      opts.resumeSdkSessionId ?? opts.forkFromSdkSessionId,
      app.getPath('userData')
    )
    const draft = prepareIdentifiedSessionDraft({ options: opts, reservedSessionId,
      parentMeta: opts.parentSessionId ? this.sessions.get(opts.parentSessionId)?.meta : undefined,
      hasSession: (id) => this.sessions.has(id) })
    let baseMeta = await prepareSessionIdentityForActivation(
      draft.baseMeta, app.getPath('userData'), draft.opts.resumeSdkSessionId !== undefined)
    if (baseMeta.conversationForkSourceSessionId) {
      const sourceSnapshot = await getTaskSnapshot(baseMeta.conversationForkSourceSessionId)
      const sourceRuns = sourceSnapshot?.run
        ? [sourceSnapshot.run]
        : await listPersistedTaskRuns(baseMeta.conversationForkSourceSessionId)
      const sourceRun = sourceRuns.sort((left, right) => right.updatedAt - left.updatedAt)[0]
      if (baseMeta.conversationForkCheckpointId) {
        transcriptForkSeedEntries(
          baseMeta.conversationForkSourceSdkSessionId!,
          baseMeta.conversationForkCheckpointId
        )
        const boundary = checkpointRestoreEffectBoundary(sourceRun, false)
        if (!boundary.allowed) throw new Error(boundary.reason)
      }
      if (sourceRun) baseMeta = { ...baseMeta, conversationForkSourceRunId: sourceRun.id }
    }
    return { ...draft, baseMeta }
  }

  private activateSessionCreation(
    draft: SessionCreationDraft,
    worktree: SessionWorktreePlacement
  ): SessionMeta {
    const { meta, session } = this.prepareSessionEngine(draft, worktree)
    this.sessions.set(meta.id, session)
    void this.writeTaskSnapshot(meta.id, 'created', 0)
    void session.start()
    return { ...meta }
  }

  private async activateManagedSessionCreation(
    draft: SessionCreationDraft,
    worktree: SessionWorktreePlacement,
    lifecycle: ManagedSessionCreationOptions = {}
  ): Promise<SessionMeta> {
    let prepared: { meta: SessionMeta; session: Engine } | undefined
    const meta = await withSessionCreationJournalBarrier(
      this.retainedSessionCreationJournals,
      draft.baseMeta.id,
      async () => {
        prepared = this.prepareSessionEngine(draft, worktree)
        this.sessions.set(prepared.meta.id, prepared.session)
        this.persistActiveSessions(true)
        await this.writeTaskSnapshot(prepared.meta.id, 'created', 0, undefined, undefined, true)
        return { ...prepared.meta }
      },
      () => { if (!lifecycle.awaitStart) this.acknowledgeSessionCreation(draft.baseMeta.id, true) },
      async () => {
        if (!prepared) return
        if (this.sessions.get(prepared.meta.id) === prepared.session) {
          this.sessions.delete(prepared.meta.id)
          this.persistActiveSessions()
        }
        try {
          await prepared.session.dispose()
        } catch (error) {
          console.error('[caogen] managed session activation rollback dispose failed:', error)
        }
      }
    )
    return completeManagedSessionInitialization({
      meta, session: prepared?.session, lifecycle,
      acknowledge: () => this.acknowledgeSessionCreation(meta.id, true),
      persistInitialized: () => this.writeTaskSnapshot(meta.id, 'created', 0, undefined, undefined, true),
      rollbackBeforeStart: async () => {
        if (prepared && this.sessions.get(meta.id) === prepared.session) {
          this.sessions.delete(meta.id)
          this.persistActiveSessions()
          await prepared.session.dispose().catch(() => undefined)
        }
        await deleteTaskSnapshot(meta.id).catch(() => undefined)
      }
    })
  }

  private prepareSessionEngine(
    draft: SessionCreationDraft,
    worktree: SessionWorktreePlacement
  ): { meta: SessionMeta; session: Engine } {
    return preparePlacedSessionEngine(draft, worktree,
      (event, seq, identity) => this.dispatch(draft.baseMeta.id, event, seq, identity))
  }

  private acknowledgeSessionCreation(sessionId: string, strict = false): void {
    try {
      deletePendingSessionCreation(sessionId)
      this.recoveredPendingSessions.delete(sessionId)
      this.blockedPendingDagSessions.delete(sessionId)
      this.retainedSessionCreationJournals.delete(sessionId)
    } catch (error) {
      if (strict) throw error
      console.error('[caogen] session activation journal cleanup failed:', error)
    }
  }

  private emitRecoveredSessionCreation(sessionId: string): void {
    const detail = 'Worktree creation was recovered, but the original prompt was not stored in the crash journal. ' +
      'Review the worktree and send the request again.'
    const event: AgentEvent = { kind: 'hook-event', event: 'session-create-recovered', detail }
    const session = this.sessions.get(sessionId)
    if (session?.emitSyntheticEvent) session.emitSyntheticEvent(event)
    else this.dispatch(sessionId, event, 0)
  }

  send(
    id: string,
    input: string | SendMessagePayload,
    options: { modelAttemptRecoveryReplay?: boolean; supervisorControlReplay?: boolean; readOnlyGoalStart?: boolean } = {}
  ): Promise<boolean> {
    return withSessionOperationQueue(id, () => this.performSend(id, input, options))
  }

  private async performSend(
    id: string,
    input: string | SendMessagePayload,
    options: { modelAttemptRecoveryReplay?: boolean; supervisorControlReplay?: boolean; readOnlyGoalStart?: boolean }
  ): Promise<boolean> {
    let session = this.sessions.get(id)
    if (!session) return false
    try { assertSessionModelChangeReady(session.meta) }
    catch (error) { return this.rejectBeforeRun(session, error instanceof Error ? error.message : String(error)) }
    await this.council.loadSnapshots()
    try {
      assertCouncilSend(session.meta, typeof input === 'string' ? undefined : input.messageId)
    } catch (error) {
      return this.rejectBeforeRun(session, error instanceof Error ? error.message : String(error))
    }
    const assertDirectStart = () => {
      if (options.readOnlyGoalStart && (session!.meta.taskStrategy !== 'view' ||
          session!.meta.permissionMode !== 'default' || this.taskPlans.get(id).currentVersion)) {
        throw new Error('任务的授权或计划已变化，请从原任务继续；直接开始不会扩大权限或跳过计划审批')
      }
    }
    try {
      assertDirectStart()
    } catch (cause) {
      return this.rejectBeforeRun(session, cause instanceof Error ? cause.message : String(cause))
    }
    try {
      const unresolvedInput = unresolvedImportedSessionInputReason(app.getPath('userData'), id)
      if (unresolvedInput) return this.rejectBeforeRun(session, unresolvedInput)
    } catch (cause) {
      return this.rejectBeforeRun(session, `导入任务的补充要求无法核对：${cause instanceof Error ? cause.message : String(cause)}`)
    }
    if (!await this.taskPlans.authorizeSend(session)) return false
    const currentRun = this.taskRuns.get(id)
    const sendGateError = managedSessionSendGateError(this.taskSnapshotReplay.blocksOrdinarySend(id, options),
      this.supervisor.blocksSend(id, currentRun, options.supervisorControlReplay === true))
    if (sendGateError) return this.rejectBeforeRun(session, sendGateError)
    const ownershipGateError = managedTaskRunSendGateError(session.meta, false, null)
    if (ownershipGateError) return this.rejectBeforeRun(session, ownershipGateError)
    if (!sendableSession(session, currentRun)) return false
    // Reading history does not authorize another Run after its task ends.
    if (session.meta.workspaceId) {
      try {
        await assertPersistedSessionExecutionAllowed(session.meta, app.getPath('userData'))
      } catch (error) {
        return this.rejectBeforeRun(session, `Canonical task ownership validation failed; Provider request was blocked: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const nextRun = !currentRun || isTaskRunTerminal(currentRun.status)
      ? createSessionTaskRun(session.meta)
      : currentRun
    const workerPolicyError = await digitalWorkerSendPolicyError({
      rootDir: app.getPath('userData'),
      meta: session.meta,
      run: nextRun,
      supervisorControlReplay: options.supervisorControlReplay,
      activeSessions: [...this.sessions.values()].map((candidate) => candidate.meta)
    })
    if (workerPolicyError) return rejectSessionSend(session, workerPolicyError)
    await this.modelAttemptRecoveryGate.refreshBeforeSend(id)
    const modelAttemptDecision = this.modelAttemptRecoveryGate.decideSend(id, currentRun,
      Boolean(options.modelAttemptRecoveryReplay))
    if (!modelAttemptDecision.allowed) return rejectSessionSend(session,
      modelAttemptDecision.error ?? 'ModelAttempt 恢复门禁拒绝发送')
    const runGateError = this.budgetError(session)
    if (runGateError) return rejectSessionSend(session, runGateError)
    const payload = normalizeStableMessagePayload(input)
    payload.messageId ??= randomUUID()
    // Evaluate and reserve the canonical WorkItem target before a possible
    // cross-protocol continuation.  The continuation consumes this route and
    // installs the same target on the successor Engine; binding remains after
    // the durable Run snapshot below.
    let pendingFrozenPolicy: ReturnType<typeof frozenPolicyForSessionRun> | undefined
    try {
      await authorizeOfficeRevisionSend({ meta: session.meta, payload, run: nextRun, rootDir: app.getPath('userData') })
      await this.supervisor.authorizeSend(session, nextRun,
        { supervisorControlReplay: options.supervisorControlReplay })
      await this.sessionStarts.ensure(id, session)
      if (nextRun.sessionId === session.meta.id && session.meta.workItemId && !nextRun.routingPolicy) {
        pendingFrozenPolicy = frozenPolicyForSessionRun(session.meta, nextRun, payload, currentRun)
        if (!pendingFrozenPolicy) throw new Error('Canonical WorkItem Run lacks a complete V1 frozen routing policy; Provider request was blocked.')
      }
      session = await prepareRuntimeContinuation({ session, payload, run: currentRun,
        emit: (event, seq, identity) => this.dispatch(id, event, seq, identity),
        install: async (successor) => {
          const current = this.sessions.get(id)
          const restricted = reconcileTaskExecutionAuthorityMarker(
            mergeTaskExecutionAuthorityMarker(successor.meta, current ? [current.meta] : []), app.getPath('userData'))
          if (restricted.taskExecutionAuthorityRequired) successor.meta.taskExecutionAuthorityRequired = true
          this.sessions.set(id, successor)
          this.sessionStarts.forget(id)
          await this.writeTaskSnapshot(id, 'important-event', 0, undefined, undefined, true)
          this.persistActiveSessions(true)
        } })
    } catch (error) {
      session = this.sessions.get(id) ?? session
      clearSessionTurnRoute(session.meta)
      session.rejectSend(supervisorSendError(error))
      return false
    }
    this.registerNewTaskRun(id, currentRun, nextRun)
    try {
      await this.writeTaskSnapshot(id, 'important-event', 0, nextRun.lastEventKind, undefined, true)
      // A completed Run may still have a terminal snapshot cleanup queued by
      // the event dispatcher. Drain the snapshot mutation queue before the
      // first bind of a successor Run so the canonical projection is visible
      // to the immutable frozen-policy binder.
      await listTaskSnapshots()
      if (nextRun.sessionId === session.meta.id && session.meta.workItemId && !nextRun.routingPolicy) {
        const policy = pendingFrozenPolicy
        if (!policy) throw new Error('Canonical WorkItem Run lacks a complete V1 frozen routing policy; Provider request was blocked.')
        const bound = await bindFrozenRunRoutingPolicy({ runId: nextRun.id, sessionId: nextRun.sessionId,
          expectedRunRevision: nextRun.revision, policy }, app.getPath('userData'))
        this.taskRuns.set(id, bound)
      }
    } catch (error) {
      clearSessionTurnRoute(session.meta)
      session.rejectSend(`TaskRun 持久化失败，已阻止 Provider 请求：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    try {
      // Earlier gates and durable Run writes await other services. Recheck the
      // Mission source immediately before handing a request to the Engine.
      if (!await this.taskPlans.authorizeSend(session)) {
        throw new Error(session.meta.lastError ?? 'Mission 执行来源已变化，已阻止 Provider 请求')
      }
      assertDirectStart()
      session.send(payload)
    } catch (error) {
      clearSessionTurnRoute(session.meta)
      const message = error instanceof Error ? error.message : String(error)
      if (options.supervisorControlReplay === true) {
        session.rejectSend(message)
        throw error instanceof Error ? error : new Error(message)
      }
      const failed = transitionTaskRun(nextRun, 'failed', { error: message })
      this.taskRuns.set(id, failed)
      this.supervisor.observeAfterEvent(session, failed, `send-failed:${randomUUID()}`, false)
      session.rejectSend(message)
      return false
    }
    this.modelAttemptRecoveryGate.acceptedSend(id, modelAttemptDecision)
    await this.supervisor.settleAcceptedSend(id)
    return true
  }

  private registerNewTaskRun(id: string, currentRun: TaskRunRecord | undefined, nextRun: TaskRunRecord): void {
    if (nextRun !== currentRun) this.taskRuns.set(id, nextRun)
  }

  private rejectBeforeRun(session: Engine, message: string): false {
    // Engine.rejectSend emits its status synchronously. This is feedback for
    // the rejected message, not an execution event belonging to the old Run.
    this.rejectedSendSessions.add(session.meta.id)
    try { return rejectSessionSend(session, message) }
    finally { this.rejectedSendSessions.delete(session.meta.id) }
  }
  async controlSupervisorRun(
    store: SupervisorStateStore,
    request: SupervisorSessionControlRequest
  ): Promise<SupervisorSessionControlResult | null> {
    return this.supervisor.control(store, request)
  }

  async claimSupervisorControlLease(
    store: SupervisorStateStore,
    runId: string,
    expectedRevision: number
  ): Promise<SupervisorRunRecord> {
    return this.supervisor.claimControlLease(store, runId, expectedRevision)
  }

  async interrupt(id: string): Promise<void> {
    await this.council.stopForParent(id)
    const session = this.sessions.get(id)
    if (!session) return
    this.effectRecoveryPreservedSessions.add(id)
    try {
      await session.interrupt()
      await this.workflow.flush(id)
      const run = this.taskRuns.get(id)
      const preserveRecovery = runHasUnresolvedEffects(run) || await this.modelAttemptRecoveryGate.shouldPreserveAfterRefresh(id, 'interrupt')
      const preserveDagFinalization = this.dagFinalizationCoordinator.hasIncomplete(id) || this.council.snapshots(id).length > 0
      if (preserveRecovery) {
        // 未知外部效果不能留在 active 会话里，否则恢复面板会过滤它且会话还能继续发工具。
        // 统一走 close 屏障：终止底层执行器、持久化 waiting_reconciliation、移出 active。
        await this.close(id)
        return
      }
      if (run && !isTaskRunTerminal(run.status)) {
        this.taskRuns.set(id, transitionTaskRun(run, 'cancelled', { lastEventKind: 'turn-result' }))
        if (preserveDagFinalization) {
          await this.writeTaskSnapshot(id, 'shutdown', 0, 'status', undefined, true)
        } else {
          this.snapshotCounts.delete(id)
          await this.persistBindAndDeleteActiveTaskSnapshot(id, 'shutdown', 0, 'status')
        }
      } else if (!preserveDagFinalization) {
        this.snapshotCounts.delete(id)
        await this.persistBindAndDeleteActiveTaskSnapshot(id, 'shutdown', 0, 'status')
      }
    } finally {
      this.effectRecoveryPreservedSessions.delete(id)
    }
  }

  async dispatchSubagents(
    parentSessionId: string,
    input: DispatchSubagentsInput
  ): Promise<SubagentDispatchResult> {
    let parent = this.sessions.get(parentSessionId)
    if (!parent) throw new Error('父会话不存在')
    if (isCouncilSession(parent.meta)) throw new Error('议事参与者不能递归派发子任务')
    await this.taskPlans.assertExecution(parent.meta, '派发子 Agent')
    const tasks = Array.isArray(input?.tasks) ? input.tasks : []
    if (tasks.length === 0) throw new Error('至少需要一个子代理任务')
    if (tasks.length > MAX_DIRECT_SUBAGENT_TASKS) throw new Error(DIRECT_SUBAGENT_LIMIT_MESSAGE)
    const orchestrationId = randomUUID()
    const children: SubagentDispatchResult['children'] = []
    const usedTaskIds = new Set<string>()
    const plannedTasks = tasks.map((task, index) => {
      const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : ''
      if (!prompt) throw new Error(`子代理任务 ${index + 1} 缺少 prompt`)
      let taskId = normalizeTaskId(task.id, `task-${index + 1}`)
      while (usedTaskIds.has(taskId)) taskId = `${taskId}-${index + 1}`
      usedTaskIds.add(taskId)
      const role = cleanOneLine(task.role ?? '', '', 40) || undefined
      const title = cleanOneLine(task.title ?? role ?? prompt, `子代理 ${index + 1}`, 42)
      return { task, taskId, prompt, role, title }
    })
    const releaseCapacity = this.agentCapacity.reserveDirect(parentSessionId, plannedTasks.length)

    try {
      this.subagentOrchestration.begin(orchestrationId, parentSessionId)
      for (const { task, taskId, prompt, role, title } of plannedTasks) {
        parent = this.sessions.get(parentSessionId)
        if (!parent) throw new Error('父会话不存在，已阻止继续派发子 Agent')
        await this.taskPlans.assertExecution(parent.meta, '继续派发子 Agent')
        const meta = await this.createManaged({
          cwd: subagentCwd(task, input, parent.meta),
          isolated: task.isolated ?? input.isolated ?? true,
          driveMode: task.driveMode ?? input.driveMode ?? parent.meta.driveMode,
          model: task.model ?? input.model ?? parent.meta.model,
          providerId: task.providerId ?? input.providerId ?? parent.meta.providerId,
          engine: task.engine ?? input.engine ?? parent.meta.engine,
          taskStrategy: task.taskStrategy ?? parent.meta.taskStrategy,
          title,
          parentSessionId,
          orchestrationId,
          childTaskId: taskId,
          childRole: role
        })
        this.subagentOrchestration.addChild(orchestrationId, meta.id)
        releaseCapacity(1)
        children.push({ taskId, prompt, meta })
      }
    } catch (error) {
      this.subagentOrchestration.cancel(orchestrationId)
      await this.rollbackProvisionedSubagents(children)
      throw error
    } finally {
      releaseCapacity()
    }
    await this.subagentOrchestration.finishProvisioning(orchestrationId, children)
    this.agentCapacity.scheduleDrain()

    return { orchestrationId, parentSessionId, children }
  }

  private async rollbackProvisionedSubagents(children: SubagentDispatchResult['children']): Promise<void> {
    for (const child of [...children].reverse()) {
      try {
        await this.close(child.meta.id)
        if (!child.meta.isolated) continue
        const removed = await executeInteractiveOperationEffectRemoveWorktree(
          child.meta.id,
          { force: true, deleteBranch: true },
          executeInteractiveOperationEffect
        )
        if (!removed.ok) console.error('[caogen] rollback provisioned subagent worktree failed:', removed)
      } catch (error) {
        console.error('[caogen] rollback provisioned subagent failed:', error)
      }
    }
  }

  async decomposeTask(parentSessionId: string, input: TaskDecomposeInput): Promise<TaskDecomposeResult> {
    const parent = this.sessions.get(parentSessionId)
    if (!parent) throw new Error('父会话不存在')
    if (isCouncilSession(parent.meta)) throw new Error('议事参与者不能递归派发子任务')
    requirePlanningTaskStrategy(parent.meta, '拆解任务 DAG')
    const existingRun = this.taskRuns.get(parentSessionId)
    const frozenTarget = existingRun ? frozenRoutingPolicyForRun(existingRun)?.initialTarget : undefined
    if (frozenTarget && (input.providerId && input.providerId !== frozenTarget.providerId || input.model && input.model !== frozenTarget.model)) {
      throw new Error('DAG 拆解不能覆盖当前 Run 的冻结 Provider/Model 目标。')
    }
    const request: TaskDecomposeInput = {
      ...input,
      cwd: input.cwd ?? parent.meta.sourceCwd ?? parent.meta.cwd,
      providerId: frozenTarget?.providerId ?? input.providerId ?? parent.meta.providerId,
      model: frozenTarget?.model ?? input.model ?? parent.meta.model
    }
    if (request.useModel !== false && request.model === 'auto') {
      throw new Error('DAG 拆解需要已冻结的具体模型目标，无法使用 auto。')
    }
    const run = existingRun
    const activeStep = [...(run?.steps ?? [])].reverse().find((step) => !step.finishedAt)
    const attemptContext = run
      ? {
          runId: run.id,
          requestId: `model-request:${run.id}:dag:${randomUUID()}`,
          stepId: activeStep?.id
        }
      : undefined
    return decomposeTask(request, {
      modelDecomposer: createModelDagDecomposer(request, attemptContext, {
        fetch,
        preflight: async ({ providerId, model, body }) => {
          const provider = getProvider(providerId)
          if (!provider) throw new Error(`DAG Provider ${providerId} 不存在。`)
          const runtimeTarget = resolveProviderRuntimeTarget(provider, { appId: 'caogen', model })
          const effectiveProtocol = runtimeTarget.protocol ?? resolveOpenAIProtocol(runtimeTarget)
          const frozenProtocol = provider.engine === 'anthropic'
            ? 'anthropic.messages'
            : provider.engine === 'gemini'
              ? 'google.generative-language'
              : effectiveProtocol === 'responses' ? 'openai.responses' : 'openai.chat-completions'
          const requestedProtocol = Array.isArray(body.input) ? 'openai.responses' : 'openai.chat-completions'
          // The model DAG adapter currently serializes OpenAI-compatible
          // Chat/Responses payloads. A native Anthropic/Gemini target must
          // fail at the routing boundary until a native DAG adapter exists;
          // sending this body to a native endpoint would violate the frozen
          // protocol contract and could otherwise be hidden by local fallback.
          if (provider.engine !== 'openai') {
            throw new Error(`DAG protocol ${frozenProtocol} 暂无原生适配器，不能把 OpenAI 请求体发送到 ${provider.engine} Provider。`)
          }
          if (provider.engine === 'openai' && requestedProtocol !== frozenProtocol) {
            throw new Error('DAG protocol does not match the effective Provider endpoint binding.')
          }
          assertFrozenRunRequestTarget({
            run,
            providerId,
            model: runtimeTarget.model || model,
            protocol: frozenProtocol,
            connectionIdentity: getProviderConnectionIdentity(providerId)
          })
          if (getSettings().routingExpertPolicy.locality === 'local_only' && !isLocalProviderUrl(runtimeTarget.baseUrl)) {
            throw new Error('DAG effective endpoint is remote under local_only routing policy.')
          }
          const serializedBody = JSON.stringify(body)
          const outbound = await prepareOutboundContext({
            meta: parent.meta,
            rootDir: app.getPath('userData'),
            payload: { text: request.request, images: [] },
            providerId,
            model,
            additionalItems: [{
              id: 'context:dag-request-body',
              kind: 'workflow_context',
              label: 'DAG decomposer request body',
              dataClass: 'S2',
              egressPolicy: 'allow',
              decision: 'included',
              bytes: Buffer.byteLength(serializedBody, 'utf8'),
              digest: `sha256:${createHash('sha256').update(serializedBody).digest('hex')}`
            }]
          })
          await assertOutboundContextAllowed({
            manifest: outbound.manifest,
            rootDir: app.getPath('userData'),
            providerId,
            model,
            engine: parent.meta.engine
          })
        }
      })
    })
  }

  async dispatchTaskDag(
    parentSessionId: string,
    input: TaskDagDispatchInput
  ): Promise<TaskDagDispatchResult> {
    const parent = this.sessions.get(parentSessionId)
    if (!parent) throw new Error('父会话不存在')
    if (isCouncilSession(parent.meta)) throw new Error('议事参与者不能递归派发子任务')
    await this.taskPlans.assertExecution(parent.meta, '执行任务 DAG')
    const children: SubagentDispatchResult['children'] = []
    const scheduler = new TaskDagScheduler(parentSessionId, input, {
      reserveTaskCapacity: () => this.agentCapacity.tryReserve(parentSessionId),
      runTask: async (task, context) => {
        const currentParent = this.sessions.get(parentSessionId)
        if (!currentParent) throw new Error('父会话不存在，已阻止继续执行任务 DAG')
        await this.taskPlans.assertExecution(currentParent.meta, '继续执行任务 DAG')
        const result = await provisionDagChildSession(currentParent.meta, input, task, context, {
          createManaged: (options, lifecycle) => this.createManaged(options, lifecycle),
          send: (sessionId, prompt) => this.send(sessionId, prompt)
        })
        children.push(result.dispatchItem)
        return result
      },
      onUpdate: (execution) => this.emitTaskDagUpdate(parentSessionId, execution),
      onTaskProvisioned: async (_execution, sessionId) => {
        await this.persistDagProvisioning(parentSessionId)
        this.acknowledgeSessionCreation(sessionId, true)
      },
      onComplete: (execution) => this.finishTaskDag(parentSessionId, execution),
      onTaskTimeout: (sessionId, taskId, error) => this.handleDagTaskTimeout(parentSessionId, sessionId, taskId, error)
    })
    this.dagExecutionSnapshots.delete(input.dag.id)
    this.dagSchedulers.set(input.dag.id, scheduler)
    this.dagAutoMergeOptions.set(input.dag.id, {
      enabled: input.autoMerge === true,
      verificationCommand: input.verificationCommand
    })
    const launched = await scheduler.start()
    if (launched.length > 0) {
      const known = new Set(children.map((child) => child.meta.id))
      for (const item of launched) {
        if (!known.has(item.meta.id)) children.push(item)
      }
    }
    // The finalizer may have projected a newer view while scheduler.start() awaited a fast child.
    // Never overwrite that durable finalization state with the scheduler's pre-finalization view.
    const execution = this.dagExecutionSnapshots.get(input.dag.id) ?? scheduler.view()
    if (launched.length === 0 && execution.status === 'waiting') {
      this.emitTaskDagUpdate(parentSessionId, execution)
      await this.persistDagProvisioning(parentSessionId)
    }
    return { execution, children }
  }

  private createTaskDagSchedulerCallbacks(
    parentSessionId: string,
    input: TaskDagDispatchInput,
    children?: SubagentDispatchResult['children']
  ): TaskDagSchedulerCallbacks {
    return {
      reserveTaskCapacity: () => this.agentCapacity.tryReserve(parentSessionId),
      runTask: async (task, context) => {
        const parent = this.sessions.get(parentSessionId)
        if (!parent) throw new Error('Parent session no longer exists for recovered DAG')
        await this.taskPlans.assertExecution(parent.meta, '继续执行任务 DAG')
        const result = await provisionDagChildSession(parent.meta, input, task, context, {
          createManaged: (options, lifecycle) => this.createManaged(options, lifecycle),
          send: (sessionId, prompt) => this.send(sessionId, prompt)
        })
        children?.push(result.dispatchItem)
        return result
      },
      onUpdate: (execution) => this.emitTaskDagUpdate(parentSessionId, execution),
      onTaskProvisioned: async (_execution, sessionId) => {
        await this.persistDagProvisioning(parentSessionId)
        this.acknowledgeSessionCreation(sessionId, true)
      },
      onComplete: (execution) => this.finishTaskDag(parentSessionId, execution),
      onTaskTimeout: (sessionId, taskId, error) =>
        this.handleDagTaskTimeout(parentSessionId, sessionId, taskId, error)
    }
  }

  private emitTaskDagUpdate(parentSessionId: string, execution: TaskDagExecutionView): void {
    this.dagExecutionSnapshots.set(execution.id, execution)
    const event: AgentEvent = { kind: 'task-dag-update', execution }
    const parent = this.sessions.get(parentSessionId)
    if (parent?.emitSyntheticEvent) {
      parent.emitSyntheticEvent(event)
    } else {
      this.dispatch(parentSessionId, event, 0)
    }
  }

  private persistDagProvisioning(parentSessionId: string): Promise<void> {
    return this.writeTaskSnapshot(parentSessionId, 'important-event', 0, 'task-dag-update', undefined, true)
  }

  private handleDagTaskTimeout(parentSessionId: string, childSessionId: string, taskId: string, error: string): void {
    const child = this.sessions.get(childSessionId)
    if (child) {
      void child.interrupt().catch((err) => {
        console.error('[caogen] DAG 子任务超时后中断 child session 失败:', err)
      })
    }
    this.dispatch(
      parentSessionId,
      {
        kind: 'hook-event',
        event: 'task-dag-timeout',
        detail: `${taskId}: ${error}`
      },
      0
    )
  }

  private async finishTaskDag(_parentSessionId: string, execution: TaskDagExecutionView): Promise<void> {
    await this.dagFinalizationCoordinator.finish(
      execution,
      this.dagAutoMergeOptions.get(execution.id),
      this.snapshotDagMergeSessionsFor(execution)
    )
    this.agentCapacity.scheduleDrain()
  }

  close(id: string): Promise<void> {
    const existing = this.closingSessions.get(id)
    if (existing) return existing
    const session = this.sessions.get(id)
    if (!session) return Promise.resolve()
    this.effectRecoveryPreservedSessions.add(id)
    const closing = this.closeAfterExecutorStops(id, session).finally(() => {
      this.effectRecoveryPreservedSessions.delete(id)
      this.closingSessions.delete(id)
    })
    this.closingSessions.set(id, closing)
    return closing
  }

  private async closeAfterExecutorStops(id: string, session: Engine): Promise<void> {
    await this.council.stopForParent(id)
    await session.dispose()
    await this.workflow.flush(id)
    let run = this.taskRuns.get(id)
    const preserveRecovery = runHasUnresolvedEffects(run) || await this.modelAttemptRecoveryGate.shouldPreserveAfterRefresh(id, 'close')
    const preserveDagFinalization = this.dagFinalizationCoordinator.hasIncomplete(id) || this.council.snapshots(id).length > 0
    if (run && !isTaskRunTerminal(run.status)) {
      if (preserveRecovery) {
        run = recoverTaskExecutionState(run)
        if (run.status !== 'waiting_reconciliation') {
          run = transitionTaskRun(run, 'waiting_reconciliation', { lastEventKind: 'status' })
        }
        this.taskRuns.set(id, run)
        await this.writeTaskSnapshot(id, 'shutdown', 0, 'status')
      } else {
        this.taskRuns.set(id, transitionTaskRun(run, 'cancelled', { lastEventKind: 'status' }))
      }
    }
    // 编排中的 child 被手动关闭:按"失败"记账,避免整组编排永远等不齐
    const orchestrationId = session.meta.orchestrationId
    const dag = orchestrationId ? this.dagSchedulers.get(orchestrationId) : undefined
    if (dag?.hasSession(id)) {
      await dag.completeSession(id, {
        ok: false,
        resultText: '子会话被手动关闭,任务未完成',
        error: '子会话被手动关闭'
      })
    }
    if (orchestrationId && this.subagentOrchestration.hasPendingChild(orchestrationId, id)) {
      this.subagentOrchestration.recordChildResult(session.meta, {
        kind: 'turn-result',
        subtype: 'closed',
        isError: true,
        resultText: '子会话被手动关闭,任务未完成'
      })
    }
    this.agentCapacity.scheduleDrain()
    if (preserveDagFinalization && !preserveRecovery) {
      await this.writeTaskSnapshot(id, 'shutdown', 0, 'status', undefined, true)
    }
    if (!preserveRecovery && !preserveDagFinalization) {
      await this.persistBindAndDeleteActiveTaskSnapshot(id, 'shutdown', 0, 'status')
      this.taskRuns.delete(id)
    }
    this.supervisor.releaseSession(id, run?.id)
    this.stopEnginePowerBlocker(id)
    this.sessions.delete(id)
    this.sessionStarts.forget(id)
    this.snapshotCounts.delete(id)
    this.recentEventIds.delete(id)
    this.persistActiveSessions()
    this.notifications.delete(id)
    clearIdeDocumentContext(id)
    this.taskSnapshotReplay.clearSession(id)
    this.modelAttemptRecoveryGate.clearSession(id)
    this.acknowledgeSessionCreation(id)
  }

  updateWorktreeState(id: string, state: SessionMeta['worktreeState']): void {
    const session = this.sessions.get(id)
    if (session) {
      session.meta.worktreeState = state
      this.persist(id)
      this.persistActiveSessions()
      return
    }
    updateActiveSessionRegistryWorktreeState(id, state)
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.council.stopForParent(id)))
    this.persistActiveSessions()
    this.taskSnapshotReplay.clear()
    this.agentCapacity.clear()
    this.subagentOrchestration.clear()
    // dispose 后 provider 仍可能异步发出尾事件。关机期间保持保护，避免晚到的
    // turn-result/status 把刚写好的恢复快照删掉。
    this.preservingSnapshotsOnDispose = true
    const pendingDisposals: Array<Promise<void>> = []
    for (const session of this.sessions.values()) {
      pendingDisposals.push(session.dispose())
      this.stopEnginePowerBlocker(session.meta.id)
      clearIdeDocumentContext(session.meta.id)
    }
    const disposalResults = await Promise.allSettled(pendingDisposals)
    for (const result of disposalResults) {
      if (result.status === 'rejected') {
        console.error('[caogen] 关闭执行器时发生错误，保留恢复快照:', result.reason)
      }
    }
    await this.dagFinalizationCoordinator.flushPending()
    await this.supervisor.settleAllObservations()
    await Promise.all([...this.sessions.keys()].map((id) =>
      this.workflow.persistShutdownSnapshot(id, this.workflow.captureSnapshot(id, 'shutdown', 0, 'status'))))
    await flushTaskSnapshotMutations()
    this.sessions.clear()
    this.sessionStarts.clear()
    this.notifications.clear()
    this.taskRuns.clear()
    this.recentEventIds.clear()
    this.modelAttemptRecoveryGate.clear()
    this.supervisor.clear()
  }

  getTranscript(id: string): TranscriptEntry[] {
    return this.sessions.get(id)?.getTranscript() ?? []
  }

  async listModelAttemptReconciliations() { return (await this.modelAttemptRecoveryGate.list()).filter((view) => !this.sessions.has(view.sessionId)) }

  async resolveModelAttemptReconciliation(attemptId: string, expectedRevision: number, resolution: ModelAttemptReconciliationResolution) {
    const resolved = await this.modelAttemptRecoveryGate.resolve(
      attemptId, expectedRevision, resolution, app.getPath('userData'),
      (sessionId) => this.sessions.has(sessionId))
    this.taskRuns.set(resolved.run.sessionId, resolved.run)
    return resolved.view
  }

  async listTaskSnapshots(): Promise<TaskSnapshotRecord[]> {
    return this.reconcileTaskSnapshots(await listTaskSnapshots(), this.workflow.recoveryBlocks())
  }

  private async reconcileTaskSnapshots(
    snapshots: TaskSnapshotRecord[],
    blockedSessionIds: ReadonlySet<string> = new Set()
  ): Promise<TaskSnapshotRecord[]> {
    const reconciled = await mapWithConcurrencyInOrder(
      snapshots,
      TASK_SNAPSHOT_RECONCILIATION_CONCURRENCY,
      async (snapshot): Promise<TaskSnapshotRecord | null> => {
        if (blockedSessionIds.has(snapshot.sessionId)) return snapshot
        // Helper 内部执行 isInteractiveOperationActive(snapshot)，并保持“交互操作快照只能进行效果对账”恢复边界。
        if (isInteractiveOperationSnapshot(snapshot)) return this.reconcileOperationSnapshot(snapshot, true)
        if (this.sessions.has(snapshot.sessionId)) return snapshot
        const reconciled = reconcileSnapshotWithReceipts(snapshot)
        if (reconciled.terminalRun) {
          if (this.dagFinalizationCoordinator.hasIncomplete(snapshot.sessionId) || snapshot.dagRuntimes?.some((runtime) => runtime.council)) {
            return reconcileExistingPersistedTaskSnapshot(reconciled.snapshot)
          }
          const persisted = await reconcileExistingPersistedTaskSnapshot(reconciled.snapshot)
          if (!persisted) return null
          await this.workflow.bindSnapshot(persisted)
          await deleteTaskSnapshot(snapshot.id, undefined, persisted.run)
          return null
        }
        return reconcileExistingPersistedTaskSnapshot(reconciled.snapshot)
      }
    )
    return reconciled.filter((snapshot): snapshot is TaskSnapshotRecord => snapshot !== null)
  }

  private async reconcileOperationSnapshot(snapshot: TaskSnapshotRecord, requireStored = false): Promise<TaskSnapshotRecord | null> {
    const reconciled = await reconcileInteractiveOperationSnapshot(snapshot, { requireStored })
    for (const effect of snapshot.run?.effects ?? []) {
      const target = effect.target
      if (target.kind !== 'git_worktree_create' && target.kind !== 'git_worktree_remove') continue
      const record = managedWorktreeRecordForSession(target.sessionId)
      if (record) this.updateWorktreeState(target.sessionId, record.state)
    }
    const operationId = snapshot.run?.operation?.operationId
    if (operationId) await this.dagFinalizationCoordinator.resumeForOperation(operationId)
    return reconciled
  }

  private async restorePendingSessionCreations(snapshots: TaskSnapshotRecord[]): Promise<void> {
    for (const plan of planPendingSessionCreations(snapshots)) {
      if (plan.kind === 'acknowledge') {
        this.acknowledgeSessionCreation(plan.draft.baseMeta.id)
      } else if (plan.kind === 'block') {
        this.blockedPendingDagSessions.set(plan.draft.baseMeta.id, plan.draft)
        console.error(
          `[caogen] blocked managed child recovery (${plan.reason}): ${plan.draft.baseMeta.id}`
        )
      } else if (plan.kind === 'restore') {
        await this.restorePendingSessionCreation(plan)
      }
    }
  }

  private async restorePendingSessionCreation(
    plan: Extract<PendingSessionRecoveryPlan, { kind: 'restore' }>
  ): Promise<void> {
    const { draft: persistedDraft, recoveredDag, record } = plan
    let draft = persistedDraft
    try {
      const baseMeta = await prepareSessionIdentityForActivation(draft.baseMeta, app.getPath('userData'), true)
      draft = { ...draft, baseMeta }
    } catch (error) {
      console.error('[caogen] pending managed session ownership recovery failed:', error)
      return
    }
    const sessionId = draft.baseMeta.id
    if (this.sessions.has(sessionId)) return this.acknowledgeSessionCreation(sessionId)
    if (recoveredDag) this.retainedSessionCreationJournals.add(sessionId)
    let placement: SessionWorktreePlacement
    try {
      placement = record
        ? { isolated: true, cwd: record.cwd, record }
        : await managedSessionPlacement(draft)
    } catch (error) {
      this.retainedSessionCreationJournals.delete(sessionId)
      if (!requiresEffectReconciliation(error)) this.acknowledgeSessionCreation(sessionId)
      console.error('[caogen] pending managed session placement recovery failed:', error)
      return
    }
    try {
      await this.activateManagedSessionCreation(draft, placement)
      if (recoveredDag) this.recoveredPendingSessions.set(sessionId, draft)
      else this.emitRecoveredSessionCreation(sessionId)
    } catch (error) {
      this.retainedSessionCreationJournals.delete(sessionId)
      console.error('[caogen] pending managed session activation recovery failed:', error)
    }
  }

  async deleteTaskSnapshot(id: string): Promise<boolean> {
    if (this.sessions.has(id)) throw new Error('活动会话的恢复快照不能手动删除；请先关闭会话。')
    await this.workflow.flush(id)
    this.workflow.assertRecoveryResolved(id)
    const snapshot = await getTaskSnapshot(id)
    if (snapshot) await this.modelAttemptRecoveryGate.assertSnapshotDeletable(snapshot, app.getPath('userData'))
    const operationWaiting = snapshot?.run?.operation && snapshot.run.status === 'waiting_reconciliation'
    if (runHasUnresolvedEffects(snapshot?.run) || operationWaiting) {
      throw new Error('waiting_reconciliation 效果尚未处置，不能删除恢复入口；请先确认已执行或未执行。')
    }
    if (this.dagFinalizationCoordinator.hasIncomplete(snapshot?.sessionId ?? id)) {
      throw new Error('DAG finalizer 尚未完成，不能删除父任务恢复入口。')
    }
    if (snapshot) await this.workflow.bindSnapshot(snapshot)
    this.snapshotCounts.delete(id)
    if (!this.sessions.has(id)) this.recentEventIds.delete(id)
    this.taskRuns.delete(id)
    return deleteTaskSnapshot(id)
  }

  async recoverTaskSnapshot(id: string): Promise<SessionMeta> {
    const stored = await getTaskSnapshot(id)
    if (!stored) throw new Error('未找到可恢复的任务快照')
    await this.supervisor.hydrateSendGate(stored.run)
    this.workflow.assertRecoveryResolved(stored.sessionId)
    assertAgentRecoverySnapshot(stored)
    await this.modelAttemptRecoveryGate.prepareRecovery(stored, app.getPath('userData'))
    const active = this.sessions.get(stored.sessionId)
    if (active) {
      this.modelAttemptRecoveryGate.clearReplayAllowance(stored.sessionId)
      return { ...active.meta }
    }
    const prepared = await prepareTaskSnapshotRecovery(
      stored,
      app.getPath('userData'),
      (sessionId) => this.dagFinalizationCoordinator.hasIncomplete(sessionId) || stored.dagRuntimes?.some((runtime) => runtime.council) === true
    )
    return this.activateRecoveredTaskSnapshot(prepared.snapshot, prepared.recoveredRun)
  }

  private async activateRecoveredTaskSnapshot(
    snapshot: TaskSnapshotRecord,
    recoveredRun: TaskRunRecord
  ): Promise<SessionMeta> {
    const { lastError: _lastError, ...restMeta } = snapshot.meta
    assertTaskSnapshotWorktreeProjection(restMeta, snapshot.worktree)
    const meta: SessionMeta = {
      ...sessionMetaForRecovery(reconcileTaskExecutionAuthorityMarker(restMeta, app.getPath('userData'))),
      status: 'starting',
      sdkSessionId: snapshot.execution.sdkSessionId,
      resumeSessionAt: snapshot.execution.resumeSessionAt
    }
    if (!meta.unassigned && !meta.workspaceId && !meta.projectId) meta.projectId = touchProject(meta.sourceCwd ?? meta.cwd).id
    resolveDigitalWorkerSessionScope(meta, app.getPath('userData'))
    bindAndValidateTaskRun(meta, recoveredRun)
    await restoreConversationLedgerJsonlFromArchive(
      snapshot.execution.sdkSessionId,
      app.getPath('userData')
    )
    restoreTranscriptIfMissing(snapshot.execution.sdkSessionId, snapshot.transcript)
    this.taskRuns.set(snapshot.sessionId, recoveredRun)
    this.snapshotCounts.set(meta.id, {
      total: snapshot.eventCount,
      sinceSave: 0,
      lastSeq: snapshot.execution.cursor?.seq ?? snapshot.execution.lastSeq,
      lastEventId: snapshot.execution.cursor?.eventId ?? snapshot.execution.lastEventId
    })
    this.recentEventIds.set(meta.id, [...(recoveredRun.recentEventIds ?? [])].slice(-256))
    const session = createEngine(
      meta.engine,
      meta,
      (event, seq, identity) => this.dispatch(meta.id, event, seq, identity),
      snapshot.execution.sdkSessionId,
      snapshot.execution.cursor?.seq ?? snapshot.execution.lastSeq
    )
    this.sessions.set(meta.id, session)
    this.persistActiveSessions(true)
    const recoveredSnapshot = { ...snapshot, run: recoveredRun }
    const restoredDagRuntimeCount = await this.restoreDagRuntimesFromSnapshot(meta.id, recoveredSnapshot)
    await this.writeTaskSnapshot(
      meta.id,
      'recovered',
      snapshot.execution.cursor?.seq ?? snapshot.execution.lastSeq,
      snapshot.execution.lastEventKind,
      snapshot.execution.cursor?.eventId ?? snapshot.execution.lastEventId,
      true
    )
    this.startRecoveredSession(session, recoveredSnapshot, restoredDagRuntimeCount > 0)
    return { ...meta }
  }

  async resolveTaskEffect(
    snapshotId: string,
    effectId: string,
    expectedRevision: number,
    resolution: EffectResolution,
    note?: string
  ): Promise<{ snapshot: TaskSnapshotRecord; resumedSession?: SessionMeta }> {
    const beforePersist = sessionCreationResolutionBarrier(resolution, (id) => this.acknowledgeSessionCreation(id, true))
    const snapshot = await resolvePersistedTaskEffect(snapshotId, effectId, expectedRevision, resolution, {
      beforePersist, note, assertStopped: snapshot => this.assertEffectRecoveryStopped(snapshot) })
    if (this.taskRuns.get(snapshot.sessionId)?.id === snapshot.run?.id && snapshot.run) this.taskRuns.set(snapshot.sessionId, snapshot.run)
    const effect = snapshot.run?.effects?.find((candidate) => candidate.id === effectId)
    let resumedSession: SessionMeta | undefined
    if (effect?.target.kind === 'git_worktree_create') {
      if (resolution === 'confirmed_applied') {
        resumedSession = await this.resumeResolvedTopLevelSessionCreation(effect.target.sessionId)
      }
    }
    const operationId = snapshot.run?.operation?.operationId
    if (operationId && resolution !== 'abandoned_by_user') await this.dagFinalizationCoordinator.resumeForOperation(operationId)
    return { snapshot, ...(resumedSession ? { resumedSession } : {}) }
  }

  async getTaskEffectRecovery(sessionId: string, runId?: string, taskId?: string): Promise<TaskEffectRecoveryView> {
    return buildTaskEffectRecoveryView(await listTaskSnapshots(), sessionId, runId, taskId, snapshot => this.effectRecoveryActive(snapshot))
  }

  async recheckTaskEffect(snapshotId: string, effectId: string, expectedRevision: number): Promise<TaskSnapshotRecord> {
    const snapshot = await recheckPersistedTaskEffect(snapshotId, effectId, expectedRevision, {
      assertStopped: snapshot => this.assertEffectRecoveryStopped(snapshot) })
    if (this.taskRuns.get(snapshot.sessionId)?.id === snapshot.run?.id && snapshot.run) this.taskRuns.set(snapshot.sessionId, snapshot.run)
    const effect = snapshot.run?.effects?.find(item => item.id === effectId)
    if (effect?.status === 'confirmed' && (effect.target.kind === 'git_worktree_create' || effect.target.kind === 'git_worktree_remove')) {
      this.updateWorktreeState(effect.target.sessionId, effect.target.registryRecord.state)
      if (effect.target.kind === 'git_worktree_create') await this.resumeResolvedTopLevelSessionCreation(effect.target.sessionId)
    }
    return snapshot
  }

  private effectRecoveryActive(snapshot: TaskSnapshotRecord): boolean {
    const status = this.sessions.get(snapshot.sessionId)?.meta.status
    return status === 'running' || status === 'starting' || isInteractiveOperationActive(snapshot)
  }

  private assertEffectRecoveryStopped(snapshot: TaskSnapshotRecord): void {
    if (this.effectRecoveryActive(snapshot)) throw new Error('操作仍在执行，请先暂停当前任务，再核对原操作结果')
  }

  resolveTaskDagFinalization(
    executionId: string,
    expectedRevision: number,
    resolution: TaskDagFinalizationResolution
  ): Promise<TaskDagFinalizationRecord> {
    return this.dagFinalizationCoordinator.resolve(executionId, expectedRevision, resolution)
  }

  private async resumeResolvedTopLevelSessionCreation(sessionId: string): Promise<SessionMeta | undefined> {
    const active = this.sessions.get(sessionId)
    if (active) return { ...active.meta }
    const draft = listPendingSessionCreations().find((candidate) => candidate.baseMeta.id === sessionId)
    if (!draft) return undefined
    const record = managedWorktreeRecordForSession(sessionId)
    if (!record || record.state !== 'active') return undefined
    try {
      const meta = await this.activateManagedSessionCreation(draft, { isolated: true, cwd: record.cwd, record })
      this.emitRecoveredSessionCreation(sessionId)
      return meta
    } catch (error) {
      throw managedSessionActivationRecoveryError(error, sessionId)
    }
  }

  private startRecoveredSession(
    session: Engine,
    snapshot: TaskSnapshotRecord,
    resumeDagRuntime = false
  ): void {
    void session
      .start()
      .then(async () => {
        const replayPrompts = buildTaskSnapshotReplayPrompts(snapshot)
        const active = this.sessions.get(snapshot.sessionId)
        if (active !== session) return
        const waitingFinalization = this.dagFinalizationCoordinator.waitingForParent(snapshot.sessionId)
        if (waitingFinalization) {
          this.dagFinalizationCoordinator.notifyRecoveryBlock(waitingFinalization)
          return
        }
        const run = this.taskRuns.get(snapshot.sessionId)
        if (this.supervisor.blocksSend(snapshot.sessionId, run)) {
          this.dispatch(
            snapshot.sessionId,
            {
              kind: 'hook-event',
              event: 'supervisor-recovery-gated',
              detail: 'Recovered session is waiting for an explicit Supervisor resume command.'
            },
            0
          )
          return
        }
        const mustReplayInterruptedRun = replayPrompts.length > 0 && Boolean(run && !isTaskRunTerminal(run.status))
        if (!mustReplayInterruptedRun) {
          const resumedFinalization = await this.dagFinalizationCoordinator.resumeForParent(snapshot.sessionId)
          if (resumedFinalization) return
        }
        if (resumeDagRuntime) {
          this.dispatch(
            snapshot.sessionId,
            {
              kind: 'hook-event',
              event: 'task-dag-recovered',
              detail: 'Recovered DAG scheduler runtime from task snapshot; continuing dependency scheduling.'
            },
            0
          )
          await this.resumeRecoveredDagRuntimes(snapshot.sessionId)
          return
        }
        if (replayPrompts.length === 0) return
        if (active.meta.status === 'error' || active.meta.status === 'closed') return
        this.dispatch(
          snapshot.sessionId,
          {
            kind: 'hook-event',
            event: 'task-snapshot-replay',
            detail: `已从快照恢复,准备按顺序续跑 ${replayPrompts.length} 个未完成步骤。`
          },
          0
        )
        await this.taskSnapshotReplay.start(snapshot.sessionId, replayPrompts, { modelAttemptRecoveryReplay: true })
      })
      .catch((err) => {
        console.error('[caogen] 恢复任务快照启动失败:', err)
      })
  }

  /** 启动时:补全 GUI 启动缺失的 PATH → 注册内置引擎 → 清理不可达转录文件 */
  whenInitialized(): Promise<void> { return this.initialization ??= this.init() }
  async init(): Promise<void> {
    // Dock 启动的应用 PATH 极简,先补全以便后续工具调用找到用户安装的 CLI。
    fixPathForGuiLaunch()
    configureModelStatsDir(app.getPath('userData'))
    configureAcceptanceQualityFeedback(app.getPath('userData'))
    configureProviderHealthDir(app.getPath('userData'), getSettings().providerCircuitBreaker)
    registerBuiltinEngines()
    await resumeProjectPermanentDeletionEffects(app.getPath('userData'))
    await resumeSessionDeletions(app.getPath('userData'))
    await this.modelAttemptRecoveryGate.initialize(app.getPath('userData'))
    await this.taskPlans.reconcileLedger()
    await this.dagFinalizationCoordinator.load()
    const persistedTaskRuns = await listPersistedTaskRuns()
    this.taskRuns.hydrateHistory(persistedTaskRuns)
    await this.supervisor.recoverStartupState(persistedTaskRuns)
    await this.dagFinalizationCoordinator.migrateLegacyRecords()
    const imported = await listTaskSnapshots()
    const workflowRecoveryBlocks = await this.workflow.recover(imported)
    await this.supervisor.hydrateSendGates(persistedTaskRuns)
    const recoverable = await this.reconcileTaskSnapshots(imported, workflowRecoveryBlocks)
    const { activeRecoveryBlocks, pendingCreationSnapshots } = await planPersonalTaskStartupRecovery(recoverable, app.getPath('userData'))
    this.modelAttemptRecoveryGate.blockActiveSessions(activeRecoveryBlocks)
    const activeRecoveryPlan = planActiveSessionRecovery(activeRecoveryBlocks, new Set(this.sessions.keys()))
    const snapshotSdkSessionIds = new Map(recoverable.flatMap((snapshot) => {
      const sdkSessionId = snapshot.execution.sdkSessionId ?? snapshot.meta.sdkSessionId
      return sdkSessionId ? [[snapshot.sessionId, sdkSessionId] as const] : []
    }))
    const preservedActiveRegistrySessionIds = activeSessionRegistryPreserveIds(
      activeRecoveryPlan,
      activeRecoveryBlocks,
      snapshotSdkSessionIds
    )
    const archiveIdentities = [
      ...this.historyRepository().list().map((entry) => conversationArchiveIdentityFor(entry)),
      ...recoverable.map((snapshot) => conversationArchiveIdentityFor(
        snapshot.meta,
        snapshot.execution.sdkSessionId ?? snapshot.meta.sdkSessionId
      )),
      ...activeRecoveryPlan.restorable.map((meta) => conversationArchiveIdentityFor(meta))
    ].filter((identity): identity is ConversationLedgerArchiveIdentity => identity !== null)
    const backfill = await backfillConversationLedgerArchives(archiveIdentities, app.getPath('userData'))
    for (const failure of backfill.failures) {
      console.error(`[caogen] Conversation Ledger backfill skipped ${failure.sdkSessionId}: ${failure.error}`)
    }
    const ledgerBlockedActiveSessions = new Set<string>()
    for (const meta of activeRecoveryPlan.restorable) {
      try {
        await restoreConversationLedgerJsonlFromArchive(meta.sdkSessionId, app.getPath('userData'))
      } catch (error) {
        ledgerBlockedActiveSessions.add(meta.id)
        preservedActiveRegistrySessionIds.add(meta.id)
        console.error(`[caogen] Conversation Ledger blocked active recovery ${meta.id}:`, error)
      }
    }
    const activeRegistryRestore = await this.restoreActiveSessions(
      new Set([...activeRecoveryBlocks, ...ledgerBlockedActiveSessions]),
      preservedActiveRegistrySessionIds
    )
    await this.restorePendingSessionCreations(pendingCreationSnapshots)
    await this.recoverAndStartWorkflowAcceptanceRepairs()
    await this.dagFinalizationCoordinator.autoRecoverParents(recoverable)
    for (const session of this.sessions.values()) {
      await this.dagFinalizationCoordinator.resumeForParent(session.meta.id)
    }
    const keep = new Set(this.historyRepository().sdkSessionIds())
    for (const snapshot of recoverable) {
      const sdkSessionId = snapshot.execution.sdkSessionId ?? snapshot.meta.sdkSessionId
      if (sdkSessionId) keep.add(sdkSessionId)
    }
    for (const meta of activeRecoveryPlan.records) {
      if (meta.sdkSessionId) keep.add(meta.sdkSessionId)
    }
    for (const session of this.sessions.values()) {
      if (session.meta.sdkSessionId) keep.add(session.meta.sdkSessionId)
    }
    if (activeSessionArtifactsCanBePruned(activeRecoveryPlan, preservedActiveRegistrySessionIds.size > 0) &&
      activeRegistryRestore.artifactsCanBePruned) {
      cleanupTranscripts(keep)
    } else {
      console.error('[caogen] active session recovery 不完整，已保留全部 transcript 和 event receipt')
    }
    const recoverableCount = this.modelAttemptRecoveryGate
      .recoverableSessionCount(recoverable.map((snapshot) => snapshot.sessionId))
    if (recoverableCount > 0 && getSettings().notificationsEnabled) {
      showDesktopNotification({
        title: 'CaoGen: 检测到未完成任务',
        body: `发现 ${recoverableCount} 个未完成任务或模型对账项，可从恢复入口继续。`,
        sessionId: 'task-snapshot'
      })
    }
  }

  async startWorkflowAcceptanceRepair(
    acceptance: WorkflowAcceptanceRecord,
    repair: WorkItem
  ): Promise<WorkflowAcceptanceRepairStartResult> {
    const pending = this.workflowAcceptanceRepairStarts.get(repair.id)
    if (pending) return pending
    const operation = startWorkflowAcceptanceRepair({
      rootDir: app.getPath('userData'),
      activeSessionForWorkItem: (workItemId) => {
        const session = [...this.sessions.values()].find((candidate) =>
          candidate.meta.workItemId === workItemId && candidate.meta.status !== 'closed')
        return session ? { id: session.meta.id, status: session.meta.status } : undefined
      },
      snapshots: () => listTaskSnapshots(),
      createManaged: (options, lifecycle) => this.createManaged(options, {
        beforeStart: async (meta) => lifecycle.beforeStart({ id: meta.id })
      }),
      send: (sessionId, prompt) => this.send(sessionId, prompt)
    }, acceptance, repair, buildWorkflowAcceptanceRepairPrompt(acceptance, repair))
    this.workflowAcceptanceRepairStarts.set(repair.id, operation)
    try {
      return await operation
    } finally {
      if (this.workflowAcceptanceRepairStarts.get(repair.id) === operation) {
        this.workflowAcceptanceRepairStarts.delete(repair.id)
      }
    }
  }

  private async startWorkflowAcceptanceRepairFromFailure(
    failure: WorkflowAcceptanceFailureResult
  ): Promise<WorkflowAcceptanceRepairStartResult> {
    const workItem = await (await import('./project-workspace/store.js'))
      .openProjectWorkspaceStore(app.getPath('userData'))
      .then((store) => store.getWorkItem(failure.repair.workItemId))
    if (!workItem) throw new Error(`workflow repair WorkItem was not found:${failure.repair.workItemId}`)
    return this.startWorkflowAcceptanceRepair(failure.acceptance, workItem)
  }

  private async recoverAndStartWorkflowAcceptanceRepairs(): Promise<void> {
    const { recoverWorkflowAcceptanceRepairMaterializations } = await import('./task/workflow-acceptance-repair-service.js')
    const result = await recoverWorkflowAcceptanceRepairMaterializations(app.getPath('userData'))
    // Materialize failed Acceptance repairs even when the installation has no
    // configured Provider, but leave execution blocked until one is available.
    // This keeps startup deterministic and avoids attempting a session that
    // cannot satisfy the creation-time Provider gate.
    if (!listProviders().some((provider) => providerIsReady(provider))) {
      if (result.recovered.length > 0) {
        console.error('[caogen] workflow repair auto-start deferred: no configured Provider is available')
      }
      return
    }
    for (const candidate of result.recovered) {
      try {
        const started = await this.startWorkflowAcceptanceRepair(
          await this.readWorkflowAcceptance(candidate.acceptanceId),
          candidate.repairWorkItem
        )
        if (started.disposition === 'blocked') {
          console.error(`[caogen] workflow repair ${candidate.repairWorkItemId} remains blocked: ${started.reason ?? 'unknown'}`)
        }
      } catch (error) {
        console.error(`[caogen] workflow repair auto-start failed:${candidate.repairWorkItemId}`, error)
      }
    }
  }

  private async readWorkflowAcceptance(acceptanceId: string): Promise<WorkflowAcceptanceRecord> {
    const { readTaskSnapshotDatabase } = await import('./task/task-snapshot.js')
    const { setupWorkflowLedgerSchema } = await import('./task/workflow-ledger-store.js')
    const { findWorkflowAcceptance } = await import('./task/workflow-ledger-query.js')
    return readTaskSnapshotDatabase(app.getPath('userData'), (db) => {
      setupWorkflowLedgerSchema(db)
      const acceptance = findWorkflowAcceptance(db, acceptanceId)
      if (!acceptance) throw new Error(`workflow acceptance was not found:${acceptanceId}`)
      return acceptance
    })
  }

  private async restoreDagRuntimesFromSnapshot(
    parentSessionId: string,
    snapshot: TaskSnapshotRecord
  ): Promise<number> {
    const executionById = new Map(snapshot.dagExecutions.map((execution) => [execution.id, execution]))
    for (const execution of snapshot.dagExecutions) {
      if (execution.parentSessionId === parentSessionId) this.dagExecutionSnapshots.set(execution.id, execution)
    }

    let restored = 0
    for (const runtime of snapshot.dagRuntimes ?? []) {
      if (runtime.parentSessionId !== parentSessionId) continue
      const execution = executionById.get(runtime.executionId)
      if (!execution) continue
      this.dagExecutionSnapshots.set(execution.id, execution)
      if (runtime.council) {
        await this.council.restore(runtime, execution)
        restored += 1
        continue
      }
      if (runtime.executionId.startsWith('council-') || execution.dag.source === 'council-v1') {
        // A missing council binding must never enter the generic auto-send finalizer.
        continue
      }
      if (runtime.mergeSessions) this.dagRuntimeMergeSessions.set(execution.id, runtime.mergeSessions)
      if (execution.completedAt !== undefined && (execution.status === 'success' || execution.status === 'failed')) {
        await this.dagFinalizationCoordinator.restoreTerminalExecution(
          execution,
          runtime.autoMerge,
          runtime.mergeSessions
        )
        continue
      }

      const input = this.taskDagDispatchInputFromRuntime(runtime, execution)
      try {
        const scheduler = TaskDagScheduler.fromRuntimeSnapshot(
          runtime,
          execution,
          this.createTaskDagSchedulerCallbacks(parentSessionId, input),
          new Set(this.sessions.keys())
        )
        this.dagSchedulers.set(execution.id, scheduler)
        if (runtime.autoMerge) {
          this.dagAutoMergeOptions.set(execution.id, {
            enabled: runtime.autoMerge.enabled,
            verificationCommand: runtime.autoMerge.verificationCommand
          })
        }
        await this.blockRecoveredPendingDagSessions(scheduler, execution)
        await this.adoptRecoveredPendingDagSessions(scheduler, execution)
        restored += 1
      } catch (err) {
        console.error('[caogen] restore DAG runtime snapshot failed:', err)
      }
    }
    return restored
  }

  private async adoptRecoveredPendingDagSessions(
    scheduler: TaskDagScheduler,
    execution: TaskDagExecutionView
  ): Promise<void> {
    for (const [sessionId, draft] of this.recoveredPendingSessions) {
      const meta = this.sessions.get(sessionId)?.meta
      if (!meta || meta.parentSessionId !== execution.parentSessionId) continue
      if (meta.orchestrationId !== execution.id || !meta.childTaskId) continue
      const item = await scheduler.adoptProvisionedSession(meta.childTaskId, { ...meta })
      if (item) {
        await scheduler.startProvisionedSession(
          item.meta.id,
          async () => requireDagPromptAccepted(await this.send(item.meta.id, item.prompt))
        )
        continue
      }
      const task = execution.tasks.find((candidate) => candidate.task.id === meta.childTaskId)
      if (!scheduler.hasSession(sessionId) && task && (task.status === 'success' || task.status === 'failed')) {
        this.acknowledgeSessionCreation(sessionId)
      }
    }
  }

  private async blockRecoveredPendingDagSessions(
    scheduler: TaskDagScheduler,
    execution: TaskDagExecutionView
  ): Promise<void> {
    for (const [sessionId, draft] of this.blockedPendingDagSessions) {
      const meta = draft.baseMeta
      if (meta.parentSessionId !== execution.parentSessionId) continue
      if (meta.orchestrationId !== execution.id || !meta.childTaskId) continue
      await scheduler.blockRecoveryTask(
        meta.childTaskId,
        sessionId,
        `DAG child ${sessionId} has a recoverable task snapshot and pending creation journal; ` +
        'prompt delivery state is unknown, so automatic replacement is blocked. Recover or reconcile the original child.'
      )
    }
  }

  private taskDagDispatchInputFromRuntime(
    runtime: TaskDagRuntimeSnapshot,
    execution: TaskDagExecutionView
  ): TaskDagDispatchInput {
    return {
      dag: execution.dag,
      cwd: runtime.dispatchOptions.cwd,
      isolated: runtime.dispatchOptions.isolated,
      driveMode: runtime.dispatchOptions.driveMode,
      model: runtime.dispatchOptions.model,
      providerId: runtime.dispatchOptions.providerId,
      engine: runtime.dispatchOptions.engine,
      permissionMode: runtime.dispatchOptions.permissionMode,
      maxRetries: execution.maxRetries,
      taskTimeoutMs: runtime.dispatchOptions.taskTimeoutMs,
      autoMerge: runtime.autoMerge?.enabled,
      verificationCommand: runtime.autoMerge?.verificationCommand
    }
  }

  private async resumeRecoveredDagRuntimes(parentSessionId: string): Promise<void> {
    for (const scheduler of this.dagSchedulers.values()) {
      const execution = scheduler.view()
      if (execution.parentSessionId !== parentSessionId) continue
      await scheduler.resume()
    }
  }

  private dispatch(
    sessionId: string,
    rawEvent: AgentEvent,
    seq: number,
    sourceIdentity?: AgentEventIdentity
  ): void {
    const identity = this.normalizeEventIdentity(sessionId, seq, sourceIdentity)
    if (!identity) return
    const session = this.sessions.get(sessionId)
    const normalizedEvent = session ? this.normalizeTurnResultCost(session, rawEvent) : rawEvent
    const event = redactSensitiveValue(normalizedEvent)
    const payload: SessionEventPayload = { sessionId, ...identity, event }
    if (this.rejectedSendSessions.has(sessionId)) {
      this.publishSessionEvent(payload)
      this.persist(sessionId)
      this.persistActiveSessions()
      return
    }
    const runBeforeEvent = this.taskRuns.get(sessionId)
    handleSessionTaskRunEvent(this.taskRuns, sessionId, event, identity, {
      cwd: session?.meta.cwd ?? '',
      supervisorPauseIntent: this.supervisor.isPauseIntent(sessionId),
      preserveClosedRun: this.preservingSnapshotsOnDispose ||
        this.effectRecoveryPreservedSessions.has(sessionId)
    })
    const runAfterEvent = this.taskRuns.get(sessionId)
    if (
      session && runAfterEvent &&
      (event.kind === 'turn-result' || runBeforeEvent?.status !== runAfterEvent.status)
    ) {
      this.supervisor.observeAfterEvent(
        session,
        runAfterEvent,
        identity.eventId,
        event.kind === 'turn-result'
      )
    }
    this.publishSessionEvent(payload)
    this.dispatchChildResult(sessionId, session, event)
    this.handleEnginePowerBlocker(sessionId, event)
    this.notifications.handle(sessionId, event)
    this.handleAutoSkillReview(sessionId, event)
    this.workflow.handleEvent(sessionId, event, identity)
    if (session && session.meta.workItemId &&
        (event.kind === 'turn-result' || (event.kind === 'status' && event.status === 'error'))) {
      const failed = event.kind === 'turn-result' ? event.isError : true
      const projection = failed
        ? markWorkflowAcceptanceRepairTerminalFailure(
            session.meta.workItemId,
            runAfterEvent?.status === 'cancelled' ? 'cancelled' : 'failed',
            app.getPath('userData')
          )
        : markWorkflowAcceptanceRepairVerifying(session.meta.workItemId, app.getPath('userData'))
      void projection.catch((error) => {
        console.error(`[caogen] workflow repair terminal projection failed:${session.meta.workItemId}`, error)
      })
    }
    if (session && shouldPersistConversationLedgerEvent(event.kind)) {
      const archiveIdentity = conversationLedgerArchiveIdentity(session.meta)
      if (archiveIdentity) {
        void archiveConversationLedgerFromJsonl(archiveIdentity, {
          rootDir: app.getPath('userData'),
          reason: event.kind === 'checkpoint-restore' ? 'checkpoint_restore' : 'append'
        }).catch((error) => {
          console.error('[caogen] Conversation Ledger archive failed:', error)
        })
      }
    }
    void this.modelCrossValidation.handleEvent(sessionId, event, identity).catch((error) => {
      console.error('[caogen] model cross-validation runtime failed:', error)
    })
    this.handleTaskSnapshot(sessionId, event, identity)
    if (event.kind === 'init' || event.kind === 'turn-result' || event.kind === 'meta') {
      this.persist(sessionId)
    }
    if (!this.preservingSnapshotsOnDispose && shouldPersistActiveRegistry(event)) {
      this.persistActiveSessions()
    }
    if (event.kind === 'init' && !this.retainedSessionCreationJournals.has(sessionId)) {
      this.acknowledgeSessionCreation(sessionId)
    }
    if (shouldResumeDagFinalization(event)) {
      void this.dagFinalizationCoordinator.resumeForParent(sessionId).catch((error) => {
        console.error('[caogen] resume DAG finalization after parent event failed:', error)
      })
    }
    this.taskSnapshotReplay.handleEvent(sessionId, event, this.modelAttemptRecoveryGate.refreshAfterEvent(sessionId, event))
    this.subagentOrchestration.handleEvent(sessionId, event)
  }

  private dispatchChildResult(sessionId: string, session: Engine | undefined, event: AgentEvent): void {
    if (!shouldDispatchChildResult(session?.meta, event, (id) => this.sessions.has(id))) return
    const childSession = session!
    if (isCouncilSession(childSession.meta)) {
      void this.council.complete(sessionId, { ok: !event.isError, resultText: event.resultText,
        error: event.isError ? event.resultText ?? event.subtype : undefined })
        .catch((error) => console.error('[caogen] council result persistence failed:', error))
        .finally(() => this.agentCapacity.scheduleDrain())
      return
    }
    const parentSessionId = childSession.meta.parentSessionId!
    const childResult: AgentEvent = {
      kind: 'subagent-result',
      orchestrationId: childSession.meta.orchestrationId,
      childTaskId: childSession.meta.childTaskId,
      childSessionId: sessionId,
      childRole: childSession.meta.childRole,
      status: event.isError ? 'error' : 'done',
      resultText: event.resultText,
      costUsd: event.costUsd,
      durationMs: event.durationMs
    }
    const parent = this.sessions.get(parentSessionId)
    if (parent?.emitSyntheticEvent) parent.emitSyntheticEvent(childResult)
    else this.dispatch(parentSessionId, childResult, 0)
    this.subagentOrchestration.recordChildResult(childSession.meta, event)
    const dag = childSession.meta.orchestrationId
      ? this.dagSchedulers.get(childSession.meta.orchestrationId)
      : undefined
    if (!dag?.hasSession(sessionId)) {
      this.agentCapacity.scheduleDrain()
      return
    }
    void dag.completeSession(sessionId, {
      ok: !event.isError,
      resultText: event.resultText,
      error: event.isError ? event.resultText ?? event.subtype : undefined
    })
      .catch((error) => {
        console.error('[caogen] DAG child completion scheduling failed:', error)
      })
      .finally(() => this.agentCapacity.scheduleDrain())
  }

  private normalizeEventIdentity(
    sessionId: string,
    sourceSeq: number,
    source?: AgentEventIdentity
  ): AgentEventIdentity | null {
    const eventId = source?.eventId?.trim() || randomUUID()
    const recent = this.recentEventIds.get(sessionId) ?? []
    if (recent.includes(eventId)) return null
    const state = this.snapshotCounts.get(sessionId) ?? {
      total: 0,
      sinceSave: 0,
      lastSeq: 0
    }
    const candidate = Number.isInteger(source?.seq) && (source?.seq ?? 0) > 0
      ? source!.seq
      : Number.isInteger(sourceSeq) && sourceSeq > 0
        ? sourceSeq
        : state.lastSeq + 1
    const normalizedSeq = candidate > state.lastSeq ? candidate : state.lastSeq + 1
    const identity: AgentEventIdentity = {
      schemaVersion: 1,
      streamId: source?.streamId?.trim() || `session:${sessionId}`,
      eventId,
      seq: normalizedSeq,
      occurredAt: source?.occurredAt ?? Date.now(),
      ...(source?.causationId ? { causationId: source.causationId } : {}),
      ...(source?.correlationId ? { correlationId: source.correlationId } : {})
    }
    recent.push(eventId)
    this.recentEventIds.set(sessionId, recent.slice(-256))
    this.snapshotCounts.set(sessionId, {
      ...state,
      lastSeq: normalizedSeq,
      lastEventId: eventId
    })
    return identity
  }

  private handleAutoSkillReview(sessionId: string, event: AgentEvent): void {
    if (event.kind !== 'turn-result' || event.isError) return
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.meta.parentSessionId || session.meta.childRole) return
    scheduleAutoSkillReview(
      {
        meta: { ...session.meta },
        transcript: session.getTranscript(),
        event
      },
      { enabled: getSettings().autoSkillLearningEnabled }
    )
  }

  private handleEnginePowerBlocker(sessionId: string, event: AgentEvent): void {
    if (event.kind !== 'status') return
    const engine = this.sessions.get(sessionId)?.meta.engine
    if (!engine) return
    if (event.status === 'running') {
      this.startEnginePowerBlocker(sessionId)
    } else if (event.status === 'idle' || event.status === 'error' || event.status === 'closed') {
      this.stopEnginePowerBlocker(sessionId)
    }
  }

  private startEnginePowerBlocker(sessionId: string): void {
    if (this.enginePowerBlockers.has(sessionId)) return
    if (!getSettings().preventDisplaySleep) return
    try {
      const blockerId = powerSaveBlocker.start('prevent-display-sleep')
      this.enginePowerBlockers.set(sessionId, blockerId)
    } catch (err) {
      console.error('[caogen] 启动引擎防休眠失败:', err)
    }
  }

  private stopEnginePowerBlocker(sessionId: string): void {
    const blockerId = this.enginePowerBlockers.get(sessionId)
    if (blockerId === undefined) return
    this.enginePowerBlockers.delete(sessionId)
    try {
      if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
    } catch (err) {
      console.error('[caogen] 释放引擎防休眠失败:', err)
    }
  }

  private handleTaskSnapshot(
    sessionId: string,
    event: AgentEvent,
    identity: AgentEventIdentity
  ): void {
    if (shouldCleanupTaskSnapshot(
      event,
      this.taskRuns.get(sessionId),
      this.effectRecoveryPreservedSessions.has(sessionId),
      this.dagFinalizationCoordinator.hasIncomplete(sessionId) || this.council.snapshots(sessionId).length > 0
    )) {
      if (!this.preservingSnapshotsOnDispose) {
        this.snapshotCounts.delete(sessionId)
        if (event.kind === 'status' && event.status === 'closed') {
          this.recentEventIds.delete(sessionId)
        }
        void this.persistBindAndDeleteActiveTaskSnapshot(
          sessionId,
          'important-event',
          identity.seq,
          event.kind,
          identity.eventId
        ).catch((error) => {
          console.error('[caogen] terminal TaskRun persistence/binding failed:', error)
        })
      }
      return
    }
    const session = this.sessions.get(sessionId)
    if (!session) return
    const state = this.snapshotCounts.get(sessionId) ?? { total: 0, sinceSave: 0, lastSeq: 0 }
    if (isTaskSnapshotCountedEvent(event)) {
      state.total += 1
      state.sinceSave += 1
      state.lastSeq = Math.max(state.lastSeq, identity.seq)
      state.lastEventId = identity.eventId
    }
    const reason = taskSnapshotReason(event, state.sinceSave)
    if (reason) {
      this.snapshotCounts.set(sessionId, { ...state, sinceSave: 0 })
      void this.writeTaskSnapshot(sessionId, reason, identity.seq, event.kind, identity.eventId)
      return
    }
    this.snapshotCounts.set(sessionId, state)
  }

  private async writeTaskSnapshot(
    sessionId: string,
    reason: TaskSnapshotReason,
    seq: number,
    eventKind?: AgentEvent['kind'],
    eventId?: string,
    strict = false
  ): Promise<void> {
    const persist = this.workflow.captureSnapshot(sessionId, reason, seq, eventKind, eventId, strict)
    await this.workflow.flush(sessionId)
    try {
      await persist()
    } catch (err) {
      if (strict) throw err
      console.error('[caogen] 写入任务快照失败:', err)
    }
  }

  private async persistBindAndDeleteActiveTaskSnapshot(
    sessionId: string,
    reason: TaskSnapshotReason,
    seq: number,
    eventKind?: AgentEvent['kind'],
    eventId?: string
  ): Promise<void> {
    await this.writeTaskSnapshot(sessionId, reason, seq, eventKind, eventId, true)
    if (this.council.snapshots(sessionId).length > 0) return
    await deleteTaskSnapshot(sessionId, undefined, this.taskRuns.get(sessionId))
  }

  private snapshotSubtasksFor(sessionId: string): TaskSnapshotSubtaskState[] {
    const subtasks: TaskSnapshotSubtaskState[] = []
    for (const state of this.subagentOrchestration.states()) {
      if (state.parentSessionId !== sessionId) continue
      for (const childSessionId of state.pending) {
        const child = this.sessions.get(childSessionId)?.meta
        subtasks.push({
          taskId: child?.childTaskId,
          role: child?.childRole,
          sessionId: childSessionId,
          status: subtaskStatusFromSession(child?.status),
          branch: child?.branch,
          worktreePath: child?.worktreePath,
          costUsd: child?.costUsd
        })
      }
      for (const result of state.results) {
        subtasks.push({
          taskId: result.taskId,
          role: result.role,
          sessionId: result.sessionId,
          status: result.ok ? 'success' : 'failed',
          resultText: result.resultText,
          costUsd: result.costUsd,
          branch: result.branch,
          worktreePath: result.worktreePath
        })
      }
    }
    for (const execution of this.snapshotDagExecutionsFor(sessionId)) {
      if (execution.parentSessionId !== sessionId) continue
      for (const task of execution.tasks) {
        subtasks.push({
          taskId: task.task.id,
          role: task.task.role,
          sessionId: task.sessionIds[task.sessionIds.length - 1] ?? `${execution.id}:${task.task.id}`,
          status: subtaskStatusFromDag(task.status),
          resultText: task.resultText,
          branch: undefined,
          worktreePath: undefined
        })
      }
    }
    return subtasks
  }

  private snapshotDagExecutionsFor(sessionId: string): TaskDagExecutionView[] {
    const executions = new Map<string, TaskDagExecutionView>()
    for (const scheduler of this.dagSchedulers.values()) {
      const execution = scheduler.view()
      executions.set(execution.id, execution)
    }
    for (const execution of this.dagExecutionSnapshots.values()) {
      executions.set(execution.id, execution)
    }
    return [...executions.values()].filter(
      (execution) =>
        execution.parentSessionId === sessionId ||
        execution.tasks.some((task) => task.sessionIds.includes(sessionId))
    )
  }

  private snapshotDagRuntimesFor(sessionId: string): TaskDagRuntimeSnapshot[] {
    const runtimes: TaskDagRuntimeSnapshot[] = this.council.snapshots(sessionId)
    for (const [executionId, scheduler] of this.dagSchedulers.entries()) {
      const execution = scheduler.view()
      if (
        execution.parentSessionId !== sessionId &&
        !execution.tasks.some((task) => task.sessionIds.includes(sessionId))
      ) {
        continue
      }
      runtimes.push(
        scheduler.runtimeSnapshot({
          autoMerge: this.dagAutoMergeOptions.get(executionId),
          mergeSessions: this.snapshotDagMergeSessionsFor(execution)
        })
      )
    }
    return runtimes
  }

  private snapshotDagMergeSessionsFor(execution: TaskDagExecutionView): TaskDagRuntimeMergeSession[] {
    const fallback = new Map(
      (this.dagRuntimeMergeSessions.get(execution.id) ?? []).map((session) => [session.sessionId, session])
    )
    const sessions: TaskDagRuntimeMergeSession[] = []
    for (const task of execution.tasks) {
      for (const sessionId of task.sessionIds) {
        const meta = this.sessions.get(sessionId)?.meta
        if (meta) {
          sessions.push({
            sessionId,
            taskId: task.task.id,
            repoRoot: meta.repoRoot,
            worktreePath: meta.worktreePath,
            baseSha: meta.baseSha,
            branch: meta.branch,
            resultText: task.resultText
          })
          continue
        }
        const restored = fallback.get(sessionId)
        if (restored) {
          sessions.push({
            ...restored,
            taskId: restored.taskId ?? task.task.id,
            resultText: task.resultText ?? restored.resultText
          })
        }
      }
    }
    return sessions
  }

  private budgetError(session: Engine): string | null {
    const budget = effectiveBudgetUsd(session.meta)
    const monthlyBudget = calculateMonthlyBudgetSnapshot({
      settings: getSettings(),
      history: this.historyRepository().list(),
      currentSession: session.meta
    })
    if (budget <= 0 && monthlyBudget.limitUsd <= 0) return null
    if (session.meta.model !== 'auto' && !canTrackCost(session.meta)) {
      return '当前引擎不提供费用回传,无法保证预算闸门;请关闭预算或切换到支持费用统计的引擎后继续。'
    }
    if (monthlyBudget.exceeded) {
      return `已达本月预算上限 $${monthlyBudget.limitUsd.toFixed(2)} (${monthlyBudget.monthKey}),请调高月度预算后继续`
    }
    if (budget > 0 && session.meta.costUsd >= budget) {
      return `已达预算上限 $${budget.toFixed(2)},请调高预算后继续`
    }
    return null
  }

  private normalizeTurnResultCost(session: Engine, event: AgentEvent): AgentEvent {
    return normalizeSessionTurnCost(session.meta, event)
  }

  private persist(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const meta = session.meta
    if (!meta.sdkSessionId) return
    this.historyRepository().upsertSession({ ...meta, sdkSessionId: meta.sdkSessionId })
  }

  private historyRepository(): SessionHistoryRepository {
    return this.sessionHistory ??= new SessionHistoryRepository()
  }

  private async restoreActiveSessions(
    snapshotSessionIds: ReadonlySet<string> = new Set(),
    preserveRegistrySessionIds: ReadonlySet<string> = new Set()
  ): Promise<ActiveSessionRegistryRestoreResult> {
    const result = await restoreActiveSessionRegistry(
      snapshotSessionIds,
      this.sessions,
      this.snapshotCounts,
      (sessionId, event, seq, identity) => this.dispatch(sessionId, event, seq, identity),
      {
        preserveRegistrySessionIds,
        startRestoredEngine: (record, engine) => this.sessionStarts.restore(record, engine)
      }
    )
    if (result.registryChanged) this.persistActiveSessions()
    return result
  }

  private persistActiveSessions(strict = false): void {
    const active = [...this.sessions.values()]
      .map((session) => session.meta)
      .filter((meta) => meta.status !== 'closed' && (strict || Boolean(meta.sdkSessionId)))
      .map((meta) => ({ ...meta }))
    writeActiveSessionRegistry(active, strict)
  }

  private publishSessionEvent(payload: SessionEventPayload): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('session:event', payload)
    }
    this.emitToSubscribers(payload)
  }

  private emitToSubscribers(payload: SessionEventPayload): void {
    for (const listener of this.sessionEventListeners) {
      try {
        listener(payload)
      } catch (error) {
        console.error('[caogen] session event subscriber failed:', error)
      }
    }
  }
}

function checkpointOperationAttemptSucceeded<T extends { error?: string }>(
  attempt: CheckpointOperationAttempt<T>
): boolean {
  return attempt.phase === 'preflight' || attempt.value.error === undefined
}

function checkpointOperationAttemptSummary<T extends { error?: string }>(
  attempt: CheckpointOperationAttempt<T>
): string {
  const value = attempt.value as T & { canRewind?: boolean; applied?: boolean }
  return JSON.stringify({
    phase: attempt.phase,
    canRewind: value.canRewind === true,
    applied: value.applied === true,
    error: value.error ? 'reported' : 'none'
  })
}

function checkpointRewindOutcome(
  outcome: InteractiveOperationEffectOutcome<CheckpointOperationAttempt<RewindResult>>
): RewindResult {
  if (outcome.status === 'completed' && outcome.value) return outcome.value.value
  const value = outcome.value?.value ?? { canRewind: false }
  return {
    ...value,
    canRewind: false,
    error: checkpointOperationOutcomeError(outcome, value.error)
  }
}

function checkpointRestoreOutcome(
  outcome: InteractiveOperationEffectOutcome<CheckpointOperationAttempt<CheckpointRestoreResult>>,
  checkpointId: string,
  mode: CheckpointRestoreMode
): CheckpointRestoreResult {
  if (outcome.status === 'completed' && outcome.value) return outcome.value.value
  const value = outcome.value?.value ?? { mode, checkpointId, canRewind: false, applied: false }
  return {
    ...value,
    canRewind: false,
    applied: false,
    error: checkpointOperationOutcomeError(outcome, value.error)
  }
}

function checkpointOperationOutcomeError<T extends { operationId: string }>(
  outcome: T & ({ status: 'completed' } | { status: 'failed'; error: string } | {
    status: 'waiting_reconciliation'
    snapshotId: string
    effectId: string
    error: string
  }),
  engineError?: string
): string {
  if (outcome.status === 'waiting_reconciliation') {
    return [
      engineError,
      `Checkpoint 回退结果无法唯一确认；Effect ${outcome.effectId} 已保留在恢复项 ${outcome.snapshotId}，完成对账前禁止自动重放。`,
      outcome.error
    ].filter(Boolean).join(' ')
  }
  if (outcome.status === 'failed') {
    return [engineError, `Checkpoint Effect ${outcome.operationId} 未能开始或持久化。`, outcome.error]
      .filter(Boolean)
      .join(' ')
  }
  return engineError ?? 'Checkpoint Effect 未返回结果'
}

function conversationArchiveIdentityFor(
  meta: Parameters<typeof conversationLedgerArchiveIdentity>[0],
  sdkSessionId = meta.sdkSessionId
): ConversationLedgerArchiveIdentity | null {
  return conversationLedgerArchiveIdentity({ ...meta, sdkSessionId })
}

function supervisorSendError(error: unknown): string {
  if (error instanceof SupervisorStateError) {
    if (error.code === 'budget_exhausted') return `Goal 预算已用尽，发送已阻止：${error.message}`
    if (error.code === 'concurrency_exhausted') return `Goal 并发 Run 已达上限，发送已阻止：${error.message}`
    return `Supervisor 发送门禁拒绝请求：${error.message}`
  }
  return `Supervisor 发送前检查失败，已按失败关闭处理：${error instanceof Error ? error.message : String(error)}`
}

function workItemTransferContinuationMatches(
  run: TaskRunRecord | undefined,
  requestId: string,
  assignmentId: string
): run is TaskRunRecord {
  return run?.continuation?.kind === 'work_item_transfer' &&
    run.continuation.requestId === requestId && run.continuation.assignmentId === assignmentId
}

export const sessionManager = new SessionManager()
