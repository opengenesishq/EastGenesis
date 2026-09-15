import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, rm } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { Document, HeadingLevel, Packer, Paragraph } from 'docx'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import PDFDocument from 'pdfkit'
import PptxGenJS from 'pptxgenjs'
import type { EffectTarget, FileSystemIdentity, OfficeSourceSnapshot } from '../../../shared/types'
import { resolveExistingProjectPath, resolveWritableProjectPath } from '../../utils/safe-project-path'
import {
  confirmed,
  notApplied,
  unresolved,
  type EffectReconciliationResult
} from '../../task/effect-reconciliation-result'
import { stableValueDigest } from '../../task/tool-idempotency'
import { runOfficeSelfCheck } from './office-self-check'

export const CREATE_DOCUMENT_TOOL = 'create_document'
export const CREATE_SPREADSHEET_TOOL = 'create_spreadsheet'
export const CREATE_PRESENTATION_TOOL = 'create_presentation'
export const CREATE_PDF_TOOL = 'create_pdf'
export const OFFICE_ARTIFACT_TOOLS = new Set([
  CREATE_DOCUMENT_TOOL,
  CREATE_SPREADSHEET_TOOL,
  CREATE_PRESENTATION_TOOL,
  CREATE_PDF_TOOL
])

export type OfficeArtifactToolName =
  | typeof CREATE_DOCUMENT_TOOL
  | typeof CREATE_SPREADSHEET_TOOL
  | typeof CREATE_PRESENTATION_TOOL
  | typeof CREATE_PDF_TOOL
export type OfficeArtifactKind = 'document' | 'spreadsheet' | 'presentation' | 'pdf'
export type OfficeScalar = string | number | boolean
export type OfficeCellValue = OfficeScalar | { formula: string; result?: OfficeScalar }

export const DOCUMENT_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const SPREADSHEET_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const PRESENTATION_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
export const PDF_MEDIA_TYPE = 'application/pdf'

const OFFICE_METADATA_DATE = new Date('2000-01-01T00:00:00.000Z')

export interface OfficeDocumentSpec {
  artifactKind: 'document'
  headings: string[]
  paragraphs: string[]
}

export interface OfficeSpreadsheetSpec {
  artifactKind: 'spreadsheet'
  sheets: Array<{ name: string; rows: OfficeCellValue[][] }>
}

export interface OfficePresentationSpec {
  artifactKind: 'presentation'
  slides: Array<{ title: string; body: string; bullets: string[] }>
}

export interface OfficePdfSpec {
  artifactKind: 'pdf'
  sections: Array<{ heading: string; paragraphs: string[] }>
}

export type OfficeArtifactSpec =
  | OfficeDocumentSpec
  | OfficeSpreadsheetSpec
  | OfficePresentationSpec
  | OfficePdfSpec

export interface OfficeArtifactPlan {
  title: string
  workspacePath: string
  rootPath: string
  rootIdentity: FileSystemIdentity
  relativePath: string
  sourceRefs: string[]
  sourceSnapshots: OfficeSourceSnapshot[]
  spec: OfficeArtifactSpec
  specDigest: string
  mediaType: string
}

export interface OfficeArtifactReplayTarget {
  kind: 'office_artifact'
  rootIdentity: FileSystemIdentity
  relativePath: string
}

export interface GeneratedOfficeArtifact {
  path: string
  sha256: string
  bytes: number
  mediaType: string
  artifactKind: OfficeArtifactKind
  title: string
  sourceRefs: string[]
}

export function isOfficeArtifactTool(name: string): name is OfficeArtifactToolName {
  return OFFICE_ARTIFACT_TOOLS.has(name)
}

export async function describeOfficeArtifactReplayTarget(
  input: Record<string, unknown>,
  cwd: string
): Promise<OfficeArtifactReplayTarget> {
  const output = await resolveWritableProjectPath(cwd, requiredText(input.path, 'path', 1_024))
  return {
    kind: 'office_artifact',
    rootIdentity: fileSystemIdentity(output.root),
    relativePath: output.relativePath
  }
}

