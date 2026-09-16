import { useEffect, useId, useRef, useState } from 'react'
import type { ProjectWorkspace } from '../../../../shared/project-workspace-types'
import {
  DEFAULT_PROJECT_INSTITUTION_TEMPLATE,
  LEGACY_PROJECT_INSTITUTION_TEMPLATE,
  PROJECT_INSTITUTION_MIGRATION_EVENT,
  isProjectInstitutionMigrationEventPayload,
  normalizeProjectInstitutionRoleMappings,
  projectInstitutionTemplate,
  type ProjectInstitutionMigrationView,
  type ProjectInstitutionRole,
  type ProjectInstitutionRoleCandidate,
  type ProjectInstitutionRoleMapping,
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
  const roleListId = useId()
  const current = projectInstitutionTemplate(project.institutionTemplate)
  const [target, setTarget] = useState<ProjectInstitutionTemplateRef>(DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
  const [preview, setPreview] = useState<ProjectInstitutionMigrationView | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [draftMappings, setDraftMappings] = useState<ProjectInstitutionRoleMapping[] | undefined>()
  const [mappingBasis, setMappingBasis] = useState<{
    key: string; mappings: ProjectInstitutionRoleMapping[]; candidates: ProjectInstitutionRoleCandidate[]
  } | null>(null)
  const [sourceRoleId, setSourceRoleId] = useState('')
  const [institutionId, setInstitutionId] = useState('')
  const sequence = useRef(0)
  const mounted = useRef(true)
  const pending = useRef(false)
  const recordKey = JSON.stringify([project.id, project.revision, project.status, current.ref, target])
  const contextKey = JSON.stringify([recordKey, draftMappings])
  const liveContext = useRef(contextKey)
  liveContext.current = contextKey

  // A readback or selection change invalidates both the displayed proposal and any late response.
  useEffect(() => {
    sequence.current += 1
    pending.current = false
    setPreview(null); setError(''); setLoading(false); setSaving(false)
  }, [contextKey])
  useEffect(() => {
    setDraftMappings(undefined); setMappingBasis(null); setSourceRoleId(''); setInstitutionId('')
  }, [recordKey])
  useEffect(() => {
    setTarget(DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
    setPreviewOpen(false); setMessage('')
  }, [project.id])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; sequence.current += 1 }
  }, [])

  const targetTemplate = projectInstitutionTemplate(target)
  const editableBasis = mappingBasis?.key === recordKey ? mappingBasis : null
  const editableMappings = draftMappings ?? editableBasis?.mappings ?? []
  const targetRoles = targetTemplate.roles.filter(role => role.participation !== 'user')
  const visiblePreview = preview && preview.projectId === project.id && preview.expectedWorkspaceRevision === project.revision &&
    preview.scope === 'future_goals' && sameTemplate(preview.current.ref, current.ref) && sameTemplate(preview.target.ref, target) &&
    (draftMappings === undefined || sameMappings(preview.roleMappings, draftMappings))
    ? preview : null
  const responseCurrent = (request: number, key: string) => mounted.current && sequence.current === request && liveContext.current === key
  const clearPreview = (): void => {
    sequence.current += 1
    pending.current = false
    setPreview(null); setLoading(false); setSaving(false); setError(''); setMessage('')
  }
  const requestPreview = async (): Promise<void> => {
    if (pending.current || project.status !== 'active') return
    const request = ++sequence.current, key = contextKey
    pending.current = true
    setLoading(true); setPreview(null); setError(''); setMessage('')
    try {
      const next = await window.agentDesk.previewProjectInstitutionMigration(project.id, {
        scope: 'future_goals', target, ...(draftMappings === undefined ? {} : { roleMappings: draftMappings })
      })
      if (!responseCurrent(request, key)) return
      if (next.schemaVersion !== 1 || next.projectId !== project.id || next.scope !== 'future_goals' ||
          next.expectedWorkspaceRevision !== project.revision || !sameTemplate(next.current.ref, current.ref) ||
          !sameTemplate(next.target.ref, target) || !next.previewDigest ||
          !validMappings(next.currentRoleMappings, current.ref) || !validMappings(next.roleMappings, target) ||
          !validCandidates(next.roleCandidates) || (draftMappings !== undefined && !sameMappings(next.roleMappings, draftMappings))) {
        setError(english ? 'Project records changed. Refresh the project and generate a new preview.' : '项目记录已变化，请刷新项目后重新生成预览。')
        await refreshProjects()
        return
      }
      setMappingBasis({ key: recordKey, mappings: next.roleMappings, candidates: next.roleCandidates })
      setPreview(next)
    } catch (failure) {
      if (responseCurrent(request, key)) setError(errorText(failure))
    } finally {
      if (responseCurrent(request, key)) { pending.current = false; setLoading(false) }
    }
  }
  const changeMappings = (next: ProjectInstitutionRoleMapping[]): boolean => {
    try {
      const normalized = normalizeProjectInstitutionRoleMappings(next, target)
      clearPreview()
      setDraftMappings(normalized)
      return true
    } catch (failure) { setError(errorText(failure)); return false }
  }
  const addMapping = (): void => {
    const source = sourceRoleId.trim()
    if (!source || !institutionId) return
    if (editableMappings.some(mapping => mapping.sourceRoleId === source)) {
      setError(english ? 'This role already has a mapping. Edit its institution below.' : '此角色已有映射，请在下方修改目标机构。')
      return
    }
    if (changeMappings([...editableMappings, { sourceRoleId: source, institutionId }])) setSourceRoleId('')
  }
  const save = async (): Promise<void> => {
    if (pending.current || !visiblePreview?.canApply || project.status !== 'active') return
    const proposal = visiblePreview, request = ++sequence.current, key = contextKey
    pending.current = true
    setSaving(true); setError(''); setMessage('')
    try {
      const result = await window.agentDesk.applyProjectInstitutionMigration(project.id, {
        scope: 'future_goals', target: proposal.target.ref, roleMappings: proposal.roleMappings,
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
          !sameMappings(payload.fromRoleMappings ?? [], proposal.currentRoleMappings) || !sameMappings(payload.toRoleMappings ?? [], proposal.roleMappings) ||
          !sameIds(payload.preservedGoalIds, proposal.preservedGoalIds) || !sameIds(payload.preservedWorkItemIds, proposal.preservedWorkItemIds) ||
          result.workspace.id !== project.id || result.workspace.revision < event.revision || typeof result.replayed !== 'boolean') {
        throw new Error(english ? 'The saved result could not be matched to this preview. Refresh the project to check its current default.'
          : '保存结果与本次预览不一致，请刷新项目核对当前机构配置。')
      }
      const savedTemplate = projectInstitutionTemplate(result.workspace.institutionTemplate)
      const currentDefaultDiffers = !sameTemplate(savedTemplate.ref, proposal.target.ref)
      if (currentDefaultDiffers && !result.replayed) {
        throw new Error(english ? 'The saved default differs from this confirmed change. Refresh the project to check its current default.'
          : '保存后的默认模板与已确认变更不一致，请刷新项目核对当前默认模板。')
      }
      setMessage(result.replayed && result.workspace.revision > event.revision
        ? (english ? `This change was already saved. Later project changes exist; refresh the preview to read the current mappings under ${savedTemplate.nameEn}.`
          : `本次变更此前已保存，项目之后又发生了变更。当前模板是“${savedTemplate.name}”，请重新预览读回当前映射。`)
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
    }}>{previewOpen ? (english ? 'Close institution settings' : '收起机构设置') : (english ? 'Change the default for future goals' : '更改后续新目标的默认机构')}</button>
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
        <button type="button" className="btn btn-secondary" disabled={loading || saving || project.status !== 'active'} onClick={() => void requestPreview()}>
          {loading ? (english ? 'Reading project…' : '读取项目记录…') : visiblePreview ? (english ? 'Refresh preview' : '刷新预览') : (english ? 'Generate migration preview' : '生成迁移预览')}
        </button>
        {sameTemplate(current.ref, target) && <span>{english ? 'You can adjust role mappings within the current template.' : '可在当前模板内调整角色映射。'}</span>}
      </div>
      {project.status !== 'active' && <p>{english ? 'Restore this project before changing its default.' : '请先恢复此项目，再更改默认机构。'}</p>}
      {editableBasis && <details className="pws-institution-mappings" data-institution-role-mappings>
        <summary>{english ? 'Role mappings (optional)' : '角色映射（可选）'} · {editableMappings.length}</summary>
        <p>{english
          ? 'Map an existing or custom role ID to a responsibility for future goals. The role ID, execution role and permissions stay unchanged. Unmapped steps use the template defaults.'
          : '将已有或自定义角色 ID 对应到后续新目标的机构职责。原角色 ID、执行角色和权限保持不变；未映射步骤沿用模板默认分工。'}</p>
        <div className="pws-institution-mapping-add">
          <label>{english ? 'Original role ID' : '原角色 ID'}
            <input data-institution-mapping-source list={roleListId} value={sourceRoleId} maxLength={200}
              placeholder={english ? 'Choose or enter a custom ID' : '选择已有或输入自定义 ID'} disabled={saving || project.status !== 'active'}
              onChange={event => setSourceRoleId(event.target.value)} />
            <datalist id={roleListId}>{editableBasis.candidates.map(role => <option key={role.id} value={role.id}>
              {role.label} · {role.recordedWorkCount} {english ? 'recorded work items' : '项已有工作'}
            </option>)}</datalist>
          </label>
          <label>{english ? 'Institution responsibility' : '目标机构职责'}
            <select data-institution-mapping-target value={institutionId} disabled={saving || project.status !== 'active'}
              onChange={event => setInstitutionId(event.target.value)}>
              <option value="">{english ? 'Choose an institution' : '选择机构'}</option>
              {targetRoles.map(role => <option key={role.id} value={role.id}>{english ? role.nameEn : role.name} ({role.id})</option>)}
            </select>
          </label>
          <button type="button" className="btn btn-secondary" data-institution-mapping-add disabled={saving || project.status !== 'active' || !sourceRoleId.trim() || !institutionId}
            onClick={addMapping}>{english ? 'Add mapping' : '添加映射'}</button>
        </div>
        {editableMappings.length > 0 ? <div className="pws-institution-table"><table>
          <thead><tr><th>{english ? 'Original role ID' : '原角色 ID'}</th><th>{english ? 'Institution for future goals' : '后续新目标的机构'}</th><th>{english ? 'Action' : '操作'}</th></tr></thead>
          <tbody>{editableMappings.map(mapping => <tr key={mapping.sourceRoleId}>
            <th scope="row"><code>{mapping.sourceRoleId}</code></th>
            <td><select value={mapping.institutionId} disabled={saving || project.status !== 'active'}
              aria-label={`${english ? 'Institution for' : '目标机构：'} ${mapping.sourceRoleId}`}
              onChange={event => changeMappings(editableMappings.map(item => item.sourceRoleId === mapping.sourceRoleId ? { ...item, institutionId: event.target.value } : item))}>
              {targetRoles.map(role => <option key={role.id} value={role.id}>{english ? role.nameEn : role.name} ({role.id})</option>)}
            </select></td>
            <td><button type="button" className="btn btn-secondary" disabled={saving || project.status !== 'active'}
              aria-label={`${english ? 'Remove mapping for' : '移除映射：'} ${mapping.sourceRoleId}`}
              onClick={() => changeMappings(editableMappings.filter(item => item.sourceRoleId !== mapping.sourceRoleId))}>{english ? 'Remove' : '移除'}</button></td>
          </tr>)}</tbody>
        </table></div> : <p>{english ? 'No explicit role mappings.' : '尚无显式角色映射。'}</p>}
        {!visiblePreview && <p>{english ? 'Mapping edits need a new preview before confirmation.' : '映射已编辑，请重新生成预览后确认。'}</p>}
      </details>}
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
        <MappingComparison preview={visiblePreview} english={english} />
        <details className="pws-institution-basis"><summary>{english ? 'Preview version and record' : '预览版本与记录'}</summary>
          <dl>
            <dt>{english ? 'Project version' : '项目版本'}</dt><dd>{visiblePreview.expectedWorkspaceRevision}</dd>
            <dt>{english ? 'Template version' : '模板版本'}</dt><dd>v{visiblePreview.current.ref.templateVersion} → v{visiblePreview.target.ref.templateVersion}</dd>
            <dt>{english ? 'Preview digest' : '预览摘要'}</dt><dd><code>{visiblePreview.previewDigest}</code></dd>
          </dl>
        </details>
        <button type="button" className="btn btn-primary" disabled={saving || loading || !visiblePreview.canApply || project.status !== 'active'} onClick={() => void save()}>
          {saving ? (english ? 'Applying…' : '应用中…') : (english ? 'Confirm for future goals' : '确认用于后续新目标')}
        </button>
        {!visiblePreview.canApply && <p>{english ? 'The template and mappings are unchanged. Edit a role mapping or choose another template to make a change.' : '模板与映射均未变化。可编辑角色映射或选择其他模板后重新预览。'}</p>}
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
function sameMappings(left: readonly ProjectInstitutionRoleMapping[], right: readonly ProjectInstitutionRoleMapping[]): boolean {
  const ordered = (value: readonly ProjectInstitutionRoleMapping[]) => [...value].sort((a, b) => a.sourceRoleId.localeCompare(b.sourceRoleId))
  const a = ordered(left), b = ordered(right)
  return a.length === b.length && a.every((mapping, index) => mapping.sourceRoleId === b[index].sourceRoleId && mapping.institutionId === b[index].institutionId)
}
function validMappings(value: unknown, template: ProjectInstitutionTemplateRef): value is ProjectInstitutionRoleMapping[] {
  try { normalizeProjectInstitutionRoleMappings(value, template); return true } catch { return false }
}
function validCandidates(value: unknown): value is ProjectInstitutionRoleCandidate[] {
  if (!Array.isArray(value)) return false
  const seen = new Set<string>()
  return value.every(candidate => {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id || seen.has(candidate.id) ||
      typeof candidate.label !== 'string' || !Number.isSafeInteger(candidate.recordedWorkCount) || candidate.recordedWorkCount < 0) return false
    seen.add(candidate.id)
    return true
  })
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function roleNames(roles: readonly ProjectInstitutionRole[], english: boolean): string {
  return roles.map((role) => `${english ? role.nameEn : role.name} (${role.id})`).join(english ? ', ' : '、') || (english ? 'None' : '无')
}

function MappingComparison({ preview, english }: { preview: ProjectInstitutionMigrationView; english: boolean }): React.JSX.Element {
  const ids = [...new Set([...preview.currentRoleMappings, ...preview.roleMappings].map(mapping => mapping.sourceRoleId))].sort()
  const label = (id: string | undefined, roles: readonly ProjectInstitutionRole[]): string => {
    if (!id) return english ? 'Template default' : '模板默认分工'
    const role = roles.find(candidate => candidate.id === id)
    return role ? `${english ? role.nameEn : role.name} (${id})` : id
  }
  return <div className="pws-institution-mapping-comparison" data-institution-mapping-comparison>
    <h4>{english ? 'Role mapping preview' : '角色映射预览'}</h4>
    {ids.length === 0 ? <p>{english ? 'No explicit role mappings before or after this change.' : '变更前后均无显式角色映射。'}</p> : <div className="pws-institution-table"><table>
      <thead><tr><th>{english ? 'Preserved role ID' : '保留的角色 ID'}</th><th>{english ? 'Current responsibility' : '当前职责'}</th><th>{english ? 'Future goal responsibility' : '后续新目标职责'}</th></tr></thead>
      <tbody>{ids.map(id => <tr key={id}><th scope="row"><code>{id}</code></th>
        <td>{label(preview.currentRoleMappings.find(mapping => mapping.sourceRoleId === id)?.institutionId, preview.current.roles)}</td>
        <td>{label(preview.roleMappings.find(mapping => mapping.sourceRoleId === id)?.institutionId, preview.target.roles)}</td>
      </tr>)}</tbody>
    </table></div>}
  </div>
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
