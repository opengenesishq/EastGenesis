import { useState } from 'react'
import type { StudioResultEvidence } from '../../../../shared/studio-result-types'
import './research-source-details.css'

/** Displays only recorded source metadata; opening a page is an explicit user action. */
export default function ResearchSourceDetails({ evidence, language, onOpen }: {
  evidence: StudioResultEvidence
  language: 'zh' | 'en'
  onOpen: (url: string) => Promise<void>
}): React.JSX.Element | null {
  const [error, setError] = useState(false)
  if (evidence.kind !== 'research_source') return null
  const en = language === 'en'
  return <div className="studio-result-source-details" data-studio-result-source={evidence.id}>
    {evidence.summary && <p>{evidence.summary}</p>}
    <p className="studio-result-muted">
      {en ? 'Source recorded: ' : '来源记录时间：'}
      <time dateTime={new Date(evidence.observedAt).toISOString()}>{new Date(evidence.observedAt).toLocaleString(en ? 'en-US' : 'zh-CN')}</time>
      {' · '}{evidence.source === 'runtime' ? (en ? 'Collected by the runtime' : '运行时采集')
        : evidence.source === 'human' ? (en ? 'User supplied' : '用户提供')
          : evidence.source === 'recovery' ? (en ? 'Recovery record' : '恢复记录') : (en ? 'Imported record' : '导入记录')}
    </p>
    {evidence.sourceUri ? <button type="button" className="btn btn-ghost btn-sm" title={evidence.sourceUri}
      onClick={() => { setError(false); void onOpen(evidence.sourceUri!).catch(() => setError(true)) }}>
      {en ? 'Open recorded source' : '打开来源原文'} · {new URL(evidence.sourceUri).hostname}
    </button> : <span className="studio-result-muted">{en ? 'No recorded web link' : '未登记可打开的网页来源'}</span>}
    {error && <p role="alert">{en ? 'The source could not be opened. Try again.' : '来源暂时无法打开，请重试。'}</p>}
  </div>
}
