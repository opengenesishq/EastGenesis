import type { LayeredMemoryEntry } from './types'

/** Canonical project-id ownership only. Path-owned legacy records are never reassigned implicitly. */
export interface ProjectLayeredMemorySlice {
  schemaVersion: 1
  projectId: string
  /** Search vectors are derived at restore so redacted text cannot retain original tokens. */
  entries: Omit<LayeredMemoryEntry, 'vector'>[]
  ownership: 'canonical_project_id'
  legacyPathOwnership: 'unresolved_not_included'
  unknownOwnership: 'unresolved_not_included'
  sliceDigest: string
}
