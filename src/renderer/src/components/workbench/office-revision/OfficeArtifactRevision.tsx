import { useState } from 'react'
import type { OfficeArtifactSnapshot, OfficeRevisionCheck, OfficeRevisionOperation, OfficeRevisionPlan, OfficeRevisionResult } from '../../../../../shared/office-revision-types'
import type { StudioResultArtifact, StudioResultSnapshot } from '../../../../../shared/studio-result-types'
import { useStore } from '../../../store'
import OfficeRevisionEditor, { officeCellLabel, officeParagraphLabel, officeSlideTextLabel } from './OfficeRevisionEditor'
import { runOfficeRevision } from './office-revision-run'
import './office-revision.css'

export default function OfficeArtifactRevision({ snapshot }: { snapshot: StudioResultSnapshot }): React.JSX.Element | null {
  const artifacts = snapshot.artifacts.filter((artifact) => artifact.kind === 'document' || artifact.kind === 'spreadsheet' || artifact.kind === 'presentation')
  const [artifactId, setArtifactId] = useState('')
  if (!artifacts.length) return null
  const artifact = artifacts.find((item) => item.id === artifactId)
  return <section className="office-artifact-revision" data-office-artifact-revision>
    <strong>指定修改</strong><p>选择这项任务的成果，预览一个段落、单元格或页面文本框的精确修改，再交给同一任务执行。</p>
    <label>成果版本<select value={artifactId} onChange={(event) => setArtifactId(event.target.value)} data-office-artifact-select><option value="">选择成果…</option>{artifacts.map((item) => <option key={item.id} value={item.id}>{item.title} · 第 {item.version} 版 · {item.deliveryScope === 'current' ? '当前版本' : '旧版本，只读'}</option>)}</select></label>
    {artifact && <OfficeArtifactDetail key={`${snapshot.scope.sessionId}:${artifact.id}:${artifact.digest}`} sessionId={snapshot.scope.sessionId} artifact={artifact} />}
  </section>
}

function OfficeArtifactDetail({ sessionId, artifact }: { sessionId: string; artifact: StudioResultArtifact }): React.JSX.Element {
  const session = useStore((state) => state.sessions[sessionId])
  const [snapshot, setSnapshot] = useState<OfficeArtifactSnapshot>()
  const [plan, setPlan] = useState<OfficeRevisionPlan>()
  const [result, setResult] = useState<OfficeRevisionResult>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const perform = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const inspect = (): Promise<void> => perform(async () => {
    setSnapshot(await window.agentDesk.inspectOfficeArtifact({ sessionId, artifactId: artifact.id, expectedDigest: artifact.digest })); setPlan(undefined)
  })
  const preview = (operation: OfficeRevisionOperation): Promise<void> => perform(async () => {
    if (!snapshot) return
    setPlan(await window.agentDesk.planOfficeRevision({ sessionId, baseArtifactId: snapshot.artifact.id, expectedDigest: snapshot.artifact.digest, operations: [operation] }))
  })
  const apply = (): Promise<void> => perform(async () => {
    if (!plan) return
    const registered = await runOfficeRevision({ api: window.agentDesk, sessionId, plan, send: useStore.getState().sendMessage })
    setResult(registered); setPlan(undefined)
    setSnapshot(await window.agentDesk.inspectOfficeArtifact({ sessionId, artifactId: registered.artifactId, expectedDigest: registered.digest }))
  })
  const taskBusy = session?.meta.status === 'running' || Boolean(session?.pendingPermissions.length)
  return <div>
    <button type="button" className="btn btn-secondary btn-sm" disabled={busy} data-office-inspect onClick={() => void inspect()}>读取任务成果</button>
    {snapshot && <>
      <p data-office-snapshot-scope={snapshot.scope.workItemId}>{snapshot.artifact.title} · 第 {snapshot.artifact.version} 版</p>
      <p>{snapshot.coverage.complete ? '选区已完整读取' : '选区未完整载入，当前只能查看，不能修改'} · {snapshot.artifact.kind === 'document' ? `${snapshot.coverage.paragraphCount} 个段落` : snapshot.artifact.kind === 'presentation' ? `${snapshot.coverage.slideCount ?? 0} 页 · ${snapshot.coverage.textBoxCount ?? 0} 个文本框` : `${snapshot.coverage.cellCount} 个单元格`}</p>
      {snapshot.editability.reasons.map((reason) => <p key={reason}>{reason}</p>)}
      {!plan && !result && <RevisionChecks checks={snapshot.checks} />}
      <OfficeRevisionEditor key={snapshot.artifact.digest} snapshot={snapshot} busy={busy} onChange={() => setPlan(undefined)} onPreview={preview} />
    </>}
    {plan && <RevisionPlanPreview plan={plan} snapshot={snapshot} disabled={busy || taskBusy || !session} onApply={() => void apply()} />}
    {busy && <p role="status">正在处理；如需批准，请在此任务中确认。修改是否完成，以新版本结果为准。</p>}
    {result && <RevisionRegistered result={result} />}
    {error && <p role="alert">{error}</p>}
  </div>
}

