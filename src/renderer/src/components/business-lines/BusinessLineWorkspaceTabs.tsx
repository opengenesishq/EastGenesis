import { ArrowLeft } from 'lucide-react'
import { getBusinessLineWorkSurfaces, type BusinessLineDefinition, type BusinessLineWorkSurface } from '../../../../shared/business-line-types'

export default function BusinessLineWorkspaceTabs({ line, surface, hasTask, zh, onChange, onOverview }: {
  line: BusinessLineDefinition; surface: BusinessLineWorkSurface; hasTask: boolean; zh: boolean
  onChange: (surface: BusinessLineWorkSurface) => void; onOverview: () => void
}): React.JSX.Element {
  const labels = zh ? { tasks: '任务', results: '成果', video: '视频' } : { tasks: 'Tasks', results: 'Results', video: 'Video' }
  const declared = getBusinessLineWorkSurfaces(line)
  const surfaces = declared.includes(surface) ? declared : [...declared, surface]
  return <nav aria-label={zh ? '业务工作面' : 'Business work surfaces'}>
    {hasTask && <button className="btn btn-ghost btn-sm" onClick={onOverview}><ArrowLeft size={14} />{zh ? '业务概览' : 'Overview'}</button>}
    {surfaces.map((value) => <button key={value} data-business-line-surface-option={value} aria-pressed={surface === value} className={`btn btn-sm ${surface === value ? 'btn-secondary' : 'btn-ghost'}`} onClick={() => onChange(value)}>{labels[value]}</button>)}
  </nav>
}
