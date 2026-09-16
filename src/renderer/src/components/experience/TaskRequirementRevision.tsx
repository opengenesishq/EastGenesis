import { useEffect, useMemo, useRef, useState } from 'react'
import type { Goal, GoalContract, WorkItem } from '../../../../shared/types'
import type { SessionInputRecord } from '../../../../shared/session-input-types'
import { previewSessionRequirementRevision } from '../../../../shared/session-requirement-revision'
import { useStore } from '../../store'
import { useSessionInputs } from '../composer/useSessionInputs'
import { announceRequirementRevision } from './requirement-revision-events'
import { requestTaskPlanNavigation } from './task-plan-navigation'
import './task-requirement-revision.css'

export default function TaskRequirementRevision({ sessionId, initialText = '', initialRecord, onClose }: {
  sessionId: string; initialText?: string; initialRecord?: SessionInputRecord; onClose(): void
}): React.JSX.Element {
  return <BoundRevision key={`${sessionId}:${initialRecord?.id ?? ''}`} sessionId={sessionId} initialText={initialText} initialRecord={initialRecord} onClose={onClose} />
}

function BoundRevision({ sessionId, initialText, initialRecord, onClose }: { sessionId: string; initialText: string; initialRecord?: SessionInputRecord; onClose(): void }): React.JSX.Element {
  const zh = useStore(state => state.settings.language) === 'zh'
  const meta = useStore(state => state.sessions[sessionId]?.meta)
  const running = meta?.status === 'running' || meta?.status === 'starting'
  const inputs = useSessionInputs(sessionId, running)
  const [text, setText] = useState(initialRecord?.payload.text ?? initialText)
  const [baseline, setBaseline] = useState<{ goal: Goal; work: WorkItem }>()
  const [record, setRecord] = useState<SessionInputRecord | undefined>(initialRecord)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(true), generation = useRef(0), submitting = useRef(false)
  const receiptId = useRef(initialRecord?.id)
  const panel = useRef<HTMLElement>(null)
  const identity = JSON.stringify([meta?.workspaceId, meta?.goalId, meta?.workItemId])
  const currentIdentity = useRef(identity); currentIdentity.current = identity
  const load = async (): Promise<void> => {
    const request = ++generation.current
    setLoading(true); setError('')
    try {
      if (!meta?.workspaceId || !meta.goalId || !meta.workItemId || meta.parentSessionId) throw new Error(zh ? '请先打开原目标任务，再修改交付要求。' : 'Open the original goal task to revise its requirements.')
      const [goal, work] = await Promise.all([window.agentDesk.getProjectGoal(meta.goalId), window.agentDesk.getProjectWorkItem(meta.workItemId)])
      if (!goal || !work || goal.id !== meta.goalId || goal.projectId !== meta.workspaceId || work.id !== meta.workItemId || work.projectId !== meta.workspaceId || work.goalId !== meta.goalId) throw new Error(zh ? '原目标或任务归属无法核对。' : 'The goal or task identity could not be verified.')
      if (mounted.current && request === generation.current && currentIdentity.current === identity) setBaseline({ goal, work })
    } catch (cause) { if (mounted.current && request === generation.current) setError(errorText(cause)) }
    finally { if (mounted.current && request === generation.current) setLoading(false) }
  }
  useEffect(() => {
    mounted.current = true; setBaseline(undefined); void load(); panel.current?.focus()
    return () => { mounted.current = false; generation.current++ }
  }, [sessionId, identity])
  const preview = useMemo(() => {
    if (!baseline || !text.trim()) return undefined
    try { return { value: previewSessionRequirementRevision(baseline.goal, baseline.work, text.trim()) } }
    catch (cause) { return { error: errorText(cause) } }
  }, [baseline, text])
  const saved = record?.phase === 'requirements_applied'
  const oldIntent = record?.payload.requirementRevisionIntent
  const stale = Boolean(baseline && oldIntent && (oldIntent.expectedGoalRevision !== baseline.goal.revision || oldIntent.expectedWorkItemRevision !== baseline.work.revision))
  const acceptRecord = (next: SessionInputRecord): void => {
    if (next.sessionId !== sessionId || next.id !== receiptId.current || next.workspaceId !== meta?.workspaceId || next.goalId !== meta.goalId || next.workItemId !== meta.workItemId) throw new Error(zh ? '需求修订回执身份不一致。' : 'The requirement receipt identity does not match.')
    if (next.phase === 'requirements_applied' && !next.requirementRevision) throw new Error(zh ? '修订缺少保存回执，请核对原请求。' : 'The saved revision receipt is missing. Check the original request.')
    if (!mounted.current || currentIdentity.current !== identity) return
    setRecord(next)
    if (next.phase === 'requirements_applied' && next.requirementRevision) {
      setNotice(zh ? `要求已保存到原任务，目标 v${next.requirementRevision.goalRevision}。尚未继续执行；请核对并更新计划后继续。` : `Requirements saved to the original task, goal v${next.requirementRevision.goalRevision}. Execution has not resumed; review and update the plan before continuing.`)
      announceRequirementRevision(sessionId)
    } else setNotice(zh ? '修订请求已保存，请核对回执后再确认。' : 'The revision request is saved. Check its receipt before confirming again.')
  }
  const confirm = async (): Promise<void> => {
    if (submitting.current || !baseline || !preview?.value?.changed || loading || saved || stale) return
    submitting.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const next = record ?? await inputs.queueRecord({ text: text.trim(), requirementRevisionIntent: { schemaVersion: 1,
        kind: 'revise_delivery_requirements', expectedGoalRevision: baseline.goal.revision, expectedWorkItemRevision: baseline.work.revision } })
      if (!mounted.current || currentIdentity.current !== identity) return
      receiptId.current = next.id
      if (mounted.current) setRecord(next)
      if (next.phase === 'requirements_applied') { acceptRecord(next); return }
      if (next.phase !== 'queued') { acceptRecord(next); return }
      if (running) { setNotice(zh ? '修订请求已保存到当前任务；本轮结束或暂停后，重新核对要求并确认保存。' : 'The revision request is queued for this task. Review and confirm it after this turn ends or pauses.'); return }
      acceptRecord(await window.agentDesk.applySessionInput(sessionId, next.id))
    } catch (cause) { if (mounted.current) setError(errorText(cause)) }
    finally { submitting.current = false; if (mounted.current) setBusy(false) }
  }
  const withdrawForReview = async (): Promise<void> => {
    if (!record || record.phase !== 'queued' || busy) return
    setBusy(true); setError('')
    try {
      const next = await window.agentDesk.cancelSessionInput(sessionId, record.id)
      if (next.sessionId !== sessionId || next.id !== record.id || next.phase !== 'cancelled') throw new Error(zh ? '旧修订撤回回执无效。' : 'The withdrawal receipt is invalid.')
      if (!mounted.current) return
      setRecord(undefined); receiptId.current = undefined; setNotice(''); await load()
    } catch (cause) { if (mounted.current) setError(errorText(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const checkReceipt = async (): Promise<void> => {
    if (!record || busy) return
    setBusy(true); setError('')
    try {
      const next = (await window.agentDesk.listSessionInputs(sessionId)).find(item => item.id === record.id)
      if (!next) throw new Error(zh ? '暂未找到原修订回执，请保留当前记录。' : 'The original receipt is unavailable; keep this request.')
      acceptRecord(next)
    } catch (cause) { if (mounted.current) setError(errorText(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const updatePlan = async (): Promise<void> => {
    if (!record?.requirementRevision || !meta?.goalId || busy || running) return
    setBusy(true); setError('')
    try {
      const goal = await window.agentDesk.getProjectGoal(meta.goalId)
      if (!goal || goal.projectId !== meta.workspaceId) throw new Error('原目标无法核对')
      await window.agentDesk.setTaskStrategy(sessionId, 'plan')
      const plan = await window.agentDesk.generateTaskPlan(sessionId, { objective: goal.objective, expectedGoalRevision: goal.revision })
      useStore.setState(state => ({ taskPlans: { ...state.taskPlans, [sessionId]: plan } }))
      await useStore.getState().syncSession(sessionId)
      requestTaskPlanNavigation(sessionId)
      onClose()
    } catch (cause) { if (mounted.current) setError(errorText(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }
  return <section ref={panel} tabIndex={-1} className="task-requirement-revision no-drag" data-task-requirement-revision={sessionId} role="region" aria-label={zh ? '确认交付要求修订' : 'Review delivery requirement changes'}>
    <header><strong>{zh ? '修改当前任务的交付要求' : 'Revise this task’s requirements'}</strong><button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{zh ? '关闭' : 'Close'}</button></header>
    <p>{zh ? '核对以下旧要求和新要求。确认只保存到原任务，不会立即启动执行。' : 'Review the current and proposed requirements. Confirmation saves them to this task without starting execution.'}</p>
    <label>{zh ? '修订原文' : 'Revision instruction'}<textarea rows={3} maxLength={20_000} value={text} disabled={busy || Boolean(record)}
      data-task-requirement-revision-text placeholder={zh ? '例如：第二页补来源；页数改为八页。' : 'For example: Add sources on page 2; change the page count to eight.'}
      onChange={event => { setText(event.target.value); setNotice('') }} /></label>
    {loading && <p role="status">{zh ? '正在读取原要求…' : 'Loading current requirements…'}</p>}
    {baseline && <>
      <p>{zh ? '目标' : 'Goal'} v{baseline.goal.revision} · {zh ? '任务' : 'Task'} v{baseline.work.revision}</p>
      <div className="task-requirement-comparison">
        <RequirementSide title={zh ? '当前要求' : 'Current requirements'} contract={baseline.goal.contract} acceptance={baseline.work.acceptanceSpec.map(item => item.criterion)} zh={zh} />
        {preview?.value && <RequirementSide title={zh ? '确认后要求' : 'Requirements after confirmation'} contract={preview.value.goalContract} acceptance={preview.value.acceptanceSpec.map(item => item.criterion)} zh={zh} />}
      </div>
    </>}
    {preview?.error && <p role="alert">{preview.error}</p>}
    {preview?.value && !preview.value.changed && <p role="status">{zh ? '尚未形成可保存的要求变化，请明确填写需要修改或补充的内容。' : 'No requirement change can be saved yet. Specify what to change or add.'}</p>}
    {stale && !saved && <p role="alert">{zh ? '原请求依据的目标或任务版本已更新。请撤回旧请求，再核对当前要求。' : 'The goal or task version changed since this request. Withdraw the old request and review the current requirements.'}</p>}
    {error && <p role="alert" data-task-requirement-revision-error>{error}</p>}
    {notice && <p role="status" data-task-requirement-revision-notice>{notice}</p>}
    <div className="task-requirement-revision-actions">
      {saved && <button type="button" className="btn btn-primary btn-sm" disabled={busy || running} onClick={() => void updatePlan()}>{zh ? '更新修订计划并查看' : 'Update and review the revision plan'}</button>}
      {!saved && <button type="button" className="btn btn-primary btn-sm" data-task-requirement-revision-confirm disabled={busy || loading || stale || !preview?.value?.changed || Boolean(record && (record.phase !== 'queued' || running))} onClick={() => void confirm()}>{busy ? (zh ? '正在处理…' : 'Working…') : running ? (zh ? '保存修订请求，待本轮结束后确认' : 'Queue revision for review after this turn') : (zh ? '确认并保存要求' : 'Confirm and save requirements')}</button>}
      {record?.phase === 'queued' && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void withdrawForReview()}>{zh ? '撤回旧请求并重新预览' : 'Withdraw and preview again'}</button>}
      {record && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void checkReceipt()}>{zh ? '核对原修订回执' : 'Check original receipt'}</button>}
      {!record && <button type="button" className="btn btn-ghost btn-sm" disabled={busy || loading} onClick={() => void load()}>{zh ? '刷新原要求' : 'Refresh current requirements'}</button>}
    </div>
  </section>
}

function RequirementSide({ title, contract, acceptance, zh }: { title: string; contract: GoalContract; acceptance: string[]; zh: boolean }): React.JSX.Element {
  const groups = [[zh ? '成功标准' : 'Success criteria', contract.successCriteria], [zh ? '约束' : 'Constraints', contract.constraints],
    [zh ? '目标验收' : 'Goal acceptance', contract.acceptance.map(item => item.criterion)], [zh ? '任务验收' : 'Task acceptance', acceptance]] as const
  return <div data-task-requirement-comparison={title}><strong>{title}</strong>{groups.map(([label, values]) => <div key={label}><span>{label}</span>
    {values.length ? <ul>{values.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p>{zh ? '未记录' : 'Not recorded'}</p>}</div>)}</div>
}
function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
