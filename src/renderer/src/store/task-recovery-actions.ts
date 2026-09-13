import type {
  AgentEvent,
  McpProbeResult,
  TaskDagFinalizationResolution,
  TaskSnapshotRecord,
  WorkItem
} from '../../../shared/types'
import type { SupervisorRunRecord } from '../../../shared/supervisor-types'
import type { McpProbeOperationResult } from '../../../shared/mcp-probe-types'
import type {
  ModelAttemptReconciliationResolution,
  ModelAttemptReconciliationView
} from '../../../shared/model-attempt-types'

interface TaskRecoveryState {
  taskSnapshots: TaskSnapshotRecord[]
  modelAttemptReconciliations: ModelAttemptReconciliationView[]
  taskSnapshotsLoading: boolean
  taskSnapshotsError?: string
  workflowAttentionWorkItems: WorkItem[]
  workflowAttentionSupervisorRuns: SupervisorRunRecord[]
  workflowAttentionLoading: boolean
  workflowAttentionError?: string
  workflowAttentionActionError?: string
  recoverTaskSnapshot(snapshotId: string): Promise<void>
  refreshTaskSnapshots(): Promise<void>
  refreshWorkflowAttention(): Promise<void>
}

type TaskRecoveryStateUpdate = Partial<
  Pick<
    TaskRecoveryState,
    | 'taskSnapshots'
    | 'modelAttemptReconciliations'
    | 'taskSnapshotsLoading'
    | 'taskSnapshotsError'
    | 'workflowAttentionWorkItems'
    | 'workflowAttentionSupervisorRuns'
    | 'workflowAttentionLoading'
    | 'workflowAttentionError'
    | 'workflowAttentionActionError'
  >
>

export interface TaskRecoveryActions {
  modelAttemptReconciliations: ModelAttemptReconciliationView[]
  workflowAttentionWorkItems: WorkItem[]
  workflowAttentionSupervisorRuns: SupervisorRunRecord[]
  workflowAttentionLoading: boolean
  workflowAttentionError?: string
  workflowAttentionActionError?: string
  hydrateTaskRecoveryCandidates(): Promise<void>
  refreshWorkflowAttention(): Promise<void>
  controlWorkflowSupervisorRun(
    run: SupervisorRunRecord,
    action: 'pause' | 'cancel' | 'resume' | 'retry'
  ): Promise<void>
  resolveTaskEffect(
    snapshotId: string,
    effectId: string,
    expectedRevision: number,
    resolution: 'confirmed_applied' | 'confirmed_not_applied'
  ): Promise<void>
  resolveTaskDagFinalization(
    executionId: string,
    expectedRevision: number,
    resolution: TaskDagFinalizationResolution
  ): Promise<void>
  resolveModelAttemptReconciliation(
    attemptId: string,
    expectedRevision: number,
    resolution: ModelAttemptReconciliationResolution
  ): Promise<void>
}

export function refreshTaskRecoveryAfterEvent(
  event: AgentEvent,
  refresh: () => Promise<void>
): void {
  if (event.kind === 'turn-result' || (event.kind === 'status' && event.status === 'error')) void refresh()
}

export async function requireMcpProbeResults(
  outcome: McpProbeOperationResult,
  refreshRecovery: () => Promise<void>
): Promise<McpProbeResult[]> {
  if (outcome.ok) return outcome.results
  if (outcome.effectStatus === 'waiting_reconciliation') await refreshRecovery()
  throw new Error(outcome.error)
}

function createWorkflowAttentionRefresh(
  set: (update: TaskRecoveryStateUpdate) => void,
  get: () => TaskRecoveryState
): () => Promise<void> {
  let workflowAttentionFlight: Promise<void> | null = null
  return async function refreshWorkflowAttention(): Promise<void> {
    if (workflowAttentionFlight) return workflowAttentionFlight
    const flight = (async () => {
      set({ workflowAttentionLoading: true, workflowAttentionError: undefined })
      const [workItemsResult, supervisorResult] = await Promise.allSettled([
        window.agentDesk.listProjectWorkItems(undefined, { includeArchived: true }),
        window.agentDesk.listSupervisorRuns()
      ])
      const attentionStatuses = new Set<WorkItem['status']>(['running', 'waiting_approval', 'blocked', 'verifying', 'failed'])
      const errors = [
        workItemsResult.status === 'rejected' ? `WorkItem: ${errorMessage(workItemsResult.reason)}` : undefined,
        supervisorResult.status === 'rejected' ? `Supervisor: ${errorMessage(supervisorResult.reason)}` : undefined
      ].filter((value): value is string => Boolean(value))
      set({
        workflowAttentionWorkItems: workItemsResult.status === 'fulfilled'
          ? workItemsResult.value.filter((item) => attentionStatuses.has(item.status) || item.acceptance?.status === 'failed')
          : get().workflowAttentionWorkItems,
        workflowAttentionSupervisorRuns: supervisorResult.status === 'fulfilled'
          ? supervisorResult.value.filter((run) => run.origin === 'task_run' && [
            'queued', 'running', 'waiting_approval', 'waiting_reconciliation', 'paused', 'blocked', 'failed'
          ].includes(run.status))
          : get().workflowAttentionSupervisorRuns,
        workflowAttentionLoading: false,
        workflowAttentionError: errors.length > 0 ? errors.join('\n') : undefined
      })
    })()
    workflowAttentionFlight = flight
    try {
      await flight
    } finally {
      if (workflowAttentionFlight === flight) workflowAttentionFlight = null
    }
  }
}