/** Build the immutable Effect target before permission is requested. */
export async function buildOfficeArtifactEffectTarget(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  sourceCwd = cwd
): Promise<Extract<EffectTarget, { kind: 'office_artifact' }>> {
  const plan = await planOfficeArtifact(toolName, input, cwd, sourceCwd)
  const state = await lstat(plan.workspacePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (state) throw new Error(`Office 输出文件已存在，禁止覆盖历史 Artifact: ${plan.relativePath}`)
  const expected = officeOutputIdentity(await generateOfficeArtifactBytes(plan.title, plan.spec))
  return {
    kind: 'office_artifact',
    artifactKind: plan.spec.artifactKind,
    rootPath: plan.rootPath,
    rootIdentity: plan.rootIdentity,
    relativePath: plan.relativePath,
    workspacePath: plan.workspacePath,
    specDigest: plan.specDigest,
    outputBindingVersion: 1,
    expectedSha256: expected.sha256,
    expectedBytes: expected.bytes,
    mediaType: plan.mediaType,
    sourceRefs: plan.sourceRefs,
    sourceSnapshots: plan.sourceSnapshots,
    title: plan.title
  }
}

/** Execute only after NativeToolRuntime has crossed the durable Effect barrier. */
export async function executeOfficeArtifactTool(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  target: EffectTarget | undefined,
  signal?: AbortSignal,
  context: {
    sourceCwd?: string
    assertWriteAuthorized?: () => void
    withWriteAccess?: (commit: () => Promise<GeneratedOfficeArtifact>) => Promise<GeneratedOfficeArtifact>
  } = {}
): Promise<GeneratedOfficeArtifact> {
  if (!target || target.kind !== 'office_artifact') {
    throw new Error('Office 生成缺少已冻结的 Effect target')
  }
  const plan = await planOfficeArtifact(toolName, input, cwd, context.sourceCwd ?? cwd)
  assertOfficePlanMatchesTarget(plan, target)
  const expected = requiredOfficeOutputIdentity(target)
  assertRootIdentity(plan.rootPath, target.rootIdentity)
  if (signal?.aborted) throw new Error('Office 生成已中断，文件尚未写入')

  const bytes = await generateOfficeArtifactBytes(plan.title, plan.spec)
  const generated = officeOutputIdentity(bytes)
  if (generated.sha256 !== expected.sha256 || generated.bytes !== expected.bytes) {
    throw new Error('Office 生成器输出与审批时冻结的字节摘要不一致，必须重新审批')
  }
  if (signal?.aborted) throw new Error('Office 生成已中断，文件尚未写入')

  const commit = async (): Promise<GeneratedOfficeArtifact> => {
    context.assertWriteAuthorized?.()
    // Source files can change while rendering or waiting for a lifecycle write.
    assertOfficePlanMatchesTarget(await planOfficeArtifact(toolName, input, cwd, context.sourceCwd ?? cwd), target)
    await mkdir(dirname(plan.workspacePath), { recursive: true, mode: 0o700 })
    const refreshed = await resolveWritableProjectPath(cwd, plan.workspacePath)
    if (refreshed.root !== target.rootPath || refreshed.relativePath !== target.relativePath) {
      throw new Error('Office 输出目录在审批后发生变化')
    }
    assertRootIdentity(refreshed.root, target.rootIdentity)

    context.assertWriteAuthorized?.()
    if (signal?.aborted) throw new Error('Office 生成已中断，文件尚未写入')
    const handle = await open(refreshed.fullPath, 'wx', 0o600)
    try {
      context.assertWriteAuthorized?.()
      if (signal?.aborted) throw new Error('Office 生成已中断，文件尚未写入')
      await handle.writeFile(bytes)
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => undefined)
      await rm(refreshed.fullPath, { force: true }).catch(() => undefined)
      throw error
    }
    await handle.close()
    return {
      path: refreshed.fullPath,
      sha256: generated.sha256,
      bytes: generated.bytes,
      mediaType: plan.mediaType,
      artifactKind: plan.spec.artifactKind,
      title: plan.title,
      sourceRefs: plan.sourceRefs
    }
  }
  return context.withWriteAccess ? context.withWriteAccess(commit) : commit()
}

