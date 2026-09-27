import type { SessionMeta } from '../../../../shared/types'
import type { SessionState } from '../../store'
import { formatCost, formatTokens } from '../../format'
import { useT } from '../../i18n'
import { useExperienceProjection } from './ExperienceProjection'

export default function ChatStatusBar({
  meta,
  providerName,
  session
}: {
  meta: SessionMeta
  providerName: string
  session: Pick<SessionState, 'effectiveModel'>
}): React.JSX.Element {
  const t = useT()
  const projection = useExperienceProjection()
  return (
    <footer className="status-bar">
      <span className={`status-dot status-${meta.status}`} />
      <span className="status-text">{t(sessionStatusKey(meta.status))}</span>
      {projection === 'assistant' ? (
        <AssistantRuntimeStatus meta={meta} providerName={providerName} effectiveModel={session.effectiveModel} />
      ) : (
        <StudioRuntimeStatus meta={meta} providerName={providerName} effectiveModel={session.effectiveModel} />
      )}
    </footer>
  )
}

function AssistantRuntimeStatus({
  effectiveModel,
  meta,
  providerName
}: {
  effectiveModel?: string
  meta: SessionMeta
  providerName: string
}): React.JSX.Element {
  const t = useT()
  const model = effectiveModel || meta.model || t('routingModeGlobalSummary')
  return (
    <>
      <span className="status-item" data-assistant-runtime-status>{t('assistantAutoCompute')}</span>
      <span className="status-item" data-assistant-runtime-provider>{t('provider')} {providerName}</span>
      <span className="status-item" data-assistant-runtime-model>{t('model')} {model}</span>
      <span className="status-spacer" />
      <span className="status-item">{t('statusContext')} ~{formatTokens(meta.contextTokens)} tokens</span>
      <span className="status-item">↑{formatTokens(meta.usage.input + meta.usage.cacheRead + meta.usage.cacheCreation)} ↓{formatTokens(meta.usage.output)}</span>
      <span className="status-item status-cost" data-assistant-runtime-cost>{t('cost')} {formatCost(meta.costUsd)}</span>
    </>
  )
}

function StudioRuntimeStatus({
  effectiveModel,
  meta,
  providerName
}: {
  effectiveModel?: string
  meta: SessionMeta
  providerName: string
}): React.JSX.Element {
  const t = useT()
  return (
    <>
      <span className="status-item">{t('provider')} {providerName}</span>
      {effectiveModel && <span className="status-item">{t('model')} {effectiveModel}</span>}
      <span className="status-spacer" />
      <span className="status-item">{t('statusContext')} ~{formatTokens(meta.contextTokens)} tokens</span>
      <span className="status-item">
        ↑{formatTokens(meta.usage.input + meta.usage.cacheRead + meta.usage.cacheCreation)} ↓{formatTokens(meta.usage.output)}
      </span>
      <span className="status-item status-cost">{formatCost(meta.costUsd)}</span>
    </>
  )
}

function sessionStatusKey(status: SessionMeta['status']): string {
  if (status === 'running') return 'statusRunning'
  if (status === 'starting') return 'statusStarting'
  if (status === 'idle') return 'statusIdle'
  if (status === 'error') return 'statusError'
  return 'statusClosed'
}
