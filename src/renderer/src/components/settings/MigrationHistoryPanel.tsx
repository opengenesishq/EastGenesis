import { useCallback, useEffect, useState } from 'react'
import type { MigrationHistory, MigrationHistoryState, MigrationRollbackPreview } from '../../../../shared/migration-types'
import { useStore } from '../../store'
import MigrationServiceFollowup from './MigrationServiceFollowup'
import './migration-history.css'

export default function MigrationHistoryPanel({ revision, busy, onBusy, onResult, onRestored }: {
  revision: number; busy: boolean; onBusy(value: boolean): void; onResult(message: string): void; onRestored(): void
}) {
  const zh = useStore(state => state.settings.language === 'zh')
  const [history, setHistory] = useState<MigrationHistory>(), [preview, setPreview] = useState<MigrationRollbackPreview>(), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const refresh = useCallback(async () => {
    setLoading(true); setError(''); setPreview(undefined)
    try { setHistory(await window.agentDesk.listMigrationHistory()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void refresh() }, [refresh, revision])
  async function review(backupId: string) {
    setLoading(true); setError(''); setPreview(undefined)
    try { setPreview(await window.agentDesk.previewMigrationRollback(backupId)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLoading(false) }
  }
  async function restore() {
    if (!preview?.canRollback || !preview.reviewDigest) return
    onBusy(true); setError('')
    try {
      const result = await window.agentDesk.rollbackMigration(preview.backupId, preview.reviewDigest)
      onResult(result.message); setPreview(undefined)
      await refresh()
      if (result.ok) onRestored()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setPreview(undefined) }
    finally { onBusy(false) }
  }
  const labels: Record<MigrationHistoryState, string> = zh
    ? { prepared: '已准备', backup_verified: '备份已核对', applying: '导入待核对', committed: '已导入', rollback_pending: '恢复待完成', rolled_back: '已恢复', invalid: '记录不可用' }
    : { prepared: 'Prepared', backup_verified: 'Backup verified', applying: 'Import needs reconciliation', committed: 'Imported', rollback_pending: 'Recovery pending', rolled_back: 'Restored', invalid: 'Record unavailable' }
  return <section className="migration-history" data-migration-history>
    <header><h4>{zh ? '导入历史与恢复' : 'Import history and recovery'}</h4><button type="button" className="btn btn-ghost btn-sm" disabled={busy || loading} onClick={() => void refresh()}>{zh ? '刷新记录' : 'Refresh records'}</button></header>
    <p className="settings-hint">{zh ? '记录保存在本机，重启后仍可查看。恢复前会核对原备份和目标文件，保留导入后产生的新修改。' : 'Records remain available after restarting. Recovery verifies the original backup and target files, preserving changes made after import.'}</p>
    {loading && <p role="status">{zh ? '读取记录…' : 'Reading records…'}</p>}{error && <p className="notice notice-error" role="alert">{error}</p>}
    {history?.entries.length === 0 && <p>{zh ? '暂无导入记录。' : 'No import records yet.'}</p>}
    {history?.entries.map(entry => <article key={entry.backupId} className="migration-history-entry"><header><strong>{labels[entry.state]}</strong><small>{entry.createdAt ? new Date(entry.createdAt).toLocaleString() : ''}</small></header><code>{entry.backupId}</code>
      <details><summary>{zh ? `涉及 ${entry.targetPaths.length} 个目标` : `${entry.targetPaths.length} targets`}</summary>{entry.targetPaths.map(path => <code key={path}>{path}</code>)}</details>
      {entry.message && <p>{entry.message}</p>}
      {entry.canReviewRollback && <button type="button" className="btn btn-ghost btn-sm" data-migration-rollback disabled={busy || loading} onClick={() => void review(entry.backupId)}>{zh ? '预览恢复' : 'Preview recovery'}</button>}
      {preview?.backupId === entry.backupId && <div className="migration-restore-preview" role="region" aria-label={zh ? '恢复预览' : 'Recovery preview'}><p>{preview.message}</p>{preview.targetPaths.map(path => <code key={path}>{path}</code>)}{preview.canRollback && <button type="button" className="btn btn-primary btn-sm" data-migration-rollback-confirm disabled={busy || loading} onClick={() => void restore()}>{zh ? '确认恢复到导入前' : 'Restore the pre-import version'}</button>}<button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPreview(undefined)}>{zh ? '关闭预览' : 'Close preview'}</button></div>}
      {entry.state === 'committed' && <MigrationServiceFollowup targetPaths={entry.targetPaths} />}
    </article>)}
    {history?.truncated && <p>{zh ? '这里只展示最近读取到的 100 条记录，旧备份仍保留在本机。' : 'Showing up to 100 recently read records; older backups remain on this computer.'}</p>}
  </section>
}
