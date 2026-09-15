import { useEffect, useRef, useState } from 'react'
import { modelOptionsForProvider, useStore } from '../../store'

export default function SessionModelPicker({ sessionId, onClose }: {
  sessionId: string; onClose(): void
}): React.JSX.Element {
  const meta = useStore((state) => state.sessions[sessionId]?.meta)
  const providers = useStore((state) => state.providers)
  const zh = useStore((state) => state.settings.language === 'zh')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = useRef(sessionId)
  current.current = sessionId
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const running = meta?.status === 'running' || meta?.status === 'starting'
  return <div className="composer-pending-inputs" data-session-model-picker={sessionId}>
    <label>{zh ? '选择后续使用的模型' : 'Choose a model for subsequent turns'}
      <select className="select" aria-label={zh ? '选择后续使用的模型' : 'Choose a model for subsequent turns'}
        disabled={running || busy || !meta} value={meta?.model ?? ''}
        onChange={(event) => {
          const model = event.target.value
          setBusy(true); setError('')
          void window.agentDesk.setModel(sessionId, model).then(async () => {
            await useStore.getState().syncSession(sessionId)
            if (mounted.current && current.current === sessionId) onClose()
          }).catch((cause) => {
            if (mounted.current && current.current === sessionId) setError(cause instanceof Error ? cause.message : String(cause))
          }).finally(() => { if (mounted.current && current.current === sessionId) setBusy(false) })
        }}>
        {modelOptionsForProvider(providers, meta?.providerId ?? '', zh ? '自动选择' : 'Automatic', meta?.model)
          .map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
    {running && <span>{zh ? ' 本轮仍使用当前模型；暂停或等待结束后可选择后续模型。' : ' Pause or wait for this turn to finish before choosing another model.'}</span>}
    {error && <p role="alert">{error}</p>}
    <button type="button" className="btn" onClick={onClose}>{zh ? '收起' : 'Dismiss'}</button>
  </div>
}
