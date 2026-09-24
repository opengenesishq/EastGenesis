import { useEffect, useRef, useState } from 'react'
import { Circle, ImagePlus, Square, X } from 'lucide-react'
import type { SkillRecordingSaveResult, SkillRecordingSource, SkillRecordingView } from '../../../../shared/skill-recording-types'
import { useStore } from '../../store'
import './skill-recording.css'

export default function SkillRecordingWizard({ onClose, onSaved }: { onClose(): void; onSaved?(): void | Promise<void> }): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [view, setView] = useState<SkillRecordingView | null>(null)
  const [name, setName] = useState(''), [description, setDescription] = useState('')
  const [consent, setConsent] = useState(false), [allowScreenshots, setAllowScreenshots] = useState(false)
  const [action, setAction] = useState(''), [outcome, setOutcome] = useState('')
  const [sources, setSources] = useState<SkillRecordingSource[]>([]), [sourceId, setSourceId] = useState('')
  const [markdown, setMarkdown] = useState(''), [reviewed, setReviewed] = useState(false)
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [minimized, setMinimized] = useState(false)
  const [saved, setSaved] = useState<SkillRecordingSaveResult | null>(null)
  const [temporary, setTemporary] = useState(false)
  const recordingId = useRef<string | null>(null), mounted = useRef(true), generation = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false; generation.current++
      if (recordingId.current) void window.agentDesk.cancelSkillRecording(recordingId.current).catch(() => undefined)
    }
  }, [])
  const apply = (next: SkillRecordingView): void => { recordingId.current = next.id; setView(next); setTemporary(next.temporary); if (next.markdown !== undefined) setMarkdown(next.markdown) }
  const run = async (key: string, call: () => Promise<SkillRecordingView>): Promise<void> => {
    const version = ++generation.current
    setBusy(key); setError('')
    try {
      const next = await call()
      if (!mounted.current || version !== generation.current) {
        if (key === 'begin') void window.agentDesk.cancelSkillRecording(next.id).catch(() => undefined)
        return
      }
      apply(next)
      if (key === 'add') { setAction(''); setOutcome('') }
      if (key === 'stop') { setMinimized(false); setReviewed(false) }
    } catch (cause) { if (mounted.current && version === generation.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (mounted.current && version === generation.current) setBusy('') }
  }
  const close = async (): Promise<void> => {
    generation.current++; setError('')
    try {
      if (recordingId.current) await window.agentDesk.cancelSkillRecording(recordingId.current)
      recordingId.current = null; onClose()
    } catch { setError(zh ? '取消未完成，请重试。' : 'Could not cancel. Please retry.') }
  }
  const listSources = async (): Promise<void> => {
    if (!view) return
    const version = ++generation.current
    setBusy('sources'); setError(''); setSourceId('')
    try { const next = await window.agentDesk.listSkillRecordingSources(view.id); if (mounted.current && version === generation.current) setSources(next) }
    catch (cause) { if (mounted.current && version === generation.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (mounted.current && version === generation.current) setBusy('') }
  }
  const save = async (): Promise<void> => {
    if (!view || !reviewed) return
    setBusy('save'); setError('')
    try {
      const result = await window.agentDesk.saveSkillRecording(view.id, markdown, true)
      recordingId.current = null
      if (mounted.current) { setSaved(result); setView(null); setMarkdown('') }
      await onSaved?.()
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (mounted.current) setBusy('') }
  }
  const stop = (): void => { if (view) void run('stop', () => window.agentDesk.stopSkillRecording(view.id)) }
  const selectedSource = sources.find(source => source.id === sourceId)
  if (minimized && view?.phase === 'recording') return <aside className="skill-recording-bar" aria-label={zh ? '技能记录控制' : 'Skill recording controls'}>
    <Circle size={12} fill="currentColor" /><span>{zh ? `逐步记录中 · ${view.steps.length} 步` : `Collecting steps · ${view.steps.length}`}</span>
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMinimized(false)}>{zh ? '添加步骤' : 'Add steps'}</button>
    <button type="button" className="btn btn-primary btn-sm" disabled={!view.steps.length || busy === 'stop'} onClick={stop}><Square size={12} />{zh ? '停止' : 'Stop'}</button>
    <button type="button" className="icon-btn" aria-label={zh ? '取消并清空记录' : 'Cancel and clear'} onClick={() => void close()}><X size={15} /></button>
    {error && <span role="alert">{error}</span>}
  </aside>
  return <div className="skill-recording-backdrop"><section className="skill-recording-modal" role="dialog" aria-modal="true" aria-labelledby="skill-recording-title">
    <header className="skill-recording-header"><div><h2 id="skill-recording-title">{zh ? '录制技能 · 逐步采集' : 'Record a skill · Step collection'}</h2>
      {view?.phase === 'recording' && <span className="skill-recording-status" role="status">● {zh ? `记录中 · 已添加 ${view.steps.length} 步` : `Recording · ${view.steps.length} steps`}</span>}</div>
      <div className="skill-recording-actions">{view?.phase === 'recording' && <><button type="button" className="btn btn-ghost btn-sm" onClick={() => setMinimized(true)}>{zh ? '收起为记录条' : 'Minimize to controls'}</button><button type="button" className="btn btn-primary btn-sm" disabled={!view.steps.length || busy === 'stop'} onClick={stop}>{zh ? '停止并生成草稿' : 'Stop and generate'}</button></>}
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy === 'save'} onClick={() => void close()}>{saved ? (zh ? '完成' : 'Done') : (zh ? '取消并清空' : 'Cancel and clear')}</button></div></header>
    <div className="skill-recording-content">
      {temporary && <p className="notice notice-info">{zh ? '当前是临时任务：技能及示范图片只保存在本临时窗口中，结束临时任务后一起清理。' : 'This is a temporary task. The skill and demonstration images stay in this temporary profile and are cleared when the temporary task ends.'}</p>}
      {!view && !saved && <>
        <p>{zh ? '每完成一个操作，添加该步骤及预期结果；可选择附上当时的屏幕或窗口画面。当前支持手动逐步采集，不会自动记录鼠标、键盘或后台屏幕。' : 'Add each demonstrated action and its expected result. Optionally attach the current screen or window. This collects steps manually; it does not automatically record mouse, keyboard, or background screens.'}</p>
        <label className="field-label">{zh ? '技能名称' : 'Skill name'}<input className="input input-block" value={name} maxLength={63} placeholder="prepare-client-report" onChange={event => setName(event.target.value)} /></label>
        <p className="settings-hint">{zh ? '使用小写字母、数字和连字符。保存范围在开始后显示，同名技能不会被覆盖。' : 'Use lowercase letters, digits, and hyphens. The save scope is shown after starting; existing names are never overwritten.'}</p>
        <label className="field-label">{zh ? '这个技能做什么、什么时候使用' : 'What the skill does and when to use it'}<textarea className="input input-block" rows={3} value={description} maxLength={500} onChange={event => setDescription(event.target.value)} /></label>
        <label className="skill-recording-check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />{zh ? '允许记录我主动添加的步骤和预期结果。停止后由我审核、编辑并决定是否保存。' : 'Collect the steps and expected results I explicitly add. I will review, edit, and choose whether to save after stopping.'}</label>
        <label className="skill-recording-check"><input type="checkbox" checked={allowScreenshots} onChange={event => setAllowScreenshots(event.target.checked)} />{zh ? '允许我逐次选择屏幕或窗口，点击按钮采集示范画面（可选）' : 'Let me select a screen or window and capture each demonstration image by clicking a button (optional)'}</label>
        <button type="button" className="btn btn-primary" disabled={Boolean(busy) || !consent || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !description.trim()} onClick={() => void run('begin', () => window.agentDesk.beginSkillRecording({ name, description, consent: true, allowScreenshots }))}>{zh ? '开始记录' : 'Start recording'}</button>
      </>}
      {view?.phase === 'recording' && <>
        <div className="skill-recording-step-form"><label className="field-label">{zh ? '刚才演示的操作' : 'Action you demonstrated'}<textarea className="input input-block" rows={2} value={action} maxLength={2000} disabled={Boolean(busy)} placeholder={zh ? '例如：在报表页选择本月，点击导出…' : 'For example: select this month on the report page and click Export…'} onChange={event => setAction(event.target.value)} /></label>
        <label className="field-label">{zh ? '预期结果 / 如何确认成功' : 'Expected result / How to verify success'}<textarea className="input input-block" rows={2} value={outcome} maxLength={2000} disabled={Boolean(busy)} onChange={event => setOutcome(event.target.value)} /></label>
        <button type="button" className="btn btn-primary" disabled={Boolean(busy) || !action.trim() || !outcome.trim()} onClick={() => void run('add', () => window.agentDesk.addSkillRecordingStep(view.id, { action, outcome }))}>{zh ? '添加这一步' : 'Add this step'}</button></div>
        {view.allowScreenshots && <div className="skill-recording-sources"><p className="settings-hint">{zh ? '仅在点击“捕获到此步骤”时采集。截图会保留画面中的可见内容，不进行文字识别；请只捕获愿意保存的内容。' : 'Capture happens only when you click Capture to step. Images retain visible content without OCR; capture only what you intend to save.'}</p>
          <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void listSources()}>{zh ? '选择 / 刷新屏幕与窗口' : 'Choose / refresh screens and windows'}</button>
          <select className="select select-block" aria-label={zh ? '示范画面来源' : 'Demonstration image source'} value={sourceId} disabled={Boolean(busy)} onChange={event => setSourceId(event.target.value)}><option value="">{zh ? '请选择来源' : 'Select a source'}</option>{sources.map(source => <option value={source.id} key={source.id}>{source.kind === 'screen' ? (zh ? '屏幕' : 'Screen') : (zh ? '窗口' : 'Window')} · {source.name}</option>)}</select></div>}
        <ol className="skill-recording-steps">{view.steps.map(step => <li key={step.id}><strong>{step.action}</strong><p>{step.outcome}</p>{step.image && <img src={step.image.previewDataUrl} alt={zh ? '用户捕获的示范画面' : 'User captured demonstration'} />}
          <div className="skill-recording-actions">{view.allowScreenshots && <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy) || !selectedSource} onClick={() => { if (selectedSource) void run('capture', () => window.agentDesk.captureSkillRecordingStep(view.id, step.id, selectedSource)) }}><ImagePlus size={14} />{zh ? '捕获到此步骤' : 'Capture to step'}</button>}
          {step.image && <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void run('remove-image', () => window.agentDesk.removeSkillRecordingImage(view.id, step.id))}>{zh ? '移除画面' : 'Remove image'}</button>}
          <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void run('remove', () => window.agentDesk.removeSkillRecordingStep(view.id, step.id))}>{zh ? '删除步骤' : 'Delete step'}</button></div></li>)}</ol>
      </>}
      {view?.phase === 'review' && <><p>{zh ? '记录已停止。请编辑完整 SKILL.md，删除不应复用的内容；执行步骤和验证列表必须保留。画面使用技能内的相对路径，不写入来源窗口名称或本机文件路径。' : 'Recording has stopped. Edit the complete SKILL.md and remove anything unsuitable for reuse. Keep Steps and Verification lists. Images use relative asset paths; source window names and local file paths are not added.'}</p>
        <p className="settings-hint">{temporary ? (zh ? '保存范围：当前临时任务；结束后清理。' : 'Save scope: this temporary task; cleared when it ends.') : (zh ? '保存范围：本机个人技能目录。' : 'Save scope: your personal skills folder on this computer.')}</p>
        <textarea className="input input-block skill-recording-markdown" aria-label="SKILL.md" value={markdown} disabled={Boolean(busy)} onChange={event => { setMarkdown(event.target.value); setReviewed(false) }} />
        {view.steps.some(step => step.image) && <div className="skill-recording-review-images"><h3>{zh ? '将随技能保存的画面' : 'Images saved with the skill'}</h3>{view.steps.map((step, index) => step.image && <figure key={step.id}><img src={step.image.previewDataUrl} alt={`${zh ? '步骤' : 'Step'} ${index + 1}`} /><figcaption>assets/step-{index + 1}.png</figcaption></figure>)}</div>}
        <label className="skill-recording-check"><input type="checkbox" checked={reviewed} disabled={Boolean(busy)} onChange={event => setReviewed(event.target.checked)} />{zh ? '我已审核正文和全部画面，同意保存并启用此技能；实际执行仍使用当前任务权限。' : 'I reviewed the text and all images and approve saving and enabling this skill. Execution still uses the current task permissions.'}</label>
        <button type="button" className="btn btn-primary" disabled={Boolean(busy) || !reviewed || !markdown.trim()} onClick={() => void save()}>{zh ? '保存并启用技能' : 'Save and enable skill'}</button></>}
      {saved && <div role="status"><h3>{saved.enabled ? (zh ? '技能已保存并启用' : 'Skill saved and enabled') : (zh ? '技能已保存，等待启用' : 'Skill saved, activation pending')}</h3><p>{saved.name} · {saved.imageCount} {zh ? '张画面' : 'images'}</p><code className="skill-recording-saved-path">{saved.path}</code>{saved.activationError && <p>{saved.activationError}</p>}<p>{zh ? '可在插件目录中选择此技能加入任务，或在任务中使用对应技能名称。' : 'Select it in the plugin directory to add it to a task, or refer to the skill by name.'}</p></div>}
      {busy && <p role="status">{zh ? '处理中…' : 'Working…'}</p>}{error && <p className="notice notice-error" role="alert">{error}</p>}
    </div>
  </section></div>
}
