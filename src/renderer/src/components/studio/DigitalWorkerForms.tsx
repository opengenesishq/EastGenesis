import { useEffect, useId, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type {
  DigitalWorker,
  DigitalWorkerAssignment,
  DigitalWorkerInput,
  DigitalWorkerRoleRecommendation,
  JsonObject,
  RoleTemplate,
  RoleTemplateInput
} from '../../../../shared/types'
import type { DigitalWorkerStudioWorkItem } from './digital-worker-studio-model'
import HireWorkerPolicyFields from './HireWorkerPolicyFields'
import {
  WATERCOLOR_ROLE_OPTIONS,
  splitList,
  suggestedWatercolorRole,
  studioLocalized,
  workerAllowedDataClasses,
  workerAllowedResourceIds,
  workerDeniedDataClasses,
  workItemTitle
} from './digital-worker-studio-model'
import type { WatercolorCharacterRole } from '../../../../shared/watercolor-character'

export { WorkerMemoryForm } from './WorkerMemoryForm'

interface RoleTemplateFormProps {
  busy: boolean
  onCancel: () => void
  onSubmit: (input: RoleTemplateInput) => Promise<boolean>
}

export function RoleTemplateForm({ busy, onCancel, onSubmit }: RoleTemplateFormProps): React.JSX.Element {
  const titleId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [instructions, setInstructions] = useState('')
  const [capabilities, setCapabilities] = useState('')
  const [skills, setSkills] = useState('')

  useEffect(() => nameRef.current?.focus(), [])

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const ok = await onSubmit({
      name: name.trim(),
      purpose: purpose.trim(),
      instructions: instructions.trim(),
      capabilityRefs: splitList(capabilities),
      skillRefs: splitList(skills),
      source: 'user'
    })
    if (ok) onCancel()
  }

  return (
    <form
      className="dws-editor"
      aria-labelledby={titleId}
      data-dws-form="role-template"
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onCancel()
      }}
    >
      <div className="dws-editor-heading">
        <div>
          <h3 id={titleId}>{studioLocalized('新建岗位', 'New role')}</h3>
          <span>{studioLocalized('只需填写岗位名称和主要职责', 'Only the role name and primary responsibility are required')}</span>
        </div>
        <button type="button" className="dws-button dws-button-quiet" onClick={onCancel} disabled={busy}>{studioLocalized('取消', 'Cancel')}</button>
      </div>
      <div className="dws-form-grid">
        <label className="dws-field">
          <span>{studioLocalized('岗位名称', 'Role name')}</span>
          <input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} />
        </label>
        <label className="dws-field dws-field-wide">
          <span>{studioLocalized('主要职责', 'Primary responsibility')}</span>
          <textarea
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
            required
            rows={2}
            maxLength={240}
            placeholder={studioLocalized('例如：整理资料并输出可交付的项目报告', 'For example: Organize source material and deliver a project report')}
          />
        </label>
        <details className="dws-advanced dws-field-wide">
          <summary>{studioLocalized('高级设置', 'Advanced settings')}</summary>
          <p>{studioLocalized('补充执行说明和能力标签，不填写也能创建', 'Add execution instructions and capability labels when needed')}</p>
          <div className="dws-form-grid">
            <label className="dws-field dws-field-wide">
              <span>{studioLocalized('详细执行说明', 'Detailed execution instructions')}</span>
              <textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={3} maxLength={4000} />
            </label>
            <label className="dws-field">
              <span>{studioLocalized('能力标签', 'Capability labels')}</span>
              <input value={capabilities} onChange={(event) => setCapabilities(event.target.value)} placeholder={studioLocalized('研究, 写作, 审核', 'research, writing, review')} />
            </label>
            <label className="dws-field">
              <span>{studioLocalized('技能标签', 'Skill labels')}</span>
              <input value={skills} onChange={(event) => setSkills(event.target.value)} placeholder={studioLocalized('资料检索, 文档整理', 'source research, document organization')} />
            </label>
          </div>
        </details>
      </div>
      <div className="dws-editor-actions">
        <button type="submit" className="dws-button dws-button-primary" disabled={busy || !name.trim() || !purpose.trim()}>
          {busy ? studioLocalized('创建中...', 'Creating...') : studioLocalized('创建岗位', 'Create role')}
        </button>
      </div>
    </form>
  )
}

