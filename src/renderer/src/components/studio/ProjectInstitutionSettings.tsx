import { useEffect, useId, useState } from 'react'
import type { ProjectWorkspace, WorkItem } from '../../../../shared/project-workspace-types'
import {
  DEFAULT_PROJECT_INSTITUTION_TEMPLATE,
  LEGACY_PROJECT_INSTITUTION_TEMPLATE,
  previewProjectInstitutionMigration,
  projectInstitutionTemplate,
  type ProjectInstitutionRole,
  type ProjectInstitutionTemplateRef
} from '../../../../shared/project-institution-template'
import { useStore } from '../../store'
import './project-institution-settings.css'

export default function ProjectInstitutionSettings({ project, refreshProjects }: {
  project: ProjectWorkspace
  refreshProjects: (preferredId?: string) => Promise<void>
}): React.JSX.Element {
  const english = useStore((state) => state.settings.language) === 'en'
  const titleId = useId()
  const current = projectInstitutionTemplate(project.institutionTemplate)
  const [target, setTarget] = useState<ProjectInstitutionTemplateRef>(DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
  const [records, setRecords] = useState<{ goals: number; workItems: WorkItem[] } | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  useEffect(() => {
    let active = true
    setRecords(null)
    setError('')
    setMessage('')
    Promise.all([
      window.agentDesk.listProjectGoals(project.id, { includeArchived: true, includeDeleted: true }),
      window.agentDesk.listProjectWorkItems(project.id, { includeArchived: true, includeDeleted: true })
    ]).then(([goals, workItems]) => {
      if (active) setRecords({ goals: goals.length, workItems })
    }).catch((failure: unknown) => { if (active) setError(String(failure)) })
    return () => { active = false }
  }, [project.id, project.revision])

  const preview = previewProjectInstitutionMigration({ institutionTemplate: project.institutionTemplate, target, workItems: records?.workItems ?? [] })
  const hasHistory = records !== null && (records.goals > 0 || records.workItems.length > 0)
  const different = current.ref.templateId !== target.templateId
  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      await window.agentDesk.updateProjectWorkspace(project.id, { institutionTemplate: target }, { expectedRevision: project.revision })
      await refreshProjects(project.id)
      setMessage(english ? 'Institution template saved.' : '机构模板已保存。')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally { setSaving(false) }
  }

  return <section className="pws-institutions" aria-labelledby={titleId} data-project-institutions={current.ref.templateId}>
    <header><h3 id={titleId}>{english ? 'Project institutions' : '项目机构配置'}</h3>
      <span>{english ? current.nameEn : current.name} · v{current.ref.templateVersion}</span>
    </header>
    <p>{english
      ? 'Institutions describe responsibilities. Agents join when needed; the existing execution and permission settings still apply.'
      : '机构定义职责，Agent 按需参与；任务仍通过已有执行与权限配置运行。'}</p>
    {current.ref.templateId === 'legacy-compatible' && <p>{english
      ? 'Existing Crown Prince, Three Departments and custom roles keep their identities and records. The list below explains known compatibility IDs; your existing configuration remains authoritative.'
      : '旧太子、三省及自定义角色保留原身份和记录。下表说明已知兼容标识，实际机构以已有配置为准。'}</p>}
    <details><summary>{english ? 'View responsibilities' : '查看机构与职责'}</summary><RoleTable roles={current.roles} english={english} /></details>
    <button type="button" className="btn btn-secondary" onClick={() => setPreviewOpen(!previewOpen)}>{english ? 'Preview template change' : '预览机构模板变更'}</button>
    {previewOpen && <div className="pws-institution-preview" data-institution-migration-preview>
      <label>{english ? 'Target template' : '目标模板'}
        <select value={target.templateId} onChange={(event) => setTarget(event.target.value === 'legacy-compatible' ? LEGACY_PROJECT_INSTITUTION_TEMPLATE : DEFAULT_PROJECT_INSTITUTION_TEMPLATE)} disabled={saving}>
          <option value="cabinet-six-ministries">{english ? 'Emperor, Cabinet and Six Ministries · v1' : '皇帝、内阁、六部及相关机构 · v1'}</option>
          <option value="legacy-compatible">{english ? 'Legacy compatibility · v1' : '旧机构兼容 · v1'}</option>
        </select>
      </label>
      <dl>
        <dt>{english ? 'New responsibilities' : '新增职责'}</dt><dd>{roleNames(preview.added, english)}</dd>
        <dt>{english ? 'Preserved IDs' : '保留标识'}</dt><dd>{roleNames(preview.retained, english)}</dd>
        <dt>{english ? 'Legacy identities retained in records' : '留在原记录中的旧身份'}</dt><dd>{roleNames(preview.legacyOnly, english)}</dd>
        <dt>{english ? 'Permissions' : '权限'}</dt><dd>{english ? 'No grants are added, replaced or elevated.' : '现有授权保留，不新增、不替换、不扩权。'}</dd>
        <dt>{english ? 'Routing' : '路由'}</dt><dd>{english ? 'Existing model, executor and worker bindings are preserved.' : '现有模型、执行器和 Worker 绑定保留。'}</dd>
        <dt>{english ? 'Recorded / pending work' : '已有工作 / 待处理工作'}</dt><dd>{records ? `${preview.recordedWorkCount} / ${preview.pendingWorkCount}` : english ? 'Loading…' : '读取中…'}</dd>
      </dl>
      {hasHistory && <p>{english
        ? 'Projects with recorded work currently support preview only. Continue using their existing template, or create a new project with the Cabinet default.'
        : '已有工作记录的项目当前只支持迁移预览。继续使用原模板，或新建采用内阁默认的项目。'}</p>}
      <button type="button" className="btn btn-primary" disabled={saving || !records || hasHistory || !different || project.status !== 'active'} onClick={() => void save()}>
        {saving ? (english ? 'Saving…' : '保存中…') : (english ? 'Apply to this empty project' : '应用到此空项目')}
      </button>
    </div>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>
}

function roleNames(roles: readonly ProjectInstitutionRole[], english: boolean): string {
  return roles.map((role) => `${english ? role.nameEn : role.name} (${role.id})`).join(english ? ', ' : '、') || (english ? 'None' : '无')
}

function RoleTable({ roles, english }: { roles: readonly ProjectInstitutionRole[]; english: boolean }): React.JSX.Element {
  const participation = english
    ? { user: 'User', on_demand: 'Agent when needed', program: 'Program / management view', legacy: 'Existing configuration' }
    : { user: '用户', on_demand: '按需 Agent', program: '程序 / 管理视图', legacy: '沿用原配置' }
  return <div className="pws-institution-table"><table>
    <thead><tr><th>{english ? 'Institution' : '机构'}</th><th>{english ? 'Responsibility' : '职责'}</th><th>{english ? 'Participation' : '参与方式'}</th></tr></thead>
    <tbody>{roles.map((role) => <tr key={role.id}><th scope="row">{english ? role.nameEn : role.name}<small>{role.id}</small></th><td>{english ? role.dutyEn : role.duty}</td><td>{participation[role.participation]}</td></tr>)}</tbody>
  </table></div>
}
