import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type {
  PalaceSceneActionBinding,
  PalaceSceneEntityKind,
  PalaceSceneManifest,
  PalaceSceneRoleBinding,
  PalaceSceneViewBinding,
  PalaceSceneViewKind,
  PalaceSceneZone
} from '../../../../shared/palace-scene-manifest'
import type { PalaceSceneBuilderSnapshot } from '../../../../shared/palace-scene-builder-types'
import { PALACE_SCENE_COMMAND_IDS, parsePalaceSceneManifest, resolvePalaceSceneRuntime, type PalaceSceneRuntimeMode, type PalaceSceneStaleReason } from '../../../../shared/palace-scene-manifest'
import { useStore } from '../../store'
import {
  buildPalaceSceneBuilderEditPatch,
  validatePalaceSceneBuilderUiManifest
} from './palace-scene-builder-gate'
import './palace-scene-builder.css'

const DEFAULT_SCENE_ID = 'product-release-palace'
const ENTITY_KINDS: PalaceSceneEntityKind[] = ['goal', 'workItem', 'run', 'artifact', 'evidence', 'acceptance']
const VIEW_KINDS: PalaceSceneViewKind[] = ['overview', 'status', 'timeline', 'artifact', 'evidence', 'acceptance']

export interface PalaceSceneBuilderProps {
  active?: boolean
  sceneId?: string
  staleReason?: PalaceSceneStaleReason
}

type BuilderCollection = 'zones' | 'roleBindings' | 'viewBindings' | 'actionBindings'

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function validSceneId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
}

function emptyEntity(): { kind: PalaceSceneEntityKind; id: string } {
  return { kind: 'workItem', id: 'work-item-1' }
}

function cloneManifest(value: PalaceSceneManifest): PalaceSceneManifest {
  return structuredClone(value)
}

function appendRow(manifest: PalaceSceneManifest, collection: BuilderCollection): PalaceSceneManifest {
  const next = cloneManifest(manifest)
  if (collection === 'zones') next.zones.push({ id: `zone-${next.zones.length + 1}`, title: '新区域' })
  if (collection === 'roleBindings') next.roleBindings.push({ id: `role-${next.roleBindings.length + 1}`, roleId: 'operator', zoneId: next.zones[0].id, target: emptyEntity() })
  if (collection === 'viewBindings') next.viewBindings.push({ id: `view-${next.viewBindings.length + 1}`, kind: 'overview', zoneId: next.zones[0].id, target: emptyEntity() })
  if (collection === 'actionBindings') next.actionBindings.push({ id: `action-${next.actionBindings.length + 1}`, label: '更新工作项', zoneId: next.zones[0].id, commandId: 'work_item.update', policyId: 'policy:workspace', target: emptyEntity() })
  return next
}

