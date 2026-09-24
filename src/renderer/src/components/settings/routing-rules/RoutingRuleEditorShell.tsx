import type { RoutingRuleSetDraftV1 } from '../../../../../shared/routing-policy-types'
import type { RoutingRuleEditorShellProps } from './routing-editor-props'
import { editorLocked, saveBlocked } from './routing-editor-state'
import SaveFeedback, { EditorDiagnostics, InvalidRead } from './RoutingEditorFeedback'
import LegacyReview from './RoutingLegacyReview'
import { ROUTING_RULE_TEMPLATES, type RoutingRuleTemplateId } from './routing-rule-templates'
import './routing-rule-editor-shell.css'
export type { RoutingRuleEditorShellProps } from './routing-editor-props'

/** Presentation only. A future controller owns reads, persistence, CAS and conflict handling. */
export default function RoutingRuleEditorShell(props: RoutingRuleEditorShellProps): React.JSX.Element {
  const { read, busy } = props, locked = editorLocked(props)
  return <section className="rr-editor" data-routing-editor aria-busy={Boolean(busy)}>
    <header><h2>模型路由规则</h2><p>设置任务在什么情况下使用哪些厂商和模型，以及失败后如何处理。</p></header>
    <p className="rr-editor-scope">统一用于当前对话任务。</p>
    {read.mode === 'invalid_v1' && <InvalidRead {...props} />}
    <div className="rr-editor-layout">
      <RuleList {...props} />
      <fieldset className="rr-editor-detail" data-routing-editor-detail disabled={locked}><legend className="rr-editor-sr-only">所选规则</legend>
        {props.editor ?? <p>选择一条规则开始编辑。</p>}
      </fieldset>
    </div>
    {read.mode === 'legacy_active' && read.legacyCount > 0 && <LegacyReview {...props} read={read} />}
    <EditorDiagnostics diagnostics={props.diagnostics ?? read.diagnostics} />
    <SaveFeedback {...props} />
    {props.previewContext}
    <EditorFooter {...props} />
    {props.preview}
  </section>
}
function RuleList(props: RoutingRuleEditorShellProps): React.JSX.Element {
  const locked = editorLocked(props)
  return <nav aria-label="路由规则列表" className="rr-rule-list">
    <label className="rr-template-picker">从内置模板开始
      <select data-routing-editor-template aria-label="路由规则模板" defaultValue="" disabled={locked}
        onChange={(event) => {
          const template = event.currentTarget.value as RoutingRuleTemplateId
          if (!locked && ROUTING_RULE_TEMPLATES.some(item => item.id === template)) props.onAddRule(template)
          event.currentTarget.value = ''
        }}>
        <option value="">选择模板…</option>
        {ROUTING_RULE_TEMPLATES.map(template => <option key={template.id} value={template.id}>{template.label} · {template.description}</option>)}
      </select>
      <small>自动填好条件与偏好，也可再限定厂商和模型。保存后生效。</small>
    </label>
    <button type="button" data-routing-editor-add disabled={locked} onClick={() => { if (!locked) props.onAddRule() }}>添加规则</button>
    {props.draft.rules.map((rule) => <button type="button" key={rule.id} data-routing-editor-rule={rule.id}
      aria-current={props.selectedRuleId === rule.id ? 'true' : undefined} disabled={Boolean(props.busy)} onClick={() => props.onSelectRule(rule.id)}>
      <strong>{rule.name || '未命名规则'}</strong><span>{scopeName(rule.scope)} · {rule.enabled ? '启用' : '停用'}</span>
    </button>)}
    {!props.draft.rules.length && <p>添加规则，指定哪些任务使用哪些模型。</p>}
  </nav>
}
function EditorFooter(props: RoutingRuleEditorShellProps): React.JSX.Element {
  const locked = editorLocked(props), blocked = saveBlocked(props)
  return <footer className="rr-editor-footer">
    <p>{props.dirty ? '有未保存的修改。' : '当前草稿没有待保存的修改。'}</p>
    <p>已运行的任务保留启动时的路由策略。</p>
    <div className="rr-editor-actions">
      <button type="button" data-routing-editor-preview disabled={locked} onClick={() => { if (!locked) props.onPreview() }}>检查会使用哪个模型</button>
      <button type="button" data-routing-editor-save disabled={blocked} onClick={() => { if (!blocked) props.onSave() }}>{props.busy === 'saving' ? '保存中…' : '保存规则'}</button>
      {props.selectedRuleId && <button type="button" data-routing-editor-remove disabled={locked}
        onClick={() => { if (!locked && props.selectedRuleId) props.onRemoveRule(props.selectedRuleId) }}>移除此规则</button>}
    </div>
    <p>检查规则不会发送模型请求，也不代表实际任务效果已验证。</p>
  </footer>
}
function scopeName(_scope: RoutingRuleSetDraftV1['rules'][number]['scope']): string {
  return '全局'
}
