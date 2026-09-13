import { useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import type {
  Goal,
  GoalInput,
  GoalPatch,
  ProjectWorkspaceInput,
  ProjectWorkspaceKind,
  WorkItem,
  WorkItemInput
} from '../../../../shared/types'
import { projectWorkspaceTemplate } from '../../../../shared/project-workspace-templates'
import {
  EMPTY_GOAL_DRAFT,
  EMPTY_WORK_ITEM_DRAFT,
  GOAL_RISK_OPTIONS,
  goalDraftFromGoal,
  goalInputFromDraft,
  goalPatchFromDraft,
  PROJECT_KIND_OPTIONS,
  TEXT,
  type GoalDraft,
  type StudioMutationKind,
  type WorkItemDraft,
  WORK_ITEM_TYPE_OPTIONS,
  workItemInputFromDraft
} from './projectWorkspaceStudioModel'

interface SharedFormProps {
  busy: StudioMutationKind | null
  onCancel: () => void
}

export function ProjectCreateForm({
  busy,
  onCancel,
  onSubmit
}: SharedFormProps & { onSubmit: (input: ProjectWorkspaceInput) => Promise<void> }): React.JSX.Element {
  const titleId = useId()
  const nameId = useId()
  const kindId = useId()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ProjectWorkspaceKind>('personal')
  const template = projectWorkspaceTemplate(kind)
  const artifacts = [...new Set(template.workItems.flatMap((item) => item.expectedArtifactKinds))]
  const isBusy = busy !== null

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void onSubmit({ name: name.trim(), kind })
  }

  return (
    <form className="pws-create-form" aria-labelledby={titleId} onSubmit={submit} onKeyDown={(event) => closeOnEscape(event, onCancel)} data-studio-form="project">
      <FormHeader id={titleId} title={TEXT.createProject} onCancel={onCancel} disabled={isBusy} />
      <fieldset className="pws-fieldset" disabled={isBusy}>
        <div className="pws-form-grid pws-form-grid-2">
          <FormField id={nameId} label={TEXT.projectName}>
            <input id={nameId} name="projectName" className="input" value={name} onChange={(event) => setName(event.target.value)} required autoFocus />
          </FormField>
          <FormField id={kindId} label={TEXT.projectKind}>
            <select id={kindId} name="projectKind" className="select select-block" value={kind} onChange={(event) => setKind(event.target.value as ProjectWorkspaceKind)}>
              {PROJECT_KIND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </FormField>
        </div>
        <section className="pws-template-preview" aria-live="polite" data-project-template={template.id}>
          <header>
            <div>
              <span className="pws-eyebrow">PROJECT TEMPLATE</span>
              <h4>{template.name}</h4>
            </div>
            <span>{TEXT.templateTaskCount(template.workItems.length)}</span>
          </header>
          <p>{template.summary}</p>
          <div className="pws-template-columns">
            <div>
              <strong>{TEXT.templateTaskSkeleton}</strong>
              <ol>{template.workItems.map((item) => <li key={item.key}>{item.title}</li>)}</ol>
            </div>
            <div>
              <strong>{TEXT.templateExpectedArtifacts}</strong>
              <div className="pws-template-tags">{artifacts.map((artifact) => <span key={artifact}>{artifact}</span>)}</div>
            </div>
            <div>
              <strong>{TEXT.templateResourceSuggestions}</strong>
              <ul>{template.resourceSuggestions.map((resource) => <li key={`${resource.kind}:${resource.label}`}>{resource.label}</li>)}</ul>
            </div>
          </div>
          <p className="pws-template-policy">{TEXT.templateResourcePolicy}</p>
        </section>
        <FormActions busy={busy === 'project'} submitLabel={TEXT.createProjectSubmit} onCancel={onCancel} />
      </fieldset>
    </form>
  )
}

export function GoalCreateForm({
  busy,
  onCancel,
  onSubmit,
  projectId
}: SharedFormProps & { projectId: string; onSubmit: (input: GoalInput) => Promise<void> }): React.JSX.Element {
  return (
    <GoalContractForm
      busy={busy !== null}
      initialDraft={EMPTY_GOAL_DRAFT}
      mode="goal"
      onCancel={onCancel}
      onSubmit={(draft) => onSubmit(goalInputFromDraft(projectId, draft))}
      submitLabel={TEXT.createGoalSubmit}
      title={TEXT.createGoal}
    />
  )
}

export function GoalEditForm({
  busy,
  goal,
  onCancel,
  onSubmit
}: {
  busy: boolean
  goal: Goal
  onCancel: () => void
  onSubmit: (patch: GoalPatch) => Promise<void>
}): React.JSX.Element {
  return (
    <GoalContractForm
      busy={busy}
      initialDraft={goalDraftFromGoal(goal)}
      mode="goal-edit"
      onCancel={onCancel}
      onSubmit={(draft) => onSubmit(goalPatchFromDraft(goal, draft))}
      submitLabel={TEXT.saveGoal}
      title={TEXT.editGoalTitle}
    />
  )
}

function GoalContractForm({
  busy,
  initialDraft,
  mode,
  onCancel,
  onSubmit,
  submitLabel,
  title
}: {
  busy: boolean
  initialDraft: GoalDraft
  mode: 'goal' | 'goal-edit'
  onCancel: () => void
  onSubmit: (draft: GoalDraft) => Promise<void>
  submitLabel: string
  title: string
}): React.JSX.Element {
  const baseId = useId()
  const [draft, setDraft] = useState<GoalDraft>({ ...initialDraft })
  const update = <K extends keyof GoalDraft>(field: K, value: GoalDraft[K]): void => {
    setDraft((current) => ({ ...current, [field]: value }))
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void onSubmit(draft)
  }

  return (
    <form className="pws-create-form" aria-labelledby={`${baseId}-title`} onSubmit={submit} onKeyDown={(event) => closeOnEscape(event, onCancel)} data-studio-form={mode}>
      <FormHeader id={`${baseId}-title`} title={title} onCancel={onCancel} disabled={busy} />
      <fieldset className="pws-fieldset" disabled={busy}>
        <div className="pws-form-grid pws-form-grid-2">
          <FormField id={`${baseId}-name`} label={TEXT.goalTitle}>
            <input id={`${baseId}-name`} className="input" value={draft.title} onChange={(event) => update('title', event.target.value)} required autoFocus data-goal-field="title" />
          </FormField>
          <FormField id={`${baseId}-risk`} label={TEXT.risk}>
            <select id={`${baseId}-risk`} className="select select-block" value={draft.riskLevel} onChange={(event) => update('riskLevel', event.target.value as GoalDraft['riskLevel'])} data-goal-field="risk">
              {GOAL_RISK_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </FormField>
          <FormField id={`${baseId}-objective`} label={TEXT.objective} wide>
            <textarea id={`${baseId}-objective`} className="input pws-textarea" rows={2} value={draft.objective} onChange={(event) => update('objective', event.target.value)} required data-goal-field="objective" />
          </FormField>
          <FormField id={`${baseId}-background`} label={TEXT.background} wide>
            <textarea id={`${baseId}-background`} className="input pws-textarea" rows={2} value={draft.background} onChange={(event) => update('background', event.target.value)} data-goal-field="background" />
          </FormField>
          <FormField id={`${baseId}-constraints`} label={TEXT.constraints}>
            <textarea id={`${baseId}-constraints`} className="input pws-textarea" rows={3} value={draft.constraints} onChange={(event) => update('constraints', event.target.value)} data-goal-field="constraints" />
          </FormField>
          <FormField id={`${baseId}-success`} label={TEXT.successCriteria}>
            <textarea id={`${baseId}-success`} className="input pws-textarea" rows={3} value={draft.successCriteria} onChange={(event) => update('successCriteria', event.target.value)} data-goal-field="success" />
          </FormField>
          <FormField id={`${baseId}-acceptance`} label={TEXT.acceptanceCriteria}>
            <textarea id={`${baseId}-acceptance`} className="input pws-textarea" rows={3} value={draft.acceptance} onChange={(event) => update('acceptance', event.target.value)} data-goal-field="acceptance" />
          </FormField>
          <FormField id={`${baseId}-forbidden`} label={TEXT.forbiddenActions}>
            <textarea id={`${baseId}-forbidden`} className="input pws-textarea" rows={3} value={draft.forbiddenActions} onChange={(event) => update('forbiddenActions', event.target.value)} data-goal-field="forbidden" />
          </FormField>
          <FormField id={`${baseId}-due`} label={TEXT.dueDate}>
            <input id={`${baseId}-due`} className="input" type="date" value={draft.dueDate} onChange={(event) => update('dueDate', event.target.value)} data-goal-field="due" />
          </FormField>
          <div className="pws-budget-grid pws-form-wide" role="group" aria-label={TEXT.budgetAmount}>
            <FormField id={`${baseId}-amount`} label={TEXT.budgetAmount}>
              <input id={`${baseId}-amount`} className="input" type="number" min="0" step="0.01" value={draft.budgetAmount} onChange={(event) => update('budgetAmount', event.target.value)} data-goal-field="budget-amount" />
            </FormField>
            <FormField id={`${baseId}-currency`} label={TEXT.budgetCurrency}>
              <input id={`${baseId}-currency`} className="input" value={draft.budgetCurrency} onChange={(event) => update('budgetCurrency', event.target.value)} maxLength={8} data-goal-field="budget-currency" />
            </FormField>
            <FormField id={`${baseId}-runs`} label={TEXT.budgetRuns}>
              <input id={`${baseId}-runs`} className="input" type="number" min="1" step="1" value={draft.budgetRuns} onChange={(event) => update('budgetRuns', event.target.value)} data-goal-field="budget-runs" />
            </FormField>
            <FormField id={`${baseId}-concurrent-runs`} label={TEXT.budgetConcurrentRuns}>
              <input id={`${baseId}-concurrent-runs`} className="input" type="number" min="1" step="1" value={draft.budgetConcurrentRuns} onChange={(event) => update('budgetConcurrentRuns', event.target.value)} data-goal-field="budget-concurrent-runs" />
            </FormField>
            <FormField id={`${baseId}-tokens`} label={TEXT.budgetTokens}>
              <input id={`${baseId}-tokens`} className="input" type="number" min="1" step="1" value={draft.budgetTokens} onChange={(event) => update('budgetTokens', event.target.value)} data-goal-field="budget-tokens" />
            </FormField>
          </div>
        </div>
        <FormActions busy={busy} submitLabel={submitLabel} onCancel={onCancel} />
      </fieldset>
    </form>
  )
}

export function WorkItemCreateForm({
  busy,
  goals,
  onCancel,
  onSubmit,
  projectId,
  workItems
}: SharedFormProps & {
  goals: Goal[]
  projectId: string
  workItems: WorkItem[]
  onSubmit: (input: WorkItemInput) => Promise<void>
}): React.JSX.Element {
  const baseId = useId()
  const [draft, setDraft] = useState<WorkItemDraft>({ ...EMPTY_WORK_ITEM_DRAFT })
  const isBusy = busy !== null
  const update = <K extends keyof WorkItemDraft>(field: K, value: WorkItemDraft[K]): void => {
    setDraft((current) => ({ ...current, [field]: value }))
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void onSubmit(workItemInputFromDraft(projectId, draft))
  }

  return (
    <form className="pws-create-form" aria-labelledby={`${baseId}-title`} onSubmit={submit} onKeyDown={(event) => closeOnEscape(event, onCancel)} data-studio-form="work-item">
      <FormHeader id={`${baseId}-title`} title={TEXT.createWorkItem} onCancel={onCancel} disabled={isBusy} />
      <fieldset className="pws-fieldset" disabled={isBusy}>
        <div className="pws-form-grid pws-form-grid-3">
          <FormField id={`${baseId}-name`} label={TEXT.workItemTitle} wide>
            <input id={`${baseId}-name`} className="input" value={draft.title} onChange={(event) => update('title', event.target.value)} required autoFocus />
          </FormField>
          <FormField id={`${baseId}-goal`} label={TEXT.linkedGoal}>
            <select id={`${baseId}-goal`} className="select select-block" value={draft.goalId} onChange={(event) => update('goalId', event.target.value)}>
              <option value="">{TEXT.noLinkedGoal}</option>
              {goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}
            </select>
          </FormField>
          <FormField id={`${baseId}-type`} label={TEXT.workItemType}>
            <select id={`${baseId}-type`} className="select select-block" value={draft.type} onChange={(event) => update('type', event.target.value as WorkItemDraft['type'])}>
              {WORK_ITEM_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </FormField>
          <FormField id={`${baseId}-priority`} label={TEXT.priority}>
            <input id={`${baseId}-priority`} className="input" type="number" min="0" step="1" value={draft.priority} onChange={(event) => update('priority', event.target.value)} />
          </FormField>
          <FormField id={`${baseId}-description`} label={TEXT.description} wide>
            <textarea id={`${baseId}-description`} className="input pws-textarea" rows={2} value={draft.description} onChange={(event) => update('description', event.target.value)} />
          </FormField>
          <FormField id={`${baseId}-owner-type`} label={TEXT.ownerType}>
            <select id={`${baseId}-owner-type`} className="select select-block" value={draft.ownerType} onChange={(event) => update('ownerType', event.target.value as WorkItemDraft['ownerType'])}>
              <option value="human">{TEXT.ownerHuman}</option>
              <option value="digital_worker">{TEXT.ownerDigitalWorker}</option>
            </select>
          </FormField>
          <FormField id={`${baseId}-owner-id`} label={TEXT.ownerId}>
            <input id={`${baseId}-owner-id`} className="input" value={draft.ownerId} onChange={(event) => update('ownerId', event.target.value)} />
          </FormField>
          <FormField id={`${baseId}-owner-name`} label={TEXT.ownerName}>
            <input id={`${baseId}-owner-name`} className="input" value={draft.ownerName} onChange={(event) => update('ownerName', event.target.value)} />
          </FormField>
          <FormField id={`${baseId}-due`} label={TEXT.dueDate}>
            <input id={`${baseId}-due`} className="input" type="date" value={draft.dueDate} onChange={(event) => update('dueDate', event.target.value)} />
          </FormField>
          <FormField id={`${baseId}-parent`} label={TEXT.parentWorkItem}>
            <select id={`${baseId}-parent`} className="select select-block" value={draft.parentId} onChange={(event) => update('parentId', event.target.value)}>
              <option value="">{TEXT.noParent}</option>
              {workItems.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </FormField>
          <FormField id={`${baseId}-acceptance`} label={TEXT.acceptanceCriteria} wide>
            <textarea id={`${baseId}-acceptance`} className="input pws-textarea" rows={2} value={draft.acceptance} onChange={(event) => update('acceptance', event.target.value)} />
          </FormField>
          <DependencyPicker baseId={baseId} draft={draft} items={workItems} update={update} />
        </div>
        <FormActions busy={busy === 'workItem'} submitLabel={TEXT.createWorkItemSubmit} onCancel={onCancel} />
      </fieldset>
    </form>
  )
}

function DependencyPicker({
  baseId,
  draft,
  items,
  update
}: {
  baseId: string
  draft: WorkItemDraft
  items: WorkItem[]
  update: <K extends keyof WorkItemDraft>(field: K, value: WorkItemDraft[K]) => void
}): React.JSX.Element {
  const toggle = (id: string): void => {
    const next = draft.dependencyIds.includes(id)
      ? draft.dependencyIds.filter((current) => current !== id)
      : [...draft.dependencyIds, id]
    update('dependencyIds', next)
  }
  return (
    <fieldset className="pws-dependency-picker pws-form-wide">
      <legend>{TEXT.dependencies}</legend>
      {items.length === 0 ? <span className="pws-muted">{TEXT.noDependencies}</span> : (
        <div className="pws-checkbox-grid">
          {items.map((item) => (
            <label key={item.id} className="pws-checkbox" htmlFor={`${baseId}-dependency-${item.id}`}>
              <input id={`${baseId}-dependency-${item.id}`} type="checkbox" checked={draft.dependencyIds.includes(item.id)} onChange={() => toggle(item.id)} />
              <span>{item.title}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  )
}

function FormHeader({ id, title, onCancel, disabled }: { id: string; title: string; onCancel: () => void; disabled: boolean }): React.JSX.Element {
  return (
    <div className="pws-form-header">
      <h3 id={id}>{title}</h3>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={disabled} aria-label={TEXT.closeForm}>{TEXT.cancel}</button>
    </div>
  )
}

function FormActions({ busy, submitLabel, onCancel }: { busy: boolean; submitLabel: string; onCancel: () => void }): React.JSX.Element {
  return (
    <div className="pws-form-actions">
      <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>{TEXT.cancel}</button>
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? TEXT.creating : submitLabel}</button>
    </div>
  )
}

function FormField({ id, label, children, wide = false }: { id: string; label: string; children: ReactNode; wide?: boolean }): React.JSX.Element {
  return (
    <div className={wide ? 'pws-field pws-form-wide' : 'pws-field'}>
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  )
}

function closeOnEscape(event: KeyboardEvent<HTMLFormElement>, onCancel: () => void): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  onCancel()
}
