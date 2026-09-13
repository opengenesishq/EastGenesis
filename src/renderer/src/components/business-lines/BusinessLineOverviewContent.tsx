import { ArrowRight, CheckCircle2, ListChecks } from 'lucide-react'
import type { HistoryEntry } from '../../../../shared/types'
import type { BusinessLineDefinition } from '../../../../shared/business-line-types'
import type { SessionState } from '../../store'

export function BusinessLinePlan({ line, zh }: { line: BusinessLineDefinition; zh: boolean }): React.JSX.Element {
  return <div className="business-line-plan">
    <section><h2><ListChecks size={16} />{zh ? '流程' : 'Workflow'}</h2>{line.workflow.length ? <ol>{line.workflow.map((step, index) => <li key={index}>{step}</li>)}</ol> : <p>{zh ? '由任务需求决定执行步骤。' : 'Steps follow the task requirements.'}</p>}</section>
    <section><h2><CheckCircle2 size={16} />{zh ? '成果' : 'Deliverables'}</h2>{line.deliverables.length ? <ul>{line.deliverables.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>{zh ? '在任务中说明预期成果。' : 'Specify deliverables in the task.'}</p>}</section>
    <BusinessLineAcceptance line={line} zh={zh} />
  </div>
}

function BusinessLineAcceptance({ line, zh }: { line: BusinessLineDefinition; zh: boolean }): React.JSX.Element | null {
  if (!line.acceptanceCriteria?.length) return null
  return <section><h2>{zh ? '待核验的验收标准' : 'Acceptance criteria to verify'}</h2>
    <ul>{line.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
    <p>{zh ? '只读任务会随任务要求保存标准，并要求用成果证据核对；规划与执行任务会先保存验收计划，审查通过后才执行。' : 'Read-only tasks retain these criteria in their task request for evidence-based review. Planning and execution tasks first save an acceptance plan for review.'}</p>
  </section>
}

interface HistoryProps {
  zh: boolean
  active: SessionState[]
  past: HistoryEntry[]
  busy: boolean
  onSelect: (id: string) => void
  onResume: (entry: HistoryEntry) => void
}

export function BusinessLineTaskHistory({ zh, active, past, busy, onSelect, onResume }: HistoryProps): React.JSX.Element {
  return <section className="business-line-task-history"><h2>{zh ? '任务与历史' : 'Tasks and history'} <small>{active.length + past.length}</small></h2>
    {active.map((session) => <button key={session.meta.id} className="business-line-task-row" onClick={() => onSelect(session.meta.id)}><span><strong>{session.meta.title}</strong><small>{session.meta.modelRoutingDecision?.model || session.meta.model} · {session.meta.status}</small></span><ArrowRight size={15} /></button>)}
    {past.map((entry) => <button key={entry.id} disabled={busy} className="business-line-task-row" onClick={() => onResume(entry)}><span><strong>{entry.title}</strong><small>{zh ? '继续历史任务' : 'Resume task'} · {new Date(entry.updatedAt).toLocaleDateString()}</small></span><ArrowRight size={15} /></button>)}
    {!active.length && !past.length && <p>{zh ? '这条业务线还没有任务。' : 'No tasks in this business line yet.'}</p>}
  </section>
}
