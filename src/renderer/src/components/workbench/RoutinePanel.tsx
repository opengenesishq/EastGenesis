import { useEffect, useState, type ReactNode } from 'react'
import type { RoutineRunRecord } from '../../../../shared/types'
import RoutineRunInbox from './RoutineRunInbox'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import '../routines/routine-editor.css'

export type RoutinePanelRunState = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed'
export type RoutinePanelTimestamp = Date | number | string | null | undefined

export interface RoutinePanelItem {
  executionTarget?: { kind: 'existing_session'; sessionId: string }
  id: string
  name: string
  schedule: string
  timeZone?: string
  scheduleState?: 'active' | 'exhausted' | 'invalid'
  scheduleError?: string
  enabled: boolean
  prompt?: string
  projectId?: string
  projectCwd?: string
  providerId?: string
  model?: string
  nextRunAt?: RoutinePanelTimestamp
  lastRunAt?: RoutinePanelTimestamp
  lastError?: string | null
  runState?: RoutinePanelRunState
  runDisabled?: boolean
  toggleDisabled?: boolean
  disabledReason?: string
}

export interface RoutinePanelEmptyState {
  title?: ReactNode
  message?: ReactNode
}

export interface RoutinePanelProps {
  onOpenSession?: (id: string) => void
  routines: readonly RoutinePanelItem[]
  className?: string
  title?: ReactNode
  subtitle?: ReactNode
  loading?: boolean
  disabled?: boolean
  error?: ReactNode
  message?: ReactNode
  runs?: readonly RoutineRunRecord[]
  selectedRoutineId?: string | null
  now?: RoutinePanelTimestamp
  showCloudSchedulingNote?: boolean
  cloudSchedulingNote?: ReactNode
  emptyState?: RoutinePanelEmptyState
  onAddRoutine?: () => void
  onRefresh?: (quiet?: boolean) => void | Promise<void>
  onClose?: () => void
  onDeleteRoutine?: (routine: RoutinePanelItem) => void
  onEditRoutine?: (routine: RoutinePanelItem) => void
  onSelectRoutine?: (routine: RoutinePanelItem) => void
  onSelectAllRoutines?: () => void
  onToggleRoutine?: (routine: RoutinePanelItem, enabled: boolean) => void
  onRunRoutine?: (routine: RoutinePanelItem) => void
}

interface TimeDisplay {
  primary: string
  secondary: string
  title?: string
}

function toDate(value: RoutinePanelTimestamp): Date | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }

  const trimmed = value.trim()
  if (!trimmed) return null
  const numeric = Number(trimmed)
  const date = Number.isFinite(numeric) && /^\d+$/.test(trimmed) ? new Date(numeric) : new Date(trimmed)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatAbsolute(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function formatFull(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date)
}

function formatRelative(date: Date, base: Date, zh: boolean): string {
  const diffMs = date.getTime() - base.getTime()
  const absMs = Math.abs(diffMs)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (absMs < minute) return diffMs >= 0 ? zh ? '1 分钟内' : 'Within a minute' : zh ? '刚刚' : 'Just now'
  if (absMs < hour) {
    const minutes = Math.ceil(absMs / minute)
    return diffMs >= 0 ? zh ? `${minutes} 分钟后` : `In ${minutes} minutes` : zh ? `${minutes} 分钟前` : `${minutes} minutes ago`
  }
  if (absMs < day) {
    const hours = Math.ceil(absMs / hour)
    return diffMs >= 0 ? zh ? `${hours} 小时后` : `In ${hours} hours` : zh ? `${hours} 小时前` : `${hours} hours ago`
  }

  const days = Math.ceil(absMs / day)
  return diffMs >= 0 ? zh ? `${days} 天后` : `In ${days} days` : zh ? `${days} 天前` : `${days} days ago`
}

