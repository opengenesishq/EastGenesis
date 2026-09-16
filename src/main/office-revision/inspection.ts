import type { OfficeArtifactSnapshot, OfficeCellSnapshot, OfficeRevisionChange, OfficeRevisionCheck, OfficeRevisionKind, OfficeRevisionOperation } from '../../shared/office-revision-types'
import type { ScopedOfficeArtifact } from './scope'
import { DOCUMENT_PART, inspectDocumentPackage, patchDocumentParagraph } from './document'
import { inspectSpreadsheetPackage, patchSpreadsheetCell } from './spreadsheet'
import { inspectPresentationPackage, patchPresentationText, slideTextKey } from './presentation'
import { assertOfficePackageIdentity } from './package-identity'
import { applyXmlPatches, readOfficePackage, unchangedOfficeScopeDigest, utf8, writeOfficePackage, type OfficePackage, type XmlPatch } from './package'
import { normalizeOfficeDraft, officeOperationKey } from './input'
import { officeBytesDigest } from './digest'
import { officeError } from './errors'
import { inspectSlideSequence, reviseSlideSequence } from './presentation-sequence'

export const OFFICE_INSPECTION_LIMITS = { paragraphs: 2_000, cells: 10_000, slides: 300, textBoxes: 3_000, characters: 1_000_000 } as const

function inspectPackage(kind: OfficeRevisionKind, parts: OfficePackage) {
  assertOfficePackageIdentity(parts, kind)
  if ([...parts.keys()].some((name) => name.startsWith('_xmlsignatures/'))) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '带数字签名的 Office 文件暂不支持局部修订。')
  const document = kind === 'document' ? inspectDocumentPackage(parts) : undefined
  const spreadsheet = kind === 'spreadsheet' ? inspectSpreadsheetPackage(parts) : undefined
  const presentation = kind === 'presentation' ? inspectPresentationPackage(parts) : undefined
  const paragraphs = document?.paragraphs ?? [], cells = spreadsheet?.cells ?? [], texts = presentation?.texts ?? []
  const characters = paragraphs.reduce((sum, item) => sum + item.text.length, 0)
    + cells.reduce((sum, item) => sum + String(item.value ?? '').length + (item.formula?.length ?? 0) + (item.cachedValue?.length ?? 0), 0)
    + texts.reduce((sum, item) => sum + item.text.length, 0)
  const complete = paragraphs.length <= OFFICE_INSPECTION_LIMITS.paragraphs && cells.length <= OFFICE_INSPECTION_LIMITS.cells
    && texts.length <= OFFICE_INSPECTION_LIMITS.textBoxes && (presentation?.slides.length ?? 0) <= OFFICE_INSPECTION_LIMITS.slides
    && characters <= OFFICE_INSPECTION_LIMITS.characters
  return { document, spreadsheet, presentation, complete }
}

