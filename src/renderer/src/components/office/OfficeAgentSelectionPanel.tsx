import type { SchedulerStrategy } from '../../../../shared/types'
import type { SessionState } from '../../store'
import { useT } from '../../i18n'
import type { OfficeSessionActivity, OfficeSessionModel, OfficeSessionSignal } from './model'
import OfficeFailoverSignals from './OfficeFailoverSignals'
import type { WatercolorCharacterRole } from '../../../../shared/watercolor-character'
import OfficeSessionActions from './OfficeSessionActions'

const ACTIVITY_LABEL_KEYS: Record<OfficeSessionActivity, string> = {
  idle: 'officeStatusIdle',
  working: 'activityWorking',
  awaiting: 'activityAwaiting',
  completed: 'officeStatusCompleted',
  error: 'activityError'
}

const ROLE_LABEL_KEYS: Record<WatercolorCharacterRole, string> = {
  researcher: 'officeRoleResearcher',
  planner: 'officeRolePlanner',
  writer: 'officeRoleWriter',
  designer: 'officeRoleDesigner',
  developer: 'officeRoleDeveloper',
  'review-test': 'officeRoleReviewTest',
  operations: 'officeRoleOperations'
}

function routingStrategyKey(strategy: SchedulerStrategy): string {
  if (strategy === 'quality') return 'routingStrategyQuality'
  if (strategy === 'cost') return 'routingStrategyCost'
  if (strategy === 'speed') return 'routingStrategySpeed'
  return 'routingStrategyBalanced'
}

function moneyShort(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0'
  return `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`
}

function durationShort(value: number | undefined): string {
  if (!value || !Number.isFinite(value) || value <= 0) return '0s'
  if (value < 60_000) return `${Math.max(1, Math.round(value / 1000))}s`
  return `${Math.round(value / 60_000)}m`
}

function workspaceChangeShort(signal: OfficeSessionSignal['workspace']): string {
  if (signal.gitOk === false) return 'git error'
  if (signal.gitOk === true) {
    if (signal.changedFiles <= 0) return 'clean'
    return `${signal.changedFiles} · S${signal.gitStaged ?? 0}/U${signal.gitUnstaged ?? 0}/?${signal.gitUntracked ?? 0}`
  }
  if (signal.changedFiles <= 0) return '0'
  return `${signal.changedFiles} · +${signal.insertions}/-${signal.deletions}`
}

function openTargetKind(
  session: SessionState,
  activity: OfficeSessionActivity,
  model: OfficeSessionModel | undefined
): 'approval' | 'failure' | 'task' | 'session' {
  if (session.pendingPermissions.length > 0) return 'approval'
  if (activity === 'error') return 'failure'
  return model?.currentTask ? 'task' : 'session'
}

export default function OfficeAgentSelectionPanel({
  activity,
  model,
  openButton,
  session,
  signal,
  role,
  providerName,
  onOpenResults
}: {
  activity: OfficeSessionActivity
  model?: OfficeSessionModel
  openButton: React.JSX.Element
  session: SessionState
  signal?: OfficeSessionSignal
  role?: WatercolorCharacterRole
  providerName?: string
  onOpenResults?: () => void
}): React.JSX.Element {
  const t = useT()
  const targetKind = openTargetKind(session, activity, model)
  const roleLabel = role ? t(ROLE_LABEL_KEYS[role]) : session.meta.childRole || t('officeRoleAgent')
  const roleMarkerDescription = t('officeRoleAccentTitle')
  const providerLabel = providerName || signal?.routing?.providerName || session.meta.providerId || '-'
  const modelLabel = signal?.routing?.model || session.meta.model || '-'
  return (
    <div className="office-selection-panel no-drag" role="complementary" aria-label={t('officeSelectedAgent')} data-office-selection-panel={session.meta.id}
      data-office-open-target-kind={targetKind} data-office-current-task-id={model?.currentTask?.id ?? ''}>
      <div className="office-selection-kicker">{t('officeSelectedAgent')}</div>
      <div className="office-selection-title">{session.meta.title}</div>
      <div className="office-selection-meta"><span>{t(ACTIVITY_LABEL_KEYS[activity])}</span><span>{modelLabel}</span></div>
      <div
        className="office-selection-meta office-selection-identity"
        data-office-agent-role={role ?? 'agent'}
        data-office-role-marker={role ?? 'agent'}
        data-office-role-marker-description={roleMarkerDescription}
        role="group"
        aria-label={`${t('officeRole')}: ${roleLabel}. ${roleMarkerDescription}`}
        title={roleMarkerDescription}
      >
        <span>{t('officeRole')}</span>
        <span className="office-role-accent-marker" aria-hidden="true" title={roleMarkerDescription} />
        <strong aria-label={`${t('officeRole')}: ${roleLabel}`} title={roleMarkerDescription}>{roleLabel}</strong>
      </div>
      <div className="office-selection-meta office-selection-identity" data-office-agent-provider={providerLabel}>
        <span>{t('provider')}</span>
        <strong title={providerLabel}>{providerLabel}</strong>
      </div>
      <div className="office-selection-meta office-selection-identity" data-office-agent-model={modelLabel}>
        <span>{t('model')}</span>
        <strong title={modelLabel}>{modelLabel}</strong>
      </div>
      {model?.currentTask && (
        <div className="office-selection-meta" data-office-current-task={model.currentTask.id}>
          <span>{model.currentTask.title}</span><span>{model.currentTask.status}</span>
        </div>
      )}
      {signal && <OfficeSignalDetails signal={signal} />}
      <OfficeSessionActions key={session.meta.id} session={session} onOpenResults={onOpenResults} />
      {openButton}
    </div>
  )
}

function OfficeSignalDetails({ signal }: { signal: OfficeSessionSignal }): React.JSX.Element {
  const t = useT()
  return (
    <div className="office-signal-list">
      {signal.routing && <>
        <div><span>{t('officeRouting')}</span><strong title={signal.routing.reason}>
          {signal.routing.providerName ?? signal.routing.providerId} / {signal.routing.model}
        </strong></div>
        <div><span>{t('officeRoutingBasis')}</span><strong title={signal.routing.reason}>
          {signal.routing.basis ?? signal.routing.reason}
        </strong></div>
        {signal.routing.strategy && <div><span>{t('routingStrategy')}</span>
          <strong>{t(routingStrategyKey(signal.routing.strategy))}</strong></div>}
      </>}
      <OfficeFailoverSignals signal={signal} />
      <div><span>{t('officeBudget')}</span><strong>{moneyShort(signal.budget.costUsd)}
        {signal.budget.budgetUsd ? ` / ${moneyShort(signal.budget.budgetUsd)}` : ''}</strong></div>
      <div><span>{t('officeDuration')}</span><strong>{durationShort(signal.budget.latestDurationMs)}</strong></div>
      <div><span>{t('officeWorkspace')}</span><strong>
        {signal.workspace.gitOk === false ? 'git error' : signal.workspace.gitBranch ||
          (signal.workspace.isolated ? signal.workspace.branch || 'worktree' : 'main')}
        {signal.workspace.worktreeState === 'removed' ? ' · removed' : ''}
      </strong></div>
      <div><span>{t('officeFiles')}</span><strong>{workspaceChangeShort(signal.workspace)}</strong></div>
    </div>
  )
}
