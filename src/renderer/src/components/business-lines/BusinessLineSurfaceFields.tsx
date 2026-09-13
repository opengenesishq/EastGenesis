import { getBusinessLineWorkSurfaces, type BusinessLineDefinition, type BusinessLineWorkSurface } from '../../../../shared/business-line-types'

export default function BusinessLineSurfaceFields({ draft, onChange, zh }: { draft: BusinessLineDefinition; onChange: (draft: BusinessLineDefinition) => void; zh: boolean }): React.JSX.Element {
  if (draft.builtinMode) return <BuiltinWorkSurface mode={draft.builtinMode} zh={zh} />
  const surfaces = getBusinessLineWorkSurfaces(draft)
  const labels = zh ? { tasks: '任务', results: '成果', video: '视频制作' } : { tasks: 'Tasks', results: 'Results', video: 'Video production' }
  const update = (surface: BusinessLineWorkSurface, checked: boolean): void => onChange({ ...draft, workSurfaces: checked ? [...surfaces, surface] : surfaces.filter((item) => item !== surface) })
  return <fieldset className="business-line-capabilities"><legend>{zh ? '工作面' : 'Work surfaces'}</legend>
    {(['tasks', 'results', 'video'] as const).map((surface) => <label key={surface}><input type="checkbox" data-business-work-surface={surface} checked={surfaces.includes(surface)} disabled={surfaces.length === 1 && surfaces.includes(surface)} onChange={(event) => update(surface, event.target.checked)} />{labels[surface]}</label>)}
  </fieldset>
}

function BuiltinWorkSurface({ mode, zh }: { mode: 'assistant' | 'studio' | 'video'; zh: boolean }): React.JSX.Element {
  const labels = zh ? { assistant: '助手工作台', studio: '项目工作台', video: '视频工作台' } : { assistant: 'Assistant workspace', studio: 'Project workspace', video: 'Video workspace' }
  return <fieldset className="business-line-capabilities" data-business-builtin-surface={mode}><legend>{zh ? '内置工作面' : 'Built-in workspace'}</legend><p>{labels[mode]}<br />{zh ? '内置入口使用专用工作面。复制为自定义业务线后，可以组合任务、成果与视频。' : 'This built-in entry uses its dedicated workspace. Duplicate it as a custom business line to combine tasks, results and video.'}</p></fieldset>
}
