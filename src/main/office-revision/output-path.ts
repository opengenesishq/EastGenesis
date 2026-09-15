import type { OfficeRevisionKind } from '../../shared/office-revision-types'
import { officeValueDigest } from './digest'

export function officeRevisionOutputRelativePath(kind: OfficeRevisionKind, lineageId: string, baseVersion: number, planDigest: string): string {
  const extension = kind === 'document' ? 'docx' : kind === 'presentation' ? 'pptx' : 'xlsx'
  return `artifacts/office-${officeValueDigest(lineageId).slice(-16)}-v${baseVersion + 1}-${planDigest.slice(-12)}.${extension}`
}
