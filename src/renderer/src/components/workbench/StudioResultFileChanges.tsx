import { useState } from 'react'
import type { StudioResultSnapshot } from '../../../../shared/studio-result-types'
import type { StudioResultFileCheck, StudioResultFileObservation } from '../../../../shared/studio-result-file-change-types'

export default function StudioResultFileChanges({ sessionId, snapshot, language, onRefresh }: {
  sessionId: string
  snapshot?: StudioResultSnapshot
  language: 'zh' | 'en'
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<StudioResultFileCheck>()
  const [error, setError] = useState('')
  const en = language === 'en'
  const check = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setResult(await window.agentDesk.checkStudioResultFiles(sessionId))
      await onRefresh()
    } catch {
      setError(en ? 'File check failed. Refresh the result and try again.' : '文件检查失败，请刷新成果后重试。')
    } finally { setBusy(false) }
  }
  const title = (id: string): string => snapshot?.artifacts.find(artifact => artifact.id === id)?.title ?? id
  const workTitle = (id: string): string => snapshot?.workItems.find(item => item.id === id)?.title ?? id
  const changedFiles = result?.files.filter(file => file.state === 'modified' || file.state === 'unavailable') ?? []
  const unchecked = result?.files.filter(file => file.state === 'not_checkable').length ?? 0
  return (
    <section className="studio-result-section" data-studio-result-file-changes>
      <div className="studio-result-row-head">
        <h3>{en ? 'Changes outside CaoGen' : '外部文件变更'}</h3>
        <button type="button" disabled={busy || snapshot?.summary.currentArtifacts === 0} onClick={() => void check()} data-studio-result-check-files>
          {busy ? (en ? 'Checking…' : '检查中…') : (en ? 'Check file changes' : '检查文件变更')}
        </button>
      </div>
      <p className="studio-result-muted">{en
        ? 'Compare current local deliverables with their recorded versions. Changes invalidate related verification and preserve your edited files.'
        : '核对当前本地交付文件与登记版本。发现变化后，相关验收会失效，人工修改的文件会被保留。'}</p>
      {error && <p role="alert" className="studio-result-notice studio-result-notice-error">{error}</p>}
      {result && <div role="status" data-studio-result-file-check-result>
        <p>{changedFiles.length > 0
          ? (en ? `${changedFiles.length} changed or unavailable files; ${result.acceptanceIds.length} verifications require rechecking.`
            : `${changedFiles.length} 个文件已变更或不可读取；${result.acceptanceIds.length} 项验收需要重新检查。`)
          : result.files.some(file => file.state === 'unchanged')
            ? (en ? 'Checked local files match their recorded versions.' : '已检查的本地文件与登记版本一致。')
            : (en ? 'No local deliverables can be checked.' : '暂无可检查的本地交付文件。')}</p>
        {unchecked > 0 && <p className="studio-result-muted">{en
          ? `${unchecked} stored snapshots or artifacts without a local source were not checked.`
          : `${unchecked} 个存储快照或无本地来源的成果未纳入检查。`}</p>}
        {changedFiles.length > 0 && <ul>{changedFiles.map(file => <li key={file.artifactId}>
          {title(file.artifactId)} · {fileStateLabel(file, en)}
          {file.observedDigest && <span title={`${file.expectedDigest} → ${file.observedDigest}`}> · {file.expectedDigest.slice(7, 15)} → {file.observedDigest.slice(7, 15)}</span>}
        </li>)}</ul>}
        {result.reviewWorkItemIds.length > 0 && <p>{en ? 'Review before rerunning: ' : '需先确认人工修改，再重跑：'}{result.reviewWorkItemIds.map(workTitle).join('、')}</p>}
        {result.rerunWorkItemIds.length > 0 && <p>{en ? 'Affected downstream work: ' : '受影响的下游工作：'}{result.rerunWorkItemIds.map(workTitle).join('、')}</p>}
        {changedFiles.length > 0 && <p className="studio-result-muted">{en ? 'No files were overwritten and no tasks were restarted.' : '本次检查未覆盖文件，也未重新启动任务。'}</p>}
      </div>}
    </section>
  )
}

function fileStateLabel(file: StudioResultFileObservation, en: boolean): string {
  if (file.state === 'modified') return en ? 'Modified; retained for review' : '文件已修改，保留待确认'
  if (file.reason === 'missing') return en ? 'File missing' : '文件已丢失'
  if (file.reason === 'unsafe_path') return en ? 'File path changed; review required' : '文件路径已变化，需确认'
  if (file.reason === 'size_limit') return en ? 'Exceeds this check’s size limit' : '超出本次检查大小上限'
  if (file.reason === 'unstable') return en ? 'File changed during the check' : '检查期间文件仍在变化'
  return en ? 'File unavailable; review required' : '文件不可读取，需确认'
}