interface HireWorkerFormProps {
  projectId: string
  roles: readonly RoleTemplate[]
  initialRoleId?: string
  recommendation?: DigitalWorkerRoleRecommendation
  busy: boolean
  onCancel: () => void
  onSubmit: (input: DigitalWorkerInput, activate: boolean) => Promise<boolean>
}

interface HireWorkerIdentityFieldsProps {
  roles: readonly RoleTemplate[]
  displayName: string
  roleId: string
  setDisplayName: Dispatch<SetStateAction<string>>
  onRoleIdChange: (roleId: string) => void
}

function HireWorkerIdentityFields(props: HireWorkerIdentityFieldsProps): React.JSX.Element {
  const {
    roles,
    displayName,
    roleId,
    setDisplayName,
    onRoleIdChange
  } = props
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => nameRef.current?.focus(), [])

  return (
    <>
      <label className="dws-field">
        <span>{studioLocalized('岗位', 'Role')}</span>
        <select value={roleId} onChange={(event) => onRoleIdChange(event.target.value)} required>
          <option value="" disabled>{studioLocalized('选择岗位', 'Select a role')}</option>
          {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
        </select>
      </label>
      <label className="dws-field">
        <span>{studioLocalized('员工名称', 'Worker name')}</span>
        <input
          ref={nameRef}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          required
          maxLength={80}
        />
      </label>
    </>
  )
}

function roleResponsibility(roleId: string, roles: readonly RoleTemplate[]): string {
  const role = roles.find((candidate) => candidate.id === roleId)
  return role?.instructions.trim() || role?.purpose.trim() || ''
}

function generatedWorkerName(roleId: string, roles: readonly RoleTemplate[]): string {
  const role = roles.find((candidate) => candidate.id === roleId)
  return role ? `${role.name} 01` : ''
}

interface HireWorkerDataScopeFieldsProps {
  allowedDataClasses: string
  deniedDataClasses: string
  allowedResourceIds: string
  requireExplicitScope: boolean
  setAllowedDataClasses: Dispatch<SetStateAction<string>>
  setDeniedDataClasses: Dispatch<SetStateAction<string>>
  setAllowedResourceIds: Dispatch<SetStateAction<string>>
  setRequireExplicitScope: Dispatch<SetStateAction<boolean>>
}

function HireWorkerDataScopeFields(props: HireWorkerDataScopeFieldsProps): React.JSX.Element {
  const {
    allowedDataClasses,
    deniedDataClasses,
    allowedResourceIds,
    requireExplicitScope,
    setAllowedDataClasses,
    setDeniedDataClasses,
    setAllowedResourceIds,
    setRequireExplicitScope
  } = props
  return (
    <fieldset className="dws-fieldset dws-field-wide">
      <legend>{studioLocalized('数据范围', 'Data scope')}</legend>
      <div className="dws-form-grid dws-nested-grid">
        <label className="dws-field">
          <span>{studioLocalized('允许的数据类', 'Allowed data classes')}</span>
          <input
            value={allowedDataClasses}
            onChange={(event) => setAllowedDataClasses(event.target.value)}
            placeholder="project-internal, public"
          />
        </label>
        <label className="dws-field">
          <span>{studioLocalized('禁止的数据类', 'Denied data classes')}</span>
          <input
            value={deniedDataClasses}
            onChange={(event) => setDeniedDataClasses(event.target.value)}
            placeholder="credential, restricted"
          />
        </label>
        <label className="dws-field dws-field-wide">
          <span>{studioLocalized('允许的 Resource ID', 'Allowed Resource IDs')}</span>
          <input
            value={allowedResourceIds}
            onChange={(event) => setAllowedResourceIds(event.target.value)}
            placeholder="repo-main, docs-public"
          />
        </label>
        <label className="dws-check dws-field-wide">
          <input
            type="checkbox"
            checked={requireExplicitScope}
            onChange={(event) => setRequireExplicitScope(event.target.checked)}
          />
          <span>{studioLocalized('分配 WorkItem 时必须声明数据类', 'Require a data class when assigning work items')}</span>
        </label>
      </div>
    </fieldset>
  )
}

