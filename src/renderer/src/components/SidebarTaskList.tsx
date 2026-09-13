import './task-entry-groups.css'
import type { ReactNode } from 'react'
import type { SidebarEntry } from './sidebar-project-groups'
import { groupTaskEntries } from './task-entry-groups'

export default function SidebarTaskList({ entries, activeId, renderEntry }: {
  entries: SidebarEntry[]; activeId?: string | null; renderEntry(entry: SidebarEntry): ReactNode
}): React.JSX.Element {
  return <>{groupTaskEntries(entries, activeId).map((group) => <div key={group.key} className="sidebar-task-group" data-sidebar-task={group.key}>
    {renderEntry(group.representative)}
    {group.attention.length > 0 && <div className="sidebar-task-attention" aria-label="同一任务的其它待审批执行">{group.attention.map(renderEntry)}</div>}
    {group.related.length > 0 && <details className="sidebar-task-executions" data-task-executions={group.key}>
      <summary>执行与历史（{group.related.length}）</summary>
      {group.related.map(renderEntry)}
    </details>}
  </div>)}</>
}
