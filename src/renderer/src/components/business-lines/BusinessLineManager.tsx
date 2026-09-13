import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { getBusinessLines, type BusinessLineDefinition } from '../../../../shared/business-line-types'
import { useStore } from '../../store'
import { businessLineLabel, routingPreferenceLabel } from './business-line-labels'
import './business-lines.css'
import BusinessLinePolicyFields from './BusinessLinePolicyFields'
import BusinessLineDraftTools from './BusinessLineDraftTools'

function newDefinition(order: number): BusinessLineDefinition {
  return { schemaVersion: 1, id: `business-line:${crypto.randomUUID()}`, origin: 'custom', name: '', objective: '', workflow: [], deliverables: [], routingPreference: 'balanced', enabled: true, order }
}

export default function BusinessLineManager({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useStore((state) => state.settings)
  const lines = getBusinessLines(settings)
  const save = useStore((state) => state.saveBusinessLine)
  const select = useStore((state) => state.selectBusinessLine)
  const reorder = useStore((state) => state.reorderBusinessLine)
  const enable = useStore((state) => state.setBusinessLineEnabled)
  const [draft, setDraft] = useState<BusinessLineDefinition>(() => newDefinition(lines.length))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const zh = settings.language === 'zh'
  const labels = managerFormLabels(zh)
  useEffect(() => { inputRef.current?.focus() }, [draft.id])
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const submit = (): void => void run(async () => {
    const isNew = !lines.some((line) => line.id === draft.id)
    await save({ ...draft, workflow: cleanLines(draft.workflow), deliverables: cleanLines(draft.deliverables), acceptanceCriteria: cleanLines(draft.acceptanceCriteria ?? []) })
    if (isNew) { await select(draft.id); onClose() }
  })
  return <div className="business-line-modal-backdrop" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) onClose() }}>
    <section className="business-line-manager" role="dialog" aria-modal="true" aria-labelledby="business-line-manager-title" data-business-line-manager>
      <header><h2 id="business-line-manager-title">{zh ? '业务线' : 'Business lines'}</h2><button type="button" className="btn btn-ghost btn-icon-sm" onClick={onClose} disabled={busy} aria-label={zh ? '关闭' : 'Close'}><X size={18} /></button></header>
      <p>{zh ? '助手、项目、视频和你创建的业务线共享模型、执行与交付能力。' : 'Built-in and custom business lines share models, execution and delivery.'}</p>
      <div className="business-line-manager-body">
        <div className="business-line-definitions">
          {lines.map((line, index) => <div key={line.id} className="business-line-definition" data-business-line-definition={line.id}>
            <button type="button" className={`business-line-edit ${draft.id === line.id ? 'active' : ''}`} onClick={() => setDraft(line)} disabled={busy}>
              <strong>{businessLineLabel(line, settings.language)}</strong><small>{line.enabled ? (zh ? '启用' : 'Enabled') : (zh ? '已停用' : 'Disabled')}</small>
            </button>
            <div className="business-line-row-actions">
              <button type="button" className="btn btn-ghost btn-icon-sm" disabled={busy || index === 0} onClick={() => void run(() => reorder(line.id, -1))} aria-label={`${zh ? '上移' : 'Move up'} ${line.name}`}><ArrowUp size={13} /></button>
              <button type="button" className="btn btn-ghost btn-icon-sm" disabled={busy || index === lines.length - 1} onClick={() => void run(() => reorder(line.id, 1))} aria-label={`${zh ? '下移' : 'Move down'} ${line.name}`}><ArrowDown size={13} /></button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(() => enable(line.id, !line.enabled))}>{line.enabled ? (zh ? '停用' : 'Disable') : (zh ? '启用' : 'Enable')}</button>
            </div>
          </div>)}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDraft(newDefinition(lines.length))} disabled={busy}><Plus size={14} />{zh ? '新增业务线' : 'Add business line'}</button>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); submit() }} className="business-line-form">
          <BusinessLineDraftTools draft={draft} onDraft={setDraft} zh={zh} />
          <label>{labels.name}<input ref={inputRef} className="input" name="businessLineName" value={draft.name} maxLength={80} required onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={zh ? '例如：市场营销' : 'For example: Marketing'} /></label>
          <label>{labels.objective}<textarea className="input" name="businessLineObjective" value={draft.objective} rows={3} maxLength={4000} onChange={(event) => setDraft({ ...draft, objective: event.target.value })} /></label>
          <label>{labels.workflow}<textarea className="input" name="businessLineWorkflow" value={draft.workflow.join('\n')} rows={4} onChange={(event) => setDraft({ ...draft, workflow: event.target.value.split('\n') })} /></label>
          <label>{labels.deliverables}<textarea className="input" name="businessLineDeliverables" value={draft.deliverables.join('\n')} rows={3} onChange={(event) => setDraft({ ...draft, deliverables: event.target.value.split('\n') })} /></label>
          <label>{labels.routing}<select className="input" name="businessLineRouting" value={draft.routingPreference} onChange={(event) => setDraft({ ...draft, routingPreference: event.target.value as BusinessLineDefinition['routingPreference'] })}>
            {(['balanced', 'quality', 'cost', 'speed'] as const).map((value) => <option key={value} value={value}>{routingPreferenceLabel(value, settings.language)}</option>)}
          </select></label>
          <BusinessLinePolicyFields draft={draft} onChange={setDraft} zh={zh} />
          {error && <p className="business-line-error" role="alert">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={busy || !draft.name.trim()} data-save-business-line>{busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存业务线' : 'Save business line')}</button>
        </form>
      </div>
    </section>
  </div>
}

function cleanLines(values: string[]): string[] { return values.map((value) => value.trim()).filter(Boolean) }

function managerFormLabels(zh: boolean) {
  return zh ? { name: '名称', objective: '业务目标', workflow: '工作流程（每行一步）', deliverables: '预期成果（每行一项）', routing: '智能路由偏好' }
    : { name: 'Name', objective: 'Objective', workflow: 'Workflow (one step per line)', deliverables: 'Deliverables (one per line)', routing: 'Routing preference' }
}