export async function reconcileOfficeArtifactEffectTarget(
  target: Extract<EffectTarget, { kind: 'office_artifact' }>
): Promise<EffectReconciliationResult> {
  try {
    assertRootIdentity(target.rootPath, target.rootIdentity)
    const resolved = await resolveWritableProjectPath(target.rootPath, target.workspacePath)
    if (resolved.root !== target.rootPath || resolved.relativePath !== target.relativePath ||
        resolved.fullPath !== target.workspacePath) {
      return unresolved({ kind: target.kind, reason: 'Office 输出路径已脱离审批时冻结的 Project 位置' })
    }
  } catch (error) {
    return unresolved({
      kind: target.kind,
      reason: error instanceof Error ? error.message : String(error)
    })
  }
  const state = await lstat(target.workspacePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!state) {
    return notApplied(
      { kind: target.kind, workspacePath: target.workspacePath, state: 'absent' },
      'Office 输出文件不存在'
    )
  }
  if (state.isSymbolicLink() || !state.isFile()) {
    return unresolved({ kind: target.kind, reason: 'Office 输出路径不是普通文件' })
  }
  let expected: { sha256: string; bytes: number }
  try {
    expected = requiredOfficeOutputIdentity(target)
  } catch (error) {
    return unresolved({
      kind: target.kind,
      reason: error instanceof Error ? error.message : String(error)
    })
  }
  const bytes = await readFile(target.workspacePath)
  const actual = officeOutputIdentity(bytes)
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    return unresolved({
      kind: target.kind,
      workspacePath: target.workspacePath,
      expected,
      actual,
      reason: 'Office 输出字节与审批时冻结的摘要或长度不一致'
    })
  }
  const selfCheck = await runOfficeSelfCheck({
    workspacePath: target.workspacePath,
    expectedSha256: expected.sha256,
    artifactKind: target.artifactKind,
    mediaType: target.mediaType,
    sourceRefs: target.sourceRefs,
    sourceSnapshots: target.sourceSnapshots,
    runtimeTraceable: true
  })
  if (!selfCheck.ok) {
    return unresolved({ kind: target.kind, selfCheck, reason: selfCheck.reason ?? 'Office 输出无法验证' })
  }
  return confirmed({
    kind: target.kind,
    workspacePath: target.workspacePath,
    sha256: actual.sha256,
    bytes: actual.bytes,
    selfCheck
  }, 'Office 输出文件存在且结构、类型与来源校验通过')
}

async function planOfficeArtifact(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  sourceCwd: string
): Promise<OfficeArtifactPlan> {
  if (!isOfficeArtifactTool(toolName)) throw new Error(`未知 Office 工具: ${toolName}`)
  const title = requiredText(input.title, 'title', 240)
  const output = await resolveWritableProjectPath(cwd, requiredText(input.path, 'path', 1_024))
  const artifactKind = officeArtifactKind(toolName)
  assertExtension(output.fullPath, artifactKind)
  const sourceSnapshots = await canonicalSourceSnapshots(sourceCwd, input.source_refs, cwd)
  const sourceRefs = sourceSnapshots.map((snapshot) => snapshot.path)
  const spec = artifactKind === 'document'
    ? normalizeDocumentSpec(input)
    : artifactKind === 'spreadsheet'
      ? normalizeSpreadsheetSpec(input)
      : artifactKind === 'presentation'
        ? normalizePresentationSpec(input)
        : normalizePdfSpec(input)
  return {
    title,
    workspacePath: output.fullPath,
    rootPath: output.root,
    rootIdentity: fileSystemIdentity(output.root),
    relativePath: output.relativePath,
    sourceRefs,
    sourceSnapshots,
    spec,
    specDigest: stableValueDigest({ title, spec }),
    mediaType: officeMediaType(artifactKind)
  }
}

function normalizeDocumentSpec(input: Record<string, unknown>): OfficeDocumentSpec {
  return {
    artifactKind: 'document',
    headings: optionalStringArray(input.headings, 'headings', 200),
    paragraphs: optionalStringArray(input.paragraphs, 'paragraphs', 5_000)
  }
}

