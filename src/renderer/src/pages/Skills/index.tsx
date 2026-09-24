import { useMemo, useState } from 'react'
import SkillRecordingWizard from './SkillRecordingWizard'

export interface SkillPageItem {
  id: string
  name: string
  description: string
  trigger?: string
  tags: string[]
  scope: 'builtin' | 'global' | 'project'
}

export interface SkillsPageProps {
  skills: SkillPageItem[]
  onRunSkill?: (skillId: string) => void
  onImportSkill?: () => void
  onExportSkill?: (skillId: string) => void
}

export default function SkillsPage({ skills, onExportSkill, onImportSkill, onRunSkill }: SkillsPageProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [recordingOpen, setRecordingOpen] = useState(false)
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return skills
    return skills.filter((skill) =>
      [skill.name, skill.description, skill.trigger, skill.tags.join(' ')].filter(Boolean).join('\n').toLowerCase().includes(needle)
    )
  }, [query, skills])

  return (
    <section className="skills-page">
      {recordingOpen && <SkillRecordingWizard onClose={() => setRecordingOpen(false)} />}
      <header className="skills-page-header">
        <div>
          <h2>Skills</h2>
          <p>项目与全局自动化工作流</p>
        </div>
        <div className="skills-page-actions"><button className="btn btn-ghost btn-sm" onClick={() => setRecordingOpen(true)}>+ 录制技能</button><button className="btn btn-ghost btn-sm" onClick={onImportSkill}>导入</button></div>
      </header>
      <input className="input" value={query} placeholder="搜索 Skill" onChange={(event) => setQuery(event.target.value)} />
      <div className="skills-page-list">
        {visible.map((skill) => (
          <article key={skill.id} className="skills-page-row">
            <div>
              <strong>{skill.name}</strong>
              <p>{skill.description}</p>
              <span>{skill.scope} / {skill.tags.join(', ') || '无标签'}</span>
            </div>
            <div className="skills-page-actions">
              <button className="btn btn-primary btn-sm" onClick={() => onRunSkill?.(skill.id)}>执行</button>
              <button className="btn btn-ghost btn-sm" onClick={() => onExportSkill?.(skill.id)}>导出</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
