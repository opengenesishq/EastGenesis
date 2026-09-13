import { useEffect, useMemo, useRef, useState } from 'react'
import { Ban, CirclePause, Play, RotateCcw } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  EffectRecord,
  TaskDagFinalizationResolution,
  TaskDagFinalizationView,
  TaskSnapshotRecord,
  WorkItem,
  SupervisorRunRecord
} from '../../../shared/types'
import { useStore } from '../store'
import {
  modelAttemptMatchesSnapshot,
  ModelAttemptRecoveryPanel
} from './ModelAttemptRecoveryPanel'
import { isTaskSnapshotRecoverable, TaskRecoveryItem } from './TaskRecoveryItem'
import { requestProjectWorkspaceNavigation } from './studio/projectWorkspaceNavigation'

type SupervisorControlAction = 'pause' | 'cancel' | 'resume' | 'retry'

function useRecoveryAttentionRefresh(
  ready: boolean,
  showTaskRecovery: boolean,
  refreshWorkflowAttention: () => Promise<void>
): void {
  const initialHydrationOwnedByStore = useRef(true)
  useEffect(() => {
    if (!ready || !showTaskRecovery) return
    if (initialHydrationOwnedByStore.current) {
      initialHydrationOwnedByStore.current = false
      return
    }
    void refreshWorkflowAttention()
  }, [ready, refreshWorkflowAttention, showTaskRecovery])
}

export default function TaskRecoveryModal(): React.JSX.Element | null {
  const recovery = useTaskRecoveryView()
  if (!recovery.available || !recovery.show) return null
  return <TaskRecoveryDrawer recovery={recovery} />
}