function normalizeSpreadsheetSpec(input: Record<string, unknown>): OfficeSpreadsheetSpec {
  if (!Array.isArray(input.sheets) || input.sheets.length === 0 || input.sheets.length > 100) {
    throw new Error('sheets 必须是 1 到 100 个工作表的数组')
  }
  let cellCount = 0
  const sheets = input.sheets.map((candidate, sheetIndex) => {
    const sheet = requiredRecord(candidate, `sheets[${sheetIndex}]`)
    const name = requiredText(sheet.name ?? `Sheet${sheetIndex + 1}`, `sheets[${sheetIndex}].name`, 31)
    if (!Array.isArray(sheet.rows) || sheet.rows.length > 50_000) {
      throw new Error(`sheets[${sheetIndex}].rows 必须是最多 50000 行的数组`)
    }
    const rows = sheet.rows.map((candidateRow, rowIndex) => {
      if (!Array.isArray(candidateRow) || candidateRow.length > 16_384) {
        throw new Error(`sheets[${sheetIndex}].rows[${rowIndex}] 不是有效行`)
      }
      cellCount += candidateRow.length
      if (cellCount > 500_000) throw new Error('工作簿最多允许 500000 个单元格')
      return candidateRow.map((value, columnIndex) =>
        normalizeCellValue(value, `sheets[${sheetIndex}].rows[${rowIndex}][${columnIndex}]`))
    })
    return { name, rows }
  })
  return { artifactKind: 'spreadsheet', sheets }
}

function normalizePresentationSpec(input: Record<string, unknown>): OfficePresentationSpec {
  if (!Array.isArray(input.slides) || input.slides.length === 0 || input.slides.length > 100) {
    throw new Error('slides 必须是 1 到 100 页的数组')
  }
  return {
    artifactKind: 'presentation',
    slides: input.slides.map((candidate, index) => {
      const slide = requiredRecord(candidate, `slides[${index}]`)
      return {
        title: requiredText(slide.title, `slides[${index}].title`, 240),
        body: optionalText(slide.body, `slides[${index}].body`, 20_000),
        bullets: optionalStringArray(slide.bullets, `slides[${index}].bullets`, 100)
      }
    })
  }
}

function normalizePdfSpec(input: Record<string, unknown>): OfficePdfSpec {
  if (!Array.isArray(input.sections) || input.sections.length === 0 || input.sections.length > 500) {
    throw new Error('sections 必须是 1 到 500 节的数组')
  }
  return {
    artifactKind: 'pdf',
    sections: input.sections.map((candidate, index) => {
      const section = requiredRecord(candidate, `sections[${index}]`)
      return {
        heading: optionalText(section.heading, `sections[${index}].heading`, 240),
        paragraphs: optionalStringArray(section.paragraphs, `sections[${index}].paragraphs`, 1_000)
      }
    })
  }
}

function normalizeCellValue(value: unknown, label: string): OfficeCellValue {
  if (typeof value === 'string') return requiredText(value, label, 100_000, true)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value
  const record = requiredRecord(value, label)
  const formula = requiredText(record.formula, `${label}.formula`, 8_192)
  const result = record.result
  if (result === undefined) return { formula }
  if (typeof result === 'string') return { formula, result: requiredText(result, `${label}.result`, 100_000, true) }
  if ((typeof result === 'number' && Number.isFinite(result)) || typeof result === 'boolean') {
    return { formula, result: result as number | boolean }
  }
  throw new Error(`${label}.result 必须是字符串、数字或布尔值`)
}

async function canonicalSourceSnapshots(cwd: string, value: unknown, draftCwd: string): Promise<OfficeSourceSnapshot[]> {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 200) throw new Error('source_refs 必须是最多 200 项的路径数组')
  const snapshots: OfficeSourceSnapshot[] = []
  for (let index = 0; index < value.length; index += 1) {
    const raw = requiredText(value[index], `source_refs[${index}]`, 1_024)
    // Relative refs remain attached to the original task. Only explicit draft
    // paths select the isolated root; a failed path check never expands scope.
    const rel = relative(resolve(draftCwd), resolve(raw))
    const fromDraft = isAbsolute(raw) && (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
    const source = await resolveExistingProjectPath(fromDraft ? draftCwd : cwd, raw)
    if (snapshots.some((snapshot) => snapshot.path === source.fullPath)) continue
    const state = await lstat(source.fullPath)
    if (!state.isFile()) throw new Error(`source_refs[${index}] 必须指向普通文件`)
    const bytes = await readFile(source.fullPath)
    snapshots.push({
      path: source.fullPath,
      identity: fileSystemIdentity(source.fullPath),
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      bytes: bytes.byteLength
    })
  }
  return snapshots
}

