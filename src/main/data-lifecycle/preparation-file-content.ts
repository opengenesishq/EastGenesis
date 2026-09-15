import { extname } from 'node:path'
import { readOfficePackage, utf8 } from '../office-revision/package'
import { decodeXmlText, xmlSpans } from '../office-revision/xml-spans'
import { assertNoCredentialMaterial } from '../project-aggregate/codec'
import { assertPreparationPdfContent } from './preparation-pdf-content'

const OFFICE_PARTS: Record<string, { path: string; root: string; mediaType: string }> = {
  '.docx': { path: 'word/document.xml', root: 'document', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' },
  '.xlsx': { path: 'xl/workbook.xml', root: 'workbook', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' },
  '.pptx': { path: 'ppt/presentation.xml', root: 'presentation', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml' }
}

/** Keep this synchronous: every draft is inspected before the import writes its revoked barrier. */
export function assertPreparationFileContent(path: string, bytes: Buffer): void {
  const extension = extname(path).toLowerCase()
  if (extension === '.pdf') return assertPreparationPdfContent(bytes)
  const expected = OFFICE_PARTS[extension]
  if (!expected) {
    // Binary-looking content must not bypass its container checks by changing the extension.
    if (bytes.subarray(0, 2).toString('ascii') === 'PK' || bytes.subarray(0, 5).toString('ascii') === '%PDF-') fail('container and extension do not match')
    let text: string
    try { text = utf8(bytes) } catch { return fail('unsupported binary draft') }
    assertNoCredentialMaterial(text)
    return
  }
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) fail('Office container and extension do not match')
  const parts = readOfficePackage(bytes)
  const roots = new Map<string, ReturnType<typeof xmlSpans>[number]>()
  for (const [name, content] of parts) {
    // Current preparation writers generate XML-only packages. Opaque embeddings need their own
    // content scanner before they can be portable; accepting a ZIP alone would hide credentials.
    if (!/\.(?:xml|rels)$/i.test(name)) fail('Office draft contains unsupported opaque parts')
    const xml = utf8(content), root = xmlSpans(xml)[0]
    roots.set(name, root)
    assertNoCredentialMaterial(xml)
    assertNoCredentialMaterial(decodeXmlText(xml))
    // A word or token can be split over formatting runs, entities, or spreadsheet rich text.
    assertNoCredentialMaterial(decodeXmlText(xml.replace(/<[^>]*>/g, '')))
  }
  const contentTypes = roots.get('[Content_Types].xml'), relationships = roots.get('_rels/.rels')
  if (contentTypes?.localName !== 'Types' || relationships?.localName !== 'Relationships' ||
      roots.get(expected.path)?.localName !== expected.root ||
      !contentTypes.children.some(node => node.localName === 'Override' && node.attributes.PartName === `/${expected.path}` && node.attributes.ContentType === expected.mediaType) ||
      !relationships.children.some(node => node.localName === 'Relationship' && node.attributes.Type?.endsWith('/officeDocument') &&
        [expected.path, `/${expected.path}`].includes(node.attributes.Target) && node.attributes.TargetMode !== 'External')) {
    fail('Office primary part, relationship or content type does not match its extension')
  }
}

function fail(message: string): never { throw new Error(`Project preparation portability: ${message}`) }
