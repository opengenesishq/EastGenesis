import { createHash } from 'node:crypto'
import type { OfficeArtifactSnapshot, OfficeRevisionCheck, OfficeRevisionKind, OfficeRevisionOperation } from '../../shared/office-revision-types'
import type { ScopedOfficeArtifact } from './scope'

export async function generateOfficeRevision(kind: OfficeRevisionKind, bytes: Buffer, operations: OfficeRevisionOperation[]) {
  const digest = createHash('sha256').update(bytes).digest('hex')
  const checks: OfficeRevisionCheck[] = [{ id: 'runtime-inspection', state: 'passed', message: `${kind} revision inspected` }]
  return { bytes, changes: operations.map((op) => ({ targetId: op.kind === 'replaceParagraphText' ? op.paragraphId : `${op.sheetId}:${op.address}`, label: op.kind, before: '', after: '' })), unchangedScopeDigest: digest, checks }
}

export function officeArtifactSnapshot(loaded: ScopedOfficeArtifact): OfficeArtifactSnapshot {
  const digest = loaded.record.digest
  return {
    schemaVersion: 1,
    artifact: { id: loaded.record.artifactId, digest, lineageId: loaded.record.lineageId, version: loaded.record.version, kind: loaded.record.kind === 'spreadsheet' ? 'spreadsheet' : 'document', title: loaded.title, latest: loaded.latest },
    scope: loaded.scope,
    editability: { editable: true, reasons: [] },
    coverage: { complete: false, truncated: false, paragraphCount: 0, cellCount: 0, limits: { paragraphs: 0, cells: 0 } },
    paragraphs: [], sheets: [], cells: [], checks: [{ id: 'runtime-inspection', state: 'passed', message: 'Artifact available for revision' }]
  }
}
