import { forwardRef, type KeyboardEvent } from 'react'
import { shortTaskTitle, taskLabelStatus, type OfficeTaskLabel } from './task-label-model'
import './task-labels.css'

export const OfficeTaskLabelLayer = forwardRef<HTMLDivElement, { labels: OfficeTaskLabel[]; zh: boolean; onSelect: (label: OfficeTaskLabel) => void }>(function OfficeTaskLabelLayer({ labels, zh, onSelect }, ref) {
  return <div ref={ref} className="office-task-label-layer" data-office-task-label-layer onKeyDown={moveLabelFocus}>
    {labels.filter((label) => label.position).map((label) => <button key={label.id} type="button"
      className={`office-task-label${label.selected ? ' is-selected' : ''}`} data-office-task-label={label.id}
      data-ming-worker={label.id} data-ming-status={label.activity} data-task-status={label.status}
      data-task-selected={label.selected ? 'true' : 'false'} aria-pressed={label.selected}
      aria-label={`${label.title} · ${taskLabelStatus(label, zh)}`} onClick={() => onSelect(label)}
      style={{ visibility: 'hidden' }} tabIndex={-1} aria-hidden="true">
      <strong>{shortTaskTitle(label.title)}</strong><span>{taskLabelStatus(label, zh)}</span>
    </button>)}
  </div>
})

function moveLabelFocus(event: KeyboardEvent<HTMLDivElement>): void {
  const directions: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
  const direction = directions[event.key]
  if (!direction) return
  const labels = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-office-task-label][aria-hidden="false"]')]
  const index = labels.indexOf(document.activeElement as HTMLButtonElement)
  if (index < 0 || !labels.length) return
  event.preventDefault()
  labels[(index + direction + labels.length) % labels.length].focus()
}

export function OfficeTaskPicker({ labels, zh, onSelect }: { labels: OfficeTaskLabel[]; zh: boolean; onSelect: (label: OfficeTaskLabel) => void }): React.JSX.Element | null {
  if (!labels.length) return null
  return <select className="input office-actor-picker" data-office-task-picker
    aria-label={zh ? '选择执行任务' : 'Select execution task'} value={labels.find((label) => label.selected)?.id ?? ''}
    onChange={(event) => { const label = labels.find((item) => item.id === event.target.value); if (label) onSelect(label) }}>
    <option value="">{zh ? '执行任务' : 'Execution tasks'}</option>
    {labels.map((label) => <option key={label.id} value={label.id}>{label.title} · {taskLabelStatus(label, zh)}{label.detailsOnly ? (zh ? ' · 详情' : ' · Details') : ''}</option>)}
  </select>
}
