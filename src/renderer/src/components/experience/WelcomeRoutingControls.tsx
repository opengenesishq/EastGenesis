import { ChevronDown } from 'lucide-react'
import type {
  CaoGenDriveMode,
  ProviderView
} from '../../../../shared/types'
import { DRIVE_MODE_OPTIONS, useStore } from '../../store'
import type { ModelOption } from '../../commands'
import { useT } from '../../i18n'
import type { WelcomeRoutingMode } from '../../store/welcome-draft'
import '../composer/session-routing-controls.css'

interface WelcomeRoutingControlsProps {
  driveMode: CaoGenDriveMode
  fixedModelOptions: ModelOption[]
  model: string
  providerId: string
  providers: ProviderView[]
  routingMode: WelcomeRoutingMode
  routingStrategyLabel: string
  onDriveChange: (mode: CaoGenDriveMode) => void
  onModelChange: (model: string) => void
  onProviderChange: (providerId: string) => void
  onRoutingModeChange: (mode: WelcomeRoutingMode) => void
  showDriveMode?: boolean
}

export default function WelcomeRoutingControls({
  driveMode,
  fixedModelOptions,
  model,
  onDriveChange,
  onModelChange,
  onProviderChange,
  onRoutingModeChange,
  providerId,
  providers,
  routingMode,
  routingStrategyLabel,
  showDriveMode = true
}: WelcomeRoutingControlsProps): React.JSX.Element {
  const t = useT()
  const zh = useStore(state => state.settings.language === 'zh')
  return (
    <details className="welcome-routing-picker" data-expert-controls="routing">
      <summary className="welcome-mini-select" aria-label={zh ? '选择模型与路由' : 'Choose model and routing'}>
        {routingMode === 'fixed' ? model || (zh ? '选择模型' : 'Choose a model') : `${zh ? '智能路由' : 'Smart routing'} · ${routingStrategyLabel}`}
        <ChevronDown size={13} aria-hidden="true" />
      </summary>
      <div className="welcome-routing-popover">
      <strong>{zh ? '模型与路由' : 'Models & routing'}</strong>
      <div className="welcome-routing-modes" role="group" aria-label={t('routingMode')}>
        {(['fixed', 'provider', 'global'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={routingMode === mode ? 'active' : ''}
            data-welcome-routing-mode={mode}
            aria-pressed={routingMode === mode}
            onClick={() => onRoutingModeChange(mode)}
          >
            {t(routingModeLabel(mode))}
          </button>
        ))}
      </div>
      {routingMode !== 'global' && (
        <select
          className="welcome-mini-select"
          data-welcome-routing-control="provider"
          aria-label={zh ? '厂商连接' : 'Provider connection'}
          value={providerId}
          onChange={(event) => onProviderChange(event.target.value)}
        >
          <option value="" disabled>{t('selectProviderPlaceholder')}</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id} disabled={!provider.ready}>
              {provider.name}{provider.ready ? '' : ` (${t('noKeyConfigured')})`}
            </option>
          ))}
        </select>
      )}
      {showDriveMode && <select
        className="welcome-mini-select"
        data-welcome-routing-control="drive"
        aria-label={zh ? '执行档位' : 'Execution profile'}
        value={driveMode}
        onChange={(event) => onDriveChange(event.target.value as CaoGenDriveMode)}
      >
        {DRIVE_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>}
      {routingMode === 'fixed' ? (
        <select
          className="welcome-mini-select"
          data-welcome-routing-control="model"
          aria-label={zh ? '指定模型' : 'Selected model'}
          value={model}
          onChange={(event) => onModelChange(event.target.value)}
        >
          <option value="" disabled>{t('selectModelPlaceholder')}</option>
          {fixedModelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      ) : (
        <span className="welcome-routing-summary">
          {routingMode === 'global' ? t('routingModeGlobalSummary') : t('routingModeProviderSummary')}
          {' · '}{routingStrategyLabel}
        </span>
      )}
      <div className="routing-settings-links welcome-routing-settings">
        <button type="button" className="welcome-mini-select" data-routing-settings-link="routing"
          onClick={() => useStore.getState().setShowSettings(true, 'routing')}>{zh ? '自定义路由' : 'Routing rules'}</button>
        <button type="button" className="welcome-mini-select" data-routing-settings-link="providers"
          onClick={() => useStore.getState().setShowSettings(true, 'providers')}>{zh ? '厂商与模型' : 'Providers & models'}</button>
      </div>
      </div>
    </details>
  )
}

export function AssistantComputeIndicator({
  available,
  checking = false,
  onConfigure
}: {
  available: boolean
  checking?: boolean
  onConfigure?: () => void
}): React.JSX.Element {
  const t = useT()
  const zh = useStore(state => state.settings.language === 'zh')
  if (!available && !checking && onConfigure) {
    return <button
      type="button"
      className="assistant-compute-indicator assistant-compute-action"
      data-assistant-compute-state
      data-compute-available="false"
      data-compute-status="unavailable"
      onClick={onConfigure}
    >{t('assistantComputeUnavailableShort')} · {zh ? '连接模型' : 'Connect model'}</button>
  }
  return (
    <span
      className="assistant-compute-indicator"
      data-assistant-compute-state
      data-compute-available={available}
      data-compute-status={checking ? 'checking' : available ? 'ready' : 'unavailable'}
    >
      {t(checking ? 'assistantComputeCheckingLocal' : available ? 'assistantComputeReady' : 'assistantComputeUnavailableShort')}
    </span>
  )
}

function routingModeLabel(mode: WelcomeRoutingMode): string {
  if (mode === 'fixed') return 'routingModeFixed'
  if (mode === 'provider') return 'routingModeProvider'
  return 'routingModeGlobal'
}