function useTaskRecoveryView() {
  const ready = useStore((s) => s.ready)
  const sessions = useStore((s) => s.sessions)
  const snapshots = useStore((s) => s.taskSnapshots)
  const modelAttemptReconciliations = useStore((s) => s.modelAttemptReconciliations)
  const attentionWorkItems = useStore((s) => s.workflowAttentionWorkItems)
  const attentionSupervisorRuns = useStore((s) => s.workflowAttentionSupervisorRuns)
  const attentionLoading = useStore((s) => s.workflowAttentionLoading)
  const attentionError = useStore((s) => s.workflowAttentionError)
  const attentionActionError = useStore((s) => s.workflowAttentionActionError)
  const refreshWorkflowAttention = useStore((s) => s.refreshWorkflowAttention)
  const controlWorkflowSupervisorRun = useStore((s) => s.controlWorkflowSupervisorRun)
  const loading = useStore((s) => s.taskSnapshotsLoading)
  const error = useStore((s) => s.taskSnapshotsError)
  const language = useStore((s) => s.settings.language)
  const showTaskRecovery = useStore((s) => s.showTaskRecovery)
  const recoverTaskSnapshot = useStore((s) => s.recoverTaskSnapshot)
  const resolveTaskEffect = useStore((s) => s.resolveTaskEffect)
  const resolveTaskDagFinalization = useStore((s) => s.resolveTaskDagFinalization)
  const deleteTaskSnapshot = useStore((s) => s.deleteTaskSnapshot)
  const setShowTaskRecovery = useStore((s) => s.setShowTaskRecovery)
  const selectSession = useStore((s) => s.selectSession)
  const openProjectWorkspace = useStore((s) => s.openProjectWorkspace)
  const [busyId, setBusyId] = useState<string | null>(null)
  const activeIds = useMemo(() => new Set(Object.keys(sessions)), [sessions])
  const recoverable = snapshots.filter((snapshot) =>
    isTaskSnapshotRecoverable(snapshot, activeIds) ||
    modelAttemptReconciliations.some((item) => modelAttemptMatchesSnapshot(item, snapshot))
  )
  const permissionSessions = Object.values(sessions).filter((session) => session.pendingPermissions.length > 0)
  const attentionCount = attentionWorkItems.length + attentionSupervisorRuns.length + permissionSessions
    .reduce((total, session) => total + session.pendingPermissions.length, 0)

  useRecoveryAttentionRefresh(ready, showTaskRecovery, refreshWorkflowAttention)

  const recover = async (snapshot: TaskSnapshotRecord): Promise<void> => {
    setBusyId(snapshot.id)
    try {
      await recoverTaskSnapshot(snapshot.id)
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (snapshot: TaskSnapshotRecord): Promise<void> => {
    setBusyId(snapshot.id)
    try {
      await deleteTaskSnapshot(snapshot.id)
    } finally {
      setBusyId(null)
    }
  }

  const resolveEffect = async (
    snapshot: TaskSnapshotRecord,
    effect: EffectRecord,
    resolution: 'confirmed_applied' | 'confirmed_not_applied'
  ): Promise<void> => {
    setBusyId(effect.id)
    try {
      await resolveTaskEffect(snapshot.id, effect.id, effect.revision, resolution)
    } catch {
      // Store 保留并展示 IPC/CAS 错误；此处只消费事件处理 Promise。
    } finally {
      setBusyId(null)
    }
  }

  const resolveFinalization = async (
    finalization: TaskDagFinalizationView,
    resolution: TaskDagFinalizationResolution
  ): Promise<void> => {
    setBusyId(finalization.executionId)
    try {
      await resolveTaskDagFinalization(finalization.executionId, finalization.revision, resolution)
    } catch {
      // Store keeps the CAS/IPC error visible in the recovery modal.
    } finally {
      setBusyId(null)
    }
  }

  const controlSupervisorRun = async (
    run: SupervisorRunRecord,
    action: SupervisorControlAction
  ): Promise<void> => {
    setBusyId(`supervisor:${run.id}`)
    try {
      await controlWorkflowSupervisorRun(run, action)
    } catch {
      // The store retains the control failure for this drawer.
    } finally {
      setBusyId(null)
    }
  }

  const close = (): void => setShowTaskRecovery(false)
  const openProject = (projectId: string, workItemId?: string): void => {
    openProjectWorkspace(projectId)
    if (workItemId) requestProjectWorkspaceNavigation(projectId, 'work-item', workItemId)
    close()
  }
  const openSession = (sessionId: string): void => {
    selectSession(sessionId)
    close()
  }

  return {
    attentionCount,
    attentionActionError,
    attentionError,
    attentionLoading,
    attentionSupervisorRuns,
    attentionWorkItems,
    // An explicit open must remain visible even when every queue is empty.
    // Readiness still prevents rendering before the canonical store is ready.
    available: ready,
    busyId,
    close,
    controlSupervisorRun,
    error,
    language,
    loading,
    modelAttemptReconciliations,
    openProject,
    openSession,
    permissionSessions,
    recover,
    recoverable,
    remove,
    resolveEffect,
    resolveFinalization,
    setBusyId,
    show: showTaskRecovery,
    snapshots
  }
}

type TaskRecoveryView = ReturnType<typeof useTaskRecoveryView>

function TaskRecoveryDrawer({ recovery }: { recovery: TaskRecoveryView }): React.JSX.Element {
  const labels = taskRecoveryLabels(recovery.language, {
    attention: recovery.attentionCount,
    attempts: recovery.modelAttemptReconciliations.length,
    snapshots: recovery.recoverable.length
  })
  const empty = recovery.attentionCount === 0 && recovery.modelAttemptReconciliations.length === 0 && recovery.recoverable.length === 0
  const settled = !recovery.loading && !recovery.attentionLoading
  const failed = Boolean(recovery.error || recovery.attentionError || recovery.attentionActionError)
  return (
    <aside
      className="task-recovery-drawer no-drag"
      data-task-recovery-drawer="true"
      data-task-recovery-attention-count={recovery.attentionCount}
      data-task-recovery-snapshot-count={recovery.recoverable.length}
      data-task-recovery-model-attempt-count={recovery.modelAttemptReconciliations.length}
      role="dialog"
      aria-modal="false"
      aria-labelledby="task-recovery-title"
    >
      <header className="task-recovery-drawer-header">
        <div>
          <h2 id="task-recovery-title" className="modal-title">{labels.title}</h2>
          <p className="task-recovery-subtitle">{labels.subtitle}</p>
        </div>
        <button
          type="button"
          className="icon-btn task-recovery-drawer-close"
          aria-label={labels.close}
          title={labels.close}
          disabled={recovery.busyId !== null}
          onClick={recovery.close}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div className="task-recovery-drawer-body">
        {recovery.error && <div className="notice notice-error task-recovery-notice">{recovery.error}</div>}
        {recovery.attentionError && <div className="notice notice-error task-recovery-notice">{recovery.attentionError}</div>}
        {recovery.attentionActionError && <div className="notice notice-error task-recovery-notice">{recovery.attentionActionError}</div>}
        {recovery.loading && <div className="task-recovery-meta">{recovery.language === 'zh' ? '正在刷新恢复候选...' : 'Refreshing recovery candidates...'}</div>}
        {recovery.attentionLoading && <div className="task-recovery-meta">{recovery.language === 'zh' ? '正在刷新工作流事项...' : 'Refreshing workflow attention...'}</div>}
        {empty && settled && !failed && <div className="task-recovery-attention" role="status" data-task-recovery-empty="true">
          <header><h3>{labels.emptyTitle}</h3></header>
          <p className="task-recovery-meta">{labels.emptyDescription}</p>
        </div>}

        <div className="task-recovery-list">
          <WorkflowAttentionPanel
            workItems={recovery.attentionWorkItems}
            supervisorRuns={recovery.attentionSupervisorRuns}
            permissionSessions={recovery.permissionSessions}
            busyId={recovery.busyId}
            onControlSupervisorRun={recovery.controlSupervisorRun}
            onOpenProject={recovery.openProject}
            onOpenSession={recovery.openSession}
          />
          <ModelAttemptRecoveryPanel
            reconciliations={recovery.modelAttemptReconciliations}
            snapshots={recovery.snapshots}
            busyId={recovery.busyId}
            setBusyId={recovery.setBusyId}
          />
          {recovery.recoverable.map((snapshot) => (
            <TaskRecoveryItem
              key={snapshot.id}
              snapshot={snapshot}
              modelAttemptBlocked={recovery.modelAttemptReconciliations.some((reconciliation) =>
                modelAttemptMatchesSnapshot(reconciliation, snapshot)
              )}
              busyId={recovery.busyId}
              onRecover={recovery.recover}
              onRemove={recovery.remove}
              onResolveEffect={recovery.resolveEffect}
              onResolveFinalization={recovery.resolveFinalization}
            />
          ))}
        </div>
      </div>

      <footer className="task-recovery-drawer-footer">
        <button
          className="btn btn-ghost"
          disabled={recovery.busyId !== null}
          onClick={recovery.close}
        >
          {labels.later}
        </button>
      </footer>
    </aside>
  )
}

function taskRecoveryLabels(
  language: string,
  counts: { attention: number; attempts: number; snapshots: number }
): { close: string; later: string; subtitle: string; title: string; emptyTitle: string; emptyDescription: string } {
  if (language === 'zh') {
    return {
      close: '关闭恢复中心',
      later: '稍后处理',
      emptyTitle: '当前没有待处理事项',
      emptyDescription: '没有待审批权限、需要对账的模型请求或可恢复的任务。出现需要处理的事项时会显示在这里。',
      subtitle: `检测到 ${counts.snapshots} 个任务快照、${counts.attempts} 个模型请求和 ${counts.attention} 个工作流事项。`,
      title: '恢复中心'
    }
  }
  return {
    close: 'Close Recovery Center',
    later: 'Review later',
    emptyTitle: 'No items need attention',
    emptyDescription: 'There are no pending permissions, model requests to reconcile, or recoverable tasks. Items that need review will appear here.',
    subtitle: `${counts.snapshots} task snapshots, ${counts.attempts} model requests, and ${counts.attention} workflow items need review.`,
    title: 'Recovery Center'
  }
}

function WorkflowAttentionPanel({
  workItems,
  supervisorRuns,
  permissionSessions,
  busyId,
  onControlSupervisorRun,
  onOpenProject,
  onOpenSession
}: {
  workItems: readonly WorkItem[]
  supervisorRuns: readonly SupervisorRunRecord[]
  permissionSessions: Array<{ meta: { id: string; title?: string }; pendingPermissions: unknown[] }>
  busyId: string | null
  onControlSupervisorRun: (run: SupervisorRunRecord, action: SupervisorControlAction) => Promise<void>
  onOpenProject: (projectId: string, workItemId?: string) => void
  onOpenSession: (sessionId: string) => void
}): React.JSX.Element | null {
  if (workItems.length === 0 && supervisorRuns.length === 0 && permissionSessions.length === 0) return null
  return (
    <section className="task-recovery-attention" aria-labelledby="workflow-attention-title">
      <header><h3 id="workflow-attention-title">待处理工作流</h3></header>
      <div role="list">
        {permissionSessions.map((session) => (
          <div className="task-recovery-attention-row" role="listitem" key={`permission:${session.meta.id}`}>
            <span className="task-recovery-attention-state">待审批</span>
            <div><strong>{session.meta.title || session.meta.id}</strong><small>{session.pendingPermissions.length} 项权限请求</small></div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenSession(session.meta.id)}>打开会话</button>
          </div>
        ))}
        {supervisorRuns.map((run) => (
          <div className="task-recovery-attention-row" role="listitem" key={`supervisor:${run.id}`}>
            <span className="task-recovery-attention-state">{attentionStateLabel(run.status)}</span>
            <div>
              <strong>{run.workItemId}</strong>
              <small>{supervisorRunDetail(run)}</small>
            </div>
            <div className="task-recovery-attention-actions">
              <SupervisorRunControls
                run={run}
                busy={busyId === `supervisor:${run.id}`}
                onControl={onControlSupervisorRun}
              />
              <button type="button" className="btn btn-ghost btn-sm" disabled={busyId !== null} onClick={() => onOpenProject(run.projectId, run.workItemId)}>打开项目</button>
            </div>
          </div>
        ))}
        {workItems.map((item) => (
          <div className="task-recovery-attention-row" role="listitem" key={`work-item:${item.id}`}>
            <span className="task-recovery-attention-state">{attentionStateLabel(item.acceptance?.status === 'failed' ? 'acceptance_failed' : item.status)}</span>
            <div><strong>{item.title}</strong><small>{item.description || item.id}</small></div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenProject(item.projectId, item.id)}>打开任务</button>
          </div>
        ))}
      </div>
    </section>
  )
}

