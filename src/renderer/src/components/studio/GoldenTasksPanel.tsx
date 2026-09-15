import { useCallback, useEffect, useMemo, useState } from 'react'
import manifest from '../../../../../GOLDEN-USER-TASKS/manifest.json'
import './golden-tasks-panel.css'

type GoldenTask = (typeof manifest.tasks)[number]
type GoldenSession = {
  sessionId: string
  taskId: string
  participantId: string
  consent: true
  synthetic: false
  evidenceOrigin: 'human-test'
  status: 'in_progress' | 'cancelled'
  startedAt: number
}

const STORAGE_KEY = 'caogen.golden-user-task-sessions.v1'

function readSessions(): GoldenSession[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter((item): item is GoldenSession => {
      if (!item || typeof item !== 'object') return false
      const candidate = item as Partial<GoldenSession>
      return typeof candidate.sessionId === 'string' && /^golden-[0-9a-f-]+$/iu.test(candidate.sessionId) &&
        typeof candidate.taskId === 'string' && manifest.tasks.some((task) => task.id === candidate.taskId) &&
        typeof candidate.participantId === 'string' && participantIsRedacted(candidate.participantId) && candidate.consent === true &&
        candidate.synthetic === false && candidate.evidenceOrigin === 'human-test' &&
        (candidate.status === 'in_progress' || candidate.status === 'cancelled')
    })
  } catch { return [] }
}

function persistSessions(sessions: GoldenSession[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(-50)))
}

function participantIsRedacted(value: string): boolean {
  return /^redacted-[a-z0-9][a-z0-9._-]{2,63}$/iu.test(value.trim())
}

function runnerCommand(command: string, sessionId?: string): string {
  if (command === 'report') return 'npm run golden-tasks:session -- report --out GOLDEN-USER-TASKS/evidence/operational-report.json'
  if (!sessionId) return `npm run golden-tasks:session -- ${command}`
  return `npm run golden-tasks:session -- ${command} --session ${sessionId}`
}

function finishCommand(sessionId: string): string {
  return `${runnerCommand('finish', sessionId)} --completed <true|false> --evidence-kinds <kinds> --context-copy-count <n> --evidence-complete <true|false> --recovery-attempted <true|false> --notes-file <file> --after-summary-file <file>`
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch { /* Fall through to the DOM fallback. */ }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  let copied = false
  try { copied = document.execCommand('copy') } catch { copied = false }
  textarea.remove()
  return copied
}

