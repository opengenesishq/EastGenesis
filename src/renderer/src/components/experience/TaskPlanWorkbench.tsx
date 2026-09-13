import { useEffect, useRef, useState } from 'react'
import type { TaskPlanStateView } from '../../../../shared/types'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import TaskPlanEditor from './TaskPlanEditor'
import { DisclosureChevron } from '../DisclosureChevron'
import { TASK_PLAN_NAVIGATION_EVENT, takeTaskPlanNavigation } from './task-plan-navigation'
import {
  emptyPlanForm,
  planFormFromVersion,
  taskPlanDraftFromForm
} from './task-plan-form'

interface TaskPlanWorkbenchProps {
  sessionId: string
  strategy: 'view' | 'plan' | 'execute'
  running: boolean
}

export default function TaskPlanWorkbench({
  sessionId,
  strategy,
  running
}: TaskPlanWorkbenchProps): React.JSX.Element | null {
  const t = useT()
  const state = useStore((store) => store.taskPlans[sessionId])
  const busy = useStore((store) => store.taskPlanBusy[sessionId] === true)
  const error = useStore((store) => store.taskPlanErrors[sessionId])
  const refresh = useStore((store) => store.refreshTaskPlan)
  const createVersion = useStore((store) => store.createTaskPlanVersion)
  const approve = useStore((store) => store.approveTaskPlan)
  const dispatchApproved = useStore((store) => store.dispatchApprovedTaskPlan)
  const revoke = useStore((store) => store.revokeTaskPlanApproval)
  const execution = useStore((store) => store.sessions[sessionId]?.taskDagExecution)
  const [expanded, setExpanded] = useState(strategy === 'plan')
  const [navigationSessionId, setNavigationSessionId] = useState<string | null>(null)
  const navigationOpened = navigationSessionId === sessionId
  const workbenchRef = useRef<HTMLElement>(null)
  const [loadedVersionId, setLoadedVersionId] = useState<string>()
  const [form, setForm] = useState(emptyPlanForm)
  const current = state?.currentVersion

  useEffect(() => {
    if (!running) void refresh(sessionId)
  }, [refresh, running, sessionId])

  useEffect(() => {
    if (strategy === 'plan') setExpanded(true)
  }, [strategy])

  useEffect(() => {
    const openRequestedPlan = (): void => {
      if (!takeTaskPlanNavigation(sessionId)) return
      setNavigationSessionId(sessionId)
      setExpanded(true)
    }
    openRequestedPlan()
    window.addEventListener(TASK_PLAN_NAVIGATION_EVENT, openRequestedPlan)
    return () => window.removeEventListener(TASK_PLAN_NAVIGATION_EVENT, openRequestedPlan)
  }, [sessionId])

  useEffect(() => {
    if (!navigationOpened) return
    workbenchRef.current?.focus()
    workbenchRef.current?.scrollIntoView({ block: 'nearest' })
  }, [navigationOpened])

  useEffect(() => {
    if (current?.id === loadedVersionId) return
    setForm(current ? planFormFromVersion(current) : emptyPlanForm())
    setLoadedVersionId(current?.id)
  }, [current, loadedVersionId])

  if (strategy !== 'plan' && !current && !navigationOpened) return null

  const save = async (): Promise<void> => {
    const plan = await createVersion(sessionId, taskPlanDraftFromForm(form))
    if (plan?.currentVersion) setLoadedVersionId(plan.currentVersion.id)
  }
  const approveCurrent = async (): Promise<boolean> => {
    if (!current) return false
    const result = await approve(sessionId, { version: current.version, digest: current.digest })
    return result?.approvalStatus === 'approved'
  }
  const approveAndExecute = async (): Promise<void> => {
    if (!await approveCurrent()) return
    if (!current) return
    await dispatchApproved(sessionId, { version: current.version, digest: current.digest })
  }
  const revokeCurrent = (): void => {
    if (current) void revoke(sessionId, { version: current.version, digest: current.digest })
  }

  return (
    <section ref={workbenchRef} className="task-plan-workbench no-drag" tabIndex={-1}
      data-task-plan-session={sessionId} data-task-plan-status={state?.approvalStatus ?? 'not_created'}>
      <TaskPlanSummary
        t={t}
        state={state}
        executionStatus={execution?.status}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      />
      {state?.approvalStatus === 'approved' && state.projection && (
        <div className={`task-plan-projection task-plan-projection-${state.projection.mode}`}
          data-task-plan-projection={state.projection.mode}>
          {state.projection.mode === 'canonical'
            ? `${t('taskPlanCanonicalProjection')} · ${state.projection.steps.length} WorkItems`
            : t('taskPlanConversationProjection')}
        </div>
      )}
      {expanded && (
        <TaskPlanEditor
          t={t}
          form={form}
          setForm={setForm}
          state={state}
          running={running}
          busy={busy}
          canEdit={strategy === 'plan' && !running && !busy}
          canApprove={Boolean(current) && strategy === 'plan' && !running && !busy}
          error={error}
          onSave={() => void save()}
          onApprove={() => void approveCurrent()}
          onApproveAndExecute={() => void approveAndExecute()}
          onRevoke={revokeCurrent}
        />
      )}
    </section>
  )
}

interface TaskPlanSummaryProps {
  t: ReturnType<typeof useT>
  state?: TaskPlanStateView
  executionStatus?: 'waiting' | 'running' | 'success' | 'failed'
  expanded: boolean
  onToggle(): void
}

function TaskPlanSummary({ t, state, executionStatus, expanded, onToggle }: TaskPlanSummaryProps): React.JSX.Element {
  const current = state?.currentVersion
  const statusLabel = state?.approvalStatus === 'approved'
    ? t('taskPlanApproved')
    : state?.approvalStatus === 'pending'
      ? t('taskPlanPending')
      : t('taskPlanNotCreated')
  const digest = current?.digest.slice(7, 19)
  const executionLabel = executionStatus === 'waiting' || executionStatus === 'running'
    ? t('taskPlanExecuting')
    : executionStatus === 'success'
      ? t('taskPlanExecutionComplete')
      : executionStatus === 'failed'
        ? t('taskPlanExecutionFailed')
        : undefined
  return (
    <div className="task-plan-summary">
      <button type="button" className="task-plan-toggle" aria-expanded={expanded}
        title={expanded ? t('taskPlanCollapse') : t('taskPlanExpand')} onClick={onToggle}>
        <DisclosureChevron expanded={expanded} />
      </button>
      <strong>{t('taskPlanTitle')}</strong>
      <span className="task-plan-version">v{current?.version ?? 0}{digest ? ` · ${digest}` : ''}</span>
      <span className={`task-plan-status task-plan-status-${state?.approvalStatus ?? 'not_created'}`}>
        {statusLabel}{executionLabel ? ` · ${executionLabel}` : ''}
      </span>
    </div>
  )
}
