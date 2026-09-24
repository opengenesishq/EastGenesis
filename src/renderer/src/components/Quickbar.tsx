import { useEffect, useRef, useState } from 'react'
import { Clipboard, FilePlus2, FolderOpen, ImagePlus, Plus, RotateCw, Settings2, X } from 'lucide-react'
import { useStore } from '../store'
import type { QuickbarDispatchOptions, QuickbarDispatchResult, QuickbarState, QuickbarTargetMode, QuickbarWindowContext } from '../../../shared/types'
import { normalizeQuickbarSettings } from '../../../shared/quickbar-settings'
import './quickbar.css'

function splitPaths(text: string): string[] { return text.split(/\r?\n/).map(value => value.trim()).filter(Boolean) }

export default function Quickbar(): React.JSX.Element | null {
  const activeId = useStore(state => state.activeId)
  const sessions = useStore(state => state.sessions)
  const zh = useStore(state => state.settings.language === 'zh')
  const [visible, setVisible] = useState(false)
  const [target, setTarget] = useState<QuickbarTargetMode>('new')
  const [targetId, setTargetId] = useState<string | null>(null)
  const [cwd, setCwd] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [windows, setWindows] = useState<QuickbarWindowContext[]>([])
  const [contextLoading, setContextLoading] = useState(false)
  const [sourceRefresh, setSourceRefresh] = useState(0)
  const [includeOcr, setIncludeOcr] = useState(false)
  const [state, setState] = useState<QuickbarState>()
  const [paths, setPaths] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const shown = useRef(false)
  const openingRevision = useRef(0)
  const inFlight = useRef(false)
  const targetSession = targetId ? sessions[targetId] : undefined
  const selectedSource = windows.find(item => item.id === sourceId)
  const targetReady = target === 'new' ? Boolean(cwd.trim()) : Boolean(targetSession && targetSession.meta.status !== 'closed')

  useEffect(() => {
    let disposed = false
    const applyVisible = (next: boolean): void => {
      if (disposed) return
      if (next && !shown.current) {
        openingRevision.current++
        const current = useStore.getState()
        const config = normalizeQuickbarSettings(current.settings.quickbar)
        const candidate = current.activeId ? current.sessions[current.activeId] : undefined
        const currentId = current.activeId && !current.showNewSession && candidate && candidate.meta.status !== 'closed' ? current.activeId : null
        const projectId = current.welcomeDraft.projectChoice ?? current.newSessionProjectId
        const projectCwd = current.projects.find(project => project.id === projectId)?.path
        setTarget(config.defaultTarget === 'new' || (config.defaultTarget === 'auto' && !currentId) ? 'new' : 'current')
        setTargetId(currentId)
        setCwd(currentId ? current.sessions[currentId].meta.cwd : projectCwd || current.welcomeDraft.cwd || '')
        setIncludeOcr(config.includeOcr)
        setSourceId(''); setWindows([]); setError(''); setMessage('')
      }
      shown.current = next
      setVisible(next)
    }
    void window.agentDesk.quickbarGetState().then(value => { if (!disposed) { setState(value); applyVisible(value.visible) } }).catch(() => undefined)
    const off = window.agentDesk.onQuickbarEvent(event => applyVisible(event.visible))
    return () => { disposed = true; off() }
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setContextLoading(true)
    void window.agentDesk.quickbarGetWindowContext().then(result => {
      if (cancelled) return
      if (!result.ok) throw new Error(result.error || (zh ? '无法列出截图来源。' : 'Could not list capture sources.'))
      setWindows(result.windows)
      setSourceId('')
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (!cancelled) setContextLoading(false) })
    return () => { cancelled = true }
  }, [visible, sourceRefresh])

  const close = (): void => {
    if (inFlight.current) return
    void window.agentDesk.quickbarSetVisible(false).catch(cause => setError(String(cause)))
  }
  useEffect(() => {
    if (!visible) return
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); close() } }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [visible])

  const options: QuickbarDispatchOptions = {
    target, sessionId: target === 'current' ? targetId ?? undefined : undefined,
    cwd: target === 'new' ? cwd.trim() : targetSession?.meta.cwd,
    sourceId: selectedSource?.id, expectedSourceName: selectedSource?.name,
    includeOcr, note: note.trim() || undefined
  }
  const run = async (key: string, action: () => Promise<QuickbarDispatchResult | undefined>): Promise<void> => {
    if (inFlight.current || !targetReady) return
    inFlight.current = true; setBusy(key); setError(''); setMessage('')
    const revision = openingRevision.current
    try {
      const result = await action()
      if (openingRevision.current !== revision) return
      if (result?.sessionId) { setTarget('current'); setTargetId(result.sessionId) }
      if (!result?.ok) throw new Error(result?.error || (zh ? '未能加入草稿。' : 'Could not add to the draft.'))
      setPaths(''); setNote(''); setSourceId('')
      if (result.warning) setMessage(`${zh ? '内容已加入目标草稿，尚未发送。' : 'Added to the destination draft; not sent.'} ${result.warning}`)
      else await window.agentDesk.quickbarSetVisible(false)
    } catch (cause) { if (openingRevision.current === revision) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { inFlight.current = false; setBusy(null) }
  }
  const pickDirectory = async (): Promise<void> => {
    try { const chosen = await window.agentDesk.pickDirectory(); if (chosen) setCwd(chosen) }
    catch (cause) { setError(String(cause)) }
  }
  const pickFiles = async (): Promise<void> => {
    try { const chosen = await window.agentDesk.quickbarPickFiles(); if (chosen.length) setPaths(chosen.join('\n')) }
    catch (cause) { setError(String(cause)) }
  }
  if (!visible) return null
  return <div className="quickbar-backdrop" onMouseDown={close}>
    <section className="quickbar quickbar-draft" role="dialog" aria-modal="true" aria-labelledby="quickbar-title" aria-busy={Boolean(busy)} onMouseDown={event => event.stopPropagation()}>
      <header className="quickbar-head"><div><h2 id="quickbar-title">{zh ? '快捷输入' : 'Quick input'}</h2><p>{zh ? '加入任务草稿，检查后再发送。' : 'Add to a task draft, then review and send.'}</p></div>
        <div className="quickbar-head-actions"><button type="button" className="icon-btn" disabled={Boolean(busy)} aria-label={zh ? '截图设置' : 'Capture settings'} onClick={() => { close(); useStore.getState().setShowSettings(true, 'appshots') }}><Settings2 size={16} /></button><button type="button" className="icon-btn" disabled={Boolean(busy)} aria-label={zh ? '关闭快捷输入' : 'Close quick input'} onClick={close}><X size={17} /></button></div>
      </header>
      <div className="quickbar-targets" role="group" aria-label={zh ? '目标任务' : 'Destination task'}>
        <button type="button" className={`quickbar-segment ${target === 'current' ? 'active' : ''}`} aria-pressed={target === 'current'} disabled={Boolean(busy)} onClick={() => { setTarget('current'); setTargetId(activeId) }}>{zh ? '继续当前任务' : 'Continue current task'}</button>
        <button type="button" className={`quickbar-segment ${target === 'new' ? 'active' : ''}`} aria-pressed={target === 'new'} disabled={Boolean(busy)} onClick={() => setTarget('new')}>{zh ? '新建任务' : 'New task'}</button>
      </div>
      {target === 'current' ? <p className="quickbar-destination" data-quickbar-target={targetId ?? ''}>
        {targetSession ? <><strong>{targetSession.meta.title}</strong><span>{targetSession.meta.cwd}</span></> : (zh ? '没有选中的任务，请选择新建任务。' : 'No task is selected. Choose a new task.')}
        {targetId && targetId !== activeId && <small>{zh ? '目标仍为上面所选任务，未随页面切换。' : 'The destination remains fixed despite navigation.'}</small>}
      </p> : <label className="quickbar-field">{zh ? '新任务工作目录' : 'New task working folder'}<div className="quickbar-folder"><input className="quickbar-input" value={cwd} disabled={Boolean(busy)} placeholder={zh ? '选择工作目录' : 'Choose a working folder'} onChange={event => setCwd(event.target.value)} /><button type="button" className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => void pickDirectory()}><FolderOpen size={15} />{zh ? '选择' : 'Browse'}</button></div></label>}
      <label className="quickbar-field">{zh ? '任务内容或补充说明' : 'Task or additional instructions'}<textarea className="quickbar-input quickbar-note" rows={3} autoFocus value={note} disabled={Boolean(busy)} placeholder={zh ? '想完成什么？' : 'What would you like to do?'} onChange={event => setNote(event.target.value)} /></label>
      <div className="quickbar-actions"><button type="button" className="btn btn-primary" disabled={Boolean(busy) || !targetReady || !note.trim()} onClick={() => void run('text', () => useStore.getState().sendQuickbarText(options))}><Plus size={15} />{zh ? '加入草稿' : 'Add to draft'}</button><button type="button" className="btn btn-ghost" disabled={Boolean(busy) || !targetReady} onClick={() => void run('clipboard', () => useStore.getState().sendQuickbarClipboard(options))}><Clipboard size={15} />{zh ? '从剪贴板加入' : 'Add clipboard text'}</button></div>
      <details className="quickbar-attachments" open><summary>{zh ? '截图与文件' : 'Screenshots and files'}</summary>
        <label className="quickbar-field">{zh ? '截图来源' : 'Capture source'}<div className="quickbar-folder"><select className="quickbar-input" value={sourceId} disabled={Boolean(busy) || contextLoading} onChange={event => setSourceId(event.target.value)}><option value="">{contextLoading ? (zh ? '正在读取来源…' : 'Loading sources…') : (zh ? '选择一个窗口或屏幕' : 'Choose a window or screen')}</option>{windows.map(item => <option key={item.id} value={item.id}>{item.kind === 'screen' ? (zh ? '屏幕' : 'Screen') : (zh ? '窗口' : 'Window')} · {item.name}</option>)}</select><button type="button" className="icon-btn" aria-label={zh ? '刷新截图来源' : 'Refresh capture sources'} disabled={Boolean(busy) || contextLoading} onClick={() => setSourceRefresh(value => value + 1)}><RotateCw size={15} /></button></div></label>
        <div className="quickbar-capture-row"><label><input type="checkbox" checked={includeOcr} disabled={Boolean(busy)} onChange={event => setIncludeOcr(event.target.checked)} />{zh ? '识别这张截图中的文字' : 'Recognize text in this screenshot'}</label><button type="button" className="btn btn-ghost" disabled={Boolean(busy) || !targetReady || !selectedSource || contextLoading} onClick={() => void run('screenshot', () => useStore.getState().sendQuickbarScreenshot(options))}><ImagePlus size={15} />{busy === 'screenshot' ? (zh ? '截图中…' : 'Capturing…') : (zh ? '截图并加入草稿' : 'Capture to draft')}</button></div>
        {selectedSource?.kind === 'screen' && <p className="quickbar-help">{zh ? '整屏截图会包含屏幕上可见的 EastGenesis 窗口；只需某个应用时，请选择该应用窗口。' : 'A screen capture includes any visible EastGenesis window. Choose an application window to capture only that app.'}</p>}
        <label className="quickbar-field">{zh ? '文件或目录路径' : 'File or folder paths'}<textarea className="quickbar-input quickbar-paths" rows={2} value={paths} disabled={Boolean(busy)} placeholder={zh ? '拖入文件，或每行输入一个路径' : 'Drop files or enter one path per line'} onChange={event => setPaths(event.target.value)} onDragOver={event => event.preventDefault()} onDrop={event => {
          event.preventDefault(); if (inFlight.current) return
          const dropped = [...event.dataTransfer.files].flatMap(file => { try { const path = window.agentDesk.pathForFile(file); return path ? [path] : [] } catch { return [] } })
          if (dropped.length) setPaths(dropped.join('\n'))
        }} /></label>
        <div className="quickbar-actions"><button type="button" className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => void pickFiles()}><FolderOpen size={15} />{zh ? '选择文件' : 'Choose files'}</button><button type="button" className="btn btn-ghost" disabled={Boolean(busy) || !targetReady || !splitPaths(paths).length} onClick={() => void run('files', () => useStore.getState().sendQuickbarFiles({ ...options, paths: splitPaths(paths) }))}><FilePlus2 size={15} />{zh ? '加入文件路径' : 'Add file paths'}</button></div>
      </details>
      {error && <div className="quickbar-status quickbar-error" role="alert">{error}</div>}
      {message && <div className="quickbar-status" role="status">{message}</div>}
      <p className="quickbar-help">{state?.accelerator}{busy ? (zh ? ' · 正在准备草稿…' : ' · Preparing draft…') : ''}</p>
    </section>
  </div>
}