async function generateDocumentBytes(title: string, spec: OfficeDocumentSpec): Promise<Buffer> {
  const children: Paragraph[] = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })]
  for (const heading of spec.headings) {
    children.push(new Paragraph({ text: heading, heading: HeadingLevel.HEADING_1 }))
  }
  for (const paragraph of spec.paragraphs) children.push(new Paragraph({ text: paragraph }))
  return canonicalizeOoxmlBytes(await Packer.toBuffer(new Document({ sections: [{ children }] })))
}

async function generateSpreadsheetBytes(title: string, spec: OfficeSpreadsheetSpec): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'CaoGen'
  workbook.title = title
  workbook.created = new Date(OFFICE_METADATA_DATE.getTime())
  workbook.modified = new Date(OFFICE_METADATA_DATE.getTime())
  for (const sheet of spec.sheets) {
    const worksheet = workbook.addWorksheet(sheet.name, {
      properties: { defaultRowHeight: 20, tabColor: { argb: 'FF00A878' } },
      views: [{ state: 'frozen', ySplit: 1, showGridLines: false }]
    })
    for (const row of sheet.rows) worksheet.addRow(row)
    worksheet.headerFooter.oddHeader = `&C&B${spreadsheetHeaderText(title)}`
    worksheet.pageSetup = {
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      orientation: worksheet.columnCount > 8 ? 'landscape' : 'portrait',
      margins: { left: 0.5, right: 0.5, top: 0.65, bottom: 0.65, header: 0.25, footer: 0.25 }
    }
    styleSpreadsheetHeader(worksheet.getRow(1))
    for (let index = 1; index <= worksheet.columnCount; index += 1) {
      const column = worksheet.getColumn(index)
      column.width = spreadsheetColumnWidth(column.values)
      column.alignment = {
        vertical: 'middle',
        horizontal: spreadsheetColumnIsNumeric(column.values) ? 'right' : 'left'
      }
    }
  }
  return canonicalizeOoxmlBytes(Buffer.from(await workbook.xlsx.writeBuffer()))
}

function spreadsheetHeaderText(value: string): string {
  return value.replaceAll('&', '&&').slice(0, 240)
}

function styleSpreadsheetHeader(row: ExcelJS.Row): void {
  row.height = 24
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17212B' } }
  row.alignment = { vertical: 'middle', horizontal: 'left' }
  row.border = { bottom: { style: 'medium', color: { argb: 'FF00A878' } } }
}

function spreadsheetColumnWidth(values: readonly ExcelJS.CellValue[]): number {
  let longest = 0
  for (const value of values) longest = Math.max(longest, spreadsheetDisplayWidth(value))
  return Math.min(60, Math.max(12, longest + 2))
}

function spreadsheetDisplayWidth(value: ExcelJS.CellValue): number {
  if (value === null || value === undefined) return 0
  const display = typeof value === 'object' && 'result' in value
    ? value.result ?? value.formula
    : value
  return Array.from(String(display)).reduce((width, character) =>
    width + ((character.codePointAt(0) ?? 0) > 0xff ? 2 : 1), 0)
}

function spreadsheetColumnIsNumeric(values: readonly ExcelJS.CellValue[]): boolean {
  const populated = values.slice(2).filter((value) => value !== null && value !== undefined)
  return populated.length > 0 && populated.every((value) =>
    typeof value === 'number' || (typeof value === 'object' && 'result' in value && typeof value.result === 'number')
  )
}

async function generateOfficeArtifactBytes(title: string, spec: OfficeArtifactSpec): Promise<Buffer> {
  if (spec.artifactKind === 'document') return generateDocumentBytes(title, spec)
  if (spec.artifactKind === 'spreadsheet') return generateSpreadsheetBytes(title, spec)
  if (spec.artifactKind === 'presentation') return generatePresentationBytes(title, spec)
  return generatePdfBytes(title, spec)
}

