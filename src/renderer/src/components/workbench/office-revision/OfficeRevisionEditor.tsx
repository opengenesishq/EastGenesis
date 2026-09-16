import { useState } from 'react'
import type { OfficeArtifactSnapshot, OfficeCellSnapshot, OfficeParagraphSnapshot, OfficeRevisionOperation, OfficeSlideTextSnapshot } from '../../../../../shared/office-revision-types'
import { cellRevision, paragraphRevision, slideTextRevision } from './office-revision-model'
import OfficeSlideSequenceEditor from './OfficeSlideSequenceEditor'

export default function OfficeRevisionEditor({ snapshot, busy, onChange, onPreview }: {
  snapshot: OfficeArtifactSnapshot; busy: boolean; onChange(): void; onPreview(operation: OfficeRevisionOperation): Promise<void>
}): React.JSX.Element {
  const [paragraphId, setParagraphId] = useState(snapshot.paragraphs[0]?.id ?? '')
  const [cellKey, setCellKey] = useState(snapshot.cells[0] ? keyForCell(snapshot.cells[0]) : '')
  const [textKey, setTextKey] = useState(snapshot.slideTexts?.[0] ? keyForSlideText(snapshot.slideTexts[0]) : '')
  const [presentationMode, setPresentationMode] = useState<'text' | 'pages'>('text')
  const paragraph = snapshot.paragraphs.find((item) => item.id === paragraphId)
  const cell = snapshot.cells.find((item) => keyForCell(item) === cellKey)
  const slideText = snapshot.slideTexts?.find((item) => keyForSlideText(item) === textKey)
  const select = (change: () => void): void => { change(); onChange() }
  return <div className="office-revision-editor">
    {snapshot.artifact.kind === 'document' ? <>
      <label>段落<select value={paragraphId} disabled={busy} onChange={(event) => select(() => setParagraphId(event.target.value))} data-office-paragraph-select>{snapshot.paragraphs.map((item) => <option key={item.id} value={item.id}>{officeParagraphLabel(item)} · {item.editable ? '可修改' : '只读'} · {item.text.slice(0, 48)}</option>)}</select></label>
      {paragraph && <div><pre>{paragraph.text}</pre>{!paragraph.editable && <p>{paragraph.reason ?? '此段包含复杂结构，仅可预览。'}</p>}
        <ReplacementEditor key={paragraph.id} initial={paragraph.text} editable={paragraph.editable && snapshot.editability.editable && snapshot.artifact.latest} busy={busy} onChange={onChange} onPreview={(text) => onPreview(paragraphRevision(snapshot, paragraph.id, text))} />
      </div>}
    </> : snapshot.artifact.kind === 'presentation' ? <>
      <div className="office-revision-modes" role="tablist" aria-label="汇报修改范围">
        <button type="button" role="tab" aria-selected={presentationMode === 'text'} disabled={busy} onClick={() => select(() => setPresentationMode('text'))}>文字</button>
        <button type="button" role="tab" aria-selected={presentationMode === 'pages'} disabled={busy} onClick={() => select(() => setPresentationMode('pages'))}>页面</button>
      </div>
      <div hidden={presentationMode !== 'pages'}><OfficeSlideSequenceEditor snapshot={snapshot} busy={busy} onChange={onChange} onPreview={onPreview} /></div>
      <div hidden={presentationMode !== 'text'}>
      <label>页面与文本框<select value={textKey} disabled={busy} onChange={(event) => select(() => setTextKey(event.target.value))} data-office-slide-text-select>{snapshot.slideTexts?.map((item) => <option key={keyForSlideText(item)} value={keyForSlideText(item)}>{officeSlideTextLabel(snapshot, item)} · {item.editable ? '可修改' : '只读'} · {item.text.slice(0, 48)}</option>)}</select></label>
      {slideText && <div><pre>{slideText.text}</pre>{!slideText.editable && <p>{slideText.reason ?? '此文本框包含复杂结构，仅可预览。'}</p>}
        <p>保留原段落数量和文字样式。请核对新文字的换行与显示范围。</p>
        <ReplacementEditor key={textKey} initial={slideText.text} editable={slideText.editable && snapshot.editability.editable && snapshot.artifact.latest} busy={busy} onChange={onChange} onPreview={(text) => onPreview(slideTextRevision(snapshot, slideText.slideId, slideText.shapeId, text))} />
      </div>}
      </div>
    </> : <>
      <label>工作表与单元格<select value={cellKey} disabled={busy} onChange={(event) => select(() => setCellKey(event.target.value))} data-office-cell-select>{snapshot.cells.map((item) => <option key={keyForCell(item)} value={keyForCell(item)}>{officeCellLabel(snapshot, item)} · {item.editable ? '可修改' : '只读'}</option>)}</select></label>
      {cell && <CellEditor key={cellKey} snapshot={snapshot} cell={cell} busy={busy} onChange={onChange} onPreview={onPreview} />}
    </>}
  </div>
}