export async function generateOfficeRevision(kind: OfficeRevisionKind, bytes: Buffer, operations: OfficeRevisionOperation[]) {
  // Revalidate at replay as well as at preview; frozen targets are persisted data.
  const normalized = normalizeOfficeDraft({ baseArtifactId: 'validated-package', expectedDigest: officeBytesDigest(bytes), operations }).operations
  if (kind === 'presentation' && normalized.length !== 1) officeError('OFFICE_PLAN_MISMATCH', '每次 PowerPoint 修订请选择一个文本框，或单独调整页面数量与顺序。')
  const parts = readOfficePackage(bytes), inspection = inspectPackage(kind, parts)
  if (!inspection.complete) officeError('OFFICE_INCOMPLETE_COVERAGE', '原稿超过完整选区读取上限，不能执行局部修订。')
  if (normalized[0].kind === 'setSlideSequence' && inspection.presentation) return reviseSlideSequence(parts, inspection.presentation, normalized[0])
  const patches = new Map<string, XmlPatch[]>(), changes: OfficeRevisionChange[] = []
  const add = (part: string, updates: XmlPatch[]): void => { patches.set(part, [...(patches.get(part) ?? []), ...updates]) }
  for (const operation of normalized) {
    if (operation.kind === 'setSlideSequence') officeError('OFFICE_PLAN_MISMATCH', '页面调整只适用于 PowerPoint，且需单独预览。')
    let before: string, after: string
    if (operation.kind === 'replaceParagraphText' && inspection.document) {
      const patch = patchDocumentParagraph(inspection.document, operation)
      before = inspection.document.paragraphs.find((item) => item.id === operation.paragraphId)!.text
      after = operation.text
      if (before !== after) add(DOCUMENT_PART, [patch])
    } else if (operation.kind === 'setCellValue' && inspection.spreadsheet) {
      const { part, patch } = patchSpreadsheetCell(inspection.spreadsheet, operation)
      const cell = inspection.spreadsheet.cells.find((item) => item.sheetId === operation.sheetId && item.address === operation.address)!
      before = String(cell.value ?? '')
      after = String(operation.value ?? '')
      if (cell.value !== operation.value) add(part, [patch])
    } else if (operation.kind === 'replaceSlideText' && inspection.presentation) {
      const update = patchPresentationText(inspection.presentation, operation)
      before = inspection.presentation.texts.find((item) => slideTextKey(item.slideId, item.shapeId) === officeOperationKey(operation))!.text
      after = operation.text
      if (update.patches.length) add(update.part, update.patches)
    } else {
      officeError('OFFICE_PLAN_MISMATCH', '修订操作与成果类型不一致。')
    }
    changes.push({ targetId: officeOperationKey(operation), label: operation.kind, before, after })
  }
  if (![...patches.values()].some((items) => items.length)) officeError('OFFICE_PLAN_MISMATCH', '选区内容没有变化。')
  const unchangedScopeDigest = unchangedOfficeScopeDigest(parts, patches)
  const output = new Map(parts), afterPatches = new Map<string, XmlPatch[]>()
  for (const [part, selected] of patches) {
    const xml = utf8(parts.get(part)!)
    output.set(part, Buffer.from(applyXmlPatches(xml, selected), 'utf8'))
    let offset = 0
    afterPatches.set(part, [...selected].sort((a, b) => a.start - b.start).map((patch) => {
      const start = patch.start + offset
      offset += patch.replacement.length - (patch.end - patch.start)
      return { start, end: start + patch.replacement.length, replacement: '' }
    }))
  }
  const generated = await writeOfficePackage(output)
  const readback = readOfficePackage(generated)
  if (unchangedOfficeScopeDigest(readback, afterPatches) !== unchangedScopeDigest) {
    officeError('OFFICE_OUTPUT_CONFLICT', '修订改变了已选范围之外的内容。')
  }
  const verified = inspectPackage(kind, readback)
  for (const operation of normalized) {
    if (operation.kind === 'setSlideSequence') officeError('OFFICE_PLAN_MISMATCH', '页面调整需单独执行。')
    const actual = operation.kind === 'replaceParagraphText'
      ? verified.document?.paragraphs.find((item) => item.id === operation.paragraphId)?.text
      : operation.kind === 'replaceSlideText'
        ? verified.presentation?.texts.find((item) => item.slideId === operation.slideId && item.shapeId === operation.shapeId)?.text
        : verified.spreadsheet?.cells.find((item) => item.sheetId === operation.sheetId && item.address === operation.address)?.value
    const expected = operation.kind === 'setCellValue' ? operation.value : operation.text
    if (actual !== expected) officeError('OFFICE_OUTPUT_CONFLICT', '新稿选区回读与冻结修改不一致。')
  }
  return { bytes: generated, changes, unchangedScopeDigest, checks: revisionChecks(kind, true, true) }
}

