import type { OfficeRevisionKind } from '../../shared/office-revision-types'
import { officeError } from './errors'
import { utf8, type OfficePackage } from './package'
import { xmlSpans } from './xml-spans'

const MAIN_TYPES: Record<OfficeRevisionKind, { part: string; contentType: string }> = {
  document: { part: '/word/document.xml', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' },
  spreadsheet: { part: '/xl/workbook.xml', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' },
  presentation: { part: '/ppt/presentation.xml', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml' }
}
/** Check the actual package's main part, not a filename extension or a mutable preview. */
export function assertOfficePackageIdentity(parts: OfficePackage, kind: OfficeRevisionKind): void {
  const types = parts.get('[Content_Types].xml'), relationships = parts.get('_rels/.rels')
  if (!types || !relationships) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'Office包缺少内容类型或根关系。')
  const typeRoot = xmlSpans(utf8(types))[0], relationRoot = xmlSpans(utf8(relationships))[0]
  if (typeRoot.attributes.xmlns !== 'http://schemas.openxmlformats.org/package/2006/content-types' ||
      relationRoot.attributes.xmlns !== 'http://schemas.openxmlformats.org/package/2006/relationships') officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'Office包类型或关系命名空间不受支持。')
  const expected = MAIN_TYPES[kind]
  const declared = typeRoot.children.filter((node) => node.name === 'Override' && node.attributes.PartName === expected.part)
  const mainRelations = relationRoot.children.filter((node) => node.attributes.Type === 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument')
  if (declared.length !== 1 || declared[0].attributes.ContentType !== expected.contentType || mainRelations.length !== 1) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'Office主部件类型或关系不一致。')
  const main = mainRelations[0].attributes
  if (main.TargetMode === 'External' || `/${main.Target.replace(/^\//, '')}` !== expected.part || !parts.has(expected.part.slice(1))) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'Office主部件缺失或指向外部。')
}