function nextRunDisplay(routine: RoutinePanelItem, now: Date, zh: boolean): TimeDisplay {
  if (routine.scheduleState === 'exhausted') return { primary: zh ? '排期已结束' : 'Schedule ended', secondary: zh ? '次数或截止时间已用尽' : 'Run count or end date reached' }
  if (routine.scheduleState === 'invalid') return { primary: zh ? '排期需修正' : 'Schedule needs editing', secondary: routine.scheduleError ?? (zh ? '请编辑时间规则' : 'Edit the schedule rule') }
  if (!routine.enabled) {
    return {
      primary: zh ? '已停用' : 'Disabled',
      secondary: zh ? '启用后恢复定时' : 'Enable to resume scheduling'
    }
  }

  const nextRun = toDate(routine.nextRunAt)
  if (!nextRun) {
    return {
      primary: zh ? '未安排' : 'Not scheduled',
      secondary: zh ? '暂无本地下次运行' : 'No next local run'
    }
  }

  return {
    primary: formatRelative(nextRun, now, zh),
    secondary: routine.timeZone ? formatInZone(nextRun, routine.timeZone) : formatAbsolute(nextRun),
    title: routine.timeZone ? formatInZone(nextRun, routine.timeZone) : formatFull(nextRun)
  }
}

function formatInZone(date: Date, timeZone: string): string {
  try { return `${new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: 'medium', timeStyle: 'long' }).format(date)} · ${timeZone}` }
  catch { return formatFull(date) }
}

function lastRunDisplay(routine: RoutinePanelItem, now: Date, zh: boolean): TimeDisplay {
  const lastRun = toDate(routine.lastRunAt)
  if (!lastRun) {
    return {
      primary: zh ? '从未运行' : 'Never run',
      secondary: zh ? '暂无运行记录' : 'No run records'
    }
  }

  return {
    primary: formatRelative(lastRun, now, zh),
    secondary: formatAbsolute(lastRun),
    title: formatFull(lastRun)
  }
}

function visualState(routine: RoutinePanelItem): string {
  if (routine.scheduleState === 'invalid') return 'failed'
  if (routine.lastError || routine.runState === 'failed') return 'failed'
  if (routine.runState === 'running') return 'running'
  if (routine.runState === 'queued') return 'queued'
  if (routine.scheduleState === 'exhausted') return 'exhausted'
  if (!routine.enabled) return 'paused'
  if (routine.runState === 'succeeded') return 'succeeded'
  return 'active'
}

function projectBindingUnavailable(routine: RoutinePanelItem): boolean {
  return Boolean(routine.lastError && /Routine Project (?:does not exist|is not active):|项目不存在|项目已停用|关联项目已失效/i.test(routine.lastError))
}

function stateLabel(state: string, zh: boolean): string {
  if (!zh) return ({ exhausted: 'Ended', failed: 'Failed', running: 'Running', queued: 'Queued', paused: 'Disabled', succeeded: 'Succeeded' } as Record<string, string>)[state] ?? 'Enabled'
  switch (state) {
    case 'exhausted':
      return '排期已结束'
    case 'failed':
      return '失败'
    case 'running':
      return '运行中'
    case 'queued':
      return '排队中'
    case 'paused':
      return '已停用'
    case 'succeeded':
      return '已成功'
    default:
      return '已启用'
  }
}

function RoutineMain({
  children,
  onSelect,
  routine
}: {
  children: ReactNode
  onSelect?: (routine: RoutinePanelItem) => void
  routine: RoutinePanelItem
}): React.JSX.Element {
  if (!onSelect) return <div className="routine-panel-main">{children}</div>
  return (
    <button className="routine-panel-main routine-panel-main-button" type="button" onClick={() => onSelect(routine)}>
      {children}
    </button>
  )
}

