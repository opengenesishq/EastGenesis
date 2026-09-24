import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import { routingFormTarget, sessionRoutingForm, sessionRoutingLabel } from './session-routing-form'
import SessionRoutingFields from './SessionRoutingFields'

export default function SessionModelPicker({ sessionId, onClose }: {
  sessionId: string; onClose(): void
}): React.JSX.Element {
  return <TaskModelPicker key={sessionId} sessionId={sessionId} onClose={onClose} />
}

function TaskModelPicker({ sessionId, onClose }: {
  sessionId: string; onClose(): void
}): React.JSX.Element {
  const meta = useStore((state) => state.sessions[sessionId]?.meta)
  const providers = useStore((state) => state.providers)
  const zh = useStore((state) => state.settings.language === 'zh')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [control, setControl] = useState(() => sessionRoutingForm(meta))
  const [notice, setNotice] = useState('')
  const inFlight = useRef(false)
  const mounted = useRef(true)
  // Meta events clone routingControl even when only progress/cost changes.
  // Synchronize actual saved choices without discarding an unsaved draft.
  const savedControlKey = JSON.stringify(sessionRoutingForm(meta))
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!inFlight.current) setControl(JSON.parse(savedControlKey))
  }, [savedControlKey, meta?.modelChange?.digest])
  const running = meta?.status === 'running' || meta?.status === 'starting'
  const savedSelection = sessionRoutingForm(meta)
  const selectedProviderId = savedSelection.kind === 'auto'
    ? savedSelection.scope?.kind === 'provider' ? savedSelection.scope.providerId : undefined
    : routingFormTarget(savedSelection).providerId
  const currentProvider = providers.find(provider => provider.id === selectedProviderId)
  const decision = meta?.modelRoutingDecision
  const apply = async (): Promise<void> => {
    if (inFlight.current || running || !meta) return
    inFlight.current = true
    setBusy(true); setError(''); setNotice('')
    let applied = false
    try {
      await window.agentDesk.setRoutingControl(sessionId, control)
      applied = true
      await useStore.getState().syncSession(sessionId)
      if (mounted.current) setNotice(zh
        ? '后续模型已保存，继续输入即可沿用当前任务。' : 'Model saved for subsequent turns. Continue in this task.')
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
        await useStore.getState().syncSession(sessionId).catch(() => undefined)
      }
    } finally {
      inFlight.current = false
      if (mounted.current) {
        const saved = useStore.getState().sessions[sessionId]?.meta
        if (applied || saved?.modelChange?.state === 'prepared') setControl(sessionRoutingForm(saved))
        setBusy(false)
      }
    }
  }
  return <div className="composer-pending-inputs session-routing-picker" data-session-model-picker={sessionId}>
    <div className="session-routing-heading">
      <div>
        <strong>{zh ? '模型与路由' : 'Models & routing'}</strong>
        {meta && <p data-session-routing-current>{zh ? '当前设置：' : 'Current setting: '}
          {sessionRoutingLabel(meta, zh)}
          {currentProvider ? ` · ${currentProvider.name}` : ''}
        </p>}
        {decision && <p data-session-routing-last-target>{zh ? '最近路由：' : 'Last routed to: '}
          {providers.find(provider => provider.id === decision.providerId)?.name ?? decision.providerName ?? decision.providerId} / {decision.model}
        </p>}
      </div>
      <div className="routing-settings-links">
        <button type="button" className="btn btn-ghost btn-sm" data-routing-settings-link="routing"
          onClick={() => useStore.getState().setShowSettings(true, 'routing')}>{zh ? '自定义路由' : 'Routing rules'}</button>
        <button type="button" className="btn btn-ghost btn-sm" data-routing-settings-link="providers"
          onClick={() => useStore.getState().setShowSettings(true, 'providers')}>{zh ? '厂商与模型' : 'Providers & models'}</button>
      </div>
    </div>
    <SessionRoutingFields value={control} providers={providers} engine={meta?.engine} zh={zh}
      disabled={running || busy || !meta || meta.modelChange?.state === 'prepared'}
      onChange={next => { setControl(next); setError(''); setNotice('') }} />
    {running && <span>{zh ? ' 本轮仍使用当前模型；暂停或等待结束后可选择后续模型。' : ' Pause or wait for this turn to finish before choosing another model.'}</span>}
    {meta?.modelChange?.state === 'prepared' && <p role="status">{zh
      ? '上次切换尚未完成保存，请重新应用该模型完成交接。' : 'The last change is not fully saved. Apply that model again to finish the handoff.'}</p>}
    {meta?.modelChange?.state === 'committed' && <p data-session-model-handoff>
      {zh ? '已保留交接记录：' : 'Saved handoff: '}{meta.modelChange.handoff.artifacts.length} {zh ? '项文件版本' : 'artifact versions'} · {meta.modelChange.handoff.facts.length} {zh ? '项已确认资料' : 'confirmed sources'} · {meta.modelChange.handoff.failures.length} {zh ? '项失败记录' : 'failure records'}
    </p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    <button type="button" className="btn btn-primary" disabled={busy || running || !meta ||
      (JSON.stringify(control) === JSON.stringify(sessionRoutingForm(meta)) && meta.modelChange?.state !== 'prepared')} onClick={() => void apply()}>
      {busy ? (zh ? '保存交接中…' : 'Saving handoff…') : (zh ? '应用到后续对话' : 'Apply to subsequent turns')}</button>
    <button type="button" className="btn" onClick={onClose}>{zh ? '收起' : 'Dismiss'}</button>
  </div>
}