interface HireWorkerInputValues {
  projectId: string
  roleId: string
  watercolorRole: WatercolorCharacterRole
  displayName: string
  responsibilities: string
  permissions: PermissionFieldsProps['permissions']
  allowedDataClasses: string
  deniedDataClasses: string
  allowedResourceIds: string
  requireExplicitScope: boolean
  monthlyBudget: string
  concurrency: string
  minimumEvidenceCount: string
  requireUserApproval: boolean
  escalationTarget: string
  escalateAfterFailures: string
}

function buildHireWorkerInput(values: HireWorkerInputValues): DigitalWorkerInput {
  const budget = values.monthlyBudget.trim() ? Number(values.monthlyBudget) : undefined
  return {
    projectId: values.projectId,
    roleTemplateId: values.roleId,
    displayName: values.displayName.trim(),
    avatarProfile: { watercolorRole: values.watercolorRole },
    responsibilityScope: splitList(values.responsibilities),
    toolPolicy: values.permissions,
    dataScope: {
      requireExplicitScope: values.requireExplicitScope,
      allowedDataClasses: splitList(values.allowedDataClasses),
      deniedDataClasses: splitList(values.deniedDataClasses),
      allowedResourceIds: splitList(values.allowedResourceIds)
    },
    budgetPolicy: budget === undefined ? {} : { monthlyUsd: budget },
    concurrencyLimit: Number(values.concurrency),
    acceptancePolicy: {
      minimumEvidenceCount: Number(values.minimumEvidenceCount),
      requireUserApproval: values.requireUserApproval
    },
    escalationPolicy: {
      target: values.escalationTarget.trim(),
      afterFailures: Number(values.escalateAfterFailures)
    }
  }
}

