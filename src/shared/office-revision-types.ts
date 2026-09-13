/** Office revision V1 edits ordinary paragraph text and literal cells only. */
export type OfficeRevisionKind = 'document' | 'spreadsheet'
export type OfficeLiteral = string | number | boolean | null
export type OfficeRevisionCheckState = 'passed' | 'failed' | 'not_checked'
export interface OfficeRevisionCheck { id: string; state: OfficeRevisionCheckState; message: string }
export interface OfficeRevisionScope { projectId: string; goalId?: string; workItemId: string; businessLineId?: string }
export interface OfficeArtifactIdentity {
  id: string; digest: string; lineageId: string; version: number; kind: OfficeRevisionKind; title: string
  supersedesId?: string; latest: boolean
}
export interface OfficeParagraphSnapshot {
  id: string; index: number; text: string; nodeDigest: string; editable: boolean; reason?: string
}
export interface OfficeCellSnapshot {
  sheetId: string; address: string; type: 'string' | 'number' | 'boolean' | 'blank' | 'formula' | 'unsupported'
  value?: OfficeLiteral; formula?: string; cachedValue?: string; nodeDigest: string; editable: boolean; reason?: string
}
export interface OfficeSheetSnapshot { id: string; name: string; usedRange?: string }
export interface OfficeArtifactSnapshot {
  schemaVersion: 1; artifact: OfficeArtifactIdentity; scope: OfficeRevisionScope
  editability: { editable: boolean; reasons: string[] }
  coverage: { complete: boolean; truncated: boolean; paragraphCount: number; cellCount: number; limits: { paragraphs: number; cells: number; characters?: number } }
  paragraphs: OfficeParagraphSnapshot[]; sheets: OfficeSheetSnapshot[]; cells: OfficeCellSnapshot[]
  checks: OfficeRevisionCheck[]
}
export interface OfficeArtifactInspectInput { sessionId: string; artifactId: string; expectedDigest?: string; locationId?: string }
export type OfficeRevisionOperation =
  | { kind: 'replaceParagraphText'; paragraphId: string; expectedNodeDigest: string; text: string }
  | { kind: 'setCellValue'; sheetId: string; address: string; expectedNodeDigest: string; value: OfficeLiteral }
export interface OfficeRevisionDraftInput {
  baseArtifactId: string; expectedDigest: string; operations: OfficeRevisionOperation[]
}
export interface OfficeRevisionPlanInput extends OfficeRevisionDraftInput { sessionId: string }
export interface OfficeRevisionChange { targetId: string; label: string; before: string; after: string }
export interface OfficeRevisionPlan {
  schemaVersion: 1; planId: string; planDigest: string; sessionId: string; baseArtifactId: string; baseDigest: string
  nextVersion: number; changes: OfficeRevisionChange[]; unchangedScopeDigest: string
  checks: OfficeRevisionCheck[]; blockedReasons: string[]; expiresAt: number
}
/** References a main-process prepared plan; prose never authorizes its scope. */
export interface OfficeRevisionIntent { planId: string; planDigest: string; baseArtifactId: string; baseDigest: string }
export interface OfficeRevisionResult {
  schemaVersion: 1; artifactId: string; digest: string; lineageId: string; version: number; supersedesId: string
  planDigest: string; checks: OfficeRevisionCheck[]; status: 'registered'
}
export interface OfficeRevisionApi {
  inspectOfficeArtifact(input: OfficeArtifactInspectInput): Promise<OfficeArtifactSnapshot>
  planOfficeRevision(input: OfficeRevisionPlanInput): Promise<OfficeRevisionPlan>
}
/** Distinct target kind prevents old create-only producers interpreting a revision as v1. */
export interface OfficeRevisionEffectTarget {
  kind: 'office_artifact_revision'; schemaVersion: 1; artifactKind: OfficeRevisionKind
  sessionId: string; projectId: string; goalId?: string; workItemId: string; businessLineId?: string
  baseArtifactId: string; baseDigest: string; baseVersion: number; lineageId: string
  planId: string; planDigest: string; operations: OfficeRevisionOperation[]; unchangedScopeDigest: string
  rootPath: string; rootIdentity: { device: string; inode: string }; relativePath: string; workspacePath: string
  expectedSha256: string; expectedBytes: number; mediaType: string; title: string
}
