import { useId, useRef, useState } from 'react'
import { useStore } from '../../store'
import { readComposerDraft, writeComposerDraft } from '../../store/composer-draft-persistence'
import type { GoalPlanningTemplate } from '../../lib/project-goal-task-submission'
import type { useProjectGoalTaskStart } from './useProjectWorkspaceStudio'
import { localized, TEXT } from './projectWorkspaceStudioLocale'
import TaskPlanWorkbench from '../experience/TaskPlanWorkbench'
import PersonalTaskRecoveryPanel from '../experience/PersonalTaskRecoveryPanel'

/** Both entry surfaces use the same draft, canonical submitter and plan workbench. */
export default function GoalTaskStarter({ projectId, state }: {
  projectId?: string
  state: ReturnType<typeof useProjectGoalTaskStart>
}): React.JSX.Element {
  const id = useId()
  const storage = useRef<Storage>()
  if (!storage.current) { try { storage.current = window.localStorage } catch { /* typing remains available */ } }
  const draftKey = `goal-intake:${projectId ?? 'personal'}`
  const [objective, setObjective] = useState(() => readComposerDraft(storage.current, draftKey))
  const [template, setTemplate] = useState<GoalPlanningTemplate>(() =>
    readComposerDraft(storage.current, `${draftKey}:template`) === 'product-launch' ? 'product-launch' : 'auto')
  const input = useRef<HTMLTextAreaElement>(null)
  const changeObjective = (text: string): void => {
    setObjective(text)
    writeComposerDraft(storage.current, draftKey, text)
  }
  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (await state.start(projectId, objective, template)) changeObjective('')
  }
  return <>
    <form className="pws-goal-task-starter" onSubmit={(event) => void submit(event)} data-goal-task-starter>
      <label className="pws-visually-hidden" htmlFor={id}>{localized('你想完成什么？', 'What would you like to accomplish?')}</label>
      <textarea ref={input} id={id} className="input pws-textarea" name="objective" rows={2}
        value={objective} maxLength={20_000} placeholder={localized('你想完成什么？', 'What would you like to accomplish?')}
        disabled={state.busy} onChange={(event) => changeObjective(event.target.value)} data-goal-task-objective
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
            event.preventDefault()
            if (objective.trim() && !state.busy) event.currentTarget.form?.requestSubmit()
          }
        }} />
      <button type="submit" className="btn btn-primary" disabled={state.busy || !objective.trim()} data-goal-task-start>
        {state.busy ? TEXT.startingGoalTask : TEXT.startGoalTask}
      </button>
      {projectId && <details className="pws-goal-task-options" data-goal-task-options>
        <summary>{localized('高级选项', 'Advanced options')}</summary>
        <label>{localized('规划模板', 'Planning template')}
          <select className="input" aria-label={localized('规划模板', 'Planning template')} disabled={state.busy}
            value={template} onChange={(event) => {
              setTemplate(event.target.value as GoalPlanningTemplate)
              writeComposerDraft(storage.current, `${draftKey}:template`, event.target.value)
            }} data-goal-task-template>
            <option value="auto">{localized('自动规划', 'Automatic plan')}</option>
            <option value="product-launch">{localized('产品发布 · 四岗位', 'Product launch · four roles')}</option>
          </select>
        </label>
      </details>}
      {state.error && <div className="pws-goal-task-error" role="alert">
        <p>{state.error}</p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => useStore.getState().setShowSettings(true)}>
          {localized('连接与设置', 'Connections and settings')}
        </button>
      </div>}
      {state.announcement && <p className="pws-goal-task-success" role="status">{state.announcement}</p>}
    </form>
    {!projectId && <PersonalTaskRecoveryPanel refreshKey={state.busy} storageKey="caogen.work-inbox.personal-submission.v1" />}
    {state.planSessionId && state.planProjectId === (projectId ?? null) && <>
      <button type="button" className="btn btn-ghost btn-sm" data-goal-task-continue onClick={() => {
        if (!state.planSessionId) return
        useStore.getState().selectSession(state.planSessionId)
        useStore.getState().setExperienceMode('studio')
        useStore.getState().setStudioSurface('session')
        useStore.getState().setShowNewSession(false)
      }}>{localized('继续这个任务', 'Continue this task')}</button>
      <TaskPlanWorkbench sessionId={state.planSessionId} strategy="plan" running={false} />
    </>}
  </>
}
