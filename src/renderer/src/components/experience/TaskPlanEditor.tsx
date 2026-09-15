import { useMemo } from 'react'
import type { TaskPlanRiskLevel, TaskPlanStateView, TaskPlanVersion } from '../../../../shared/types'
import type { useT } from '../../i18n'
import {
  lineList,
  newPlanStep,
  updatePlanStep,
  type PlanForm,
  type PlanFormSetter
} from './task-plan-form'

type Translator = ReturnType<typeof useT>

interface TaskPlanEditorProps {
  t: Translator
  form: PlanForm
  setForm: PlanFormSetter
  state?: TaskPlanStateView
  running: boolean
  busy: boolean
  canEdit: boolean
  canApprove: boolean
  error?: string
  onSave(): void
  onApprove(): void
  onApproveAndExecute(): void
  onRevoke(): void
}

export default function TaskPlanEditor(props: TaskPlanEditorProps): React.JSX.Element {
  const current = props.state?.currentVersion
  return (
    <div className="task-plan-body">
      <TaskPlanObjective t={props.t} form={props.form} setForm={props.setForm} canEdit={props.canEdit} />
      <TaskPlanStepsEditor t={props.t} form={props.form} setForm={props.setForm} canEdit={props.canEdit} />
      <TaskPlanMetadataEditor
        t={props.t}
        form={props.form}
        setForm={props.setForm}
        current={current}
        canEdit={props.canEdit}
      />
      {current && <TaskPlanHistory t={props.t} current={current} versions={props.state?.versions ?? []} />}
      {props.error && <div className="task-plan-error" role="alert">{props.error}</div>}
      <TaskPlanActions {...props} current={current} />
    </div>
  )
}

function TaskPlanObjective({ t, form, setForm, canEdit }: EditorSectionProps): React.JSX.Element {
  return (
    <label className="task-plan-field task-plan-field-wide">
      <span>{t('taskPlanObjective')}</span>
      <textarea
        data-task-plan-objective="true"
        value={form.objective}
        disabled={!canEdit}
        rows={2}
        onChange={(event) => setForm((value) => ({ ...value, objective: event.target.value }))}
      />
    </label>
  )
}

function TaskPlanStepsEditor({ t, form, setForm, canEdit }: EditorSectionProps): React.JSX.Element {
  const stepIds = useMemo(
    () => new Set(form.steps.map((step) => step.id.trim()).filter(Boolean)),
    [form.steps]
  )
  return (
    <div className="task-plan-steps">
      <div className="task-plan-section-heading">
        <span>{t('taskPlanSteps')}</span>
        <button type="button" className="icon-btn task-plan-add-step" disabled={!canEdit}
          title={t('taskPlanAddStep')} aria-label={t('taskPlanAddStep')}
          onClick={() => setForm((value) => ({ ...value, steps: [...value.steps, newPlanStep(value.steps.length + 1)] }))}>
          +
        </button>
      </div>
      {form.steps.map((step, index) => (
        <div className="task-plan-step" key={step.key}>
          <input data-task-plan-step-id={index} aria-label={t('taskPlanStepId')} title={t('taskPlanStepId')}
            value={step.id} disabled={!canEdit}
            onChange={(event) => updatePlanStep(setForm, index, { id: event.target.value })} />
          <input data-task-plan-step-title={index} aria-label={t('taskPlanStepTitle')}
            placeholder={t('taskPlanStepTitle')} value={step.title} disabled={!canEdit}
            onChange={(event) => updatePlanStep(setForm, index, { title: event.target.value })} />
          <input aria-label={t('taskPlanDependencies')} placeholder={t('taskPlanDependencies')}
            value={step.dependsOn} disabled={!canEdit}
            data-dependencies-valid={lineList(step.dependsOn).every((id) => stepIds.has(id))}
            onChange={(event) => updatePlanStep(setForm, index, { dependsOn: event.target.value })} />
          <button type="button" className="icon-btn task-plan-remove-step"
            disabled={!canEdit || form.steps.length === 1} title={t('taskPlanRemoveStep')}
            aria-label={t('taskPlanRemoveStep')}
            onClick={() => setForm((value) => ({
              ...value,
              steps: value.steps.filter((_, itemIndex) => itemIndex !== index)
            }))}>
            ×
          </button>
          <textarea aria-label={t('taskPlanStepDescription')} placeholder={t('taskPlanStepDescription')}
            value={step.description} disabled={!canEdit} rows={2}
            onChange={(event) => updatePlanStep(setForm, index, { description: event.target.value })} />
          <textarea aria-label={t('taskPlanStepArtifacts')} placeholder={t('taskPlanStepArtifacts')}
            value={step.expectedArtifacts} disabled={!canEdit} rows={2}
            onChange={(event) => updatePlanStep(setForm, index, { expectedArtifacts: event.target.value })} />
          <textarea aria-label={t('taskPlanStepDataEgress')} placeholder={t('taskPlanStepDataEgress')}
            value={step.dataEgress} disabled={!canEdit} rows={2}
            onChange={(event) => updatePlanStep(setForm, index, { dataEgress: event.target.value })} />
          <label className="task-plan-step-inline">
            <span>{t('taskPlanStepRisk')}</span>
            <select value={step.riskLevel} disabled={!canEdit}
              onChange={(event) => updatePlanStep(setForm, index, {
                riskLevel: event.target.value as TaskPlanRiskLevel
              })}>
              <option value="low">{t('taskPlanRiskLow')}</option>
              <option value="medium">{t('taskPlanRiskMedium')}</option>
              <option value="high">{t('taskPlanRiskHigh')}</option>
              <option value="critical">{t('taskPlanRiskCritical')}</option>
            </select>
          </label>
          <label className="task-plan-step-inline">
            <span>{t('taskPlanStepCost')}</span>
            <input type="number" min="0" step="0.01" value={step.estimatedCostUsd} disabled={!canEdit}
              onChange={(event) => updatePlanStep(setForm, index, { estimatedCostUsd: event.target.value })} />
          </label>
        </div>
      ))}
    </div>
  )
}