function RoutineRow({
  disabled,
  now,
  onDeleteRoutine,
  onEditRoutine,
  onRunRoutine,
  onSelectRoutine,
  onToggleRoutine,
  routine,
  selected
}: {
  disabled: boolean
  now: Date
  onDeleteRoutine?: (routine: RoutinePanelItem) => void
  onEditRoutine?: (routine: RoutinePanelItem) => void
  onRunRoutine?: (routine: RoutinePanelItem) => void
  onSelectRoutine?: (routine: RoutinePanelItem) => void
  onToggleRoutine?: (routine: RoutinePanelItem, enabled: boolean) => void
  routine: RoutinePanelItem
  selected: boolean
}): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const state = visualState(routine)
  const bindingUnavailable = projectBindingUnavailable(routine)
  const nextRun = nextRunDisplay(routine, now, zh)
  const lastRun = lastRunDisplay(routine, now, zh)
  const running = routine.runState === 'running'
  const queued = routine.runState === 'queued'
  const runDisabled = disabled || bindingUnavailable || Boolean(routine.runDisabled) || running || queued || !onRunRoutine
  const toggleDisabled = disabled || Boolean(routine.toggleDisabled) || !onToggleRoutine
  const modelLabel = [routine.providerId, routine.model].filter(Boolean).join(' / ')

  return (
    <article
      role="listitem"
      className={[
        'routine-panel-item',
        `routine-panel-item-${state}`,
        selected ? 'routine-panel-item-selected' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <RoutineMain routine={routine} onSelect={onSelectRoutine}>
        <div className="routine-panel-item-top">
          <div className="routine-panel-title-row">
            <h3 className="routine-panel-name">{routine.name}</h3>
            <span className={`routine-panel-status routine-panel-status-${state}`}>{bindingUnavailable ? zh ? '需修复' : 'Needs repair' : stateLabel(state, zh)}</span>
          </div>
          <div className="routine-panel-schedule" title={routine.schedule}>
            {routine.schedule}
            {routine.timeZone && <span> · {routine.timeZone}</span>}
          </div>
        </div>

        <div className="routine-panel-metrics">
          <div className="routine-panel-metric" title={nextRun.title}>
            <span className="routine-panel-metric-label">{zh ? '下次运行' : 'Next run'}</span>
            <strong className="routine-panel-metric-value">{nextRun.primary}</strong>
            <span className="routine-panel-metric-sub">{nextRun.secondary}</span>
          </div>
          <div className="routine-panel-metric" title={lastRun.title}>
            <span className="routine-panel-metric-label">{zh ? '上次运行' : 'Last run'}</span>
            <strong className="routine-panel-metric-value">{lastRun.primary}</strong>
            <span className="routine-panel-metric-sub">{lastRun.secondary}</span>
          </div>
        </div>

        {(routine.projectId || routine.projectCwd || modelLabel || routine.prompt) && (
          <div className="routine-panel-meta">
            {routine.executionTarget && <span className="routine-panel-model">{zh ? '继续原任务' : 'Continue original task'}</span>}
            {routine.projectId && <span className="routine-panel-model">{zh ? '项目任务' : 'Project task'}</span>}
            {routine.projectCwd && (
              <span className="routine-panel-path" title={routine.projectCwd}>
                {routine.projectCwd}
              </span>
            )}
            {modelLabel && <span className="routine-panel-model">{modelLabel}</span>}
            {routine.prompt && (
              <span className="routine-panel-prompt" title={routine.prompt}>
                {routine.prompt}
              </span>
            )}
          </div>
        )}

        {(routine.lastError || state === 'failed') && (
          <div className="routine-panel-error">{routine.lastError || (zh ? '上次运行失败。' : 'The last run failed.')}</div>
        )}
      </RoutineMain>

      <div className="routine-panel-actions">
        <label className="routine-panel-switch" title={routine.disabledReason}>
          <input
            className="routine-panel-switch-input"
            type="checkbox"
            checked={routine.enabled}
            disabled={toggleDisabled}
            aria-label={zh ? `${routine.name} 启停` : `Enable ${routine.name}`}
            onChange={(event) => onToggleRoutine?.(routine, event.currentTarget.checked)}
          />
          <span className="routine-panel-switch-track" aria-hidden="true">
            <span className="routine-panel-switch-thumb" />
          </span>
          <span className="routine-panel-switch-label">{routine.enabled ? zh ? '开' : 'On' : zh ? '关' : 'Off'}</span>
        </label>
        <button
          className="routine-panel-run"
          type="button"
          disabled={runDisabled}
          title={bindingUnavailable ? (zh ? '项目已失效，请编辑计划重新绑定项目。' : 'The project is unavailable. Edit this schedule to bind a project again.') : routine.disabledReason}
          onClick={() => onRunRoutine?.(routine)}
        >
          {running ? zh ? '运行中' : 'Running' : queued ? zh ? '排队中' : 'Queued' : zh ? '立即运行' : 'Run now'}
        </button>
        <div className="routine-panel-row-buttons">
          <button
            className="routine-panel-secondary"
            type="button"
            disabled={disabled || !onEditRoutine}
            onClick={() => onEditRoutine?.(routine)}
          >
            {zh ? '编辑' : 'Edit'}
          </button>
          <button
            className="routine-panel-secondary routine-panel-secondary-danger"
            type="button"
            disabled={disabled || !onDeleteRoutine}
            onClick={() => onDeleteRoutine?.(routine)}
          >
            {zh ? '删除' : 'Delete'}
          </button>
        </div>
      </div>
    </article>
  )
}

export default function RoutinePanel({
  className,
  cloudSchedulingNote,
  disabled = false,
  emptyState,
  error,
  loading = false,
  message,
  now,
  onAddRoutine,
  onClose,
  onDeleteRoutine,
  onEditRoutine,
  onRefresh,
  onRunRoutine,
  onOpenSession,
  onSelectRoutine,
  onSelectAllRoutines,
  onToggleRoutine,
  runs = [],
  routines,
  selectedRoutineId,
  showCloudSchedulingNote = true,
  subtitle,
  title
}: RoutinePanelProps): React.JSX.Element {
  const t = useT(), zh = useStore(state => state.settings.language === 'zh')
  const [planStatus, setPlanStatus] = useState('all')
  const [planQuery, setPlanQuery] = useState('')
  const [planProject, setPlanProject] = useState('')
  const hasActivePlans = routines.some((item) => item.enabled) || runs.some((item) => item.status === 'running' || item.status === 'queued')
  useEffect(() => {
    if (!onRefresh || !hasActivePlans) return
    let pending = false
    const timer = window.setInterval(() => {
      if (pending || document.visibilityState === 'hidden') return
      pending = true
      void Promise.resolve(onRefresh(true)).finally(() => { pending = false }).catch(() => undefined)
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [onRefresh, hasActivePlans])
  const nowDate = toDate(now) ?? new Date()
  const selectedRoutine = selectedRoutineId ? routines.find(item => item.id === selectedRoutineId) : undefined
  const staleRoutine = selectedRoutine ?? routines.find(item => runs.some(run => run.routineId === item.id && projectBindingUnavailable({ ...item, lastError: run.error ?? item.lastError })))
  const inboxRoutine = selectedRoutine ?? staleRoutine
  const rootClassName = ['routine-panel', className].filter(Boolean).join(' ')
  const visiblePlans = routines.filter(routine =>
    (planStatus === 'all' || planStatus === 'enabled' && routine.enabled || planStatus === 'paused' && !routine.enabled || planStatus === 'problem' && (routine.lastError || routine.runState === 'failed')) &&
    (!planProject || routine.projectId === planProject) && (!planQuery.trim() || [routine.name, routine.prompt, routine.projectCwd].some(value => value?.toLocaleLowerCase().includes(planQuery.trim().toLocaleLowerCase()))))
  const planProjects = [...new Map(routines.filter(routine => routine.projectId).map(routine => [routine.projectId!, routine.projectCwd || routine.projectId!])).entries()]

  return (
    <section className={rootClassName}>
      <header className="routine-panel-header">
        <div className="routine-panel-heading">
          <h2 className="routine-panel-title">{title ?? t('routinePanelTitle')}</h2>
          <div className="routine-panel-subtitle">{subtitle ?? t('routinePanelSubtitle')}</div>
        </div>
        <div className="routine-panel-header-actions">
          <div className="routine-panel-count">{loading ? zh ? '加载中' : 'Loading' : zh ? `${routines.length} 个` : `${routines.length}`}</div>
          {onAddRoutine && (
            <button className="btn btn-primary btn-sm" disabled={loading} onClick={onAddRoutine}>
              {zh ? '新建' : 'New'}
            </button>
          )}
          {onRefresh && (
            <button className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void onRefresh()}>
              {zh ? '刷新' : 'Refresh'}
            </button>
          )}
          {onClose && (
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              {zh ? '关闭' : 'Close'}
            </button>
          )}
        </div>
      </header>

      {error && <div className="notice notice-error routine-panel-notice">{error}</div>}
      {message && <div className="notice notice-info routine-panel-notice">{message}</div>}
      {showCloudSchedulingNote && <div className="routine-panel-cloud-note">{cloudSchedulingNote ?? t('routinePanelNote')}</div>}

      <div className="routine-plan-filters">
        {onSelectAllRoutines && <button type="button" className={`btn btn-sm ${!selectedRoutineId ? 'btn-primary' : 'btn-ghost'}`} onClick={onSelectAllRoutines}>{zh ? '全部计划' : 'All schedules'}</button>}
        <input aria-label={zh ? '搜索计划任务' : 'Search scheduled tasks'} value={planQuery} placeholder={zh ? '搜索计划' : 'Search schedules'} onChange={event => setPlanQuery(event.target.value)} />
        <select aria-label={zh ? '计划任务状态' : 'Schedule status'} value={planStatus} onChange={event => setPlanStatus(event.target.value)}><option value="all">{zh ? '全部状态' : 'All statuses'}</option><option value="enabled">{zh ? '已启用' : 'Enabled'}</option><option value="paused">{zh ? '已停用' : 'Disabled'}</option><option value="problem">{zh ? '有异常' : 'Needs attention'}</option></select>
        <select aria-label={zh ? '计划任务项目' : 'Schedule project'} value={planProject} onChange={event => setPlanProject(event.target.value)}><option value="">{zh ? '全部项目' : 'All projects'}</option>{planProjects.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
      </div>

      <div className="routine-panel-list" role="list">
        {loading && routines.length === 0 ? (
          <div className="routine-panel-empty">{zh ? '正在加载计划任务…' : 'Loading scheduled tasks…'}</div>
        ) : routines.length === 0 ? (
          <div className="routine-panel-empty">
            <strong>{emptyState?.title ?? t('routineEmptyTitle')}</strong>
            <span>{emptyState?.message ?? t('routineEmptyMessage')}</span>
          </div>
        ) : (
          visiblePlans.map((routine) => (
            <RoutineRow
              key={routine.id}
              disabled={disabled}
              now={nowDate}
              onDeleteRoutine={onDeleteRoutine}
              onEditRoutine={onEditRoutine}
              onRunRoutine={onRunRoutine}
              onSelectRoutine={onSelectRoutine}
              onToggleRoutine={onToggleRoutine}
              routine={routine}
              selected={selectedRoutineId === routine.id}
            />
          ))
        )}
      </div>
      {routines.length > 0 && visiblePlans.length === 0 && <p className="routine-panel-empty">{zh ? '当前筛选下没有计划任务。' : 'No scheduled tasks match the current filters.'}</p>}
      <RoutineRunInbox
        routineId={selectedRoutineId}
        refreshKey={runs}
        onOpenSession={onOpenSession}
        onRepairRoutine={inboxRoutine && onEditRoutine ? () => onEditRoutine(inboxRoutine) : undefined}
        onDeleteRoutine={inboxRoutine && onDeleteRoutine ? () => onDeleteRoutine(inboxRoutine) : undefined}
      />
    </section>
  )
}
