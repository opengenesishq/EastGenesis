import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extractGoalRequestRequirements, type GoalRequestRequirement } from '../../shared/goal-request-requirements'
import { readOfficePackage } from '../office-revision/package'
import { assertOfficePackageIdentity } from '../office-revision/package-identity'
import { inspectPresentationPackage } from '../office-revision/presentation'
import { inspectDocumentPackage } from '../office-revision/document'
import { inspectSpreadsheetPackage } from '../office-revision/spreadsheet'
import type { OfficeArtifactKind } from '../agent/tools/office-self-check'
import { inspectPdfDelivery } from './pdf-delivery-inspection'

export interface OfficeDeliveryRequirementCheck {
  id: string
  requirement: GoalRequestRequirement
  status: 'passed' | 'failed' | 'unverified' | 'not_applicable'
  reason: string
  actualPageCount?: number
  actualFormat?: string
  referenceCount?: number
}
export interface OfficeDeliveryRequirementReport {
  schemaVersion: 1
  artifactDigest: string
  binding: { acceptanceId?: string; acceptanceRevision?: number; criteriaDigest?: string; reason?: string;
    contractEventId?: string; workItemRevision?: number; goalRevision?: number }
  checks: OfficeDeliveryRequirementCheck[]
  /** A machine content check never takes the user's final acceptance authority. */
  finalUserAcceptance: false
}

const FORMATS = { presentation: 'pptx', document: 'docx', spreadsheet: 'xlsx', pdf: 'pdf' } as const

export async function checkOfficeDeliveryRequirements(input: {
  workspacePath: string; expectedDigest: string; kind: OfficeArtifactKind; sourceRefs: string[]
  criteria?: string[]; binding: OfficeDeliveryRequirementReport['binding']; bytes?: Buffer
}): Promise<OfficeDeliveryRequirementReport> {
  const report: OfficeDeliveryRequirementReport = { schemaVersion: 1, artifactDigest: input.expectedDigest,
    binding: input.binding, checks: [], finalUserAcceptance: false }
  const requests = (input.criteria ?? []).flatMap((criterion) => extractGoalRequestRequirements(criterion)
    .map((requirement) => ({ requirement, criterion })))
  const unique = [...new Map(requests.map((entry) => {
    if (entry.requirement.kind === 'constraint') entry.requirement = { ...entry.requirement,
      id: `request:constraint:${createHash('sha256').update(entry.requirement.text).digest('hex').slice(0, 16)}` }
    return [entry.requirement.id, entry]
  })).values()]
  if (!unique.length) return report
  const actualFormat = FORMATS[input.kind]
  let bytes: Buffer | undefined, text: string | undefined, pageCount: number | undefined, inspectionError: string | undefined
  try {
    bytes = input.bytes ?? await readFile(input.workspacePath)
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== input.expectedDigest) {
      throw new Error('成果字节已改变，不能把检查归于原版本')
    }
    if (input.kind === 'pdf') {
      const pdf = inspectPdfDelivery(bytes)
      pageCount = pdf.pageCount
      text = pdf.text
    } else {
      const parts = readOfficePackage(bytes)
      assertOfficePackageIdentity(parts, input.kind)
      if (input.kind === 'presentation') {
        const presentation = inspectPresentationPackage(parts)
        pageCount = presentation.slides.length
        text = presentation.texts.map((item) => item.text).join('\n')
      } else if (input.kind === 'document') {
        text = inspectDocumentPackage(parts).paragraphs.map((item) => item.text).join('\n')
      } else {
        text = inspectSpreadsheetPackage(parts).cells.map((item) => String(item.value ?? '')).join('\n')
      }
    }
  } catch (error) { inspectionError = error instanceof Error ? error.message : String(error) }
  const formatRequests = unique.filter(({ requirement }) => requirement.kind === 'format' && requirement.format)
  for (const { requirement, criterion } of unique) {
    const check: OfficeDeliveryRequirementCheck = { id: requirement.id, requirement, status: 'unverified',
      reason: '该要求需要补充可核验证据', actualFormat }
    const localFormats = extractGoalRequestRequirements(criterion).flatMap((entry) => entry.format ? [entry.format] : [])
    const formats = [...new Set(localFormats.length ? localFormats : formatRequests.flatMap(({ requirement: entry }) => entry.format ? [entry.format] : []))]
    if (requirement.kind !== 'format' && formats.length === 1 && formats[0] !== actualFormat) {
      check.status = 'not_applicable'; check.reason = `该要求属于 ${formats[0]} 成果，本文件是 ${actualFormat}`
    } else if (inspectionError) {
      check.reason = inspectionError
    } else if (requirement.kind === 'format') {
      if (requirement.format === actualFormat) { check.status = 'passed'; check.reason = `实际文件包已解析为 ${actualFormat}` }
      else check.reason = `本文件是 ${actualFormat}，不能证明已交付所要求的 ${requirement.format}；附属文件可以保留，主成果要求仍待核验`
    } else if (requirement.kind === 'page_count' && requirement.pageCount) {
      if (formats.length > 1) check.reason = '要求涉及多个格式，尚未确定页数约束属于哪一份成果'
      else if (input.kind === 'spreadsheet') check.reason = '工作表数量不能代替交付页面数，主成果的页数要求仍待核验'
      else if (pageCount === undefined) check.reason = '实际排版后的页面数未验证；文档属性或显式分页符不能代替渲染页数'
      else {
        const { value, operator } = requirement.pageCount
        check.actualPageCount = pageCount
        check.status = (operator === 'eq' ? pageCount === value : operator === 'lte' ? pageCount <= value : pageCount >= value) ? 'passed' : 'failed'
        check.reason = `实际 ${actualFormat} 页面树包含 ${pageCount} 页；要求 ${operator === 'eq' ? '等于' : operator === 'lte' ? '不超过' : '不少于'} ${value} 页`
      }
    } else if (requirement.kind === 'sources') {
      const references = text?.match(/https?:\/\/[^\s<>"']+|doi:\s*\S+|(?:来源|参考文献|出处|source|references?)\s*[:：]\s*\S+/gi) ?? []
      check.referenceCount = references.length
      if (text === undefined) check.reason = '尚无可检查的完整正文，来源要求未验证'
      else if (!references.length && !input.sourceRefs.length) check.reason = '实际正文未发现来源标记或地址，且没有绑定的来源材料；备注、脚注或链接内容尚未完整核验'
      else check.reason = `发现 ${references.length} 处正文来源标记和 ${input.sourceRefs.length} 份绑定材料；来源是否真实支持相应结论仍待核验`
    }
    report.checks.push(check)
  }
  return report
}
