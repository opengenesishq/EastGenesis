import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import { matchesDesktopShortcut } from '../../desktop-keyboard'
import type { BusinessLineDefinition } from '../../../../shared/business-line-types'
import { useOfficeCommand, type OfficeCommandTarget } from './useOfficeCommand'
import SessionInputQueue from '../composer/SessionInputQueue'
import SessionModelPicker from '../composer/SessionModelPicker'
import TaskRequirementRevision from '../experience/TaskRequirementRevision'
import '../composer/session-inputs.css'
import './office-command.css'

type Command = ReturnType<typeof useOfficeCommand>
export interface OfficeCommandSelectionRequest { sequence: number; scope: 'selection' | 'new' }
interface CommandInputProps {
  lines: BusinessLineDefinition[]; defaultLineId: string; zh: boolean; preferSelection: boolean
  selectionRequest?: OfficeCommandSelectionRequest
  onSelectionApplied?(): void
  selectedSession?: { id: string; title: string }; selectedTask?: { id: string; title: string }
  onOpenSession(id: string): void; onOpenWorkspace?(id: string): void; onOpenTask?: () => void
}

export default function OfficeCommandInput({ lines, defaultLineId, selectedSession, selectedTask, zh, preferSelection, selectionRequest, onSelectionApplied, onOpenSession, onOpenWorkspace, onOpenTask }: CommandInputProps): React.JSX.Element {
  const incoming = commandSelection(selectedSession, selectedTask)
  const host = useRef<HTMLElement>(null)
  useEffect(() => {
    const element = host.current
    if (!element) return
    const measure = (): void => element.parentElement?.style.setProperty('--office-command-height', `${element.getBoundingClientRect().height}px`)
    const observer = new ResizeObserver(measure)
    observer.observe(element); measure()
    return () => observer.disconnect()
  }, [])
  const [scope, setScope] = useState(selectionRequest?.scope ?? (preferSelection && incoming ? 'selection' : 'new'))
  const [lineId, setLineId] = useState(defaultLineId)

  const line = lines.find((item) => item.id === lineId && item.enabled)
  const target: OfficeCommandTarget = scope === 'selection' && incoming
    ? incoming
    : { kind: line ? 'business' : 'unavailable', id: lineId, title: line?.name ?? lineId }
  const command = useOfficeCommand(target, zh)
  useEffect(() => {
    // Drafts are already keyed by task. Follow an explicit task selection so a
    // draft for the previously selected figure cannot receive its instructions.
    setScope(preferSelection && incoming ? 'selection' : 'new'); setLineId(defaultLineId)
  }, [incoming?.kind, incoming?.id, defaultLineId, preferSelection])
  useEffect(() => {
    if (selectionRequest) { setScope(selectionRequest.scope); onSelectionApplied?.() }
  }, [selectionRequest?.sequence])
  return <section ref={host} className="office-command-input no-drag" data-office-command-target={target.kind + ':' + target.id}
    aria-label={zh ? '御案任务指令' : 'Task command desk'}>
    <form onSubmit={(event) => { event.preventDefault(); void command.send() }}>
      <CommandTarget lines={lines} target={target} selected={Boolean(incoming)} scope={scope} setScope={setScope} lineId={lineId} setLineId={setLineId} zh={zh} />
      {target.kind === 'session' && <div className="office-command-task-links">
        <span>{zh ? '对话、文件和草稿沿用当前任务' : 'Conversation, files and draft belong to this task'}</span>
        <button type="button" className="btn btn-ghost btn-sm" data-office-command-conversation={target.id} onClick={() => onOpenSession(target.id)}>{zh ? '对话与文件' : 'Conversation and files'}</button>
        {onOpenWorkspace && <button type="button" className="btn btn-ghost btn-sm" data-office-command-workspace={target.id} onClick={() => onOpenWorkspace(target.id)}>{zh ? '工作台继续' : 'Open in workspace'}</button>}
      </div>}
      <CommandCompose command={command} target={target} zh={zh} />
    </form>
    <CommandFeedback command={command} target={target} zh={zh} onOpenTask={onOpenTask} onOpenSession={onOpenSession} />
    {target.kind === 'session' && command.modelRequestSessionId === target.id && <SessionModelPicker
      key={target.id} sessionId={target.id} onClose={command.closeModelPicker} />}
    {target.kind === 'session' && command.requirementRevision?.sessionId === target.id && <TaskRequirementRevision key={target.id}
      sessionId={target.id} initialText={command.requirementRevision.text} onClose={command.closeRequirementRevision} />}
    {target.kind === 'session' && <SessionInputQueue zh={zh}
      records={command.sessionInputs.records} running={command.running} busy={command.sessionInputs.busy}
      error={command.sessionInputs.error} onApply={command.sessionInputs.apply}
      onCancel={command.sessionInputs.cancel} onRefresh={command.sessionInputs.refresh} />}
    <CommandPending command={command} zh={zh} />
  </section>
}