export function officeArtifactSnapshot(loaded: ScopedOfficeArtifact): OfficeArtifactSnapshot {
  const kind = loaded.record.kind as OfficeRevisionKind
  if (!['document', 'spreadsheet', 'presentation'].includes(kind)) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '成果类型不支持局部修订。')
  const parts = readOfficePackage(loaded.bytes), inspected = inspectPackage(kind, parts)
  const slideSequence = kind === 'presentation' ? inspectSlideSequence(parts) : undefined
  const paragraphs = inspected.document?.paragraphs ?? [], cells = inspected.spreadsheet?.cells ?? []
  const slides = inspected.presentation?.slides ?? [], texts = inspected.presentation?.texts ?? []
  const reasons = [
    ...(!loaded.latest ? ['原稿已有新版本，请选择当前版本。'] : []),
    ...(!inspected.complete ? ['原稿超过完整读取上限，当前只读。'] : []),
    ...(!slideSequence?.editable && ![...paragraphs, ...cells, ...texts].some((item) => item.editable) ? ['原稿没有支持局部修改的普通选区。'] : [])
  ]
  return {
    schemaVersion: 1,
    artifact: { id: loaded.record.artifactId, digest: loaded.record.digest, lineageId: loaded.record.lineageId,
      version: loaded.record.version, kind, title: loaded.title, latest: loaded.latest, supersedesId: loaded.record.supersedesId },
    scope: loaded.scope,
    editability: { editable: reasons.length === 0, reasons },
    coverage: { complete: inspected.complete, truncated: !inspected.complete, paragraphCount: paragraphs.length,
      cellCount: cells.length, slideCount: slides.length, textBoxCount: texts.length, limits: OFFICE_INSPECTION_LIMITS },
    paragraphs: boundedTextItems(paragraphs, OFFICE_INSPECTION_LIMITS.paragraphs),
    sheets: inspected.spreadsheet?.sheets ?? [], cells: boundedCells(cells),
    slides: slides.slice(0, OFFICE_INSPECTION_LIMITS.slides), slideTexts: boundedTextItems(texts, OFFICE_INSPECTION_LIMITS.textBoxes),
    ...(slideSequence ? { slideSequence } : {}),
    checks: revisionChecks(kind, inspected.complete, false)
  }
}

function boundedCells(items: OfficeCellSnapshot[]): OfficeCellSnapshot[] {
  let remaining = OFFICE_INSPECTION_LIMITS.characters as number
  const clip = (value: string): string => {
    const text = value.slice(0, remaining)
    remaining -= text.length
    return text
  }
  return items.slice(0, OFFICE_INSPECTION_LIMITS.cells).map((item) => ({
    ...item,
    ...(typeof item.value === 'string' ? { value: clip(item.value) } : {}),
    ...(item.formula === undefined ? {} : { formula: clip(item.formula) }),
    ...(item.cachedValue === undefined ? {} : { cachedValue: clip(item.cachedValue) })
  }))
}

function boundedTextItems<T extends { text: string }>(items: T[], limit: number): T[] {
  let remaining = OFFICE_INSPECTION_LIMITS.characters as number
  return items.slice(0, limit).map((item) => {
    const text = item.text.slice(0, remaining)
    remaining -= text.length
    return { ...item, text }
  })
}

function revisionChecks(kind: OfficeRevisionKind, complete: boolean, revised: boolean): OfficeRevisionCheck[] {
  return [
    { id: 'package', state: 'passed', message: 'Office 包结构、主部件身份与 XML 已检查。' },
    { id: 'coverage', state: complete ? 'passed' : 'failed', message: complete ? '选区已完整读取。' : '选区超过完整读取上限。' },
    ...(revised ? [{ id: 'unselected-content', state: 'passed' as const, message: '未选 XML 及所有其他部件内容摘要保持一致；修改文字已回读验证。' }] : []),
    { id: 'semantic', state: 'not_checked', message: '文字事实、来源支持及视觉排版需复核；文字变长可能影响换行或溢出。' },
    ...(kind === 'spreadsheet' ? [{ id: 'calculation', state: 'not_checked' as const, message: '公式与缓存结果保持原样，需在 Excel 中重新计算。' }] : [])
  ]
}
