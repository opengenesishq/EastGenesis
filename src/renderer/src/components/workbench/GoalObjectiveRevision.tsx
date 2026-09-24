import { useEffect, useRef, useState } from 'react'
import type { Goal, WorkItem } from '../../../../shared/project-workspace-types'
import type { SessionMeta } from '../../../../shared/types'
import type { SessionInputRecord } from '../../../../shared/session-input-types'
import { previewSessionGoalRevision } from '../../../../shared/session-goal-revision'
import { useStore } from '../../store'
import { announceRequirementRevision } from '../experience/requirement-revision-events'
import { requestTaskPlanNavigation } from '../experience/task-plan-navigation'

export default function GoalObjectiveRevision({ meta, initialRecord, onClose, onSaved }: {
  meta: SessionMeta; initialRecord?: SessionInputRecord; onClose(): void; onSaved?(): void
}): React.JSX.Element {
  const zh = useStore(state => state.settings.language) === 'zh'
  const [baseline, setBaseline] = useState<{ goal: Goal; item: WorkItem }>()
  const [text, setText] = useState(initialRecord?.payload.text ?? '')
  const [record, setRecord] = useState(initialRecord)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const mounted = useRef(true), inFlight = useRef(false), requestId = useRef(initialRecord?.id)
  const running = meta.status === 'running' || meta.status === 'starting'
  const load = async (): Promise<void> => {
    if (!meta.goalId || !meta.workItemId || !meta.workspaceId || meta.parentSessionId) throw new Error('请打开原目标任务')
    const [goal, item] = await Promise.all([window.agentDesk.getProjectGoal(meta.goalId), window.agentDesk.getProjectWorkItem(meta.workItemId)])
    if (!goal || !item || goal.projectId !== meta.workspaceId || item.projectId !== meta.workspaceId || item.goalId !== goal.id) throw new Error('目标归属无法核对')
    if (mounted.current) { setBaseline({ goal, item }); if (!requestId.current) setText(goal.objective) }
  }
  useEffect(() => { mounted.current = true; void load().catch(cause => setError(String(cause))); return () => { mounted.current = false } }, [meta.id, meta.goalId, meta.workItemId])
  const saved = record?.phase === 'goal_revised'
  const intent = record?.payload.goalRevisionIntent
  const stale = Boolean(baseline && intent && (baseline.goal.revision !== intent.expectedGoalRevision || baseline.item.revision !== intent.expectedWorkItemRevision))
  let preview: ReturnType<typeof previewSessionGoalRevision> | undefined
  try { if (baseline && text.trim()) preview = previewSessionGoalRevision(baseline.goal, text) } catch { /* save shows validation error */ }
  const invoke = async (operation: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    try { await operation() } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }
  const accept = (next: SessionInputRecord): void => {
    if (next.id !== requestId.current || next.sessionId !== meta.id || next.goalId !== meta.goalId || next.workItemId !== meta.workItemId || next.workspaceId !== meta.workspaceId) throw new Error('目标修订回执归属不一致')
    if (mounted.current) setRecord(next)
    if (next.phase === 'goal_revised') { announceRequirementRevision(meta.id); onSaved?.() }
  }
  const save = async (): Promise<void> => {
    if (!baseline || running || stale || saved) return
    previewSessionGoalRevision(baseline.goal, text)
    requestId.current ??= crypto.randomUUID()
    const queued = record ?? await window.agentDesk.queueSessionInput(meta.id, requestId.current, {
      text: text.trim(), goalRevisionIntent: { schemaVersion: 1, kind: 'revise_goal_objective',
        expectedGoalRevision: baseline.goal.revision, expectedWorkItemRevision: baseline.item.revision } })
    accept(queued)
    if (queued.phase === 'queued') accept(await window.agentDesk.applySessionInput(meta.id, queued.id))
  }
  const replan = async (): Promise<void> => {
    if (!saved || !meta.goalId) return
    const goal = await window.agentDesk.getProjectGoal(meta.goalId)
    if (!goal || goal.projectId !== meta.workspaceId) throw new Error('目标归属无法核对')
    await window.agentDesk.setTaskStrategy(meta.id, 'plan')
    const plan = await window.agentDesk.generateTaskPlan(meta.id, { objective: goal.objective, expectedGoalRevision: goal.revision })
    useStore.setState(state => ({ taskPlans: { ...state.taskPlans, [meta.id]: plan } }))
    await useStore.getState().syncSession(meta.id)
    requestTaskPlanNavigation(meta.id); onClose()
  }
  return <section className="goal-objective-revision no-drag" role="region" aria-label={zh ? '编辑当前目标' : 'Edit current goal'} data-goal-objective-revision={meta.id}>
    <strong>{zh ? '编辑当前目标' : 'Edit current goal'}</strong>
    <p>{zh ? '保存后重新核对计划和验收。原任务、文件版本、执行记录与已用轮数保留，预算和禁止事项继续适用。' : 'Review the plan and acceptance again after saving. Task identity, files, history, used turns, budget and prohibitions are retained.'}</p>
    {baseline && <p>{zh ? '原目标' : 'Current goal'} v{baseline.goal.revision} · {zh ? '任务' : 'Task'} v{baseline.item.revision}：{baseline.goal.objective}</p>}
    <label>{zh ? '新目标' : 'New goal'}<textarea data-goal-objective-text rows={3} maxLength={20_000} value={text} disabled={busy || Boolean(record)} onChange={event => setText(event.target.value)} /></label>
    {preview && <div><strong>{zh ? '待重新核对的验收' : 'Acceptance to review'}</strong><ul>{preview.acceptance.map(item => <li key={item.id}>{item.criterion}</li>)}</ul></div>}
    {running && <p role="status">{zh ? '本轮结束、待核对执行已处理后可保存目标修订。' : 'Save after this turn ends and unresolved execution has been reconciled.'}</p>}
    {stale && !saved && <p role="alert">{zh ? '原目标版本已变化，请撤回旧请求后重新编辑。' : 'The goal version changed. Withdraw this request and edit again.'}</p>}
    {saved && <p role="status" data-goal-objective-saved>{zh ? `目标已修订为 v${record.goalRevision?.goalRevision}；请重新生成并确认计划后执行。` : `Goal revised to v${record.goalRevision?.goalRevision}. Regenerate and approve the plan before execution.`}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="goal-continuation-actions">
      {!saved && <button data-goal-objective-save className="btn btn-primary btn-sm" disabled={busy || running || !baseline || stale || !text.trim() || text.trim() === baseline.goal.objective || Boolean(record && record.phase !== 'queued')} onClick={() => void invoke(save)}>{zh ? '保存目标修订' : 'Save goal revision'}</button>}
      {saved && <button data-goal-objective-replan className="btn btn-primary btn-sm" disabled={busy || running} onClick={() => void invoke(replan)}>{zh ? '重新生成并核对计划' : 'Regenerate and review plan'}</button>}
      {record?.phase === 'queued' && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void invoke(async () => {
        const next = await window.agentDesk.cancelSessionInput(meta.id, record.id)
        if (next.phase !== 'cancelled') throw new Error('撤回回执无法核对')
        requestId.current = undefined; setRecord(undefined); await load()
      })}>{zh ? '撤回旧请求并重编辑' : 'Withdraw and edit again'}</button>}
      {requestId.current && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void invoke(async () => {
        const next = (await window.agentDesk.listSessionInputs(meta.id)).find(item => item.id === requestId.current)
        if (!next) throw new Error('原修订回执尚未找到，请保留当前提交标识')
        accept(next)
      })}>{zh ? '核对回执' : 'Check receipt'}</button>}
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose}>{zh ? '关闭' : 'Close'}</button>
    </div>
  </section>
}
