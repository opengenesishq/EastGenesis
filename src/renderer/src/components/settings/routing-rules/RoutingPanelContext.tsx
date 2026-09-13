import { useId } from 'react'
import type { RoutingPreviewContext } from '../../../../../shared/routing-policy-types'
import type { RoutingBusinessLineOption } from './routing-ui-props'

export default function RoutingPanelContext({ context, active, lines, defaultLineId, disabled, onChange }: {
  context?: RoutingPreviewContext
  active?: { id: string; title: string }
  lines: readonly RoutingBusinessLineOption[]
  defaultLineId: string
  disabled: boolean
  onChange(context: RoutingPreviewContext): void
}): React.JSX.Element {
  const id = useId()
  const missingSession = context?.kind === 'session' && context.sessionId !== active?.id
  const currentLine = context?.kind === 'new_task' ? lines.find((line) => line.id === context.businessLineId) : undefined
  return <fieldset className="rr-panel-context" data-routing-preview-context disabled={disabled}>
    <legend>预演任务</legend>
    <label htmlFor={`${id}-scope`}>任务来源<select id={`${id}-scope`} data-routing-preview-kind value={context?.kind ?? 'new_task'}
      onChange={(event) => {
        const prompt = context?.prompt ?? ''
        if (event.target.value === 'session' && active) onChange({ kind: 'session', sessionId: active.id, prompt })
        else onChange({ kind: 'new_task', businessLineId: defaultLineId, prompt, routingIntent: { kind: 'global' } })
      }}>
      <option value="new_task">新任务</option>
      <option value="session" disabled={!active}>当前会话{active?.title ? `：${active.title}` : ''}</option>
    </select></label>
    {context?.kind === 'new_task' && <label htmlFor={`${id}-line`}>业务线<select id={`${id}-line`} data-routing-preview-business-line value={context.businessLineId}
      onChange={(event) => onChange({ ...context, businessLineId: event.target.value })}>
      {!currentLine && <option value={context.businessLineId} disabled>原业务线已不可用</option>}
      {lines.map((line) => <option key={line.id} value={line.id} disabled={!line.enabled}>{line.name}{line.enabled ? '' : '（已停用）'}</option>)}
    </select></label>}
    {missingSession && <p role="alert">原会话已不在当前工作区，请重新选择任务来源。</p>}
    <label htmlFor={`${id}-prompt`}>任务内容<textarea id={`${id}-prompt`} data-routing-preview-prompt rows={3} value={context?.prompt ?? ''}
      onChange={(event) => {
        if (context) onChange({ ...context, prompt: event.target.value })
      }} /></label>
  </fieldset>
}
