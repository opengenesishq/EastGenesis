import { stableValueDigest } from '../task/tool-idempotency'
import { normalizeOfficeIntent } from './input'

export interface OfficeRevisionReplayTarget { kind: 'office_artifact_revision'; sessionId: string; baseArtifactId: string; planDigest: string }
/** A completed revision retains this resource identity even after its base stops being the head. */
export function describeOfficeRevisionReplay(sessionId: string, args: Record<string, unknown>): { targetDigest: string } {
  const intent = normalizeOfficeIntent(args)
  return { targetDigest: officeRevisionReplayDigest({ kind: 'office_artifact_revision', sessionId, baseArtifactId: intent.baseArtifactId, planDigest: intent.planDigest }) }
}
export function officeRevisionReplayDigest(target: OfficeRevisionReplayTarget): string {
  return stableValueDigest({ kind: target.kind, sessionId: target.sessionId, baseArtifactId: target.baseArtifactId, planDigest: target.planDigest })
}
