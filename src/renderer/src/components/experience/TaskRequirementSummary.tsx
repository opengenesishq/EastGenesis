import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { Goal, TaskPlanVersion } from '../../../../shared/types'
import { useStore } from '../../store'
import { DisclosureChevron } from '../DisclosureChevron'
import { taskRequirementSummary, type RequirementBinding, type TaskRequirementGroup } from './task-requirement-summary'
import './task-requirement-summary.css'

export default function TaskRequirementSummary({ binding, plan, running }: { binding: RequirementBinding; plan?: TaskPlanVersion; running: boolean }): React.JSX.Element {
  return <BoundRequirements key={JSON.stringify([binding.id, binding.workspaceId, binding.goalId, binding.workItemId])} binding={binding} plan={plan} running={running} />
}

function BoundRequirements({ binding, plan, running }: { binding: RequirementBinding; plan?: TaskPlanVersion; running: boolean }): React.JSX.Element {
  const zh = useStore(state => state.settings.language) === 'zh'
  const [goal, setGoal] = useState<Goal>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(Boolean(binding.goalId && binding.workspaceId))
  const [expanded, setExpanded] = useState(false)
  const toggleLabel = expanded ? (zh ? '收起交付要求' : 'Collapse requirements') : (zh ? '展开交付要求' : 'Expand requirements')
  const sequence = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    if (!binding.goalId || !binding.workspaceId) return
    const request = ++sequence.current
    setLoading(true)
    try {
      const next = await window.agentDesk.getProjectGoal(binding.goalId)
      if (!next) throw new Error(zh ? '目标要求当前不可用。' : 'The goal requirements are unavailable.')
      taskRequirementSummary(binding, next)
      if (request === sequence.current) { setGoal(next); setError('') }
    } catch (cause) {
      if (request === sequence.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (request === sequence.current) setLoading(false) }
  }, [binding.id, binding.workspaceId, binding.goalId, binding.workItemId, zh])
  useEffect(() => {
    void refresh()
    const focused = (): void => { void refresh() }
    window.addEventListener('focus', focused)
    return () => { sequence.current++; window.removeEventListener('focus', focused) }
  }, [refresh, plan?.digest, running])
  let summary: ReturnType<typeof taskRequirementSummary>
  try { summary = taskRequirementSummary(binding, goal, plan) }
  catch (cause) { return <section className="task-requirement-summary" role="alert">{cause instanceof Error ? cause.message : String(cause)}</section> }
  return <section className="task-requirement-summary" data-task-requirement-session={binding.id}
    data-goal-requirement-revision={summary.goalRevision} data-plan-requirement-version={summary.planVersion}>
    <header>
      <button type="button" className="task-plan-toggle" aria-expanded={expanded} aria-label={toggleLabel} title={toggleLabel} onClick={() => setExpanded(value => !value)}><DisclosureChevron expanded={expanded} /></button>
      <strong>{zh ? '交付与验收要求' : 'Delivery requirements'}</strong>
      <span>{[summary.goalRevision !== undefined ? `${zh ? '目标' : 'Goal'} v${summary.goalRevision}` : '', summary.planVersion !== undefined ? `${zh ? '计划' : 'Plan'} v${summary.planVersion}` : ''].filter(Boolean).join(' · ')}</span>
      {binding.goalId && <button type="button" className="task-plan-toggle" aria-label={zh ? '刷新交付要求' : 'Refresh requirements'} title={zh ? '刷新交付要求' : 'Refresh requirements'} disabled={loading} onClick={() => void refresh()}><RefreshCw size={13} aria-hidden="true" /></button>}
    </header>
    {!expanded && summary.preview.length > 0 && <p className="task-requirement-preview">{summary.preview.join(zh ? '；' : '; ')}</p>}
    {error && <p role="alert">{goal ? (zh ? '刷新失败，当前显示上次读取的要求：' : 'Refresh failed; showing previously loaded requirements: ') : ''}{error}</p>}
    {summary.outdatedPlan && <p role="status" data-task-requirement-plan-outdated>{zh ? `目标版本已更新；当前计划依据目标 v${summary.planGoalRevision}。` : `The goal version changed; the current plan was based on goal v${summary.planGoalRevision}.`}</p>}
    {summary.groups.length === 0 && <p role="status">{loading ? (zh ? '正在读取要求…' : 'Loading requirements…') : (zh ? '尚未记录具体交付或验收要求。' : 'No delivery or acceptance requirements have been recorded.')}</p>}
    {expanded && summary.groups.map((group, index) => <div key={`${group.kind}:${index}`} className="task-requirement-group" data-task-requirement-group={group.kind}>
      <strong>{group.title ?? requirementLabel(group.kind, zh)}</strong><ul>{group.values.map(value => <li key={value}>{value}</li>)}</ul>
    </div>)}
  </section>
}

function requirementLabel(kind: TaskRequirementGroup['kind'], zh: boolean): string {
  return ({ success: ['成功标准', 'Success criteria'], constraints: ['约束', 'Constraints'], goalAcceptance: ['目标验收', 'Goal acceptance'],
    artifacts: ['计划交付物', 'Planned deliverables'], planAcceptance: ['计划验收', 'Plan acceptance'], stepAcceptance: ['步骤验收', 'Step acceptance'] })[kind][zh ? 0 : 1]
}
