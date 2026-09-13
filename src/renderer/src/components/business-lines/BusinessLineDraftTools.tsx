import { useRef, useState } from 'react'
import { copyBusinessLine, exportBusinessLine, importBusinessLine } from '../../../../shared/business-line-portability'
import type { BusinessLineDefinition } from '../../../../shared/business-line-types'
import { generateBusinessLineDraft } from '../../store/business-line-draft'
import { useStore } from '../../store'

export default function BusinessLineDraftTools({ draft, onDraft, zh }: { draft: BusinessLineDefinition; onDraft: (draft: BusinessLineDefinition) => void; zh: boolean }): React.JSX.Element {
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(''); setNotice('')
    try { await operation() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const generate = (): void => void run(async () => {
    const result = await generateBusinessLineDraft(window.agentDesk, description)
    await useStore.getState().syncSession(result.sessionId)
    onDraft(result.draft)
    setNotice(zh ? '模型已生成草稿。请检查并编辑，再保存业务线。' : 'AI draft generated. Review and edit it before saving.')
  })
  const upload = (file?: File): void => void run(async () => {
    if (file) onDraft(importBusinessLine(await file.text(), `business-line:${crypto.randomUUID()}`))
  })
  const download = (): void => void run(async () => {
    const data = exportBusinessLine(draft)
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${draft.name || 'business-line'}.json`; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })
  const duplicate = (): void => void run(async () => onDraft(copyBusinessLine(draft, `business-line:${crypto.randomUUID()}`, `${draft.name}${zh ? ' 副本' : ' copy'}`)))
  return <div className="business-line-draft-tools">
    <div className="business-line-portability-actions">
      <button type="button" className="btn btn-secondary btn-sm" data-business-line-duplicate disabled={busy || !draft.name.trim()} onClick={duplicate}>{zh ? '复制为新业务线' : 'Duplicate as new line'}</button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>{zh ? '导入配置' : 'Import'}</button>
      <button type="button" className="btn btn-ghost btn-sm" data-business-line-export disabled={busy || !draft.name.trim()} onClick={download}>{zh ? '导出配置' : 'Export'}</button>
      <input type="file" accept="application/json,.json" hidden ref={fileRef} onChange={(event) => { upload(event.target.files?.[0]); event.target.value = '' }} />
    </div>
    <details><summary>{zh ? '描述需求，让助手生成可编辑草稿' : 'Describe the line and generate an editable AI draft'}</summary>
      <textarea className="input" rows={3} value={description} maxLength={10000} onChange={(event) => setDescription(event.target.value)} aria-label={zh ? '业务线需求描述' : 'Business line description'} />
      <button type="button" className="btn btn-secondary btn-sm" data-business-line-generate disabled={busy || !description.trim()} onClick={generate}>{busy ? (zh ? '助手生成中…' : 'Assistant is working…') : (zh ? '用已连接模型生成' : 'Generate with connected model')}</button>
    </details>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="business-line-error">{error}</p>}
  </div>
}
