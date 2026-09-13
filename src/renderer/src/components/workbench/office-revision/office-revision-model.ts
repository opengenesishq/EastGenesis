import type {
  OfficeArtifactSnapshot, OfficeCellSnapshot, OfficeLiteral, OfficeRevisionIntent,
  OfficeRevisionOperation, OfficeRevisionPlan, OfficeRevisionResult
} from '../../../../../shared/office-revision-types'
import type { StudioResultSnapshot } from '../../../../../shared/studio-result-types'

export function paragraphRevision(snapshot: OfficeArtifactSnapshot, id: string, text: string): OfficeRevisionOperation {
  const paragraph = snapshot.paragraphs.find((item) => item.id === id)
  assertEditable(snapshot, paragraph?.editable)
  if (!paragraph) throw new Error('段落已不可用，请重新读取成果。')
  return { kind: 'replaceParagraphText', paragraphId: paragraph.id, expectedNodeDigest: paragraph.nodeDigest, text }
}

export function cellRevision(snapshot: OfficeArtifactSnapshot, cell: OfficeCellSnapshot, type: string, text: string): OfficeRevisionOperation {
  const current = snapshot.cells.find((item) => item.sheetId === cell.sheetId && item.address === cell.address)
  assertEditable(snapshot, current?.editable)
  if (!current || current.type === 'formula') throw new Error('该单元格不可直接修改。')
  return { kind: 'setCellValue', sheetId: current.sheetId, address: current.address,
    expectedNodeDigest: current.nodeDigest, value: parseLiteral(type, text) }
}

function assertEditable(snapshot: OfficeArtifactSnapshot, editable?: boolean): void {
  if (!snapshot.artifact.latest || !snapshot.editability.editable || !editable) throw new Error('当前选区只读；请查看原因或选择最新成果。')
}

export function parseLiteral(type: string, text: string): OfficeLiteral {
  if (type === 'blank') return null
  if (type === 'string') return text
  if (type === 'boolean' && ['true', 'false'].includes(text)) return text === 'true'
  if (type === 'number' && text.trim() && Number.isFinite(Number(text))) return Number(text)
  throw new Error('单元格值与所选类型不一致。')
}

export function officeRevisionIntent(plan: OfficeRevisionPlan, sessionId: string, now = Date.now()): OfficeRevisionIntent {
  if (plan.sessionId !== sessionId || plan.blockedReasons.length || plan.expiresAt <= now) throw new Error('修改预览已失效或存在阻止项，请重新预览。')
  return { planId: plan.planId, planDigest: plan.planDigest, baseArtifactId: plan.baseArtifactId, baseDigest: plan.baseDigest }
}

/** A tool message alone cannot prove delivery; the canonical task snapshot must confirm the new version. */
export function canonicalRevisionMatches(snapshot: StudioResultSnapshot, result: OfficeRevisionResult, plan: OfficeRevisionPlan): boolean {
  if (snapshot.scope.sessionId !== plan.sessionId || result.planDigest !== plan.planDigest || result.supersedesId !== plan.baseArtifactId) return false
  return snapshot.artifacts.some((artifact) => artifact.id === result.artifactId && artifact.digest === result.digest &&
    artifact.version === result.version && artifact.version === plan.nextVersion && artifact.supersedesId === plan.baseArtifactId)
}

export function parseRevisionToolResult(content: string, plan: OfficeRevisionPlan): OfficeRevisionResult | undefined {
  try {
    const value = JSON.parse(content) as Partial<OfficeRevisionResult>
    if (value.schemaVersion !== 1 || value.status !== 'registered' || value.planDigest !== plan.planDigest ||
      value.supersedesId !== plan.baseArtifactId || value.version !== plan.nextVersion) return undefined
    if (![value.artifactId, value.digest, value.lineageId].every((item) => typeof item === 'string' && item.length > 0) || !Array.isArray(value.checks)) return undefined
    return value as OfficeRevisionResult
  } catch { return undefined }
}
