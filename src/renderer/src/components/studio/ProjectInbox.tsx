import { useEffect, useMemo, useState } from 'react'
import type { RoutineRunRecord, WorkItem } from '../../../../shared/types'
import { useStore } from '../../store'
import { TEXT } from './projectWorkspaceStudioModel'
import { localized } from './projectWorkspaceStudioLocale'
import {
  adaptRendererInboxLanes,
  WORK_INBOX_LANE_ORDER,
  type RendererInboxEntry,
  type RendererInboxLanes
} from './projectInboxAdapter'

const REFRESH_INTERVAL_MS = 15_000
const INBOX_WORK_ITEM_STATUSES = new Set<WorkItem['status']>([
  'running',
  'waiting_approval',
  'blocked',
  'verifying',
  'failed',
  'done',
  'cancelled'
])

export function ProjectInbox({
  active,
  onRefreshProject,
  projectId,
  workItems
}: {
  active: boolean
  onRefreshProject: () => Promise<void>
  projectId: string
  workItems: WorkItem[]
}): React.JSX.Element | null {
  const runs = useStore((state) => state.workbench.routineRuns)
  const loading = useStore((state) => state.workbench.routineLoading)
  const error = useStore((state) => state.workbench.routineError)
  const sessions = useStore((state) => state.sessions)
  const refresh = useStore((state) => state.refreshRoutinePanel)
  const selectSession = useStore((state) => state.selectSession)
  const [reviewingRunId, setReviewingRunId] = useState('')
  const [reviewError, setReviewError] = useState('')
  const entries = useMemo(() => projectInboxEntries(projectId, workItems, runs), [projectId, runs, workItems])
  const lanes = useMemo(() => adaptRendererInboxLanes(entries), [entries])

  const review = async (entry: RendererInboxEntry, decision: 'accept' | 'reject'): Promise<void> => {
    if (!entry.routineRunId || reviewingRunId) return
    setReviewingRunId(entry.routineRunId)
    setReviewError('')
    try {
      await window.agentDesk.reviewRoutineRun(entry.routineRunId, { decision })
      await Promise.all([refresh(), onRefreshProject()])
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setReviewingRunId('')
    }
  }

  useEffect(() => {
    if (!active) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [active, projectId, refresh])

  if (!loading && !error && entries.length === 0) return null

  return (
    <section className="pws-inbox" aria-labelledby={`project-inbox-${projectId}`} data-project-inbox={projectId}>
      <header className="pws-inbox-header">
        <div>
          <h2 id={`project-inbox-${projectId}`}>{TEXT.projectInbox}</h2>
          <span>{TEXT.attentionItemCount(entries.length)}</span>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void refresh()}>
          {loading ? TEXT.refreshing : TEXT.refresh}
        </button>
      </header>
      {error && <p className="pws-inbox-error" role="alert">{error}</p>}
      {reviewError && <p className="pws-inbox-error" role="alert">{reviewError}</p>}
      {entries.length === 0 ? (
        <p className="pws-inbox-empty">{TEXT.noInboxItems}</p>
      ) : (
        <div className="pws-inbox-lanes" data-inbox-total={entries.length}>
          {WORK_INBOX_LANE_ORDER.map((lane) => {
            const laneEntries = lanes[lane]
            if (laneEntries.length === 0) return null
            return <details key={lane} className="pws-inbox-lane" open>
              <summary>{inboxLaneLabel(lane)} <span>({laneEntries.length})</span></summary>
              <div
                className="pws-inbox-list"
                role="list"
                aria-label={`${inboxLaneLabel(lane)}: ${laneEntries.length}`}
                data-inbox-lane={lane}
                data-inbox-rendered={laneEntries.length}
                tabIndex={0}
              >
                {laneEntries.slice(0, 50).map((entry) => {
                  const canOpen = Boolean(entry.sessionId && sessions[entry.sessionId])
                  return (
                    <article key={entry.id} className="pws-inbox-row" role="listitem" data-inbox-state={entry.state}>
                      <span className={`pws-inbox-state pws-inbox-state-${entry.state}`}>{inboxStateLabel(entry.state)}</span>
                      <span className="pws-inbox-copy">
                        <strong>{entry.title}</strong>
                        {entry.detail && <span>{entry.detail}</span>}
                      </span>
                      <time dateTime={new Date(entry.updatedAt).toISOString()}>{formatInboxTime(entry.updatedAt)}</time>
                      {canOpen && entry.sessionId && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => selectSession(entry.sessionId!)}>
                          {TEXT.openSession}
                        </button>
                      )}
                      {entry.reviewable && (
                        <span className="pws-inbox-review-actions">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={Boolean(reviewingRunId)}
                            onClick={() => void review(entry, 'accept')}
                          >{TEXT.acceptReview}</button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={Boolean(reviewingRunId)}
                            onClick={() => void review(entry, 'reject')}
                          >{TEXT.rejectReview}</button>
                        </span>
                      )}
                    </article>
                  )
                })}
              </div>
            </details>
          })}
        </div>
      )}
    </section>
  )
}