export function RevisionPlanPreview({ plan, snapshot, disabled, onApply }: { plan: OfficeRevisionPlan; snapshot?: OfficeArtifactSnapshot; disabled: boolean; onApply(): void }): React.JSX.Element {
  return <section className="office-revision-plan" data-office-revision-plan={plan.planDigest}>
    <strong>修改预览 · 第 {plan.nextVersion} 版</strong><p>确认后另存新版本，旧版本保留。</p>
    {plan.changes.map((change) => <div key={change.targetId}><b>{officeRevisionTargetLabel(snapshot, change.targetId)}</b><div className="office-revision-comparison"><div><span>修改前</span><pre aria-label="修改前">{change.before}</pre></div><div><span>修改后</span><pre aria-label="修改后">{change.after}</pre></div></div></div>)}
    <RevisionChecks checks={plan.checks} unchangedDigest={plan.unchangedScopeDigest} />
    {plan.blockedReasons.map((reason) => <p key={reason} role="alert">{reason}</p>)}
    <button type="button" className="btn btn-primary btn-sm" data-office-apply-revision disabled={disabled || Boolean(plan.blockedReasons.length)} onClick={onApply}>确认范围，让此任务继续修改</button>
  </section>
}

export function officeRevisionTargetLabel(snapshot: OfficeArtifactSnapshot | undefined, targetId: string): string {
  const paragraph = snapshot?.paragraphs.find((item) => item.id === targetId)
  if (paragraph) return officeParagraphLabel(paragraph)
  const cell = snapshot?.cells.find((item) => `${item.sheetId}!${item.address}` === targetId)
  if (cell && snapshot) return officeCellLabel(snapshot, cell)
  const text = snapshot?.slideTexts?.find((item) => `${item.slideId}!${item.shapeId}` === targetId)
  if (text && snapshot) return officeSlideTextLabel(snapshot, text)
  return '已选内容'
}

export function RevisionRegistered({ result }: { result: OfficeRevisionResult }): React.JSX.Element {
  return <section className="office-revision-result">
    <p role="status" data-office-revision-registered={result.artifactId}>已保存第 {result.version} 版，旧版本保留。可以在同一任务继续补充要求。</p>
    <RevisionChecks checks={result.checks} />
  </section>
}

const CHECK_LABELS: Record<string, string> = { package: '文件结构', coverage: '读取范围', semantic: '事实、引用与排版', calculation: '数字与公式', 'unselected-content': '未选内容' }
const CHECK_STATES = { passed: '已通过', failed: '未通过', not_checked: '待核验' } as const

export function RevisionChecks({ checks, unchangedDigest }: { checks: OfficeRevisionCheck[]; unchangedDigest?: string }): React.JSX.Element {
  const passed = checks.filter((check) => check.state === 'passed')
  const outstanding = checks.filter((check) => check.state !== 'passed')
  return <div className="office-revision-checks">
    {passed.length > 0 && <p className="office-revision-checked">已核验：{passed.map((check) => CHECK_LABELS[check.id] ?? '其他检查').join('、')}。</p>}
    {outstanding.map((check) => <p className="office-revision-limitation" key={check.id} role={check.state === 'failed' ? 'alert' : undefined}><strong>{CHECK_STATES[check.state]}：</strong>{officeCheckMessage(check)}</p>)}
    <details className="office-revision-technical"><summary>技术核验记录（{checks.length} 项）</summary>
      {checks.map((check) => <p key={check.id}><b>{CHECK_LABELS[check.id] ?? '其他检查'} · {CHECK_STATES[check.state]}</b><br />{check.message}</p>)}
      {unchangedDigest && <p>未选内容校验摘要：<code>{unchangedDigest}</code></p>}
    </details>
  </div>
}

function officeCheckMessage(check: OfficeRevisionCheck): string {
  if (check.id === 'package') return '文件结构尚未确认安全，请查看核验记录后再继续。'
  if (check.id === 'coverage') return '内容未完整读取，不能据此执行局部修改。'
  if (check.id === 'unselected-content') return '尚未确认其它内容保持不变，请查看核验记录。'
  return check.message
}