export function createTaskRecoveryActions(
  set: (update: TaskRecoveryStateUpdate) => void,
  get: () => TaskRecoveryState
): TaskRecoveryActions {
  const refreshWorkflowAttention = createWorkflowAttentionRefresh(set, get)
  return {
    modelAttemptReconciliations: [],
    workflowAttentionWorkItems: [],
    workflowAttentionSupervisorRuns: [],
    workflowAttentionLoading: false,
    workflowAttentionActionError: undefined,

    refreshWorkflowAttention,

    async controlWorkflowSupervisorRun(run, action) {
      set({ workflowAttentionActionError: undefined })
      try {
        if (action === 'cancel') {
          await window.agentDesk.cancelSupervisorRun(run.id, { expectedRevision: run.revision })
        } else if (action === 'retry') {
          await window.agentDesk.retrySupervisorRun(run.id, { expectedRevision: run.revision })
        } else {
          const leased = await window.agentDesk.claimSupervisorControlLease(run.id, run.revision)
          const lease = leased.lease
          if (!lease) throw new Error(`Supervisor Run ${run.id} did not return a control lease`)
          const options = {
            ownerId: lease.ownerId,
            leaseId: lease.id,
            fencingToken: lease.fencingToken,
            expectedRevision: leased.revision
          }
          if (action === 'pause') await window.agentDesk.pauseSupervisorRun(run.id, options)
          else if (action === 'resume') await window.agentDesk.resumeSupervisorRun(run.id, options)
          else throw new Error(`Unsupported Supervisor action: ${action}`)
        }
        await get().refreshWorkflowAttention()
      } catch (error) {
        set({ workflowAttentionActionError: errorMessage(error) })
        await get().refreshWorkflowAttention()
        throw error
      }
    },

    async hydrateTaskRecoveryCandidates() {
      set({ taskSnapshotsLoading: true, taskSnapshotsError: undefined })
      await refreshRecoveryCandidates(set, get)
    },

    async resolveTaskEffect(snapshotId, effectId, expectedRevision, resolution) {
      set({ taskSnapshotsLoading: true, taskSnapshotsError: undefined })
      try {
        const { snapshot: updated, resumedSession } = await window.agentDesk.resolveTaskEffect(
          snapshotId,
          effectId,
          expectedRevision,
          resolution
        )
        if (resumedSession) return get().recoverTaskSnapshot(resumedSession.id)
        set({
          taskSnapshots: get().taskSnapshots.map(
            (snapshot) => snapshot.id === updated.id ? updated : snapshot
          )
        })
        await refreshRecoveryCandidates(set, get)
      } catch (error) {
        await restoreRecoveryCandidatesAfterError(set, get, error)
        throw error
      }
    },

    async resolveTaskDagFinalization(executionId, expectedRevision, resolution) {
      set({ taskSnapshotsLoading: true, taskSnapshotsError: undefined })
      try {
        await window.agentDesk.resolveTaskDagFinalization(executionId, expectedRevision, resolution)
        await refreshRecoveryCandidates(set, get)
      } catch (error) {
        await restoreRecoveryCandidatesAfterError(set, get, error)
        throw error
      }
    },

    async resolveModelAttemptReconciliation(attemptId, expectedRevision, resolution) {
      set({ taskSnapshotsLoading: true, taskSnapshotsError: undefined })
      try {
        await window.agentDesk.resolveModelAttemptReconciliation(
          attemptId,
          expectedRevision,
          resolution
        )
        await refreshRecoveryCandidates(set, get)
      } catch (error) {
        await restoreRecoveryCandidatesAfterError(set, get, error)
        throw error
      }
    }
  }
}

async function restoreRecoveryCandidatesAfterError(
  set: (update: TaskRecoveryStateUpdate) => void,
  get: () => TaskRecoveryState,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  await refreshRecoveryCandidates(set, get, message)
}

async function refreshRecoveryCandidates(
  set: (update: TaskRecoveryStateUpdate) => void,
  get: () => TaskRecoveryState,
  preferredError?: string
): Promise<void> {
  const [taskSnapshotsResult, modelAttemptsResult] = await Promise.allSettled([
    window.agentDesk.listTaskSnapshots(),
    window.agentDesk.listModelAttemptReconciliations()
  ])
  const refreshErrors = [
    taskSnapshotsResult.status === 'rejected'
      ? `task snapshots: ${errorMessage(taskSnapshotsResult.reason)}`
      : undefined,
    modelAttemptsResult.status === 'rejected'
      ? `model attempt reconciliations: ${errorMessage(modelAttemptsResult.reason)}`
      : undefined
  ].filter((message): message is string => Boolean(message))
  set({
    taskSnapshots:
      taskSnapshotsResult.status === 'fulfilled' ? taskSnapshotsResult.value : get().taskSnapshots,
    modelAttemptReconciliations:
      modelAttemptsResult.status === 'fulfilled'
        ? modelAttemptsResult.value
        : get().modelAttemptReconciliations,
    taskSnapshotsLoading: false,
    taskSnapshotsError: preferredError ?? (refreshErrors.length > 0 ? refreshErrors.join('\n') : undefined)
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