export function HireWorkerForm(props: HireWorkerFormProps): React.JSX.Element {
  const { projectId, roles, initialRoleId, recommendation, busy, onCancel, onSubmit } = props
  const titleId = useId()
  const defaultRoleId = initialRoleId || roles[0]?.id || ''
  const [displayName, setDisplayName] = useState(
    recommendation ? `${recommendation.name} 01` : generatedWorkerName(defaultRoleId, roles)
  )
  const [roleId, setRoleId] = useState(defaultRoleId)
  const [watercolorRole, setWatercolorRole] = useState<WatercolorCharacterRole>(() =>
    suggestedWatercolorRole(initialRoleId || roles[0]?.id || '', roles)
  )
  const [responsibilities, setResponsibilities] = useState(
    recommendation?.responsibilities.join('\n') || roleResponsibility(defaultRoleId, roles)
  )
  const [monthlyBudget, setMonthlyBudget] = useState(jsonNumberText(recommendation?.budgetPolicy.maxAmount))
  const [concurrency, setConcurrency] = useState(jsonNumberText(recommendation?.budgetPolicy.maxConcurrentRuns) || '1')
  const [allowedDataClasses, setAllowedDataClasses] = useState(jsonStringList(recommendation?.dataScope.allowedDataClasses))
  const [deniedDataClasses, setDeniedDataClasses] = useState('')
  const [allowedResourceIds, setAllowedResourceIds] = useState(jsonStringList(recommendation?.dataScope.allowedResourceIds))
  const [requireExplicitScope, setRequireExplicitScope] = useState(recommendation?.dataScope.requireExplicitScope === true)
  const [minimumEvidenceCount, setMinimumEvidenceCount] = useState(String(Math.max(1, Math.min(recommendation?.acceptance.length ?? 1, 10000))))
  const [requireUserApproval, setRequireUserApproval] = useState(false)
  const [escalationTarget, setEscalationTarget] = useState(jsonString(recommendation?.escalationPolicy.target) || 'project-owner')
  const [escalateAfterFailures, setEscalateAfterFailures] = useState(jsonNumberText(recommendation?.escalationPolicy.afterFailures) || '2')
  const [activate, setActivate] = useState(true)
  const [permissions, setPermissions] = useState(() => ({
    workspaceRead: recommendation?.toolPolicy.workspaceRead !== false,
    workspaceWrite: recommendation?.toolPolicy.workspaceWrite === true,
    terminal: recommendation?.toolPolicy.terminal === true,
    browser: recommendation?.toolPolicy.browser === true,
    network: recommendation?.toolPolicy.network === true
  }))

  useEffect(() => {
    if (initialRoleId && roles.some((role) => role.id === initialRoleId)) {
      setRoleId(initialRoleId)
      setWatercolorRole(suggestedWatercolorRole(initialRoleId, roles))
    }
  }, [initialRoleId, roles])

  const selectRole = (nextRoleId: string): void => {
    const previousGeneratedName = generatedWorkerName(roleId, roles)
    const previousResponsibility = roleResponsibility(roleId, roles)
    setRoleId(nextRoleId)
    setWatercolorRole(suggestedWatercolorRole(nextRoleId, roles))
    setDisplayName((current) => current.trim() === '' || current === previousGeneratedName
      ? generatedWorkerName(nextRoleId, roles)
      : current)
    setResponsibilities((current) => current.trim() === '' || current === previousResponsibility
      ? roleResponsibility(nextRoleId, roles)
      : current)
  }

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const input = buildHireWorkerInput({
      projectId,
      roleId,
      watercolorRole,
      displayName,
      responsibilities,
      permissions,
      allowedDataClasses,
      deniedDataClasses,
      allowedResourceIds,
      requireExplicitScope,
      monthlyBudget,
      concurrency,
      minimumEvidenceCount,
      requireUserApproval,
      escalationTarget,
      escalateAfterFailures
    })
    if (await onSubmit(input, activate)) onCancel()
  }

  return (
    <form
      className="dws-editor"
      aria-labelledby={titleId}
      data-dws-form="hire-worker"
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onCancel()
      }}
    >
      <div className="dws-editor-heading">
        <div>
          <h3 id={titleId}>{studioLocalized('招聘数字员工', 'Hire digital worker')}</h3>
          <span>{studioLocalized('岗位职责和安全策略已经自动配置，可直接招聘', 'Responsibilities and security policies are preconfigured')}</span>
        </div>
        <button type="button" className="dws-button dws-button-quiet" onClick={onCancel} disabled={busy}>{studioLocalized('取消', 'Cancel')}</button>
      </div>
      <div className="dws-form-grid">
        <HireWorkerIdentityFields
          roles={roles}
          displayName={displayName}
          roleId={roleId}
          setDisplayName={setDisplayName}
          onRoleIdChange={selectRole}
        />
        <details className="dws-advanced dws-field-wide">
          <summary>{studioLocalized('高级设置', 'Advanced settings')}</summary>
          <p>{studioLocalized('需要特殊规则时再修改；默认值适合大多数任务', 'Change these only when special rules are required; the defaults suit most tasks')}</p>
          <div className="dws-form-grid">
            <label className="dws-field dws-field-wide">
              <span>{studioLocalized('自定义职责', 'Custom responsibilities')}</span>
              <textarea
                value={responsibilities}
                onChange={(event) => setResponsibilities(event.target.value)}
                rows={2}
                placeholder={studioLocalized('默认继承岗位职责', 'Inherits role responsibilities by default')}
                maxLength={2000}
              />
            </label>
            <label className="dws-field">
              <span>{studioLocalized('水墨岗位形象', 'Office role appearance')}</span>
              <select
                value={watercolorRole}
                onChange={(event) => setWatercolorRole(event.target.value as WatercolorCharacterRole)}
                data-dws-watercolor-role
              >
                {WATERCOLOR_ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="dws-check">
              <input type="checkbox" checked={activate} onChange={(event) => setActivate(event.target.checked)} />
              <span>{studioLocalized('入职后立即启用', 'Activate immediately after hiring')}</span>
            </label>
            <PermissionFields permissions={permissions} setPermissions={setPermissions} />
            <HireWorkerDataScopeFields
              allowedDataClasses={allowedDataClasses}
              deniedDataClasses={deniedDataClasses}
              allowedResourceIds={allowedResourceIds}
              requireExplicitScope={requireExplicitScope}
              setAllowedDataClasses={setAllowedDataClasses}
              setDeniedDataClasses={setDeniedDataClasses}
              setAllowedResourceIds={setAllowedResourceIds}
              setRequireExplicitScope={setRequireExplicitScope}
            />
            <HireWorkerPolicyFields
              monthlyBudget={monthlyBudget}
              concurrency={concurrency}
              minimumEvidenceCount={minimumEvidenceCount}
              requireUserApproval={requireUserApproval}
              escalationTarget={escalationTarget}
              escalateAfterFailures={escalateAfterFailures}
              setMonthlyBudget={setMonthlyBudget}
              setConcurrency={setConcurrency}
              setMinimumEvidenceCount={setMinimumEvidenceCount}
              setRequireUserApproval={setRequireUserApproval}
              setEscalationTarget={setEscalationTarget}
              setEscalateAfterFailures={setEscalateAfterFailures}
            />
          </div>
        </details>
      </div>
      <div className="dws-editor-actions">
        <button
          type="submit"
          className="dws-button dws-button-primary"
          disabled={busy || !displayName.trim() || !roleId || !projectId}
        >
          {busy ? studioLocalized('招聘中...', 'Hiring...') : studioLocalized('确认招聘', 'Confirm hire')}
        </button>
      </div>
    </form>
  )
}