function keyForCell(cell: OfficeCellSnapshot): string { return `${cell.sheetId}\0${cell.address}` }
function keyForSlideText(text: OfficeSlideTextSnapshot): string { return `${text.slideId}!${text.shapeId}` }
export function officeParagraphLabel(paragraph: OfficeParagraphSnapshot): string { return `第 ${paragraph.index + 1} 段` }
export function officeCellLabel(snapshot: OfficeArtifactSnapshot, cell: OfficeCellSnapshot): string { return `${snapshot.sheets.find((sheet) => sheet.id === cell.sheetId)?.name ?? '工作表'} · ${cell.address} 单元格` }
export function officeSlideTextLabel(snapshot: OfficeArtifactSnapshot, text: OfficeSlideTextSnapshot): string {
  const slide = snapshot.slides?.find((item) => item.id === text.slideId)
  return `${slide ? `第 ${slide.index + 1} 页` : '已选页面'} · ${text.name}`
}

function ReplacementEditor({ initial, editable, busy, forceChanged = false, onChange, onPreview }: {
  initial: string; editable: boolean; busy: boolean; forceChanged?: boolean; onChange(): void; onPreview(text: string): Promise<void>
}): React.JSX.Element {
  const [text, setText] = useState(initial)
  const [error, setError] = useState('')
  const preview = async (): Promise<void> => {
    try { setError(''); await onPreview(text) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return <div><label>替换为<textarea rows={4} value={text} disabled={!editable || busy} data-office-replacement onChange={(event) => { setText(event.target.value); onChange() }} /></label>
    <button type="button" className="btn btn-secondary btn-sm" data-office-preview-revision disabled={!editable || busy || (!forceChanged && text === initial)} onClick={() => void preview()}>预览修改</button>
    {error && <p role="alert">{error}</p>}
  </div>
}

function CellEditor({ snapshot, cell, busy, onChange, onPreview }: {
  snapshot: OfficeArtifactSnapshot; cell: OfficeCellSnapshot; busy: boolean; onChange(): void; onPreview(operation: OfficeRevisionOperation): Promise<void>
}): React.JSX.Element {
  const [type, setType] = useState(cell.type === 'blank' ? 'blank' : cell.type)
  const current = cell.formula ? `公式：=${cell.formula}\n上次保存的计算结果：${cell.cachedValue ?? '暂无'}` : String(cell.value ?? '')
  return <div><pre>{current}</pre>{cell.formula ? <p>公式只能预览。修改输入后，请在 Excel 中重新计算；当前显示的结果可能尚未更新。</p> : !cell.editable && <p>{cell.reason ?? '此单元格包含复杂内容，仅可预览。'}</p>}
    <label>数据类型<select value={type} disabled={!cell.editable || busy} data-office-cell-type onChange={(event) => { setType(event.target.value); onChange() }}><option value="string">文本</option><option value="number">数字</option><option value="boolean">逻辑值（true 或 false）</option><option value="blank">空白</option>{type === 'formula' && <option value="formula">公式（只读）</option>}{type === 'unsupported' && <option value="unsupported">特殊内容（只读）</option>}</select></label>
    <ReplacementEditor key={type} forceChanged={type !== cell.type} initial={String(cell.value ?? '')} editable={cell.editable && snapshot.editability.editable && snapshot.artifact.latest} busy={busy} onChange={onChange} onPreview={(text) => onPreview(cellRevision(snapshot, cell, type, text))} />
  </div>
}
