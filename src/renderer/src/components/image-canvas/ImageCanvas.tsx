import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronLeft, ChevronRight, Crop, Images, LoaderCircle, Minus, Plus, RefreshCw, X } from 'lucide-react'
import type { PreviewAnnotation } from '../../../../shared/types'
import type { TaskImageAsset, TaskImageCollection, TaskImageItem } from '../../../../shared/image-canvas-types'
import { useStore } from '../../store'
import { appendComposerDraft } from '../../store/composer-draft-inbox'
import { imageCanvasDraftAddition, normalizedImageBox, type NormalizedImageBox } from './image-canvas-model'
import './image-canvas.css'

export interface ImageCanvasProps { sessionId: string; initialAttachmentId?: string; onClose(): void; onDraftStaged?(): void }
export default function ImageCanvas({ sessionId, initialAttachmentId, onClose, onDraftStaged }: ImageCanvasProps): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh'), title = useStore(state => state.sessions[sessionId]?.meta.title)
  const [collection, setCollection] = useState<TaskImageCollection | null>(null), [focusId, setFocusId] = useState('')
  const [selected, setSelected] = useState<string[]>([]), [page, setPage] = useState(0), [asset, setAsset] = useState<TaskImageAsset | null>(null)
  const [annotations, setAnnotations] = useState<PreviewAnnotation[]>([]), [request, setRequest] = useState(''), [note, setNote] = useState('')
  const [box, setBox] = useState<NormalizedImageBox | undefined>(), [drawing, setDrawing] = useState(false), [zoom, setZoom] = useState(1)
  const [loading, setLoading] = useState(true), [imageLoading, setImageLoading] = useState(false), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [imageError, setImageError] = useState(''), [notice, setNotice] = useState('')
  const generation = useRef(0), actionBusy = useRef(false), start = useRef<{ x: number; y: number } | null>(null), dialog = useRef<HTMLElement>(null)
  const currentFocus = useRef(focusId)
  currentFocus.current = focusId
  const images = collection?.images ?? [], focused = images.find(item => item.id === focusId), pageImages = images.slice(page * 12, page * 12 + 12)
  const refresh = useCallback(async () => {
    const ticket = ++generation.current
    setLoading(true); setError('')
    try {
      const next = await window.agentDesk.listTaskImages(sessionId)
      if (ticket !== generation.current) return
      setCollection(next)
      setSelected(current => current.filter(id => next.images.some(item => item.id === id)))
      setFocusId(current => next.images.some(item => item.id === current) ? current : next.images.find(item => item.attachmentId === initialAttachmentId)?.id ?? next.images[0]?.id ?? '')
      setPage(0)
    } catch (error) { if (ticket === generation.current) setError(errorText(error)) }
    finally { if (ticket === generation.current) setLoading(false) }
  }, [sessionId, initialAttachmentId])
  useEffect(() => { void refresh(); return () => { generation.current++ } }, [refresh])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    return () => previous?.focus?.()
  }, [])
  useEffect(() => {
    if (!collection || !focusId) { setAsset(null); return }
    let live = true
    setAsset(null); setImageError(''); setImageLoading(true); setBox(undefined); setNote(''); setAnnotations([]); setZoom(1); start.current = null
    void Promise.all([window.agentDesk.readTaskImage(sessionId, collection.collectionId, focusId), window.agentDesk.listTaskImageAnnotations(sessionId, collection.collectionId, focusId)]).then(([preview, notes]) => {
      if (live) { setAsset(preview); setAnnotations(notes) }
    }).catch(error => { if (live) setImageError(errorText(error)) }).finally(() => { if (live) setImageLoading(false) })
    return () => { live = false }
  }, [collection, focusId, sessionId])
  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : current.length < 16 ? [...current, id] : current)
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height }
  }
  const saveNote = async () => {
    if (!collection || !focused || !asset || !note.trim() || actionBusy.current) return
    actionBusy.current = true; setBusy(true); setError(''); setNotice('')
    const ticket = generation.current, imageId = focused.id
    try {
      const annotation = await window.agentDesk.saveTaskImageAnnotation(sessionId, collection.collectionId, imageId, { note, boundingBox: box })
      if (ticket !== generation.current || currentFocus.current !== imageId) return
      setAnnotations(current => [annotation, ...current]); setNote(''); setBox(undefined)
      setSelected(current => current.includes(imageId) || current.length >= 16 ? current : [...current, imageId])
      setNotice(zh ? '批注已保存到这张图片。' : 'Annotation saved to this image.')
    } catch (error) { if (ticket === generation.current) setError(errorText(error)) }
    finally { actionBusy.current = false; if (ticket === generation.current) setBusy(false) }
  }
  const stageDraft = async () => {
    if (!collection || !selected.length || actionBusy.current) return
    if (note.trim()) { setError(zh ? '请先保存或清空当前批注。' : 'Save or clear the current annotation first.'); return }
    actionBusy.current = true; setBusy(true); setError(''); setNotice('')
    const ticket = generation.current, originalActive = useStore.getState().activeId
    const originalBinding = rendererBinding(useStore.getState().sessions[sessionId]?.meta)
    try {
      const notes = Object.fromEntries(await Promise.all(selected.map(async id => [id, await window.agentDesk.listTaskImageAnnotations(sessionId, collection.collectionId, id)] as const)))
      if (!request.trim() && !Object.values(notes).some(items => items.length)) throw new Error(zh ? '请填写编辑要求或添加图片批注。' : 'Add edit instructions or an image annotation.')
      const draft = await window.agentDesk.prepareTaskImageDraft(sessionId, collection.collectionId, selected)
      if (ticket !== generation.current) return
      const state = useStore.getState(), meta = state.sessions[sessionId]?.meta
      if (!meta || meta.status === 'closed' || draft.sessionId !== sessionId || draft.taskKey !== collection.taskKey || state.activeId !== originalActive || rendererBinding(meta) !== originalBinding) throw new Error(zh ? '任务已关闭或你已切换任务，未加入草稿。' : 'The task closed or the selection changed. Draft was not updated.')
      appendComposerDraft(sessionId, imageCanvasDraftAddition(draft, request, notes, zh))
      setNotice(zh ? '图片与编辑要求已加入原任务草稿。' : 'Images and instructions added to the original task draft.')
      onDraftStaged?.()
    } catch (error) { if (ticket === generation.current) setError(errorText(error)) }
    finally { actionBusy.current = false; if (ticket === generation.current) setBusy(false) }
  }
  return createPortal(<div className="image-canvas-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="image-canvas-title" className="image-canvas" data-image-canvas={sessionId} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onClose() }
      if (event.key === 'Tab') {
        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
        const first = focusable[0], last = focusable.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <header className="image-canvas-header"><div><h2 id="image-canvas-title"><Images size={18} />{zh ? '图片工作台' : 'Image workspace'}</h2><span>{title ?? sessionId} · {images.length} {zh ? '张图片' : 'images'}</span></div>
        <div className="image-canvas-actions"><button className="btn btn-ghost btn-sm" disabled={busy || loading} aria-label={zh ? '刷新图片' : 'Refresh images'} onClick={() => void refresh()}><RefreshCw size={16} /></button><button className="btn btn-ghost btn-sm" disabled={busy} aria-label={zh ? '关闭图片工作台' : 'Close image workspace'} onClick={onClose}><X size={18} /></button></div></header>
      {error && <div role="alert" className="image-canvas-error">{error}</div>}
      {notice && <div role="status" className="image-canvas-notice">{notice}</div>}
      {collection?.warnings.map(warning => <div className="image-canvas-notice" key={warning}>{warning}</div>)}
      {loading && !collection ? <div className="image-canvas-empty"><LoaderCircle size={22} />{zh ? '正在读取任务图片…' : 'Loading task images…'}</div> : images.length === 0 ? <div className="image-canvas-empty">{zh ? '这个任务还没有上传图片或登记图片成果。' : 'No uploaded images or registered image artifacts in this task.'}</div> : <div className="image-canvas-body">
        <aside className="image-canvas-gallery"><div className="image-canvas-gallery-heading"><strong>{zh ? '任务图片' : 'Task images'}</strong><span>{selected.length}/16 {zh ? '已选' : 'selected'}</span></div>
          <div className="image-canvas-grid">{pageImages.map(item => <ImageTile key={`${collection!.collectionId}:${item.id}`} item={item} sessionId={sessionId} collectionId={collection!.collectionId} selected={selected.includes(item.id)} focused={focusId === item.id} disabled={busy} selectionFull={selected.length >= 16} onFocus={() => { setFocusId(item.id); setNotice('') }} onToggle={() => toggle(item.id)} zh={zh} />)}</div>
          {images.length > 12 && <div className="image-canvas-pagination"><button className="btn btn-ghost btn-sm" disabled={page === 0 || busy} onClick={() => setPage(value => value - 1)} aria-label={zh ? '上一页图片' : 'Previous images'}><ChevronLeft size={16} /></button><span>{page + 1} / {Math.ceil(images.length / 12)}</span><button className="btn btn-ghost btn-sm" disabled={(page + 1) * 12 >= images.length || busy} onClick={() => setPage(value => value + 1)} aria-label={zh ? '下一页图片' : 'Next images'}><ChevronRight size={16} /></button></div>}
        </aside>
        <main className="image-canvas-main"><div className="image-canvas-toolbar"><strong title={focused?.sourcePath}>{focused?.title}</strong><div><button className="btn btn-ghost btn-sm" aria-pressed={drawing} disabled={!asset || busy} onClick={() => { setDrawing(value => !value); setBox(undefined) }}><Crop size={15} />{zh ? '框选区域' : 'Select region'}</button><button className="btn btn-ghost btn-sm" disabled={zoom <= .5 || !asset} aria-label={zh ? '缩小' : 'Zoom out'} onClick={() => setZoom(value => Math.max(.5, value - .25))}><Minus size={15} /></button><span>{Math.round(zoom * 100)}%</span><button className="btn btn-ghost btn-sm" disabled={zoom >= 3 || !asset} aria-label={zh ? '放大' : 'Zoom in'} onClick={() => setZoom(value => Math.min(3, value + .25))}><Plus size={15} /></button></div></div>
          <div className="image-canvas-viewport">{imageError ? <div className="image-canvas-empty" role="alert">{imageError}</div> : imageLoading ? <div className="image-canvas-empty">{zh ? '正在核对图片…' : 'Verifying image…'}</div> : asset && <div className={`image-canvas-plane ${drawing ? 'is-drawing' : ''}`} style={{ width: `${zoom * 100}%` }}>
            <img src={asset.dataUrl} alt={focused?.title ?? ''} draggable={false} data-image-canvas-preview />
            <div className="image-canvas-overlay" data-image-canvas-region onPointerDown={event => { if (!drawing || busy || event.button !== 0) return; event.preventDefault(); start.current = point(event); setBox(undefined); event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={event => { if (start.current) setBox(normalizedImageBox(start.current, point(event))) }} onPointerUp={event => { if (!start.current) return; const next = normalizedImageBox(start.current, point(event)); start.current = null; setBox(next.width > .002 && next.height > .002 ? next : undefined); event.currentTarget.releasePointerCapture(event.pointerId) }} onPointerCancel={() => { start.current = null; setBox(undefined) }}>
              {annotations.map((value, index) => value.boundingBox ? <div className="image-canvas-saved-region" key={value.id} style={boxStyle(value.boundingBox!)} title={value.note}><span>{index + 1}</span></div> : null)}
              {box && <div className="image-canvas-selection" style={boxStyle(box)} />}
            </div>
          </div>}</div>
          <div className="image-canvas-image-meta">{asset ? `${asset.width} × ${asset.height}` : ''}{focused?.version ? ` · v${focused.version}` : ''}{drawing && <span>{zh ? '在图片上拖动框选，随后填写区域批注。' : 'Drag on the image, then add an annotation.'}</span>}</div>
        </main>
        <aside className="image-canvas-notes"><h3>{zh ? '图片批注' : 'Image annotations'}</h3><p>{box ? (zh ? '批注作用于框选区域。' : 'This note applies to the selected region.') : (zh ? '批注作用于整张图片。' : 'This note applies to the whole image.')}</p>
          <textarea className="input" value={note} maxLength={8000} disabled={!asset || busy} onChange={event => setNote(event.target.value)} placeholder={zh ? '例如：这里的标题改成深蓝色' : 'For example: change this heading to dark blue'} aria-label={zh ? '图片批注内容' : 'Image annotation'} data-image-canvas-note />
          <div className="image-canvas-actions"><button className="btn btn-ghost btn-sm" disabled={busy || !box} onClick={() => setBox(undefined)}>{zh ? '清除框选' : 'Clear region'}</button><button className="btn btn-primary btn-sm" disabled={busy || loading || !asset || !note.trim()} onClick={() => void saveNote()} data-image-canvas-save-note>{zh ? '保存批注' : 'Save annotation'}</button></div>
          <div className="image-canvas-annotation-list">{annotations.map((annotation, index) => <article key={annotation.id}><strong>{index + 1}. {annotation.boundingBox ? (zh ? '区域批注' : 'Region note') : (zh ? '整图批注' : 'Image note')}</strong><p>{annotation.note}</p></article>)}</div>
        </aside>
      </div>}
      <footer className="image-canvas-footer"><label>{zh ? '对所选图片的编辑要求' : 'Edit instructions for selected images'}<textarea className="input" rows={2} value={request} maxLength={16000} disabled={busy} onChange={event => setRequest(event.target.value)} placeholder={zh ? '例如：统一成暖色调，保留人物和构图' : 'For example: use warmer colors and preserve the composition'} data-image-canvas-request /></label><button className="btn btn-primary" disabled={busy || loading || selected.length === 0} onClick={() => void stageDraft()} data-image-canvas-stage>{busy ? <LoaderCircle size={16} /> : <Check size={16} />}{zh ? `加入原任务草稿 (${selected.length})` : `Add to task draft (${selected.length})`}</button></footer>
    </section>
  </div>, document.body)
}
function ImageTile({ item, sessionId, collectionId, selected, focused, disabled, selectionFull, onFocus, onToggle, zh }: { item: TaskImageItem; sessionId: string; collectionId: string; selected: boolean; focused: boolean; disabled: boolean; selectionFull: boolean; onFocus(): void; onToggle(): void; zh: boolean }): React.JSX.Element {
  const [src, setSrc] = useState(''), [error, setError] = useState(item.unavailableReason ?? '')
  useEffect(() => { let live = true; if (!item.unavailableReason) void window.agentDesk.readTaskImage(sessionId, collectionId, item.id, true).then(asset => { if (live) setSrc(asset.dataUrl) }).catch(error => { if (live) setError(errorText(error)) }); return () => { live = false } }, [item.id, item.unavailableReason, sessionId, collectionId])
  return <div className={`image-canvas-tile ${focused ? 'is-focused' : ''}`} data-image-canvas-item={item.id}><button className="image-canvas-thumbnail" disabled={disabled} onClick={onFocus} title={error || item.title}>{src ? <img src={src} alt={item.title} draggable={false} /> : <span>{error ? (zh ? '无法预览' : 'Unavailable') : (zh ? '读取中…' : 'Loading…')}</span>}</button><label><input type="checkbox" checked={selected} disabled={disabled || Boolean(error) || !src || !selected && selectionFull} onChange={onToggle} aria-label={`${zh ? '选择' : 'Select'} ${item.title}`} /><span title={item.title}>{item.title}</span></label></div>
}
function boxStyle(box: NormalizedImageBox): React.CSSProperties { return { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` } }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function rendererBinding(meta: import('../../../../shared/types').SessionMeta | undefined): string { return JSON.stringify(meta ? [meta.id, meta.createdAt, meta.cwd, meta.sdkSessionId, meta.workspaceId ?? meta.projectId, meta.goalId, meta.workItemId] : null) }
