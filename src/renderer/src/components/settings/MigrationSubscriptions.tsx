import { useEffect, useState } from 'react'
import type { MigrationSubscription, MigrationSubscriptionPreview, MigrationSubscriptionsProps } from '../../../../shared/migration-subscription-types'
import { useStore } from '../../store'

export default function MigrationSubscriptions({ scan, result }: MigrationSubscriptionsProps): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [rows, setRows] = useState<MigrationSubscription[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [preview, setPreview] = useState<MigrationSubscriptionPreview>(), [chosen, setChosen] = useState<string[]>([])
  const candidates = scan?.assets.filter(asset => result?.subscriptionAssetIds?.includes(asset.id)) ?? []
  const tr = (cn: string, en: string): string => zh ? cn : en
  const refresh = async (): Promise<void> => { setRows(await window.agentDesk.listMigrationSubscriptions()) }
  useEffect(() => { let active = true; const load = async (): Promise<void> => { try { const next = await window.agentDesk.listMigrationSubscriptions(); if (active) setRows(next) } catch (cause) { if (active) setError(String(cause)) } }; void load(); const timer = setInterval(() => void load(), 15_000); return () => { active = false; clearInterval(timer) } }, [])
  useEffect(() => { setChosen([]) }, [result?.backupId])
  const act = async (fn: () => Promise<unknown>): Promise<void> => { if (busy) return; setBusy(true); setError(''); try { await fn(); await refresh() } catch (cause) { setError(String(cause)) } finally { setBusy(false) } }
  return <section className="settings-section" data-migration-subscriptions>
    <h3 className="settings-h3">{tr('订阅导入来源', 'Watch imported sources')}</h3>
    <p className="settings-hint">{tr('应用运行时，每分钟检查已选择来源的变化。更新先预览再确认；关闭订阅保留已导入内容。', 'While the app runs, selected sources are checked every minute. Review and confirm each update. Disabling a watch keeps imported content.')}</p>
    {candidates.length > 0 && result?.backupId && <div>
      {candidates.map(asset => <label className="settings-toggle" key={asset.id}><input type="checkbox" checked={chosen.includes(asset.id)} disabled={busy} onChange={event => setChosen(current => event.target.checked ? [...current, asset.id] : current.filter(id => id !== asset.id))} />{asset.name}</label>)}
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !chosen.length} onClick={() => void act(async () => { await window.agentDesk.subscribeMigrationImport(result.backupId!, chosen); setChosen([]) })}>{tr('订阅所选来源', 'Watch selected sources')}</button>
    </div>}
    <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !rows.length} onClick={() => void act(async () => setRows(await window.agentDesk.checkMigrationSubscriptions()))}>{tr('立即检查更新', 'Check now')}</button>
    {!rows.length && <p className="settings-hint">{tr('成功导入文件、配置或技能后，可在这里选择订阅。', 'After importing files, configuration, or skills, select the sources to watch here.')}</p>}
    {rows.map(row => <article key={row.id} className="settings-section">
      <label className="settings-toggle"><input type="checkbox" checked={row.enabled} disabled={busy} onChange={event => { setPreview(undefined); void act(() => window.agentDesk.setMigrationSubscriptionEnabled(row.id, row.revision, event.target.checked)) }} />{row.name}</label>
      <p className="field-hint" style={{ overflowWrap: 'anywhere' }}>{row.sourcePath} → {row.targetPath}</p>
      <p>{row.message ?? (row.enabled ? tr('来源未变化', 'Source unchanged') : tr('订阅已关闭', 'Watch disabled'))}</p>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !row.enabled || row.status !== 'changed'} onClick={() => void act(async () => setPreview(await window.agentDesk.previewMigrationSubscription(row.id, row.revision)))}>{tr('预览更新', 'Preview update')}</button>
    </article>)}
    {preview && <div className="notice" data-migration-update-preview>
      <strong>{tr('确认来源更新', 'Confirm source update')} · {preview.after.name}</strong>
      <p>{tr('此前导入摘要', 'Previously imported summary')}</p><pre style={{ whiteSpace: 'pre-wrap' }}>{preview.before}</pre>
      <p>{tr('新来源摘要', 'New source summary')}</p><pre style={{ whiteSpace: 'pre-wrap' }}>{preview.after.preview}</pre>
      <p>{preview.after.conflictDetail}</p><p>{preview.after.riskReasons.join(' · ')}</p>
      <p className="field-hint">{preview.after.path} → {preview.after.targetPath}</p>
      <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act(async () => { const applied = await window.agentDesk.applyMigrationSubscription(preview.id); setPreview(undefined); if (!applied.ok) throw new Error(applied.message) })}>{preview.action === 'replace' ? tr('确认替换此项', 'Confirm replacement') : tr('确认应用此项', 'Confirm update')}</button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPreview(undefined)}>{tr('取消', 'Cancel')}</button>
    </div>}
    {error && <p role="alert" className="notice notice-error">{error}</p>}
  </section>
}