function SupervisorRunControls({
  run,
  busy,
  onControl
}: {
  run: SupervisorRunRecord
  busy: boolean
  onControl: (run: SupervisorRunRecord, action: SupervisorControlAction) => Promise<void>
}): React.JSX.Element | null {
  const controls = supervisorControlsFor(run)
  if (controls.length === 0) return null
  return <div className="task-recovery-supervisor-controls" aria-label={`Supervisor 运行 ${run.id} 操作`}>
    {controls.map((control) => (
      <button
        key={control.action}
        type="button"
        className="btn btn-ghost btn-icon-sm"
        disabled={busy}
        onClick={() => void onControl(run, control.action)}
        title={control.label}
        aria-label={control.label}
      >
        <control.Icon size={14} aria-hidden="true" />
      </button>
    ))}
  </div>
}

function supervisorControlsFor(run: SupervisorRunRecord): Array<{
  action: SupervisorControlAction
  label: string
  Icon: LucideIcon
}> {
  if (run.status === 'running' || run.status === 'waiting_approval') {
    return [
      { action: 'pause', label: '暂停运行', Icon: CirclePause },
      { action: 'cancel', label: '取消运行', Icon: Ban }
    ]
  }
  if (run.status === 'queued' || run.status === 'paused' || run.status === 'blocked') {
    return [
      { action: 'resume', label: '恢复运行', Icon: Play },
      { action: 'cancel', label: '取消运行', Icon: Ban }
    ]
  }
  if (run.status === 'failed') {
    return [{ action: 'retry', label: '授权重试', Icon: RotateCcw }]
  }
  return []
}

function supervisorRunDetail(run: SupervisorRunRecord): string {
  const tokens = (run.usage?.input ?? 0) + (run.usage?.output ?? 0)
  const budget = run.budget?.maxTokens === undefined ? undefined : `${tokens}/${run.budget.maxTokens} tokens`
  const retry = `${run.retryCount}/${run.maxRetries} 次重试`
  return [run.error, budget, retry].filter((value): value is string => Boolean(value)).join(' · ') || `Supervisor Run ${run.id}`
}

function attentionStateLabel(status: string): string {
  if (status === 'queued') return '待恢复'
  if (status === 'paused') return '已暂停'
  if (status === 'waiting_approval') return '待审批'
  if (status === 'waiting_reconciliation') return '待对账'
  if (status === 'verifying') return '待验收'
  if (status === 'acceptance_failed') return '验收失败'
  if (status === 'failed' || status === 'blocked') return '失败'
  return '运行中'
}
