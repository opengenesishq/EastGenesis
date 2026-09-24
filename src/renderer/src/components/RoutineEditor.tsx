import { useEffect, useState } from 'react'
import { PERMISSION_OPTIONS, useStore } from '../store'
import { useT } from '../i18n'
import { taskReasoningOptions } from '../../../shared/task-reasoning'
import { isRRuleSchedule, routineStartFromLocal, routineStartToLocal } from '../../../shared/routine-schedule'
import RoutineScheduleFields from './routines/RoutineScheduleFields'
import './routines/routine-editor.css'
import type {
  CreateRoutineInput,
  EngineInfo,
  EngineKind,
  Goal,
  Routine,
  RoutinePermissionMode,
  RoutineTemplate
} from '../../../shared/types'

interface Props {
  /** null / undefined = 新建;否则编辑该 Routine */
  routine?: Routine | null
  initialSessionId?: string
  onClose: () => void
}

/** Examples feed the same schedule calculation used by the main-process runtime. */
const CRON_EXAMPLES: Array<{ expr: string; label: string }> = [
  { expr: '0 9 * * *', label: 'routineExampleDaily' },
  { expr: '*/30 * * * *', label: 'routineExampleHalfHour' },
  { expr: '0 */2 * * *', label: 'routineExampleTwoHours' },
  { expr: '0 9 * * 1-5', label: 'routineExampleWeekdays' },
  { expr: '0 0 1 * *', label: 'routineExampleMonthly' },
  { expr: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0', label: 'routineExampleWeekdayRule' },
  { expr: 'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=5', label: 'routineExampleFiveRuns' }
]

export default function RoutineEditor({ routine = null, initialSessionId, onClose }: Props): React.JSX.Element {
  const t = useT()
  const providers = useStore((s) => s.providers)
  const projectWorkspaces = useStore((s) => s.projectWorkspaces)
  const preferredProjectWorkspaceId = useStore((s) => s.preferredProjectWorkspaceId)
  const refreshProjectWorkspaces = useStore((s) => s.refreshProjectWorkspaces)
  const sessions = useStore((s) => s.sessions)
  const zh = useStore((s) => s.settings.language === 'zh')
  const [continueSession, setContinueSession] = useState(Boolean(routine?.executionTarget || initialSessionId))
  const [targetSessionId, setTargetSessionId] = useState(routine?.executionTarget?.sessionId ?? initialSessionId ?? '')
  const targetSession = sessions[targetSessionId]?.meta

  const isEdit = routine !== null

  const [name, setName] = useState(routine?.name ?? '')
  const [prompt, setPrompt] = useState(routine?.prompt ?? '')
  const [projectId, setProjectId] = useState(routine?.projectId ?? preferredProjectWorkspaceId ?? '')
  const [goalTemplateId, setGoalTemplateId] = useState(routine?.goalTemplateId ?? '')
  const [goalTemplates, setGoalTemplates] = useState<Goal[]>([])
  const [projectCwd, setProjectCwd] = useState(routine?.projectCwd ?? '')
  const [schedule, setSchedule] = useState(routine?.schedule ?? '')
  const [timeZone, setTimeZone] = useState(routine?.timeZone ?? (routine ? '' : Intl.DateTimeFormat().resolvedOptions().timeZone))
  const [startLocal, setStartLocal] = useState(() => routineStartToLocal(routine?.startAt ?? (routine?.createdAt ?? Math.ceil((Date.now() + 1000) / 60000) * 60000), routine?.timeZone))
  const [providerId, setProviderId] = useState(routine?.providerId ?? '')
  const [model, setModel] = useState(routine?.model ?? '')
  const [reasoningEffort, setReasoningEffort] = useState(routine?.reasoningEffort)
  const [executionLocation, setExecutionLocation] = useState<'local' | 'worktree'>(routine?.executionLocation ?? 'local')
  const reasoningOptions = taskReasoningOptions(providers.find(item => item.id === providerId), model.trim())
  const [engine, setEngine] = useState<EngineKind | ''>(routine?.engine ?? '')
  const [engines, setEngines] = useState<EngineInfo[]>([])
  const [budgetUsd, setBudgetUsd] = useState(routine?.budgetUsd ? String(routine.budgetUsd) : '')
  const [permissionMode, setPermissionMode] = useState<RoutinePermissionMode>(
    routine?.permissionMode ?? 'default'
  )
  const [notificationEnabled, setNotificationEnabled] = useState(routine?.notification?.enabled ?? true)
  const [enabled, setEnabled] = useState(routine?.enabled ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [templates, setTemplates] = useState<RoutineTemplate[]>([])

  useEffect(() => {
    void window.agentDesk.listEngines().then(setEngines)
    void window.agentDesk.listRoutineTemplates().then(setTemplates).catch(() => undefined)
    void refreshProjectWorkspaces().catch(() => undefined)
  }, [providers, refreshProjectWorkspaces])

  useEffect(() => {
    if (!projectId) {
      setGoalTemplates([])
      setGoalTemplateId('')
      return
    }
    void window.agentDesk.listProjectGoals(projectId, { includeArchived: true }).then((goals) => {
      setGoalTemplates(goals)
      setGoalTemplateId((current) => goals.some((goal) => goal.id === current) ? current : '')
    }).catch(() => {
      setGoalTemplates([])
      setGoalTemplateId('')
    })
  }, [projectId])

  const browse = async (): Promise<void> => {
    const dir = await window.agentDesk.pickDirectory()
    if (dir) setProjectCwd(dir)
  }

  const applyCron = (expr: string): void => {
    if (expr) setSchedule(expr)
  }

  const applyTemplate = (templateId: string): void => {
    const template = templates.find((item) => item.id === templateId)
    if (!template) return
    if (!name.trim()) setName(template.name)
    setPrompt(template.content)
    setSchedule(template.frequency)
    setPermissionMode(template.permissionMode)
  }

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      setError(t('errNameRequired'))
      return
    }
    if (!prompt.trim()) {
      setError(t('routineErrPromptRequired'))
      return
    }
    if (continueSession && (!targetSession || targetSession.status === 'closed')) {
      setError(zh ? '原任务已关闭或不存在，请先恢复原任务。' : 'Restore the original task before scheduling a continuation.')
      return
    }
    if (!continueSession && !projectId && !projectCwd.trim()) {
      setError(t('routineErrCwdRequired'))
      return
    }
    if (!schedule.trim()) {
      setError(t('routineErrScheduleRequired'))
      return
    }

    setBusy(true)
    setError('')
    try {
      const startAt = isRRuleSchedule(schedule) ? routineStartFromLocal(startLocal, timeZone) : routine?.startAt
      const budget = Number(budgetUsd)
      const normalizedBudget = Number.isFinite(budget) && budget > 0 ? budget : 0
      if (isEdit && routine) {
        await window.agentDesk.updateRoutine(routine.id, {
          executionTarget: continueSession ? { kind: 'existing_session', sessionId: targetSessionId } : null,
          name: name.trim(),
          prompt: prompt.trim(),
          projectId: projectId || null,
          goalTemplateId: goalTemplateId || null,
          digitalWorkerId: null,
          projectCwd: projectCwd.trim(),
          schedule: schedule.trim(),
          timeZone,
          startAt,
          providerId: providerId.trim(),
          model: model.trim(),
          engine: engine || undefined,
          reasoningEffort: continueSession ? undefined : reasoningEffort,
          executionLocation: continueSession ? undefined : executionLocation,
          budgetUsd: normalizedBudget,
          permissionMode,
          content: prompt.trim(),
          frequency: schedule.trim(),
          notification: { enabled: notificationEnabled, onSuccess: true, onFailure: true },
          enabled
        })
      } else {
        const input: CreateRoutineInput = {
          executionTarget: continueSession ? { kind: 'existing_session', sessionId: targetSessionId } : undefined,
          name: name.trim(),
          prompt: prompt.trim(),
          content: prompt.trim(),
          projectId: projectId || undefined,
          goalTemplateId: goalTemplateId || undefined,
          projectCwd: projectCwd.trim(),
          schedule: schedule.trim(),
          timeZone,
          startAt,
          frequency: schedule.trim(),
          providerId: providerId.trim(),
          model: model.trim(),
          engine: engine || undefined,
          reasoningEffort: continueSession ? undefined : reasoningEffort,
          executionLocation: continueSession ? undefined : executionLocation,
          budgetUsd: normalizedBudget,
          permissionMode,
          notification: { enabled: notificationEnabled, onSuccess: true, onFailure: true },
          enabled
        }
        await window.agentDesk.createRoutine(input)
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop modal-backdrop-nested routine-editor-backdrop" onClick={onClose}>
      <div className="modal routine-editor-modal" role="dialog" aria-modal="true" aria-labelledby="routine-editor-title" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title" id="routine-editor-title">
          {isEdit ? t('routineEditTitle') : t('routineAddTitle')}
        </h2>

        <label className="field-label">{zh ? '执行方式' : 'Execution'}</label>
        <select className="select select-block" value={continueSession ? 'continue' : 'new'} onChange={(event) => setContinueSession(event.target.value === 'continue')}>
          <option value="continue">{zh ? '定时继续原任务' : 'Continue an existing task'}</option>
          <option value="new">{zh ? '每次创建新任务' : 'Create a new task for each run'}</option>
        </select>
        {continueSession && <>
          <label className="field-label">{zh ? '原任务' : 'Original task'}</label>
          <select className="select select-block" value={targetSessionId} onChange={(event) => setTargetSessionId(event.target.value)}>
            <option value="">{zh ? '选择任务' : 'Choose a task'}</option>
            {Object.values(sessions).filter((item) => item.meta.status !== 'closed').map(({ meta }) => <option key={meta.id} value={meta.id}>{meta.title || meta.id}</option>)}
          </select>
          <p className="field-hint">{zh ? '沿用原任务的模型路由、目录、预算和权限；正在执行时等待，不打断当前工作。' : 'Uses the task’s routing, directory, budget and permissions. Waits while the task is busy.'}</p>
          {targetSession && <p className="field-hint">{targetSession.cwd}</p>}
        </>}

        {!continueSession && !isEdit && templates.length > 0 && (
          <>
            <label className="field-label">{t('routineTemplateLabel')}</label>
            <select className="select select-block" defaultValue="" onChange={(e) => applyTemplate(e.target.value)}>
              <option value="" disabled>
                {t('routineTemplatePick')}
              </option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name} · {template.frequency}
                </option>
              ))}
            </select>
          </>
        )}

        <label className="field-label">{t('nameLabel')}</label>
        <input
          className="input input-block"
          value={name}
          placeholder={t('routineNamePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="field-label">{t('routinePromptLabel')}</label>
        <textarea
          className="input input-block textarea"
          value={prompt}
          rows={4}
          placeholder={t('routinePromptPlaceholder')}
          onChange={(e) => setPrompt(e.target.value)}
        />

        {!continueSession && <><label className="field-label">{t('routineProjectLabel')}</label>
        <select
          className="select select-block"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">{t('routineDirectoryOnly')}</option>
          {projectWorkspaces.filter((project) => project.status === 'active').map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>

        {projectId && goalTemplates.length > 0 && (
          <>
            <label className="field-label">{t('routineGoalTemplate')}</label>
            <select
              className="select select-block"
              value={goalTemplateId}
              onChange={(event) => setGoalTemplateId(event.target.value)}
            >
              <option value="">{t('routineNoRunGoal')}</option>
              {goalTemplates.map((goal) => (
                <option key={goal.id} value={goal.id}>{goal.title}</option>
              ))}
            </select>
          </>
        )}

        <label className="field-label">{t(projectId ? 'routineDirectoryOptional' : 'routineDirectoryLabel')}</label>
        <div className="field-row">
          <input
            className="input input-block"
            value={projectCwd}
            placeholder="/path/to/project"
            onChange={(e) => setProjectCwd(e.target.value)}
          />
          <button className="btn btn-ghost" onClick={() => void browse()}>
            {t('browse')}
          </button>
        </div>

        <label className="field-label">{zh ? '运行位置' : 'Run location'}</label>
        <select className="select select-block" value={executionLocation} onChange={event => setExecutionLocation(event.target.value as 'local' | 'worktree')}>
          <option value="local">{zh ? '本地目录' : 'Local directory'}</option>
          <option value="worktree">{zh ? '独立 Worktree（Git 项目）' : 'Isolated Worktree (Git project)'}</option>
        </select>
        <p className="field-hint">{zh ? 'Worktree 每次创建独立分支和目录；原目录须为已提交的 Git 项目，失败时会显示原因。' : 'Each Worktree run creates its own branch and directory. Requires a Git project with a commit; creation errors are shown.'}</p>
        </>}

        <div className="field-label-row routine-schedule-row">
          <label className="field-label">{t('routineScheduleLabel')}</label>
          <select
            className="select"
            aria-label={t('routineCronPick')}
            defaultValue=""
            onChange={(e) => applyCron(e.target.value)}
          >
            <option value="" disabled>
              {t('routineCronPick')}
            </option>
            {CRON_EXAMPLES.map((c) => (
              <option key={c.expr} value={c.expr}>
                {t(c.label)}
              </option>
            ))}
          </select>
        </div>
        <input
          className="input input-block"
          value={schedule}
          placeholder="0 9 * * *"
          onChange={(e) => setSchedule(e.target.value)}
        />
        <p className="field-hint">{zh ? '支持 every 30m、五段 cron 或一条 RRULE:FREQ=…；规则中的起点与时区在下方设置。' : 'Use every 30m, five-field cron, or a single RRULE:FREQ=…. Configure its start and time zone below.'}</p>
        <RoutineScheduleFields schedule={schedule} timeZone={timeZone} startLocal={startLocal} onTimeZone={setTimeZone} onStartLocal={setStartLocal} zh={zh} />

        {!continueSession && <details className="routine-advanced-settings">
          <summary>{t('routineAdvanced')}</summary>
          <label className="field-label">{t('providerLabel')}</label>
          <select
            className="select select-block"
            value={providerId}
            onChange={(e) => { setProviderId(e.target.value); setReasoningEffort(undefined) }}
          >
            <option value="">{t('noDefaultProvider')}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.ready}>
                {p.name}
                {p.ready ? '' : ` (${t('noKeyConfigured')})`}
              </option>
            ))}
          </select>

          <label className="field-label">{t('model')}</label>
          <input
            className="input input-block"
            value={model}
            placeholder={t('selectModelPlaceholder')}
            onChange={(e) => { setModel(e.target.value); setReasoningEffort(undefined) }}
          />

          <label className="field-label">{zh ? '此计划的推理强度' : 'Reasoning for this schedule'}</label>
          <select className="select select-block" value={reasoningEffort ?? ''} disabled={!reasoningOptions.length} onChange={event => setReasoningEffort(event.target.value as Routine['reasoningEffort'] || undefined)}>
            <option value="">{zh ? '跟随模型配置' : 'Use model configuration'}</option>
            {reasoningOptions.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
          {!reasoningOptions.length && <p className="field-hint">{zh ? '选择已声明推理能力或已配置推理档位的模型后可独立选择。其他模型沿用设置中的思考配置。' : 'Independent levels require a model that declares reasoning support or has a configured reasoning level. Other models retain their thinking settings.'}</p>}

          {engines.length > 1 && (
            <>
              <label className="field-label">{t('engineLabel')}</label>
              <select
                className="select select-block"
                value={engine}
                onChange={(e) => setEngine(e.target.value as EngineKind | '')}
              >
                <option value="">{t('routineEngineDefault')}</option>
                {engines.map((en) => (
                  <option key={en.kind} value={en.kind} disabled={!en.available || (en.optional && !en.configured)}>
                    {en.label}
                    {en.optional ? ` (${t(en.configured ? 'optionalEngine' : 'optionalEngineNotConfigured')})` : ''}
                  </option>
                ))}
              </select>
            </>
          )}

          <label className="field-label">{t('routineBudgetLabel')}</label>
          <input
            className="input input-block"
            type="number"
            min="0"
            step="0.01"
            value={budgetUsd}
            placeholder="0"
            onChange={(e) => setBudgetUsd(e.target.value)}
          />
          <p className="field-hint">{t('routineBudgetHint')}</p>

          <label className="field-label">{t('permissionMode')}</label>
          <select
            className="select select-block"
            value={permissionMode}
            onChange={(e) => setPermissionMode(e.target.value as RoutinePermissionMode)}
          >
            {PERMISSION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.value === 'default' ? 'routinePermissionDefault' : o.value === 'acceptEdits' ? 'routinePermissionEdits' : o.value === 'plan' ? 'routinePermissionPlan' : 'routinePermissionBypass')}
              </option>
            ))}
          </select>
        </details>}

        <label className="settings-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t('routineEnabledLabel')}
        </label>

        <label className="settings-check">
          <input
            type="checkbox"
            checked={notificationEnabled}
            onChange={(e) => setNotificationEnabled(e.target.checked)}
          />
          {t('routineNotify')}
        </label>

        {error && <div className="notice notice-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? t('saving') : t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}
