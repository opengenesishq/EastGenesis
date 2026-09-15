import type { ProjectAggregatePortableFile } from './project-aggregate-types'

export interface PortablePreparationSession {
  sessionId: string
  workspaceId: string
  goalId?: string
  workItemId?: string
  /** Exact source JSON preserves the legacy permission digest; never imported as a grant. */
  permissionSource?: string
  /** Audit-only records retained across repeated migrations and explicit reauthorization. */
  priorPermissionSources?: string[]
  /** Relative to the main-process assigned Session preparation files directory. */
  files: ProjectAggregatePortableFile[]
}

export interface ProjectPreparationSlice {
  schemaVersion: 1
  projectId: string
  sessions: PortablePreparationSession[]
  sliceDigest: string
}
