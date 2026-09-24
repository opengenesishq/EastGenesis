export type SessionFollowUpBehavior = 'queue' | 'pause_and_apply' | 'manual'

export function normalizeSessionFollowUpBehavior(value: unknown): SessionFollowUpBehavior {
  return value === 'pause_and_apply' || value === 'manual' ? value : 'queue'
}

export interface SessionInputQueueOptions {
  followUpBehavior?: SessionFollowUpBehavior
}

/** The token is deliberately process-local: restarting never silently resumes work. */
export interface SessionInputFollowUp {
  behavior: Exclude<SessionFollowUpBehavior, 'manual'>
  token: string
  sessionCreatedAt: number
  state: 'armed' | 'paused'
}
