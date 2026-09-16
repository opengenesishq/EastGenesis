import { useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2, Undo2 } from 'lucide-react'
import type { OfficeArtifactSnapshot, OfficeRevisionOperation, OfficeSlideSequenceEntry } from '../../../../../shared/office-revision-types'

export default function OfficeSlideSequenceEditor({ snapshot, busy, onChange, onPreview }: {
  snapshot: OfficeArtifactSnapshot; busy: boolean; onChange(): void; onPreview(operation: OfficeRevisionOperation): Promise<void>
}): React.JSX.Element {
  const initial = () => snapshot.slides?.map(slide => ({ slideId: slide.id })) ?? []
  const [slides, setSlides] = useState<OfficeSlideSequenceEntry[]>(initial)
  const [error, setError] = useState('')
  const editable = snapshot.slideSequence?.editable && snapshot.editability.editable && snapshot.artifact.latest
  const disabled = busy || !editable
  const update = (next: OfficeSlideSequenceEntry[]) => { setSlides(next); setError(''); onChange() }
  const move = (index: number, offset: number) => {
    const next = [...slides]
    ;[next[index], next[index + offset]] = [next[index + offset], next[index]]
    update(next)
  }
  const preview = async () => {
    try {
      if (!snapshot.slideSequence || slides.some(slide => !('slideId' in slide) && !slide.title.trim())) throw new Error('请填写新增页面标题。')
      setError('')
      await onPreview({ kind: 'setSlideSequence', expectedNodeDigest: snapshot.slideSequence.nodeDigest, slides })
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const changed = JSON.stringify(slides) !== JSON.stringify(initial())
  const removed = (snapshot.slides ?? []).filter(original => !slides.some(slide => 'slideId' in slide && slide.slideId === original.id))
  return <div className="office-slide-sequence" data-office-slide-sequence>
    <div className="office-slide-sequence-toolbar"><strong>{slides.length} 页</strong>
      <button className="btn btn-secondary btn-sm" type="button" title="新增页面" aria-label="新增页面" disabled={disabled || slides.length >= 300}
        onClick={() => update([...slides, { title: '', body: '' }])}><Plus size={16} /></button>
      <button className="btn btn-secondary btn-sm" type="button" title="还原页面列表" aria-label="还原页面列表" disabled={disabled || !changed}
        onClick={() => update(initial())}><Undo2 size={16} /></button>
    </div>
    {!editable && <p>{snapshot.slideSequence?.reason ?? '此版本的页面列表只读。'}</p>}
    <ol>{slides.map((slide, index) => {
      const original = 'slideId' in slide ? snapshot.slides?.find(item => item.id === slide.slideId) : undefined
      return <li key={'slideId' in slide ? slide.slideId : `new:${index}`}>
        <div className="office-slide-sequence-row"><span>{index + 1}. {original ? `原第 ${original.index + 1} 页 · ${original.name}` : '新增页'}</span>
          <div className="office-slide-sequence-actions">
            <button className="btn btn-secondary btn-sm" type="button" title="上移页面" aria-label={`上移第 ${index + 1} 页`} disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></button>
            <button className="btn btn-secondary btn-sm" type="button" title="下移页面" aria-label={`下移第 ${index + 1} 页`} disabled={disabled || index === slides.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></button>
            <button className="btn btn-secondary btn-sm" type="button" title="移除页面" aria-label={`移除第 ${index + 1} 页`} disabled={disabled || slides.length === 1} onClick={() => update(slides.filter((_, current) => current !== index))}><Trash2 size={14} /></button>
          </div>
        </div>
        {!('slideId' in slide) && <div className="office-slide-sequence-new">
          <label>标题<input value={slide.title} maxLength={300} disabled={disabled} onChange={event => update(slides.map((item, at) => at === index ? { ...slide, title: event.target.value } : item))} /></label>
          <label>正文<textarea value={slide.body} maxLength={8000} rows={4} disabled={disabled} onChange={event => update(slides.map((item, at) => at === index ? { ...slide, body: event.target.value } : item))} /></label>
        </div>}
      </li>
    })}</ol>
    {!!removed.length && <p>从新版本移除：{removed.map(slide => `原第 ${slide.index + 1} 页`).join('、')}</p>}
    <button className="btn btn-secondary btn-sm" type="button" disabled={disabled || !changed} onClick={() => void preview()}>预览页面调整</button>
    {error && <p role="alert">{error}</p>}
  </div>
}
