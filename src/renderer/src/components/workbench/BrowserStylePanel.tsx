import { useEffect, useRef, useState } from 'react'
import type { BrowserTabTarget } from '../../../../shared/browser-tab-types'
import { BROWSER_STYLE_CSS_PROPERTIES, BROWSER_STYLE_RANGES, type BrowserStyleChanges, type BrowserStylePreview, type BrowserStyleProperty } from '../../../../shared/browser-style-types'
import { useStore } from '../../store'
import { targetForBrowserState } from '../../store/browser-tab-state'
import { appendPersistentComposerDraft } from '../../store/composer-draft-persistence'
import './browser-style-panel.css'

type Fields = Partial<Record<BrowserStyleProperty, string>>
const names: Record<BrowserStyleProperty, [string, string]> = {
  fontFamily: ['字体', 'Font'], fontSize: ['字号', 'Size'], fontWeight: ['字重', 'Weight'], lineHeight: ['行高', 'Line height'], letterSpacing: ['字间距', 'Letter spacing'],
  color: ['文字颜色', 'Text color'], backgroundColor: ['背景颜色', 'Background'],
  marginTop: ['上', 'Top'], marginRight: ['右', 'Right'], marginBottom: ['下', 'Bottom'], marginLeft: ['左', 'Left'],
  paddingTop: ['上', 'Top'], paddingRight: ['右', 'Right'], paddingBottom: ['下', 'Bottom'], paddingLeft: ['左', 'Left']
}
function sameTarget(left: BrowserTabTarget | undefined, right: BrowserTabTarget): boolean {
  return !!left && left.contextId === right.contextId && left.contextEpoch === right.contextEpoch && left.tabId === right.tabId &&
    left.selectionRevision === right.selectionRevision && left.navigationRevision === right.navigationRevision
}
function fieldsFor(preview: BrowserStylePreview): Fields {
  return Object.fromEntries(Object.entries(preview.values).map(([key, value]) => [key, String(value)]))
}
function changesFor(fields: Fields): BrowserStyleChanges {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value?.trim()).map(([name, value]) =>
    [name, name === 'fontFamily' || name === 'color' || name === 'backgroundColor' ? value!.trim() : Number(value)])) as BrowserStyleChanges
}

