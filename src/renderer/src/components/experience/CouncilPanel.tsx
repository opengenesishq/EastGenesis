import { useCallback, useEffect, useRef, useState } from 'react'
import type { CouncilContext, CouncilPhase, CouncilPreview, CouncilPreviewInput, CouncilRecord } from '../../../../shared/council-types'
import { useStore } from '../../store'
import { formatPermissionInput } from '../PermissionBar'
import { readCouncilOpinionRecords, type CouncilOpinionRecords } from './council-opinion-records'
import './council-panel.css'

export default function CouncilPanel({ sessionId, expanded = false, mode = 'council', institutionId }: {
  sessionId: string; expanded?: boolean; mode?: 'council' | 'audience'; institutionId?: string
}): React.JSX.Element {
  const meta = useStore(state => state.sessions[sessionId]?.meta)
  const binding = JSON.stringify([sessionId, meta?.workspaceId, meta?.goalId, meta?.workItemId, meta?.createdAt])
  return <CouncilSessionPanel key={`${binding}:${mode}:${institutionId ?? ''}`} sessionId={sessionId} initiallyExpanded={expanded}
    single={mode === 'audience'} initialInstitutionId={institutionId} />
}

function CouncilSessionPanel({ sessionId, initiallyExpanded, single, initialInstitutionId }: {
  sessionId: string; initiallyExpanded: boolean; single: boolean; initialInstitutionId?: string
}): React.JSX.Element {
  const zh = useStore(state => state.settings.language) === 'zh'
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const [context, setContext] = useState<CouncilContext>()
  const [topic, setTopic] = useState('')
  const [institutions, setInstitutions] = useState<string[]>([])
  const [preview, setPreview] = useState<CouncilPreview>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [openingOpinion, setOpeningOpinion] = useState<string>()
  const [opinionRecords, setOpinionRecords] = useState<CouncilOpinionRecords>()
  const [opinionError, setOpinionError] = useState('')
  const opinionRequest = useRef(0)
  const mounted = useRef(true), sequence = useRef(0), draftVersion = useRef(0)
  const previewInput = useRef<CouncilPreviewInput>()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++ } }, [])
  const refresh = useCallback(async () => {
    const request = ++sequence.current
    try {
      const next = await window.agentDesk.councilGet({ sessionId })
      if (next.sessionId !== sessionId || next.history.some(item => item.sessionId !== sessionId)) throw new Error('议事记录与当前任务不一致。')
      if (mounted.current && request === sequence.current) { setContext(next); setError('') }
    } catch (cause) { if (mounted.current && request === sequence.current) setError(errorText(cause)) }
  }, [sessionId])
  const history = [...(context?.history ?? [])].sort((a, b) => b.startedAt - a.startedAt)
  const active = history.find(item => isRunning(item.phase) || item.phase === 'needs_reconciliation')
  useEffect(() => {
    if (!expanded) return
    void refresh()
    if (!active || !isRunning(active.phase)) return
    const timer = window.setInterval(() => void refresh(), 2500)
    return () => window.clearInterval(timer)
  }, [expanded, active?.councilId, active?.phase, refresh])
  const changeDraft = (): void => { draftVersion.current++; previewInput.current = undefined; setPreview(undefined); setError('') }
  const getPreview = async (): Promise<void> => {
    if (busy || active || !topic.trim()) return
    setBusy(true); setError('')
    const version = draftVersion.current
    const requestId = crypto.randomUUID()
    const institutionIds = single ? [institutions[0] ?? eligible.find(role => role.id === initialInstitutionId)?.id ?? eligible[0]?.id].filter(Boolean) as string[] : institutions
    const input = { sessionId, requestId, topic: topic.trim(), institutionIds }
    try {
      const result = await window.agentDesk.councilPreview(input)
      if (result.sessionId !== sessionId || result.requestId !== requestId) throw new Error('议事预览与当前任务不一致。')
      if (mounted.current && version === draftVersion.current) { previewInput.current = input; setPreview(result) }
    } catch (cause) { if (mounted.current && version === draftVersion.current) setError(errorText(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const acceptRecord = (record: CouncilRecord): void => {
    if (record.sessionId !== sessionId) throw new Error('议事回执与当前任务不一致。')
    if (!mounted.current) return
    // Invalidate older poll replies so they cannot remove a newly accepted run.
    sequence.current++
    setContext(current => current && { ...current, history: [record, ...current.history.filter(item => item.councilId !== record.councilId)] })
  }
  const start = async (): Promise<void> => {
    if (!preview || !previewInput.current || previewInput.current.requestId !== preview.requestId || busy || active || preview.blockedReasons.length) return
    setBusy(true); setError('')
    try {
      const record = await window.agentDesk.councilStart({ ...previewInput.current, previewDigest: preview.previewDigest })
      acceptRecord(record)
      if (mounted.current) setPreview(undefined)
    } catch (cause) { if (mounted.current) setError(errorText(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const stop = async (record: CouncilRecord): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try { acceptRecord(await window.agentDesk.councilStop({ sessionId, councilId: record.councilId })) }
    catch (cause) { if (mounted.current) setError(errorText(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const openOpinion = async (record: CouncilRecord, opinion: CouncilRecord['opinions'][number]): Promise<void> => {
    if (busy || openingOpinion || !opinion.sessionId) return
    const request = ++opinionRequest.current
    setOpeningOpinion(opinion.sessionId); setOpinionRecords(undefined); setOpinionError('')
    try {
      const result = await readCouncilOpinionRecords(record, opinion, {
        councilGet: input => window.agentDesk.councilGet(input),
        listSessions: () => window.agentDesk.listSessions(),
        syncSession: id => useStore.getState().syncSession(id),
        session: id => useStore.getState().sessions[id]?.meta,
        getTranscript: id => window.agentDesk.getTranscript(id),
        listHistory: () => window.agentDesk.listHistory(),
        listTaskSnapshots: () => window.agentDesk.listTaskSnapshots()
      })
      if (mounted.current && request === opinionRequest.current) setOpinionRecords(result)
    } catch (cause) { if (mounted.current && request === opinionRequest.current) setOpinionError(errorText(cause)) }
    finally { if (mounted.current && request === opinionRequest.current) setOpeningOpinion(undefined) }
  }
  const eligible = context?.institutions.filter(role => role.participation === 'on_demand' || role.participation === 'legacy') ?? []
  return <details className="council-panel" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)} data-council-session={sessionId}>
    <summary>{single ? (zh ? '单独召见' : 'Individual consultation') : (zh ? '召集议事' : 'Council review')}{active ? ` · ${phaseLabel(active.phase, zh)}` : ''}</summary>
    {expanded && <>
      <p>{single ? (zh ? '选择一个机构，就当前任务听取一轮意见。意见和原始记录保留在当前任务中，由你裁决。'
        : 'Consult one institution about this task. Its advice and original records stay with the task for your decision.')
        : (zh ? '请必要机构对当前任务提出一轮意见，形成可复核的记录。议事不会批准计划或代替你的裁决。'
        : 'Ask the relevant institutions for one round of advice on this task. The recorded opinions inform your decision and require your review.')}</p>
      {active?.phase === 'needs_reconciliation' && <p role="status">{zh
        ? '上次议事仍有结果需要核对。查看原始意见记录后，可停止该次议事；已发送请求不会自动重发。'
        : 'The previous council has unresolved results. Review the original opinions, then stop that council. Sent requests will not be repeated automatically.'}</p>}
      {!active && <>
        <label>{zh ? '议题' : 'Topic'}<textarea rows={2} maxLength={4000} value={topic} disabled={busy}
          placeholder={zh ? '例如：这份六页客户汇报还缺哪些来源？' : 'For example: Which sources are missing from this six-page report?'}
          onChange={event => { changeDraft(); setTopic(event.target.value) }} /></label>
        {single ? <label>{zh ? '召见机构' : 'Institution'}<select disabled={busy || eligible.length === 0}
          value={institutions[0] ?? eligible.find(role => role.id === initialInstitutionId)?.id ?? eligible[0]?.id ?? ''}
          onChange={event => { changeDraft(); setInstitutions([event.target.value]) }}>
          {eligible.map(role => <option key={role.id} value={role.id}>{zh ? role.name : role.nameEn}</option>)}
        </select></label> : <fieldset disabled={busy}><legend>{zh ? '参与机构（最多两个，留空由系统建议）' : 'Participants (up to two; leave empty for suggestions)'}</legend>
          {eligible.map(role => <label key={role.id} title={zh ? role.duty : role.dutyEn}><input type="checkbox"
            checked={institutions.includes(role.id)} disabled={!institutions.includes(role.id) && institutions.length >= 2}
            onChange={event => { changeDraft(); setInstitutions(current => event.target.checked ? [...current, role.id] : current.filter(id => id !== role.id)) }} />{zh ? role.name : role.nameEn}</label>)}
        </fieldset>}
        <button className="btn btn-ghost btn-sm" type="button" disabled={busy || !context || !topic.trim()} onClick={() => void getPreview()}>
          {single ? (zh ? '查看召见安排' : 'Preview consultation') : (zh ? '查看议事安排' : 'Preview council')}</button>
      </>}
      {preview && !active && <div className="council-preview" data-council-preview={preview.previewDigest}>
        <p>{zh ? '上限' : 'Limits'}：{preview.limits.rounds} {zh ? '轮' : 'round'} · {preview.participants.length} {zh ? '位参与者' : 'participants'} · {Math.ceil(preview.limits.timeoutMs / 60000)} {zh ? '分钟' : 'minutes'} · ${preview.limits.totalBudgetUsd.toFixed(2)}</p>
        <ul>{preview.participants.map(participant => <li key={participant.institutionId}><strong>{participant.institutionName}</strong> · {participant.providerName} / {participant.model}<p>{participant.duty}</p></li>)}</ul>
        {preview.blockedReasons.length > 0 ? <ul role="alert">{preview.blockedReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
          : <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => void start()}>{single ? (zh ? '按此安排开始召见' : 'Start this consultation') : (zh ? '按此安排开始议事' : 'Start this council')}</button>}
      </div>}
      {error && <p role="alert">{error}</p>}
      <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => void refresh()}>{zh ? '刷新议事记录' : 'Refresh records'}</button>
      {opinionError && <p role="alert" data-council-opinion-error>{opinionError}</p>}
      {opinionRecords && <section data-council-opinion-records={opinionRecords.sessionId} className="council-opinion-records" aria-label={zh ? '原始意见记录' : 'Original opinion records'}>
        <header><strong>{zh ? '原始意见记录' : 'Original opinion records'}</strong><button type="button" className="btn btn-ghost btn-sm" onClick={() => { opinionRequest.current++; setOpinionRecords(undefined) }}>{zh ? '收起记录' : 'Close records'}</button></header>
        <p>{opinionRecords.sessionId} · {opinionRecords.source === 'snapshot'
          ? (zh ? `只读快照 · 保存于 ${new Date(opinionRecords.capturedAt!).toLocaleString()}` : `Read-only snapshot · saved ${new Date(opinionRecords.capturedAt!).toLocaleString()}`)
          : (zh ? '只读记录' : 'Read-only records')}</p>
        {opinionRecords.transcript.length === 0 && <p role="status">{zh ? '原始转录当前不可用。可核对上方已有意见及纪要，或在恢复中心查看保存状态。' : 'The original transcript is unavailable. Review the saved opinion and council record, or inspect its saved state in Recovery.'}</p>}
        {opinionRecords.transcript.map((entry, index) => <details key={`${entry.eventId ?? entry.seq}:${index}`}><summary>{entry.seq} · {entry.event.kind}</summary><pre>{formatPermissionInput(entry)}</pre></details>)}
        {opinionRecords.recoveryAvailable && <button type="button" className="btn btn-ghost btn-sm" onClick={() => useStore.getState().setShowTaskRecovery(true)}>{zh ? '在恢复中心核对原记录' : 'Review original records in Recovery'}</button>}
      </section>}
      {history.map(record => <article key={record.councilId} data-council-id={record.councilId} data-council-phase={record.phase}>
        <header><strong>{record.topic}</strong><span>{phaseLabel(record.phase, zh)}</span>
          {(isRunning(record.phase) || record.phase === 'needs_reconciliation') && <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => void stop(record)}>{zh ? '停止议事' : 'Stop council'}</button>}</header>
        <p>{new Date(record.startedAt).toLocaleString()} · {zh ? '截止' : 'Deadline'} {new Date(record.deadlineAt).toLocaleTimeString()} · {zh ? '预算上限' : 'Budget limit'} ${record.limits.totalBudgetUsd.toFixed(2)}</p>
        {record.error && <p role="alert">{record.error}</p>}
        {record.opinions.map(opinion => <details key={opinion.institutionId}><summary>{record.participants.find(item => item.institutionId === opinion.institutionId)?.institutionName ?? opinion.institutionId} · {opinionLabel(opinion.status, zh)}</summary>
          {opinion.conclusion && <pre>{opinion.conclusion}</pre>}{opinion.error && <p role="alert">{opinion.error}</p>}
          {opinion.sessionId && <button type="button" className="btn btn-ghost btn-sm" disabled={busy || Boolean(openingOpinion)} onClick={() => void openOpinion(record, opinion)}>
            {openingOpinion === opinion.sessionId ? (zh ? '正在核对记录…' : 'Checking record…') : (zh ? '打开原始意见记录' : 'Open original opinion')}</button>}
        </details>)}
        {record.report && <details><summary>{zh ? '议事纪要与分歧' : 'Council record and differing opinions'}</summary><pre>{record.report}</pre></details>}
      </article>)}
    </>}
  </details>
}

function isRunning(phase: CouncilPhase): boolean { return phase === 'preparing' || phase === 'running' }
function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
function phaseLabel(phase: CouncilPhase, zh: boolean): string {
  return ({ preparing: ['正在准备', 'Preparing'], running: ['议事中', 'In progress'], completed: ['议事已结束', 'Council finished'], stopped: ['已停止', 'Stopped'], needs_reconciliation: ['需要核对', 'Needs reconciliation'] })[phase][zh ? 0 : 1]
}
function opinionLabel(status: CouncilRecord['opinions'][number]['status'], zh: boolean): string {
  return ({ pending: ['待开始', 'Pending'], running: ['正在整理', 'In progress'], completed: ['已完成', 'Complete'], failed: ['未完成', 'Failed'], needs_reconciliation: ['需要核对', 'Needs reconciliation'] })[status][zh ? 0 : 1]
}