export default memo(function PalaceSceneBuilder({ active = true, sceneId: initialSceneId = DEFAULT_SCENE_ID, staleReason }: PalaceSceneBuilderProps): React.JSX.Element {
  const language = useStore((state) => state.settings.language)
  const [sceneId, setSceneId] = useState(initialSceneId)
  const [snapshot, setSnapshot] = useState<PalaceSceneBuilderSnapshot | null>(null)
  const [draft, setDraft] = useState<PalaceSceneManifest | null>(null)
  const [importText, setImportText] = useState('')
  const [exportText, setExportText] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'saving' | 'exporting' | 'rolling-back'>('idle')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false)
  // Runtime preview is explicit: the default is the deterministic offline
  // 2D fallback; 3D is only selected after the caller opts into capability.
  const [runtimeMode, setRuntimeMode] = useState<PalaceSceneRuntimeMode>('2d-fallback')

  useEffect(() => {
    const markOnline = (): void => setOffline(false)
    const markOffline = (): void => setOffline(true)
    window.addEventListener('online', markOnline)
    window.addEventListener('offline', markOffline)
    return () => {
      window.removeEventListener('online', markOnline)
      window.removeEventListener('offline', markOffline)
    }
  }, [])

  const load = useCallback(async (): Promise<void> => {
    if (!validSceneId(sceneId)) { setError('场景 ID 只能包含字母、数字、点、下划线、冒号和连字符。'); return }
    setStatus('loading'); setError(''); setNotice(''); setSnapshot(null); setDraft(null)
    try {
      const result = await window.agentDesk.getPalaceSceneBuilder(sceneId)
      setSnapshot(result)
      setDraft(result ? cloneManifest(result.manifest) : null)
      if (!result) setNotice('尚未找到本地场景。可粘贴声明式 JSON 后导入保存。')
    } catch (cause) { setError(errorMessage(cause)) } finally { setStatus('idle') }
  }, [sceneId])

  useEffect(() => { if (active) void load() }, [active, load])

  const updateDraft = useCallback((next: PalaceSceneManifest): void => {
    // Keep form edits local while a user is typing (for example, changing a
    // Zone id before updating its bindings). The canonical gate runs atomically
    // immediately before an IPC write.
    setError(''); setDraft(cloneManifest(next))
  }, [])

  const save = async (): Promise<void> => {
    if (!draft) return
    setStatus('saving'); setError(''); setNotice('')
    try {
      const checked = validatePalaceSceneBuilderUiManifest(draft)
      if (!checked.ok || !checked.manifest) throw new Error(checked.error ?? '声明式场景校验失败。')
      const patch = snapshot ? buildPalaceSceneBuilderEditPatch(snapshot.manifest, checked.manifest) : null
      if (patch && Object.keys(patch).length === 0) throw new Error('没有可保存的声明式变更。')
      const result = patch
        ? await window.agentDesk.editPalaceSceneBuilder(sceneId, patch)
        : await window.agentDesk.savePalaceSceneBuilder(sceneId, checked.manifest)
      setSnapshot(result); setDraft(cloneManifest(result.manifest)); setNotice('已保存声明式场景版本。')
    } catch (cause) { setError(errorMessage(cause)) } finally { setStatus('idle') }
  }

  const importAndSave = async (): Promise<void> => {
    try {
      const checked = validatePalaceSceneBuilderUiManifest(JSON.parse(importText))
      if (!checked.ok || !checked.manifest) throw new Error(checked.error ?? '导入场景校验失败。')
      const imported = { ...checked.manifest, id: sceneId }
      const parsed = parsePalaceSceneManifest(imported)
      setDraft(parsed)
      setStatus('saving'); setError(''); setNotice('')
      const result = await window.agentDesk.savePalaceSceneBuilder(sceneId, parsed)
      setSnapshot(result); setDraft(cloneManifest(result.manifest)); setImportText(''); setNotice('已导入并保存。')
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setStatus('idle') }
  }

  const exportScene = async (): Promise<void> => {
    setStatus('exporting'); setError('')
    try {
      const value = await window.agentDesk.exportPalaceSceneBuilder(sceneId)
      if (!value) throw new Error('当前场景没有可导出的版本。')
      setExportText(value); setNotice('已生成声明式 JSON，可复制保存。')
    } catch (cause) { setError(errorMessage(cause)) } finally { setStatus('idle') }
  }

  const rollback = async (revision: number): Promise<void> => {
    setStatus('rolling-back'); setError(''); setNotice('')
    try {
      const result = await window.agentDesk.rollbackPalaceSceneBuilder(sceneId, revision)
      setSnapshot(result); setDraft(cloneManifest(result.manifest)); setNotice(`已回滚到版本 ${revision}，并生成新回滚版本。`)
    } catch (cause) { setError(errorMessage(cause)) } finally { setStatus('idle') }
  }

  const busy = status !== 'idle'
  const runtimeProjection = useMemo(() => {
    if (!draft) return null
    const effectiveStaleReason = staleReason ?? (offline ? 'offline' : undefined)
    try { return resolvePalaceSceneRuntime(draft, { supports3D: runtimeMode === '3d', ...(effectiveStaleReason ? { staleReason: effectiveStaleReason } : {}) }) } catch { return null }
  }, [draft, runtimeMode, staleReason, offline])
  const labels = language === 'zh'
    ? { title: '宫苑场景 Builder', subtitle: '编辑声明式 Zone、Role、View、Action；不会创建 Effect 或网络请求。', scene: '场景 ID', load: '加载', save: '保存', export: '导出 JSON', import: '导入并保存', importHint: '粘贴 PalaceScene JSON', zones: 'Zones', roles: 'Roles', views: 'Views', actions: 'Actions', add: '新增', rollback: '回滚', noScene: '未加载场景' }
    : { title: 'PalaceScene Builder', subtitle: 'Edit declarative zones, roles, views, and actions without creating Effects or network requests.', scene: 'Scene ID', load: 'Load', save: 'Save', export: 'Export JSON', import: 'Import and save', importHint: 'Paste PalaceScene JSON', zones: 'Zones', roles: 'Roles', views: 'Views', actions: 'Actions', add: 'Add', rollback: 'Rollback', noScene: 'No scene loaded' }

  return <section className="palace-scene-builder" data-palace-scene-builder data-palace-scene-builder-state={status === 'loading' ? 'loading' : error ? 'error' : snapshot ? 'ready' : 'empty'} aria-busy={busy}>
    <header className="palace-scene-builder-header">
      <div><h2>{labels.title}</h2><p>{labels.subtitle}</p></div>
      <div className="palace-scene-builder-toolbar">
        <label>{labels.scene}<input data-palace-scene-id value={sceneId} onChange={(event) => setSceneId(event.target.value)} /></label>
        <button type="button" data-palace-scene-action="load" disabled={busy} onClick={() => void load()}>{labels.load}</button>
      </div>
    </header>
    {status === 'loading' && <p className="palace-scene-builder-status" role="status" data-palace-scene-status="loading">加载场景…</p>}
    {error && <div className="palace-scene-builder-error" role="alert" data-palace-scene-status="error"><span>{error}</span><button type="button" onClick={() => void load()}>重试</button></div>}
    {notice && !error && <p className="palace-scene-builder-notice" role="status">{notice}</p>}
    {!snapshot && status !== 'loading' && <div className="palace-scene-builder-empty" data-palace-scene-empty>
      <p>{labels.noScene}</p>
      <textarea data-palace-scene-import value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={labels.importHint} rows={8} />
      <button type="button" data-palace-scene-action="import" disabled={busy || !importText.trim()} onClick={() => void importAndSave()}>{labels.import}</button>
    </div>}
    {snapshot && draft && <>
      <div className="palace-scene-builder-meta"><label>标题<input value={draft.title} onChange={(event) => updateDraft({ ...draft, title: event.target.value })} /></label><span>版本 {snapshot.summary.builderRevision} · layout {snapshot.summary.layoutVersion} · {snapshot.summary.digest.slice(0, 18)}…</span></div>
      <section className="palace-scene-runtime-preview" data-palace-scene-runtime-entry data-palace-scene-runtime-mode={runtimeProjection?.mode ?? runtimeMode} aria-label={language === 'zh' ? '宫苑运行预览' : 'PalaceScene runtime preview'}>
        <div className="palace-scene-builder-list-header"><div><h3>{language === 'zh' ? '运行预览' : 'Runtime preview'}</h3><p data-palace-scene-freshness={runtimeProjection?.freshness ?? 'fresh'}>{runtimeProjection?.stale ? (language === 'zh' ? `数据暂时滞后（${runtimeProjection.staleReason ?? 'unknown'}），仍可安全查看。` : `Projection is stale (${runtimeProjection.staleReason ?? 'unknown'}); safe read-only view.`) : runtimeMode === '3d' ? (language === 'zh' ? '已显式声明 3D capability。' : '3D capability explicitly declared.') : (language === 'zh' ? '离线 2D fallback，稳定且不执行场景代码。' : 'Offline 2D fallback; stable and data-only.')}</p></div><div className="palace-scene-runtime-switcher"><button type="button" data-palace-scene-runtime-mode="2d-fallback" aria-pressed={runtimeMode === '2d-fallback'} onClick={() => setRuntimeMode('2d-fallback')}>2D fallback</button><button type="button" data-palace-scene-runtime-mode="3d" aria-pressed={runtimeMode === '3d'} onClick={() => setRuntimeMode('3d')}>3D capability</button></div></div>
        {runtimeProjection && <div className="palace-scene-runtime-summary"><strong data-palace-scene-runtime-resolved>{runtimeProjection.mode}</strong><span>{runtimeProjection.zones.length} zones · {runtimeProjection.nodes.length} nodes</span><small>{runtimeProjection.source.type}:{runtimeProjection.source.ref} · {runtimeProjection.license.spdx}</small></div>}
      </section>
      <BuilderList title={labels.zones} collection="zones" rows={draft.zones} onChange={(rows) => updateDraft({ ...draft, zones: rows as PalaceSceneZone[] })} onAdd={() => updateDraft(appendRow(draft, 'zones'))} />
      <BuilderList title={labels.roles} collection="roleBindings" rows={draft.roleBindings} onChange={(rows) => updateDraft({ ...draft, roleBindings: rows as PalaceSceneRoleBinding[] })} onAdd={() => updateDraft(appendRow(draft, 'roleBindings'))} />
      <BuilderList title={labels.views} collection="viewBindings" rows={draft.viewBindings} onChange={(rows) => updateDraft({ ...draft, viewBindings: rows as PalaceSceneViewBinding[] })} onAdd={() => updateDraft(appendRow(draft, 'viewBindings'))} />
      <BuilderList title={labels.actions} collection="actionBindings" rows={draft.actionBindings} onChange={(rows) => updateDraft({ ...draft, actionBindings: rows as PalaceSceneActionBinding[] })} onAdd={() => updateDraft(appendRow(draft, 'actionBindings'))} />
      <div className="palace-scene-builder-actions"><button type="button" data-palace-scene-action="save" disabled={busy} onClick={() => void save()}>{labels.save}</button><button type="button" data-palace-scene-action="export" disabled={busy} onClick={() => void exportScene()}>{labels.export}</button></div>
      {exportText && <textarea className="palace-scene-builder-export" data-palace-scene-export value={exportText} readOnly rows={6} aria-label="Exported PalaceScene JSON" />}
      <div className="palace-scene-builder-history"><h3>版本历史</h3>{snapshot.history.map((entry) => <div key={`${entry.builderRevision}-${entry.digest}`} className="palace-scene-builder-history-row"><span>v{entry.builderRevision} · {entry.change} · {entry.changedAreas.join(', ')}</span><button type="button" data-palace-scene-rollback={entry.builderRevision} disabled={busy || entry.builderRevision === snapshot.summary.builderRevision} onClick={() => void rollback(entry.builderRevision)}>{labels.rollback}</button></div>)}</div>
    </>}
  </section>
})

