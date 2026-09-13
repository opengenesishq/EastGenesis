import { useEffect, useState } from 'react'
import { PERMISSION_OPTIONS, useStore } from '../store'
import { useT } from '../i18n'
import type {
  CreateRoutineInput,
  DigitalWorker,
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
  onClose: () => void
}

/** cron 速查:主控接入真实执行器前仅作输入提示,不做严格校验 */
const CRON_EXAMPLES: Array<{ expr: string; desc: string }> = [
  { expr: '0 9 * * *', desc: '每天 09:00' },
  { expr: '*/30 * * * *', desc: '每 30 分钟' },
  { expr: '0 */2 * * *', desc: '每 2 小时' },
  { expr: '0 9 * * 1-5', desc: '工作日 09:00' },
  { expr: '0 0 1 * *', desc: '每月 1 号 00:00' }
]

export default function RoutineEditor({ routine = null, onClose }: Props): React.JSX.Element {
  const t = useT()
  const providers = useStore((s) => s.providers)
  const projectWorkspaces = useStore((s) => s.projectWorkspaces)
  const preferredProjectWorkspaceId = useStore((s) => s.preferredProjectWorkspaceId)
  const refreshProjectWorkspaces = useStore((s) => s.refreshProjectWorkspaces)

  const isEdit = routine !== null

  const [name, setName] = useState(routine?.name ?? '')
  const [prompt, setPrompt] = useState(routine?.prompt ?? '')
  const [projectId, setProjectId] = useState(routine?.projectId ?? preferredProjectWorkspaceId ?? '')
  const [digitalWorkerId, setDigitalWorkerId] = useState(routine?.digitalWorkerId ?? '')
  const [goalTemplateId, setGoalTemplateId] = useState(routine?.goalTemplateId ?? '')
  const [digitalWorkers, setDigitalWorkers] = useState<DigitalWorker[]>([])
  const [goalTemplates, setGoalTemplates] = useState<Goal[]>([])
  const [projectCwd, setProjectCwd] = useState(routine?.projectCwd ?? '')
  const [schedule, setSchedule] = useState(routine?.schedule ?? '')
  const [providerId, setProviderId] = useState(routine?.providerId ?? '')
  const [model, setModel] = useState(routine?.model ?? '')
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
      setDigitalWorkers([])
      setGoalTemplates([])
      setDigitalWorkerId('')
      setGoalTemplateId('')
      return
    }
    void Promise.all([
      window.agentDesk.listDigitalWorkers({ projectId, status: 'active' }),
      window.agentDesk.listProjectGoals(projectId, { includeArchived: true })
    ]).then(([workers, goals]) => {
      setDigitalWorkers(workers)
      setGoalTemplates(goals)
      setDigitalWorkerId((current) => workers.some((worker) => worker.id === current) ? current : '')
      setGoalTemplateId((current) => goals.some((goal) => goal.id === current) ? current : '')
    }).catch(() => {
      setDigitalWorkers([])
      setGoalTemplates([])
      setDigitalWorkerId('')
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
    if (!projectId && !projectCwd.trim()) {
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
      const budget = Number(budgetUsd)
      const normalizedBudget = Number.isFinite(budget) && budget > 0 ? budget : 0
      if (isEdit && routine) {
        await window.agentDesk.updateRoutine(routine.id, {
          name: name.trim(),
          prompt: prompt.trim(),
          projectId: projectId || null,
          goalTemplateId: goalTemplateId || null,
          digitalWorkerId: digitalWorkerId || null,
          projectCwd: projectCwd.trim(),
          schedule: schedule.trim(),
          providerId: providerId.trim(),
          model: model.trim(),
          engine: engine || undefined,
          budgetUsd: normalizedBudget,
          permissionMode,
          content: prompt.trim(),
          frequency: schedule.trim(),
          notification: { enabled: notificationEnabled, onSuccess: true, onFailure: true },
          enabled
        })
      } else {
        const input: CreateRoutineInput = {
          name: name.trim(),
          prompt: prompt.trim(),
          content: prompt.trim(),
          projectId: projectId || undefined,
          goalTemplateId: goalTemplateId || undefined,
          digitalWorkerId: digitalWorkerId || undefined,
          projectCwd: projectCwd.trim(),
          schedule: schedule.trim(),
          frequency: schedule.trim(),
          providerId: providerId.trim(),
          model: model.trim(),
          engine: engine || undefined,
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
    <div className="modal-backdrop modal-backdrop-nested" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">
          {isEdit ? t('routineEditTitle') : t('routineAddTitle')}
        </h2>

        {!isEdit && templates.length > 0 && (
          <>
            <label className="field-label">Routine 模板</label>
            <select className="select select-block" defaultValue="" onChange={(e) => applyTemplate(e.target.value)}>
              <option value="" disabled>
                选择模板
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

        <label className="field-label">归属项目</label>
        <select
          className="select select-block"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">仅使用执行目录</option>
          {projectWorkspaces.filter((project) => project.status === 'active').map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>

        {projectId && digitalWorkers.length > 0 && (
          <>
            <label className="field-label">执行员工</label>
            <select
              className="select select-block"
              value={digitalWorkerId}
              onChange={(event) => setDigitalWorkerId(event.target.value)}
            >
              <option value="">项目负责人</option>
              {digitalWorkers.map((worker) => (
                <option key={worker.id} value={worker.id}>{worker.displayName}</option>
              ))}
            </select>
          </>
        )}

        {projectId && goalTemplates.length > 0 && (
          <>
            <label className="field-label">目标契约模板</label>
            <select
              className="select select-block"
              value={goalTemplateId}
              onChange={(event) => setGoalTemplateId(event.target.value)}
            >
              <option value="">不创建每次运行目标</option>
              {goalTemplates.map((goal) => (
                <option key={goal.id} value={goal.id}>{goal.title}</option>
              ))}
            </select>
          </>
        )}

        <label className="field-label">执行目录{projectId ? '（可选）' : ''}</label>
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

        <div className="field-label-row">
          <label className="field-label">{t('routineScheduleLabel')}</label>
          <select
            className="select"
            defaultValue=""
            onChange={(e) => applyCron(e.target.value)}
          >
            <option value="" disabled>
              {t('routineCronPick')}
            </option>
            {CRON_EXAMPLES.map((c) => (
              <option key={c.expr} value={c.expr}>
                {c.expr} — {c.desc}
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
        <p className="field-hint">{t('routineCronHint')}</p>

        <details className="routine-advanced-settings">
          <summary>高级设置</summary>
          <label className="field-label">{t('providerLabel')}</label>
          <select
            className="select select-block"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
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
            onChange={(e) => setModel(e.target.value)}
          />

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
                {o.label}
              </option>
            ))}
          </select>
        </details>

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
          执行完成后发送通知
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
