import { useCallback, useEffect, useRef, useState } from 'react'
import type { LearningProjectSnapshot, LearningRecord } from '../../../shared/learning-types'

type LearningDecisionAction = 'approve' | 'reject' | 'rollback' | 'revoke' | 'delete'

interface Props {
  sessionId: string
  refreshToken: number
  onChanged?(): Promise<void>
  contributionAllowed?: boolean
}

export default function LearningApprovalPanel(props: Props): React.JSX.Element {
  return <ProjectLearningApprovalPanel key={props.sessionId} {...props} />
}

function ProjectLearningApprovalPanel({ sessionId, refreshToken, onChanged, contributionAllowed = true }: Props): React.JSX.Element {
  const loadSequence = useRef(0)
  const mounted = useRef(false)
  const [snapshot, setSnapshot] = useState<LearningProjectSnapshot | null>(null)
  const [actingId, setActingId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    if (!mounted.current) return
    const sequence = ++loadSequence.current
    setSnapshot(null)
    try {
      const result = await window.agentDesk.listLearning(sessionId)
      if (!mounted.current || sequence !== loadSequence.current) return
      setSnapshot(result)
      setError('')
    } catch (err) {
      if (!mounted.current || sequence !== loadSequence.current) return
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [sessionId])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      loadSequence.current++
    }
  }, [load, refreshToken])

  const decide = async (action: LearningDecisionAction, recordId: string): Promise<void> => {
    setActingId(recordId)
    setError('')
    try {
      if (action === 'approve') await window.agentDesk.approveLearning(sessionId, recordId)
      else if (action === 'reject') await window.agentDesk.rejectLearning(sessionId, recordId)
      else if (action === 'rollback') await window.agentDesk.rollbackLearning(sessionId, recordId)
      else if (action === 'revoke') await window.agentDesk.revokeLearning(sessionId, recordId)
      else await window.agentDesk.deleteLearning(sessionId, recordId)
      if (mounted.current) {
        if (onChanged) await onChanged()
        else await load()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActingId(null)
    }
  }

  const records = snapshot?.records ?? []
  const recordsById = new Map(records.map((record) => [record.id, record]))
  return (
    <div className="memory-group" data-learning-approval-panel="true">
      <h4 className="settings-h3">学习审批 · {records.length}</h4>
      {error && <div className="notice notice-error">{error}</div>}
      {records.length === 0 ? (
        <div className="provider-empty">暂无学习记录</div>
      ) : (
        <div className="provider-list">
          {records.map((record) => (
            <LearningRecordRow
              key={record.id}
              record={record}
              previous={record.supersedes ? recordsById.get(record.supersedes) : undefined}
              disabled={actingId !== null}
              contributionAllowed={contributionAllowed}
              onDecision={decide}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function LearningRecordRow({
  record,
  previous,
  disabled,
  contributionAllowed,
  onDecision
}: {
  record: LearningRecord
  previous?: LearningRecord
  disabled: boolean
  contributionAllowed: boolean
  onDecision(action: LearningDecisionAction, recordId: string): Promise<void>
}): React.JSX.Element {
  return (
    <div className="provider-row memory-row" data-learning-record={record.status}>
      <div className="provider-row-body">
        <div className="provider-row-name">
          {record.payload.type === 'memory' ? record.payload.title : record.payload.name}
          <span className="migrate-kind">{record.kind}</span>
          <span className="migrate-kind">{statusLabel(record.status)}</span>
        </div>
        <div className="provider-row-sub memory-body">
          {record.payload.type === 'memory' ? record.payload.body : record.payload.description}
        </div>
        <div className="field-hint">
          v{record.version} · {record.scope} · {Math.round(record.confidence * 100)}% · {record.source}
        </div>
        <div className="field-hint">{record.diff.summary}: {record.diff.changedFields.join(', ') || '-'}</div>
        <LearningChangePreview record={record} previous={previous} />
        {record.expiresAt && <div className="field-hint">到期: {record.expiresAt}</div>}
      </div>
      <div className="provider-row-actions">
        {record.status === 'draft' && (
          <>
            <DecisionButton label="批准" action="approve" record={record} disabled={disabled || (record.kind === 'memory' && !contributionAllowed)} onDecision={onDecision} />
            <DecisionButton label="拒绝" action="reject" record={record} disabled={disabled} onDecision={onDecision} />
          </>
        )}
        {record.status === 'active' && (
          <DecisionButton label="撤销" action="revoke" record={record} disabled={disabled} onDecision={onDecision} />
        )}
        {canRollback(record) && (
          <DecisionButton label="回滚到此版本" action="rollback" record={record} disabled={disabled || (record.kind === 'memory' && !contributionAllowed)} onDecision={onDecision} />
        )}
        {record.status !== 'deleted' && (
          <DecisionButton label="删除" action="delete" record={record} disabled={disabled} onDecision={onDecision} />
        )}
      </div>
    </div>
  )
}

interface SkillMarkdownDiffLine {
  kind: 'context' | 'removed' | 'added'
  text: string
}

export function LearningChangePreview({
  record,
  previous
}: {
  record: LearningRecord
  previous?: LearningRecord
}): React.JSX.Element | null {
  if (record.payload.type === 'memory') {
    const prior = previous?.payload.type === 'memory' ? previous.payload : undefined
    return (
      <details className="learning-skill-preview">
        <summary>查看记忆修订与来源</summary>
        <div className="field-hint">来源: {record.source} · v{record.version} · {record.createdAt}</div>
        {record.supersedes && <section className="learning-skill-version">
          <div className="field-hint">上一版本 · {record.diff.previousDigest ?? '-'}</div>
          <pre className="learning-skill-markdown" data-memory-before="true">
            {prior ? `${prior.title}\n\n${prior.body}\n\n理由: ${prior.reason}` : '（上一版本记录不可用）'}
          </pre>
        </section>}
        <section className="learning-skill-version">
          <div className="field-hint">当前记录 · {record.digest}</div>
          <pre className="learning-skill-markdown" data-memory-after="true">
            {`${record.payload.title}\n\n${record.payload.body}\n\n理由: ${record.payload.reason}`}
          </pre>
        </section>
      </details>
    )
  }
  const skill = record.payload
  const previousSkill = previous?.payload.type === 'skill' ? previous.payload : undefined
  const expectsPrevious = Boolean(record.supersedes)
  const previousMarkdown = previousSkill?.markdown ?? ''
  const canBuildDiff = Boolean(previousSkill) || !expectsPrevious
  const diffLines = canBuildDiff ? buildSkillMarkdownDiff(previousMarkdown, skill.markdown) : []
  return (
    <details className="learning-skill-preview">
      <summary>查看 Skill 完整内容与差异</summary>
      <div className="learning-skill-versions">
        <section className="learning-skill-version">
          <div className="field-hint">上一版本完整 Markdown · {record.diff.previousDigest ?? '-'}</div>
          <pre className="learning-skill-markdown" data-skill-markdown-before="true">
            {previousSkill
              ? previousMarkdown
              : expectsPrevious
                ? '（上一版本记录不可用）'
                : '（新建 Skill，无上一版本）'}
          </pre>
        </section>
        <section className="learning-skill-version">
          <div className="field-hint">待批准版本完整 Markdown · {record.digest}</div>
          <pre className="learning-skill-markdown" data-skill-markdown-after="true">
            {skill.markdown}
          </pre>
        </section>
      </div>
      {canBuildDiff ? (
        <section className="learning-skill-diff-section">
          <div className="field-hint">前后 Markdown 差异 · {skill.relativePath}</div>
          <pre className="learning-skill-diff" data-skill-markdown-diff="true">
            {diffLines.length > 0 ? (
              diffLines.map((line, index) => (
                <span
                  className={`learning-diff-line learning-diff-${line.kind}`}
                  data-diff-kind={line.kind}
                  key={index}
                >
                  {diffLinePrefix(line.kind)}{line.text}
                </span>
              ))
            ) : (
              <span className="learning-diff-line learning-diff-context">  （Markdown 内容无变化）</span>
            )}
          </pre>
        </section>
      ) : (
        <div className="notice notice-error" data-skill-diff-unavailable="true">
          上一版本记录不可用，无法生成可信的前后差异。
        </div>
      )}
    </details>
  )
}

export function buildSkillMarkdownDiff(
  previousMarkdown: string,
  proposedMarkdown: string
): SkillMarkdownDiffLine[] {
  const previousLines = splitMarkdownLines(previousMarkdown)
  const proposedLines = splitMarkdownLines(proposedMarkdown)
  let prefixLength = 0
  while (
    prefixLength < previousLines.length &&
    prefixLength < proposedLines.length &&
    previousLines[prefixLength] === proposedLines[prefixLength]
  ) {
    prefixLength += 1
  }

  let suffixLength = 0
  while (
    suffixLength < previousLines.length - prefixLength &&
    suffixLength < proposedLines.length - prefixLength &&
    previousLines[previousLines.length - 1 - suffixLength] === proposedLines[proposedLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1
  }

  const previousChangeEnd = previousLines.length - suffixLength
  const proposedChangeEnd = proposedLines.length - suffixLength
  return [
    ...previousLines.slice(0, prefixLength).map((text) => ({ kind: 'context' as const, text })),
    ...previousLines.slice(prefixLength, previousChangeEnd).map((text) => ({ kind: 'removed' as const, text })),
    ...proposedLines.slice(prefixLength, proposedChangeEnd).map((text) => ({ kind: 'added' as const, text })),
    ...proposedLines.slice(proposedChangeEnd).map((text) => ({ kind: 'context' as const, text }))
  ]
}

function splitMarkdownLines(markdown: string): string[] {
  return markdown.length > 0 ? markdown.split('\n') : []
}

function diffLinePrefix(kind: SkillMarkdownDiffLine['kind']): string {
  if (kind === 'removed') return '- '
  if (kind === 'added') return '+ '
  return '  '
}

function DecisionButton({ label, action, record, disabled, onDecision }: {
  label: string
  action: LearningDecisionAction
  record: LearningRecord
  disabled: boolean
  onDecision(action: LearningDecisionAction, recordId: string): Promise<void>
}): React.JSX.Element {
  return (
    <button className="btn btn-ghost btn-sm" disabled={disabled} onClick={() => void onDecision(action, record.id)}>
      {label}
    </button>
  )
}

function canRollback(record: LearningRecord): boolean {
  if (record.kind === 'memory' && record.status === 'expired') return false
  return record.status !== 'draft' && record.status !== 'active' && record.status !== 'deleted'
}

function statusLabel(status: LearningRecord['status']): string {
  if (status === 'draft') return '待审批'
  if (status === 'active') return '已生效'
  if (status === 'rejected') return '已拒绝'
  if (status === 'superseded') return '历史版本'
  if (status === 'revoked') return '已撤销'
  if (status === 'expired') return '已过期'
  return '已删除'
}
