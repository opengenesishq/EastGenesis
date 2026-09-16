import type { ToolExecutionOptions } from '../../openaiTools'
import type { ToolDefinition, ToolExecResult } from './tool-types'
import { officeDigest, officeRecord, officeText } from '../../office-revision/input'
import { inspectScopedOffice, prepareOfficeRevision } from '../../office-revision/plans'
import { executeFrozenOfficeRevision } from '../../office-revision/effect'

export const OFFICE_REVISION_TOOL_NAMES = new Set(['inspect_office_artifact', 'plan_office_revision', 'revise_office_artifact'])
const text = { type: 'string' }
const operation = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['kind', 'expectedNodeDigest', 'slides'], properties: {
    kind: { type: 'string', enum: ['setSlideSequence'] }, expectedNodeDigest: text,
    slides: { type: 'array', minItems: 1, maxItems: 300, items: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['slideId'], properties: { slideId: text } },
      { type: 'object', additionalProperties: false, required: ['title', 'body'], properties: { title: text, body: text } }
    ] } } } },
  { type: 'object', additionalProperties: false, required: ['kind', 'paragraphId', 'expectedNodeDigest', 'text'], properties: {
    kind: { type: 'string', enum: ['replaceParagraphText'] }, paragraphId: text, expectedNodeDigest: text, text } },
  { type: 'object', additionalProperties: false, required: ['kind', 'sheetId', 'address', 'expectedNodeDigest', 'value'], properties: {
    kind: { type: 'string', enum: ['setCellValue'] }, sheetId: text, address: text, expectedNodeDigest: text, value: { type: ['string', 'number', 'boolean', 'null'] } } },
  { type: 'object', additionalProperties: false, required: ['kind', 'slideId', 'shapeId', 'expectedNodeDigest', 'text'], properties: {
    kind: { type: 'string', enum: ['replaceSlideText'] }, slideId: text, shapeId: text, expectedNodeDigest: text, text } }
] }
export const OFFICE_REVISION_TOOLS: ToolDefinition[] = [
  { type: 'function', function: { name: 'inspect_office_artifact', description: '检查当前任务 Word/Excel/PowerPoint 成果选区；返回段落、已有单元格、页面与文本框身份、slideSequence摘要和可调整性。复杂结构与公式只读，不接受文件路径或任意项目。',
    parameters: { type: 'object', additionalProperties: false, required: ['artifactId'], properties: { artifactId: text, expectedDigest: text } } } },
  { type: 'function', function: { name: 'plan_office_revision', description: '只读生成精确修订预览。先inspect取得选区摘要。支持段落、literal单元格和页面文本框（保留段落数量）。PowerPoint还可单独setSlideSequence：用slideSequence.nodeDigest，slides按新顺序列出保留的slideId或新增页title/body；省略的原页面将从新版本删除，原版本保留，共享媒体与保留页不变。不直接应用修改。',
    parameters: { type: 'object', additionalProperties: false, required: ['baseArtifactId', 'expectedDigest', 'operations'], properties: {
      baseArtifactId: text, expectedDigest: text, operations: { type: 'array', minItems: 1, maxItems: 128, items: operation } } } } },
  { type: 'function', function: { name: 'revise_office_artifact', description: '通过原工具权限/Effect应用已准备的精确修订计划，产生同lineage下一版本并保留旧稿。UI指定planDigest时必须原样使用。只在返回registered后才宣称应用完成。',
    parameters: { type: 'object', additionalProperties: false, required: ['planId', 'planDigest', 'baseArtifactId', 'baseDigest'], properties: {
      planId: text, planDigest: text, baseArtifactId: text, baseDigest: text } } } }
]
export async function executeOfficeRevisionTool(name: string, args: Record<string, unknown>, options: ToolExecutionOptions): Promise<ToolExecResult> {
  if (!options.sessionMeta || !options.userDataRoot) throw new Error('Office工具缺少可信会话上下文')
  const context = { meta: options.sessionMeta, rootDir: options.userDataRoot }
  if (name === 'inspect_office_artifact') {
    officeRecord(args, ['artifactId', 'expectedDigest'])
    return officeToolJson(await inspectScopedOffice(context, officeText(args.artifactId, 'artifactId'), args.expectedDigest === undefined ? undefined : officeDigest(args.expectedDigest)))
  }
  if (name === 'plan_office_revision') return officeToolJson(await prepareOfficeRevision(context, args))
  return { ok: true, output: JSON.stringify(await executeFrozenOfficeRevision(context, args, options.effectTarget, options.signal, options.assertFormalWriteAuthorized)) }
}
function officeToolJson(value: unknown): ToolExecResult {
  const output = JSON.stringify(value)
  if (output.length <= 20_000) return { ok: true, output }
  // Preserve valid JSON and explicit coverage instead of the generic text clipper
  // silently cutting an inspection or an approval plan in the middle of a node.
  return { ok: false, output: JSON.stringify({ code: 'OFFICE_TOOL_PREVIEW_TOO_LARGE', coverage: { complete: false, truncated: true },
    reason: '结果超过单次模型工具预览范围。请在当前任务成果面板检查选区并提交精确修改，或减少一次修改的位置与文本。' }) }
}
