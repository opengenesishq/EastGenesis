import { useEffect, useId, useRef, useState } from 'react'
import type { ProjectWorkspace } from '../../../../shared/project-workspace-types'
import {
  DEFAULT_PROJECT_INSTITUTION_TEMPLATE,
  LEGACY_PROJECT_INSTITUTION_TEMPLATE,
  PROJECT_INSTITUTION_MIGRATION_EVENT,
  isProjectInstitutionMigrationEventPayload,
  projectInstitutionTemplate,
  type ProjectInstitutionMigrationView,
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
  const [preview, setPreview] = useState<ProjectInstitutionMigrationView | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const sequence = useRef(0)
  const mounted = useRef(true)
  const pending = useRef(false)
  const contextKey = JSON.stringify([project.id, project.revision, project.status, current.ref, target])
  const liveContext = useRef(contextKey)
  liveContext.current = contextKey

  // A readback or selection change invalidates both the displayed proposal and any late response.
  useEffect(() => {
    sequence.current += 1
    pending.current = false
    setPreview(null); setError(''); setLoading(false); setSaving(false)
  }, [contextKey])
  useEffect(() => {
    setTarget(DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
    setPreviewOpen(false); setMessage('')
  }, [project.id])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; sequence.current += 1 }
  }, [])

  const different = !sameTemplate(current.ref, target)
  const visiblePreview = preview && preview.projectId === project.id && preview.expectedWorkspaceRevision === project.revision &&
    preview.scope === 'future_goals' && sameTemplate(preview.current.ref, current.ref) && sameTemplate(preview.target.ref, target)
    ? preview : null
  const responseCurrent = (request: number, key: string) => mounted.current && sequence.current === request && liveContext.current === key
  const clearPreview = (): void => {
    sequence.current += 1
    pending.current = false
    setPreview(null); setLoading(false); setSaving(false); setError(''); setMessage('')
  }
  const requestPreview = async (): Promise<void> => {
    if (pending.current || !different || project.status !== 'active') return
    const request = ++sequence.current, key = contextKey
    pending.current = true
    setLoading(true); setPreview(null); setError(''); setMessage('')
    try {
      const next = await window.agentDesk.previewProjectInstitutionMigration(project.id, { scope: 'future_goals', target })
      if (!responseCurrent(request, key)) return
      if (next.schemaVersion !== 1 || next.projectId !== project.id || next.scope !== 'future_goals' ||
          next.expectedWorkspaceRevision !== project.revision || !sameTemplate(next.current.ref, current.ref) ||
          !sameTemplate(next.target.ref, target) || !next.previewDigest) {
        setError(english ? 'Project records changed. Refresh the project and generate a new preview.' : '项目记录已变化，请刷新项目后重新生成预览。')
        await refreshProjects()
        return
      }
      setPreview(next)
    } catch (failure) {
      if (responseCurrent(request, key)) setError(errorText(failure))
    } finally {
      if (responseCurrent(request, key)) { pending.current = false; setLoading(false) }
    }
  }
  const save = async (): Promise<void> => {
    if (pending.current || !visiblePreview?.canApply || project.status !== 'active') return
    const proposal = visiblePreview, request = ++sequence.current, key = contextKey
    pending.current = true
    setSaving(true); setError(''); setMessage('')
    try {
      const result = await window.agentDesk.applyProjectInstitutionMigration(project.id, {
        scope: 'future_goals', target: proposal.target.ref,
        expectedWorkspaceRevision: proposal.expectedWorkspaceRevision, previewDigest: proposal.previewDigest
      })
      if (!responseCurrent(request, key)) return
      setPreview(null)
      const event = result.event
      const payload = event?.payload
      if (event?.projectId !== project.id || event.entityType !== 'workspace' || event.entityId !== project.id ||
          event.kind !== PROJECT_INSTITUTION_MIGRATION_EVENT || event.revision !== proposal.expectedWorkspaceRevision + 1 ||
          !isProjectInstitutionMigrationEventPayload(payload) || payload.previewDigest !== proposal.previewDigest ||
          payload.expectedWorkspaceRevision !== proposal.expectedWorkspaceRevision ||
          !sameTemplate(payload.fromTemplate, proposal.current.ref) || !sameTemplate(payload.toTemplate, proposal.target.ref) ||
          !sameIds(payload.preservedGoalIds, proposal.preservedGoalIds) || !sameIds(payload.preservedWorkItemIds, proposal.preservedWorkItemIds) ||
          result.workspace.id !== project.id || result.workspace.revision < event.revision || typeof result.replayed !== 'boolean') {
        throw new Error(english ? 'The saved result could not be matched to this preview. Refresh the project to check its current default.'
          : '保存结果与本次预览不一致，请刷新项目核对当前默认模板。')
      }
      const savedTemplate = projectInstitutionTemplate(result.workspace.institutionTemplate)
      const currentDefaultDiffers = !sameTemplate(savedTemplate.ref, proposal.target.ref)
      if (currentDefaultDiffers && !result.replayed) {
        throw new Error(english ? 'The saved default differs from this confirmed change. Refresh the project to check its current default.'
          : '保存后的默认模板与已确认变更不一致，请刷新项目核对当前默认模板。')
      }
      setMessage(result.replayed && currentDefaultDiffers
        ? (english ? `This change was already saved. A later change set the current default to ${savedTemplate.nameEn}; the refreshed project shows that current default.`
          : `本次变更此前已保存，之后又发生了模板变更。当前默认是“${savedTemplate.name}”，以项目读回结果为准。`)
        : (english ? 'Default saved for future goals. Existing work keeps its recorded institutions.'
          : '已更新后续新目标的默认机构，已有工作继续使用原机构记录。'))
      // Refresh the current selection; a response must never navigate back to a previously selected project.
      await refreshProjects()
    } catch (failure) {
      if (responseCurrent(request, key)) {
        setPreview(null)
        setError(`${errorText(failure)}${english ? ' Generate a fresh preview before confirming again.' : ' 请重新生成预览后再确认。'}`)
      }
    } finally {
      if (responseCurrent(request, key)) { pending.current = false; setSaving(false) }
    }
  }

  return <section className="pws-institutions" aria-labelledby={titleId} data-project-institutions={current.ref.templateId}>
    <header><h3 id={titleId}>{english ? 'Project institutions' : '项目机构配置'}</h3>
      <span>{english ? current.nameEn : current.name} · v{current.ref.templateVersion}</span>
    </header>
    <p>{english
      ? 'Institutions describe responsibilities. Agents join when needed; the existing execution and permission settings still apply.'
      : '机构定义职责，Agent 按需参与；任务仍通过已有执行与权限配置运行。'}</p>
    {current.ref.templateId === 'legacy-compatible' && <p>{english
      ? 'Existing Crown Prince, Three Departments and custom roles keep their identities and records. The list explains known compatibility IDs; existing configuration remains authoritative.'
      : '旧太子、三省及自定义角色保留原身份和记录。下表说明已知兼容标识，实际机构以已有配置为准。'}</p>}
    <details><summary>{english ? 'View responsibilities' : '查看机构与职责'}</summary><RoleTable roles={current.roles} english={english} /></details>
    <button type="button" className="btn btn-secondary" aria-expanded={previewOpen} disabled={saving} onClick={() => {
      clearPreview(); setPreviewOpen(!previewOpen)
    }}>{previewOpen ? (english ? 'Close template change' : '收起模板变更') : (english ? 'Change the default for future goals' : '更改后续新目标的默认机构')}</button>
    {previewOpen && <div className="pws-institution-preview" data-institution-migration-preview aria-busy={loading || saving}>
      <label>{english ? 'Target template' : '目标模板'}
        <select value={target.templateId} onChange={(event) => {
          clearPreview()
          setTarget(event.target.value === 'legacy-compatible' ? LEGACY_PROJECT_INSTITUTION_TEMPLATE : DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
        }} disabled={saving}>
          <option value="cabinet-six-ministries">{english ? 'Emperor, Cabinet and Six Ministries · v1' : '皇帝、内阁、六部及相关机构 · v1'}</option>
          <option value="legacy-compatible">{english ? 'Legacy compatibility · v1' : '旧机构兼容 · v1'}</option>
        </select>
      </label>
      <p>{english ? 'After confirmation, newly created goals use this template. Existing goals, work items, runs and plan responsibilities keep their recorded configuration.'
        : '确认后，新建目标使用此模板。已有目标、工作项、运行及计划职责继续保留原配置。'}</p>
      <div className="pws-institution-actions">
        <button type="button" className="btn btn-secondary" disabled={loading || saving || !different || project.status !== 'active'} onClick={() => void requestPreview()}>
          {loading ? (english ? 'Reading project…' : '读取项目记录…') : visiblePreview ? (english ? 'Refresh preview' : '刷新预览') : (english ? 'Generate migration preview' : '生成迁移预览')}
        </button>
        {!different && <span>{english ? 'This is already the current default.' : '此模板已是当前默认。'}</span>}
      </div>
      {project.status !== 'active' && <p>{english ? 'Restore this project before changing its default.' : '请先恢复此项目，再更改默认机构。'}</p>}
      {visiblePreview && <>
        <dl>
          <dt>{english ? 'Applies to' : '生效范围'}</dt><dd>{english ? 'Future goals created in this project' : '此项目后续新建的目标'}</dd>
          <dt>{english ? 'Preserved goals / work items' : '保留目标 / 工作项'}</dt><dd>{visiblePreview.recordedGoalCount} / {visiblePreview.recordedWorkCount}</dd>
          <dt>{english ? 'Pending work preserved' : '保留待处理工作'}</dt><dd>{visiblePreview.pendingWorkCount}</dd>
          <dt>{english ? 'New responsibilities' : '新增职责'}</dt><dd>{roleNames(visiblePreview.added, english)}</dd>
          <dt>{english ? 'Preserved IDs' : '保留标识'}</dt><dd>{roleNames(visiblePreview.retained, english)}</dd>
          <dt>{english ? 'Legacy identities in existing records' : '原记录中的旧身份'}</dt><dd>{roleNames(visiblePreview.legacyOnly, english)}</dd>
          <dt>{english ? 'Runs and permissions' : '运行与权限'}</dt><dd>{english ? 'Runs, confirmed plans, model and executor bindings, and personnel permissions keep their existing records.' : '运行、已确认方案、模型与执行器绑定、人员权限继续保留原记录。'}</dd>
        </dl>
        <details className="pws-institution-basis"><summary>{english ? 'Preview version and record' : '预览版本与记录'}</summary>
          <dl>
            <dt>{english ? 'Project version' : '项目版本'}</dt><dd>{visiblePreview.expectedWorkspaceRevision}</dd>
            <dt>{english ? 'Template version' : '模板版本'}</dt><dd>v{visiblePreview.current.ref.templateVersion} → v{visiblePreview.target.ref.templateVersion}</dd>
            <dt>{english ? 'Preview digest' : '预览摘要'}</dt><dd><code>{visiblePreview.previewDigest}</code></dd>
          </dl>
        </details>
        <button type="button" className="btn btn-primary" disabled={saving || loading || !visiblePreview.canApply || !different || project.status !== 'active'} onClick={() => void save()}>
          {saving ? (english ? 'Applying…' : '应用中…') : (english ? 'Confirm for future goals' : '确认用于后续新目标')}
        </button>
        {!visiblePreview.canApply && <p>{english ? 'This preview cannot be applied. Refresh the project and generate a new preview.' : '当前预览不可应用，请刷新项目并重新生成预览。'}</p>}
      </>}
    </div>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>
}

function sameTemplate(left: ProjectInstitutionTemplateRef, right: ProjectInstitutionTemplateRef): boolean {
  return left.schemaVersion === right.schemaVersion && left.templateId === right.templateId && left.templateVersion === right.templateVersion
}
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
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