function TaskPlanMetadataEditor({ t, form, setForm, canEdit, current }: MetadataProps): React.JSX.Element {
  const update = (patch: Partial<PlanForm>): void => setForm((value) => ({ ...value, ...patch }))
  return (
    <div className="task-plan-grid">
      <PlanTextField label={t('taskPlanArtifacts')} value={form.expectedArtifacts} disabled={!canEdit}
        onChange={(expectedArtifacts) => update({ expectedArtifacts })} />
      <PlanTextField label={t('taskPlanDataEgress')} value={form.dataEgress} disabled={!canEdit}
        onChange={(dataEgress) => update({ dataEgress })} />
      <PlanTextField label={t('taskPlanAcceptance')} value={form.acceptanceCriteria} disabled={!canEdit}
        marker="acceptance" onChange={(acceptanceCriteria) => update({ acceptanceCriteria })} />
      <div className="task-plan-inline-fields">
        <label className="task-plan-field">
          <span>{t('taskPlanRisk')}</span>
          <select value={form.riskLevel} disabled={!canEdit}
            onChange={(event) => update({ riskLevel: event.target.value as TaskPlanRiskLevel })}>
            <option value="low">{t('taskPlanRiskLow')}</option>
            <option value="medium">{t('taskPlanRiskMedium')}</option>
            <option value="high">{t('taskPlanRiskHigh')}</option>
            <option value="critical">{t('taskPlanRiskCritical')}</option>
          </select>
        </label>
        <label className="task-plan-field">
          <span>{t('taskPlanCost')}</span>
          <input type="number" min="0" step="0.01" value={form.estimatedCostUsd} disabled={!canEdit}
            onChange={(event) => update({ estimatedCostUsd: event.target.value })} />
        </label>
      </div>
      {current && (
        <label className="task-plan-field task-plan-field-wide">
          <span>{t('taskPlanChangeReason')}</span>
          <input data-task-plan-change-reason="true" value={form.changeReason} disabled={!canEdit}
            onChange={(event) => update({ changeReason: event.target.value })} />
        </label>
      )}
    </div>
  )
}

function PlanTextField({ label, value, disabled, marker, onChange }: PlanTextFieldProps): React.JSX.Element {
  return (
    <label className="task-plan-field">
      <span>{label}</span>
      <textarea value={value} disabled={disabled} rows={2}
        data-task-plan-acceptance={marker === 'acceptance' ? 'true' : undefined}
        onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}

function TaskPlanHistory({ t, current, versions }: HistoryProps): React.JSX.Element {
  return (
    <details className="task-plan-history">
      <summary>{t('taskPlanHistory')} · {current.digest}</summary>
      <ol>
        {[...versions].reverse().map((version) => (
          <li key={version.id}>v{version.version} · {version.source} · {version.digest}</li>
        ))}
      </ol>
    </details>
  )
}

function TaskPlanActions(props: TaskPlanEditorProps & { current?: TaskPlanVersion }): React.JSX.Element {
  return (
    <div className="task-plan-actions">
      <button type="button" className="btn" data-task-plan-save="true" disabled={!props.canEdit}
        onClick={props.onSave}>{props.t('taskPlanSaveVersion')}</button>
      {props.state?.approvalStatus === 'approved' && props.current ? (
        <button type="button" className="btn" disabled={props.running || props.busy}
          onClick={props.onRevoke}>{props.t('taskPlanRevoke')}</button>
      ) : (
        <button type="button" className="btn" data-task-plan-approve="true" disabled={!props.canApprove}
          onClick={props.onApprove}>{props.t('taskPlanApprove')}</button>
      )}
      <button type="button" className="btn btn-primary" data-task-plan-approve-execute="true"
        disabled={!props.canApprove} onClick={props.onApproveAndExecute}>
        {props.t('taskPlanApproveExecute')}
      </button>
    </div>
  )
}

interface EditorSectionProps {
  t: Translator
  form: PlanForm
  setForm: PlanFormSetter
  canEdit: boolean
}

interface MetadataProps extends EditorSectionProps {
  current?: TaskPlanVersion
}

interface PlanTextFieldProps {
  label: string
  value: string
  disabled: boolean
  marker?: 'acceptance'
  onChange(value: string): void
}

interface HistoryProps {
  t: Translator
  current: TaskPlanVersion
  versions: TaskPlanVersion[]
}
