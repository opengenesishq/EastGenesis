import type { OfficeRevisionDraftInput, OfficeRevisionIntent, OfficeRevisionOperation } from '../../shared/office-revision-types'
import { officeError } from './errors'
import { validCellAddress } from './spreadsheet'

export function officeRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) officeError('OFFICE_PLAN_MISMATCH', 'Office输入必须是对象。')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !keys.includes(key))) officeError('OFFICE_PLAN_MISMATCH', 'Office输入含未允许字段。')
  return record
}
export function officeText(value: unknown, label: string, max = 1024): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f]/.test(value)) officeError('OFFICE_PLAN_MISMATCH', `${label}无效。`)
  return value
}
export function officeDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) officeError('OFFICE_PLAN_MISMATCH', '摘要无效。')
  return value
}
export function officeLiteralText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32_767) officeError('OFFICE_PLAN_MISMATCH', '文本超出普通段落/单元格范围。')
  // V1 does not flatten line breaks, tabs or malformed Unicode into Office XML.
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (code < 32 || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '第一版仅支持无换行、制表符和控制字符的普通文本。')
  }
  return value
}
function officeSlideText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32_767) officeError('OFFICE_PLAN_MISMATCH', '文本超出文本框修订范围。')
  // Paragraph boundaries may remain, but runs/line breaks are never synthesized.
  value.split('\n').forEach(officeLiteralText)
  if (/_x[a-f0-9]{4}_/i.test(value)) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '文本包含 Office 转义序列，不能作为普通文字替换。')
  return value
}
export function normalizeOfficeOperation(value: unknown): OfficeRevisionOperation {
  const raw = officeRecord(value, ['kind', 'paragraphId', 'sheetId', 'address', 'slideId', 'shapeId', 'expectedNodeDigest', 'text', 'value', 'slides'])
  const expectedNodeDigest = officeDigest(raw.expectedNodeDigest)
  if (raw.kind === 'setSlideSequence') {
    officeRecord(raw, ['kind', 'expectedNodeDigest', 'slides'])
    if (!Array.isArray(raw.slides) || raw.slides.length < 1 || raw.slides.length > 300) officeError('OFFICE_PLAN_MISMATCH', '汇报必须保留 1 至 300 页。')
    const slides = raw.slides.map(value => {
      const slide = officeRecord(value, ['slideId', 'title', 'body'])
      if (slide.slideId !== undefined) {
        officeRecord(slide, ['slideId'])
        const slideId = officeText(slide.slideId, 'slideId')
        if (!/^slide:[1-9][0-9]*$/.test(slideId)) officeError('OFFICE_PLAN_MISMATCH', '页面身份无效。')
        return { slideId }
      }
      officeRecord(slide, ['title', 'body'])
      const title = officeLiteralText(slide.title), body = officeSlideText(slide.body)
      if (!title.trim() || title.length > 300 || body.length > 8_000) officeError('OFFICE_PLAN_MISMATCH', '新页面需要标题（300 字内）和正文（8000 字内）。')
      return { title, body }
    })
    const ids = slides.flatMap(slide => 'slideId' in slide ? [slide.slideId] : [])
    if (new Set(ids).size !== ids.length) officeError('OFFICE_PLAN_MISMATCH', '同一原页面不能重复放入汇报。')
    return { kind: raw.kind, expectedNodeDigest, slides }
  }
  if (raw.kind === 'replaceParagraphText') {
    officeRecord(raw, ['kind', 'paragraphId', 'expectedNodeDigest', 'text'])
    const paragraphId = officeText(raw.paragraphId, 'paragraphId')
    if (!/^paragraph:[1-9][0-9]*$/.test(paragraphId)) officeError('OFFICE_PLAN_MISMATCH', '段落ID无效。')
    return { kind: raw.kind, paragraphId, expectedNodeDigest, text: officeLiteralText(raw.text) }
  }
  if (raw.kind === 'replaceSlideText') {
    officeRecord(raw, ['kind', 'slideId', 'shapeId', 'expectedNodeDigest', 'text'])
    const slideId = officeText(raw.slideId, 'slideId'), shapeId = officeText(raw.shapeId, 'shapeId')
    if (!/^slide:[1-9][0-9]*$/.test(slideId) || !/^shape:[1-9][0-9]*$/.test(shapeId)) officeError('OFFICE_PLAN_MISMATCH', '页面或文本框身份无效。')
    return { kind: raw.kind, slideId, shapeId, expectedNodeDigest, text: officeSlideText(raw.text) }
  }
  if (raw.kind !== 'setCellValue') officeError('OFFICE_PLAN_MISMATCH', '只允许替换普通段落、文本框文字和设置普通单元格。')
  officeRecord(raw, ['kind', 'sheetId', 'address', 'expectedNodeDigest', 'value'])
  const sheetId = officeText(raw.sheetId, 'sheetId'), address = officeText(raw.address, 'address')
  if (!/^sheet:[1-9][0-9]*$/.test(sheetId) || !validCellAddress(address)) officeError('OFFICE_PLAN_MISMATCH', '单元格身份无效。')
  const literal = raw.value
  if (typeof literal === 'string') officeLiteralText(literal)
  else if (literal !== null && typeof literal !== 'boolean' && !(typeof literal === 'number' && Number.isFinite(literal))) officeError('OFFICE_PLAN_MISMATCH', '单元格只接受有限数字、布尔、文本或null。')
  return { kind: raw.kind, sheetId, address, expectedNodeDigest, value: literal as string | number | boolean | null }
}
export function normalizeOfficeDraft(value: unknown): OfficeRevisionDraftInput {
  const raw = officeRecord(value, ['baseArtifactId', 'expectedDigest', 'operations'])
  if (!Array.isArray(raw.operations) || !raw.operations.length || raw.operations.length > 128) officeError('OFFICE_PLAN_MISMATCH', '每次修订必须选择1至128个明确位置。')
  const operations = raw.operations.map(normalizeOfficeOperation)
  const keys = operations.map(officeOperationKey)
  if (new Set(keys).size !== keys.length) officeError('OFFICE_PLAN_MISMATCH', '同一位置不能重复修改。')
  return { baseArtifactId: officeText(raw.baseArtifactId, 'baseArtifactId'), expectedDigest: officeDigest(raw.expectedDigest), operations }
}
export function officeOperationKey(operation: OfficeRevisionOperation): string {
  if (operation.kind === 'setSlideSequence') return 'presentation:slide-sequence'
  if (operation.kind === 'replaceParagraphText') return operation.paragraphId
  if (operation.kind === 'replaceSlideText') return `${operation.slideId}!${operation.shapeId}`
  return `${operation.sheetId}!${operation.address}`
}
export function normalizeOfficeIntent(value: unknown): OfficeRevisionIntent {
  const raw = officeRecord(value, ['planId', 'planDigest', 'baseArtifactId', 'baseDigest'])
  return { planId: officeText(raw.planId, 'planId'), planDigest: officeDigest(raw.planDigest),
    baseArtifactId: officeText(raw.baseArtifactId, 'baseArtifactId'), baseDigest: officeDigest(raw.baseDigest) }
}
