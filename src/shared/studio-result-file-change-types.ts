export interface StudioResultFileObservation {
  artifactId: string
  expectedDigest: string
  state: 'unchanged' | 'modified' | 'unavailable' | 'not_checkable'
  observedDigest?: string
  reason?: 'no_local_source' | 'missing' | 'unsafe_path' | 'size_limit' | 'unstable' | 'unreadable'
}

/** A file check preserves local bytes and only invalidates canonical verification. */
export interface StudioResultFileCheck {
  checkedAt: number
  files: StudioResultFileObservation[]
  planDigest?: string
  changedArtifactIds: string[]
  protectedArtifactIds: string[]
  rerunWorkItemIds: string[]
  reviewWorkItemIds: string[]
  acceptanceIds: string[]
  unresolvedReferences: string[]
}
