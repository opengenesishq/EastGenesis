export type CourtStageId = 'enter' | 'salute' | 'report' | 'dismiss' | 'complete'

export interface CourtStage {
  id: CourtStageId
  zh: string
  en: string
  /** Animation seconds. The report duration is per representative. */
  durationSeconds: number
}

/** A shortened presentation timeline, not the historical duration of a court audience. */
export const COURT_STAGES: readonly CourtStage[] = [
  { id: 'enter', zh: '入班', en: 'Assemble', durationSeconds: 8 },
  { id: 'salute', zh: '行礼', en: 'Salute', durationSeconds: 6 },
  { id: 'report', zh: '奏事', en: 'Reports', durationSeconds: 8 },
  { id: 'dismiss', zh: '退朝', en: 'Dismiss', durationSeconds: 7 },
  { id: 'complete', zh: '朝会结束', en: 'Audience complete', durationSeconds: 0 },
]

export const COURT_MAX_REPRESENTATIVES = 6

export interface CourtFrame {
  stage: CourtStageId
  /** Progress through the entire current stage, clamped to 0..1. */
  progress: number
  /** Zero-based representative during reports; -1 in all other stages. */
  reportIndex: number
  /** Progress through the current representative's report, clamped to 0..1. */
  reportProgress: number
  totalDuration: number
}

export function getCourtParticipantCount(participants: number): number {
  if (Number.isNaN(participants)) return 0
  return Math.min(COURT_MAX_REPRESENTATIVES, Math.max(0, Math.floor(participants)))
}

export function getCourtFrame(elapsed: number, participants: number): CourtFrame {
  const count = getCourtParticipantCount(participants)
  const totalDuration = COURT_STAGES.reduce((sum, stage) =>
    sum + stage.durationSeconds * (stage.id === 'report' ? count : 1), 0)
  let remaining = Math.min(totalDuration, Math.max(0, Number.isNaN(elapsed) ? 0 : elapsed))

  for (const stage of COURT_STAGES) {
    const duration = stage.durationSeconds * (stage.id === 'report' ? count : 1)
    if (duration > 0 && remaining < duration) {
      const reportIndex = stage.id === 'report' ? Math.floor(remaining / stage.durationSeconds) : -1
      return {
        stage: stage.id,
        progress: remaining / duration,
        reportIndex,
        reportProgress: stage.id === 'report'
          ? (remaining - reportIndex * stage.durationSeconds) / stage.durationSeconds
          : 0,
        totalDuration,
      }
    }
    remaining -= duration
  }

  return { stage: 'complete', progress: 1, reportIndex: -1, reportProgress: 0, totalDuration }
}