async function generatePresentationBytes(title: string, spec: OfficePresentationSpec): Promise<Buffer> {
  const presentation = new PptxGenJS()
  presentation.layout = 'LAYOUT_WIDE'
  presentation.author = 'CaoGen'
  presentation.company = 'CaoGen'
  presentation.subject = title
  presentation.title = title
  presentation.theme = {
    headFontFace: 'Noto Sans SC',
    bodyFontFace: 'Noto Sans SC'
  }
  for (const item of spec.slides) {
    const slide = presentation.addSlide()
    slide.background = { color: 'F7F8FA' }
    slide.addText(item.title, {
      x: 0.72, y: 0.48, w: 11.9, h: 0.9,
      fontFace: 'Noto Sans SC', fontSize: 35, bold: true, color: '17212B', margin: 0
    })
    slide.addShape(presentation.ShapeType.line, {
      x: 0.72, y: 1.48, w: 1.2, h: 0,
      line: { color: '00A878', width: 3 }
    })
    if (item.body) {
      slide.addText(item.body, {
        x: 0.75, y: 1.68, w: 11.6, h: 1.2,
        fontFace: 'Noto Sans SC', fontSize: 17, color: '34414D',
        margin: 0.04, valign: 'top'
      })
    }
    if (item.bullets.length > 0) {
      slide.addText(item.bullets.map((text) => ({
        text,
        options: { bullet: { indent: 18 }, breakLine: true }
      })), {
        x: 0.95, y: item.body ? 3.05 : 1.65, w: 11.0, h: item.body ? 3.65 : 5.0,
        fontFace: 'Noto Sans SC', fontSize: 18, color: '24313C',
        margin: 0.04, paraSpaceAfter: 10, valign: 'top'
      })
    }
  }
  const output = await presentation.write({ outputType: 'nodebuffer' })
  const bytes = typeof output === 'string'
    ? Buffer.from(output, 'binary')
    : output instanceof Uint8Array
      ? Buffer.from(output)
      : output instanceof ArrayBuffer
        ? Buffer.from(output)
        : null
  if (!bytes) throw new Error('PPTX 生成器返回了不支持的输出类型')
  return canonicalizeOoxmlBytes(bytes)
}

async function generatePdfBytes(title: string, spec: OfficePdfSpec): Promise<Buffer> {
  const font = await readFile(pdfFontPath())
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    const pdf = new PDFDocument({
      size: 'A4',
      margins: { top: 56, right: 54, bottom: 56, left: 54 },
      info: {
        Title: title,
        Author: 'CaoGen',
        CreationDate: new Date(OFFICE_METADATA_DATE.getTime()),
        ModDate: new Date(OFFICE_METADATA_DATE.getTime())
      }
    })
    pdf.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    pdf.on('end', () => resolve(Buffer.concat(chunks)))
    pdf.on('error', reject)
    pdf.font(font).fontSize(24).fillColor('#17212B').text(title, { lineGap: 8 })
    pdf.moveDown(0.8)
    for (const section of spec.sections) {
      if (section.heading) {
        pdf.font(font).fontSize(16).fillColor('#17212B').text(section.heading, { lineGap: 5 })
        pdf.moveDown(0.35)
      }
      for (const paragraph of section.paragraphs) {
        pdf.font(font).fontSize(11.5).fillColor('#283640').text(paragraph, {
          align: 'justify', lineGap: 5, paragraphGap: 9
        })
      }
      pdf.moveDown(0.45)
    }
    pdf.end()
  })
}

async function canonicalizeOoxmlBytes(bytes: Buffer): Promise<Buffer> {
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true })
  const coreProperties = archive.file('docProps/core.xml')
  if (coreProperties) {
    archive.file(
      'docProps/core.xml',
      normalizeCorePropertyDates(await coreProperties.async('string')),
      { date: deterministicZipDate() }
    )
  }
  for (const entry of Object.values(archive.files)) {
    entry.date = deterministicZipDate()
    entry.comment = ''
  }
  return archive.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'DOS',
    streamFiles: false,
    comment: ''
  })
}

function normalizeCorePropertyDates(xml: string): string {
  let normalized = xml
  for (const property of ['created', 'modified']) {
    normalized = normalized.replace(
      new RegExp(`(<dcterms:${property}\\b[^>]*>)[\\s\\S]*?(<\\/dcterms:${property}>)`, 'g'),
      `$1${OFFICE_METADATA_DATE.toISOString().replace('.000', '')}$2`
    )
  }
  return normalized
}

function deterministicZipDate(): Date {
  return new Date(Date.UTC(2000, 0, 1, 0, 0, 0, 0))
}

