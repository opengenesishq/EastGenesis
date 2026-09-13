import { useState } from 'react'
import { useStore } from '../../store'
import type { MediaJobRecord } from '../../../../shared/media-types'
import type { OfficeOperationalActor } from './operationalActors'
import { MEDIA_ACTION_RECEIPTS, operateOfficeMedia, type MediaActionReceipt } from './officeMediaActions'

const STATUS_LABELS: Record<string, [string, string]> = {
  requested: ['待提交', 'Queued'], submitting: ['提交中', 'Submitting'],
  running: ['执行中', 'Running'], downloading: ['下载成果', 'Downloading'],
  waiting_reconciliation: ['等待对账', 'Awaiting reconciliation'],
  succeeded: ['已完成', 'Completed'], cancelled: ['已取消', 'Cancelled'],
  failed: ['失败', 'Failed'], verifying: ['验证中', 'Verifying'],
  waiting_approval: ['等待审批', 'Awaiting approval'], blocked: ['受阻', 'Blocked'],
  done: ['已完成', 'Completed'], ready: ['就绪', 'Ready'], backlog: ['待安排', 'Backlog']
}

function useMediaControls(actor: OfficeOperationalActor, onJobChanged: (job: MediaJobRecord) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState<MediaActionReceipt>()
  const operate = async (action: 'cancel' | 'observe'): Promise<void> => {
    setBusy(true)
    setError('')
    setReceipt(undefined)
    try {
      const result = await operateOfficeMedia(window.agentDesk, actor, action)
      onJobChanged(result.job)
      setReceipt(result.receipt)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }
  return { busy, error, receipt, operate }
}

function OfficeActorFacts({ actor, zh }: { actor: OfficeOperationalActor; zh: boolean }): React.JSX.Element {
  return <div className="office-signal-list">
    <div><span>{zh ? '厂商 / 模型' : 'Provider / model'}</span><strong>{actor.providerName || '—'} / {actor.model || '—'}</strong></div>
    <div><span>{zh ? '实际费用' : 'Actual cost'}</span><strong>{actor.actualUsd === undefined ? (zh ? '尚未结算' : 'Not settled') : `$${actor.actualUsd.toFixed(4)}`}</strong></div>
    {actor.estimatedUsd !== undefined && <div><span>{zh ? '预计费用' : 'Estimated cost'}</span><strong>${actor.estimatedUsd.toFixed(4)}</strong></div>}
    <div><span>{zh ? '成果' : 'Artifacts'}</span><strong>{actor.artifactIds.length}</strong></div>
  </div>
}

export default function OfficeOperationalPanel({ actor, onOpen, onJobChanged, onClose }: {
  actor: OfficeOperationalActor
  onOpen: (actor: OfficeOperationalActor) => void
  onJobChanged: (job: MediaJobRecord) => void
  onClose: () => void
}): React.JSX.Element {
  const zh = useStore((s) => s.settings.language) === 'zh'
  const { busy, error, receipt, operate } = useMediaControls(actor, onJobChanged)
  const activeMedia = actor.kind === 'media' && !['failed', 'succeeded', 'cancelled'].includes(actor.status)
  return <div className="office-selection-panel no-drag" role="complementary" aria-label={zh ? '任务详情' : 'Task details'} data-office-operational-panel={actor.id}>
    <div className="office-selection-kicker">{zh ? '真实执行任务' : 'Execution task'}
      <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label={zh ? '关闭任务详情' : 'Close task details'}>×</button>
    </div>
    <div className="office-selection-title">{actor.title}</div>
    <div className="office-selection-meta"><span>{STATUS_LABELS[actor.status]?.[zh ? 0 : 1] ?? actor.status}</span>
      {actor.simulated && <span>{zh ? '模拟任务' : 'Simulated task'}</span>}
    </div>
    <OfficeActorFacts actor={actor} zh={zh} />
    {actor.reason && <p>{actor.reason}</p>}
    {error && <p role="alert">{error}</p>}
    {receipt && <p role="status" data-office-action-receipt={receipt}>{MEDIA_ACTION_RECEIPTS[receipt][zh ? 0 : 1]}</p>}
    <OfficeMediaButtons actor={actor} zh={zh} busy={busy} activeMedia={activeMedia} onOpen={onOpen} operate={operate} />
  </div>
}

function OfficeMediaButtons({ actor, zh, busy, activeMedia, onOpen, operate }: {
  actor: OfficeOperationalActor; zh: boolean; busy: boolean; activeMedia: boolean
  onOpen: (actor: OfficeOperationalActor) => void; operate: (action: 'cancel' | 'observe') => Promise<void>
}): React.JSX.Element {
  return <div className="office-operation-actions">
    <button className="btn btn-primary btn-sm" data-office-operational-open onClick={() => onOpen(actor)}>{zh ? '打开工作区' : 'Open workspace'}</button>
    {actor.artifactIds.length > 0 && <button className="btn btn-ghost btn-sm" data-office-operational-results onClick={() => onOpen(actor)}>{zh ? '查看成果' : 'View results'}</button>}
    {activeMedia && <>
      <button className="btn btn-ghost btn-sm" data-office-operational-observe disabled={busy} onClick={() => void operate('observe')}>{zh ? '检查 / 继续' : 'Check / continue'}</button>
      <button className="btn btn-ghost btn-sm" data-office-operational-cancel disabled={busy} onClick={() => void operate('cancel')}>{zh ? '取消任务' : 'Cancel task'}</button>
    </>}
  </div>
}