function downloadSessionState(sessions: GoldenSession[]): void {
  const payload = {
    schemaVersion: 1,
    kind: 'caogen.golden-task-local-session-state',
    exportedAt: new Date().toISOString(),
    policy: { realUsersOnly: true, syntheticEvidenceAllowed: false, retention: 'redacted-summary-only' },
    // This export is lifecycle state only. It deliberately contains no evidence
    // body, summary, timing result, or unredacted participant information.
    sessions: sessions.map(({ sessionId, taskId, participantId, consent, synthetic, evidenceOrigin, status, startedAt }) => ({
      sessionId, taskId, participantId, consent, synthetic, evidenceOrigin, status, startedAt
    }))
  }
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `golden-task-session-state-${Date.now()}.json`
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export default function GoldenTasksPanel({ active = true }: { active?: boolean }): React.JSX.Element {
  const [sessions, setSessions] = useState<GoldenSession[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState(manifest.tasks[0]?.id ?? '')
  const [participantId, setParticipantId] = useState('')
  const [consent, setConsent] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState('')

  const reload = useCallback(() => setSessions(readSessions()), [])
  useEffect(() => { if (active) reload() }, [active, reload])

  const selectedTask = useMemo(() => manifest.tasks.find((task) => task.id === selectedTaskId) ?? manifest.tasks[0], [selectedTaskId])
  const start = (): void => {
    const normalizedParticipant = participantId.trim()
    if (!selectedTask) return
    if (!participantIsRedacted(normalizedParticipant)) { setError('参与者标识必须是脱敏格式 redacted-…。'); return }
    if (!consent) { setError('开始真实用户任务前必须明确取得同意。'); return }
    const session: GoldenSession = {
      // Keep the canonical runner prefix while this UI only stores lifecycle
      // state; evidence promotion still requires the human capture CLI.
      sessionId: `golden-${crypto.randomUUID()}`,
      taskId: selectedTask.id,
      participantId: normalizedParticipant,
      consent: true,
      synthetic: false,
      evidenceOrigin: 'human-test',
      status: 'in_progress',
      startedAt: Date.now()
    }
    const next = [...sessions, session]
    persistSessions(next); setSessions(next); setSelectedSessionId(session.sessionId); setError(''); setNotice(`已开始 ${selectedTask.scenario} session；当前只记录状态，不会生成证据。`)
  }
  const cancel = (sessionId: string): void => {
    const next = sessions.map((session) => session.sessionId === sessionId ? { ...session, status: 'cancelled' as const } : session)
    persistSessions(next); setSessions(next); setNotice('session 已取消；未产生 Golden evidence。'); setError('')
  }
  const copyCommand = (label: string, command: string): void => {
    void copyText(command).then((copied) => setNotice(copied ? `${label}已复制到剪贴板。` : `${label}：${command}`))
  }
  const inProgressCount = sessions.filter((session) => session.status === 'in_progress').length
  // Only an in-progress session can be passed to status/finish. Cancelled
  // records remain visible for audit but never receive an actionable command.
  const selectedSession = sessions.find((session) => session.sessionId === selectedSessionId && session.status === 'in_progress') ?? sessions.find((session) => session.status === 'in_progress')
  const blockerSummary = inProgressCount > 0
    ? `当前有 ${inProgressCount} 个 session 未结束；CLI report 会保持 blocked。`
    : '本地 UI 没有证据正文；请运行 CLI report 核验真实证据后再评审。'

  return <section className="golden-tasks-panel" data-golden-tasks-panel data-golden-task-count={manifest.tasks.length} aria-labelledby="golden-tasks-title">
    <header className="golden-tasks-header"><div><h2 id="golden-tasks-title">黄金用户任务</h2><p>来自 {manifest.sourcePlan} 的五个真实用户验收场景。</p></div><span className="golden-tasks-policy">真实用户 · 脱敏摘要 · 禁止合成证据</span></header>
    {error && <p className="golden-tasks-error" role="alert">{error}</p>}
    {notice && !error && <p className="golden-tasks-notice" role="status">{notice}</p>}
    <div className="golden-tasks-layout">
      <div className="golden-task-list" role="list" aria-label="Golden User Tasks">
        {manifest.tasks.map((task) => <GoldenTaskCard key={task.id} task={task} selected={task.id === selectedTask?.id} onSelect={() => { setSelectedTaskId(task.id); setError('') }} />)}
      </div>
      {selectedTask && <section className="golden-task-session" aria-label="开始 Golden Task session">
        <h3>开始 session：{selectedTask.scenario}</h3><p>{selectedTask.userInstruction}</p>
        <label>脱敏参与者 ID<input value={participantId} onChange={(event) => setParticipantId(event.target.value)} placeholder="redacted-user-01" autoComplete="off" /></label>
        <label className="golden-task-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />我已取得参与者同意，并会在任务前后提供脱敏摘要。</label>
        <button type="button" className="btn btn-primary btn-sm" data-golden-task-action="start" onClick={start}>开始本地 session</button>
        <p className="golden-task-session-note">本入口只维护 list/start/status/cancel 状态；完成任务仍须由主持人使用 evidence capture 记录真实证据。</p>
      </section>}
    </div>
    <section className="golden-task-operator-bridge" aria-label="主持人证据操作桥接" data-golden-task-operational-status="blocked">
      <div className="golden-task-sessions-heading"><div><h3>主持人证据桥接</h3><p className="golden-task-session-note">UI 只导出脱敏生命周期状态；证据 capture 和 report 必须由主持人 CLI 完成。</p></div><span className="golden-task-blocked-badge">blocked · 需真实证据</span></div>
      <p className="golden-task-blocker" role="status">{blockerSummary}</p>
      <div className="golden-task-operator-actions">
        <button type="button" className="btn btn-ghost btn-sm" data-golden-task-action="export-state" onClick={() => { downloadSessionState(sessions); setNotice('已下载脱敏 session 状态；文件不包含证据正文。') }}>导出脱敏状态</button>
        <button type="button" className="btn btn-ghost btn-sm" data-golden-task-action="copy-report" onClick={() => copyCommand('report 命令', runnerCommand('report'))}>复制 report 命令</button>
        {selectedSession && <button type="button" className="btn btn-ghost btn-sm" data-golden-task-action="copy-status" onClick={() => copyCommand('status 命令', runnerCommand('status', selectedSession.sessionId))}>复制当前 status 命令</button>}
        {selectedSession && <button type="button" className="btn btn-ghost btn-sm" data-golden-task-action="copy-finish" onClick={() => copyCommand('finish 模板', finishCommand(selectedSession.sessionId))}>复制 finish 模板</button>}
      </div>
      {selectedSession && <div className="golden-task-command-preview" aria-label="当前 session 主持人命令"><small>当前 session：{selectedSession.sessionId}</small><code>{runnerCommand('status', selectedSession.sessionId)}</code><code>{finishCommand(selectedSession.sessionId)}</code></div>}
    </section>
    <section className="golden-task-sessions" aria-label="Golden Task session 状态"><div className="golden-task-sessions-heading"><h3>本地 session 状态</h3><div className="golden-task-sessions-actions"><button type="button" className="btn btn-ghost btn-sm" data-golden-task-action="status" onClick={reload}>刷新状态</button><button type="button" className="btn btn-ghost btn-sm" data-golden-task-action="copy-report" onClick={() => copyCommand('report 命令', runnerCommand('report'))}>复制 report</button></div></div>
      {sessions.length === 0 ? <p>尚无 session。</p> : <div role="list">{sessions.slice().reverse().map((session) => <article key={session.sessionId} role="listitem" className="golden-task-session-row" data-golden-session-status={session.status}><span><strong>{manifest.tasks.find((task) => task.id === session.taskId)?.scenario ?? session.taskId}</strong><small>{session.participantId} · {new Date(session.startedAt).toLocaleString()}</small></span><span className="golden-task-session-status">{session.status === 'in_progress' ? '进行中' : '已取消'}</span>{session.status === 'in_progress' && <button type="button" className="btn btn-ghost btn-sm" data-golden-task-action="cancel" onClick={() => cancel(session.sessionId)}>取消</button>}</article>)}</div>}
    </section>
  </section>
}

function GoldenTaskCard({ task, selected, onSelect }: { task: GoldenTask; selected: boolean; onSelect: () => void }): React.JSX.Element {
  return <button type="button" className={`golden-task-card${selected ? ' selected' : ''}`} data-golden-task-id={task.id} aria-pressed={selected} onClick={onSelect}>
    <strong>{task.scenario}</strong><span>{task.userInstruction}</span><small>交付物 {task.requiredDeliverables.length} 项 · evidence {task.acceptance.requiredEvidenceKinds.join(', ')}</small>
  </button>
}
