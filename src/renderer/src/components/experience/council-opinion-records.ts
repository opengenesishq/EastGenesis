import type { CouncilContext, CouncilOpinion, CouncilRecord } from '../../../../shared/council-types'
import type { HistoryEntry, SessionMeta, TaskSnapshotRecord, TranscriptEntry } from '../../../../shared/types'

export interface CouncilOpinionRecords {
  sessionId: string
  source: 'live' | 'snapshot' | 'unavailable'
  transcript: TranscriptEntry[]
  capturedAt?: number
  recoveryAvailable?: boolean
}

/** Reuse transcript and recovery reads without constructing a new Engine or
 * replaying the council's prompt. Historical opinions stay read-only. */
export async function readCouncilOpinionRecords(record: CouncilRecord, opinion: CouncilOpinion, host: {
  councilGet(input: { sessionId: string; councilId: string }): Promise<CouncilContext>
  listSessions(): Promise<SessionMeta[]>
  syncSession(id: string): Promise<boolean>
  session(id: string): SessionMeta | undefined
  getTranscript(id: string): Promise<TranscriptEntry[]>
  listHistory(): Promise<HistoryEntry[]>
  listTaskSnapshots(): Promise<TaskSnapshotRecord[]>
}): Promise<CouncilOpinionRecords> {
  const latest = await host.councilGet({ sessionId: record.sessionId, councilId: record.councilId })
  const councils = latest.history.filter(item => item.councilId === record.councilId)
  const council = councils[0]
  if (latest.sessionId !== record.sessionId || councils.length !== 1 || council.sessionId !== record.sessionId ||
    council.projectId !== record.projectId || council.goalId !== record.goalId || council.workItemId !== record.workItemId ||
    council.opinions.filter(item => item.sessionId === opinion.sessionId && item.institutionId === opinion.institutionId).length !== 1) {
    throw new Error('原始意见与当前议事记录不一致，已阻止打开。')
  }
  const matches = (meta: Pick<SessionMeta, 'id' | 'workspaceId' | 'goalId' | 'workItemId' | 'parentSessionId' | 'orchestrationId' | 'childTaskId' | 'childRole'>): boolean =>
    meta.id === opinion.sessionId && meta.parentSessionId === record.sessionId && meta.orchestrationId === record.councilId &&
    meta.childTaskId === opinion.institutionId && meta.childRole === `council:${opinion.institutionId}` &&
    meta.workspaceId === record.projectId && meta.goalId === record.goalId && meta.workItemId === `${opinion.sessionId}-review`
  const active = (await host.listSessions()).filter(meta => meta.id === opinion.sessionId)
  if (active.length > 1 || (active[0] && !matches(active[0]))) throw new Error('活动会话与议事归属不一致，已阻止打开。')
  if (active[0] && active[0].status !== 'closed' && await host.syncSession(opinion.sessionId)) {
    const hydrated = host.session(opinion.sessionId)
    if (!hydrated || !matches(hydrated)) throw new Error('同步后的会话归属已变化，已阻止打开。')
    if (hydrated.status !== 'closed') {
      const transcript = await host.getTranscript(opinion.sessionId)
      if (transcript.length) return { sessionId: opinion.sessionId, source: 'live', transcript }
    }
  }
  const [history, snapshots] = await Promise.all([host.listHistory(), host.listTaskSnapshots()])
  const historical = history.filter(entry => entry.id === opinion.sessionId)
  if (historical.length > 1 || historical.some(entry => !matches(entry))) throw new Error('历史会话与议事归属不一致，已阻止打开。')
  const bound = snapshots.filter(snapshot => snapshot.sessionId === opinion.sessionId)
  if (bound.some(snapshot => !matches(snapshot.meta))) throw new Error('恢复快照与议事归属不一致，已阻止打开。')
  const snapshot = bound.sort((left, right) => right.updatedAt - left.updatedAt)[0]
  if (snapshot?.conversationLedger?.valid === false) throw new Error('原始意见快照的转录完整性检查失败，请从恢复中心核对。')
  if (snapshot?.transcript.length) return { sessionId: opinion.sessionId, source: 'snapshot',
    transcript: snapshot.transcript, capturedAt: snapshot.updatedAt, recoveryAvailable: true }
  return { sessionId: opinion.sessionId, source: 'unavailable', transcript: [], recoveryAvailable: bound.length > 0 || historical.length > 0 }
}