function BuilderList({ title, collection, rows, onChange, onAdd }: { title: string; collection: BuilderCollection; rows: Array<PalaceSceneZone | PalaceSceneRoleBinding | PalaceSceneViewBinding | PalaceSceneActionBinding>; onChange: (rows: Array<PalaceSceneZone | PalaceSceneRoleBinding | PalaceSceneViewBinding | PalaceSceneActionBinding>) => void; onAdd: () => void }): React.JSX.Element {
  const update = (index: number, patch: Record<string, unknown>): void => onChange(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } as typeof row : row))
  const remove = (index: number): void => onChange(rows.filter((_, rowIndex) => rowIndex !== index))
  return <section className="palace-scene-builder-list" data-palace-scene-collection={collection}><div className="palace-scene-builder-list-header"><h3>{title} <small>{rows.length}</small></h3><button type="button" data-palace-scene-add={collection} onClick={onAdd}>新增</button></div>{rows.map((row, index) => <div className="palace-scene-builder-row" key={`${row.id}-${index}`}>
    <input aria-label={`${title} id`} value={row.id} onChange={(event) => update(index, { id: event.target.value })} />
    {collection === 'zones' && <><input aria-label="Zone title" value={(row as PalaceSceneZone).title} onChange={(event) => update(index, { title: event.target.value })} /><button type="button" onClick={() => remove(index)}>删除</button></>}
    {collection === 'roleBindings' && <><input aria-label="Role id" value={(row as PalaceSceneRoleBinding).roleId} onChange={(event) => update(index, { roleId: event.target.value })} /><input aria-label="Role zone" value={(row as PalaceSceneRoleBinding).zoneId} onChange={(event) => update(index, { zoneId: event.target.value })} /><EntityEditor row={row as PalaceSceneRoleBinding} onChange={(patch) => update(index, patch)} /><button type="button" onClick={() => remove(index)}>删除</button></>}
    {collection === 'viewBindings' && <><select aria-label="View kind" value={(row as PalaceSceneViewBinding).kind} onChange={(event) => update(index, { kind: event.target.value })}>{VIEW_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select><input aria-label="View zone" value={(row as PalaceSceneViewBinding).zoneId} onChange={(event) => update(index, { zoneId: event.target.value })} /><EntityEditor row={row as PalaceSceneViewBinding} onChange={(patch) => update(index, patch)} /><button type="button" onClick={() => remove(index)}>删除</button></>}
    {collection === 'actionBindings' && <><input aria-label="Action label" value={(row as PalaceSceneActionBinding).label} onChange={(event) => update(index, { label: event.target.value })} /><input aria-label="Action zone" value={(row as PalaceSceneActionBinding).zoneId} onChange={(event) => update(index, { zoneId: event.target.value })} /><select aria-label="Action command" value={(row as PalaceSceneActionBinding).commandId} onChange={(event) => update(index, { commandId: event.target.value })}>{PALACE_SCENE_COMMAND_IDS.map((command) => <option key={command}>{command}</option>)}</select><input aria-label="Action policy" value={(row as PalaceSceneActionBinding).policyId} onChange={(event) => update(index, { policyId: event.target.value })} /><EntityEditor row={row as PalaceSceneActionBinding} onChange={(patch) => update(index, patch)} /><button type="button" onClick={() => remove(index)}>删除</button></>}
  </div>)}</section>
}

function EntityEditor({ row, onChange }: { row: PalaceSceneRoleBinding | PalaceSceneViewBinding | PalaceSceneActionBinding; onChange: (patch: Record<string, unknown>) => void }): React.JSX.Element {
  return <span className="palace-scene-builder-entity"><select aria-label="Target kind" value={row.target.kind} onChange={(event) => onChange({ target: { ...row.target, kind: event.target.value } })}>{ENTITY_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select><input aria-label="Target id" value={row.target.id} onChange={(event) => onChange({ target: { ...row.target, id: event.target.value } })} /></span>
}
