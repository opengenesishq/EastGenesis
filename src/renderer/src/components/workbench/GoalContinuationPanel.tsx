import { useCallback, useEffect, useState } from 'react'
import type { Routine } from '../../../../main/routineStore'
import type { Goal } from '../../../../shared/project-workspace-types'
import type { SessionMeta, SupervisorRunRecord } from '../../../../shared/types'
import { useStore } from '../../store'
import { useGoalControlNavigation } from '../../store/goal-control-navigation'
import GoalObjectiveRevision from './GoalObjectiveRevision'
import TaskBudgetSummary from './TaskBudgetSummary'
import './goal-continuation-panel.css'

const PROMPT = '继续推进当前任务关联的目标。先核对已有成果、验收标准、审批和未解决的执行结果，再完成下一个有实际进展的步骤。沿用当前授权和预算；不重复已经确认完成的操作。需要用户决定或没有可继续的步骤时明确说明。目标完成以任务系统的验收和完成记录为准。'

export default function GoalContinuationPanel({ meta, runId }: { meta: SessionMeta; runId?: string }): React.JSX.Element | null {
  const language = useStore(state => state.settings.language)
  const zh = language === 'zh'
  const [goal, setGoal] = useState<Goal>()
  const [routine, setRoutine] = useState<Routine>()
  const [maxTurns, setMaxTurns] = useState(5)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [editingObjective, setEditingObjective] = useState(false), [clearing, setClearing] = useState(false), [notice, setNotice] = useState('')
  const [expanded, setExpanded] = useState(false)
  const navigation = useGoalControlNavigation(state => state.request)
  useEffect(() => {
    if (navigation?.sessionId !== meta.id) return
    setExpanded(true)
    if (navigation.action === 'edit') { setEditingObjective(true); setClearing(false) }
    if (navigation.action === 'clear') { setClearing(true); setEditingObjective(false) }
    useGoalControlNavigation.getState().consume(navigation.nonce)
  }, [navigation, meta.id])
  useEffect(() => { if (routine && routine.goalContinuationState?.status !== 'exited') setExpanded(true) }, [routine?.id, routine?.goalContinuationState?.status])
  const refresh = useCallback(async (): Promise<void> => {
    if (!meta.goalId || !meta.workItemId || !meta.workspaceId) return
    const [nextGoal, routines] = await Promise.all([window.agentDesk.getProjectGoal(meta.goalId), window.agentDesk.listRoutines()])
    if (!nextGoal || nextGoal.projectId !== meta.workspaceId) throw new Error(zh ? '目标归属无法核对。' : 'Goal ownership could not be verified.')
    const selected = routines.filter(item => item.goalContinuation && item.executionTarget?.sessionId === meta.id)
    if (selected.length > 1) throw new Error(zh ? '此任务存在多个持续推进计划，请在计划任务中处理。' : 'Manage duplicate continuation plans in Schedules.')
    setGoal(nextGoal); setRoutine(selected[0])
    if (!editing) { setMaxTurns(selected[0]?.goalContinuation?.maxTurns ?? 5); setAmount(nextGoal.budget?.amount ? String(nextGoal.budget.amount) : '') }
  }, [meta.id, meta.goalId, meta.workItemId, meta.workspaceId, zh, editing])
  useEffect(() => {
    void refresh().catch(cause => setError(String(cause)))
    const timer = window.setInterval(() => { if (!document.hidden && !busy) void refresh().catch(cause => setError(String(cause))) }, 10000)
    return () => window.clearInterval(timer)
  }, [refresh, busy])
  if (!meta.goalId || !meta.workItemId || !meta.workspaceId) return null
  const invoke = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError('')
    try { await operation(); setEditing(false); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const executionControl = async (action: 'pause' | 'resume'): Promise<void> => {
    if (!runId) {
      if (action === 'pause' && (meta.status === 'running' || meta.status === 'starting')) throw new Error(zh ? '持续推进已暂停；当前执行记录尚未读取，请用输入框旁的停止按钮暂停本轮。' : 'Continuation is paused. Use the composer stop button while the execution record loads.')
      return
    }
    const runs = await window.agentDesk.listSupervisorRuns({ projectId: meta.workspaceId })
    const current = runs.find(item => item.id === runId && item.workItemId === meta.workItemId && item.origin === 'task_run')
    if (!current || (action === 'pause' ? !['running', 'waiting_approval'].includes(current.status) : !['paused', 'blocked'].includes(current.status))) return
    await controlRun(current, action)
  }
  const enable = async (): Promise<void> => {
    if (!goal) throw new Error(zh ? '请等待目标读取。' : 'Wait for the goal to load.')
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100) throw new Error(zh ? '总轮数必须为 1–100。' : 'Set a total of 1–100 turns.')
    if (goal.budget?.currency && goal.budget.currency.toUpperCase() !== 'USD') throw new Error(zh ? '当前目标预算不是 USD，请先在项目中核对预算币种。' : 'Review the goal budget currency in the project before continuing.')
    const limit = amount.trim() ? Number(amount) : 0
    if (!Number.isFinite(limit) || limit < 0) throw new Error(zh ? '预算必须是非负金额。' : 'Budget must be a non-negative amount.')
    if (limit !== (goal.budget?.amount ?? 0)) await window.agentDesk.updateProjectGoal(goal.id, { budget: { ...goal.budget, amount: limit, currency: 'USD' } }, { expectedRevision: goal.revision })
    await executionControl('resume')
    const definition = { executionTarget: { kind: 'existing_session' as const, sessionId: meta.id },
      goalContinuation: { maxTurns }, enabled: true, schedule: 'every 1m', prompt: PROMPT }
    const saved = routine ? await window.agentDesk.updateRoutine(routine.id, definition) : await window.agentDesk.createRoutine({
      ...definition, name: `${zh ? '持续目标' : 'Continue goal'} · ${goal.title}`, notification: { enabled: true, onFailure: true, onSuccess: false } })
    if (!saved) throw new Error(zh ? '计划已变化，请刷新。' : 'The plan changed; refresh to continue.')
    setRoutine(saved)
    await window.agentDesk.runRoutineNow(saved.id)
  }
  const pause = async (): Promise<void> => {
    if (routine) await window.agentDesk.updateRoutine(routine.id, { enabled: false })
    await executionControl('pause')
  }
  const clear = async (): Promise<void> => {
    const result = await window.agentDesk.clearSessionGoalMode(meta.id)
    if (result.sessionId !== meta.id) throw new Error('退出回执与当前任务不一致')
    setClearing(false)
    setNotice(result.reason ?? (zh ? '已退出持续目标模式；原任务、费用、文件版本和已用轮数均已保留。' : 'Goal mode exited. Task history, cost, file versions and used turns are retained.'))
    if (!result.executionPaused || result.pendingInputIds.length) setError(result.reason ?? (zh ? '存在已提交或待核对的执行，请查看原任务运行记录。' : 'Submitted or unresolved work remains. Review the original run.'))
    await useStore.getState().syncSession(meta.id)
  }
  const state = routine?.goalContinuationState
  const terminal = goal && ['completed', 'failed', 'cancelled', 'archived'].includes(goal.status)
  return <details className="goal-continuation-panel" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary data-goal-mode-summary><strong>{zh ? '持续推进目标' : 'Continue toward the goal'}</strong><span>{routine?.enabled ? (zh ? '已开启' : 'Enabled') : (state?.status === 'exited' ? (zh ? '已退出' : 'Exited') : (zh ? '未运行' : 'Not running'))}</span></summary>
    <p>{goal?.objective ?? (zh ? '正在读取当前目标…' : 'Reading the current goal…')}</p>
    <p className="goal-continuation-note">{zh ? '沿用当前任务，每轮结束后继续。电脑与应用保持运行；审批、预算不足或结果待核对时停止派发。' : 'Continues in this task after each turn while the app is running. Approval, budget and unresolved-result gates still apply.'}</p>
    <div className="goal-continuation-fields">
      <label>{zh ? '总轮数上限' : 'Total turn limit'}<input type="number" className="input" min={1} max={100} value={maxTurns} disabled={busy || routine?.enabled} onChange={event => { setEditing(true); setMaxTurns(Number(event.target.value)) }} /></label>
      <label>{zh ? '目标总预算（USD，可选）' : 'Total goal budget (USD, optional)'}<input type="number" className="input" min={0} step="0.01" value={amount} disabled={busy || routine?.enabled} placeholder={zh ? '仍受轮数上限约束' : 'Turn limit always applies'} onChange={event => { setEditing(true); setAmount(event.target.value) }} /></label>
    </div>
    <p>{zh ? `已预留 ${state?.turns ?? 0} / ${routine?.goalContinuation?.maxTurns ?? maxTurns} 轮；失败或结果未知的轮次计入上限。` : `${state?.turns ?? 0} / ${routine?.goalContinuation?.maxTurns ?? maxTurns} turns reserved; failures and unknown outcomes count.`}</p>
    {Boolean(state?.reason || routine?.lastError) && <p role="status">{state?.reason || String(routine?.lastError)}</p>}
    <div className="goal-continuation-actions">
      <button data-goal-mode-edit type="button" className="btn btn-secondary btn-sm" disabled={busy || !goal || Boolean(meta.parentSessionId)} onClick={() => setEditingObjective(true)}>{zh ? '编辑目标' : 'Edit goal'}</button>
      <button data-goal-mode-clear type="button" className="btn btn-ghost btn-sm" disabled={busy || Boolean(meta.parentSessionId)} onClick={() => setClearing(true)}>{zh ? '清除持续目标' : 'Clear goal mode'}</button>
      {routine?.enabled ? <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void invoke(pause)}>{zh ? '暂停推进与执行' : 'Pause continuation and execution'}</button>
        : <button type="button" className="btn btn-primary btn-sm" disabled={busy || !goal || Boolean(terminal)} onClick={() => void invoke(enable)}>{zh ? (routine ? '保存并恢复推进' : '保存并开启推进') : (routine ? 'Save and resume' : 'Save and enable')}</button>}
    </div>
    {clearing && <div className="goal-mode-clear-confirm" role="group" aria-label={zh ? '确认退出持续目标' : 'Confirm exit goal mode'}>
      <p>{zh ? '退出持续目标模式并暂停当前执行，撤回尚未发送的自动继续。原任务、历史、费用及已用轮数仍然保留。' : 'Exit goal mode, pause execution and withdraw unsent automatic continuations. Task history, cost and used turns are retained.'}</p>
      <button data-goal-mode-clear-confirm type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void invoke(clear)}>{zh ? '退出并暂停' : 'Exit and pause'}</button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setClearing(false)}>{zh ? '取消' : 'Cancel'}</button>
    </div>}
    {editingObjective && <GoalObjectiveRevision key={meta.id} meta={meta} onClose={() => setEditingObjective(false)} onSaved={() => { void refresh().catch(cause => setError(String(cause))) }} />}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    <TaskBudgetSummary sessionId={meta.id} language={zh ? 'zh' : 'en'} />
  </details>
}

async function controlRun(run: SupervisorRunRecord, action: 'pause' | 'resume'): Promise<void> {
  const leased = await window.agentDesk.claimSupervisorControlLease(run.id, run.revision)
  const lease = leased.lease
  if (!lease) throw new Error('执行控制租约不可用。 / Run control lease unavailable.')
  const options = { expectedRevision: leased.revision, ownerId: lease.ownerId, leaseId: lease.id, fencingToken: lease.fencingToken }
  if (action === 'pause') await window.agentDesk.pauseSupervisorRun(run.id, options)
  else await window.agentDesk.resumeSupervisorRun(run.id, options)
}
