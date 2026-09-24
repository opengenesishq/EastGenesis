import { useEffect, useState } from 'react'
import type { SessionMeta } from '../../../../shared/types'
import type { Goal } from '../../../../shared/project-workspace-types'
import { useStore } from '../../store'
import { useGoalControlNavigation, type GoalControlAction } from '../../store/goal-control-navigation'
import { REQUIREMENTS_CHANGED_EVENT } from '../experience/requirement-revision-events'
import './task-goal-bar.css'

export default function TaskGoalBar({ meta }: { meta: SessionMeta }): React.JSX.Element | null {
  const zh = useStore(state => state.settings.language === 'zh')
  const [goal, setGoal] = useState<Goal>(), [error, setError] = useState('')
  useEffect(() => {
    let active = true, sequence = 0
    const refresh = async (): Promise<void> => {
      const request = ++sequence
      try {
        if (!meta.goalId || !meta.workspaceId) return
        const next = await window.agentDesk.getProjectGoal(meta.goalId)
        if (!active || request !== sequence) return
        if (!next || next.projectId !== meta.workspaceId) throw new Error(zh ? '目标归属已变化，请刷新任务。' : 'Goal ownership changed. Refresh this task.')
        setGoal(next); setError('')
      } catch (cause) { if (active && request === sequence) { setGoal(undefined); setError(String(cause)) } }
    }
    const changed = (event: Event): void => { if ((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId === meta.id) void refresh() }
    const focused = (): void => { void refresh() }
    setGoal(undefined); setError(''); void refresh()
    window.addEventListener(REQUIREMENTS_CHANGED_EVENT, changed); window.addEventListener('focus', focused)
    return () => { active = false; sequence++; window.removeEventListener(REQUIREMENTS_CHANGED_EVENT, changed); window.removeEventListener('focus', focused) }
  }, [meta.id, meta.goalId, meta.workspaceId, meta.workItemId, meta.status, zh])
  if (!meta.goalId || !meta.workItemId || !meta.workspaceId || meta.parentSessionId) return null
  const open = (action: GoalControlAction): void => {
    useGoalControlNavigation.getState().open(meta.id, action)
    useStore.getState().openPanel('execution')
  }
  const labels: Record<Goal['status'], string> = zh ? { draft: '草稿', planned: '已计划', running: '执行中', waiting_approval: '待审批', blocked: '待处理', verifying: '验收中', completed: '已完成', failed: '失败', cancelled: '已取消', archived: '已归档' } : { draft: 'Draft', planned: 'Planned', running: 'Running', waiting_approval: 'Approval', blocked: 'Blocked', verifying: 'Verifying', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', archived: 'Archived' }
  return <section className="task-goal-bar" data-task-goal-bar={meta.id} aria-label={zh ? '当前目标' : 'Current goal'}>
    <button type="button" className="task-goal-summary" onClick={() => open('details')} title={goal?.objective ?? error}>
      <span>{zh ? '目标' : 'Goal'}{goal ? ` · ${labels[goal.status]}` : ''}</span><strong>{goal?.objective ?? (error || (zh ? '读取目标…' : 'Reading goal…'))}</strong>
    </button>
    <button type="button" className="btn btn-ghost btn-sm" data-task-goal-edit disabled={!goal} onClick={() => open('edit')}>{zh ? '编辑' : 'Edit'}</button>
    <button type="button" className="btn btn-ghost btn-sm" data-task-goal-clear onClick={() => open('clear')}>{zh ? '退出持续模式' : 'Exit goal mode'}</button>
  </section>
}
