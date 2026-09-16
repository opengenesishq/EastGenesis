import { useEffect, useRef, useState } from 'react'
import type { MemoryRetentionLayer, MemoryRetentionPreview, MemoryRetentionView } from '../../../shared/memory-retention-types'

const LABELS: Record<MemoryRetentionLayer, string> = {
  working: '当前任务记忆', project: '本项目记忆', user: '用户记忆（所有项目共用）'
}

export default function MemoryRetentionPanel({ sessionId, onChanged }: {
  sessionId: string
  onChanged(): Promise<void>
}): React.JSX.Element {
  const generation = useRef(0)
  const [view, setView] = useState<MemoryRetentionView | null>(null)
  const [layer, setLayer] = useState<MemoryRetentionLayer>('working')
  const [days, setDays] = useState('')
  const [preview, setPreview] = useState<MemoryRetentionPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => () => { generation.current++ }, [sessionId])

  const read = async (): Promise<void> => {
    const token = ++generation.current
    setBusy(true)
    setError('')
    setNotice('')
    setPreview(null)
    try {
      const result = await window.agentDesk.readMemoryRetention(sessionId)
      if (token !== generation.current) return
      setView(result)
      setDays(String(result.settings.find((setting) => setting.layer === layer)?.days ?? ''))
    } catch (err) {
      if (token === generation.current) setError(message(err))
    } finally {
      if (token === generation.current) setBusy(false)
    }
  }

  const prepare = async (): Promise<void> => {
    if (!view) return
    const token = generation.current
    setBusy(true)
    setError('')
    setNotice('')
    setPreview(null)
    try {
      const value = days.trim() === '' ? null : Number(days)
      if (value !== null && (!Number.isInteger(value) || value < 1 || value > 36_500)) throw new Error('请输入 1 至 36500 天，留空表示永久保留')
      const result = await window.agentDesk.previewMemoryRetention(sessionId, { layer, days: value, expectedRevision: view.revision })
      if (token === generation.current) setPreview(result)
    } catch (err) {
      if (token === generation.current) setError(message(err))
    } finally {
      if (token === generation.current) setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!preview) return
    const token = generation.current
    setBusy(true)
    setError('')
    try {
      const result = await window.agentDesk.saveMemoryRetention(sessionId, {
        layer: preview.layer, days: preview.days, expectedRevision: preview.expectedRevision,
        evaluatedAt: preview.evaluatedAt, digest: preview.digest
      })
      if (token !== generation.current) return
      setView(result)
      setPreview(null)
      setNotice(preview.days === null ? '已改为永久保留。已经到期的记忆不会恢复。' : `已保存，${LABELS[preview.layer]}超过 ${preview.days} 天后自动到期。`)
      await onChanged()
    } catch (err) {
      if (token === generation.current) { setError(message(err)); setPreview(null) }
    } finally {
      if (token === generation.current) setBusy(false)
    }
  }

  return <div className="memory-group" data-memory-retention="true">
    <div className="settings-section-head">
      <h4 className="settings-h3">记忆保留期限</h4>
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void read()}>
        {busy ? '处理中…' : view ? '刷新保留设置' : '设置保留期限'}
      </button>
    </div>
    <p className="field-hint">默认永久保留。各范围分别设置，按最近一次修改计时，读取不会延长期限。</p>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice notice-info" role="status">{notice}</div>}
    {view && <div className="memory-form">
      <label className="field-label">适用范围
        <select className="input input-block" aria-label="记忆保留范围" value={layer} disabled={busy}
          onChange={(event) => {
            const value = event.target.value as MemoryRetentionLayer
            setLayer(value)
            setDays(String(view.settings.find((setting) => setting.layer === value)?.days ?? ''))
            setPreview(null); setError(''); setNotice('')
          }}>
          {view.settings.map((setting) => <option key={setting.layer} value={setting.layer} disabled={!setting.available}>
            {LABELS[setting.layer]}{setting.available ? ` · ${setting.days === null ? '永久保留' : `${setting.days} 天`}` : ' · 尚未关联项目'}
          </option>)}
        </select>
      </label>
      <label className="field-label">保留天数（留空为永久）
        <input className="input input-block" aria-label="记忆保留天数" type="number" min={1} max={36500} step={1}
          placeholder="永久保留" value={days} disabled={busy} onChange={(event) => {
            setDays(event.target.value); setPreview(null); setNotice('')
          }} />
      </label>
      <p className="field-hint">到期后停止检索并清理记忆，保留原任务、文件、转录和审计。项目规则包括已采纳记忆及待确认草稿；旧目录记忆导入后才适用。</p>
      <button className="btn btn-ghost btn-sm" disabled={busy || !view.settings.find((setting) => setting.layer === layer)?.available}
        onClick={() => void prepare()}>预览保留变更</button>
      {preview && <div className="notice notice-info" data-memory-retention-preview="true">
        <p>{LABELS[preview.layer]}：{preview.days === null ? '永久保留' : `保留 ${preview.days} 天`}。
          当前将清理 {preview.layeredCount} 条记忆，并将 {preview.projectCount} 条项目记忆或草稿标记为到期。</p>
        <button className="btn btn-sm" disabled={busy} onClick={() => void save()}>保存保留规则</button>
      </div>}
    </div>}
  </div>
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
