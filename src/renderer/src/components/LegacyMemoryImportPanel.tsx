import { useEffect, useRef, useState } from 'react'
import type { LegacyMemoryPreview, LegacyMemoryPreviewEntry } from '../../../shared/legacy-memory-import-types'

export default function LegacyMemoryImportPanel({ sessionId, onImported, contributionAllowed = true }: {
  sessionId: string
  onImported(): Promise<void>
  contributionAllowed?: boolean
}): React.JSX.Element {
  const [preview, setPreview] = useState<LegacyMemoryPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [sessionId])

  const load = async (): Promise<void> => {
    const token = ++generation.current
    setLoading(true)
    setPreview(null)
    setError('')
    setNotice('')
    try {
      const value = await window.agentDesk.previewLegacyProjectMemory(sessionId)
      if (token === generation.current) setPreview(value)
    } catch (err) {
      if (token === generation.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (token === generation.current) setLoading(false)
    }
  }

  const importEntry = async (entry: LegacyMemoryPreviewEntry): Promise<void> => {
    if (!preview) return
    const token = generation.current
    setImporting(entry.entryKey)
    setError('')
    setNotice('')
    try {
      const result = await window.agentDesk.importLegacyProjectMemory(sessionId, {
        expectedProjectId: preview.projectId, entryKey: entry.entryKey, sourceDigest: entry.sourceDigest
      })
      if (token !== generation.current) return
      setPreview((current) => current && { ...current, entries: current.entries.map((candidate) => candidate.entryKey === entry.entryKey
        ? { ...candidate, imported: { recordId: result.record.id, status: result.record.status } } : candidate) })
      setNotice(result.record.status === 'draft' ? '已导入为待确认草稿，请在待确认草稿中查看并采纳。' : '此版本已导入，保留已有处理结果。')
      await onImported()
    } catch (err) {
      if (token === generation.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (token === generation.current) setImporting(null)
    }
  }

  return <div className="memory-group" data-legacy-memory-import="true">
    <div className="settings-section-head">
      <h4 className="settings-h3">旧目录记忆</h4>
      <button className="btn btn-ghost btn-sm" disabled={loading || importing !== null} onClick={() => void load()}>
        {loading ? '读取中…' : preview ? '刷新旧记忆' : '查看旧记忆'}
      </button>
    </div>
    <p className="field-hint">查看当前任务目录中保存的旧记忆，逐条导入本项目后仍需确认。多个项目可共用目录，请核对内容的归属。</p>
    {error && <div className="notice notice-error">{error}</div>}
    {notice && <div className="notice notice-info">{notice}</div>}
    {preview && <>
      <div className="field-hint">来源目录：{preview.sourceDirectory}</div>
      {preview.entries.length === 0 ? <div className="provider-empty">没有可导入的旧记忆</div> : <div className="provider-list">
        {preview.entries.map((entry) => <div className="provider-row memory-row" key={entry.entryKey}>
          <div className="provider-row-body">
            <div className="provider-row-name">{entry.title}</div>
            <div className="provider-row-sub memory-body">{entry.body}</div>
            <div className="field-hint">原来源：{entry.source} · {entry.sourceState === 'active' ? '原已生效' : '原待确认'}
              {entry.sourceVersion ? ` · v${entry.sourceVersion}` : ''} · {entry.updatedAt}</div>
            {entry.reason && <div className="field-hint">原理由：{entry.reason}</div>}
          </div>
          <div className="provider-row-actions"><button className="btn btn-ghost btn-sm"
            disabled={!contributionAllowed || importing !== null || Boolean(entry.imported)} onClick={() => void importEntry(entry)}>
            {entry.imported ? importedLabel(entry.imported.status) : importing === entry.entryKey ? '导入中…' : '导入为待确认草稿'}
          </button></div>
        </div>)}
      </div>}
    </>}
  </div>
}

function importedLabel(status: NonNullable<LegacyMemoryPreviewEntry['imported']>['status']): string {
  if (status === 'draft') return '已导入待确认'
  if (status === 'active') return '已导入并采纳'
  if (status === 'deleted') return '已导入后删除'
  return '已导入并处理'
}