function projectInboxEntries(
  projectId: string,
  workItems: readonly WorkItem[],
  runs: readonly RoutineRunRecord[]
): RendererInboxEntry[] {
  const relevantRuns = runs.filter((run) =>
    run.projectId === projectId && run.inboxStatus !== 'accepted' && run.inboxStatus !== 'rejected')
  const runByWorkItem = new Map(
    relevantRuns.filter((run) => run.workItemId).map((run) => [run.workItemId as string, run])
  )
  const entries: RendererInboxEntry[] = workItems
    .filter((item) => INBOX_WORK_ITEM_STATUSES.has(item.status))
    .map((item) => {
      const run = runByWorkItem.get(item.id)
      return {
        id: `work-item:${item.id}`,
        title: item.title,
        detail: run?.resultText || run?.error || item.description,
        state: run ? routineInboxState(run) : workItemInboxState(item),
        updatedAt: Math.max(item.updatedAt, run?.finishedAt ?? run?.startedAt ?? 0),
        sessionId: run?.sessionId,
        workItemId: item.id,
        routineRunId: run?.id,
        reviewable: run?.inboxStatus === 'needs_review'
      }
    })
  const representedRunIds = new Set(
    entries
      .map((entry) => relevantRuns.find((run) => run.workItemId === entry.workItemId)?.id)
      .filter((id): id is string => Boolean(id))
  )
  for (const run of relevantRuns) {
    if (representedRunIds.has(run.id)) continue
    entries.push({
      id: `routine-run:${run.id}`,
      title: run.routineName,
      detail: run.resultText || run.error,
      state: routineInboxState(run),
      updatedAt: run.finishedAt ?? run.startedAt,
      sessionId: run.sessionId,
      workItemId: run.workItemId,
      routineRunId: run.id,
      reviewable: run.inboxStatus === 'needs_review'
    })
  }
  return entries.sort((left, right) => inboxPriority(left.state) - inboxPriority(right.state) || right.updatedAt - left.updatedAt)
}

function routineInboxState(run: RoutineRunRecord): RendererInboxEntry['state'] {
  if (run.inboxStatus === 'waiting_approval') return 'waiting_approval'
  if (run.inboxStatus === 'needs_review') return 'needs_review'
  if (run.inboxStatus === 'failed' || run.status === 'failed') return 'failed'
  if (run.status === 'succeeded') return 'completed'
  return 'running'
}

function workItemInboxState(item: WorkItem): RendererInboxEntry['state'] {
  if (item.status === 'waiting_approval') return 'waiting_approval'
  if (item.status === 'verifying') return 'needs_review'
  if (item.status === 'blocked' || item.status === 'failed' || item.status === 'cancelled') return 'failed'
  if (item.status === 'done') return 'completed'
  return 'running'
}

function inboxStateLabel(state: RendererInboxEntry['state']): string {
  if (state === 'waiting_approval') return TEXT.inboxAwaitingApproval
  if (state === 'needs_review') return TEXT.inboxAwaitingAcceptance
  if (state === 'failed') return TEXT.inboxException
  if (state === 'ready_for_delivery') return localized('待交付', 'Ready for delivery')
  if (state === 'completed') return localized('已完成', 'Completed')
  return TEXT.inboxRunning
}

function inboxPriority(state: RendererInboxEntry['state']): number {
  if (state === 'waiting_approval') return 1
  if (state === 'needs_review') return 2
  if (state === 'failed') return 3
  if (state === 'ready_for_delivery') return 4
  if (state === 'completed') return 5
  return 4
}

function inboxLaneLabel(lane: keyof RendererInboxLanes): string {
  if (lane === 'needs_confirmation') return TEXT.inboxAwaitingApproval
  if (lane === 'running') return TEXT.inboxRunning
  if (lane === 'blocked') return TEXT.inboxException
  if (lane === 'ready_for_delivery') return localized('待交付', 'Ready for delivery')
  return localized('已完成', 'Completed')
}

function formatInboxTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}