function CommandTarget({ lines, target, selected, scope, setScope, lineId, setLineId, zh }: {
  lines: BusinessLineDefinition[]; target: OfficeCommandTarget; selected: boolean; scope: OfficeCommandSelectionRequest['scope']
  setScope(value: OfficeCommandSelectionRequest['scope']): void; lineId: string; setLineId(value: string): void; zh: boolean
}): React.JSX.Element {
  return (<div className="office-command-target">
        <strong>{zh ? '御案' : 'Command'}</strong>
        {selected && <select value={scope} onChange={(event) => setScope(event.target.value === 'selection' ? 'selection' : 'new')} aria-label={zh ? '指令作用范围' : 'Command scope'}>
          <option value="selection">{zh ? '所选任务' : 'Selected task'}</option><option value="new">{zh ? '新任务' : 'New task'}</option>
        </select>}
        {target.kind === 'business' || scope === 'new' ? <select value={lineId} data-office-command-business-line
          onChange={(event) => setLineId(event.target.value)} aria-label={zh ? '新任务业务线' : 'Business line for new task'}>
          {lines.filter((item) => item.enabled).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select> : <span title={target.title}>{target.title}</span>}
      </div>)
}

function CommandCompose({ command, target, zh }: { command: Command; target: OfficeCommandTarget; zh: boolean }): React.JSX.Element {
  const label = command.busy ? (zh ? '提交中' : 'Submitting')
    : target.kind === 'session' ? (zh ? '交给此任务' : 'Send to task') : (zh ? '开始任务' : 'Start task')
  return (<div className="office-command-compose">
        <textarea data-office-command-text value={command.text} onChange={(event) => command.setText(event.target.value)} rows={2}
          aria-label={zh ? '任务要求' : 'Task instruction'}
          placeholder={target.kind === 'session' ? (zh ? '向这个任务补充要求…' : 'Add an instruction to this task…') : (zh ? '输入目标、成果要求或需要解决的问题…' : 'Describe the goal and the result you need…')}
          onKeyDown={(event) => { if (matchesDesktopShortcut(event.nativeEvent, 'submitMultiline', useStore.getState().settings.desktopShortcuts)) { event.preventDefault(); void command.send() } }} />
        <button className="btn btn-primary" data-office-command-send disabled={command.busy || !command.text.trim() || target.kind === 'unavailable'}>
          {label}
        </button>
      </div>)
}

function CommandPending({ command, zh }: { command: Command; zh: boolean }): React.JSX.Element | null {
  if (!command.pending.length) return null
  return (<details className="office-command-pending"><summary>{zh ? '待确认的提交' : 'Pending submissions'} ({command.pending.length})</summary>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void command.recover()}>{zh ? '查询回执' : 'Check receipts'}</button>
      {command.pending.map((item) => <div key={item.draft.clientRequestId}>
        <span>{item.draft.input.text.slice(0, 70)}</span>
        {item.receipt?.status !== 'needs_reconciliation' && <button type="button" className="btn btn-ghost btn-sm" disabled={command.busy}
          onClick={() => void command.send(item.draft.clientRequestId)}>{zh ? '重试原提交' : 'Retry original'}</button>}
      </div>)}
    </details>)
}

function CommandFeedback({ command, target, zh, onOpenTask, onOpenSession }: {
  command: Command; target: OfficeCommandTarget; zh: boolean; onOpenTask?: () => void; onOpenSession(id: string): void
}): React.JSX.Element {
  return <>    {target.kind === 'unavailable' && <p>{zh ? '所选事项使用右侧控制；也可切换到新任务交办。' : 'Use the selected item’s controls, or choose New task.'}
      {onOpenTask && <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenTask}>{zh ? '打开所选事项' : 'Open selected item'}</button>}</p>}
    {command.message && <div role={command.error ? 'alert' : 'status'} data-office-command-receipt>{command.message}
      {command.lastSessionId && <button type="button" className="btn btn-ghost btn-sm" data-office-command-open onClick={() => onOpenSession(command.lastSessionId!)}>{zh ? '查看任务' : 'Open task'}</button>}</div>}
</>
}

function commandSelection(session?: { id: string; title: string }, task?: { id: string; title: string }): OfficeCommandTarget | undefined {
  if (session) return { kind: 'session', ...session }
  if (task) return { kind: 'unavailable', ...task }
  return undefined
}
