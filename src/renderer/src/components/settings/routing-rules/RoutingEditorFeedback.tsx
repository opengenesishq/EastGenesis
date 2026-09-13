import type { RoutingDiagnostic } from '../../../../../shared/routing-policy-types'
import type { RoutingRuleEditorShellProps } from './routing-editor-props'

export function EditorDiagnostics({ diagnostics }: { diagnostics: readonly RoutingDiagnostic[] }): React.JSX.Element {
  return <div className="rr-editor-diagnostics">{diagnostics.map((item, index) => <p key={`${item.code}:${item.path}:${index}`}
    className={`rr-editor-${item.severity}`} role={item.severity === 'error' ? 'alert' : 'status'} data-routing-editor-diagnostic={item.code}>{item.message}</p>)}</div>
}
export function InvalidRead({ busy, onReread }: Pick<RoutingRuleEditorShellProps, 'busy' | 'onReread'>): React.JSX.Element {
  return <div role="alert" className="rr-editor-error" data-routing-invalid-read>
    <p>现有规则暂时无法读取。你的草稿已保留，请重新读取或修复配置后继续。</p>
    <button type="button" data-routing-editor-reread disabled={Boolean(busy)} onClick={onReread}>重新读取规则</button>
  </div>
}
export default function SaveFeedback(props: RoutingRuleEditorShellProps): React.JSX.Element | null {
  const { lastSave, dirty, busy, onReviewConflict } = props
  if (!lastSave) return null
  switch (lastSave.status) {
    case 'saved': return <p role="status">最近一次保存已完成。{dirty ? '随后还有修改尚未保存。' : ''}</p>
    case 'conflict': return <div role="alert" className="rr-editor-error">
      <p>规则或目录已发生变化。你的草稿已保留，请比较最新内容后再保存。</p>
      <button type="button" data-routing-editor-review-conflict disabled={Boolean(busy)} onClick={onReviewConflict}>查看变化，保留我的草稿</button>
    </div>
    case 'invalid': return <div role="alert" className="rr-editor-error"><p>规则尚未保存。请修复以下问题后重试，草稿已保留。</p><EditorDiagnostics diagnostics={lastSave.diagnostics} /></div>
    case 'storage_error': return <StorageFeedback {...props} result={lastSave} />
  }
}
function StorageFeedback({ result, busy, onReread }: Pick<RoutingRuleEditorShellProps, 'busy' | 'onReread'> & {
  result: Extract<NonNullable<RoutingRuleEditorShellProps['lastSave']>, { status: 'storage_error' }>
}): React.JSX.Element {
  return <div role="alert" className="rr-editor-error" data-routing-storage-error={result.commitState}>
    <p>{storageMessage(result.commitState)}</p>
    {result.commitState === 'unknown' && <button type="button" data-routing-editor-reread disabled={Boolean(busy)} onClick={onReread}>重新读取，核对保存结果</button>}
    <EditorDiagnostics diagnostics={result.diagnostics} />
  </div>
}
function storageMessage(state: 'not_attempted' | 'not_committed' | 'unknown'): string {
  switch (state) {
    case 'not_attempted': return '此次保存尚未开始。草稿已保留，处理问题后可再次点击保存。'
    case 'not_committed': return '此次修改确认未保存。草稿已保留，处理问题后可再次点击保存。'
    case 'unknown': return '尚不能确认此次保存是否完成。草稿已保留，请先重新读取并核对结果；现在不会再次提交。'
  }
}
