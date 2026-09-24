import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Code2, Eye, Globe2 } from 'lucide-react'
import { useStore } from '../../store'
import { trackLocalSitePreview } from './local-site-preview-lifecycle'
import PreviewRenderer from './PreviewRenderer'
import './html-file-workspace.css'

interface Props {
  sessionId: string
  path: string
  content: string
  savedContent: string
  saving: boolean
  onSave(): Promise<{ ok: boolean; error?: string } | undefined>
  children: ReactNode
}
export default function HtmlFileWorkspace(props: Props): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [view, setView] = useState<'source' | 'static'>('source')
  const [draftPreview, setDraftPreview] = useState(true)
  const [chooseVersion, setChooseVersion] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const latest = useRef(props), mounted = useRef(true), request = useRef(0)
  latest.current = props
  const dirty = props.content !== props.savedContent
  const tr = (cn: string, en: string): string => zh ? cn : en
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++ } }, [])
  const openBrowser = async (save: boolean): Promise<void> => {
    if (busy || props.saving) return
    const identity = { sessionId: props.sessionId, path: props.path }, ticket = ++request.current
    const taskIdentity = (): string => {
      const meta = useStore.getState().sessions[identity.sessionId]?.meta
      return JSON.stringify(meta && [meta.id, meta.createdAt, meta.cwd, meta.workspaceId, meta.goalId, meta.workItemId])
    }
    const originalTask = taskIdentity()
    const current = (): boolean => mounted.current && request.current === ticket && latest.current.sessionId === identity.sessionId && latest.current.path === identity.path &&
      useStore.getState().activeId === identity.sessionId && useStore.getState().workbench.currentFilePath === identity.path && taskIdentity() === originalTask
    setBusy(true); setError('')
    try {
      if (save) {
        const result = await props.onSave()
        if (!result?.ok) throw new Error(result?.error || tr('文件尚未保存，未打开预览。', 'The file was not saved; preview was not opened.'))
      }
      if (!current()) return
      const site = await window.agentDesk.registerLocalSite({ sessionId: identity.sessionId, path: identity.path })
      if (!current()) return
      trackLocalSitePreview(identity.sessionId)
      const preview = await window.agentDesk.startLocalSitePreview(identity.sessionId, identity.path, site.taskKey)
      if (!current()) { await window.agentDesk.stopLocalSitePreview(identity.sessionId, preview.id); return }
      setChooseVersion(false)
      await useStore.getState().openBrowserPanel(preview.localUrl)
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (mounted.current && ticket === request.current) setBusy(false) }
  }
  return <div className="html-file-workspace" data-html-file-workspace={props.path}>
    <div className="html-file-toolbar">
      <div role="tablist" aria-label={tr('HTML 文件视图', 'HTML file view')} className="html-file-tabs">
        <button type="button" role="tab" aria-selected={view === 'source'} className={view === 'source' ? 'is-active' : ''} onClick={() => setView('source')}><Code2 size={14} />{tr('源码', 'Source')}</button>
        <button type="button" role="tab" aria-selected={view === 'static'} className={view === 'static' ? 'is-active' : ''} onClick={() => setView('static')}><Eye size={14} />{tr('静态预览', 'Static preview')}</button>
      </div>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy || props.saving} onClick={() => dirty ? setChooseVersion(true) : void openBrowser(false)}><Globe2 size={14} />{busy ? tr('正在准备…', 'Preparing…') : tr('浏览器预览', 'Browser preview')}</button>
    </div>
    {chooseVersion && <div className="html-preview-version" role="group" aria-label={tr('选择预览版本', 'Choose preview version')}>
      <p>{tr('文件有未保存的修改。浏览器预览使用磁盘上的文件。', 'This file has unsaved changes. Browser preview uses the file on disk.')}</p>
      <div><button type="button" className="btn btn-primary btn-sm" disabled={busy || props.saving} onClick={() => void openBrowser(true)}>{tr('保存并打开', 'Save and open')}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || props.saving} onClick={() => void openBrowser(false)}>{tr('打开磁盘版本', 'Open disk version')}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setChooseVersion(false)}>{tr('取消', 'Cancel')}</button></div>
    </div>}
    {error && <p role="alert" className="notice notice-error">{error}</p>}
    <div className="html-file-source" hidden={view !== 'source'}>{props.children}</div>
    {view === 'static' && <div className="html-file-static" role="tabpanel">
      <div className="html-preview-description"><span>{draftPreview && dirty ? tr('当前草稿 · 未保存', 'Current draft · unsaved') : tr('已加载的保存版本', 'Loaded saved version')}</span>
        {dirty && <select aria-label={tr('静态预览版本', 'Static preview version')} value={draftPreview ? 'draft' : 'saved'} onChange={event => setDraftPreview(event.target.value === 'draft')}><option value="draft">{tr('当前草稿', 'Current draft')}</option><option value="saved">{tr('已加载的保存版本', 'Loaded saved version')}</option></select>}
        <span>{tr('不运行脚本；完整交互请打开浏览器预览。', 'Scripts are disabled. Open browser preview for interactive behavior.')}</span></div>
      <PreviewRenderer preview={{ ok: true, type: 'html', path: props.path, content: draftPreview ? props.content : props.savedContent }} maxTextChars={2 * 1024 * 1024} />
    </div>}
    <p className="html-preview-hint">{tr('浏览器预览自动登记到“站点”。单 HTML 只包含该文件；使用相对 CSS、图片或脚本时，在“网站”中选择完整构建目录。', 'Browser preview registers this file in Sites. A single HTML includes only that file; choose the complete build directory in Sites for relative CSS, images or scripts.')}</p>
  </div>
}
