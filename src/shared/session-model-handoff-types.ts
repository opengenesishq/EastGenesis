import type { StudioAuditTimelineItem, StudioResultArtifact, StudioResultGoal, StudioResultScope, StudioResultWorkItem } from './studio-result-types'

/** Frozen task context owned by the existing SessionModelChange receipt, never a new task. */
export interface SessionModelHandoff {
  schemaVersion: 1
  format: 'caogen.session-model-handoff.v1'
  createdAt: number
  scope: StudioResultScope
  sourceRunId?: string
  aggregateDigest?: string
  transcript: {
    sdkSessionId?: string
    boundarySeq: number
    entryCount: number
    sourceDigest: string
    contextDigest: string
  }
  /** A prepared shorter prefix remains valid both before and after the authorized chat rewind. */
  checkpointProjection?: {
    checkpointId: string
    preparedAt: number
    previousHandoffDigest: string
    previousBoundarySeq: number
    previousEntryCount: number
    previousSourceDigest: string
    previousContextDigest: string
  }
  goal?: StudioResultGoal
  workItems: StudioResultWorkItem[]
  /** Explicitly approved memory or human Evidence; generated summaries never become confirmed facts. */
  facts: Array<{ id: string; source: 'approved_memory' | 'human_evidence'; text: string; sourceDigest: string; version?: number; actor?: string }>
  artifacts: StudioResultArtifact[]
  /** Digest of the byte-verified accepted Artifact continuation, when such files exist. */
  artifactContinuationDigest?: string
  failures: StudioAuditTimelineItem[]
  omitted: { workItems: number; facts: number; artifacts: number; failures: number }
  digest: string
}
