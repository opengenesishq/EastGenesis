import { resolve, relative, isAbsolute, sep } from 'node:path'
import type { WorkflowLedgerDatabase } from '../task/workflow-ledger-db'
import { readArtifactLocations } from '../task/workflow-ledger-artifact-graph-query'
import { findEventById } from '../task/workflow-ledger-query'
import type { WorkflowArtifactLocationRecord } from '../../shared/workflow-types'

/** Location overlays never modify the creating Effect, lifecycle or source evidence. */
export function handoffArtifactPlacement(
  db: WorkflowLedgerDatabase, root: string, artifactId: string, checksum: string, sizeBytes: number
): WorkflowArtifactLocationRecord | undefined {
  return readArtifactLocations(db).filter(location => {
    if (location.artifactId !== artifactId || location.checksum !== checksum || location.sizeBytes !== sizeBytes ||
      location.availability !== 'available' || !location.path || !/^handoff-location:[a-f0-9]{64}:/.test(location.id)) return false
    const suffix = relative(resolve(root), resolve(location.path))
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return false
    const bundleDigest = location.id.slice('handoff-location:'.length).split(':')[0]
    const receipt = findEventById(db, `task-handoff-import:${bundleDigest}`)
    return receipt?.kind === 'workflow.task-handoff.imported' && receipt.payload.bundleDigest === bundleDigest
  }).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0]
}