function jsonString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function jsonNumberText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function jsonStringList(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').join(', ')
    : ''
}

interface PermissionFieldsProps {
  permissions: {
    workspaceRead: boolean
    workspaceWrite: boolean
    terminal: boolean
    browser: boolean
    network: boolean
  }
  setPermissions: Dispatch<SetStateAction<PermissionFieldsProps['permissions']>>
}

function PermissionFields({ permissions, setPermissions }: PermissionFieldsProps): React.JSX.Element {
  const options = [
    ['workspaceRead', studioLocalized('读取工作区', 'Read workspace')],
    ['workspaceWrite', studioLocalized('修改工作区', 'Modify workspace')],
    ['terminal', studioLocalized('终端操作', 'Terminal access')],
    ['browser', studioLocalized('浏览器操作', 'Browser access')],
    ['network', studioLocalized('网络访问', 'Network access')]
  ] as const
  return (
    <fieldset className="dws-fieldset dws-field-wide">
      <legend>{studioLocalized('工具权限', 'Tool permissions')}</legend>
      <div className="dws-check-grid">
        {options.map(([key, label]) => (
          <label key={key} className="dws-check">
            <input
              type="checkbox"
              checked={permissions[key]}
              onChange={() => setPermissions((current) => ({ ...current, [key]: !current[key] }))}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

interface AssignmentFormProps {
  projectId: string
  workItems: readonly DigitalWorkerStudioWorkItem[]
  workers: readonly DigitalWorker[]
  assignments: readonly DigitalWorkerAssignment[]
  initialWorkerId?: string
  busy: boolean
  onCancel: () => void
  onSubmit: (workItemId: string, workerId: string, scope: JsonObject, reason: string) => Promise<boolean>
}

function buildAssignmentScope(dataClass: string, resourceIds: string): JsonObject {
  const resources = splitList(resourceIds)
  return {
    ...(dataClass.trim() ? { dataClass: dataClass.trim() } : {}),
    ...(resources.length > 0 ? { resourceIds: resources } : {})
  }
}

interface AssignmentScopeFieldsProps {
  titleId: string
  worker?: DigitalWorker
  dataClass: string
  resourceIds: string
  setDataClass: Dispatch<SetStateAction<string>>
  setResourceIds: Dispatch<SetStateAction<string>>
}

function AssignmentScopeFields(props: AssignmentScopeFieldsProps): React.JSX.Element {
  const { titleId, worker, dataClass, resourceIds, setDataClass, setResourceIds } = props
  const allowedDataClasses = worker ? workerAllowedDataClasses(worker) : []
  const deniedDataClasses = worker ? workerDeniedDataClasses(worker) : []
  const allowedResources = worker ? workerAllowedResourceIds(worker) : []
  const scopeRequired = worker?.dataScope.requireExplicitScope === true ||
    allowedDataClasses.length > 0 || deniedDataClasses.length > 0

  return (
    <>
      <label className="dws-field dws-field-wide">
        <span>{studioLocalized('数据类', 'Data classes')}</span>
        <input
          value={dataClass}
          onChange={(event) => setDataClass(event.target.value)}
          required={scopeRequired}
          list={`${titleId}-data-classes`}
          placeholder={scopeRequired ? studioLocalized('必须匹配员工策略', 'Must match worker policy') : studioLocalized('可选', 'Optional')}
        />
        <datalist id={`${titleId}-data-classes`}>
          {allowedDataClasses.map((entry) => <option key={entry} value={entry} />)}
        </datalist>
      </label>
      <label className="dws-field dws-field-wide">
        <span>Resource ID</span>
        <input
          value={resourceIds}
          onChange={(event) => setResourceIds(event.target.value)}
          required={allowedResources.length > 0}
          placeholder={allowedResources.length > 0 ? studioLocalized('必须匹配员工策略', 'Must match worker policy') : studioLocalized('多个值用逗号或换行分隔', 'Separate multiple values with commas or line breaks')}
        />
      </label>
    </>
  )
}

interface AssignmentFieldsProps {
  titleId: string
  workItems: readonly DigitalWorkerStudioWorkItem[]
  activeWorkers: readonly DigitalWorker[]
  currentAssignment?: DigitalWorkerAssignment
  workItemId: string
  workerId: string
  dataClass: string
  resourceIds: string
  reason: string
  setWorkItemId: Dispatch<SetStateAction<string>>
  setWorkerId: Dispatch<SetStateAction<string>>
  setDataClass: Dispatch<SetStateAction<string>>
  setResourceIds: Dispatch<SetStateAction<string>>
  setReason: Dispatch<SetStateAction<string>>
}

function AssignmentFields(props: AssignmentFieldsProps): React.JSX.Element {
  const {
    titleId,
    workItems,
    activeWorkers,
    currentAssignment,
    workItemId,
    workerId,
    dataClass,
    resourceIds,
    reason,
    setWorkItemId,
    setWorkerId,
    setDataClass,
    setResourceIds,
    setReason
  } = props
  const selectedWorker = activeWorkers.find((worker) => worker.id === workerId)

  return (
    <div className="dws-form-grid">
      <label className="dws-field">
        <span>WorkItem</span>
        <select value={workItemId} onChange={(event) => setWorkItemId(event.target.value)} data-dws-field="work-item">
          {workItems.map((item) => (
            <option key={item.id} value={item.id}>{item.title}{item.status ? ` · ${item.status}` : ''}</option>
          ))}
        </select>
      </label>
      <label className="dws-field">
        <span>{studioLocalized('数字员工', 'Digital worker')}</span>
        <select value={workerId} onChange={(event) => setWorkerId(event.target.value)} data-dws-field="worker">
          {activeWorkers.map((worker) => <option key={worker.id} value={worker.id}>{worker.displayName}</option>)}
        </select>
      </label>
      <AssignmentScopeFields
        titleId={titleId}
        worker={selectedWorker}
        dataClass={dataClass}
        resourceIds={resourceIds}
        setDataClass={setDataClass}
        setResourceIds={setResourceIds}
      />
      <label className="dws-field dws-field-wide">
        <span>{studioLocalized('分配原因', 'Assignment reason')}</span>
        <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={240} />
      </label>
      {currentAssignment && (
        <div className="dws-current-assignment dws-field-wide" role="status">
          {studioLocalized(`${workItemTitle(currentAssignment.workItemId, workItems)} 当前已有负责人，提交后将保留历史并完成改派。`, `${workItemTitle(currentAssignment.workItemId, workItems)} already has an owner. Submitting will preserve the history and transfer ownership.`)}
        </div>
      )}
    </div>
  )
}

export function AssignmentForm(props: AssignmentFormProps): React.JSX.Element {
  const { projectId, workItems, workers, assignments, initialWorkerId, busy, onCancel, onSubmit } = props
  const titleId = useId()
  const activeWorkers = workers.filter((worker) => worker.status === 'active')
  const [workItemId, setWorkItemId] = useState(workItems[0]?.id || '')
  const [workerId, setWorkerId] = useState(initialWorkerId || activeWorkers[0]?.id || '')
  const [dataClass, setDataClass] = useState('')
  const [resourceIds, setResourceIds] = useState('')
  const [reason, setReason] = useState('')

  const currentAssignment = assignments.find(
    (item) => item.projectId === projectId && item.workItemId === workItemId && item.status === 'active'
  )
  const unchanged = currentAssignment?.assigneeKind === 'digital_worker' && currentAssignment.assigneeId === workerId

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const scope = buildAssignmentScope(dataClass, resourceIds)
    if (await onSubmit(workItemId, workerId, scope, reason)) onCancel()
  }

  return (
    <form
      className="dws-editor"
      aria-labelledby={titleId}
      data-dws-form="assignment"
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onCancel()
      }}
    >
      <div className="dws-editor-heading">
        <h3 id={titleId}>{studioLocalized('分配 WorkItem', 'Assign work item')}</h3>
        <button type="button" className="dws-button dws-button-quiet" onClick={onCancel} disabled={busy}>{studioLocalized('取消', 'Cancel')}</button>
      </div>
      {workItems.length === 0 || activeWorkers.length === 0 ? (
        <div className="dws-inline-empty" role="status">
          {workItems.length === 0 ? studioLocalized('当前项目暂无 WorkItem。', 'This project has no work items.') : studioLocalized('当前项目暂无工作中的数字员工。', 'This project has no active digital workers.')}
        </div>
      ) : (
        <AssignmentFields
          titleId={titleId}
          workItems={workItems}
          activeWorkers={activeWorkers}
          currentAssignment={currentAssignment}
          workItemId={workItemId}
          workerId={workerId}
          dataClass={dataClass}
          resourceIds={resourceIds}
          reason={reason}
          setWorkItemId={setWorkItemId}
          setWorkerId={setWorkerId}
          setDataClass={setDataClass}
          setResourceIds={setResourceIds}
          setReason={setReason}
        />
      )}
      <div className="dws-editor-actions">
        <button
          type="submit"
          className="dws-button dws-button-primary"
          disabled={busy || !workItemId || !workerId || unchanged}
        >
          {busy ? studioLocalized('分配中...', 'Assigning...') : unchanged ? studioLocalized('已分配', 'Assigned') : studioLocalized('确认分配', 'Confirm assignment')}
        </button>
      </div>
    </form>
  )
}
