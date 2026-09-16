import { useEffect, useRef, useState } from 'react'
import { modelOptionsForProvider, useStore } from '../../store'

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
  const [model, setModel] = useState(meta?.model ?? 'auto')
  const [notice, setNotice] = useState('')
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!inFlight.current) setModel(meta?.modelChange?.state === 'prepared' ? meta.modelChange.to.model : meta?.model ?? 'auto')
  }, [meta?.model, meta?.modelChange?.state, meta?.modelChange?.to.model])
  const running = meta?.status === 'running' || meta?.status === 'starting'
  const apply = async (): Promise<void> => {
    if (inFlight.current || running || !meta) return
    inFlight.current = true
    setBusy(true); setError(''); setNotice('')
    try {
      await window.agentDesk.setModel(sessionId, model)
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
        setModel(saved?.modelChange?.state === 'prepared' ? saved.modelChange.to.model : saved?.model ?? 'auto')
        setBusy(false)
      }
    }
  }
  return <div className="composer-pending-inputs" data-session-model-picker={sessionId}>
    <label>{zh ? '选择后续使用的模型' : 'Choose a model for subsequent turns'}
      <select className="select" aria-label={zh ? '选择后续使用的模型' : 'Choose a model for subsequent turns'}
        disabled={running || busy || !meta || meta.modelChange?.state === 'prepared'} value={model}
        onChange={(event) => { setModel(event.target.value); setError(''); setNotice('') }}>
        {modelOptionsForProvider(providers, meta?.providerId ?? '', zh ? '自动选择' : 'Automatic', model)
          .map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
    {running && <span>{zh ? ' 本轮仍使用当前模型；暂停或等待结束后可选择后续模型。' : ' Pause or wait for this turn to finish before choosing another model.'}</span>}
    {meta?.modelChange?.state === 'prepared' && <p role="status">{zh
      ? '上次切换尚未完成保存，请重新应用该模型完成交接。' : 'The last change is not fully saved. Apply that model again to finish the handoff.'}</p>}
    {meta?.modelChange?.state === 'committed' && <p data-session-model-handoff>
      {zh ? '已保留交接记录：' : 'Saved handoff: '}{meta.modelChange.handoff.artifacts.length} {zh ? '项文件版本' : 'artifact versions'} · {meta.modelChange.handoff.facts.length} {zh ? '项已确认资料' : 'confirmed sources'} · {meta.modelChange.handoff.failures.length} {zh ? '项失败记录' : 'failure records'}
    </p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    <button type="button" className="btn btn-primary" disabled={busy || running || !meta ||
      (model === meta.model && meta.modelChange?.state !== 'prepared')} onClick={() => void apply()}>
      {busy ? (zh ? '保存交接中…' : 'Saving handoff…') : (zh ? '应用到后续对话' : 'Apply to subsequent turns')}</button>
    <button type="button" className="btn" onClick={onClose}>{zh ? '收起' : 'Dismiss'}</button>
  </div>
}
