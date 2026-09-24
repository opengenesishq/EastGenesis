import { useEffect, useRef, useState } from 'react'
import type { FeedbackAppInfo, FeedbackPreview } from '../../../../shared/feedback-types'
import { useStore } from '../../store'
import './feedback-settings.css'

export default function FeedbackSettings(): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const sessionId = useStore(state => state.activeId)
  const [appInfo, setAppInfo] = useState<FeedbackAppInfo | null>(null)
  const [description, setDescription] = useState('')
  const [includeTaskSummary, setIncludeTaskSummary] = useState(false)
  const [includeErrorSummary, setIncludeErrorSummary] = useState(false)
  const [preview, setPreview] = useState<FeedbackPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const revision = useRef(0)
  useEffect(() => {
    let active = true
    void window.agentDesk.getFeedbackAppInfo().then(info => { if (active) setAppInfo(info) }).catch(() => {
      if (active) setError(zh ? '无法读取应用信息，请重新打开反馈。' : 'Could not load application information. Reopen Feedback to retry.')
    })
    return () => { active = false; revision.current++ }
  }, [zh])
  useEffect(() => { revision.current++; setPreview(null); setIncludeTaskSummary(false); setIncludeErrorSummary(false) }, [sessionId])
  const invalidate = (): void => { revision.current++; setPreview(null); setNotice(''); setError('') }
  const generate = async (): Promise<void> => {
    const current = ++revision.current
    setBusy(true); setError(''); setNotice(''); setPreview(null)
    try {
      const value = await window.agentDesk.previewFeedback({ description, includeTaskSummary, includeErrorSummary,
        ...((includeTaskSummary || includeErrorSummary) && sessionId ? { sessionId } : {}) })
      if (current === revision.current) setPreview(value)
    } catch {
      if (current === revision.current) setError(zh ? '生成失败，当前任务可能已关闭。请重新生成或取消摘要选项。' : 'Preview failed. The task may have closed. Retry or turn off task summaries.')
    } finally { setBusy(false) }
  }
  const save = async (): Promise<void> => {
    if (!preview) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await window.agentDesk.exportFeedback(preview.previewId)
      setNotice(result.canceled ? (zh ? '已取消导出。' : 'Export canceled.') : (zh ? `已保存到：${result.filePath}` : `Saved to: ${result.filePath}`))
    } catch {
      setError(zh ? '导出未完成。请重新生成预览，并选择可写入的位置。' : 'Export did not complete. Generate a new preview and choose a writable location.')
    } finally { setBusy(false) }
  }
  return <section className="feedback-settings" aria-label={zh ? '反馈与诊断' : 'Feedback & diagnostics'}>
    <h3>{zh ? '反馈与诊断' : 'Feedback & diagnostics'}</h3>
    <p className="settings-hint">{zh ? '描述遇到的问题，检查导出预览后保存到本机。文件由你自行决定是否分享。' : 'Describe the issue, review the report, then save it locally. You decide whether to share the file.'}</p>
    {appInfo && <p className="feedback-app-info">EastGenesis {appInfo.version} · {appInfo.platform} {appInfo.architecture} · {appInfo.build === 'packaged' ? (zh ? '打包版本' : 'Packaged build') : (zh ? '开发版本' : 'Development build')}<br />Electron {appInfo.electron} · Chromium {appInfo.chromium} · Node {appInfo.node}</p>}
    <label className="field-label" htmlFor="feedback-description">{zh ? '问题描述与复现步骤' : 'Issue and steps to reproduce'}</label>
    <textarea id="feedback-description" className="input input-block feedback-description" rows={6} maxLength={12000} value={description} disabled={busy}
      placeholder={zh ? '当时在做什么、发生了什么、预期的结果是什么…' : 'What were you doing, what happened, and what did you expect…'}
      onChange={event => { invalidate(); setDescription(event.target.value) }} />
    <fieldset className="feedback-options" disabled={busy}>
      <legend>{zh ? '可选摘要' : 'Optional summaries'}</legend>
      <label><input type="checkbox" checked={includeTaskSummary} disabled={!sessionId} onChange={event => { invalidate(); setIncludeTaskSummary(event.target.checked) }} />{zh ? '当前任务状态、执行方式和步骤数量' : 'Current task status, execution mode, and step counts'}</label>
      <label><input type="checkbox" checked={includeErrorSummary} disabled={!sessionId} onChange={event => { invalidate(); setIncludeErrorSummary(event.target.checked) }} />{zh ? '当前任务错误标记及失败次数（不含错误原文）' : 'Current task error flags and failure counts (no error text)'}</label>
      {!sessionId && <p className="settings-hint">{zh ? '打开一个任务后可加入该任务的摘要。' : 'Open a task to include its summary.'}</p>}
    </fieldset>
    <p className="settings-hint">{zh ? '自动信息不包含对话正文、任务名称、文件内容和路径、环境变量、凭据或原始日志。描述中的常见密钥会遮盖；手动填写的内容仍请在预览中核对。' : 'Automatic fields exclude conversation text, task names, file contents and paths, environment variables, credentials, and raw logs. Common secrets in your description are redacted; review any text you enter before export.'}</p>
    <div className="feedback-actions"><button className="btn btn-secondary" type="button" disabled={busy || !description.trim() || !appInfo} onClick={() => void generate()}>{zh ? '生成导出预览' : 'Generate preview'}</button>
      <button className="btn btn-primary" type="button" disabled={busy || !preview} onClick={() => void save()}>{zh ? '导出本地诊断文件' : 'Export local report'}</button></div>
    {preview && <div className="feedback-preview"><h4>{zh ? '将导出的完整内容' : 'Complete export content'}</h4><p className="settings-hint">{zh ? '预览有效期 15 分钟；文件内容与下方一致。修改选项后需要重新生成。' : 'Preview expires in 15 minutes. The file matches the content below. Regenerate after changing options.'}</p><pre tabIndex={0}>{preview.json}</pre></div>}
    {busy && <p role="status">{zh ? '处理中…' : 'Working…'}</p>}
    {notice && <p className="feedback-notice" role="status">{notice}</p>}
    {error && <p className="notice notice-error" role="alert">{error}</p>}
  </section>
}