function officeOutputIdentity(bytes: Buffer): { sha256: string; bytes: number } {
  return {
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    bytes: bytes.byteLength
  }
}

function requiredOfficeOutputIdentity(
  target: Extract<EffectTarget, { kind: 'office_artifact' }>
): { sha256: string; bytes: number } {
  if (target.outputBindingVersion !== 1 || !target.expectedSha256 || target.expectedBytes === undefined ||
      !target.sourceSnapshots) {
    throw new Error('旧版 Office Effect 缺少审批时冻结的输出摘要，禁止自动执行或确认，必须重新审批')
  }
  return { sha256: target.expectedSha256, bytes: target.expectedBytes }
}

function pdfFontPath(): string {
  const packagedFont = join(process.resourcesPath ?? '', 'office-font', 'NotoSansSC-Regular.woff')
  if (existsSync(packagedFont)) return packagedFont
  const nodeRequire = createRequire(__filename)
  const packageRoot = dirname(nodeRequire.resolve('@fontsource/noto-sans-sc/package.json'))
  return join(packageRoot, 'files', 'noto-sans-sc-chinese-simplified-400-normal.woff')
}

function assertOfficePlanMatchesTarget(
  plan: OfficeArtifactPlan,
  target: Extract<EffectTarget, { kind: 'office_artifact' }>
): void {
  if (plan.spec.artifactKind !== target.artifactKind || plan.workspacePath !== target.workspacePath ||
      plan.rootPath !== target.rootPath || plan.relativePath !== target.relativePath ||
      plan.specDigest !== target.specDigest || plan.mediaType !== target.mediaType ||
      plan.title !== target.title || stableValueDigest(plan.sourceRefs) !== stableValueDigest(target.sourceRefs) ||
      stableValueDigest(plan.sourceSnapshots) !== stableValueDigest(target.sourceSnapshots)) {
    throw new Error('Office 工具输入与已批准 Effect target 不一致')
  }
}

function assertRootIdentity(rootPath: string, expected: FileSystemIdentity): void {
  const actual = fileSystemIdentity(rootPath)
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error('Office 项目根目录身份在审批后发生变化')
  }
}

function fileSystemIdentity(path: string): FileSystemIdentity {
  const info = statSync(path, { bigint: true })
  return {
    device: info.dev.toString(),
    inode: info.ino.toString()
  }
}

function assertExtension(path: string, kind: OfficeArtifactKind): void {
  const expected = kind === 'document'
    ? '.docx'
    : kind === 'spreadsheet'
      ? '.xlsx'
      : kind === 'presentation'
        ? '.pptx'
        : '.pdf'
  if (extname(path).toLowerCase() !== expected) throw new Error(`Office 输出路径必须以 ${expected} 结尾`)
}

export function officeArtifactKind(toolName: OfficeArtifactToolName): OfficeArtifactKind {
  if (toolName === CREATE_DOCUMENT_TOOL) return 'document'
  if (toolName === CREATE_SPREADSHEET_TOOL) return 'spreadsheet'
  if (toolName === CREATE_PRESENTATION_TOOL) return 'presentation'
  if (toolName === CREATE_PDF_TOOL) return 'pdf'
  throw new Error(`未知 Office 工具: ${toolName}`)
}

function officeMediaType(kind: OfficeArtifactKind): string {
  if (kind === 'document') return DOCUMENT_MEDIA_TYPE
  if (kind === 'spreadsheet') return SPREADSHEET_MEDIA_TYPE
  if (kind === 'presentation') return PRESENTATION_MEDIA_TYPE
  return PDF_MEDIA_TYPE
}

function optionalStringArray(value: unknown, label: string, maxItems: number): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} 必须是最多 ${maxItems} 项的字符串数组`)
  return value.map((candidate, index) => requiredText(candidate, `${label}[${index}]`, 100_000, true))
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as Record<string, unknown>
}

function requiredText(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty = false
): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`)
  if (value.length > maxLength || /[\0\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} 无效`)
  }
  const clean = value.trim()
  if (!allowEmpty && !clean) throw new Error(`${label} 不能为空`)
  return allowEmpty ? value : clean
}

function optionalText(value: unknown, label: string, maxLength: number): string {
  if (value === undefined) return ''
  return requiredText(value, label, maxLength, true).trim()
}