/** Mounted only while visible; keyed by complete task/tab/document identity. */
export default function BrowserStylePanel({ target }: { target: BrowserTabTarget }): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [preview, setPreview] = useState<BrowserStylePreview>()
  const [fields, setFields] = useState<Fields>({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const alive = useRef(true), operation = useRef(false), id = useRef<string | undefined>(undefined), selected = useRef<BrowserStylePreview | undefined>(undefined)
  const label = (cn: string, en: string): string => zh ? cn : en
  const current = (): boolean => {
    const state = useStore.getState()
    return alive.current && state.activeId === target.contextId && !state.showNewSession && !!state.sessions[target.contextId] && state.sessions[target.contextId].meta.status !== 'closed' &&
      state.workbench.activePanelId === 'browser' && sameTarget(targetForBrowserState(state.workbench.browserState), target)
  }
  const release = (previewId: string): Promise<void> => window.agentDesk.releaseBrowserStylePreview({ previewId, target })
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; if (id.current) void release(id.current).catch(() => undefined) }
  }, [])
  useEffect(() => {
    if (!preview) return
    const timer = window.setTimeout(() => {
      if (!current()) return
      if (id.current) void release(id.current).catch(() => undefined)
      id.current = undefined; selected.current = undefined; setPreview(undefined); setFields({})
      setMessage(label('预览已到期并撤回，请重新选择元素。', 'Preview expired and was reverted. Select the element again.'))
    }, Math.max(0, preview.expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [preview?.id, preview?.expiresAt])

  const pick = async (): Promise<void> => {
    if (operation.current || !current()) return
    operation.current = true; setBusy('pick'); setError(''); setMessage('')
    try {
      if (id.current) await release(id.current)
      if (!current()) return
      const nextId = crypto.randomUUID()
      id.current = nextId; selected.current = undefined; setPreview(undefined); setFields({})
      const result = await window.agentDesk.pickBrowserStyleTarget(target, nextId)
      if (!current() || id.current !== nextId) { await release(nextId); return }
      if (result.cancelled) { id.current = undefined; setMessage(label('已取消选择。', 'Selection cancelled.')); return }
      selected.current = result.preview; setPreview(result.preview); setFields(fieldsFor(result.preview))
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { operation.current = false; if (current()) setBusy('') }
  }
  const cancel = async (): Promise<void> => {
    if (!id.current) return
    const pendingId = id.current; id.current = undefined
    try { await release(pendingId) } catch (cause) { if (current()) setError(String(cause)) }
  }
  const perform = async (kind: 'preview' | 'revert' | 'draft'): Promise<void> => {
    const before = selected.current
    if (operation.current || !before || !current()) return
    operation.current = true; setBusy(kind); setError(''); setMessage('')
    const input = { previewId: before.id, target, expectedRevision: before.revision }
    try {
      if (kind === 'draft') {
        const draft = await window.agentDesk.getBrowserStyleDraft(input)
        if (!current() || selected.current?.id !== before.id || selected.current.revision !== before.revision || draft.sessionId !== target.contextId) return
        const result = appendPersistentComposerDraft(window.localStorage, draft.sessionId, draft.text, draft.deliveryId)
        setMessage(result.duplicate ? label('这版修改已在任务草稿中。', 'This revision is already in the task draft.') : label('已加入当前任务草稿，可编辑后发送。', 'Added to the current task draft. Review it before sending.'))
      } else {
        const next = kind === 'preview' ? await window.agentDesk.previewBrowserStyles({ ...input, changes: changesFor(fields) }) : await window.agentDesk.revertBrowserStyles(input)
        if (!current() || id.current !== before.id) return
        selected.current = next; setPreview(next); setFields(fieldsFor(next))
        if (kind === 'revert') setMessage(next.conflicts.length ? label('已撤回预览；网页自行修改过的属性予以保留。请重新选择。', 'Preview reverted. Changes made by the page were preserved. Select again.') : label('已撤回临时样式。', 'Temporary styles reverted.'))
      }
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { operation.current = false; if (current()) setBusy('') }
  }
  const field = (property: BrowserStyleProperty): React.JSX.Element => {
    const range = BROWSER_STYLE_RANGES[property], color = property === 'color' || property === 'backgroundColor'
    return <label className="browser-style-field" key={property}>
      <span>{names[property][zh ? 0 : 1]}{range && property !== 'fontWeight' ? ' (px)' : ''}</span>
      <input className="input" type={color ? 'text' : 'number'} value={fields[property] ?? ''} min={range?.[0]} max={range?.[1]} step={property === 'fontWeight' ? 100 : 0.1}
        placeholder={color ? '#RRGGBB' : preview?.computed[property]} maxLength={color ? 9 : undefined}
        title={preview ? `${label('当前', 'Current')}: ${preview.computed[property]}` : undefined}
        onChange={event => setFields(value => ({ ...value, [property]: event.target.value }))} />
    </label>
  }
  const disabled = !!busy || !preview || preview.status === 'conflict'
  const pendingChanges = preview && JSON.stringify(changesFor(fields)) !== JSON.stringify(preview.values)
  return <aside id="browser-style-adjuster" className="browser-style-panel no-drag" aria-label={label('网页样式调整', 'Page style adjustment')}>
    <div className="browser-style-heading"><strong>{label('样式调整', 'Style adjustment')}</strong><p>{label('仅预览当前网页，未保存源码。关闭面板或切换页面将撤回预览。', 'Preview only; source files are unchanged. Closing this panel or changing pages reverts the preview.')}</p></div>
    <div className="browser-style-actions">
      <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void pick()}>{busy === 'pick' ? label('点击网页中的元素…', 'Click an element…') : label(preview ? '重新选择元素' : '选择网页元素', preview ? 'Select another element' : 'Select page element')}</button>
      {busy === 'pick' && <button className="btn btn-ghost btn-sm" onClick={() => void cancel()}>{label('取消', 'Cancel')}</button>}
    </div>
    {busy === 'pick' && <p className="browser-style-hint">{label('移动鼠标查看边框，点击确认。Esc 取消。', 'Move to inspect, click to select. Esc cancels.')}</p>}
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {message && <div className="notice notice-info" role="status">{message}</div>}
    {preview && <>
      <code className="browser-style-selector" title={preview.selector}>{preview.selector}</code>
      <fieldset disabled={disabled} className="browser-style-fields"><legend>{label('字体与颜色', 'Typography & colors')}</legend>
        <label className="browser-style-field"><span>{label('字体', 'Font')}</span><select className="input" value={fields.fontFamily ?? ''} onChange={event => setFields(value => ({ ...value, fontFamily: event.target.value }))}>
          <option value="">{label('沿用网页', 'Page default')}</option><option value="system">{label('系统字体', 'System')}</option><option value="sans">{label('无衬线', 'Sans serif')}</option><option value="serif">{label('衬线', 'Serif')}</option><option value="mono">{label('等宽', 'Monospace')}</option>
        </select></label>
        {(['fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color', 'backgroundColor'] as BrowserStyleProperty[]).map(field)}
      </fieldset>
      {(['margin', 'padding'] as const).map(prefix => <fieldset key={prefix} disabled={disabled} className="browser-style-fields"><legend>{prefix === 'margin' ? label('外边距', 'Margin') : label('内边距', 'Padding')}</legend>
        {(['Top', 'Right', 'Bottom', 'Left'] as const).map(side => field(`${prefix}${side}`))}
      </fieldset>)}
      <p className="browser-style-hint">{label('留空即保留原样；清空已调整字段后预览，可恢复该项。', 'Leave blank to preserve the original. Clear an edited field and preview to restore it.')}</p>
      <div className="browser-style-actions"><button className="btn btn-primary btn-sm" disabled={disabled} onClick={() => void perform('preview')}>{label('预览修改', 'Preview')}</button>
        <button className="btn btn-ghost btn-sm" disabled={!!busy || !preview.changes.length} onClick={() => void perform('revert')}>{label('撤回', 'Revert')}</button></div>
      {preview.changes.length > 0 && <div className="browser-style-changes"><strong>{label('当前预览改动', 'Preview changes')}</strong>{preview.changes.map(change => <div key={change.property}><code>{BROWSER_STYLE_CSS_PROPERTIES[change.property]}</code><span>{change.before || '—'} → {change.after}</span></div>)}</div>}
      {pendingChanges && <p className="browser-style-hint">{label('字段已修改，请先预览再加入草稿。', 'Fields changed. Preview them before adding to the draft.')}</p>}
      <button className="btn btn-ghost btn-sm browser-style-draft" disabled={!!busy || !!pendingChanges || preview.status !== 'previewing' || !preview.changes.length} onClick={() => void perform('draft')}>{label('加入当前任务草稿', 'Add to current task draft')}</button>
    </>}
  </aside>
}
